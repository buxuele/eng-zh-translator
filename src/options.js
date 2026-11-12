import { DEFAULTS, LANGS, MSG, MODEL_PRESETS, parseBlacklist, originPatternOf, formatBytes } from "./shared/config.js";
import { getDevConfigKey } from "./shared/dev_key.js";

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let saveTimer = null;
let devKey = "";

const NUMERIC = ["prefetchScreens", "batchSegments", "batchChars", "concurrency", "maxTokens", "temperature", "cacheLimit", "cacheMaxMB", "cacheTtlDays", "idleFillMaxChars"];
const BOOLEAN = ["flashHighlight", "selectionTranslate", "hoverOriginal"];
const PRESET_OF = (model) => {
  const hit = MODEL_PRESETS.find((item) => item.model && item.model === model);
  return hit ? hit.id : "custom";
};

function flashSaved(text, cls) {
  const el = $("saveState");
  el.textContent = text;
  el.className = "chip" + (cls ? " " + cls : "");
}

async function save() {
  await chrome.storage.local.set({ settings });
  flashSaved("已保存");
}

function scheduleSave() {
  flashSaved("保存中");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  const values = items.slice();
  if (value && !values.some((v) => v.value === value)) values.unshift({ value, label: value });
  for (const item of values) {
    const opt = document.createElement("option");
    opt.value = item.value;
    opt.textContent = item.label;
    sel.appendChild(opt);
  }
  sel.value = value;
}

function render() {
  $("apiKey").value = settings.apiKey || devKey || "";
  $("baseUrl").value = settings.baseUrl;
  fillSelect($("model"), [], settings.model);
  fillSelect($("targetLang"), LANGS.map((l) => ({ value: l.id, label: l.label })), settings.targetLang);
  $("mode").value = settings.mode;
  $("scope").value = settings.scope || "all";
  $("reasoningEffort").value = settings.reasoningEffort;
  $("idleFill").value = settings.idleFill === true ? "on" : settings.idleFill === false ? "off" : settings.idleFill;
  $("blacklist").value = Array.isArray(settings.blacklist) ? settings.blacklist.join("\n") : "";
  $("autoTranslate").value = Array.isArray(settings.autoTranslateHosts) ? settings.autoTranslateHosts.join("\n") : "";
  $("preset").value = PRESET_OF(settings.model);
  updateBlacklistState();
  updateAutoState();
  for (const key of BOOLEAN) $(key).checked = !!settings[key];
  for (const key of NUMERIC) $(key).value = settings[key];
}

function updateBlacklistState() {
  const el = $("blacklistState");
  const { valid, invalid } = parseBlacklist($("blacklist").value);
  if (!valid.length) {
    el.textContent = invalid.length ? `已忽略 ${invalid.length} 个无效项，当前没有生效的域名` : "未设置，所有站点都会翻译";
    el.className = invalid.length ? "result err" : "result";
    return;
  }
  el.textContent = `已设置 ${valid.length} 个域名，其子域名同样命中${invalid.length ? `，已忽略 ${invalid.length} 个无效项` : ""}`;
  el.className = invalid.length ? "result err" : "result ok";
}

function updateAutoState() {
  const el = $("autoState");
  const { valid, invalid } = parseBlacklist($("autoTranslate").value);
  if (!valid.length) {
    el.textContent = invalid.length ? `已忽略 ${invalid.length} 个无效项，当前没有自动翻译的站点` : "未设置，需要手动点翻译";
    el.className = invalid.length ? "result err" : "result";
    return;
  }
  el.textContent = `已设置 ${valid.length} 个域名，打开即自动翻译${invalid.length ? `，已忽略 ${invalid.length} 个无效项` : ""}`;
  el.className = invalid.length ? "result err" : "result ok";
}

