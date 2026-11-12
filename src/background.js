import {
  DEFAULTS,
  MSG,
  buildSystemPrompt,
  buildUserMessage,
  cacheKeyFor,
  parseGroqDuration,
  estimateTokens,
  createObjectStream,
  CACHE_VERSION,
  hostMatchesBlacklist,
  originPatternOf,
  formatDuration,
} from "./shared/config.js";
import { getDevConfigKey } from "./shared/dev_key.js";

const settings = { ...DEFAULTS };
let devApiKey = "";
const settingsReady = (async () => {
  devApiKey = await getDevConfigKey();
  const stored = await chrome.storage.local.get("settings");
  if (stored.settings) Object.assign(settings, stored.settings);
  if (!settings.apiKey && devApiKey) settings.apiKey = devApiKey;
})();

function apiKeyOf() {
  return settings.apiKey || devApiKey || "";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings && changes.settings.newValue) {
    const prev = changes.settings.oldValue || {};
    const next = changes.settings.newValue;
    Object.assign(settings, next);
    if (
      prev.cacheLimit !== next.cacheLimit ||
      prev.cacheMaxMB !== next.cacheMaxMB ||
      prev.cacheTtlDays !== next.cacheTtlDays
    ) {
      purgeExpiredCache();
      evictOverLimit();
      schedulePersist();
    }
  }
});

const KEY_PREFIX = "t|";
const memCache = new Map();
let cacheBytes = 0;
let cacheReady = null;
let dirtyKeys = new Set();
let removedKeys = new Set();
let persistTimer = null;
let cacheExpired = 0;
let cacheError = "";

function entryBytes(key, entry) {
  return (key.length + (entry && entry.t ? entry.t.length : 0)) * 2 + 48;
}

