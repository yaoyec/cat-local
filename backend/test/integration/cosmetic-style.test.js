import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { BackendHarness } from "./harness.js";

const ACCOUNT_A = { nickname: "装饰权益测试猫", email: "phase1-cosmetic-a@example.invalid", password: "phase-one-cosmetic-password" };
const ACCOUNT_B = { nickname: "装饰隐私测试猫", email: "phase1-cosmetic-b@example.invalid", password: "phase-one-cosmetic-password" };
const GM_PASSWORD = "phase-one-cosmetic-gm";

function encode(data = {}) {
  return JSON.stringify({ data });
}

function emit(socket, event, data = {}) {
  socket.emit(event, encode(data));
}

async function gmCookie(backend) {
  const response = await backend.request("/api/gm/login", { method: "POST", json: { password: GM_PASSWORD } });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function grant(backend, cookie, uuid, items) {
  const response = await backend.request(`/api/gm/players/${uuid}/grant`, { method: "POST", cookie, json: { items } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function use(backend, socket, itemId, multiple = 1) {
  const outcome = Promise.race([
    backend.waitEvent(socket, "effectAction:useItem:success").then((value) => ({ ok: true, value })),
    backend.waitEvent(socket, "effectAction:useItem:error").then((value) => ({ ok: false, value }))
  ]);
  emit(socket, "effectAction:useItem", { itemId, multiple });
  return outcome;
}

async function style(backend, socket, uuid) {
  return backend.emitAndWait(socket, "style:get", uuid ? { uuid } : {}, "style:get:success");
}

async function inventoryCount(backend, socket, itemId) {
  const waiting = backend.waitEvent(socket, "dispatchInventoryInfo");
  emit(socket, "requestInventoryInfo", {});
  const inventory = await waiting;
  return Number(inventory?.[itemId]?.count) || 0;
}

function styleRequest(styleValue) {
  return {
    currentBattleCardStyle: styleValue.currentBattleCardStyle,
    currentChatContentStyle: styleValue.currentChatContentStyle,
    currentChatNameStyle: styleValue.currentChatNameStyle,
    currentProfileStyle: styleValue.currentProfileStyle,
    currentChatBubbleStyle: styleValue.currentChatBubbleStyle,
    currentAvatarBorder: styleValue.currentAvatarBorder,
    diyChatBubbleStyle: styleValue.diyChatBubbleStyle
  };
}

async function readPlayerDisk(backend, uuid) {
  const rows = JSON.parse(await fs.readFile(backend.files.players, "utf8"));
  return rows.find((row) => row.uuid === uuid);
}

async function waitForPlayerDisk(backend, uuid, predicate = () => true) {
  const rows = await backend.waitForJson(backend.files.players, (value) => {
    const player = Array.isArray(value) ? value.find((row) => row.uuid === uuid) : null;
    return player && predicate(player);
  });
  return rows.find((row) => row.uuid === uuid);
}

function playerPhaseOneView(player) {
  return {
    inventory: player.inventory,
    uniqueFlag: player.uniqueFlag,
    personalization: player.personalization,
    style: player.style
  };
}

async function emitOutcome(backend, socket, outbound, data, successEvent, errorEvent) {
  const outcome = Promise.race([
    backend.waitEvent(socket, successEvent).then((value) => ({ ok: true, value })),
    backend.waitEvent(socket, errorEvent).then((value) => ({ ok: false, value }))
  ]);
  emit(socket, outbound, data);
  return outcome;
}

async function assertPeerQuiet(backend, socket, events, action, timeoutMs = 300) {
  let outcome;
  const quiet = backend.assertNoEvents(socket, events, () => { outcome = action(); }, timeoutMs);
  await quiet;
  return outcome;
}

test("cosmetic use grants authoritative Style entitlements atomically", { timeout: 90_000 }, async (t) => {
  const backend = await BackendHarness.start(t, { env: { MAOMAO_GM_PASSWORD: GM_PASSWORD } });
  const registeredA = await backend.register(ACCOUNT_A);
  const registeredB = await backend.register(ACCOUNT_B);
  const a1 = (await backend.connect(registeredA.cookie)).socket;
  const a2 = (await backend.connect(registeredA.cookie)).socket;
  const b = (await backend.connect(registeredB.cookie)).socket;
  const gm = await gmCookie(backend);

  const battleItem = "sponsorPointResource_battleStyleWarrior";
  const profileItem = "sponsorPointResource_profileFishing_1";
  const bubbleItem = "sponsorPointResource_chatBubble_cute_cat_1";
  const borderItem = "t_avatarBorder_SpringFestival2026_LuckyHorseCat2";
  const uncappedItem = "sponsorPointResource_avatarBorder_kittyRing2";
  await grant(backend, gm, registeredA.user.uuid, [
    { resourceId: battleItem, count: 2 },
    { resourceId: profileItem, count: 1 },
    { resourceId: bubbleItem, count: 1 },
    { resourceId: borderItem, count: 2 },
    { resourceId: uncappedItem, count: 2 }
  ]);

  await t.test("maxUseEachTime rejection and duplicate use consume nothing", async () => {
    const tooMany = await use(backend, a1, battleItem, 2);
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.value.message, /只能使用 1 个/);
    assert.equal(await inventoryCount(backend, a1, battleItem), 2);

    const sameUserPush = backend.waitEvent(a2, "style:get:success", { predicate: (value) => value.style?.availableBattleCardStyles?.includes("warrior") });
    const accepted = await use(backend, a1, battleItem, 1);
    assert.equal(accepted.ok, true);
    await sameUserPush;
    assert.equal(await inventoryCount(backend, a1, battleItem), 1);

    const duplicate = await use(backend, a1, battleItem, 1);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.value.message, /已经解锁/);
    assert.equal(await inventoryCount(backend, a1, battleItem), 1);
  });

  await t.test("all cosmetic categories and malformed Cat2 metadata grant exact owned keys", async () => {
    for (const itemId of [profileItem, bubbleItem, borderItem]) assert.equal((await use(backend, a1, itemId)).ok, true);
    const self = await style(backend, a1);
    assert.deepEqual(self.style.availableBattleCardStyles, ["warrior"]);
    assert.deepEqual(self.style.availableProfileStyles, ["fishing_1"]);
    assert.deepEqual(self.style.availableChatBubbleStyles, ["cute_cat_1"]);
    assert.deepEqual(self.style.availableAvatarBorders, ["SpringFestival2026_LuckyHorseCat2"]);
    assert.equal(self.style.availableAvatarBorders.includes("SpringFestival2026_LuckyHorseCat"), false);

    const guardedDuplicate = await use(backend, a1, borderItem, 1);
    assert.equal(guardedDuplicate.ok, false);
    assert.equal(await inventoryCount(backend, a1, borderItem), 1);

    const uncappedMany = await use(backend, a1, uncappedItem, 2);
    assert.equal(uncappedMany.ok, false);
    assert.match(uncappedMany.value.message, /只能使用 1 个/);
    assert.equal(await inventoryCount(backend, a1, uncappedItem), 2);
    assert.equal((await use(backend, a1, uncappedItem, 1)).ok, true);
    const after = await style(backend, a1);
    assert.equal(after.style.availableAvatarBorders.filter((key) => key === "kittyRing2").length, 1);
  });

  await t.test("remote Style projection never exposes ownership, DIY, versions or flags", async () => {
    const remote = await style(backend, b, registeredA.user.uuid);
    assert.deepEqual(Object.keys(remote.style).sort(), [
      "currentAvatarBorder", "currentBattleCardStyle", "currentChatBubbleStyle",
      "currentChatContentStyle", "currentChatNameStyle", "currentProfileStyle"
    ].sort());
    assert.equal(JSON.stringify(remote).includes("available"), false);
    assert.equal(JSON.stringify(remote).includes("uniqueFlag"), false);
    assert.equal(JSON.stringify(remote).includes("version"), false);
  });

  await t.test("entitlements and inventory survive process-only restart", async () => {
    await backend.hardKillProcess();
    await backend.launch();
    const loggedIn = await backend.login(ACCOUNT_A);
    const socket = (await backend.connect(loggedIn.cookie)).socket;
    const restored = await style(backend, socket);
    assert.equal(restored.style.availableAvatarBorders.includes("SpringFestival2026_LuckyHorseCat2"), true);
    assert.equal(restored.style.availableAvatarBorders.includes("kittyRing2"), true);
  });
});

test("Phase 1 mutations roll back synchronously on players.json failure", { timeout: 90_000 }, async (t) => {
  const backend = await BackendHarness.start(t, { env: { MAOMAO_GM_PASSWORD: GM_PASSWORD } });
  const registered = await backend.register({ ...ACCOUNT_A, email: "phase1-rollback@example.invalid" });
  const primary = (await backend.connect(registered.cookie)).socket;
  const peer = (await backend.connect(registered.cookie)).socket;
  const gm = await gmCookie(backend);
  const itemId = "sponsorPointResource_battleStyleWarrior";
  await grant(backend, gm, registered.user.uuid, [{ resourceId: itemId, count: 1 }]);
  await waitForPlayerDisk(backend, registered.user.uuid, (player) => player.inventory?.[itemId]?.count === 1);

  await t.test("personalization returns PERSISTENCE_ERROR and preserves memory, disk, version and timestamp", async () => {
    const beforeMemory = await backend.playerSnapshot(registered.user.uuid);
    const beforeDisk = await readPlayerDisk(backend, registered.user.uuid);
    await backend.failNextPlayerPersistence();
    const outcome = await assertPeerQuiet(backend, peer, ["userPersonalization:setFavorites:success"], () =>
      emitOutcome(backend, primary, "userPersonalization:setFavorites", {
        favorites: [itemId], expectedVersion: beforeMemory.personalization.version
      }, "userPersonalization:setFavorites:success", "userPersonalization:error"));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.value.code, "PERSISTENCE_ERROR");
    const afterMemory = await backend.playerSnapshot(registered.user.uuid);
    const afterDisk = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(playerPhaseOneView(afterMemory), playerPhaseOneView(beforeMemory));
    assert.deepEqual(playerPhaseOneView(afterDisk), playerPhaseOneView(beforeDisk));
  });

  await t.test("style returns PERSISTENCE_ERROR and preserves memory and disk exactly", async () => {
    const beforeMemory = await backend.playerSnapshot(registered.user.uuid);
    const beforeDisk = await readPlayerDisk(backend, registered.user.uuid);
    const current = await style(backend, primary);
    await backend.failNextPlayerPersistence();
    const outcome = await assertPeerQuiet(backend, peer, ["style:setAll:success"], () =>
      emitOutcome(backend, primary, "style:setAll", {
        style: styleRequest(current.style), expectedVersion: current.style.version
      }, "style:setAll:success", "style:setAll:fail"));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.value.code, "PERSISTENCE_ERROR");
    const afterMemory = await backend.playerSnapshot(registered.user.uuid);
    const afterDisk = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(playerPhaseOneView(afterMemory), playerPhaseOneView(beforeMemory));
    assert.deepEqual(playerPhaseOneView(afterDisk), playerPhaseOneView(beforeDisk));
  });

  await t.test("cosmetic returns PERSISTENCE_ERROR without inventory, flag, style or peer-success side effects", async () => {
    const beforeMemory = await backend.playerSnapshot(registered.user.uuid);
    const beforeDisk = await readPlayerDisk(backend, registered.user.uuid);
    await backend.failNextPlayerPersistence();
    const outcome = await assertPeerQuiet(backend, peer, ["style:get:success", "effectAction:useItem:success"], () => use(backend, primary, itemId));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.value.code, "PERSISTENCE_ERROR");
    const afterMemory = await backend.playerSnapshot(registered.user.uuid);
    const afterDisk = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(playerPhaseOneView(afterMemory), playerPhaseOneView(beforeMemory));
    assert.deepEqual(playerPhaseOneView(afterDisk), playerPhaseOneView(beforeDisk));
    assert.equal(await inventoryCount(backend, primary, itemId), 1);
  });

  await t.test("pending full flush persists prior social state and retries only rolled-back player state", async () => {
    const before = await backend.playerSnapshot(registered.user.uuid);
    await backend.persistenceControl({ frozen: true, resetCounters: true });
    const content = "pending-social-before-injected-phase-one-failure";
    const pushed = backend.waitEvent(primary, "chat:newPublicChatMsg");
    emit(primary, "chat:createPublicChatMsg", { content });
    const message = await pushed;
    const pending = await backend.persistenceState();
    assert.equal(pending.frozen, true);
    assert.equal(pending.pendingFullFlush, true);

    await backend.failNextPlayerPersistence();
    const outcome = await emitOutcome(backend, primary, "userPersonalization:setFavorites", {
      favorites: [itemId], expectedVersion: before.personalization.version
    }, "userPersonalization:setFavorites:success", "userPersonalization:error");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.value.code, "PERSISTENCE_ERROR");
    await backend.awaitPhaseOneIdle(registered.user.uuid);
    const failedBranch = await backend.persistenceState();
    assert.equal(failedBranch.counters.phaseOnePendingBranchStarted, 1);
    assert.equal(failedBranch.counters.phaseOnePendingBranchCompleted, 0);
    assert.equal(failedBranch.counters.phaseOnePendingBranchFailed, 1);
    assert.equal(failedBranch.counters.phaseOneRetryScheduled, 1);
    assert.equal(failedBranch.pendingFullFlush, true);

    const persistedSocial = JSON.parse(await fs.readFile(backend.files.social, "utf8"));
    assert.equal(persistedSocial.chatMessages.some((candidate) => candidate.id === message.id && candidate.content === content), true);
    await backend.persistenceControl({ frozen: false });
    const retriedState = await backend.awaitFullFlushIdle();
    assert.equal(retriedState.counters.phaseOneRetryStarted, 1);
    assert.equal(retriedState.counters.phaseOneRetryCompleted, 1);
    const retried = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(retried.personalization, before.personalization);
    const afterMemory = await backend.playerSnapshot(registered.user.uuid);
    assert.deepEqual(afterMemory.personalization, before.personalization);
  });
});

