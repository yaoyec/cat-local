import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { a as resourceCatalog } from "../../../pulled-frontend/_nuxt/game-json-resources-C7HDgHOG.js";
import { BackendHarness } from "./harness.js";

const ACCOUNT_A = { nickname: "个性化测试猫甲", email: "phase1-a@example.invalid", password: "phase-one-password-a" };
const ACCOUNT_B = { nickname: "个性化测试猫乙", email: "phase1-b@example.invalid", password: "phase-one-password-b" };
const PERSONALIZATION_EVENTS = [
  "userPersonalization:get:success",
  "userPersonalization:setFavorites:success",
  "userPersonalization:error",
  "userPersonalization:get:error",
  "userPersonalization:get:fail",
  "userPersonalization:setFavorites:error",
  "userPersonalization:setFavorites:fail"
];
const STYLE_EVENTS = [
  "style:get:success",
  "style:get:error",
  "style:get:fail",
  "style:setAll:success",
  "style:setAll:error",
  "style:setAll:fail"
];
const CHAT_EVENTS = [
  "chat:newPublicChatMsg",
  "chat:getChatList:success",
  "chat:createPublicMessage:error"
];
const LEGACY_TIMESTAMP = "2021-02-03T04:05:06.000Z";
const LEGACY_DIY = {
  bgColor: ["#112233", "#112233", "not-a-color", "#445566"],
  textColor: ["#FFFFFF", "#ffffff", "#aabbcc"],
  textShadow: [{ color: "#010203", blur: 3 }, { color: "unsafe", blur: 2 }]
};
const MISSING_PLAYER_UUID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_STYLE = {
  availableBattleCardStyles: [],
  currentBattleCardStyle: "",
  availableChatContentStyles: [],
  currentChatContentStyle: "",
  availableChatNameStyles: [],
  currentChatNameStyle: "",
  availableProfileStyles: [],
  currentProfileStyle: "",
  availableChatBubbleStyles: [],
  currentChatBubbleStyle: "",
  availableAvatarBorders: [],
  currentAvatarBorder: "",
  diyChatBubbleStyle: { bgColor: [], textColor: [], textShadow: [] }
};
const KNOWN_RESOURCE_IDS = Object.values(resourceCatalog)
  .filter((resource) => resource?.id && resourceCatalog[resource.id] === resource)
  .map((resource) => resource.id);

function encode(payload = {}) {
  return JSON.stringify({ data: payload });
}

function decodeExact(raw, label = "socket result") {
  assert.equal(typeof raw, "string", `${label} must be a JSON string envelope`);
  const envelope = JSON.parse(raw);
  assert.equal(envelope && typeof envelope === "object" && !Array.isArray(envelope), true, `${label} envelope must be an object`);
  assert.deepEqual(Object.keys(envelope), ["data"], `${label} must contain exactly {data: ...}`);
  return envelope.data;
}

function emitRaw(socket, event, raw) {
  socket.emit(event, raw);
}

function emit(socket, event, payload = {}) {
  emitRaw(socket, event, encode(payload));
}

function onceDecoded(backend, socket, event, options) {
  return backend.waitEvent(socket, event, { ...options, decode: false }).then((raw) => decodeExact(raw, event));
}

function emitBackToBackAndCollect(collectors, { outbound, payloads, successEvent, errorEvent }) {
  assert.equal(collectors.length, payloads.length);
  for (const collector of collectors) collector.clear();
  payloads.forEach((payload, index) => emit(collectors[index].socket, outbound, payload));
}

async function waitForExactlyOneConflict(collectors, successEvent, errorEvent, backend, uuid) {
  await Promise.all(collectors.map((collector) => Promise.race([
    collector.waitFor(successEvent),
    collector.waitFor(errorEvent)
  ])));
  await backend.awaitPhaseOneIdle(uuid);

  const perSocket = collectors.map((collector) => ({
    successes: collector.matching(successEvent),
    errors: collector.matching(errorEvent)
  }));
  for (const [index, result] of perSocket.entries()) {
    assert.equal(result.successes.length, 1, `socket ${index} must receive the winner broadcast exactly once`);
    assert.equal(result.errors.length <= 1, true, `socket ${index} must receive at most one conflict`);
  }
  const errors = perSocket.flatMap((result, socketIndex) => result.errors.map((record) => ({ socketIndex, record })));
  assert.equal(errors.length, 1, "exactly one CAS requester must receive one conflict");
  const winnerPayloads = perSocket.map((result) => decodeExact(result.successes[0].raw, successEvent));
  for (const payload of winnerPayloads.slice(1)) assert.deepEqual(payload, winnerPayloads[0], "winner payload must be identical on every player socket");
  return {
    conflict: decodeExact(errors[0].record.raw, errorEvent),
    winner: winnerPayloads[0],
    loserSocketIndex: errors[0].socketIndex
  };
}

function assertChatSnapshot(message, { bubble, diy, content }) {
  assert.equal(message && typeof message === "object", true);
  if (content !== undefined) assert.equal(message.content, content);
  assert.equal(message.extra2?.bubble, bubble);
  if (diy === undefined) {
    assert.equal(Object.hasOwn(message.extra2, "bubbleDiyStyle"), false);
  } else {
    assert.equal(Object.hasOwn(message.extra2, "bubbleDiyStyle"), true);
    assert.deepEqual(message.extra2.bubbleDiyStyle, diy);
  }
  return message;
}

function isStructuredError(value) {
  return value && typeof value === "object" && typeof value.code === "string" && value.code.length > 0;
}

function assertStructuredError(raw, label) {
  const value = decodeExact(raw, label);
  assert.equal(isStructuredError(value), true, `${label} must expose a structured string code`);
  return value;
}

function assertPersonalization(value, { favorites, previous } = {}) {
  assert.equal(value && typeof value === "object", true);
  assert.equal(Array.isArray(value.favoriteItems), true);
  assert.equal(Array.isArray(value.categoryOrder), true);
  assert.equal(Number.isSafeInteger(value.version) && value.version >= 0, true);
  assert.equal(value.updatedAt === null || typeof value.updatedAt === "string", true);
  if (typeof value.updatedAt === "string") assert.equal(Number.isNaN(Date.parse(value.updatedAt)), false);
  if (favorites) assert.deepEqual(value.favoriteItems, favorites);
  if (previous) {
    assert.equal(value.version >= previous.version, true);
    if (value.updatedAt !== null && previous.updatedAt !== null) {
      assert.equal(Date.parse(value.updatedAt) >= Date.parse(previous.updatedAt), true);
    }
  }
  return value;
}

function assertSetFavorites(value, favorites, previous) {
  assert.equal(value && typeof value === "object", true);
  assert.deepEqual(value.favoriteItems, favorites);
  assert.equal(Array.isArray(value.categoryOrder), true);
  if (previous) assert.deepEqual(value.categoryOrder, previous.categoryOrder);
  assert.equal(Number.isSafeInteger(value.version) && value.version >= 0, true);
  assert.equal(typeof value.updatedAt, "string");
  assert.equal(Number.isNaN(Date.parse(value.updatedAt)), false);
  if (previous) {
    assert.equal(value.version, previous.version + 1, "an accepted mutation must advance version exactly once");
    if (previous.updatedAt !== null) assert.equal(Date.parse(value.updatedAt) >= Date.parse(previous.updatedAt), true);
  }
  return value;
}

