// 站点黑名单、错误分类与重试、缓存容量与过期、进度耗时的确定性回归，不消耗任何接口额度。
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE_PORT = 8798;
const MOCK_PORT = 8799;
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/scroll_page.html`;
const TTL_URL = `http://127.0.0.1:${PAGE_PORT}/ttl_page.html`;
const SHOT_DIR = path.join(ROOT, "效果图");
const TTL_TEXT = "Cache policy regression sentence.";
const TTL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>缓存过期用例</title></head>
<body><main><p id="ttl">${TTL_TEXT}</p></main></body></html>`;
const ARTICLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>正文范围用例</title></head>
<body><nav><a href="#">Home</a></nav><article><h1>Article heading</h1><p id="inner">Inside the article, this sentence should be translated by the reader.</p></article>
<footer><p id="outer">Outside the article, this footer sentence should stay in English.</p></footer></body></html>`;
const ZH_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>中文页面</title></head>
<body><main><p>这是一段已经完全由中文写成的页面内容，用来验证自动翻译会在中文页面直接跳过，不会发起接口请求。</p>
<p>第二段同样是中文，包含少量 English 单词也不应该触发整页翻译。</p></main></body></html>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "通过" : "未通过"} | ${name} | ${detail}`);
}

// 与 src/shared/config.js 的 cacheKeyFor 保持一致，用来预置过期缓存。
function cacheKeyFor(text, lang, model) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `v1|${lang}|${model}|${h.toString(36)}|${text.length}`;
}

const mock = { mode: "ok", requests: 0, log: [] };
const mockServer = http.createServer((req, res) => {
  if (req.url.startsWith("/stats")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mock));
    return;
  }
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    mock.requests++;
    mock.log.push({ mode: mock.mode, at: Date.now() });
    if (mock.mode === "drop") {
      req.socket.destroy();
      return;
    }
    if (mock.mode === "401") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API Key" } }));
      return;
    }
    if (mock.mode === "429") {
      res
        .writeHead(429, { "content-type": "application/json", "retry-after": "60s" })
        .end(JSON.stringify({ error: { message: "Rate limit reached for model, please try again in 60s" } }));
      return;
    }
    if (mock.mode === "500") {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "internal error" } }));
      return;
    }
    let segments = [];
    try {
      const payload = JSON.parse(body);
      const user = payload.messages.find((m) => m.role === "user").content;
      segments = user.split("\n").filter(Boolean).map((line) => {
        const tab = line.indexOf("\t");
        return { i: Number(line.slice(0, tab)), text: line.slice(tab + 1) };
      });
    } catch {
      segments = [];
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-ratelimit-limit-tokens": "8000",
      "x-ratelimit-remaining-tokens": "7000",
      "x-ratelimit-reset-tokens": "3s",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ id: "guard", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (const seg of segments) {
      send({ id: "guard", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: JSON.stringify({ i: seg.i, t: `译${seg.i}：${seg.text.slice(0, 12)}` }) }, finish_reason: null }] });
      await new Promise((r) => setTimeout(r, 15));
    }
    send({
      id: "guard",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100 + segments.length * 10, completion_tokens: segments.length * 20 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

const pageServer = http.createServer((req, res) => {
  const name = req.url === "/" ? "scroll_page.html" : path.basename(req.url);
  if (name === "favicon.ico") return res.writeHead(204).end();
  if (name === "ttl_page.html") {
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(TTL_HTML);
  }
  if (name === "article_page.html") {
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE_HTML);
  }
  if (name === "zh_page.html") {
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ZH_HTML);
  }
  const file = path.join(ROOT, "tests", "fixtures", name);
  if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});

await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
fs.mkdirSync(SHOT_DIR, { recursive: true });

async function launch(profile, options = {}) {
  const dir = path.join(ROOT, profile);
  if (options.clean !== false) fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    executablePath: chromium.executablePath(),
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--no-first-run", "--no-default-browser-check"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  return { ctx, sw, extId: new URL(sw.url()).host };
}

function swEvalFactory(session) {
  return async (fn, arg) => {
    for (let i = 0; i < 4; i++) {
      try {
        return await session.sw.evaluate(fn, arg);
      } catch (err) {
        if (i === 3) throw err;
        await new Promise((r) => setTimeout(r, 400));
        session.sw = session.ctx.serviceWorkers()[0] || (await session.ctx.waitForEvent("serviceworker", { timeout: 5000 }));
      }
    }
  };
}

const errors = [];
function watch(page, label) {
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(`${label} console: ${m.text()}`);
  });
}

async function waitFor(fn, timeout = 20000, interval = 200) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

const session = await launch(".guards_profile");
const { ctx, extId } = session;
const swEval = swEvalFactory(session);

async function send(cmd, url = PAGE_URL) {
  const tabId = await swEval(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || "").startsWith(u));
    return hit ? hit.id : null;
  }, url);
  if (tabId === null) throw new Error(`找不到标签页 ${url}`);
  return swEval(async ({ id, c }) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: c }), { id: tabId, c: cmd });
}

async function setSettings(patch) {
  await swEval(async (p) => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(stored.settings || {}), ...p } });
  }, patch);
  await new Promise((r) => setTimeout(r, 300));
}

const control = await ctx.newPage();
await control.goto(`chrome-extension://${extId}/src/options.html`);
await control.waitForTimeout(600);
async function extMessage(msg) {
  return control.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

const page = ctx.pages().find((p) => p.url().startsWith("http")) || (await ctx.newPage());
watch(page, "页面");
await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(700);

async function openPopup() {
  await page.bringToFront();
  const p = await ctx.newPage();
  watch(p, "弹窗");
  await p.goto(`chrome-extension://${extId}/src/popup.html`);
  await p.waitForTimeout(900);
  return p;
}

const snapshot = () =>
  page.evaluate(() => ({
    markers: (document.body.textContent.match(/译\d+：/g) || []).length,
    overlays: document.querySelectorAll("[data-ez]").length,
  }));

await setSettings({
  apiKey: "mock-key",
  baseUrl: `http://127.0.0.1:${MOCK_PORT}/openai/v1`,
  model: "mock-model",
  targetLang: "简体中文",
  mode: "full",
  idleFill: "on",
  batchSegments: 8,
  batchChars: 600,
  concurrency: 2,
  prefetchScreens: 1,
  blacklist: ["127.0.0.1"],
  cacheLimit: 5,
  cacheMaxMB: 4,
  cacheTtlDays: 30,
});

console.log("用例一：站点黑名单");
await send("translate");
await page.waitForTimeout(500);
let st = (await send("status")).state;
let view = await snapshot();
check("命中黑名单时引擎标记为免译", st.blocked === true && st.status === "blocked", `blocked=${st.blocked} status=${st.status}`);
check("命中黑名单时不扫描也不翻译", st.total === 0 && view.markers === 0, `total=${st.total}，页面标记 ${view.markers}`);
check("命中黑名单时不发送任何接口请求", mock.requests === 0, `接口请求 ${mock.requests} 次`);
check("免译提示来自真实状态且页面无浮层", /免翻译名单/.test(st.error || "") && view.overlays === 0, `提示「${(st.error || "").slice(0, 20)}」，浮层 ${view.overlays} 个`);
await page.screenshot({ path: path.join(SHOT_DIR, "16-免译站点提示.png") });

const popup = await openPopup();
const blockedPopup = {
  chip: await popup.textContent("#chip"),
  primary: await popup.textContent("#primary"),
  disabled: await popup.$eval("#primary", (el) => el.disabled),
  box: await popup.$eval("#errorBox", (el) => el.classList.contains("show")),
};
check("弹窗显示免译站点并禁用翻译按钮", /免译站点/.test(blockedPopup.chip) && blockedPopup.disabled, JSON.stringify(blockedPopup));
await popup.close();

console.log("用例二：正常翻译与进度耗时");
await setSettings({ blacklist: [] });
await send("translate");
const finished = await waitFor(async () => {
  const now = (await send("status")).state;
  return now.status === "done" && now.done >= now.total && now.queue === 0 ? now : null;
}, 30000, 300);
check("整页翻译完成", !!finished && finished.done > 0, finished ? `已译 ${finished.done} / ${finished.total}，失败 ${finished.failed}` : "超时未完成");
check("完成状态带真实耗时", !!finished && finished.durationMs > 0, `耗时 ${finished ? finished.durationMs : 0} 毫秒`);
view = await snapshot();
check("翻译后页面没有常驻浮层", view.overlays === 0, `浮层 ${view.overlays} 个`);
await page.waitForTimeout(700);
const badge = await swEval(async (u) => {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => (t.url || "").startsWith(u));
  return hit ? chrome.action.getBadgeText({ tabId: hit.id }) : "";
}, PAGE_URL);
check("工具栏角标在完成后显示完成", badge === "完成", `角标文字「${badge}」`);

