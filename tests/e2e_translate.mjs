// 端到端验证：真实 Chrome 加载扩展，真实请求 Groq，验证滚动优先、流式写入、跳过规则、动态内容、缓存与还原。
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME_BIN || chromium.executablePath();
const PORT = Number(process.env.E2E_PORT || 8791);
const FIXTURE = process.env.E2E_FIXTURE || "sample_page.html";
const PAGE_URL = `http://127.0.0.1:${PORT}/${FIXTURE}`;
const SHOT_DIR = path.join(ROOT, "效果图");
const EXPECT = {
  "sample_page.html": { code: /new Groq/, hidden: /Secret menu/, firstPara: /Content scripts/ },
  "scroll_page.html": { code: /new Map/, hidden: /Hidden menu/, firstPara: /Content scripts/ },
  "mini_page.html": { code: /new Map/, hidden: /Hidden menu/, firstPara: /Chrome extensions/ },
};
const want = EXPECT[FIXTURE] || EXPECT["sample_page.html"];

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "通过" : "未通过"} | ${name} | ${detail}`);
}

fs.writeFileSync(
  path.join(ROOT, "src", "dev_config.json"),
  JSON.stringify({ _note: "端到端测试生成", apiKey: env.GROQ_API_KEY }, null, 2) + "\n",
);
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.rmSync(path.join(ROOT, process.env.E2E_PROFILE || ".e2e_profile"), { recursive: true, force: true });

const server = http.createServer((req, res) => {
  const name = req.url === "/" ? FIXTURE : path.basename(req.url);
  if (name === "favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const file = path.join(ROOT, "tests", "fixtures", name);
  if (!fs.existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const proxy = env.HTTPS_PROXY || "";
const ctx = await chromium.launchPersistentContext(path.join(ROOT, process.env.E2E_PROFILE || ".e2e_profile"), {
  headless: true,
  executablePath: CHROME,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=127.0.0.1;localhost"] : []),
  ],
});

const errors = [];
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
const extId = new URL(sw.url()).host;
console.log(`扩展标识 ${extId}`);
console.log(`浏览器 ${CHROME}`);

async function swEval(fn, arg) {
  for (let i = 0; i < 4; i++) {
    try {
      if (!sw || sw.isClosed?.()) sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 5000 }));
      return await sw.evaluate(fn, arg);
    } catch (err) {
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 400));
      sw = null;
    }
  }
}

async function send(cmd) {
  const tabId = await swEval(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || "").startsWith(u));
    return hit ? hit.id : null;
  }, `http://127.0.0.1:${PORT}`);
  if (tabId === null) throw new Error("找不到目标标签页");
  return swEval(async ({ id, c }) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: c }), { id: tabId, c: cmd });
}

const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

async function snapshot() {
  return page.evaluate(() => {
    const cjk = (t) => /[\u4e00-\u9fff]/.test(t || "");
    const paras = [...document.querySelectorAll(".para")];
    const host = document.querySelector(".ez-ui-host");
    const sr = host && host.shadowRoot;
    const stateHost = sr;
    return {
      total: paras.length,
      top20: paras.slice(0, 20).filter((p) => cjk(p.textContent)).length,
      all: paras.filter((p) => cjk(p.textContent)).length,
      bottom5: paras.slice(-5).filter((p) => cjk(p.textContent)).length,
      footer: cjk((document.getElementById("footerNote") || {}).textContent),
      nav: cjk(document.querySelector("nav").textContent),
      h1: cjk(document.querySelector("h1").textContent),
      code: document.querySelector("code").textContent,
      hidden: document.getElementById("hiddenMenu").textContent,
      noTranslate: document.getElementById("noTranslate") ? document.getElementById("noTranslate").textContent : null,
      dynamic: document.getElementById("dynamicOne")
        ? { translated: cjk(document.getElementById("dynamicOne").textContent), text: document.getElementById("dynamicOne").textContent.slice(0, 40) }
        : null,
      pill: stateHost
        ? {
            label: sr.querySelector(".label").textContent,
            count: sr.querySelector(".count").textContent,
            bar: sr.querySelector(".bar").style.width,
            toggle: sr.querySelector(".toggle").textContent,
          }
        : null,
      highlight: typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.has("ez-flash") : null,
      firstPara: (document.querySelector(".para") ? document.querySelector(".para").textContent : "").slice(0, 60),
    };
  });
}

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const before = await snapshot();
console.log(`初始状态：段落 ${before.total} 段，动态追加 ${before.dynamic ? "已出现" : "未出现"}`);
check("页面初始为英文", before.top20 === 0 && before.all === 0, `已译段落 ${before.all}`);

