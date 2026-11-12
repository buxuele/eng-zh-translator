// 限流与压力验证：300 段的大页面，模式设为整页立即，观察真实限流提示、恢复能力与扫描耗时。
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 8793;
const PAGE_URL = `http://127.0.0.1:${PORT}/big_page.html`;
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
  JSON.stringify({ _note: "限流测试生成", apiKey: env.GROQ_API_KEY }, null, 2) + "\n",
);
fs.rmSync(path.join(ROOT, ".throttle_profile"), { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "通过" : "未通过"} | ${name} | ${detail}`);
}

const server = http.createServer((req, res) => {
  const name = req.url === "/" ? "big_page.html" : path.basename(req.url);
  if (name === "favicon.ico") return res.writeHead(204).end();
  const file = path.join(ROOT, "tests", "fixtures", name);
  if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const proxy = env.HTTPS_PROXY || "";
const ctx = await chromium.launchPersistentContext(path.join(ROOT, ".throttle_profile"), {
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
  if (tabId === null) throw new Error("找不到目标标签页");
  return swEval(async ({ id, c }) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: c }), { id: tabId, c: cmd });
}

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);

await swEval(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, mode: "full", batchSegments: 12, batchChars: 1200, concurrency: 2 } });
});

const t0 = Date.now();
await send("translate");
let scanMs = null;
let sawThrottle = false;
let doneAtThrottle = null;
let resumeAt = null;
let resumed = false;
let maxDone = 0;
let last = null;
const samples = [];

for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const host = document.querySelector(".ez-ui-host");
    const sr = host && host.shadowRoot;
    return {
      label: sr ? sr.querySelector(".label").textContent : null,
      count: sr ? sr.querySelector(".count").textContent : null,
    };
  });
  const st = (await send("status")).state;
  if (scanMs === null && !st.collecting) scanMs = Date.now() - t0;
  if (s.label && s.label.includes("限流")) {
    if (!sawThrottle) {
      sawThrottle = true;
      doneAtThrottle = st.done;
      console.log(`第 ${i + 1} 秒出现限流等待：胶囊「${s.label} ${s.count}」，此刻已译 ${st.done} 段`);
      await page.screenshot({ path: path.join(SHOT_DIR, "11-限流等待.png") });
    }
  } else if (sawThrottle && !resumed && st.done > doneAtThrottle) {
    resumed = true;
    resumeAt = i + 1;
    console.log(`第 ${i + 1} 秒限流结束并继续推进，已译 ${st.done} 段`);
  }
  if (samples.length < 40 && (i + 1) % 20 === 0) samples.push(`第 ${i + 1} 秒 已译 ${st.done} / ${st.total} 队列 ${st.queue} 胶囊「${s.label} ${s.count}」`);
  maxDone = Math.max(maxDone, st.done);
  last = { ...st, label: s.label, count: s.count };
  if (st.done >= st.total && st.queue === 0) break;
}

const elapsed = (Date.now() - t0) / 1000;
for (const s of samples) console.log(s);
console.log(`扫描完成耗时 ${scanMs} 毫秒，总耗时 ${elapsed.toFixed(1)} 秒`);
console.log(
  `用量统计：请求 ${last.requests} 次，输入 ${last.tokensIn} tokens，输出 ${last.tokensOut} tokens，` +
    `每段平均 ${((last.tokensIn + last.tokensOut) / Math.max(1, last.done)).toFixed(0)} tokens`,
);
const quotaError = (last.errors || []).find((e) => e.code === "rate") || null;
const waitedSec = Math.round((last.waitedMs || 0) / 1000);
console.log(`等待统计：本次会话累计等待 ${waitedSec} 秒，结束时剩余等待 ${Math.round((last.waitMs || 0) / 1000)} 秒`);
check("大页面扫描可完成", scanMs !== null && scanMs < 8000, `${scanMs} 毫秒`);
check("额度受限时给出真实倒计时", !quotaError || sawThrottle || last.waitMs > 0, quotaError ? `胶囊提示 ${sawThrottle ? "已出现" : "未出现"}，剩余等待 ${Math.round((last.waitMs || 0) / 1000)} 秒` : "本次未触发额度限制");
check("额度受限不丢内容", last.failed === 0, `失败 ${last.failed} 段，待处理 ${last.queue} 段`);
check("大页面无 JavaScript 报错", errors.length === 0, errors.slice(0, 2).join(" | ") || "无");
check("队列推进速度可用", maxDone >= 40, `观察窗口内已译 ${maxDone} 段`);
if (quotaError) console.log("额度限制原文：" + quotaError.message);
if (last.errors && last.errors.length > 1) console.log("错误留痕：" + JSON.stringify(last.errors.map((e) => e.code)));
console.log(`引擎最终状态 ${JSON.stringify({ ...last, errors: (last.errors || []).map((e) => e.code) })}`);
await page.screenshot({ path: path.join(SHOT_DIR, "12-大页面翻译完成.png") });

await ctx.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length} 项检查，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`失败项：${f.name} -> ${f.detail}`);
  process.exit(1);
}