const donePopupPage = await openPopup();
const donePopup = { chip: await donePopupPage.textContent("#chip"), tip: await donePopupPage.textContent("#tip") };
check("弹窗完成态显示段数与耗时", /已完成/.test(donePopup.chip) && /用时/.test(donePopup.tip), `${donePopup.chip}｜${donePopup.tip.slice(0, 60)}`);
await donePopupPage.close();

console.log("用例三：缓存容量与占用统计");
const immediateStats = await extMessage({ t: "STATS" });
check("缓存写入后立即受条数上限约束", !!immediateStats && immediateStats.ok && immediateStats.cacheEntries <= 5, `条数 ${immediateStats && immediateStats.cacheEntries}，上限 ${immediateStats && immediateStats.cacheLimit}`);
await new Promise((r) => setTimeout(r, 4000));
const cacheStats = await extMessage({ t: "STATS" });
check("缓存条数不超过设定上限", !!cacheStats && cacheStats.ok && cacheStats.cacheEntries <= 5, `条数 ${cacheStats && cacheStats.cacheEntries}，上限 ${cacheStats && cacheStats.cacheLimit}`);
check("缓存占用估算可读且非零", !!cacheStats && cacheStats.cacheBytes > 0, `占用 ${cacheStats && cacheStats.cacheBytes} 字节`);
const storedCacheKeys = await swEval(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith("t|")).length;
});
check("存储里的缓存键同样受上限约束", storedCacheKeys <= 5, `存储键 ${storedCacheKeys} 个`);