function cacheTtlMs() {
  const days = Number(settings.cacheTtlDays ?? DEFAULTS.cacheTtlDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days * 86400000;
}

function cacheMaxBytes() {
  const mb = Number(settings.cacheMaxMB ?? DEFAULTS.cacheMaxMB);
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return mb * 1024 * 1024;
}

function isExpired(entry, now) {
  const ttl = cacheTtlMs();
  if (!ttl || !entry) return false;
  return now - (entry.at || 0) > ttl;
}

function ensureCache() {
  if (!cacheReady) {
    cacheReady = chrome.storage.local.get(null).then((all) => {
      cacheBytes = 0;
      const now = Date.now();
      let expired = 0;
      const legacy = [];
      for (const [k, v] of Object.entries(all)) {
        if (!v || typeof v.t !== "string") continue;
        const prefixed = k.startsWith(KEY_PREFIX);
        // 兼容 1.0.0 把缓存键直接当存储键的旧数据，迁移时补上前缀。
        const isLegacy = !prefixed && k.startsWith(CACHE_VERSION + "|");
        if (!prefixed && !isLegacy) continue;
        const key = prefixed ? k : KEY_PREFIX + k;
        if (isExpired(v, now)) {
          expired++;
          removedKeys.add(key);
          if (isLegacy) removedKeys.add(k);
          continue;
        }
        memCache.set(key, v);
        cacheBytes += entryBytes(key, v);
        if (isLegacy) {
          dirtyKeys.add(key);
          removedKeys.add(k);
          legacy.push(k);
        }
      }
      cacheExpired = expired;
      if (expired || legacy.length) schedulePersist();
      evictOverLimit();
    });
  }
  return cacheReady;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(persistCache, 3000);
}

function dropCache(key) {
  const hit = memCache.get(key);
  if (!hit) return;
  memCache.delete(key);
  cacheBytes = Math.max(0, cacheBytes - entryBytes(key, hit));
  dirtyKeys.delete(key);
  removedKeys.add(key);
}

function evictOverLimit() {
  const limit = Number(settings.cacheLimit ?? DEFAULTS.cacheLimit);
  const byteCap = cacheMaxBytes();
  let changed = false;
  if (Number.isFinite(limit) && limit > 0 && memCache.size > limit) {
    const excess = memCache.size - limit;
    const entries = [...memCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (const [k] of entries.slice(0, excess)) {
      dropCache(k);
      changed = true;
    }
  }
  if (byteCap > 0 && cacheBytes > byteCap) {
    const entries = [...memCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (const [k] of entries) {
      if (cacheBytes <= byteCap) break;
      dropCache(k);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

function purgeExpiredCache() {
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of [...memCache]) {
    if (!isExpired(v, now)) continue;
    dropCache(k);
    removed++;
  }
  if (removed) {
    cacheExpired += removed;
    schedulePersist();
  }
  return removed;
}

async function persistCache() {
  persistTimer = null;
  await ensureCache();
  purgeExpiredCache();
  evictOverLimit();

  const payload = {};
  for (const k of dirtyKeys) if (memCache.has(k)) payload[k] = memCache.get(k);
  const removeList = [...removedKeys];
  dirtyKeys = new Set();
  removedKeys = new Set();

  if (removeList.length) {
    try {
      await chrome.storage.local.remove(removeList);
    } catch (err) {
      cacheError = `缓存清理失败：${err && err.message ? err.message : err}`;
    }
  }

  if (Object.keys(payload).length) {
    try {
      await chrome.storage.local.set(payload);
      cacheError = "";
    } catch (err) {
      cacheError = `缓存写入失败：${err && err.message ? err.message : err}`;
      // 配额告急时先丢掉约四分之一的最久未用条目，稍后再写。
      const victims = [...memCache.entries()]
        .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
        .slice(0, Math.max(1, Math.ceil(memCache.size / 4)));
      const victimKeys = victims.map(([k]) => k);
      for (const k of victimKeys) dropCache(k);
      await chrome.storage.local.remove(victimKeys).catch(() => {});
      removedKeys = new Set();
      for (const k of Object.keys(payload)) if (memCache.has(k)) dirtyKeys.add(k);
      schedulePersist();
    }
  }
}

function storageKey(key) {
  return KEY_PREFIX + key;
}

function cacheGet(key) {
  const k = storageKey(key);
  const hit = memCache.get(k);
  if (!hit) return null;
  if (isExpired(hit, Date.now())) {
    dropCache(k);
    schedulePersist();
    return null;
  }
  const prevAt = hit.at || 0;
  hit.at = Date.now();
  // 五分钟内的重复命中只更新内存顺序，避免每次命中都触发一次落盘。
  if (hit.at - prevAt > 300000) dirtyKeys.add(k);
  schedulePersist();
  return hit.t;
}

function cacheSet(key, text) {
  const k = storageKey(key);
  const entry = { t: text, at: Date.now() };
  const old = memCache.get(k);
  if (old) cacheBytes = Math.max(0, cacheBytes - entryBytes(k, old));
  memCache.set(k, entry);
  cacheBytes += entryBytes(k, entry);
  dirtyKeys.add(k);
  removedKeys.delete(k);
  schedulePersist();
  // 立即按条数与占用上限回收，避免低上限设置下内存先超出再等定时落盘。
  evictOverLimit();
}

const rate = { remainingTokens: null, limitTokens: null, resetTokensAt: 0, remainingReq: null, limitReq: null, resetReqAt: 0 };
let quotaWaitUntil = 0;

function noteRateFromHeaders(res) {
  const rem = res.headers.get("x-ratelimit-remaining-tokens");
  const lim = res.headers.get("x-ratelimit-limit-tokens");
  const reset = res.headers.get("x-ratelimit-reset-tokens");
  if (rem !== null) rate.remainingTokens = Number(rem);
  if (lim !== null) rate.limitTokens = Number(lim);
  if (reset) rate.resetTokensAt = Date.now() + parseGroqDuration(reset);
  const rreq = res.headers.get("x-ratelimit-remaining-requests");
  const lreq = res.headers.get("x-ratelimit-limit-requests");
  const rreset = res.headers.get("x-ratelimit-reset-requests");
  if (rreq !== null) rate.remainingReq = Number(rreq);
  if (lreq !== null) rate.limitReq = Number(lreq);
  if (rreset) rate.resetReqAt = Date.now() + parseGroqDuration(rreset);
}

function quotaWaitFor(estimate) {
  const now = Date.now();
  let wait = 0;
  if (now < quotaWaitUntil) wait = quotaWaitUntil - now;
  if (rate.remainingTokens !== null && rate.remainingTokens < estimate && now < rate.resetTokensAt) {
    wait = Math.max(wait, rate.resetTokensAt - now);
  }
  return wait;
}

let running = 0;
const waiting = [];

async function acquireSlot() {
  const max = Math.max(1, Math.min(6, settings.concurrency || DEFAULTS.concurrency));
  if (running < max) {
    running++;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  running++;
}

function releaseSlot() {
  running--;
  const next = waiting.shift();
  if (next) next();
}

function apiUrl() {
  return (settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "") + "/chat/completions";
}

class ApiError extends Error {
  constructor(status, body, headers, kind) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error?.message || body;
    } catch {}
    super(`${status}: ${detail}`.slice(0, 300));
    this.status = status;
    this.kind = kind || "";
    this.detail = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 200);
    let retryAfter = headers ? parseGroqDuration(headers.get("retry-after")) : 0;
    if (!retryAfter && status === 429) {
      const match = /try again in ([0-9.]+(?:ms|s|m|h)[0-9a-z.]*)/i.exec(detail);
      if (match) retryAfter = parseGroqDuration(match[1]);
    }
    this.retryAfter = retryAfter;
    this.daily = /tokens per day|TPD\b/i.test(detail);
    this.retryable = status === 429 || status >= 500 || status === 0;
  }
}

// 把底层异常翻译成用户能看懂的中文原因，并给出是否值得重试。
function describeFailure(err) {
  if (!(err instanceof ApiError)) {
    const raw = String(err && err.message ? err.message : err);
    if (err && err.name === "AbortError") {
      return { code: "aborted", title: "已取消", message: "本次翻译已取消。", detail: "", retryable: false };
    }
    const network = /Failed to fetch|NetworkError|Load failed|net::ERR_|ERR_NAME|ERR_CONNECTION|ERR_PROXY|timed? ?out/i.test(raw);
    return {
      code: "network",
      title: "网络错误",
      message: network
        ? "无法连接翻译接口，请检查网络或代理是否正常，然后点重试。"
        : "请求翻译接口时出现异常，请稍后点重试。",
      detail: raw.replace(/\s+/g, " ").slice(0, 200),
      retryable: true,
    };
  }
  if (err.kind === "config") {
    return {
      code: "auth",
      title: "密钥未配置",
      message: "尚未配置接口密钥，请打开设置页填写 Groq 密钥。",
      detail: "",
      retryable: false,
    };
  }
  if (err.kind === "permission") {
    return {
      code: "permission",
      title: "接口域名未授权",
      message: "当前接口域名尚未获得扩展授权，请到设置页点授权接口域名后再重试。",
      detail: err.detail,
      retryable: false,
    };
  }
  const status = err.status;
  if (status === 401) {
    return {
      code: "auth",
      title: "密钥无效",
      message: "密钥无效或已失效，请在设置页更新 Groq 密钥。",
      detail: err.detail,
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      code: "forbidden",
      title: "接口拒绝访问",
      message: "接口拒绝访问，可能是密钥权限不足或网络出口被拦截，请检查代理后重试。",
      detail: err.detail,
      retryable: false,
    };
  }
  if (status === 429) {
    const wait = err.retryAfter > 0 ? formatDuration(err.retryAfter) : "";
    const message = err.daily
      ? `今日接口额度已用尽${wait ? `，约 ${wait}后恢复` : ""}，译文缓存会保留，额度恢复后可点重试。`
      : `触发接口限流${wait ? `，约 ${wait}后自动继续` : ""}，也可以稍后点重试。`;
    return { code: "rate", title: "触发限流", message, detail: err.detail, retryable: true };
  }
  if (status === 413 || status === 400 || status === 422) {
    return {
      code: "api",
      title: "接口拒绝请求",
      message: "接口认为这批内容不合法，可能是文本过长或被安全策略拦截，请点重试。",
      detail: err.detail,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      code: "server",
      title: "接口临时故障",
      message: "翻译接口服务端临时故障，稍后会自动重试，也可以点重试立即发起。",
      detail: err.detail,
      retryable: true,
    };
  }
  if (status === 0) {
    return {
      code: "network",
      title: "网络错误",
      message: "无法连接翻译接口，请检查网络或代理是否正常，然后点重试。",
      detail: err.detail,
      retryable: true,
    };
  }
  return {
    code: "api",
    title: "请求失败",
    message: `翻译接口返回异常状态 ${status || "未知"}，请稍后点重试。`,
    detail: err.detail,
    retryable: !!err.retryable,
  };
}

async function assertEndpointPermission() {
  const origin = originPatternOf(apiUrl());
  if (!origin || !chrome.permissions?.contains) return;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) throw new ApiError(0, "", null, "permission");
}

function hostOfUrl(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function streamCompletion(segments, signal, onSegment) {
  const key = apiKeyOf();
  if (!key) throw new ApiError(0, "", null, "config");
  await assertEndpointPermission();

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: buildSystemPrompt(settings.targetLang) },
      { role: "user", content: buildUserMessage(segments) },
    ],
    temperature: Number(settings.temperature),
    max_completion_tokens: Number(settings.maxTokens),
    top_p: Number(settings.topP),
    reasoning_effort: settings.reasoningEffort,
    stream: true,
  };

  const started = Date.now();
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  noteRateFromHeaders(res);
  if (!res.ok) throw new ApiError(res.status, await res.text(), res.headers);

  const parser = createObjectStream((obj) => onSegment(obj.i, obj.t));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  let finishReason = null;
  let firstContentAt = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json = null;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta && delta.content) {
        if (firstContentAt === null) firstContentAt = Date.now() - started;
        parser.push(delta.content);
      }
    }
  }
  parser.flush();
  return { usage, finishReason, firstContentAt, ms: Date.now() - started };
}