function assertStyleShape(style) {
  assert.equal(style && typeof style === "object" && !Array.isArray(style), true);
  const core = { ...style };
  if (Object.hasOwn(core, "version")) {
    assert.equal(Number.isSafeInteger(core.version) && core.version >= 0, true);
    delete core.version;
  }
  if (Object.hasOwn(core, "updatedAt")) {
    assert.equal(core.updatedAt === null || (typeof core.updatedAt === "string" && !Number.isNaN(Date.parse(core.updatedAt))), true);
    delete core.updatedAt;
  }
  for (const key of [
    "availableBattleCardStyles",
    "availableChatContentStyles",
    "availableChatNameStyles",
    "availableProfileStyles",
    "availableChatBubbleStyles",
    "availableAvatarBorders"
  ]) assert.equal(Array.isArray(style[key]), true, `${key} must be an array`);
  for (const key of [
    "currentBattleCardStyle",
    "currentChatContentStyle",
    "currentChatNameStyle",
    "currentProfileStyle",
    "currentChatBubbleStyle",
    "currentAvatarBorder"
  ]) assert.equal(typeof style[key], "string", `${key} must be a string`);
  assert.equal(style.diyChatBubbleStyle && typeof style.diyChatBubbleStyle === "object", true);
  assert.equal(Array.isArray(style.diyChatBubbleStyle.bgColor), true);
  assert.equal(Array.isArray(style.diyChatBubbleStyle.textColor), true);
  assert.equal(Array.isArray(style.diyChatBubbleStyle.textShadow), true);
  return style;
}

function assertDefaultStyle(style) {
  assertStyleShape(style);
  const { version, updatedAt, ...wireDefaults } = style;
  assert.deepEqual(wireDefaults, DEFAULT_STYLE);
}

function assertStyleGet(value, uuid) {
  assert.equal(value && typeof value === "object", true);
  assert.equal(value.uuid, uuid);
  assertStyleShape(value.style);
  return value;
}

async function requestRaw(backend, socket, event, raw, successEvent, collector) {
  const startIndex = collector.cursor() - 1;
  const success = collector.waitFor(successEvent, { predicate: (record) => record.index > startIndex });
  emitRaw(socket, event, raw);
  return (await success).raw;
}

async function request(backend, socket, event, payload, successEvent, collector) {
  return requestRaw(backend, socket, event, encode(payload), successEvent, collector);
}

async function expectDesignatedError(options) {
  const { backend, socket, collector, event, payload, designated, forbidden = [] } = options;
  const startIndex = collector.cursor() - 1;
  const waiting = collector.waitFor(designated, { predicate: (record) => record.index > startIndex });
  const noForbidden = backend.assertNoEvents(socket, forbidden, () => {
    emitRaw(socket, event, Object.hasOwn(options, "raw") ? options.raw : encode(payload));
  }, 300);
  const record = await waiting;
  const error = assertStructuredError(record.raw, designated);
  await noForbidden;
  return error;
}

function containsDeep(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value) && Array.isArray(expected) && value.length === expected.length && value.every((entry, index) => entry === expected[index])) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsDeep(child, expected));
}

function styleForRequest(style) {
  const requestStyle = structuredClone(style);
  delete requestStyle.version;
  delete requestStyle.updatedAt;
  return requestStyle;
}

function makeOwnedStyle(style) {
  const next = styleForRequest(style);
  const choices = [
    ["availableBattleCardStyles", "currentBattleCardStyle"],
    ["availableChatContentStyles", "currentChatContentStyle"],
    ["availableChatNameStyles", "currentChatNameStyle"],
    ["availableProfileStyles", "currentProfileStyle"],
    ["availableChatBubbleStyles", "currentChatBubbleStyle"],
    ["availableAvatarBorders", "currentAvatarBorder"]
  ];
  for (const [availableKey, currentKey] of choices) {
    if (next[availableKey].length) {
      next[currentKey] = next[availableKey][0];
      return { style: next, currentKey };
    }
  }
  return null;
}