console.log("用例四：错误分类与重试");
const freshPage = async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
};

await extMessage({ t: "CLEAR_CACHE" });
mock.mode = "401";
await freshPage();
await send("translate");
st = await waitFor(async () => {
  const now = (await send("status")).state;
  return now.errorCode ? now : null;
}, 8000, 200);
check("密钥错误被单独识别", !!st && st.errorCode === "auth" && /密钥/.test(st.error || "") && st.retryable === false, st ? `${st.errorCode}｜${st.error}｜retryable=${st.retryable}` : "未捕获");

await page.bringToFront();
const authPopupPage = await openPopup();
const authPopup = {
  text: await authPopupPage.textContent("#errorText"),
  retryVisible: await authPopupPage.$eval("#retry", (el) => !el.classList.contains("hidden")),
};
check("弹窗显示可读的密钥错误", /密钥/.test(authPopup.text), authPopup.text);
check("不可重试的错误不显示重试按钮", authPopup.retryVisible === false, `重试按钮可见=${authPopup.retryVisible}`);
await authPopupPage.close();

await extMessage({ t: "CLEAR_CACHE" });
mock.mode = "drop";
await freshPage();
await send("translate");
st = await waitFor(async () => {
  const now = (await send("status")).state;
  return now.errorCode === "network" ? now : null;
}, 15000, 300);
check("网络错误被单独识别并允许重试", !!st && st.errorCode === "network" && /网络/.test(st.error || "") && st.retryable === true, st ? `${st.errorCode}｜${st.error}｜retryable=${st.retryable}` : "未捕获");

await page.bringToFront();
const netPopupPage = await openPopup();
const netPopup = {
  text: await netPopupPage.textContent("#errorText"),
  retryVisible: await netPopupPage.$eval("#retry", (el) => !el.classList.contains("hidden")),
};
check("弹窗为网络错误提供重试按钮", /网络/.test(netPopup.text) && netPopup.retryVisible, `${netPopup.text}｜重试按钮可见=${netPopup.retryVisible}`);
await netPopupPage.screenshot({ path: path.join(SHOT_DIR, "21-错误重试.png") });