async function translateBatch(segments, signal, onSegment, onWait) {
  const estimate = estimateTokens(segments);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = quotaWaitFor(estimate);
    if (wait > 0) {
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, Math.min(wait, 45000)));
    }
    onWait?.(0);
    await acquireSlot();
    try {
      const out = await streamCompletion(segments, signal, onSegment);
      return out;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (!(err instanceof ApiError) || !err.retryable || attempt === 4) throw err;
      if (err.retryAfter > 45000) throw err;
      const backoff = Math.min(err.retryAfter || 1500 * attempt, 45000);
      if (err.status === 429) quotaWaitUntil = Date.now() + backoff;
      onWait?.(backoff);
      await new Promise((r) => setTimeout(r, backoff));
    } finally {
      releaseSlot();
    }
  }
}

async function handleBatch(port, msg, signal) {
  await settingsReady;
  await ensureCache();
  const tabHost = hostOfUrl(port.sender?.tab?.url);
  if (tabHost && hostMatchesBlacklist(tabHost, settings.blacklist)) {
    port.postMessage({
      t: MSG.ERR,
      id: msg.id,
      code: "blocked",
      title: "免翻译站点",
      message: `当前站点 ${tabHost} 在免翻译名单内，未发送任何翻译请求。可在设置页的站点黑名单中移除它。`,
      detail: "",
      retryable: false,
      failedIndexes: [],
    });
    return;
  }
  const segments = msg.segs;
  const lang = msg.lang || settings.targetLang;
  const model = settings.model;

  const keys = segments.map((s) => cacheKeyFor(s, lang, model));
  const hits = {};
  const missIndexes = [];
  const missSeen = new Map();
  const uniqueTexts = [];
  const uniqueOf = [];

  for (let i = 0; i < segments.length; i++) {
    const cached = cacheGet(keys[i]);
    if (cached !== null) {
      hits[i] = cached;
      port.postMessage({ t: MSG.SEG, id: msg.id, i, text: cached, cached: true });
      continue;
    }
    missIndexes.push(i);
    const existing = missSeen.get(segments[i]);
    if (existing === undefined) {
      missSeen.set(segments[i], uniqueOf.length);
      uniqueOf.push([]);
      uniqueTexts.push(segments[i]);
    }
    uniqueOf[missSeen.get(segments[i])].push(i);
  }

  if (!uniqueTexts.length) {
    port.postMessage({ t: MSG.DONE, id: msg.id, cached: msg.segs.length, translated: 0, failed: 0, ms: 0 });
    return;
  }

  const received = new Set();
  const outText = new Map();
  const onSegment = (idx, text) => {
    if (idx < 0 || idx >= uniqueTexts.length || received.has(idx)) return;
    received.add(idx);
    outText.set(idx, text);
    for (const originalIndex of uniqueOf[idx]) {
      cacheSet(keys[originalIndex], text);
      port.postMessage({ t: MSG.SEG, id: msg.id, i: originalIndex, text, cached: false });
    }
  };

  const started = Date.now();
  let usage = null;
  let finishReason = null;
  let failed = 0;

  const runChunk = (texts, idxMap) =>
    translateBatch(
      texts,
      signal,
      (localIdx, text) => onSegment(idxMap[localIdx], text),
      (waitMs) => port.postMessage({ t: MSG.RATE, id: msg.id, waitMs, remainingTokens: rate.remainingTokens, limitTokens: rate.limitTokens }),
    );

  let error = null;
  let pendingTexts = uniqueTexts;
  let pendingMap = uniqueTexts.map((_, i) => i);
  for (let round = 0; round < 3; round++) {
    if (!pendingTexts.length) break;
    try {
      const out = await runChunk(pendingTexts, pendingMap);
      usage = out.usage || usage;
      finishReason = out.finishReason || finishReason;
    } catch (err) {
      if (err.name === "AbortError") {
        port.postMessage({ t: MSG.ERR, id: msg.id, code: "aborted", message: "已取消", retryable: false, failedIndexes: [] });
        return;
      }
      error = err;
      break;
    }
    const missing = [];
    for (let i = 0; i < pendingMap.length; i++) if (!received.has(pendingMap[i])) missing.push(i);
    if (!missing.length) break;
    pendingTexts = missing.map((i) => pendingTexts[i]);
    pendingMap = missing.map((i) => pendingMap[i]);
  }

  const lost = [];
  for (let i = 0; i < uniqueTexts.length; i++) if (!received.has(i)) lost.push(...uniqueOf[i]);

  if (error && lost.length === missIndexes.length) {
    const info = describeFailure(error);
    port.postMessage({
      t: MSG.ERR,
      id: msg.id,
      code: info.code,
      title: info.title,
      message: info.message,
      detail: info.detail,
      retryable: info.retryable,
      retryAfterMs: error.retryAfter || 0,
      daily: !!error.daily,
      failedIndexes: lost,
      rate: { remainingTokens: rate.remainingTokens, limitTokens: rate.limitTokens },
    });
    return;
  }

  failed = lost.length;
  port.postMessage({
    t: MSG.DONE,
    id: msg.id,
    cached: Object.keys(hits).length,
    translated: missIndexes.length - failed,
    failed,
    failedIndexes: lost,
    ms: Date.now() - started,
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    finishReason,
    truncated: finishReason === "length",
    rate: { remainingTokens: rate.remainingTokens, limitTokens: rate.limitTokens, resetAt: rate.resetTokensAt },
  });
}

