import assert from "node:assert/strict";
import test from "node:test";
import { BackendHarness } from "./harness.js";

const ACCOUNT_A = {
  nickname: "请求关联测试猫甲",
  email: "phase1-request-correlation-a@example.invalid",
  password: "phase-one-request-correlation-a"
};
const ACCOUNT_B = {
  nickname: "请求关联测试猫乙",
  email: "phase1-request-correlation-b@example.invalid",
  password: "phase-one-request-correlation-b"
};
const RESULT_EVENTS = [
  "userPersonalization:get:success",
  "userPersonalization:get:error",
  "userPersonalization:get:fail",
  "userPersonalization:setFavorites:success",
  "userPersonalization:setFavorites:error",
  "userPersonalization:setFavorites:fail",
  "userPersonalization:error",
  "style:get:success",
  "style:get:error",
  "style:get:fail",
  "style:setAll:success",
  "style:setAll:error",
  "style:setAll:fail"
];
const ONE_CHAR_REQUEST_ID = "r";
const MAX_REQUEST_ID = "r".repeat(100);
const EVENT_TIMEOUT_MS = 2_500;

function encode(data = {}) {
  return JSON.stringify({ data });
}

function decodeStrictEnvelope(raw, label) {
  assert.equal(typeof raw, "string", `${label} must be a JSON-string envelope`);
  const envelope = JSON.parse(raw);
  assert.equal(envelope && typeof envelope === "object" && !Array.isArray(envelope), true, `${label} envelope must be an object`);
  assert.deepEqual(Object.keys(envelope), ["data"], `${label} envelope must contain exactly one data property`);
  assert.equal(envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data), true, `${label} data must be an object`);
  return envelope.data;
}

function requestIdPaths(value, path = "data", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === "requestId") paths.push(childPath);
    paths.push(...requestIdPaths(child, childPath, seen));
  }
  return paths;
}

function assertEchoed(data, requestId, label) {
  assert.equal(Object.hasOwn(data, "requestId"), true, `${label} must echo requestId inside data`);
  assert.equal(data.requestId, requestId, `${label} must echo requestId unchanged`);
}

function assertNoRequestId(data, label) {
  assert.deepEqual(requestIdPaths(data), [], `${label} must not contain requestId`);
}

function assertError(data, code, label) {
  assert.equal(data && typeof data === "object" && !Array.isArray(data), true, `${label} must have object data`);
  assert.equal(data.code, code, `${label} must use ${code}`);
}

function styleMutation(style) {
  return {
    currentBattleCardStyle: style.currentBattleCardStyle,
    currentChatContentStyle: style.currentChatContentStyle,
    currentChatNameStyle: style.currentChatNameStyle,
    currentProfileStyle: style.currentProfileStyle,
    currentChatBubbleStyle: style.currentChatBubbleStyle,
    currentAvatarBorder: style.currentAvatarBorder,
    diyChatBubbleStyle: structuredClone(style.diyChatBubbleStyle)
  };
}

async function requestResult(socket, collector, outbound, raw) {
  const cursor = collector.cursor();
  const waiting = collector.waitFor(undefined, {
    timeoutMs: EVENT_TIMEOUT_MS,
    predicate: (record) => record.index >= cursor
  });
  socket.emit(outbound, raw);
  const record = await waiting;
  return {
    event: record.event,
    data: decodeStrictEnvelope(record.raw, record.event)
  };
}

async function request(socket, collector, outbound, data) {
  return requestResult(socket, collector, outbound, encode(data));
}

async function expectResult(socket, collector, outbound, data, expectedEvent) {
  const result = await request(socket, collector, outbound, data);
  assert.equal(result.event, expectedEvent, `${outbound} must answer on ${expectedEvent}`);
  return result.data;
}

async function mutationSuccess({ requester, requesterCollector, peerCollector, outbound, data, successEvent }) {
  const requesterCursor = requesterCollector.cursor();
  const peerCursor = peerCollector.cursor();
  const requesterWaiting = requesterCollector.waitFor(successEvent, {
    timeoutMs: EVENT_TIMEOUT_MS,
    predicate: (record) => record.index >= requesterCursor
  });
  const peerWaiting = peerCollector.waitFor(successEvent, {
    timeoutMs: EVENT_TIMEOUT_MS,
    predicate: (record) => record.index >= peerCursor
  });
  requester.emit(outbound, encode(data));
  const [requesterRecord, peerRecord] = await Promise.all([requesterWaiting, peerWaiting]);
  return {
    requesterData: decodeStrictEnvelope(requesterRecord.raw, `${successEvent} requester ACK`),
    peerData: decodeStrictEnvelope(peerRecord.raw, `${successEvent} same-user push`)
  };
}