mock.mode = "ok";
const beforeRetry = mock.requests;
await netPopupPage.click("#retry");
st = await waitFor(async () => {
  const now = (await send("status")).state;
  return now.status === "done" && now.done >= now.total && !now.error ? now : null;
}, 25000, 300);
check("弹窗重试后继续翻译并完成", !!st && st.done >= st.total, st ? `已译 ${st.done} / ${st.total}，失败 ${st.failed}` : "重试后未完成");
check("重试没有重复累计已译段数", !!st && st.done === st.total && st.failed === 0, st ? `已译 ${st.done} / ${st.total}，失败 ${st.failed}` : "重试后未完成");
check("重试确实重新发起了接口请求", mock.requests > beforeRetry, `重试前 ${beforeRetry} 次，重试后 ${mock.requests} 次`);
await netPopupPage.close();

await extMessage({ t: "CLEAR_CACHE" });
mock.mode = "429";
await freshPage();
await send("translate");
st = await waitFor(async () => {
  const now = (await send("status")).state;
  return now.errorCode === "rate" ? now : null;
}, 15000, 200);
check("限流错误被单独识别并带等待时长", !!st && st.errorCode === "rate" && /限流|额度/.test(st.error || "") && st.retryable === true, st ? `${st.errorCode}｜${st.error}｜retryable=${st.retryable}` : "未捕获");
mock.mode = "ok";
await send("retry");
st = await waitFor(async () => {
  const now = (await send("status")).state;
  return now.status === "done" && now.done >= now.total && !now.error ? now : null;
}, 25000, 300);
check("限流后重试可以恢复", !!st && st.done >= st.total, st ? `已译 ${st.done} / ${st.total}` : "未恢复");
check("限流重试后统计仍然准确", !!st && st.done === st.total && st.failed === 0, st ? `已译 ${st.done} / ${st.total}，失败 ${st.failed}` : "未恢复");
check("页面无 JavaScript 报错", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

console.log("用例七：界面规范与新增能力");

await page.bringToFront();
const uiPopup = await openPopup();
const popupFonts = await uiPopup.evaluate(() => ({
  body: parseFloat(getComputedStyle(document.body).fontSize),
  h1: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
  chip: parseFloat(getComputedStyle(document.getElementById("chip")).fontSize),
  tip: parseFloat(getComputedStyle(document.getElementById("tip")).fontSize),
  button: parseFloat(getComputedStyle(document.getElementById("primary")).fontSize),
}));
check(
  "弹窗字号符合规范",
  popupFonts.body >= 16 && popupFonts.h1 >= 18 && popupFonts.chip >= 14 && popupFonts.tip >= 14 && popupFonts.button >= 16,
  JSON.stringify(popupFonts),
);
const popupStats = await uiPopup.evaluate(() => document.querySelectorAll(".stat").length);
check("弹窗统计改为两列四格", popupStats === 4, `统计格 ${popupStats} 个`);
await uiPopup.screenshot({ path: path.join(SHOT_DIR, "17-弹窗新版.png") });
await uiPopup.close();

const optionFonts = await control.evaluate(() => ({
  body: parseFloat(getComputedStyle(document.body).fontSize),
  h1: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
  h2: parseFloat(getComputedStyle(document.querySelector("h2")).fontSize),
  result: parseFloat(getComputedStyle(document.querySelector(".result")).fontSize),
}));
check("设置页字号符合规范", optionFonts.body >= 16 && optionFonts.h1 >= 18 && optionFonts.h2 >= 18 && optionFonts.result >= 14, JSON.stringify(optionFonts));
await control.screenshot({ path: path.join(SHOT_DIR, "18-设置页新版.png"), fullPage: true });

const requestsBeforeSelect = mock.requests;
await page.evaluate(() => {
  const target = [...document.querySelectorAll(".para")].find((el) => /译\d+：/.test(el.textContent));
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
await page.waitForTimeout(500);
const selectResult = await page.evaluate(() => ({
  overlays: document.querySelectorAll("[data-ez]").length,
  selection: String(window.getSelection()),
}));
check("选中文本不再弹出翻译按钮", selectResult.overlays === 0, `浮层 ${selectResult.overlays} 个`);
check("选中文本不会发起接口请求", mock.requests === requestsBeforeSelect, `新增请求 ${mock.requests - requestsBeforeSelect} 次`);

await page.evaluate(() => {
  const target = [...document.querySelectorAll(".para")].find((el) => /译\d+：/.test(el.textContent));
  target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
});
await page.waitForTimeout(700);
const tipInfo = await page.evaluate(() => {
  const host = document.querySelector("[data-ez]");
  const tip = host && host.shadowRoot.querySelector(".tip");
  return { show: !!tip, text: tip ? tip.textContent.slice(0, 40) : "" };
});
check("悬停译文显示原句", tipInfo.show && /原文/.test(tipInfo.text), JSON.stringify(tipInfo));
await page.evaluate(() => {
  document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
});
await page.waitForTimeout(300);
const tipGone = await page.evaluate(() => document.querySelectorAll("[data-ez]").length);
check("移开鼠标后浮层立即移除", tipGone === 0, `浮层 ${tipGone} 个`);
await page.screenshot({ path: path.join(SHOT_DIR, "19-悬停原文.png") });

const autoPage = await ctx.newPage();
watch(autoPage, "白名单页");
await setSettings({ autoTranslateHosts: ["127.0.0.1"], scope: "all" });
await autoPage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
const autoDone = await waitFor(async () => {
  const state = await send("status", PAGE_URL).catch(() => null);
  if (!state || !state.state) return null;
  return state.state.done > 0 ? state.state : null;
}, 12000, 300);
check("白名单站点进站自动翻译", !!autoDone, autoDone ? `自动已译 ${autoDone.done} 段` : "未自动开始");
await autoPage.close();

const articlePage = await ctx.newPage();
watch(articlePage, "正文范围页");
await setSettings({ autoTranslateHosts: [], scope: "article", blacklist: [] });
await articlePage.goto(`http://127.0.0.1:${PAGE_PORT}/article_page.html`, { waitUntil: "domcontentloaded" });
await articlePage.waitForTimeout(500);
await send("translate", `http://127.0.0.1:${PAGE_PORT}/article_page.html`);
await articlePage.waitForTimeout(1500);
const articleView = await articlePage.evaluate(() => ({
  inner: document.getElementById("inner").textContent,
  outer: document.getElementById("outer").textContent,
}));
check("仅正文范围只译正文", /译\d+：/.test(articleView.inner) && !/译\d+：/.test(articleView.outer), `正文「${articleView.inner.slice(0, 24)}」，页脚「${articleView.outer.slice(0, 24)}」`);

mock.mode = "401";
await extMessage({ t: "CLEAR_CACHE" });
await articlePage.reload({ waitUntil: "domcontentloaded" });
await articlePage.waitForTimeout(600);
await send("translate", `http://127.0.0.1:${PAGE_PORT}/article_page.html`);
const authState = await waitFor(async () => {
  const now = await send("status", `http://127.0.0.1:${PAGE_PORT}/article_page.html`);
  return now && now.state && now.state.error ? now.state : null;
}, 8000, 300);
await articlePage.bringToFront();
const errorPopup = await ctx.newPage();
watch(errorPopup, "错误详情弹窗");
await errorPopup.goto(`chrome-extension://${extId}/src/popup.html`);
await errorPopup.waitForTimeout(900);
const errorBox = await errorPopup.evaluate(() => ({
  title: document.getElementById("errorTitle").textContent,
  text: document.getElementById("errorText").textContent,
  raw: document.getElementById("errorRaw").textContent,
  detailHidden: document.getElementById("errDetail").classList.contains("hidden"),
}));
check("错误块显示标题与可读文案", !!(authState && authState.error) && !!errorBox.title && /密钥/.test(errorBox.text), `${errorBox.title}｜${errorBox.text.slice(0, 24)}｜状态=${authState ? authState.errorCode : "无"}`);
check("错误块提供接口原文详情", !errorBox.detailHidden && /Invalid API Key/.test(errorBox.raw), errorBox.raw.slice(0, 40));
await errorPopup.click("#errDetail");
const rawShown = await errorPopup.evaluate(() => !document.getElementById("errorRaw").classList.contains("hidden"));
check("点详情可以展开接口原文", rawShown, `展开 ${rawShown}`);
await errorPopup.screenshot({ path: path.join(SHOT_DIR, "20-错误详情.png") });
await errorPopup.close();
mock.mode = "ok";
await articlePage.close();

const zhPage = await ctx.newPage();
watch(zhPage, "中文页");
await setSettings({ autoTranslateHosts: ["127.0.0.1"], scope: "all" });
const zhUrl = `http://127.0.0.1:${PAGE_PORT}/zh_page.html`;
await zhPage.goto(zhUrl, { waitUntil: "domcontentloaded" });
await zhPage.waitForTimeout(1400);
const zhState = await send("status", zhUrl).catch(() => null);
const requestsOnZh = mock.requests;
await zhPage.waitForTimeout(800);
check("中文页面自动跳过翻译", !!zhState && zhState.state.status === "skipped", zhState ? `状态 ${zhState.state.status}` : "无状态");
check("跳过时没有发起接口请求", mock.requests === requestsOnZh, `新增请求 ${mock.requests - requestsOnZh} 次`);
await zhPage.close();
await setSettings({ autoTranslateHosts: [], scope: "all" });

await ctx.close();

console.log("用例五：缓存过期");
const ttlSession = await launch(".guards_ttl_profile");
const ttlSwEval = swEvalFactory(ttlSession);
const seedKey = `t|${cacheKeyFor(TTL_TEXT, "简体中文", "mock-model")}`;
await ttlSwEval(async ({ baseUrl, key }) => {
  const stored = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...(stored.settings || {}),
      apiKey: "mock-key",
      baseUrl,
      model: "mock-model",
      targetLang: "简体中文",
      mode: "full",
      batchSegments: 8,
      batchChars: 600,
      blacklist: [],
      cacheTtlDays: 30,
      cacheLimit: 100,
    },
  });
  // 直接预置一条 40 天前的缓存，模拟过期数据。
  await chrome.storage.local.set({ [key]: { t: "旧译文", at: Date.now() - 40 * 86400000 } });
}, { baseUrl: `http://127.0.0.1:${MOCK_PORT}/openai/v1`, key: seedKey });

