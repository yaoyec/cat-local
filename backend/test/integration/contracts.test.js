import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BackendHarness } from "./harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_DATA_DIR = path.resolve(HERE, "../../data");

async function existingOfficialFiles() {
  let entries = [];
  try { entries = await fs.readdir(OFFICIAL_DATA_DIR, { withFileTypes: true }); } catch {}
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(OFFICIAL_DATA_DIR, entry.name)).sort();
}

async function hashes(files) {
  return new Map(await Promise.all(files.map(async (file) => {
    const content = await fs.readFile(file);
    return [file, createHash("sha256").update(content).digest("hex")];
  })));
}

async function officialSnapshot() {
  const files = await existingOfficialFiles();
  return {
    names: files.map((file) => path.relative(OFFICIAL_DATA_DIR, file)),
    hashes: await hashes(files)
  };
}

function emit(socket, event, payload = {}) {
  socket.emit(event, JSON.stringify({ data: payload }));
}

function responseData(body) {
  return body?.data ?? body;
}

const accountA = { nickname: "测试猫甲", email: "test-a@example.invalid", password: "correct-horse-a" };
const accountB = { nickname: "测试猫乙", email: "test-b@example.invalid", password: "correct-horse-b" };

await test("isolated contract-honesty and persistence foundation", { timeout: 60_000 }, async (t) => {
  const beforeOfficial = await officialSnapshot();
  t.after(async () => {
    const afterOfficial = await officialSnapshot();
    assert.deepEqual(afterOfficial.names, beforeOfficial.names, "official backend/data JSON file list must remain unchanged");
    assert.deepEqual(afterOfficial.hashes, beforeOfficial.hashes, "official backend/data JSON files must remain byte-for-byte unchanged");
  });
  const backend = await BackendHarness.start(t);

  await t.test("uses isolated paths and enforces authentication", async () => {
    assert.notEqual(backend.port, 8080);
    for (const file of Object.values(backend.files)) assert.equal(path.dirname(file), backend.tempDir);

    const unauthorized = await backend.request("/api/game/user/profile");
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.msg, "未登录");

    const anonymous = await backend.connect();
    assert.equal(anonymous.initial.code, 401);
    assert.equal(anonymous.initial.msg, "未登录");
    anonymous.socket.disconnect();
  });

  const registeredA = await backend.register(accountA);
  const registeredB = await backend.register(accountB);

  await t.test("validates REST inputs, ownership and explicit unsupported features", async () => {
    const duplicate = await backend.request("/api/auth/register", { method: "POST", json: accountA });
    assert.equal(duplicate.status, 409);

    const weakPassword = await backend.request("/api/auth/register", {
      method: "POST",
      json: { nickname: "无效猫", email: "weak@example.invalid", password: "short" }
    });
    assert.equal(weakPassword.status, 400);

    const profileA = await backend.request("/api/game/user/profile", { cookie: registeredA.cookie });
    const profileB = await backend.request("/api/game/user/profile", { cookie: registeredB.cookie });
    assert.equal(profileA.status, 200);
    assert.equal(profileB.status, 200);
    assert.equal(responseData(profileA.body).uuid, registeredA.user.uuid);
    assert.equal(responseData(profileB.body).uuid, registeredB.user.uuid);
    assert.notEqual(responseData(profileA.body).uuid, responseData(profileB.body).uuid);

    const invalidKitty = await backend.request("/api/game/kitty/profile", { cookie: registeredA.cookie });
    assert.equal(invalidKitty.status, 400);
    assert.equal(invalidKitty.body.code, "INVALID_UUID");

    const missingKitty = await backend.request("/api/game/kitty/profile?uuid=not-a-real-kitty", { cookie: registeredA.cookie });
    assert.equal(missingKitty.status, 404);
    assert.equal(missingKitty.body.code, "KITTY_NOT_FOUND");

    const missingGuild = await backend.request("/api/game/guild/profile?uuid=not-a-real-guild", { cookie: registeredA.cookie });
    assert.equal(missingGuild.status, 404);
    assert.equal(missingGuild.body.code, "GUILD_NOT_FOUND");

    for (const resource of ["/api/game/user/switch_account", "/api/game/sponsor/service-usage"]) {
      const response = await backend.request(resource, {
        method: resource.includes("switch_account") ? "POST" : "GET",
        cookie: registeredA.cookie,
        json: resource.includes("switch_account") ? {} : undefined
      });
      assert.equal(response.status, 501);
      assert.equal(response.body.code, "UNSUPPORTED_FEATURE");
      assert.equal(typeof response.body.feature, "string");
      assert.equal(response.body.message, response.body.msg);
    }
  });

  const connectionA = await backend.connect(registeredA.cookie);
  const connectionB = await backend.connect(registeredB.cookie);
  const socketA = connectionA.socket;
  const socketB = connectionB.socket;

  await t.test("two authenticated sockets stay isolated and exchange intentional pushes", async () => {
    assert.equal(connectionA.initial.uuid, registeredA.user.uuid);
    assert.equal(connectionB.initial.uuid, registeredB.user.uuid);

    const receivedRequest = backend.waitEvent(socketB, "friend:request:received");
    const noRequestEcho = backend.assertNoEvent(socketA, "friend:request:received", () => {}, 350);
    const sentRequest = backend.emitAndWait(socketA, "friend:sendRequest", { toUserName: accountB.nickname }, "friend:request:send:success");
    const [incoming, sent] = await Promise.all([receivedRequest, sentRequest]);
    await noRequestEcho;
    assert.equal(incoming.fromUserUuid, registeredA.user.uuid);
    assert.equal(sent.toUserUuid, registeredB.user.uuid);

    const duplicateRequest = await backend.emitAndWait(socketA, "friend:sendRequest", { toUserName: accountB.nickname }, "friend:request:send:fail");
    assert.match(duplicateRequest.message, /待处理/);

    const acceptedPush = backend.waitEvent(socketA, "friend:request:accepted");
    const noAcceptedEcho = backend.assertNoEvent(socketB, "friend:request:accepted", () => {}, 350);
    const accepted = await backend.emitAndWait(socketB, "friend:acceptRequest", { requestId: incoming.request.id }, "friend:request:accept:success");
    assert.equal(accepted.request.status, "ACCEPTED");
    assert.equal((await acceptedPush).fromUserUuid, registeredB.user.uuid);
    await noAcceptedEcho;

    const duplicateAccept = await backend.emitAndWait(socketB, "friend:acceptRequest", { requestId: incoming.request.id }, "friend:request:accept:fail");
    assert.match(duplicateAccept.message, /不存在|已处理/);

    const uniqueMessage = `integration-${Date.now()}`;
    const publicA = backend.waitEvent(socketA, "chat:newPublicChatMsg", { predicate: (value) => value.content === uniqueMessage });
    const publicB = backend.waitEvent(socketB, "chat:newPublicChatMsg", { predicate: (value) => value.content === uniqueMessage });
    emit(socketA, "chat:createPublicChatMsg", { content: uniqueMessage });
    const [messageA, messageB] = await Promise.all([publicA, publicB]);
    assert.equal(messageA.id, messageB.id);
    assert.equal(messageA.sender, registeredA.user.uuid);
  });

  await t.test("unknown and known-unimplemented events fail explicitly without success", async () => {
    const unknownEvent = `integration:unknown:${Date.now()}`;
    const unknownError = backend.waitEvent(socketA, `${unknownEvent}:error`);
    const unknownFail = backend.waitEvent(socketA, `${unknownEvent}:fail`);
    emit(socketA, unknownEvent);
    const [errorPayload, failPayload] = await Promise.all([unknownError, unknownFail]);
    assert.equal(errorPayload.code, "UNSUPPORTED_EVENT");
    assert.deepEqual(failPayload, errorPayload);

    const cases = [
      ["kitty:getAllFriend", "kitty:getAllFriend:error", "kittyFriendProfile"],
      ["kitty:getAllTask", "kitty:getAllTask:error", "kittyTaskQueue"],
      ["worldBoss:listAvailable", "worldBoss:listAvailable:fail", "worldBoss"],
      ["battle:battleInfoDetail", "battle:battleInfoDetail:error", "battleInfoDetailQuery"],
      ["fishing:myBaitAreas:get", "fishing:myBaitAreas:get:fail", "interactiveFishing"],
      ["fishing:myCatches:get", "fishing:myCatches:get:fail", "interactiveFishing"],
      ["fishing:start", "fishing:start:fail", "interactiveFishing"]
    ];
    for (const [outbound, inbound, feature] of cases) {
      const failure = backend.waitEvent(socketA, inbound);
      const forbidden = [...new Set([
        `${outbound}:success`,
        `${outbound}:error`,
        `${outbound}:fail`
      ])].filter((event) => event !== inbound);
      const noOtherResult = backend.assertNoEvents(socketA, forbidden, () => emit(socketA, outbound, { pointX: 1, pointY: 2 }));
      const payload = await failure;
      assert.equal(payload.code, "UNSUPPORTED_FEATURE", outbound);
      assert.equal(payload.feature, feature, outbound);
      assert.equal(payload.event, outbound, outbound);
      await noOtherResult;
    }
  });

  await t.test("forced restart restores persisted player and social state but not sessions", async () => {
    const chefSkill = { flavors: [{ key: "sweet", count: 2 }], targets: [{ key: "self", count: 1 }] };
    const updated = await backend.emitAndWait(socketA, "chefSkill:update", { info: chefSkill }, "chefSkill:update:success");
    assert.deepEqual(updated, chefSkill);

    await backend.waitForJson(backend.files.players, (rows) => rows.some((row) => row.uuid === registeredA.user.uuid && row.chefSkill?.flavors?.[0]?.key === "sweet"));
    await backend.waitForJson(backend.files.social, (value) =>
      value.friendships?.some((pair) => pair.includes(registeredA.user.uuid) && pair.includes(registeredB.user.uuid)) &&
      value.chatMessages?.some((message) => message.sender === registeredA.user.uuid));

    const oldCookie = registeredA.cookie;
    await backend.forceKill();
    await backend.launch();
    assert.notEqual(backend.port, 8080);

    const staleSession = await backend.request("/api/game/user/profile", { cookie: oldCookie });
    assert.equal(staleSession.status, 401);

    const loggedInA = await backend.login(accountA);
    const loggedInB = await backend.login(accountB);
    const restartedA = await backend.connect(loggedInA.cookie);
    const restartedB = await backend.connect(loggedInB.cookie);

    const persistedChefSkill = await backend.emitAndWait(restartedA.socket, "chefSkill:get", {}, "chefSkill:get:success");
    assert.deepEqual(persistedChefSkill, chefSkill);

    const friendList = backend.waitEvent(restartedA.socket, "friend:list");
    emit(restartedA.socket, "friend:getList");
    assert.equal((await friendList).list.some((friend) => friend.uuid === registeredB.user.uuid), true);

    const chatHistory = await backend.emitAndWait(restartedB.socket, "chat:getPublicChatList", {}, "chat:getChatList:success");
    assert.equal(chatHistory.list.some((message) => message.sender === registeredA.user.uuid), true);
  });
});
