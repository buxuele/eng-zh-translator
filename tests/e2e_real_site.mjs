// 真实站点验证：在 MDN 英文文档页跑一遍，并直接用扩展弹窗界面点按钮，顺带截图弹窗与设置页。
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGET = process.env.TARGET_URL || "https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API";
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
  JSON.stringify({ _note: "端到端测试生成", apiKey: env.GROQ_API_KEY }, null, 2) + "\n",
);
fs.rmSync(path.join(ROOT, ".real_profile"), { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "通过" : "未通过"} | ${name} | ${detail}`);
}

const proxy = env.HTTPS_PROXY || "";
const ctx = await chromium.launchPersistentContext(path.join(ROOT, ".real_profile"), {
  headless: true,
  executablePath: chromium.executablePath(),
  viewport: { width: 1440, height: 900 },
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
console.log(`扩展标识 ${extId}，真实站点 ${TARGET}`);

const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup.html`);
await popup.waitForTimeout(600);
await popup.screenshot({ path: path.join(SHOT_DIR, "06-弹窗未开始.png") });
const keyState = await popup.textContent("#keyState");
check("弹窗读取到密钥状态", /密钥已配置/.test(keyState), keyState);

const options = await ctx.newPage();
await options.goto(`chrome-extension://${extId}/src/options.html`);
await options.waitForTimeout(1200);
await options.click("#test");
let testResult = "正在请求真实接口";
for (let i = 0; i < 60; i++) {
  await options.waitForTimeout(500);
  testResult = await options.textContent("#testResult");
  if (!testResult.includes("正在请求")) break;
}
check("设置页连接测试走真实接口", /成功，用时 \d+ 毫秒/.test(testResult), testResult.slice(0, 90));
await options.screenshot({ path: path.join(SHOT_DIR, "07-设置页.png"), fullPage: true });

await page.bringToFront();
const before = await page.evaluate(() => {
  const text = document.body.innerText;
  return { cjk: (text.match(/[\u4e00-\u9fff]/g) || []).length, codeBlocks: document.querySelectorAll("pre").length };
});
check("真实页面初始无中文", before.cjk === 0, `页面已有中文字符 ${before.cjk}`);

const t0 = Date.now();
await popup.bringToFront();
await popup.click("#primary");
await page.bringToFront();
let visible = 0;
let waiting = null;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const host = document.querySelector(".ez-ui-host");
    const sr = host && host.shadowRoot;
    const cjk = (document.body.innerText.match(/[\u4e00-\u9fff]/g) || []).length;
    return { cjk, label: sr ? sr.querySelector(".label").textContent : null, count: sr ? sr.querySelector(".count").textContent : null };
  });
  if (s.label && s.label.includes("限流")) waiting = s.label;
  visible = s.cjk;
  if (s.cjk > 400 || i === 89) {
    console.log(`第 ${i + 1} 秒：正文中文字符 ${s.cjk}，胶囊「${s.label} ${s.count}」`);
    break;
  }
}
check("真实页面出现译文", visible > 200, `正文中文字符 ${visible}`);
console.log(waiting ? `观察到限流提示：${waiting}` : "本次未触发限流");
check("真实页面无 JavaScript 报错", errors.length === 0, errors.slice(0, 2).join(" | ") || "无");
await page.screenshot({ path: path.join(SHOT_DIR, "08-真实站点翻译.png") });
await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(SHOT_DIR, "09-真实站点滚动补译.png") });

await popup.bringToFront();
await popup.reload();
await popup.waitForTimeout(800);
await popup.screenshot({ path: path.join(SHOT_DIR, "10-弹窗翻译中.png") });
const popupStats = await popup.evaluate(() => ({
  done: document.getElementById("sDone").textContent,
  queue: document.getElementById("sQueue").textContent,
  failed: document.getElementById("sFailed").textContent,
  cached: document.getElementById("sCached").textContent,
  chip: document.getElementById("chip").textContent,
  tip: document.getElementById("tip").textContent,
}));
console.log("弹窗实时数据：", JSON.stringify(popupStats));

await ctx.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length} 项检查，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`失败项：${f.name} -> ${f.detail}`);
  process.exit(1);
}