const ttlPage = ttlSession.ctx.pages().find((p) => p.url().startsWith("http")) || (await ttlSession.ctx.newPage());
watch(ttlPage, "过期页");
await ttlPage.goto(TTL_URL, { waitUntil: "domcontentloaded" });
await ttlPage.waitForTimeout(600);
const ttlTabId = await ttlSwEval(async (u) => {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => (t.url || "").startsWith(u));
  return hit ? hit.id : null;
}, TTL_URL);
const beforeTtl = mock.requests;
await ttlSwEval(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "translate" }), ttlTabId);
const ttlDone = await waitFor(async () => {
  const state = await ttlSwEval(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "status" }), ttlTabId);
  return state && state.state && state.state.done > 0 ? state.state : null;
}, 15000, 300);
const ttlText = await ttlPage.textContent("#ttl");
check("过期缓存未被使用，重新请求接口", mock.requests > beforeTtl, `新增请求 ${mock.requests - beforeTtl} 次`);
check("过期条目已被清理", !!ttlDone && ttlDone.cached === 0 && ttlDone.errorCode !== "blocked", ttlDone ? `缓存命中 ${ttlDone.cached}，已译 ${ttlDone.done}` : "未完成");
check("页面写入的是新译文而不是旧缓存", ttlText !== "旧译文" && /译0：/.test(ttlText), `页面文本「${ttlText}」`);

