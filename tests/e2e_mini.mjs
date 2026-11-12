// 快速回归：小页面跑完整链路，验证翻译、跳过规则、还原、缓存与错误留痕。
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 8794;
const PAGE_URL = `http://127.0.0.1:${PORT}/mini_page.html`;
const SHOT_DIR = path.join(ROOT, "效果图");

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
fs.writeFileSync(
  path.join(ROOT, "src", "dev_config.json"),
  JSON.stringify({ _note: "快速回归生成", apiKey: env.GROQ_API_KEY }, null, 2) + "\n",
);
fs.rmSync(path.join(ROOT, ".mini_profile"), { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "通过" : "未通过"} | ${name} | ${detail}`);
}

const server = http.createServer((req, res) => {
  const name = req.url === "/" ? "mini_page.html" : path.basename(req.url);
  if (name === "favicon.ico") return res.writeHead(204).end();
  const file = path.join(ROOT, "tests", "fixtures", name);
  if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const proxy = env.HTTPS_PROXY || "";
const ctx = await chromium.launchPersistentContext(path.join(ROOT, ".mini_profile"), {
  headless: true,
  executablePath: chromium.executablePath(),
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
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

async function swEval(fn, arg) {
  for (let i = 0; i < 4; i++) {
    try {
      return await sw.evaluate(fn, arg);
    } catch (err) {
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 400));
      sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 5000 }));
    }
  }
}

async function send(cmd) {
  const tabId = await swEval(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || "").startsWith(u));
    return hit ? hit.id : null;
  }, `http://127.0.0.1:${PORT}`);
  return swEval(async ({ id, c }) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: c }), { id: tabId, c: cmd });
}

const snapshot = () =>
  page.evaluate(() => {
    const cjk = (t) => /[\u4e00-\u9fff]/.test(t || "");
    const paras = [...document.querySelectorAll(".para")];
    return {
      total: paras.length,
      translated: paras.filter((p) => cjk(p.textContent)).length,
      nav: cjk(document.querySelector("nav").textContent),
      code: document.querySelector("code").textContent,
      hidden: document.getElementById("hiddenMenu").textContent,
      first: document.getElementById("m1").textContent,
    };
  });

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
const t0 = Date.now();
await send("translate");
let done = null;
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(500);
  done = await snapshot();
  if (i % 20 === 19) console.log(`  等待中 ${(i + 1) / 2} 秒：已译 ${done.translated} / ${done.total}`);
  if (done.translated >= done.total) break;
}
const state = (await send("status")).state;
console.log(`迷你页：${done.translated} / ${done.total} 段译为中文，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
check("整页译完", done.translated >= done.total, `${done.translated} / ${done.total}`);
check("导航与页脚一并翻译", done.nav, `导航已译 ${done.nav}`);
check("代码块保持原样", /new Map/.test(done.code), done.code);
check("隐藏块保持原样", /Hidden menu/.test(done.hidden), done.hidden);
check("引擎记录真实用量", state.tokensIn > 0 && state.tokensOut > 0 && state.failed === 0, `输入 ${state.tokensIn}，输出 ${state.tokensOut}，失败 ${state.failed}，请求 ${state.requests} 次`);
check("错误留痕字段可用", Array.isArray(state.errors), `已有 ${state.errors.length} 条记录`);
await page.screenshot({ path: path.join(SHOT_DIR, "13-迷你页翻译.png") });

await page.evaluate(() => document.querySelector(".ez-ui-host").shadowRoot.querySelector(".toggle").click());
await page.waitForTimeout(300);
const restored = await snapshot();
check("一键还原原文", restored.translated === 0, `还原后中文段落 ${restored.translated}`);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const t1 = Date.now();
await send("translate");
let cached = null;
for (let i = 0; i < 200; i++) {
  await page.waitForTimeout(100);
  cached = await snapshot();
  if (cached.translated >= cached.total) break;
}
const cachedState = (await send("status")).state;
const cachedMs = Date.now() - t1;
console.log(`缓存复访：${cachedMs} 毫秒译完，缓存命中 ${cachedState.cached}`);
check("复访命中缓存", cached.translated >= cached.total && cachedState.cached > 0, `${cachedMs} 毫秒，命中 ${cachedState.cached} 段`);
check("页面无 JavaScript 报错", errors.length === 0, errors.slice(0, 2).join(" | ") || "无");

await ctx.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length} 项检查，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`失败项：${f.name} -> ${f.detail}`);
  process.exit(1);
}
