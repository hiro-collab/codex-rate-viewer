const dom = {
  connectionPill: document.querySelector("#connectionPill"),
  connectionLabel: document.querySelector("#connectionLabel"),
  primaryTitle: document.querySelector("#primaryTitle"),
  primaryReset: document.querySelector("#primaryReset"),
  primaryRing: document.querySelector("#primaryRing"),
  primaryRemaining: document.querySelector("#primaryRemaining"),
  primaryUsed: document.querySelector("#primaryUsed"),
  primaryResetTime: document.querySelector("#primaryResetTime"),
  primaryRunway: document.querySelector("#primaryRunway"),
  secondaryTitle: document.querySelector("#secondaryTitle"),
  secondaryReset: document.querySelector("#secondaryReset"),
  secondaryRing: document.querySelector("#secondaryRing"),
  secondaryRemaining: document.querySelector("#secondaryRemaining"),
  secondaryUsed: document.querySelector("#secondaryUsed"),
  secondaryResetTime: document.querySelector("#secondaryResetTime"),
  planType: document.querySelector("#planType"),
  historyChart: document.querySelector("#historyChart"),
  threadCount: document.querySelector("#threadCount"),
  threadList: document.querySelector("#threadList"),
  endpoint: document.querySelector("#endpoint"),
  updatedAt: document.querySelector("#updatedAt"),
  codexAgent: document.querySelector("#codexAgent"),
  eventList: document.querySelector("#eventList"),
  refreshButton: document.querySelector("#refreshButton"),
};

let latestState = null;
const demoMode = new URLSearchParams(window.location.search).has("demo");

const demoState = {
  viewerStartedAt: Date.now() - 1000 * 60 * 18,
  appServerUrl: "ws://127.0.0.1:35420",
  connection: "online",
  connectionDetail: "Demo snapshot",
  codexHome: "C:\\Users\\you\\.codex",
  userAgent: "Codex Desktop/0.117.0 (demo)",
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 54,
      windowDurationMins: 300,
      resetsAt: Math.floor(Date.now() / 1000) + 78 * 60,
    },
    secondary: {
      usedPercent: 18,
      windowDurationMins: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60,
    },
    credits: {
      hasCredits: false,
      unlimited: false,
      balance: "0",
    },
    planType: "plus",
  },
  rateLimitsByLimitId: null,
  threads: [
    {
      id: "demo-thread-1",
      preview: "Build rate limit viewer",
      status: { type: "active" },
      source: "vscode",
      name: "Build rate limit viewer",
    },
    {
      id: "demo-thread-2",
      preview: "Review dashboard layout",
      status: { type: "idle" },
      source: "cli",
      name: "Review dashboard layout",
    },
    {
      id: "demo-thread-3",
      preview: "Polish README snapshot",
      status: { type: "notLoaded" },
      source: "appServer",
      name: "Polish README snapshot",
    },
  ],
  tokenUsageByThread: {
    "demo-thread-1": { total: { totalTokens: 48200 } },
    "demo-thread-2": { total: { totalTokens: 17480 } },
  },
  lastUpdated: Date.now(),
  history: Array.from({ length: 48 }, (_, index) => ({
    at: Date.now() - (47 - index) * 60 * 1000,
    primaryUsed: 24 + index * 0.65 + Math.sin(index / 3) * 4,
    secondaryUsed: 14 + index * 0.08,
  })),
  events: [
    { at: Date.now() - 1000 * 11, level: "info", message: "Connected to Codex App Server" },
    { at: Date.now() - 1000 * 45, level: "info", message: "Rate limits updated" },
    { at: Date.now() - 1000 * 92, level: "warn", message: "Primary window usage rising" },
  ],
  errors: [],
};

function percent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function remainingPercent(window) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return Math.max(0, 100 - window.usedPercent);
}

function formatWindowName(window, fallback) {
  const mins = window?.windowDurationMins;
  if (!mins) return fallback;
  if (mins === 300) return "5h window";
  if (mins === 10080) return "weekly window";
  if (mins % 1440 === 0) return `${Math.round(mins / 1440)}d window`;
  if (mins % 60 === 0) return `${Math.round(mins / 60)}h window`;
  return `${mins}m window`;
}

function formatClock(epochSeconds) {
  if (!epochSeconds) return "--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(epochSeconds * 1000));
}