const ttlOptions = await ttlSession.ctx.newPage();
await ttlOptions.goto(`chrome-extension://${ttlSession.extId}/src/options.html`);
await ttlOptions.waitForTimeout(800);
const ttlStats = await ttlOptions.evaluate(() => chrome.runtime.sendMessage({ t: "STATS" }));
const ttlCacheText = await ttlOptions.textContent("#cacheCount");
check("设置页显示条数与占用估算", /条/.test(ttlCacheText) && /KB|MB|字节/.test(ttlCacheText), ttlCacheText);
check("设置页显示条数上限与过期策略", /上限 100 条/.test(ttlCacheText) && /30 天过期/.test(ttlCacheText), ttlCacheText);
check("启动时统计到过期清理", !!ttlStats && ttlStats.cacheExpired >= 1, `过期清理 ${ttlStats && ttlStats.cacheExpired} 条，当前 ${ttlStats && ttlStats.cacheEntries} 条`);
await ttlOptions.screenshot({ path: path.join(SHOT_DIR, "22-缓存治理.png"), fullPage: true });

await ttlSession.ctx.close();

console.log("用例六：缓存跨浏览器重启持久化");
const persistSession = await launch(".guards_persist_profile");
const persistSwEval = swEvalFactory(persistSession);
await persistSwEval(async (baseUrl) => {
  const stored = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...(stored.settings || {}),
      apiKey: "mock-key",
      baseUrl,
      model: "mock-model",
      targetLang: "简体中文",
      mode: "full",
      batchSegments: 8,
      batchChars: 600,
      blacklist: [],
      cacheTtlDays: 30,
      cacheLimit: 100,
    },
  });
}, `http://127.0.0.1:${MOCK_PORT}/openai/v1`);
await new Promise((r) => setTimeout(r, 300));
const persistPageA = persistSession.ctx.pages().find((p) => p.url().startsWith("http")) || (await persistSession.ctx.newPage());
watch(persistPageA, "持久化页");
await persistPageA.goto(TTL_URL, { waitUntil: "domcontentloaded" });
await persistPageA.waitForTimeout(600);
const persistTabA = await persistSwEval(async (u) => {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => (t.url || "").startsWith(u));
  return hit ? hit.id : null;
}, TTL_URL);
await persistSwEval(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "translate" }), persistTabA);
const firstDone = await waitFor(async () => {
  const state = await persistSwEval(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "status" }), persistTabA);
  return state && state.state && state.state.done > 0 ? state.state : null;
}, 15000, 300);
await new Promise((r) => setTimeout(r, 4000));
const entriesBefore = await persistSwEval(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith("t|")).length;
});
check("首轮翻译写入带前缀的缓存键", !!firstDone && entriesBefore >= 1, `缓存键 ${entriesBefore} 个`);
await persistSession.ctx.close();