async function refreshPermission() {
  const el = $("permState");
  const origin = originPatternOf(settings.baseUrl);
  if (!origin) {
    el.textContent = "接口地址无效，仅支持 http 或 https";
    el.className = "result err";
    return;
  }
  if (!chrome.permissions || !chrome.permissions.contains) {
    el.textContent = "当前浏览器不支持权限查询";
    el.className = "result";
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  el.textContent = granted ? `已授权 ${origin}` : `未授权 ${origin}`;
  el.className = granted ? "result ok" : "result err";
}

function wire() {
  $("apiKey").addEventListener("input", () => { settings.apiKey = $("apiKey").value.trim(); scheduleSave(); });
  $("baseUrl").addEventListener("input", () => {
    settings.baseUrl = $("baseUrl").value.trim();
    scheduleSave();
    refreshPermission();
  });
  $("model").addEventListener("change", () => {
    settings.model = $("model").value;
    $("preset").value = PRESET_OF(settings.model);
    scheduleSave();
  });
  $("preset").addEventListener("change", () => {
    const preset = MODEL_PRESETS.find((item) => item.id === $("preset").value);
    if (preset && preset.model) {
      settings.model = preset.model;
      fillSelect($("model"), [], settings.model);
      scheduleSave();
    }
  });
  $("targetLang").addEventListener("change", () => { settings.targetLang = $("targetLang").value; scheduleSave(); });
  $("mode").addEventListener("change", () => { settings.mode = $("mode").value; scheduleSave(); });
  $("scope").addEventListener("change", () => { settings.scope = $("scope").value; scheduleSave(); });
  $("reasoningEffort").addEventListener("change", () => { settings.reasoningEffort = $("reasoningEffort").value; scheduleSave(); });
  $("idleFill").addEventListener("change", () => { settings.idleFill = $("idleFill").value; scheduleSave(); });
  for (const key of BOOLEAN) $(key).addEventListener("change", () => { settings[key] = $(key).checked; scheduleSave(); });
  for (const key of NUMERIC) {
    $(key).addEventListener("change", () => {
      const n = Number($(key).value);
      if (Number.isFinite(n)) settings[key] = n;
      $(key).value = settings[key];
      scheduleSave();
      if (key === "cacheLimit" || key === "cacheMaxMB" || key === "cacheTtlDays") {
        setTimeout(refreshStats, 500);
      }
    });
  }
  $("blacklist").addEventListener("input", () => {
    settings.blacklist = parseBlacklist($("blacklist").value).valid;
    updateBlacklistState();
    scheduleSave();
  });
  $("autoTranslate").addEventListener("input", () => {
    settings.autoTranslateHosts = parseBlacklist($("autoTranslate").value).valid;
    updateAutoState();
    scheduleSave();
  });

  $("grantHost").addEventListener("click", async () => {
    const el = $("permState");
    const origin = originPatternOf(settings.baseUrl);
    if (!origin) {
      el.textContent = "接口地址无效，仅支持 http 或 https";
      el.className = "result err";
      return;
    }
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      el.textContent = granted ? `已授权 ${origin}` : `未授权 ${origin}，自定义接口将无法访问`;
      el.className = granted ? "result ok" : "result err";
    } catch (err) {
      el.textContent = `授权失败：${err && err.message ? err.message : err}`;
      el.className = "result err";
    }
    refreshPermission();
  });

  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("toggleKey").textContent = showing ? "显示" : "隐藏";
  });

  $("loadModels").addEventListener("click", async () => {
    const el = $("testResult");
    el.textContent = "正在拉取模型列表";
    el.className = "result";
    const res = await chrome.runtime.sendMessage({ t: MSG.MODELS });
    if (!res || !res.ok) {
      el.textContent = `拉取失败：${res ? res.message : "扩展无响应"}${res && res.detail ? `（接口原文：${res.detail}）` : ""}`;
      el.className = "result err";
      return;
    }
    fillSelect($("model"), res.models.map((m) => ({ value: m, label: m })), settings.model);
    el.textContent = `已拉取 ${res.models.length} 个模型`;
    el.className = "result ok";
  });

  $("test").addEventListener("click", async () => {
    const el = $("testResult");
    el.textContent = "正在请求真实接口";
    el.className = "result";
    const res = await chrome.runtime.sendMessage({ t: MSG.TEST, text: "The extension streams translations while you scroll." });
    if (!res || !res.ok) {
      el.textContent = `失败：${res ? res.message : "扩展无响应"}${res && res.detail ? `（接口原文：${res.detail}）` : ""}`;
      el.className = "result err";
      return;
    }
    el.textContent = `成功，用时 ${res.ms} 毫秒，返回：${res.text}`;
    el.className = "result ok";
    refreshStats();
  });

  $("purgeCache").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ t: MSG.CACHE_PURGE });
    $("clearResult").textContent = res && res.ok ? `已清理 ${res.removed} 条过期缓存` : "清理失败";
    $("clearResult").className = res && res.ok ? "result ok" : "result err";
    refreshStats();
  });

  $("clearCache").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ t: MSG.CLEAR_CACHE });
    $("clearResult").textContent = res && res.ok ? `已删除 ${res.removed} 条缓存` : "清理失败";
    $("clearResult").className = res && res.ok ? "result ok" : "result err";
    refreshStats();
  });

  $("reset").addEventListener("click", async () => {
    settings = { ...DEFAULTS, apiKey: settings.apiKey };
    render();
    await save();
    refreshPermission();
  });
}

async function refreshStats() {
  const res = await chrome.runtime.sendMessage({ t: MSG.STATS });
  if (!res || !res.ok) return;
  const countLimit = res.cacheLimit > 0 ? `上限 ${res.cacheLimit} 条` : "条数不限";
  const byteLimit = res.cacheMaxMB > 0 ? ` / ${res.cacheMaxMB} MB` : "";
  const ttl = res.cacheTtlDays > 0 ? `，${res.cacheTtlDays} 天过期` : "，不按时间过期";
  $("cacheCount").textContent = `${res.cacheEntries} 条，${countLimit}，占用约 ${formatBytes(res.cacheBytes)}${byteLimit}${ttl}`;
  if (res.cacheError) {
    $("clearResult").textContent = res.cacheError;
    $("clearResult").className = "result err";
  }
  $("rateState").textContent = res.rate.remainingTokens === null ? "暂无数据，发起一次翻译后显示" : `剩余 ${res.rate.remainingTokens} / ${res.rate.limitTokens} tokens`;
}

async function init() {
  devKey = await getDevConfigKey();
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  render();
  wire();
  flashSaved("已保存");
  await refreshStats();
  await refreshPermission();
}

init();
