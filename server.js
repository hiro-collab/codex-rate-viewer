const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const viewerPort = Number(process.env.VIEWER_PORT || 8787);
const appServerPort = Number(process.env.APP_SERVER_PORT || 35420);
const appServerUrl =
  process.env.CODEX_APP_SERVER_URL || `ws://127.0.0.1:${appServerPort}`;
const readyzUrl = appServerUrl.replace(/^ws/, "http").replace(/\/$/, "") + "/readyz";
const spawnAppServer =
  process.env.CODEX_SPAWN_APP_SERVER !== "0" && !process.env.CODEX_APP_SERVER_URL;
const codexBin = process.env.CODEX_BIN || "codex";
const publicDir = path.join(__dirname, "public");

const state = {
  viewerStartedAt: Date.now(),
  appServerUrl,
  connection: "booting",
  connectionDetail: "Starting viewer",
  codexHome: null,
  userAgent: null,
  rateLimits: null,
  rateLimitsByLimitId: null,
  threads: [],
  tokenUsageByThread: {},
  lastUpdated: null,
  history: [],
  events: [],
  errors: [],
};

let appServerProcess = null;
let ws = null;
let nextRequestId = 1;
const pending = new Map();
const sseClients = new Set();
let pollTimer = null;
let threadTimer = null;
let reconnectTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function pushEvent(message, level = "info") {
  state.events.unshift({ at: Date.now(), level, message });
  state.events = state.events.slice(0, 30);
  broadcast();
}

function pushError(message) {
  state.errors.unshift({ at: Date.now(), message });
  state.errors = state.errors.slice(0, 20);
  pushEvent(message, "error");
}

function setConnection(connection, detail) {
  state.connection = connection;
  state.connectionDetail = detail;
  broadcast();
}

function selectRateLimit() {
  if (state.rateLimitsByLimitId?.codex) return state.rateLimitsByLimitId.codex;
  if (state.rateLimits) return state.rateLimits;
  const values = Object.values(state.rateLimitsByLimitId || {});
  return values[0] || null;
}

function recordHistory() {
  const limit = selectRateLimit();
  if (!limit) return;

  const point = {
    at: Date.now(),
    primaryUsed: limit.primary?.usedPercent ?? null,
    secondaryUsed: limit.secondary?.usedPercent ?? null,
  };

  const last = state.history[state.history.length - 1];
  if (
    last &&
    last.primaryUsed === point.primaryUsed &&
    last.secondaryUsed === point.secondaryUsed &&
    point.at - last.at < 15000
  ) {
    return;
  }

  state.history.push(point);
  state.history = state.history.slice(-240);
}

function updateRateLimits(payload) {
  if (!payload) return;

  if (payload.rateLimitsByLimitId) {
    state.rateLimitsByLimitId = payload.rateLimitsByLimitId;
  }

  if (payload.rateLimits) {
    state.rateLimits = payload.rateLimits;
    const id = payload.rateLimits.limitId;
    if (id) {
      state.rateLimitsByLimitId = {
        ...(state.rateLimitsByLimitId || {}),
        [id]: payload.rateLimits,
      };
    }
  }

  state.lastUpdated = Date.now();
  recordHistory();
  broadcast();
}

function updateThreads(threads) {
  state.threads = Array.isArray(threads) ? threads : [];
  broadcast();
}

function launchAppServer() {
  if (!spawnAppServer || appServerProcess) return;

  const useShell =
    process.platform === "win32" && !codexBin.toLowerCase().endsWith(".exe");

  try {
    appServerProcess = spawn(codexBin, ["app-server", "--listen", appServerUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
      shell: useShell,
    });
  } catch (error) {
    appServerProcess = null;
    pushError(`Failed to start Codex App Server: ${error.message}`);
    return;
  }

  appServerProcess.stdout.on("data", (data) => {
    const text = data.toString().trim();
    if (text) pushEvent(text);
  });

  appServerProcess.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (!text) return;
    if (text.includes("listening on:") || text.includes("readyz:")) {
      pushEvent(text);
    } else {
      state.events.unshift({ at: Date.now(), level: "debug", message: text });
      state.events = state.events.slice(0, 30);
      broadcast();
    }
  });

  appServerProcess.on("error", (error) => {
    appServerProcess = null;
    pushError(`Failed to start Codex App Server: ${error.message}`);
  });

  appServerProcess.on("exit", (code, signal) => {
    appServerProcess = null;
    if (code !== null && code !== 0) {
      pushError(`Codex App Server exited with code ${code}`);
    } else if (signal) {
      pushEvent(`Codex App Server stopped by ${signal}`, "warn");
    }
  });
}