await test("phase-one personalization and style socket contracts", { timeout: 120_000 }, async (t) => {
  const gmPassword = "phase-one-test-gm-password";
  const backend = await BackendHarness.start(t, { env: { MAOMAO_GM_PASSWORD: gmPassword } });
  const registeredA = await backend.register(ACCOUNT_A);
  const registeredB = await backend.register(ACCOUNT_B);
  const connectionA1 = await backend.connect(registeredA.cookie);
  const connectionA2 = await backend.connect(registeredA.cookie);
  const connectionB = await backend.connect(registeredB.cookie);
  let socketA1 = connectionA1.socket;
  let socketA2 = connectionA2.socket;
  let socketB = connectionB.socket;
  let collectA1 = backend.collectRawEvents(socketA1, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
  let collectA2 = backend.collectRawEvents(socketA2, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
  let collectB = backend.collectRawEvents(socketB, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
  t.after(() => {
    collectA1?.stop();
    collectA2?.stop();
    collectB?.stop();
  });

  let currentPersonalization;
  let currentStyle;

  await t.test("defaults and success replies use exact string envelopes", async () => {
    const personalizationRaw = await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1);
    currentPersonalization = assertPersonalization(decodeExact(personalizationRaw, "userPersonalization:get:success"));
    assert.deepEqual(currentPersonalization.favoriteItems, []);
    assert.deepEqual(currentPersonalization.categoryOrder, []);

    const styleRaw = await request(backend, socketA1, "style:get", {}, "style:get:success", collectA1);
    const styleResult = assertStyleGet(decodeExact(styleRaw, "style:get:success"), registeredA.user.uuid);
    assertDefaultStyle(styleResult.style);
    currentStyle = styleResult.style;

    const explicitSelfRaw = await request(backend, socketA1, "style:get", { uuid: registeredA.user.uuid }, "style:get:success", collectA1);
    const explicitSelf = assertStyleGet(decodeExact(explicitSelfRaw, "style:get:success"), registeredA.user.uuid);
    assert.deepEqual(explicitSelf.style, currentStyle);
  });

  await t.test("malformed JSON and wrong envelopes fail only on designated events", async () => {
    for (const raw of [
      "{not-json",
      undefined,
      { data: {} },
      JSON.stringify({ user: registeredA.user, data: {} }),
      JSON.stringify({ data: {}, extra: true }),
      JSON.stringify({ data: [] }),
      JSON.stringify({ data: "direct" }),
      JSON.stringify([]),
      JSON.stringify(7)
    ]) {
      collectA1.clear();
      const error = await expectDesignatedError({
        backend,
        socket: socketA1,
        collector: collectA1,
        event: "userPersonalization:get",
        raw,
        designated: "userPersonalization:error",
        forbidden: ["userPersonalization:get:success", "userPersonalization:get:error", "userPersonalization:get:fail"]
      });
      assert.equal(error.code, "INVALID_PAYLOAD");
    }
    const nullSelfRaw = await request(backend, socketA1, "style:get", null, "style:get:success", collectA1);
    assert.deepEqual(assertStyleGet(decodeExact(nullSelfRaw), registeredA.user.uuid).style, currentStyle);

    for (const raw of ["{not-json", undefined, { data: {} }, JSON.stringify({ user: registeredA.user, data: {} }), JSON.stringify({ uuid: registeredA.user.uuid }), JSON.stringify({ data: {}, extra: true }), JSON.stringify({ data: [] }), encode({ uuid: 123 }), encode({ uuid: "" }), encode({ uuid: "not-a-uuid" })]) {
      collectA1.clear();
      const error = await expectDesignatedError({
        backend,
        socket: socketA1,
        collector: collectA1,
        event: "style:get",
        raw,
        designated: "style:get:fail",
        forbidden: ["style:get:success", "style:get:error"]
      });
      assert.equal(error.code, "INVALID_PAYLOAD");
      assert.deepEqual(Object.keys(error).sort(), ["code", "message"]);
    }
    for (const raw of ["{not-json", { data: { favorites: ["stone"] } }, JSON.stringify({ user: registeredB.user, data: { favorites: ["stone"] } }), JSON.stringify({ favorites: ["stone"] }), JSON.stringify({ data: { favorites: ["stone"] }, extra: true })]) {
      collectA1.clear();
      const error = await expectDesignatedError({
        backend,
        socket: socketA1,
        collector: collectA1,
        event: "userPersonalization:setFavorites",
        raw,
        designated: "userPersonalization:error",
        forbidden: ["userPersonalization:setFavorites:success", "userPersonalization:setFavorites:error", "userPersonalization:setFavorites:fail"]
      });
      assert.equal(error.code, "INVALID_PAYLOAD");
    }
    for (const raw of ["{not-json", { data: { style: {} } }, JSON.stringify({ user: registeredB.user, data: { style: {} } }), JSON.stringify({ style: {} }), JSON.stringify({ data: { style: {} }, extra: true })]) {
      collectA1.clear();
      const error = await expectDesignatedError({
        backend,
        socket: socketA1,
        collector: collectA1,
        event: "style:setAll",
        raw,
        designated: "style:setAll:fail",
        forbidden: ["style:setAll:success", "style:setAll:error"]
      });
      assert.equal(error.code, "INVALID_PAYLOAD");
    }
  });

  await t.test("favorites accept 500 unique known IDs and reject unknown, duplicate and oversized writes atomically", async () => {
    assert.equal(KNOWN_RESOURCE_IDS.length >= 501, true, "resource catalog must provide boundary fixtures");
    const boundary = KNOWN_RESOURCE_IDS.slice(0, 500);
    collectA1.clear();
    collectA2.clear();
    collectB.clear();
    const successWait = collectA1.waitFor("userPersonalization:setFavorites:success");
    const sameUserPush = collectA2.waitFor("userPersonalization:setFavorites:success");
    const noOtherUser = backend.assertNoEvents(socketB, PERSONALIZATION_EVENTS, () => {
      emit(socketA1, "userPersonalization:setFavorites", { favorites: boundary });
    }, 350);
    const [successRecord, pushRecord] = await Promise.all([successWait, sameUserPush]);
    await noOtherUser;
    const accepted = assertSetFavorites(decodeExact(successRecord.raw), boundary, currentPersonalization);
    assert.deepEqual(decodeExact(pushRecord.raw), accepted);
    currentPersonalization = { ...currentPersonalization, ...accepted };
    const boundaryGetRaw = await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1);
    const boundaryView = assertPersonalization(decodeExact(boundaryGetRaw));
    assert.deepEqual(boundaryView.categoryOrder, currentPersonalization.categoryOrder);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(collectA1.count("userPersonalization:setFavorites:success"), 1);
    assert.equal(collectA2.count("userPersonalization:setFavorites:success"), 1);
    assert.equal(collectB.count("userPersonalization:setFavorites:success"), 0);

    const invalidCases = [
      {},
      { favorites: "stone" },
      { favorites: [boundary[0], "definitely-not-a-resource-id"] },
      { favorites: [boundary[0], boundary[0]] },
      { favorites: KNOWN_RESOURCE_IDS.slice(0, 501) }
    ];
    for (const payload of invalidCases) {
      collectA1.clear();
      collectA2.clear();
      collectB.clear();
      await expectDesignatedError({
        backend,
        socket: socketA1,
        collector: collectA1,
        event: "userPersonalization:setFavorites",
        payload,
        designated: "userPersonalization:error",
        forbidden: ["userPersonalization:setFavorites:success", "userPersonalization:setFavorites:error", "userPersonalization:setFavorites:fail"]
      });
      assert.equal(collectA2.count("userPersonalization:setFavorites:success"), 0);
      assert.equal(collectB.count("userPersonalization:setFavorites:success"), 0);
      const afterRaw = await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1);
      const after = assertPersonalization(decodeExact(afterRaw));
      assert.deepEqual(after.favoriteItems, boundary);
      assert.deepEqual(after.categoryOrder, currentPersonalization.categoryOrder);
      assert.equal(after.version, currentPersonalization.version);
      assert.equal(after.updatedAt, currentPersonalization.updatedAt);
    }
  });

  await t.test("category order writes atomically and survives later favorite-only saves", async () => {
    const order = ["currency", "material", "usable"];
    collectA1.clear();
    collectA2.clear();
    const successA1 = collectA1.waitFor("userPersonalization:setFavorites:success");
    const successA2 = collectA2.waitFor("userPersonalization:setFavorites:success");
    emit(socketA1, "userPersonalization:setFavorites", { categoryOrder: order, expectedVersion: currentPersonalization.version });
    const [recordA1] = await Promise.all([successA1, successA2]);
    const accepted = decodeExact(recordA1.raw);
    assert.deepEqual(accepted.favoriteItems, currentPersonalization.favoriteItems);
    assert.deepEqual(accepted.categoryOrder, order);
    assert.equal(accepted.version, currentPersonalization.version + 1);
    currentPersonalization = { ...currentPersonalization, ...accepted };

    const before = structuredClone(currentPersonalization);
    for (const invalidOrder of [["currency", "currency"], [""], ["x".repeat(101)], Array.from({ length: 101 }, (_, index) => `category-${index}`)]) {
      collectA1.clear();
      const failure = collectA1.waitFor("userPersonalization:error");
      emit(socketA1, "userPersonalization:setFavorites", { categoryOrder: invalidOrder });
      assert.equal(assertStructuredError((await failure).raw).code, "INVALID_PAYLOAD");
      const after = assertPersonalization(decodeExact(await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1)));
      assert.deepEqual(after, before);
    }

    collectA1.clear();
    collectA2.clear();
    const nextFavorites = ["wood", "stone"];
    const nextA1 = collectA1.waitFor("userPersonalization:setFavorites:success");
    const nextA2 = collectA2.waitFor("userPersonalization:setFavorites:success");
    emit(socketA2, "userPersonalization:setFavorites", { favorites: nextFavorites });
    const [nextRecord] = await Promise.all([nextA1, nextA2]);
    const next = assertSetFavorites(decodeExact(nextRecord.raw), nextFavorites, currentPersonalization);
    currentPersonalization = { ...currentPersonalization, ...next };
    assert.deepEqual(currentPersonalization.categoryOrder, order);
  });

  await t.test("favorites enforce CAS and arrival-order last-write-wins without expectedVersion", async () => {
    const first = ["stone", "coal"];
    const second = ["iron", "sand"];
    collectA1.clear();
    collectA2.clear();
    const firstA1Wait = collectA1.waitFor("userPersonalization:setFavorites:success");
    const firstA2Wait = collectA2.waitFor("userPersonalization:setFavorites:success");
    emit(socketA1, "userPersonalization:setFavorites", { favorites: first });
    await Promise.all([firstA1Wait, firstA2Wait]);
    collectA1.clear();
    collectA2.clear();
    const secondA1Wait = collectA1.waitFor("userPersonalization:setFavorites:success");
    const secondA2Wait = collectA2.waitFor("userPersonalization:setFavorites:success");
    emit(socketA2, "userPersonalization:setFavorites", { favorites: second });
    const [secondA1, secondA2] = await Promise.all([secondA1Wait, secondA2Wait]);
    currentPersonalization = { ...currentPersonalization, ...assertSetFavorites(decodeExact(secondA1.raw), second) };
    assert.deepEqual(decodeExact(secondA2.raw), decodeExact(secondA1.raw));
    const lwwRaw = await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1);
    assert.deepEqual(assertPersonalization(decodeExact(lwwRaw)).favoriteItems, second);

    collectA1.clear();
    collectA2.clear();
    const casPayload = { favorites: ["steel"], expectedVersion: currentPersonalization.version };
    const casA1Wait = collectA1.waitFor("userPersonalization:setFavorites:success");
    const casA2Wait = collectA2.waitFor("userPersonalization:setFavorites:success");
    emit(socketA1, "userPersonalization:setFavorites", casPayload);
    const [casA1, casA2] = await Promise.all([casA1Wait, casA2Wait]);
    const casAccepted = assertSetFavorites(decodeExact(casA1.raw), casPayload.favorites, currentPersonalization);
    assert.deepEqual(decodeExact(casA2.raw), decodeExact(casA1.raw));
    currentPersonalization = { ...currentPersonalization, ...casAccepted };
    collectA1.clear();
    collectA2.clear();
    const staleWait = collectA2.waitFor("userPersonalization:error");
    emit(socketA2, "userPersonalization:setFavorites", { favorites: ["silverOre"], expectedVersion: currentPersonalization.version - 1 });
    const staleError = assertStructuredError((await staleWait).raw, "stale expectedVersion");
    assert.equal(staleError.code, "VERSION_CONFLICT");
    await backend.awaitPhaseOneIdle(registeredA.user.uuid);
    assert.equal(collectA2.count("userPersonalization:setFavorites:success"), 0);
    const afterRaw = await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1);
    const after = assertPersonalization(decodeExact(afterRaw));
    assert.deepEqual(after.favoriteItems, casPayload.favorites);
    assert.equal(after.version, currentPersonalization.version);
  });

  await t.test("style validates ownership, keys, DIY limits and safe colors atomically", async () => {
    const owned = makeOwnedStyle(currentStyle);
    if (owned) {
      collectA1.clear();
      collectA2.clear();
      collectB.clear();
      const successA1 = collectA1.waitFor("style:setAll:success");
      const successA2 = collectA2.waitFor("style:setAll:success");
      const noOtherUser = backend.assertNoEvents(socketB, STYLE_EVENTS, () => emit(socketA1, "style:setAll", { style: owned.style }), 350);
      const [recordA1, recordA2] = await Promise.all([successA1, successA2]);
      await noOtherUser;
      const setResult = decodeExact(recordA1.raw, "style:setAll:success");
      assert.deepEqual(Object.keys(setResult), ["style"]);
      assert.deepEqual(styleForRequest(setResult.style), owned.style);
      assert.deepEqual(decodeExact(recordA2.raw), setResult);
      assert.equal(setResult.style.version, currentStyle.version + 1);
      assert.equal(Date.parse(setResult.style.updatedAt) >= Date.parse(currentStyle.updatedAt), true);
      currentStyle = setResult.style;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(collectA1.count("style:setAll:success"), 1);
      assert.equal(collectA2.count("style:setAll:success"), 1);
      assert.equal(collectB.count("style:setAll:success"), 0);
    }

    const diyItemId = "sponsorPointResource_chatBubble_diy";
    const gmLogin = await backend.request("/api/gm/login", { method: "POST", json: { password: gmPassword } });
    assert.equal(gmLogin.status, 200);
    const gmCookie = gmLogin.headers.get("set-cookie").split(";", 1)[0];
    const granted = await backend.request(`/api/gm/players/${registeredA.user.uuid}/grant`, {
      method: "POST",
      cookie: gmCookie,
      json: { items: [{ resourceId: diyItemId, count: 1 }] }
    });
    assert.equal(granted.status, 200);
    const usedDiy = backend.waitEvent(socketA1, "effectAction:useItem:success");
    emit(socketA1, "effectAction:useItem", { itemId: diyItemId, multiple: 1 });
    await usedDiy;
    currentStyle = assertStyleGet(decodeExact(await request(backend, socketA1, "style:get", {}, "style:get:success", collectA1)), registeredA.user.uuid).style;

    const safeDiyStyle = {
      ...styleForRequest(currentStyle),
      diyChatBubbleStyle: {
        bgColor: ["#112233", "#223344", "#334455", "#445566", "#556677", "#667788", "#778899"],
        textColor: ["#ffffff", "#eeeeee", "#dddddd", "#cccccc", "#bbbbbb", "#aaaaaa", "#999999"],
        textShadow: [{ color: "#000000", blur: 1 }, { color: "#123456", blur: 10 }]
      }
    };
    collectA1.clear();
    collectA2.clear();
    collectB.clear();
    const safeA1 = collectA1.waitFor("style:setAll:success");
    const safeA2 = collectA2.waitFor("style:setAll:success");
    const noSafeLeak = backend.assertNoEvents(socketB, STYLE_EVENTS, () => emit(socketA1, "style:setAll", { style: safeDiyStyle }), 350);
    const [safeRecordA1, safeRecordA2] = await Promise.all([safeA1, safeA2]);
    await noSafeLeak;
    const safeResult = decodeExact(safeRecordA1.raw, "safe style:setAll:success");
    assert.deepEqual(Object.keys(safeResult), ["style"]);
    assert.deepEqual(styleForRequest(safeResult.style), safeDiyStyle);
    assert.deepEqual(decodeExact(safeRecordA2.raw), safeResult);
    assert.equal(safeResult.style.version, currentStyle.version + 1);
    assert.equal(Date.parse(safeResult.style.updatedAt) >= Date.parse(currentStyle.updatedAt), true);
    currentStyle = safeResult.style;

    const nextCasStyle = styleForRequest(currentStyle);
    nextCasStyle.diyChatBubbleStyle.bgColor = ["#abcdef"];
    collectA1.clear();
    collectA2.clear();
    const previousStyle = currentStyle;
    const casA1Wait = collectA1.waitFor("style:setAll:success");
    const casA2Wait = collectA2.waitFor("style:setAll:success");
    emit(socketA1, "style:setAll", { style: nextCasStyle, expectedVersion: previousStyle.version });
    const [casA1, casA2] = await Promise.all([casA1Wait, casA2Wait]);
    const casResult = decodeExact(casA1.raw, "style expectedVersion success");
    assert.deepEqual(Object.keys(casResult), ["style"]);
    assert.deepEqual(casResult.style.diyChatBubbleStyle.bgColor, ["#abcdef"]);
    assert.deepEqual(decodeExact(casA2.raw), casResult);
    assert.equal(casResult.style.version, previousStyle.version + 1);
    assert.equal(Date.parse(casResult.style.updatedAt) >= Date.parse(previousStyle.updatedAt), true);
    currentStyle = casResult.style;
    collectA1.clear();
    collectA2.clear();
    const staleWait = collectA2.waitFor("style:setAll:fail");
    emit(socketA2, "style:setAll", { style: safeDiyStyle, expectedVersion: currentStyle.version - 1 });
    const stale = assertStructuredError((await staleWait).raw, "stale style expectedVersion");
    assert.equal(stale.code, "VERSION_CONFLICT");
    await backend.awaitPhaseOneIdle(registeredA.user.uuid);
    assert.equal(collectA2.count("style:setAll:success"), 0);
    currentStyle = assertStyleGet(decodeExact(await request(backend, socketA1, "style:get", {}, "style:get:success", collectA1)), registeredA.user.uuid).style;

    const currentRequestStyle = styleForRequest(currentStyle);
    const invalidStyleCases = [
      undefined,
      null,
      {},
      { currentAvatarBorder: "" },
      { ...currentRequestStyle, currentAvatarBorder: "definitely-unowned-avatar-border" },
      { ...currentRequestStyle, unexpectedContractKey: "not-allowed" },
      { ...currentRequestStyle, diyChatBubbleStyle: { bgColor: Array(8).fill("#112233"), textColor: ["#ffffff"], textShadow: [] } },
      { ...currentRequestStyle, diyChatBubbleStyle: { bgColor: ["#112233"], textColor: Array(8).fill("#ffffff"), textShadow: [] } },
      { ...currentRequestStyle, diyChatBubbleStyle: { bgColor: ["#112233"], textColor: ["#ffffff"], textShadow: Array(3).fill({ color: "#000000", blur: 1 }) } },
      { ...currentRequestStyle, diyChatBubbleStyle: { bgColor: ["url(javascript:alert(1))"], textColor: ["#ffffff"], textShadow: [] } },
      { ...currentRequestStyle, diyChatBubbleStyle: { bgColor: ["#112233"], textColor: ["expression(alert(1))"], textShadow: [] } },
      { ...currentRequestStyle, diyChatBubbleStyle: { bgColor: ["#112233"], textColor: ["#ffffff"], textShadow: [{ color: "var(--unsafe)", blur: 1 }] } }
    ];
    for (const invalidStyle of invalidStyleCases) {
      collectA1.clear();
      collectA2.clear();
      collectB.clear();
      const error = await expectDesignatedError({
        backend,
        socket: socketA1,
        collector: collectA1,
        event: "style:setAll",
        payload: invalidStyle === undefined ? {} : { style: invalidStyle },
        designated: "style:setAll:fail",
        forbidden: ["style:setAll:success", "style:setAll:error"]
      });
      assert.equal(typeof error.code, "string");
      assert.equal(collectA2.count("style:setAll:success"), 0);
      assert.equal(collectB.count("style:setAll:success"), 0);
      const afterRaw = await request(backend, socketA1, "style:get", {}, "style:get:success", collectA1);
      const after = assertStyleGet(decodeExact(afterRaw), registeredA.user.uuid);
      assert.deepEqual(after.style, currentStyle);
    }
  });

  await t.test("style get returns a privacy-safe public projection for another UUID", async () => {
    const missingUuid = MISSING_PLAYER_UUID;
    collectA1.clear();
    const missingWait = collectA1.waitFor("style:get:fail");
    const noWrongMissingEvent = backend.assertNoEvents(socketA1, ["style:get:success", "style:get:error"], () => {
      emit(socketA1, "style:get", { uuid: missingUuid });
    }, 300);
    assert.deepEqual(decodeExact((await missingWait).raw), { code: "PLAYER_NOT_FOUND", message: "玩家不存在", uuid: missingUuid });
    await noWrongMissingEvent;
    assert.equal(collectA1.count("style:get:fail"), 1);
    const selfRaw = await request(backend, socketA1, "style:get", {}, "style:get:success", collectA1);
    const self = assertStyleGet(decodeExact(selfRaw), registeredA.user.uuid);
    const otherRaw = await request(backend, socketB, "style:get", { uuid: registeredA.user.uuid }, "style:get:success", collectB);
    const other = decodeExact(otherRaw);
    assert.equal(other.uuid, registeredA.user.uuid);
    assert.equal(other.style && typeof other.style === "object", true);
    const publicKeys = ["currentBattleCardStyle", "currentChatContentStyle", "currentChatNameStyle", "currentProfileStyle", "currentChatBubbleStyle", "currentAvatarBorder"];
    assert.deepEqual(Object.keys(other.style).sort(), publicKeys.sort());
    for (const key of publicKeys) assert.equal(other.style[key], self.style[key]);
    for (const privateKey of ["availableBattleCardStyles", "availableChatContentStyles", "availableChatNameStyles", "availableProfileStyles", "availableChatBubbleStyles", "availableAvatarBorders", "diyChatBubbleStyle"]) {
      assert.equal(Object.hasOwn(other.style, privateKey), false, `${privateKey} must stay private`);
    }
  });

  await t.test("persisted state survives process-only hard kill and stale sessions cannot mutate", async () => {
    const persistedFavorites = ["stone", "iron", "coal"];
    collectA1.clear();
    collectA2.clear();
    const savedA1Wait = collectA1.waitFor("userPersonalization:setFavorites:success");
    const savedA2Wait = collectA2.waitFor("userPersonalization:setFavorites:success");
    emit(socketA1, "userPersonalization:setFavorites", { favorites: persistedFavorites });
    const [savedA1] = await Promise.all([savedA1Wait, savedA2Wait]);
    currentPersonalization = { ...currentPersonalization, ...assertSetFavorites(decodeExact(savedA1.raw), persistedFavorites, currentPersonalization) };
    await backend.waitForJson(backend.files.players, (rows) => containsDeep(rows, persistedFavorites));

    const oldCookie = registeredA.cookie;
    const staleSocketA1 = socketA1;
    const staleSocketA2 = socketA2;
    const disconnectedA1 = new Promise((resolve) => staleSocketA1.once("disconnect", resolve));
    const disconnectedA2 = new Promise((resolve) => staleSocketA2.once("disconnect", resolve));
    await backend.hardKillProcess();
    await Promise.all([disconnectedA1, disconnectedA2]);
    assert.equal(staleSocketA1.active, false);
    assert.equal(staleSocketA2.active, false);
    emit(staleSocketA1, "userPersonalization:setFavorites", { favorites: ["sand"] });
    emit(staleSocketA2, "style:setAll", { style: styleForRequest(currentStyle) });

    await backend.launch();
    const staleConnect = await backend.connect(oldCookie);
    assert.equal(staleConnect.initial.code, 401);
    staleConnect.socket.disconnect();
    const staleRest = await backend.request("/api/game/user/profile", { cookie: oldCookie });
    assert.equal(staleRest.status, 401);
    assert.equal(staleSocketA1.connected, false);
    assert.equal(staleSocketA2.connected, false);

    const loggedInA = await backend.login(ACCOUNT_A);
    const loggedInB = await backend.login(ACCOUNT_B);
    const freshA1 = await backend.connect(loggedInA.cookie);
    const freshA2 = await backend.connect(loggedInA.cookie);
    const freshB = await backend.connect(loggedInB.cookie);
    collectA1.stop();
    collectA2.stop();
    collectB.stop();
    socketA1 = freshA1.socket;
    socketA2 = freshA2.socket;
    socketB = freshB.socket;
    collectA1 = backend.collectRawEvents(socketA1, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
    collectA2 = backend.collectRawEvents(socketA2, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
    collectB = backend.collectRawEvents(socketB, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });

    const restoredPersonalizationRaw = await request(backend, socketA1, "userPersonalization:get", {}, "userPersonalization:get:success", collectA1);
    const restoredPersonalization = assertPersonalization(decodeExact(restoredPersonalizationRaw));
    assert.deepEqual(restoredPersonalization.favoriteItems, persistedFavorites);
    assert.deepEqual(restoredPersonalization.categoryOrder, currentPersonalization.categoryOrder);
    assert.equal(restoredPersonalization.version, currentPersonalization.version);
    const restoredStyleRaw = await request(backend, socketA1, "style:get", {}, "style:get:success", collectA1);
    const restoredStyle = assertStyleGet(decodeExact(restoredStyleRaw), registeredA.user.uuid);
    assert.deepEqual(restoredStyle.style, currentStyle);
  });
});


