import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as createSocket } from "socket.io-client";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(HERE, "../..");
const SERVER_FILE = path.join(BACKEND_DIR, "server.js");

const PERSISTENCE_ENV = {
  accounts: "MAOMAO_ACCOUNT_FILE",
  players: "MAOMAO_PLAYER_FILE",
  market: "MAOMAO_MARKET_FILE",
  social: "MAOMAO_SOCIAL_FILE",
  village: "MAOMAO_VILLAGE_FILE",
  homeServiceWal: "MAOMAO_HOME_SERVICE_WAL_FILE",
  auctions: "MAOMAO_AUCTION_FILE",
  shops: "MAOMAO_SHOP_FILE",
  rooms: "MAOMAO_ROOM_FILE"
};

const PERSISTENCE_FILENAMES = {
  accounts: "accounts.json",
  players: "players.json",
  market: "market.json",
  social: "social.json",
  village: "village.json",
  homeServiceWal: "home-service-transaction.json",
  auctions: "auctions.json",
  shops: "shops.json",
  rooms: "rooms.json"
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function deadlineSignal(timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function decodeEnvelope(value) {
  let decoded = value;
  if (typeof decoded === "string") decoded = JSON.parse(decoded);
  return decoded && typeof decoded === "object" && Object.hasOwn(decoded, "data") ? decoded.data : decoded;
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port || port === 8080) allocatePort().then(resolve, reject);
        else resolve(port);
      });
    });
  });
}

function appendCapped(current, chunk, cap = 80_000) {
  const combined = current + chunk.toString("utf8");
  return combined.length > cap ? combined.slice(-cap) : combined;
}