async function handleCacheLookup(port, msg) {
  await ensureCache();
  const lang = msg.lang || settings.targetLang;
  const model = settings.model;
  const hits = {};
  for (let i = 0; i < msg.segs.length; i++) {
    const found = cacheGet(cacheKeyFor(msg.segs[i], lang, model));
    if (found !== null) hits[i] = found;
  }
  port.postMessage({ t: MSG.HITS, id: msg.id, hits });
}

function setBadge(tabId, msg) {
  if (tabId === undefined) return;
  if (msg.status === "error" || msg.status === "blocked") {
    chrome.action.setBadgeText({ tabId, text: "!" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#d92d20" });
    return;
  }
  if (!msg.total) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const pct = Math.round((msg.done / msg.total) * 100);
  const text = msg.done >= msg.total ? "完成" : `${pct}%`;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: msg.done >= msg.total ? "#9adb37" : "#fc0377" });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "eng_zh") return;
  const inflight = new Map();
  port.onMessage.addListener((msg) => {
    if (!msg || !msg.t) return;
    if (msg.t === MSG.PING) return;
    if (msg.t === MSG.PROGRESS) {
      setBadge(port.sender?.tab?.id, msg);
      return;
    }
    if (msg.t === MSG.CANCEL) {
      inflight.get(msg.id)?.abort();
      return;
    }
    if (msg.t === MSG.BATCH) {
      const controller = new AbortController();
      inflight.set(msg.id, controller);
      handleBatch(port, msg, controller.signal)
        .catch((err) => port.postMessage({ t: MSG.ERR, id: msg.id, code: "internal", message: String(err && err.message ? err.message : err), retryable: false, failedIndexes: [] }))
        .finally(() => inflight.delete(msg.id));
      return;
    }
    if (msg.t === MSG.CACHE_LOOKUP) {
      handleCacheLookup(port, msg).catch((err) => port.postMessage({ t: MSG.ERR, id: msg.id, code: "internal", message: String(err && err.message ? err.message : err), retryable: false, failedIndexes: [] }));
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.t) return false;
  if (msg.t === MSG.MODELS) {
    settingsReady.then(async () => {
      if (!apiKeyOf()) return sendResponse({ ok: false, message: "尚未配置密钥，请先填写 Groq 密钥。" });
      try {
        await assertEndpointPermission();
        const res = await fetch((settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "") + "/models", {
          headers: { Authorization: `Bearer ${apiKeyOf()}` },
        });
        const text = await res.text();
        if (!res.ok) {
          const info = describeFailure(new ApiError(res.status, text, res.headers));
          return sendResponse({ ok: false, message: info.message, detail: info.detail });
        }
        const ids = JSON.parse(text).data.map((m) => m.id).filter((id) => !/whisper|orpheus|prompt-guard|safeguard/.test(id));
        sendResponse({ ok: true, models: ids });
      } catch (err) {
        const info = describeFailure(err);
        sendResponse({ ok: false, message: info.message, detail: info.detail });
      }
    });
    return true;
  }
  if (msg.t === MSG.TEST) {
    settingsReady.then(async () => {
      const t0 = Date.now();
      let got = "";
      try {
        await streamCompletion([msg.text || "Hello world, this is a live connection test."], undefined, (i, text) => {
          got = text;
        });
        sendResponse({ ok: true, ms: Date.now() - t0, text: got, rate: { remainingTokens: rate.remainingTokens, limitTokens: rate.limitTokens } });
      } catch (err) {
        const info = describeFailure(err);
        sendResponse({ ok: false, ms: Date.now() - t0, message: info.message, detail: info.detail, code: info.code });
      }
    });
    return true;
  }
  if (msg.t === MSG.STATS) {
    ensureCache().then(() => {
      purgeExpiredCache();
      sendResponse({
        ok: true,
        cacheEntries: memCache.size,
        cacheBytes,
        cacheExpired,
        cacheError,
        cacheLimit: settings.cacheLimit,
        cacheMaxMB: settings.cacheMaxMB,
        cacheTtlDays: settings.cacheTtlDays,
        rate: { remainingTokens: rate.remainingTokens, limitTokens: rate.limitTokens, resetAt: rate.resetTokensAt },
        settings: { ...settings },
      });
    });
    return true;
  }
  if (msg.t === MSG.CLEAR_CACHE) {
    ensureCache().then(async () => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX) || k.startsWith(CACHE_VERSION + "|"));
      memCache.clear();
      cacheBytes = 0;
      cacheExpired = 0;
      cacheError = "";
      dirtyKeys = new Set();
      removedKeys = new Set();
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (keys.length) await chrome.storage.local.remove(keys);
      sendResponse({ ok: true, removed: keys.length });
    });
    return true;
  }
  if (msg.t === MSG.CACHE_PURGE) {
    ensureCache().then(async () => {
      const removed = purgeExpiredCache();
      await persistCache();
      sendResponse({ ok: true, removed, cacheEntries: memCache.size, cacheBytes });
    });
    return true;
  }
  return false;
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { t: "CMD", cmd: "toggle" });
  } catch {}
});