const persistSessionB = await launch(".guards_persist_profile", { clean: false });
const persistSwEvalB = swEvalFactory(persistSessionB);
const storedBSettings = await persistSwEvalB(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  return settings;
});
console.log(`重启后设置：${JSON.stringify({ baseUrl: storedBSettings && storedBSettings.baseUrl, model: storedBSettings && storedBSettings.model, targetLang: storedBSettings && storedBSettings.targetLang })}`);
const persistPageB = persistSessionB.ctx.pages().find((p) => p.url().startsWith("http")) || (await persistSessionB.ctx.newPage());
watch(persistPageB, "重启持久化页");
await persistPageB.goto(TTL_URL, { waitUntil: "domcontentloaded" });
await persistPageB.waitForTimeout(700);
const persistTabB = await persistSwEvalB(async (u) => {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => (t.url || "").startsWith(u));
  return hit ? hit.id : null;
}, TTL_URL);
const requestsBeforeRevisit = mock.requests;
await persistSwEvalB(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "translate" }), persistTabB);
const cachedAfterRestart = await waitFor(async () => {
  const state = await persistSwEvalB(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "status" }), persistTabB);
  return state && state.state && state.state.done > 0 ? state.state : null;
}, 15000, 300);
if (!cachedAfterRestart) {
  const diag = await persistSwEvalB(async (id) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: "status" }), persistTabB);
  console.log(`重启后状态：${JSON.stringify(diag && diag.state)}，页面文本「${await persistPageB.textContent("#ttl")}」`);
}
console.log(`重启后命中：${JSON.stringify(cachedAfterRestart)}，页面文本「${await persistPageB.textContent("#ttl")}」`);
check("浏览器重启后缓存仍能命中", !!cachedAfterRestart && cachedAfterRestart.cached > 0, cachedAfterRestart ? `缓存命中 ${cachedAfterRestart.cached} 段` : "未命中");
check("跨会话命中缓存不发接口请求", mock.requests === requestsBeforeRevisit, `新增请求 ${mock.requests - requestsBeforeRevisit} 次`);
await persistSessionB.ctx.close();

mockServer.close();
pageServer.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length} 项检查，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`失败项：${f.name} -> ${f.detail}`);
  process.exit(1);
}