const t0 = Date.now();
await send("translate");
let firstVisibleMs = null;
let early = null;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(250);
  const s = await snapshot();
  if (i === 6) early = s;
  if (s.top20 > 0) {
    firstVisibleMs = Date.now() - t0;
    if (!early) early = s;
    break;
  }
}
early = early || (await snapshot());
console.log(`首个译文出现耗时 ${firstVisibleMs === null ? "超过 6 秒" : firstVisibleMs + " 毫秒"}`);
console.log(`视口采样：顶部 20 段已译 ${early.top20}，全页已译 ${early.all}，末尾 5 段已译 ${early.bottom5}`);
check("视口内先出译文", firstVisibleMs !== null && firstVisibleMs < 6000, `${firstVisibleMs} 毫秒`);
check("整页并未一次性翻完", early.bottom5 === 0, `末尾 5 段已译 ${early.bottom5} 段`);
check("进度胶囊显示真实计数", !!early.pill && /^\d+ \/ \d+/.test(early.pill.count), JSON.stringify(early.pill));
await page.screenshot({ path: path.join(SHOT_DIR, "01-滚动流式翻译中.png") });

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
const scrollAt = Date.now();
let bottomReady = 0;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const s = await snapshot();
  bottomReady = s.bottom5;
  if (s.bottom5 > 0) {
    console.log(`滚动到页尾后 ${Date.now() - scrollAt} 毫秒，末尾段落开始出译文`);
    await page.screenshot({ path: path.join(SHOT_DIR, "02-滚动到页尾补译.png") });
    break;
  }
}
check("滚动到页尾后该区域被优先翻译", bottomReady > 0, `末尾 5 段已译 ${bottomReady} 段`);

let done = null;
for (let i = 0; i < 240; i++) {
  done = await snapshot();
  if (done.all >= done.total) break;
  await page.waitForTimeout(1000);
}
console.log(`全页收尾：已译 ${done.all} / ${done.total}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
check("全页最终翻译完成", done.all >= done.total, `已译 ${done.all} / ${done.total}`);
let full = null;
for (let i = 0; i < 150; i++) {
  full = (await send("status")).state;
  if (full.done >= full.total && full.queue === 0) break;
  if (i % 15 === 14) console.log(`空闲补全等待中：已译 ${full.done} / ${full.total}，队列 ${full.queue}，失败 ${full.failed}，等待限流 ${Math.round((full.waitMs || 0) / 1000)} 秒`);
  await page.waitForTimeout(1000);
}
check("停止滚动后空闲补全剩余块", full.done >= full.total && full.queue === 0, `已译 ${full.done} / ${full.total}，队列 ${full.queue}`);
check("没有段落被静默丢弃", full.failed === 0, `失败 ${full.failed} 段`);
check("代码块保持原样", want.code.test(done.code), done.code.slice(0, 40));
check("隐藏菜单保持原样", want.hidden.test(done.hidden), done.hidden.slice(0, 30));
check("translate=no 区块保持原样", done.noTranslate === null || /Brand asset/.test(done.noTranslate), done.noTranslate === null ? "本页无该区块，跳过" : done.noTranslate.slice(0, 30));
check("导航与标题已翻译", done.nav && done.h1, `导航已译 ${done.nav}，标题已译 ${done.h1}`);
check("动态注入段落已翻译", !!done.dynamic && done.dynamic.translated, done.dynamic ? done.dynamic.text : "未出现");
await page.screenshot({ path: path.join(SHOT_DIR, "03-整页翻译完成.png") });

const state = await send("status");
console.log(`引擎状态：${JSON.stringify(state.state)}`);

await page.evaluate(() => {
  const host = document.querySelector(".ez-ui-host");
  host.shadowRoot.querySelector(".toggle").click();
});
await page.waitForTimeout(400);
const restored = await snapshot();
check("一键还原原文", want.firstPara.test(restored.firstPara), restored.firstPara);
await page.screenshot({ path: path.join(SHOT_DIR, "04-还原原文.png") });

await page.evaluate(() => {
  const host = document.querySelector(".ez-ui-host");
  host.shadowRoot.querySelector(".toggle").click();
});
await page.waitForTimeout(500);
const reapplied = await snapshot();
check("恢复译文即刻生效", /[\u4e00-\u9fff]/.test(reapplied.firstPara), reapplied.firstPara);

await page.reload({ waitUntil: "domcontentloaded" });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(700);
const cachedStart = Date.now();
await send("translate");
let cachedReady = 0;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(200);
  const s = await snapshot();
  cachedReady = s.top20;
  if (cachedReady >= 10) break;
}
const cachedMs = Date.now() - cachedStart;
const cachedState = (await send("status")).state;
console.log(`复访缓存命中：${cachedMs} 毫秒内顶部译出 ${cachedReady} 段，缓存命中数 ${cachedState.cached}`);
check("复访命中缓存并秒出译文", cachedReady >= 10 && cachedMs < 4000 && cachedState.cached > 0, `${cachedMs} 毫秒，顶部译出 ${cachedReady} 段，缓存命中 ${cachedState.cached}`);
await page.screenshot({ path: path.join(SHOT_DIR, "05-复访缓存秒出.png") });

check("页面无 JavaScript 报错", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");

await send("restore");
await ctx.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length} 项检查，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`失败项：${f.name} -> ${f.detail}`);
  process.exit(1);
}