await test("Phase 1 requestId correlation stays requester-local", { timeout: 60_000 }, async (t) => {
  const backend = await BackendHarness.start(t, { eventMs: EVENT_TIMEOUT_MS });
  assert.notEqual(backend.port, 8080);

  const registeredA = await backend.register(ACCOUNT_A);
  const registeredB = await backend.register(ACCOUNT_B);
  const socketA1 = (await backend.connect(registeredA.cookie)).socket;
  const socketA2 = (await backend.connect(registeredA.cookie)).socket;
  const socketB = (await backend.connect(registeredB.cookie)).socket;
  const collectA1 = backend.collectRawEvents(socketA1, { events: RESULT_EVENTS });
  const collectA2 = backend.collectRawEvents(socketA2, { events: RESULT_EVENTS });
  const collectB = backend.collectRawEvents(socketB, { events: RESULT_EVENTS });
  t.after(() => {
    collectA1.stop();
    collectA2.stop();
    collectB.stop();
  });

  let personalization;
  let style;

  await t.test("getter successes echo both valid requestId boundaries and Style reports the target uuid", async () => {
    for (const requestId of [ONE_CHAR_REQUEST_ID, MAX_REQUEST_ID]) {
      const data = await expectResult(
        socketA1,
        collectA1,
        "userPersonalization:get",
        { requestId },
        "userPersonalization:get:success"
      );
      assertEchoed(data, requestId, "userPersonalization:get success");
      personalization = data;
    }

    for (const requestId of [ONE_CHAR_REQUEST_ID, MAX_REQUEST_ID]) {
      const data = await expectResult(socketA1, collectA1, "style:get", { requestId }, "style:get:success");
      assertEchoed(data, requestId, "self style:get success");
      assert.equal(data.uuid, registeredA.user.uuid, "self style:get must identify its implicit self target");
      style = data.style;
    }

    const remoteRequestId = "remote-style-target";
    const remote = await expectResult(
      socketB,
      collectB,
      "style:get",
      { uuid: registeredA.user.uuid, requestId: remoteRequestId },
      "style:get:success"
    );
    assertEchoed(remote, remoteRequestId, "remote style:get success");
    assert.equal(remote.uuid, registeredA.user.uuid, "remote style:get must identify the requested target");
  });

  await t.test("valid requestId is echoed on validation errors for all four events", async () => {
    const cases = [
      {
        outbound: "userPersonalization:get",
        designated: "userPersonalization:error",
        requestId: "personal-get-validation",
        data: { unexpected: true }
      },
      {
        outbound: "userPersonalization:setFavorites",
        designated: "userPersonalization:error",
        requestId: "personal-set-validation",
        data: { favorites: ["definitely-not-a-resource-id"] }
      },
      {
        outbound: "style:get",
        designated: "style:get:fail",
        requestId: "style-get-validation",
        data: { uuid: "not-a-uuid" }
      },
      {
        outbound: "style:setAll",
        designated: "style:setAll:fail",
        requestId: "style-set-validation",
        data: { style: {} }
      }
    ];
    const violations = [];
    for (const contract of cases) {
      const result = await request(socketA1, collectA1, contract.outbound, {
        ...contract.data,
        requestId: contract.requestId
      });
      try {
        assert.equal(result.event, contract.designated, `${contract.outbound} validation must use its designated error event`);
        assertError(result.data, "INVALID_PAYLOAD", `${contract.outbound} validation error`);
        assertEchoed(result.data, contract.requestId, `${contract.outbound} validation error`);
      } catch (error) {
        violations.push(`${contract.outbound}: ${error.message}`);
      }
    }
    assert.deepEqual(violations, [], `validation requestId violations:\n${violations.join("\n")}`);
  });

  await t.test("mutation ACKs echo both valid boundaries while same-user foreign pushes omit requestId", async () => {
    const personalMutations = [
      { requestId: ONE_CHAR_REQUEST_ID, favorites: ["stone"] },
      { requestId: MAX_REQUEST_ID, favorites: ["coal"] }
    ];
    for (const mutation of personalMutations) {
      const result = await mutationSuccess({
        requester: socketA1,
        requesterCollector: collectA1,
        peerCollector: collectA2,
        outbound: "userPersonalization:setFavorites",
        data: {
          favorites: mutation.favorites,
          expectedVersion: personalization.version,
          requestId: mutation.requestId
        },
        successEvent: "userPersonalization:setFavorites:success"
      });
      assertEchoed(result.requesterData, mutation.requestId, "userPersonalization:setFavorites ACK");
      assertNoRequestId(result.peerData, "userPersonalization:setFavorites same-user foreign success push");
      personalization = result.requesterData;
    }

    for (const requestId of [ONE_CHAR_REQUEST_ID, MAX_REQUEST_ID]) {
      const result = await mutationSuccess({
        requester: socketA1,
        requesterCollector: collectA1,
        peerCollector: collectA2,
        outbound: "style:setAll",
        data: {
          style: styleMutation(style),
          expectedVersion: style.version,
          requestId
        },
        successEvent: "style:setAll:success"
      });
      assertEchoed(result.requesterData, requestId, "style:setAll ACK");
      assertNoRequestId(result.peerData, "style:setAll same-user foreign success push");
      style = result.requesterData.style;
    }
  });

  await t.test("VERSION_CONFLICT errors echo the initiating mutation requestId", async () => {
    const personalRequestId = "personal-version-conflict";
    const personalConflict = await expectResult(
      socketA1,
      collectA1,
      "userPersonalization:setFavorites",
      {
        favorites: ["iron"],
        expectedVersion: personalization.version - 1,
        requestId: personalRequestId
      },
      "userPersonalization:error"
    );
    assertError(personalConflict, "VERSION_CONFLICT", "personalization conflict");
    assertEchoed(personalConflict, personalRequestId, "personalization conflict");
    await backend.awaitPhaseOneIdle(registeredA.user.uuid);

    const styleRequestId = "style-version-conflict";
    const styleConflict = await expectResult(
      socketA1,
      collectA1,
      "style:setAll",
      {
        style: styleMutation(style),
        expectedVersion: style.version - 1,
        requestId: styleRequestId
      },
      "style:setAll:fail"
    );
    assertError(styleConflict, "VERSION_CONFLICT", "style conflict");
    assertEchoed(styleConflict, styleRequestId, "style conflict");
    await backend.awaitPhaseOneIdle(registeredA.user.uuid);
  });

  await t.test("persistence errors echo the initiating mutation requestId", async () => {
    const personalRequestId = "personal-persistence-error";
    await backend.failNextPlayerPersistence();
    const personalFailure = await expectResult(
      socketA1,
      collectA1,
      "userPersonalization:setFavorites",
      {
        favorites: ["iron"],
        expectedVersion: personalization.version,
        requestId: personalRequestId
      },
      "userPersonalization:error"
    );
    assertError(personalFailure, "PERSISTENCE_ERROR", "personalization persistence error");
    assertEchoed(personalFailure, personalRequestId, "personalization persistence error");
    await backend.awaitPhaseOneIdle(registeredA.user.uuid);

    const styleRequestId = "style-persistence-error";
    await backend.failNextPlayerPersistence();
    const styleFailure = await expectResult(
      socketA1,
      collectA1,
      "style:setAll",
      {
        style: styleMutation(style),
        expectedVersion: style.version,
        requestId: styleRequestId
      },
      "style:setAll:fail"
    );
    assertError(styleFailure, "PERSISTENCE_ERROR", "style persistence error");
    assertEchoed(styleFailure, styleRequestId, "style persistence error");
    await backend.awaitPhaseOneIdle(registeredA.user.uuid);
  });

  await t.test("empty, overlong and non-string request IDs use designated errors and are never echoed", async () => {
    const specs = [
      {
        outbound: "userPersonalization:get",
        designated: "userPersonalization:error",
        payload: (requestId) => ({ requestId })
      },
      {
        outbound: "userPersonalization:setFavorites",
        designated: "userPersonalization:error",
        payload: (requestId) => ({ favorites: ["stone"], requestId })
      },
      {
        outbound: "style:get",
        designated: "style:get:fail",
        payload: (requestId) => ({ requestId })
      },
      {
        outbound: "style:setAll",
        designated: "style:setAll:fail",
        payload: (requestId) => ({ style: styleMutation(style), requestId })
      }
    ];
    const invalidIds = [
      { label: "empty", value: "" },
      { label: "length 101", value: "x".repeat(101) },
      { label: "non-string", value: 17 }
    ];
    const violations = [];
    for (const spec of specs) {
      for (const invalid of invalidIds) {
        const result = await request(socketA1, collectA1, spec.outbound, spec.payload(invalid.value));
        try {
          assert.equal(result.event, spec.designated, `${spec.outbound} ${invalid.label} requestId must use ${spec.designated}`);
          assertError(result.data, "INVALID_PAYLOAD", `${spec.outbound} ${invalid.label} requestId`);
          assertNoRequestId(result.data, `${spec.outbound} ${invalid.label} requestId error`);
        } catch (error) {
          violations.push(`${spec.outbound} (${invalid.label}): ${error.message}`);
        }
      }
    }
    assert.deepEqual(violations, [], `invalid requestId violations:\n${violations.join("\n")}`);
  });

  await t.test("malformed outer envelopes cannot invent requestId on validation errors", async () => {
    const cases = [
      {
        outbound: "userPersonalization:get",
        designated: "userPersonalization:error",
        data: { requestId: "malformed-personal-get" }
      },
      {
        outbound: "userPersonalization:setFavorites",
        designated: "userPersonalization:error",
        data: { favorites: ["stone"], requestId: "malformed-personal-set" }
      },
      {
        outbound: "style:get",
        designated: "style:get:fail",
        data: { uuid: registeredA.user.uuid, requestId: "malformed-style-get" }
      },
      {
        outbound: "style:setAll",
        designated: "style:setAll:fail",
        data: { style: styleMutation(style), requestId: "malformed-style-set" }
      }
    ];
    for (const contract of cases) {
      const raw = JSON.stringify({ data: contract.data, extraOuterProperty: true });
      const result = await requestResult(socketA1, collectA1, contract.outbound, raw);
      assert.equal(result.event, contract.designated, `${contract.outbound} malformed envelope must use its designated error`);
      assertError(result.data, "INVALID_PAYLOAD", `${contract.outbound} malformed envelope`);
      assertNoRequestId(result.data, `${contract.outbound} malformed-envelope error`);
    }
  });
});