await test("personalization and style enforce same-version CAS races and arrival-order LWW", { timeout: 60_000 }, async (t) => {
  const gmPassword = "phase-one-order-gm";
  const backend = await BackendHarness.start(t, { env: { MAOMAO_GM_PASSWORD: gmPassword } });
  const registered = await backend.register({ ...ACCOUNT_A, email: "phase1-order@example.invalid" });
  const first = await backend.connect(registered.cookie);
  const second = await backend.connect(registered.cookie);
  const gmLogin = await backend.request("/api/gm/login", { method: "POST", json: { password: gmPassword } });
  assert.equal(gmLogin.status, 200);
  const gmCookie = gmLogin.headers.get("set-cookie").split(";", 1)[0];
  const grant = await backend.request(`/api/gm/players/${registered.user.uuid}/grant`, {
    method: "POST",
    cookie: gmCookie,
    json: { items: [
      { resourceId: "sponsorPointResource_chatBubble_cute_cat_1", count: 1 },
      { resourceId: "sponsorPointResource_chatBubble_cute_cat_2", count: 1 }
    ] }
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  for (const itemId of ["sponsorPointResource_chatBubble_cute_cat_1", "sponsorPointResource_chatBubble_cute_cat_2"]) {
    const used = onceDecoded(backend, first.socket, "effectAction:useItem:success");
    emit(first.socket, "effectAction:useItem", { itemId, multiple: 1 });
    await used;
  }
  const collectFirst = backend.collectRawEvents(first.socket, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
  const collectSecond = backend.collectRawEvents(second.socket, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
  collectFirst.socket = first.socket;
  collectSecond.socket = second.socket;
  t.after(() => { collectFirst.stop(); collectSecond.stop(); });

  let personalization = decodeExact(await request(backend, first.socket, "userPersonalization:get", {}, "userPersonalization:get:success", collectFirst));
  let style = assertStyleGet(decodeExact(await request(backend, first.socket, "style:get", {}, "style:get:success", collectFirst)), registered.user.uuid).style;

  collectFirst.clear();
  collectSecond.clear();
  // No await between emits: two sockets truly compete on one advertised personalization version.
  emitBackToBackAndCollect([collectFirst, collectSecond], {
    outbound: "userPersonalization:setFavorites",
    payloads: [
      { favorites: ["stone"], expectedVersion: personalization.version },
      { favorites: ["coal"], expectedVersion: personalization.version }
    ],
    successEvent: "userPersonalization:setFavorites:success",
    errorEvent: "userPersonalization:error"
  });
  // Exactly one requester receives the direct conflict while one success fans out to both sockets.
  const personalizationCas = await waitForExactlyOneConflict(
    [collectFirst, collectSecond],
    "userPersonalization:setFavorites:success",
    "userPersonalization:error",
    backend,
    registered.user.uuid
  );
  assert.equal(personalizationCas.conflict.code, "VERSION_CONFLICT");
  const personalizationWinner = personalizationCas.winner;
  assert.equal(personalizationWinner.version, personalization.version + 1);
  assert.equal(Date.parse(personalizationWinner.updatedAt) >= (personalization.updatedAt ? Date.parse(personalization.updatedAt) : 0), true);
  let diskPlayers = JSON.parse(await fs.readFile(backend.files.players, "utf8"));
  let diskPlayer = diskPlayers.find((candidate) => candidate.uuid === registered.user.uuid);
  assert.deepEqual(diskPlayer.personalization, personalizationWinner, "players.json must equal the sole personalization CAS winner");
  personalization = decodeExact(await request(backend, first.socket, "userPersonalization:get", {}, "userPersonalization:get:success", collectFirst));
  assert.deepEqual(personalization, personalizationWinner, "in-memory personalization must equal the sole CAS winner");

  const styleA = styleForRequest(style);
  styleA.currentChatBubbleStyle = "cute_cat_1";
  const styleB = styleForRequest(style);
  styleB.currentChatBubbleStyle = "cute_cat_2";
  collectFirst.clear();
  collectSecond.clear();
  emitBackToBackAndCollect([collectFirst, collectSecond], {
    outbound: "style:setAll",
    payloads: [
      { style: styleA, expectedVersion: style.version },
      { style: styleB, expectedVersion: style.version }
    ],
    successEvent: "style:setAll:success",
    errorEvent: "style:setAll:fail"
  });
  const styleCas = await waitForExactlyOneConflict(
    [collectFirst, collectSecond],
    "style:setAll:success",
    "style:setAll:fail",
    backend,
    registered.user.uuid
  );
  assert.equal(styleCas.conflict.code, "VERSION_CONFLICT");
  const styleWinner = styleCas.winner.style;
  assert.equal(styleWinner.version, style.version + 1);
  assert.equal(Date.parse(styleWinner.updatedAt) >= (style.updatedAt ? Date.parse(style.updatedAt) : 0), true);
  diskPlayers = JSON.parse(await fs.readFile(backend.files.players, "utf8"));
  diskPlayer = diskPlayers.find((candidate) => candidate.uuid === registered.user.uuid);
  assert.deepEqual(diskPlayer.style, {
    owned: {
      battle: styleWinner.availableBattleCardStyles,
      chatContent: styleWinner.availableChatContentStyles,
      chatName: styleWinner.availableChatNameStyles,
      profile: styleWinner.availableProfileStyles,
      chatBubble: styleWinner.availableChatBubbleStyles,
      avatarBorder: styleWinner.availableAvatarBorders
    },
    selected: {
      battle: styleWinner.currentBattleCardStyle,
      chatContent: styleWinner.currentChatContentStyle,
      chatName: styleWinner.currentChatNameStyle,
      profile: styleWinner.currentProfileStyle,
      chatBubble: styleWinner.currentChatBubbleStyle,
      avatarBorder: styleWinner.currentAvatarBorder
    },
    diyChatBubbleStyle: styleWinner.diyChatBubbleStyle,
    version: styleWinner.version,
    updatedAt: styleWinner.updatedAt
  }, "players.json must equal the sole style CAS winner in canonical storage form");
  style = assertStyleGet(decodeExact(await request(backend, first.socket, "style:get", {}, "style:get:success", collectFirst)), registered.user.uuid).style;
  assert.deepEqual(style, styleWinner, "in-memory style must equal the sole CAS winner");

  collectFirst.clear();
  collectSecond.clear();
  emit(first.socket, "userPersonalization:setFavorites", { favorites: ["sand"] });
  emit(first.socket, "userPersonalization:setFavorites", { favorites: ["coal"] });
  await backend.awaitPhaseOneIdle(registered.user.uuid);
  const personalizationWrites = collectFirst.matching("userPersonalization:setFavorites:success").map((record) => decodeExact(record.raw));
  assert.equal(personalizationWrites.length, 2);
  assert.equal(collectSecond.count("userPersonalization:setFavorites:success"), 2);
  assert.deepEqual(personalizationWrites.map((result) => result.favoriteItems), [["sand"], ["coal"]]);
  assert.equal(personalizationWrites[1].version, personalizationWrites[0].version + 1);
  personalization = decodeExact(await request(backend, first.socket, "userPersonalization:get", {}, "userPersonalization:get:success", collectFirst));
  assert.deepEqual(personalization.favoriteItems, ["coal"]);

  const styleFirstRequest = { ...styleForRequest(style), currentChatBubbleStyle: "cute_cat_1" };
  const styleSecondRequest = { ...styleForRequest(style), currentChatBubbleStyle: "cute_cat_2" };
  collectFirst.clear();
  collectSecond.clear();
  emit(first.socket, "style:setAll", { style: styleFirstRequest });
  emit(first.socket, "style:setAll", { style: styleSecondRequest });
  await backend.awaitPhaseOneIdle(registered.user.uuid);
  const styleWrites = collectFirst.matching("style:setAll:success").map((record) => decodeExact(record.raw).style);
  assert.equal(styleWrites.length, 2);
  assert.equal(collectSecond.count("style:setAll:success"), 2);
  assert.equal(styleWrites[0].currentChatBubbleStyle, "cute_cat_1");
  assert.equal(styleWrites[1].currentChatBubbleStyle, "cute_cat_2");
  assert.equal(styleWrites[1].version, styleWrites[0].version + 1);
  style = assertStyleGet(decodeExact(await request(backend, first.socket, "style:get", {}, "style:get:success", collectFirst)), registered.user.uuid).style;
  assert.deepEqual(style, styleWrites[1], "no-CAS style writes must be arrival-order last-write-wins");

  await backend.hardKillProcess();
  await backend.launch();
  const restarted = await backend.connect((await backend.login({ ...ACCOUNT_A, email: "phase1-order@example.invalid" })).cookie);
  const restartedPersonalization = await backend.emitAndWait(restarted.socket, "userPersonalization:get", {}, "userPersonalization:get:success");
  const restartedStyle = await backend.emitAndWait(restarted.socket, "style:get", {}, "style:get:success");
  assert.deepEqual(restartedPersonalization, personalization, "final personalization state must survive restart from players.json");
  assert.deepEqual(restartedStyle.style, style, "final style state must survive restart from players.json");
});

await test("non-empty legacy Phase 1 state migrates deterministically", { timeout: 60_000 }, async (t) => {
  const fixtureSourceContext = { after() {} };
  const source = await BackendHarness.start(fixtureSourceContext);
  const legacyAccount = { nickname: "旧存档猫", email: "phase1-legacy@example.invalid", password: "phase-one-legacy-password" };
  const registered = await source.register(legacyAccount);
  await source.waitForJson(source.files.accounts, (rows) => rows.some((row) => row.uuid === registered.user.uuid));
  await source.waitForJson(source.files.players, (rows) => rows.some((row) => row.uuid === registered.user.uuid));
  const accounts = JSON.parse(await fs.readFile(source.files.accounts, "utf8"));
  const players = JSON.parse(await fs.readFile(source.files.players, "utf8"));
  const legacyPlayers = players.map((player) => {
    if (player.uuid !== registered.user.uuid) return player;
    const copy = structuredClone(player);
    for (const key of ["personalization", "userPersonalization", "style", "customStyle"]) delete copy[key];
    copy.favoriteItems = ["stone", "stone", "not-a-resource", "coal"];
    copy.categoryOrder = ["Currency", "Material", "Material", "__proto__", 17];
    copy.personalizationVersion = 9;
    copy.personalizationUpdatedAt = LEGACY_TIMESTAMP;
    copy.uniqueFlag = [
      { type: "chatBubble", key: "cute_cat_1" },
      { type: "chatBubble", key: "cute_cat_2" },
      { type: "chatBubble", key: "diy" },
      { type: "chatBubble", key: "diy" },
      { type: "avatarBorder", key: "kitty_head_1" },
      { type: "constructor", key: "poison" },
      null
    ];
    copy.userStyle = {
      availableBattleCardStyles: ["warrior", "unknown", "warrior"],
      currentBattleCardStyle: "unknown",
      availableChatContentStyles: ["unknown"],
      currentChatContentStyle: "unknown",
      availableChatNameStyles: [],
      currentChatNameStyle: "stale",
      availableProfileStyles: ["wangzong"],
      currentProfileStyle: "wangzong",
      availableChatBubbleStyles: ["cute_cat_1", "unknown"],
      currentChatBubbleStyle: "cute_cat_2",
      availableAvatarBorders: ["kitty_head_1"],
      currentAvatarBorder: "expired-border",
      diyChatBubbleStyle: LEGACY_DIY,
      version: 14,
      updatedAt: LEGACY_TIMESTAMP
    };
    return copy;
  });
  await source.close();

  const backend = await BackendHarness.start(t, { fixtures: { accounts, players: legacyPlayers } });
  const loggedIn = await backend.login(legacyAccount);
  const connected = await backend.connect(loggedIn.cookie);
  const collector = backend.collectRawEvents(connected.socket, { events: [...PERSONALIZATION_EVENTS, ...STYLE_EVENTS] });
  t.after(() => collector.stop());
  const personalization = assertPersonalization(decodeExact(await request(backend, connected.socket, "userPersonalization:get", {}, "userPersonalization:get:success", collector)));
  assert.deepEqual(personalization, {
    favoriteItems: ["stone", "coal"],
    categoryOrder: ["Currency", "Material"],
    version: 9,
    updatedAt: LEGACY_TIMESTAMP
  });
  const style = assertStyleGet(decodeExact(await request(backend, connected.socket, "style:get", {}, "style:get:success", collector)), registered.user.uuid).style;
  assert.deepEqual(style.availableBattleCardStyles, ["warrior"]);
  assert.equal(style.currentBattleCardStyle, "", "expired legacy selection must be cleared");
  assert.deepEqual(style.availableProfileStyles, ["wangzong"]);
  assert.equal(style.currentProfileStyle, "wangzong");
  assert.deepEqual(style.availableChatBubbleStyles, ["cute_cat_1", "cute_cat_2"], "uniqueFlag entitlement must merge into userStyle ownership");
  assert.equal(style.currentChatBubbleStyle, "cute_cat_2");
  assert.deepEqual(style.availableAvatarBorders, ["kitty_head_1"]);
  assert.equal(style.currentAvatarBorder, "", "unowned legacy avatar selection must be cleared");
  assert.deepEqual(style.diyChatBubbleStyle, {
    bgColor: ["#112233", "#445566"],
    textColor: ["#FFFFFF", "#aabbcc"],
    textShadow: [{ color: "#010203", blur: 3 }]
  });
  assert.equal(style.version, 14);
  assert.equal(style.updatedAt, LEGACY_TIMESTAMP);

  const canonicalRows = JSON.parse(await fs.readFile(backend.files.players, "utf8"));
  const canonicalPlayer = canonicalRows.find((player) => player.uuid === registered.user.uuid);
  assert.deepEqual(canonicalPlayer.personalization, personalization, "players.json must contain canonical personalization state");
  assert.deepEqual(canonicalPlayer.style, {
    owned: {
      battle: style.availableBattleCardStyles,
      chatContent: style.availableChatContentStyles,
      chatName: style.availableChatNameStyles,
      profile: style.availableProfileStyles,
      chatBubble: style.availableChatBubbleStyles,
      avatarBorder: style.availableAvatarBorders
    },
    selected: {
      battle: style.currentBattleCardStyle,
      chatContent: style.currentChatContentStyle,
      chatName: style.currentChatNameStyle,
      profile: style.currentProfileStyle,
      chatBubble: style.currentChatBubbleStyle,
      avatarBorder: style.currentAvatarBorder
    },
    diyChatBubbleStyle: style.diyChatBubbleStyle,
    version: style.version,
    updatedAt: style.updatedAt
  }, "players.json must contain canonical style state");
  for (const legacyKey of ["favoriteItems", "categoryOrder", "personalizationVersion", "personalizationUpdatedAt", "userStyle", "customStyle", "userPersonalization"]) {
    assert.equal(Object.hasOwn(canonicalPlayer, legacyKey), false, `canonical players.json must remove ${legacyKey}`);
  }

  await backend.hardKillProcess();
  await backend.launch();
  const restarted = await backend.connect((await backend.login(legacyAccount)).cookie);
  const restartedPersonalization = await backend.emitAndWait(restarted.socket, "userPersonalization:get", {}, "userPersonalization:get:success");
  const restartedStyle = await backend.emitAndWait(restarted.socket, "style:get", {}, "style:get:success");
  assert.deepEqual(restartedPersonalization, personalization, "canonical personalization must remain stable after restart");
  assert.deepEqual(restartedStyle.style, style, "normalized non-empty legacy style must remain stable after restart");
});

await test("chat bubble and DIY payloads are immutable persisted message snapshots", { timeout: 90_000 }, async (t) => {
  const gmPassword = "phase-one-chat-snapshot-gm";
  const backend = await BackendHarness.start(t, { env: { MAOMAO_GM_PASSWORD: gmPassword } });
  const account = { ...ACCOUNT_A, email: "phase1-chat-snapshot@example.invalid" };
  const registered = await backend.register(account);
  const connected = await backend.connect(registered.cookie);
  let socket = connected.socket;

  const gmLogin = await backend.request("/api/gm/login", { method: "POST", json: { password: gmPassword } });
  assert.equal(gmLogin.status, 200);
  const gmCookie = gmLogin.headers.get("set-cookie").split(";", 1)[0];
  const grant = await backend.request(`/api/gm/players/${registered.user.uuid}/grant`, {
    method: "POST",
    cookie: gmCookie,
    json: { items: [
      { resourceId: "sponsorPointResource_chatBubble_cute_cat_1", count: 1 },
      { resourceId: "sponsorPointResource_chatBubble_diy", count: 1 }
    ] }
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  for (const itemId of [
    "sponsorPointResource_chatBubble_cute_cat_1",
    "sponsorPointResource_chatBubble_diy"
  ]) {
    const used = onceDecoded(backend, socket, "effectAction:useItem:success");
    emit(socket, "effectAction:useItem", { itemId, multiple: 1 });
    await used;
  }

  let style = (await backend.emitAndWait(socket, "style:get", {}, "style:get:success")).style;
  const firstDiy = { bgColor: ["#112233"], textColor: ["#eeeeee"], textShadow: [{ color: "#000000", blur: 2 }] };
  const diyRequest = { ...styleForRequest(style), currentChatBubbleStyle: "", diyChatBubbleStyle: firstDiy };
  style = (await backend.emitAndWait(socket, "style:setAll", { style: diyRequest, expectedVersion: style.version }, "style:setAll:success")).style;

  const firstContent = "immutable-chat-snapshot-one";
  const firstMessageWait = onceDecoded(backend, socket, "chat:newPublicChatMsg");
  emit(socket, "chat:createPublicChatMsg", { content: firstContent });
  const firstMessage = assertChatSnapshot(await firstMessageWait, { bubble: "", diy: firstDiy, content: firstContent });
  assert.notStrictEqual(firstMessage.extra2.bubbleDiyStyle, style.diyChatBubbleStyle);

  const secondDiy = { bgColor: ["#abcdef"], textColor: ["#123456"], textShadow: [{ color: "#654321", blur: 7 }] };
  const namedRequest = { ...styleForRequest(style), currentChatBubbleStyle: "cute_cat_1", diyChatBubbleStyle: secondDiy };
  style = (await backend.emitAndWait(socket, "style:setAll", { style: namedRequest, expectedVersion: style.version }, "style:setAll:success")).style;
  assert.equal(style.currentChatBubbleStyle, "cute_cat_1");

  let history = await backend.emitAndWait(socket, "chat:getPublicChatList", {}, "chat:getChatList:success");
  assertChatSnapshot(history.list.find((message) => message.id === firstMessage.id), { bubble: "", diy: firstDiy, content: firstContent });

  const secondContent = "immutable-chat-snapshot-two";
  const secondMessageWait = onceDecoded(backend, socket, "chat:newPublicChatMsg");
  emit(socket, "chat:createPublicChatMsg", { content: secondContent });
  const secondMessage = assertChatSnapshot(await secondMessageWait, { bubble: "cute_cat_1", content: secondContent });
  history = await backend.emitAndWait(socket, "chat:getPublicChatList", {}, "chat:getChatList:success");
  assertChatSnapshot(history.list.find((message) => message.id === secondMessage.id), { bubble: "cute_cat_1", content: secondContent });

  const socialRows = await backend.waitForJson(backend.files.social, (value) =>
    value?.chatMessages?.some((message) => message.id === firstMessage.id)
    && value.chatMessages.some((message) => message.id === secondMessage.id));
  assertChatSnapshot(socialRows.chatMessages.find((message) => message.id === firstMessage.id), { bubble: "", diy: firstDiy, content: firstContent });
  assertChatSnapshot(socialRows.chatMessages.find((message) => message.id === secondMessage.id), { bubble: "cute_cat_1", content: secondContent });

  await backend.hardKillProcess();
  await backend.launch();
  socket = (await backend.connect((await backend.login(account)).cookie)).socket;
  history = await backend.emitAndWait(socket, "chat:getPublicChatList", {}, "chat:getChatList:success");
  assertChatSnapshot(history.list.find((message) => message.id === firstMessage.id), { bubble: "", diy: firstDiy, content: firstContent });
  assertChatSnapshot(history.list.find((message) => message.id === secondMessage.id), { bubble: "cute_cat_1", content: secondContent });
});
await test("pending social full flush survives immediate Phase 1 sync write and hard kill", { timeout: 60_000 }, async (t) => {
  const account = { ...ACCOUNT_A, email: "phase1-pending-social@example.invalid" };
  const backend = await BackendHarness.start(t);
  const registered = await backend.register(account);
  let socket = (await backend.connect(registered.cookie)).socket;
  // Freeze the debounce before creating social state so the pending intent cannot race the Phase 1 write.
  await backend.persistenceControl({ frozen: true, resetCounters: true });
  const content = "pending-social-before-phase-one-sync";
  const pushed = onceDecoded(backend, socket, "chat:newPublicChatMsg");
  emit(socket, "chat:createPublicChatMsg", { content });
  const message = await pushed;
  const pending = await backend.persistenceState();
  assert.equal(pending.frozen, true);
  assert.equal(pending.pendingFullFlush, true);

  const personalization = await backend.emitAndWait(socket, "userPersonalization:get", {}, "userPersonalization:get:success");
  const saved = await backend.emitAndWait(socket, "userPersonalization:setFavorites", {
    favorites: ["stone"],
    expectedVersion: personalization.version
  }, "userPersonalization:setFavorites:success");
  assert.deepEqual(saved.favoriteItems, ["stone"]);
  assert.equal(saved.version, personalization.version + 1);
  assert.equal(Date.parse(saved.updatedAt) >= (personalization.updatedAt ? Date.parse(personalization.updatedAt) : 0), true);
  await backend.awaitPhaseOneIdle(registered.user.uuid);
  const branch = await backend.persistenceState();
  assert.equal(branch.counters.phaseOnePendingBranchStarted, 1);
  assert.equal(branch.counters.phaseOnePendingBranchCompleted, 1);
  assert.equal(branch.counters.phaseOnePendingBranchFailed, 0);
  const social = JSON.parse(await fs.readFile(backend.files.social, "utf8"));
  assert.equal(social.chatMessages.some((candidate) => candidate.id === message.id && candidate.content === content), true);
  await backend.persistenceControl({ frozen: false });
  await backend.awaitFullFlushIdle();

  await backend.hardKillProcess();
  await backend.launch();

  socket = (await backend.connect((await backend.login(account)).cookie)).socket;
  const restoredPersonalization = await backend.emitAndWait(socket, "userPersonalization:get", {}, "userPersonalization:get:success");
  assert.deepEqual(restoredPersonalization.favoriteItems, ["stone"]);
  const restoredHistory = await backend.emitAndWait(socket, "chat:getPublicChatList", {}, "chat:getChatList:success");
  const restoredMessage = restoredHistory.list.find((candidate) => candidate.id === message.id);
  assert.equal(restoredMessage?.content, content, "Phase 1 sync persistence must not discard the pending full social flush");
});

