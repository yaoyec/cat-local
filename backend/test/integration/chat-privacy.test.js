import assert from "node:assert/strict";
import test from "node:test";
import { BackendHarness, decodeEnvelope } from "./harness.js";

const IRON_A = { nickname: "铁猫甲", email: "chat-privacy-iron-a@example.invalid", password: "correct-horse-iron-a" };
const IRON_B = { nickname: "铁猫乙", email: "chat-privacy-iron-b@example.invalid", password: "correct-horse-iron-b" };
const NON_IRON = { nickname: "普通猫", email: "chat-privacy-normal@example.invalid", password: "correct-horse-normal" };
const IRON_PUSH_EVENT = "chat:newIronPublicChatMsg";

function emit(socket, event, payload = {}) {
  socket.emit(event, JSON.stringify({ data: payload }));
}

function recordMessage(record) {
  return decodeEnvelope(record.raw);
}

function recordHasContent(content) {
  return (record) => {
    try {
      return recordMessage(record)?.content === content;
    } catch {
      return false;
    }
  };
}

function assertSingleHistoryCopy(history, expected) {
  const copies = history.list.filter((message) => message.id === expected.id);
  assert.equal(copies.length, 1, "iron history must contain exactly one copy of the persisted message");
  assert.equal(copies[0].content, expected.content);
  assert.equal(copies[0].channel, "iron");
  assert.equal(copies[0].sender, expected.sender);
}

await test("iron live chat is isolated, delivered once per eligible socket, and survives restart", { timeout: 45_000 }, async (t) => {
  const backend = await BackendHarness.start(t);
  assert.notEqual(backend.port, 8080);

  const ironA = await backend.register(IRON_A);
  const ironB = await backend.register(IRON_B);
  const nonIron = await backend.register(NON_IRON);
  await backend.playerSnapshot(ironA.user.uuid, { patch: { ironcat: true } });
  await backend.playerSnapshot(ironB.user.uuid, { patch: { isIronCat: true } });

  const ironASocketOne = (await backend.connect(ironA.cookie)).socket;
  const ironASocketTwo = (await backend.connect(ironA.cookie)).socket;
  const ironBSocket = (await backend.connect(ironB.cookie)).socket;
  const nonIronSocket = (await backend.connect(nonIron.cookie)).socket;
  const content = "iron-live-privacy-contract";
  const matchesMessage = recordHasContent(content);

  // Attach every positive collector and waiter before the send. The negative assertion
  // installs its own listener and performs the send as its coupled action.
  const ironAOneCollector = backend.collectRawEvents(ironASocketOne, { events: [IRON_PUSH_EVENT] });
  const ironATwoCollector = backend.collectRawEvents(ironASocketTwo, { events: [IRON_PUSH_EVENT] });
  const ironBCollector = backend.collectRawEvents(ironBSocket, { events: [IRON_PUSH_EVENT] });
  const nonIronCollector = backend.collectRawEvents(nonIronSocket, { events: [IRON_PUSH_EVENT] });
  const collectors = [ironAOneCollector, ironATwoCollector, ironBCollector, nonIronCollector];
  t.after(() => collectors.forEach((collector) => collector.stop()));

  const firstIronCopy = ironAOneCollector.waitFor(IRON_PUSH_EVENT, { predicate: matchesMessage });
  const secondIronCopy = ironATwoCollector.waitFor(IRON_PUSH_EVENT, { predicate: matchesMessage });
  const otherIronCopy = ironBCollector.waitFor(IRON_PUSH_EVENT, { predicate: matchesMessage });
  const noNonIronCopy = backend.assertNoEvent(
    nonIronSocket,
    IRON_PUSH_EVENT,
    () => emit(ironASocketOne, "chat:createIronPublicChatMsg", { content }),
    500
  );

  const [oneRecord, twoRecord, otherRecord] = await Promise.all([
    firstIronCopy,
    secondIronCopy,
    otherIronCopy,
    noNonIronCopy
  ]);
  const one = recordMessage(oneRecord);
  const two = recordMessage(twoRecord);
  const other = recordMessage(otherRecord);
  assert.equal(one.id, two.id);
  assert.equal(one.id, other.id);
  assert.equal(one.sender, ironA.user.uuid);
  assert.equal(one.content, content);
  assert.equal(one.channel, "iron");

  // The action-coupled 500 ms quiet window has now elapsed, so collector counts
  // prove exact-once delivery rather than merely observing each socket's first copy.
  assert.equal(ironAOneCollector.count(IRON_PUSH_EVENT, matchesMessage), 1);
  assert.equal(ironATwoCollector.count(IRON_PUSH_EVENT, matchesMessage), 1);
  assert.equal(ironBCollector.count(IRON_PUSH_EVENT, matchesMessage), 1);
  assert.equal(nonIronCollector.count(IRON_PUSH_EVENT, matchesMessage), 0);
  collectors.forEach((collector) => collector.stop());

  const ironHistory = await backend.emitAndWait(
    ironBSocket,
    "chat:getIronPublicChatList",
    {},
    "chat:getIronPublicChatList:success"
  );
  assertSingleHistoryCopy(ironHistory, one);
  const deniedHistory = await backend.emitAndWait(
    nonIronSocket,
    "chat:getIronPublicChatList",
    {},
    "chat:createComment:error"
  );
  assert.equal(typeof deniedHistory.message, "string");
  assert.notEqual(deniedHistory.message.length, 0);

  const persisted = await backend.waitForJson(backend.files.social, (value) => {
    const copies = value?.chatMessages?.filter((message) => message.id === one.id) || [];
    return copies.length === 1
      && copies[0].content === content
      && copies[0].channel === "iron"
      && copies[0].sender === ironA.user.uuid;
  });
  await backend.awaitFullFlushIdle();
  const persistedCopies = persisted.chatMessages.filter((message) => message.id === one.id);
  assert.equal(persistedCopies.length, 1);

  await backend.hardKillProcess();
  await backend.launch();

  // Iron identity is intentionally not a production-persisted field. Re-grant it
  // with the test-only hook after relaunch: this restart section verifies durable
  // message/history recovery, not persistence of the iron role itself.
  await backend.playerSnapshot(ironA.user.uuid, { patch: { ironcat: true } });
  await backend.playerSnapshot(ironB.user.uuid, { patch: { isIronCat: true } });

  const restartedIronALogin = await backend.login(IRON_A);
  const restartedIronBLogin = await backend.login(IRON_B);
  const restartedNonIronLogin = await backend.login(NON_IRON);
  const restartedIronASocket = (await backend.connect(restartedIronALogin.cookie)).socket;
  const restartedIronBSocket = (await backend.connect(restartedIronBLogin.cookie)).socket;
  const restartedNonIronSocket = (await backend.connect(restartedNonIronLogin.cookie)).socket;

  const restartedHistoryA = await backend.emitAndWait(
    restartedIronASocket,
    "chat:getIronPublicChatList",
    {},
    "chat:getIronPublicChatList:success"
  );
  const restartedHistoryB = await backend.emitAndWait(
    restartedIronBSocket,
    "chat:getIronPublicChatList",
    {},
    "chat:getIronPublicChatList:success"
  );
  assertSingleHistoryCopy(restartedHistoryA, one);
  assertSingleHistoryCopy(restartedHistoryB, one);

  const restartedDeniedHistory = await backend.emitAndWait(
    restartedNonIronSocket,
    "chat:getIronPublicChatList",
    {},
    "chat:createComment:error"
  );
  assert.equal(typeof restartedDeniedHistory.message, "string");
  assert.notEqual(restartedDeniedHistory.message.length, 0);
});
