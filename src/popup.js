import { DEFAULTS, LANGS, MSG, formatDuration, hostMatchesBlacklist, normalizeDomain } from "./shared/config.js";
import { getDevConfigKey } from "./shared/dev_key.js";

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let tab = null;
let supported = false;
let polling = null;
let host = "";
let lastState = null;
let rawOpen = false;
let devKey = "";

function chip(text, cls) {
  const el = $("chip");
  el.textContent = text;
  el.className = "chip" + (cls ? " " + cls : "");
}

function fillLangs() {
  const sel = $("lang");
  sel.innerHTML = "";
  for (const l of LANGS) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.label;
    sel.appendChild(opt);
  }
}

async function ask(cmd) {
  if (!tab || !supported) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { t: "CMD", cmd });
    return res && res.state ? res.state : null;
  } catch {
    return null;
  }
}

function setPrimary(text, kind) {
  const btn = $("primary");
  btn.textContent = text;
  btn.className = kind === "ghost" ? "primary ghost" : "primary";
  btn.disabled = kind === "disabled";
}

function renderStats(state) {
  const total = state.total || 0;
  const done = state.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $("barFill").style.width = pct + "%";
  $("barFill").style.background = pct >= 100 && total > 0 ? "#9adb37" : "#fc0377";
  $("sDone").textContent = done;
  $("sQueue").textContent = state.queue || 0;
  $("sCached").textContent = state.cachedUnits || 0;
  $("sFailed").textContent = state.failed || 0;
}

function renderError(state) {
  const box = $("errorBox");
  const retry = $("retry");
  if (!state || !state.error) {
    box.classList.remove("show");
    $("errorRaw").classList.add("hidden");
    $("errDetail").textContent = "详情";
    rawOpen = false;
    return;
  }
  $("errorTitle").textContent = state.errorTitle || "翻译遇到问题";
  $("errorText").textContent = state.error;
  const raw = state.errorDetail || "";
  $("errorRaw").textContent = raw;
  $("errDetail").classList.toggle("hidden", !raw);
  $("errorRaw").classList.toggle("hidden", !rawOpen || !raw);
  $("errDetail").textContent = rawOpen ? "收起" : "详情";
  retry.classList.toggle("hidden", !state.retryable);
  box.classList.add("show");
}

function renderBlocked(message) {
  chip("免译站点", "err");
  setPrimary("此站免译", "disabled");
  $("secondary").classList.add("hidden");
  $("tip").textContent = message || `当前站点 ${host} 在免翻译名单内，可在下方开关里取消。`;
  $("tip").className = "tip err";
  $("siteBlacklist").checked = true;
  $("errorBox").classList.remove("show");
}

function renderState(state) {
  lastState = state;
  const tip = $("tip");
  const secondary = $("secondary");

  if (!state) {
    if (host && hostMatchesBlacklist(host, settings.blacklist)) {
      renderBlocked();
      return;
    }
    chip("无响应", "err");
    tip.textContent = "当前页面未注入脚本，刷新页面后重试。";
    tip.className = "tip err";
    setPrimary("翻译此页", "disabled");
    secondary.classList.add("hidden");
    renderError(null);
    return;
  }

  if (state.blocked) {
    renderBlocked(state.error);
    renderStats(state);
    return;
  }

  renderStats(state);
  renderError(state);

  secondary.classList.add("hidden");
  secondary.textContent = "重新翻译";

  if (state.status === "skipped") {
    chip("已是中文", "done");
    setPrimary("仍然翻译", "primary");
    tip.textContent = "页面文字以中文为主，自动翻译已跳过。需要强制翻译可以点仍然翻译。";
    tip.className = "tip";
  } else if (state.showingOriginal) {
    chip("原文");
    setPrimary("恢复译文", "primary");
    tip.textContent = "正在显示原文，点恢复译文立即切回，不消耗额度。";
    tip.className = "tip";
  } else if (state.status === "running") {
    chip(state.waitMs > 0 ? "限流等待" : "翻译中", "run");
    setPrimary("停止翻译", "ghost");
    const wait = state.waitMs > 0 ? `，正在等待额度 ${formatDuration(state.waitMs)}` : "";
    tip.textContent = `已译 ${state.done || 0} / ${state.total || 0} 段，已用 ${formatDuration(state.elapsedMs || 0)}${wait}。`;
    tip.className = "tip";
  } else if (state.status === "done") {
    chip("已完成", "done");
    setPrimary("显示原文", "primary");
    secondary.classList.remove("hidden");
    tip.textContent = `本页 ${state.total || 0} 段译完，用时 ${formatDuration(state.durationMs || state.elapsedMs || 0)}。`;
    tip.className = "tip";
  } else if (state.status === "error") {
    chip("已暂停", "err");
    setPrimary("显示原文", state.done > 0 ? "primary" : "ghost");
    if (state.done > 0) secondary.classList.remove("hidden");
    tip.textContent = "翻译已暂停，处理上方原因后可以重试。";
    tip.className = "tip err";
  } else if (state.status === "paused") {
    chip("已停止");
    setPrimary(state.done > 0 ? "显示原文" : "继续翻译", "primary");
    if (state.done > 0) secondary.classList.remove("hidden");
    tip.textContent = state.done > 0 ? "翻译已停止，已译部分保留。" : "尚未开始翻译。";
    tip.className = "tip";
  } else {
    chip("未开始");
    setPrimary("翻译此页", "primary");
    tip.textContent = "点下方按键开始，滚动到哪就译到哪。快捷键 Alt+Shift+T。";
    tip.className = "tip";
  }

  if (state.total > 0 && state.status !== "running" && state.status !== "skipped") {
    const tokens = state.tokensIn || state.tokensOut ? `，输入 ${state.tokensIn} tokens，输出 ${state.tokensOut} tokens` : "";
    const rate = state.rateLimit ? `，本分钟额度剩余 ${state.rateRemaining ?? "未知"} / ${state.rateLimit}` : "";
    if (!state.error) tip.textContent = tip.textContent.replace(/。$/, "") + `${tokens}${rate}。`;
  }
}

