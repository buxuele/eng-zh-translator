export const PROMPT_VERSION = "v1";
export const CACHE_VERSION = "v1";

export const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
  targetLang: "简体中文",
  mode: "scroll",
  idleFill: "auto",
  idleFillMaxChars: 20000,
  idleDelayMs: 2500,
  prefetchScreens: 2,
  batchSegments: 16,
  batchChars: 1500,
  concurrency: 2,
  temperature: 1,
  topP: 1,
  maxTokens: 4096,
  reasoningEffort: "low",
  cacheLimit: 8000,
  cacheMaxMB: 4,
  cacheTtlDays: 30,
  blacklist: [],
  autoTranslateHosts: [],
  scope: "all",
  selectionTranslate: true,
  hoverOriginal: true,
  flashHighlight: true,
};

export const MODEL_PRESETS = [
  { id: "quality", label: "质量优先", model: "openai/gpt-oss-120b" },
  { id: "fast", label: "速度优先", model: "openai/gpt-oss-20b" },
  { id: "custom", label: "自定义模型", model: "" },
];

export const LANGS = [
  { id: "简体中文", label: "简体中文" },
  { id: "繁體中文", label: "繁體中文" },
  { id: "日本語", label: "日本語" },
  { id: "한국어", label: "한국어" },
  { id: "English", label: "English" },
  { id: "Français", label: "Français" },
  { id: "Deutsch", label: "Deutsch" },
  { id: "Español", label: "Español" },
  { id: "Русский", label: "Русский" },
];

export const MSG = {
  BATCH: "BATCH",
  CACHE_LOOKUP: "CACHE_LOOKUP",
  CANCEL: "CANCEL",
  PING: "PING",
  SEG: "SEG",
  HITS: "HITS",
  DONE: "DONE",
  ERR: "ERR",
  RATE: "RATE",
  PROGRESS: "PROGRESS",
  STATE: "STATE",
  MODELS: "MODELS",
  TEST: "TEST",
  STATS: "STATS",
  CLEAR_CACHE: "CLEAR_CACHE",
  CACHE_PURGE: "CACHE_PURGE",
  TEXT: "TEXT",
  TEXT_DELTA: "TEXT_DELTA",
  TEXT_DONE: "TEXT_DONE",
};

// 域名归一化：去掉协议、路径、端口与通配前缀，只保留主机名。
export function normalizeDomain(value) {
  let host = String(value || "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0].split("?")[0].split("#")[0];
  host = host.replace(/:\d+$/, "");
  host = host.replace(/^\*\./, "").replace(/^\./, "");
  if (!host || host.length > 253) return "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return "";
  if (host.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return "";
  return host;
}

export function parseBlacklist(text) {
  const valid = [];
  const invalid = [];
  for (const line of String(text || "").split(/[\s,，;；]+/)) {
    const raw = line.trim();
    if (!raw) continue;
    const host = normalizeDomain(raw);
    if (!host) {
      invalid.push(raw);
      continue;
    }
    if (!valid.includes(host)) valid.push(host);
  }
  return { valid, invalid };
}

export function hostMatchesBlacklist(host, list) {
  const target = String(host || "").trim().toLowerCase();
  if (!target || !Array.isArray(list)) return false;
  for (const item of list) {
    const domain = normalizeDomain(item);
    if (!domain) continue;
    if (target === domain || target.endsWith("." + domain)) return true;
  }
  return false;
}

// 取接口地址的授权范围，用于校验可选主机权限。
export function originPatternOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return "";
  }
}

export function formatDuration(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return "0 秒";
  if (value < 100) return "0.1 秒";
  if (value >= 60000) return `${(value / 60000).toFixed(1)} 分钟`;
  if (value >= 10000) return `${Math.round(value / 1000)} 秒`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} 字节`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function buildSystemPrompt(lang) {
  return (
    `You are a professional translator working inside a browser extension. ` +
    `Input lines are numbered segments separated by a TAB character. All segments come from the same region of one web page, so keep terminology consistent across them. ` +
    `Translate every segment into ${lang}. Rules: keep the original meaning, tone and trailing punctuation; never merge, split, reorder, drop or explain segments; ` +
    `keep proper nouns, brand names, code identifiers, numbers and URLs unchanged; do not analyse, translate directly. ` +
    `Output one JSON object per line and nothing else: {"i":<index>,"t":"<translation>"}`
  );
}

export function buildUserMessage(segments) {
  return segments.map((s, i) => `${i}\t${s}`).join("\n");
}

export function buildSelectionPrompt(lang) {
  return (
    `You are a professional translator inside a browser extension. Translate the user's selected text into ${lang}. ` +
    `Output only the translation, with no quotes, no explanations and no JSON. ` +
    `Keep the original tone, line breaks and inline punctuation. Keep proper nouns, code identifiers, numbers and URLs unchanged.`
  );
}

export function cacheKeyFor(text, lang, model) {
  return `${CACHE_VERSION}|${lang}|${model}|${fnv1a(text)}|${text.length}`;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

export function parseGroqDuration(value) {
  if (!value) return 0;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m;
  let matched = false;
  while ((m = re.exec(value)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    if (m[2] === "ms") ms += n;
    else if (m[2] === "s") ms += n * 1000;
    else if (m[2] === "m") ms += n * 60000;
    else if (m[2] === "h") ms += n * 3600000;
  }
  if (!matched) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n * 1000 : 0;
  }
  return Math.round(ms);
}

export function estimateTokens(segments) {
  let chars = 0;
  for (const s of segments) chars += s.length;
  const input = Math.ceil(chars / 3.4) + 210;
  const output = Math.ceil(chars * 0.42) + 40;
  return input + output;
}

export function createObjectStream(onObject) {
  let buffer = "";
  let scanFrom = 0;

  function drain() {
    for (;;) {
      const start = buffer.indexOf("{", scanFrom);
      if (start === -1) {
        buffer = "";
        scanFrom = 0;
        return;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < buffer.length; i++) {
        const ch = buffer[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) {
        buffer = buffer.slice(start);
        scanFrom = 0;
        return;
      }
      const raw = buffer.slice(start, end + 1);
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = null;
      }
      if (obj && typeof obj.i === "number" && typeof obj.t === "string") onObject(obj);
      buffer = buffer.slice(end + 1);
      scanFrom = 0;
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      drain();
    },
    flush() {
      drain();
    },
  };
}