function formatCountdown(epochSeconds) {
  if (!epochSeconds) return "--";
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return "reset soon";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function classifyRing(element, used) {
  element.classList.toggle("warn", used >= 65 && used < 85);
  element.classList.toggle("hot", used >= 85);
}

function renderGauge(prefix, window, fallbackTitle, historyKey) {
  const title = dom[`${prefix}Title`];
  const reset = dom[`${prefix}Reset`];
  const ring = dom[`${prefix}Ring`];
  const remaining = dom[`${prefix}Remaining`];
  const used = dom[`${prefix}Used`];
  const resetTime = dom[`${prefix}ResetTime`];

  title.textContent = formatWindowName(window, fallbackTitle);
  const usedValue = Number.isFinite(window?.usedPercent) ? window.usedPercent : 0;
  const remainingValue = remainingPercent(window);
  ring.style.setProperty("--used", String(Math.max(0, Math.min(100, usedValue))));
  classifyRing(ring, usedValue);
  remaining.textContent = remainingValue === null ? "--" : percent(remainingValue);
  used.textContent = percent(usedValue);
  reset.textContent = formatCountdown(window?.resetsAt);
  resetTime.textContent = formatClock(window?.resetsAt);

  if (historyKey === "primary") {
    dom.primaryRunway.textContent = computeRunway(latestState?.history || []);
  }
}

function getRateLimit(state) {
  if (state?.rateLimitsByLimitId?.codex) return state.rateLimitsByLimitId.codex;
  if (state?.rateLimits) return state.rateLimits;
  const values = Object.values(state?.rateLimitsByLimitId || {});
  return values[0] || null;
}

function computeRunway(history) {
  const points = history
    .filter((point) => Number.isFinite(point.primaryUsed))
    .slice(-40);
  if (points.length < 2) return "learning";

  const first = points[0];
  const last = points[points.length - 1];
  const minutes = (last.at - first.at) / 60000;
  const usedDelta = last.primaryUsed - first.primaryUsed;
  if (minutes <= 0 || usedDelta <= 0.05) return "stable";

  const rate = usedDelta / minutes;
  const remaining = Math.max(0, 100 - last.primaryUsed);
  const runwayMinutes = remaining / rate;
  if (!Number.isFinite(runwayMinutes)) return "stable";
  if (runwayMinutes < 60) return `${Math.round(runwayMinutes)}m`;
  if (runwayMinutes < 48 * 60) {
    return `${Math.round(runwayMinutes / 60)}h`;
  }
  return `${Math.round(runwayMinutes / 1440)}d`;
}

function renderHistory(history) {
  dom.historyChart.innerHTML = "";
  const points = (history || []).slice(-72);
  if (!points.length) {
    dom.historyChart.innerHTML = '<div class="empty-state">waiting for samples</div>';
    return;
  }

  for (const point of points) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const height = Math.max(2, Math.min(100, point.primaryUsed || 0));
    bar.style.height = `${height}%`;
    bar.title = `${percent(point.primaryUsed)} used at ${new Date(point.at).toLocaleTimeString()}`;
    dom.historyChart.append(bar);
  }
}

function statusText(status) {
  if (!status) return "unknown";
  if (typeof status === "string") return status;
  if (status.type === "active") return "active";
  return status.type || "unknown";
}

function renderThreads(threads, tokenUsageByThread) {
  const active = (threads || []).filter((thread) => statusText(thread.status) === "active");
  dom.threadCount.textContent = `${active.length} active`;
  dom.threadList.innerHTML = "";

  if (!threads?.length) {
    dom.threadList.innerHTML = '<div class="empty-state">no recent threads</div>';
    return;
  }

  for (const thread of threads.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "thread-item";
    const title = thread.name || thread.preview || thread.id;
    const usage = tokenUsageByThread?.[thread.id]?.total?.totalTokens;
    const usageText = Number.isFinite(usage) ? ` · ${usage.toLocaleString()} tokens` : "";
    item.innerHTML = `
      <strong>${escapeHtml(title)}</strong>
      <div class="thread-meta">${escapeHtml(statusText(thread.status))} · ${escapeHtml(thread.source || "unknown")}${usageText}</div>
    `;
    dom.threadList.append(item);
  }
}

function renderEvents(events, errors) {
  const merged = [...(events || [])];
  for (const error of errors || []) {
    if (!merged.some((item) => item.at === error.at && item.message === error.message)) {
      merged.push({ ...error, level: "error" });
    }
  }
  merged.sort((a, b) => b.at - a.at);
  dom.eventList.innerHTML = "";

  if (!merged.length) {
    dom.eventList.innerHTML = '<div class="empty-state">no events yet</div>';
    return;
  }

  for (const event of merged.slice(0, 10)) {
    const item = document.createElement("div");
    item.className = `event-item ${event.level || "info"}`;
    item.innerHTML = `
      <strong>${escapeHtml(event.message)}</strong>
      <div class="event-meta">${new Date(event.at).toLocaleTimeString()}</div>
    `;
    dom.eventList.append(item);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render(state) {
  latestState = state;
  const limit = getRateLimit(state);
  const connection = state.connection || "offline";

  dom.connectionPill.classList.toggle("online", connection === "online");
  dom.connectionPill.classList.toggle("offline", connection === "offline");
  dom.connectionLabel.textContent = connection;

  renderGauge("primary", limit?.primary, "5h window", "primary");
  renderGauge("secondary", limit?.secondary, "weekly window", "secondary");

  dom.planType.textContent = limit?.planType || "--";
  dom.endpoint.textContent = state.appServerUrl || "--";
  dom.updatedAt.textContent = state.lastUpdated
    ? new Date(state.lastUpdated).toLocaleTimeString()
    : "--";
  dom.codexAgent.textContent = state.userAgent || state.connectionDetail || "--";

  renderHistory(state.history);
  renderThreads(state.threads, state.tokenUsageByThread);
  renderEvents(state.events, state.errors);
}

async function loadSnapshot() {
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  render(await response.json());
}

function connectEvents() {
  const events = new EventSource("/events");
  events.addEventListener("state", (event) => {
    render(JSON.parse(event.data));
  });
  events.addEventListener("error", () => {
    dom.connectionPill.classList.add("offline");
    dom.connectionLabel.textContent = "viewer reconnecting";
  });
}

dom.refreshButton.addEventListener("click", async () => {
  dom.refreshButton.disabled = true;
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    render(await response.json());
  } finally {
    dom.refreshButton.disabled = false;
  }
});

setInterval(() => {
  if (latestState) render(latestState);
}, 1000);

if (demoMode) {
  render(demoState);
  setInterval(() => render(demoState), 1000);
} else {
  loadSnapshot().catch(() => {});
  connectEvents();
}