export class BackendHarness {
  static async start(t, options = {}) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "maomao-it-"));
    const files = Object.fromEntries(Object.entries(PERSISTENCE_FILENAMES).map(([key, filename]) => [key, path.join(tempDir, filename)]));
    const harness = new BackendHarness(tempDir, files, options);
    try {
      await harness.seedFixtures(options.fixtures);
      await harness.launch();
    } catch (error) {
      await harness.close();
      throw error;
    }
    t?.after(async () => harness.close());
    return harness;
  }

  constructor(tempDir, files, options = {}) {
    this.tempDir = tempDir;
    this.files = files;
    this.startupMs = options.startupMs ?? 20_000;
    this.requestMs = options.requestMs ?? 10_000;
    this.eventMs = options.eventMs ?? 5_000;
    this.diskMs = options.diskMs ?? 5_000;
    this.exitMs = options.exitMs ?? 5_000;
    this.maxLaunchAttempts = options.maxLaunchAttempts ?? 3;
    this.extraEnv = options.env && typeof options.env === "object" ? { ...options.env } : {};
    this.logs = { stdout: "", stderr: "" };
    this.child = null;
    this.port = null;
    this.url = null;
    this.sockets = new Set();
    this.closed = false;
  }

  async seedFixtures(fixtures) {
    if (fixtures === undefined || fixtures === null) return;
    const entries = typeof fixtures === "function"
      ? await fixtures({ files: { ...this.files }, tempDir: this.tempDir })
      : fixtures;
    if (entries === undefined || entries === null) return;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new TypeError("fixtures must be an object, function, null or undefined");
    }
    for (const [key, value] of Object.entries(entries)) {
      if (!Object.hasOwn(this.files, key)) throw new Error(`unknown persistence fixture: ${key}`);
      if (value === undefined) continue;
      await fs.mkdir(path.dirname(this.files[key]), { recursive: true });
      if (typeof value === "string" || Buffer.isBuffer(value)) {
        await fs.writeFile(this.files[key], value);
      } else {
        await fs.writeFile(this.files[key], `${JSON.stringify(value, null, 2)}\n`, "utf8");
      }
    }
  }

  async launch({ port } = {}) {
    if (this.child) throw new Error("backend is already running");
    const fixedPort = port !== undefined;
    let lastError;
    for (let attempt = 1; attempt <= this.maxLaunchAttempts; attempt += 1) {
      try {
        return await this.launchOnce({ port: fixedPort ? port : undefined });
      } catch (error) {
        lastError = error;
        const addressInUse = error?.code === "EADDRINUSE" || /EADDRINUSE/.test(`${error?.message || ""}\n${this.logs.stderr}`);
        await this.stop({ force: true });
        if (fixedPort || !addressInUse || attempt === this.maxLaunchAttempts) throw error;
        this.logs = { stdout: "", stderr: "" };
      }
    }
    throw lastError;
  }

  async launchOnce({ port } = {}) {
    this.port = port ?? await allocatePort();
    if (this.port === 8080) throw new Error("integration tests must never use port 8080");
    this.url = `http://127.0.0.1:${this.port}`;
    const env = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(this.port),
      MAOMAO_LOCAL_RECOVERY: "false",
      NODE_ENV: "test",
      MAOMAO_TEST_HOOKS: "1",
      MAOMAO_EMAIL: "isolated-demo@example.invalid",
      MAOMAO_PASSWORD: "isolated-demo-password",
      ...this.extraEnv
    };
    for (const [key, variable] of Object.entries(PERSISTENCE_ENV)) env[variable] = this.files[key];

    const child = spawn(process.execPath, [SERVER_FILE], {
      cwd: BACKEND_DIR,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.child = child;
    child.stdout.on("data", (chunk) => { this.logs.stdout = appendCapped(this.logs.stdout, chunk); });
    child.stderr.on("data", (chunk) => { this.logs.stderr = appendCapped(this.logs.stderr, chunk); });

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.startupMs) {
      if (child.exitCode !== null) {
        const error = new Error(`backend exited during startup (code ${child.exitCode})\n${this.logs.stderr}`);
        if (/EADDRINUSE/.test(`${this.logs.stdout}\n${this.logs.stderr}`)) error.code = "EADDRINUSE";
        throw error;
      }
      try {
        const response = await this.request("/api/_auth/session", { timeoutMs: Math.min(this.requestMs, 750) });
        if (response.status === 200 && response.body?.loggedIn === false) return this;
      } catch {}
      await delay(40);
    }
    throw new Error(`backend startup timed out\nstdout:\n${this.logs.stdout}\nstderr:\n${this.logs.stderr}`);
  }

  async testIpcRequest(type, responseType, payload = {}, { timeoutMs = this.requestMs } = {}) {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.connected) throw new Error("backend IPC test hook is unavailable");
    const requestId = `${process.pid}:${Date.now()}:${Math.random()}`;
    const response = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      const onMessage = (message) => {
        if (message?.type !== responseType || message.requestId !== requestId) return;
        cleanup();
        resolve(message);
      };
      const onExit = (code) => { cleanup(); reject(new Error(`backend exited during ${type} (code ${code})`)); };
      const onError = (error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
    });
    child.send({ type, requestId, ...payload });
    return response;
  }

  async failNextPlayerPersistence({ count = 1, timeoutMs = this.requestMs } = {}) {
    return this.testIpcRequest(
      "maomao:test:fail-player-persistence",
      "maomao:test:fail-player-persistence:armed",
      { count },
      { timeoutMs }
    );
  }

  async persistenceControl({ frozen, resetCounters = false, timeoutMs = this.requestMs } = {}) {
    const response = await this.testIpcRequest(
      "maomao:test:persistence-control",
      "maomao:test:persistence-control:result",
      { ...(typeof frozen === "boolean" ? { frozen } : {}), resetCounters },
      { timeoutMs }
    );
    const { type, requestId, ...state } = response;
    return state;
  }

  async persistenceState({ timeoutMs = this.requestMs } = {}) {
    const response = await this.testIpcRequest(
      "maomao:test:persistence-state",
      "maomao:test:persistence-state:result",
      {},
      { timeoutMs }
    );
    const { type, requestId, ...state } = response;
    return state;
  }

  async awaitFullFlushIdle({ timeoutMs = this.diskMs } = {}) {
    const response = await this.testIpcRequest(
      "maomao:test:await-full-flush-idle",
      "maomao:test:full-flush-idle:result",
      {},
      { timeoutMs }
    );
    const { type, requestId, ...state } = response;
    return state;
  }

  async awaitPhaseOneIdle(uuid, { timeoutMs = this.requestMs } = {}) {
    await this.testIpcRequest(
      "maomao:test:await-phase-one-idle",
      "maomao:test:phase-one-idle:result",
      { uuid },
      { timeoutMs }
    );
  }

  async waitForPersistenceState(predicate, { timeoutMs = this.diskMs } = {}) {
    const startedAt = Date.now();
    let lastState;
    while (Date.now() - startedAt < timeoutMs) {
      lastState = await this.persistenceState({ timeoutMs: Math.min(this.requestMs, timeoutMs) });
      if (await predicate(lastState)) return lastState;
      await delay(10);
    }
    throw new Error(`persistence state predicate timed out after ${timeoutMs} ms; last=${JSON.stringify(lastState)}`);
  }

  async playerSnapshot(uuid, { patch, timeoutMs = this.requestMs } = {}) {
    const response = await this.testIpcRequest(
      "maomao:test:player-snapshot",
      "maomao:test:player-snapshot:result",
      { uuid, ...(patch === undefined ? {} : { patch }) },
      { timeoutMs }
    );
    return response.player;
  }

  async request(resource, { method = "GET", cookie, json, timeoutMs = this.requestMs } = {}) {
    if (!this.url) throw new Error("backend is not running");
    const timeout = deadlineSignal(timeoutMs, `${method} ${resource}`);
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (json !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await fetch(new URL(resource, this.url), {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: timeout.signal
      });
      const text = await response.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return { status: response.status, headers: response.headers, body };
    } finally {
      timeout.clear();
    }
  }

  async register({ nickname, email, password }) {
    const response = await this.request("/api/auth/register", { method: "POST", json: { nickname, email, password } });
    if (response.status !== 201) throw new Error(`registration failed: ${response.status} ${JSON.stringify(response.body)}`);
    return { user: response.body.user, cookie: this.cookieFrom(response) };
  }

  async login({ email, password }) {
    const response = await this.request("/api/auth/login", { method: "POST", json: { email, password } });
    if (response.status !== 200) throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
    return { user: response.body.user, cookie: this.cookieFrom(response) };
  }

  cookieFrom(response) {
    const raw = response.headers.get("set-cookie");
    if (!raw) throw new Error("response did not set maomao_session");
    const pair = raw.split(";", 1)[0];
    if (!pair.startsWith("maomao_session=")) throw new Error(`unexpected session cookie: ${pair}`);
    return pair;
  }

  waitEvent(socket, event, { timeoutMs = this.eventMs, predicate = () => true, decode = true } = {}) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(event, onEvent);
        socket.off("disconnect", onDisconnect);
        socket.off("connect_error", onConnectError);
      };
      const onEvent = (raw) => {
        let value;
        try { value = decode ? decodeEnvelope(raw) : raw; }
        catch (error) { cleanup(); reject(error); return; }
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      };
      const onDisconnect = (reason) => { cleanup(); reject(new Error(`socket disconnected while waiting for ${event}: ${reason}`)); };
      const onConnectError = (error) => { cleanup(); reject(new Error(`socket connection error while waiting for ${event}: ${error.message}`)); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`socket event ${event} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      socket.on(event, onEvent);
      socket.on("disconnect", onDisconnect);
      socket.on("connect_error", onConnectError);
    });
  }

  collectRawEvents(socket, { events, predicate = () => true } = {}) {
    const names = events === undefined ? null : new Set(Array.isArray(events) ? events : [events]);
    const records = [];
    const waiters = new Set();
    let sequence = 0;
    let closed = false;

    const matches = (record, waiter = {}) =>
      (!waiter.event || record.event === waiter.event) &&
      (!names || names.has(record.event)) &&
      predicate(record) &&
      (waiter.predicate || (() => true))(record);
    const onAny = (event, ...args) => {
      const record = { event, raw: args[0], args, index: sequence, at: Date.now() };
      sequence += 1;
      if (!names || names.has(event)) records.push(record);
      for (const waiter of [...waiters]) {
        if (!matches(record, waiter)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    };
    socket.onAny(onAny);

    const stop = () => {
      if (closed) return;
      closed = true;
      socket.offAny(onAny);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("raw event collector stopped"));
      }
      waiters.clear();
    };
    const waitFor = (event, { timeoutMs = this.eventMs, predicate: recordPredicate = () => true, includePast = false } = {}) => {
      if (includePast) {
        const previous = records.find((record) => matches(record, { event, predicate: recordPredicate }));
        if (previous) return Promise.resolve(previous);
      }
      if (closed) return Promise.reject(new Error("raw event collector is stopped"));
      return new Promise((resolve, reject) => {
        const waiter = { event, predicate: recordPredicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`raw socket event ${event || "*"} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        waiter.timer.unref?.();
        waiters.add(waiter);
      });
    };
    const matching = (event, recordPredicate = () => true) => records.filter((record) => (!event || record.event === event) && recordPredicate(record));
    return {
      records,
      stop,
      waitFor,
      matching,
      count: (event, recordPredicate) => matching(event, recordPredicate).length,
      clear: () => records.splice(0, records.length),
      cursor: () => sequence
    };
  }

  async connect(cookie) {
    const socket = createSocket(this.url, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: cookie ? { Cookie: cookie } : {}
    });
    this.sockets.add(socket);
    const initialized = this.waitEvent(socket, "gameInited", { timeoutMs: this.startupMs }).then((initial) => ({ initial, authenticated: true }));
    const required = this.waitEvent(socket, "authRequired", { timeoutMs: this.startupMs }).then((initial) => ({ initial, authenticated: false }));
    socket.connect();
    const result = await Promise.race([initialized, required]);
    return { socket, initial: result.initial, authenticated: result.authenticated };
  }

  async emitAndWait(socket, outbound, payload, inbound, options = {}) {
    const waiting = this.waitEvent(socket, inbound, options);
    socket.emit(outbound, JSON.stringify({ data: payload ?? {} }));
    return waiting;
  }

  async assertNoEvents(socket, events, action, timeoutMs = 250) {
    const names = [...new Set(events)];
    return new Promise((resolve, reject) => {
      const listeners = new Map(names.map((event) => [event, (raw) => {
        cleanup();
        reject(new Error(`unexpected socket event ${event}: ${String(raw)}`));
      }]));
      const cleanup = () => {
        clearTimeout(timer);
        for (const [event, listener] of listeners) socket.off(event, listener);
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      timer.unref?.();
      for (const [event, listener] of listeners) socket.on(event, listener);
      try { action(); } catch (error) { cleanup(); reject(error); }
    });
  }

  async assertNoEvent(socket, event, action, timeoutMs = 250) {
    return this.assertNoEvents(socket, [event], action, timeoutMs);
  }

  async waitForJson(file, predicate, { timeoutMs = this.diskMs } = {}) {
    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        if (await predicate(value)) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(25);
    }
    throw new Error(`JSON predicate timed out for ${file}${lastError ? `: ${lastError.message}` : ""}`);
  }

  async terminateChild({ force = false } = {}) {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    if (force) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGTERM");
    }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    try {
      await withTimeout(exited, this.exitMs, `backend process ${child.pid} exit`);
    } catch (error) {
      if (!force) {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
        await withTimeout(exited, this.exitMs, `forced backend process ${child.pid} exit`);
      } else {
        throw error;
      }
    }
  }

  async stop({ force = false } = {}) {
    for (const socket of this.sockets) socket.disconnect();
    this.sockets.clear();
    await this.terminateChild({ force });
  }

  async forceKill() {
    await this.stop({ force: true });
  }

  async hardKillProcess() {
    const connectedSockets = [...this.sockets].filter((socket) => socket.connected);
    const disconnected = connectedSockets.map((socket) => new Promise((resolve) => {
      if (!socket.connected) resolve();
      else socket.once("disconnect", resolve);
    }));
    await this.terminateChild({ force: true });
    if (disconnected.length) {
      await withTimeout(Promise.all(disconnected), Math.min(this.exitMs, 1_000), "client sockets to observe hard-killed backend").catch(() => {});
    }
    // 服务端已被强杀后才停用客户端重连；这不会触发服务端清理或保存，仍是 process-only crash。
    for (const socket of connectedSockets) socket.disconnect();
    this.sockets.clear();
  }

  async restart({ reusePort = false } = {}) {
    const oldPort = this.port;
    await this.stop({ force: true });
    return this.launch({ port: reusePort ? oldPort : undefined });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
    await fs.rm(this.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export { decodeEnvelope };