test("cosmetic boundaries, timestamps and same-user serialization are transactional", { timeout: 90_000 }, async (t) => {
  const backend = await BackendHarness.start(t, { env: { MAOMAO_GM_PASSWORD: GM_PASSWORD } });
  const registered = await backend.register({ ...ACCOUNT_A, email: "phase1-serialization@example.invalid" });
  const first = (await backend.connect(registered.cookie)).socket;
  const second = (await backend.connect(registered.cookie)).socket;
  const gm = await gmCookie(backend);
  const warriorItem = "sponsorPointResource_battleStyleWarrior";
  const profileItem = "sponsorPointResource_profileFishing_1";
  await grant(backend, gm, registered.user.uuid, [
    { resourceId: warriorItem, count: 2 },
    { resourceId: profileItem, count: 2 }
  ]);
  await waitForPlayerDisk(backend, registered.user.uuid, (player) => player.inventory?.[warriorItem]?.count === 2);

  await t.test("successful cosmetic use advances version and timestamp", async () => {
    const before = await style(backend, first);
    const used = await use(backend, first, warriorItem);
    assert.equal(used.ok, true);
    const after = await style(backend, first);
    assert.equal(after.style.version, before.style.version + 1);
    assert.equal(typeof after.style.updatedAt, "string");
    assert.equal(Date.parse(after.style.updatedAt) >= (before.style.updatedAt ? Date.parse(before.style.updatedAt) : 0), true);
  });

  await t.test("same-user double-use serializes: exactly one consumes and unlocks", async () => {
    const baseline = await backend.playerSnapshot(registered.user.uuid);
    const [left, right] = await Promise.all([use(backend, first, profileItem), use(backend, second, profileItem)]);
    await backend.awaitPhaseOneIdle(registered.user.uuid);
    assert.equal([left, right].filter((result) => result.ok).length, 1);
    assert.equal([left, right].filter((result) => !result.ok).length, 1);
    assert.match([left, right].find((result) => !result.ok).value.message, /已经解锁/);
    const after = await backend.playerSnapshot(registered.user.uuid);
    assert.equal(after.style.version, baseline.style.version + 1);
    assert.equal(after.inventory[profileItem].count, baseline.inventory[profileItem].count - 1);
    assert.equal(after.style.owned.profile.filter((key) => key === "fishing_1").length, 1);
  });

  await t.test("concurrent cosmetic and style:setAll serialize without lost updates", async () => {
    const borderItem = "sponsorPointResource_avatarBorder_kittyRing2";
    await grant(backend, gm, registered.user.uuid, [{ resourceId: borderItem, count: 1 }]);
    const baseline = await style(backend, first);
    const setPayload = styleRequest(baseline.style);
    setPayload.currentBattleCardStyle = "warrior";
    const [cosmetic, setAll] = await Promise.all([
      use(backend, first, borderItem),
      emitOutcome(backend, second, "style:setAll", { style: setPayload }, "style:setAll:success", "style:setAll:fail")
    ]);
    await backend.awaitPhaseOneIdle(registered.user.uuid);
    assert.equal(cosmetic.ok, true);
    assert.equal(setAll.ok, true);
    const after = await style(backend, first);
    assert.equal(after.style.version, baseline.style.version + 2);
    assert.equal(after.style.currentBattleCardStyle, "warrior");
    assert.equal(after.style.availableAvatarBorders.includes("kittyRing2"), true);
    assert.equal(await inventoryCount(backend, first, borderItem), 0);
  });

  await t.test("exactly 500 distinct valid flags reject a new cosmetic with no side effects", async () => {
    const boundaryItem = "sponsorPointResource_chatBubble_cute_cat_1";
    await grant(backend, gm, registered.user.uuid, [{ resourceId: boundaryItem, count: 1 }]);
    const seeded = await backend.playerSnapshot(registered.user.uuid, {
      patch: { uniqueFlag: Array.from({ length: 500 }, (_, index) => ({ type: `test-${index}`, key: `flag-${index}` })) }
    });
    assert.equal(seeded.uniqueFlag.length, 500);
    const syncBoundary = await emitOutcome(backend, first, "style:setAll", {
      style: styleRequest((await style(backend, first)).style)
    }, "style:setAll:success", "style:setAll:fail");
    assert.equal(syncBoundary.ok, true);
    const before = await backend.playerSnapshot(registered.user.uuid);
    const diskBefore = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(playerPhaseOneView(diskBefore), playerPhaseOneView(before));
    const rejected = await use(backend, first, boundaryItem);
    assert.equal(rejected.ok, false);
    assert.match(rejected.value.message, /数量已达上限/);
    const after = await backend.playerSnapshot(registered.user.uuid);
    const diskAfter = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(playerPhaseOneView(after), playerPhaseOneView(before));
    assert.deepEqual(playerPhaseOneView(diskAfter), playerPhaseOneView(diskBefore));
  });

  await t.test("more than 500 legacy flags survive normalization, persistence and restart without expanding owned style beyond 500", async () => {
    const legacyItem = "sponsorPointResource_chatBubble_cute_cat_2";
    await grant(backend, gm, registered.user.uuid, [{ resourceId: legacyItem, count: 1 }]);
    const legacyFlags = Array.from({ length: 550 }, (_, index) => ({
      type: index < 510 ? "chatBubble" : `legacy-${index}`,
      key: index < 510 ? `legacyBubble-${index}` : `flag-${index}`
    }));
    const seeded = await backend.playerSnapshot(registered.user.uuid, { patch: { uniqueFlag: legacyFlags } });
    assert.equal(seeded.uniqueFlag.length, 550);
    assert.equal(seeded.style.owned.chatBubble.length <= 500, true);
    const syncLegacy = await emitOutcome(backend, first, "style:setAll", {
      style: styleRequest((await style(backend, first)).style)
    }, "style:setAll:success", "style:setAll:fail");
    assert.equal(syncLegacy.ok, true);
    const saved = await readPlayerDisk(backend, registered.user.uuid);
    assert.deepEqual(saved.uniqueFlag, legacyFlags);
    assert.equal(saved.style.owned.chatBubble.length <= 500, true);
    await backend.hardKillProcess();
    await backend.launch();
    const socket = (await backend.connect((await backend.login({ ...ACCOUNT_A, email: "phase1-serialization@example.invalid" })).cookie)).socket;
    const restored = await backend.playerSnapshot(registered.user.uuid);
    assert.deepEqual(restored.uniqueFlag, legacyFlags);
    assert.equal(restored.style.owned.chatBubble.length <= 500, true);
    const before = playerPhaseOneView(restored);
    const rejected = await use(backend, socket, legacyItem);
    assert.equal(rejected.ok, false);
    assert.match(rejected.value.message, /数量已达上限/);
    assert.deepEqual(playerPhaseOneView(await backend.playerSnapshot(registered.user.uuid)), before);
    assert.deepEqual((await readPlayerDisk(backend, registered.user.uuid)).uniqueFlag, legacyFlags);
  });
});