async function refresh() {
  renderState(await ask("status"));
}

function renderKeyState() {
  const ok = !!(settings.apiKey || devKey);
  $("keyState").textContent = ok ? `密钥已配置 · ${settings.model}` : "密钥未配置";
}

function renderSiteToggles() {
  $("siteBlacklist").checked = !!host && hostMatchesBlacklist(host, settings.blacklist);
  const auto = Array.isArray(settings.autoTranslateHosts) ? settings.autoTranslateHosts : [];
  $("siteAuto").checked = !!host && auto.includes(host);
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  renderKeyState();
  renderSiteToggles();
}

function setPrimaryHandler(handler) {
  $("primary").onclick = handler;
}

async function primaryAction() {
  const state = lastState;
  if (state && state.status === "skipped") {
    await ask("translate");
    await refresh();
    return;
  }
  if (state && state.showingOriginal) {
    await ask("toggle");
    await refresh();
    return;
  }
  if (state && state.status === "running") {
    await ask("stop");
    await refresh();
    return;
  }
  if (state && (state.status === "done" || state.status === "paused") && (state.done || 0) > 0) {
    await ask("restore");
    await refresh();
    return;
  }
  const res = await ask("translate");
  if (!res) {
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["src/content/protocol.js", "src/content/collect.js", "src/content/ui.js", "src/content/engine.js", "src/content/main.js"] })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await ask("translate");
  }
  await refresh();
}

async function init() {
  devKey = await getDevConfigKey();
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  fillLangs();
  $("lang").value = settings.targetLang;
  $("mode").value = settings.mode;
  renderKeyState();

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active || null;
  if (tab && (tab.url || "").startsWith("chrome-extension://")) {
    const all = await chrome.tabs.query({});
    const candidates = all.filter((t) => /^https?:/.test(t.url || "")).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (candidates.length) tab = candidates[0];
  }
  supported = !!tab && /^(https?|file):/.test(tab.url || "");
  if (!supported) {
    chip("不支持此页面", "err");
    $("tip").textContent = "浏览器内部页面无法注入翻译脚本。";
    $("tip").className = "tip err";
    setPrimary("翻译此页", "disabled");
    return;
  }

  try {
    host = normalizeDomain(new URL(tab.url).hostname);
  } catch {
    host = "";
  }
  renderSiteToggles();
  setPrimaryHandler(primaryAction);

  $("secondary").addEventListener("click", async () => {
    await ask("restore");
    await ask("translate");
    await refresh();
  });
  $("retry").addEventListener("click", async () => {
    $("retry").disabled = true;
    await ask("retry");
    await refresh();
    $("retry").disabled = false;
  });
  $("errDetail").addEventListener("click", () => {
    rawOpen = !rawOpen;
    renderError(lastState);
  });
  $("lang").addEventListener("change", async () => {
    await save({ targetLang: $("lang").value });
    await ask("rescan");
  });
  $("mode").addEventListener("change", () => save({ mode: $("mode").value }));

  $("siteBlacklist").addEventListener("change", async () => {
    const list = new Set(Array.isArray(settings.blacklist) ? settings.blacklist : []);
    if ($("siteBlacklist").checked) list.add(host);
    else list.delete(host);
    await save({ blacklist: [...list] });
    if ($("siteBlacklist").checked) {
      await ask("restore");
      await ask("stop");
      renderBlocked();
    } else {
      await refresh();
    }
  });

  $("siteAuto").addEventListener("change", async () => {
    const list = new Set(Array.isArray(settings.autoTranslateHosts) ? settings.autoTranslateHosts : []);
    if ($("siteAuto").checked) {
      list.add(host);
      await save({ autoTranslateHosts: [...list] });
      if (!lastState || lastState.status === "idle" || lastState.status === "paused") await ask("translate");
    } else {
      list.delete(host);
      await save({ autoTranslateHosts: [...list] });
    }
    await refresh();
  });

  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  if (host && hostMatchesBlacklist(host, settings.blacklist)) renderBlocked();

  await refresh();
  polling = setInterval(refresh, 600);
  window.addEventListener("unload", () => clearInterval(polling));
}

init();