async function waitForReady(timeoutMs = 18000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(readyzUrl, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Keep waiting while the app-server boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function request(method, params, timeoutMs = 10000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Codex App Server is not connected"));
  }

  const id = nextRequestId++;
  const payload = params === undefined ? { id, method } : { id, method, params };
  ws.send(JSON.stringify(payload));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
}

async function refreshRateLimits() {
  try {
    const result = await request("account/rateLimits/read", undefined, 15000);
    updateRateLimits(result);
  } catch (error) {
    pushError(`Rate limit refresh failed: ${error.message}`);
  }
}

async function refreshThreads() {
  try {
    const result = await request(
      "thread/list",
      { limit: 12, sortKey: "updated_at", archived: false },
      15000,
    );
    updateThreads(result?.data || []);
  } catch (error) {
    pushEvent(`Thread refresh skipped: ${error.message}`, "warn");
  }
}

function handleServerMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    pushEvent("Received non-JSON app-server message", "warn");
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    const waiter = pending.get(message.id);
    if (!waiter) return;

    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (!message.method) return;

  if (message.method === "account/rateLimits/updated") {
    updateRateLimits(message.params);
  } else if (message.method === "thread/tokenUsage/updated") {
    const { threadId, tokenUsage } = message.params || {};
    if (threadId) {
      state.tokenUsageByThread[threadId] = tokenUsage;
      broadcast();
    }
  } else if (
    message.method === "thread/started" ||
    message.method === "thread/status/changed" ||
    message.method === "thread/closed"
  ) {
    refreshThreads();
  }
}

async function connectAppServer() {
  clearTimeout(reconnectTimer);
  setConnection("connecting", `Connecting to ${appServerUrl}`);
  launchAppServer();

  try {
    await waitForReady();
    ws = new WebSocket(appServerUrl);
  } catch (error) {
    pushError(`Unable to create WebSocket: ${error.message}`);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", async () => {
    try {
      const init = await request("initialize", {
        clientInfo: {
          name: "codex-rate-viewer",
          title: "Codex Rate Viewer",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      });

      state.codexHome = init.codexHome || null;
      state.userAgent = init.userAgent || null;
      setConnection("online", "Connected to Codex App Server");
      pushEvent("Connected to Codex App Server");
      await refreshRateLimits();
      await refreshThreads();

      clearInterval(pollTimer);
      clearInterval(threadTimer);
      pollTimer = setInterval(refreshRateLimits, 30000);
      threadTimer = setInterval(refreshThreads, 10000);
    } catch (error) {
      pushError(`Initialize failed: ${error.message}`);
      ws.close();
    }
  });

  ws.addEventListener("message", (event) => {
    handleServerMessage(event.data);
  });

  ws.addEventListener("error", () => {
    pushEvent("WebSocket error from Codex App Server", "warn");
  });

  ws.addEventListener("close", () => {
    clearInterval(pollTimer);
    clearInterval(threadTimer);
    pending.forEach((waiter) => waiter.reject(new Error("Connection closed")));
    pending.clear();
    setConnection("offline", "Codex App Server connection closed");
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectAppServer, 2500);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function snapshot() {
  return {
    ...state,
    serverTime: Date.now(),
  };
}

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast() {
  const data = snapshot();
  for (const client of sseClients) {
    sendSse(client, "state", data);
  }
}

function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const decoded = decodeURIComponent(relative);
  const filePath = path.normalize(path.join(publicDir, decoded));

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
      }[ext] || "application/octet-stream";

    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/api/snapshot") {
    sendJson(response, 200, snapshot());
    return;
  }

  if (url.pathname === "/api/refresh") {
    Promise.all([refreshRateLimits(), refreshThreads()]).finally(() => {
      sendJson(response, 200, snapshot());
    });
    return;
  }

  if (url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`: connected ${nowIso()}\n\n`);
    sseClients.add(response);
    sendSse(response, "state", snapshot());
    request.on("close", () => sseClients.delete(response));
    return;
  }

  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  serveStatic(request, response, url.pathname);
});

function shutdown() {
  clearInterval(pollTimer);
  clearInterval(threadTimer);
  clearTimeout(reconnectTimer);
  if (ws) ws.close();
  if (appServerProcess) appServerProcess.kill();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(viewerPort, "127.0.0.1", () => {
  console.log(`Codex Rate Viewer: http://127.0.0.1:${viewerPort}`);
  console.log(`Codex App Server: ${appServerUrl}`);
  connectAppServer();
});
