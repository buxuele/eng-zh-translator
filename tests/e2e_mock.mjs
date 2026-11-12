// 确定性回归：不消耗任何接口额度，用本地假接口验证流式写入、保序、去重、跳过规则、还原与缓存。
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createMockGroq } from "./mock_groq.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE_PORT = 8796;
const MOCK_PORT = 8797;
const FIXTURE = "scroll_page.html";
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/${FIXTURE}`;
const SHOT_DIR = path.join(ROOT, "效果图");

fs.rmSync(path.join(ROOT, ".mock_profile"), { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "通过" : "未通过"} | ${name} | ${detail}`);
}

const mock = createMockGroq({ delayMs: 160, reasoningDelayMs: 80 });
await mock.listen(MOCK_PORT);

const pageServer = http.createServer((req, res) => {
  const name = req.url === "/" ? FIXTURE : path.basename(req.url);
  if (name === "favicon.ico") return res.writeHead(204).end();
  const file = path.join(ROOT, "tests", "fixtures", name);
  if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));

const ctx = await chromium.launchPersistentContext(path.join(ROOT, ".mock_profile"), {
  headless: true,
  executablePath: chromium.executablePath(),
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--no-first-run", "--no-default-browser-check"],
});

const errors = [];
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));

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

const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
});

await swEval(
  async ({ baseUrl }) => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: {
        ...(stored.settings || {}),
        apiKey: "mock-key",
        baseUrl,
        model: "mock-model",
        mode: "scroll",
        batchSegments: 8,
        batchChars: 600,
        concurrency: 2,
        idleFill: "on",
        prefetchScreens: 1,
      },
    });
  },
  { baseUrl: mock.baseUrl(MOCK_PORT) },
);

async function send(cmd, prefix = `http://127.0.0.1:${PAGE_PORT}`) {
  const tabId = await swEval(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || "").startsWith(u));
    return hit ? hit.id : null;
  }, prefix);
  return swEval(async ({ id, c }) => chrome.tabs.sendMessage(id, { t: "CMD", cmd: c }), { id: tabId, c: cmd });
}

const snapshot = () =>
  page.evaluate(() => {
    const markers = (document.body.textContent.match(/译\d+：/g) || []).length;
    const paras = [...document.querySelectorAll(".para")];
    const translatedParas = paras.filter((p) => /译\d+：/.test(p.textContent)).length;
    const host = document.querySelector(".ez-ui-host");
    const sr = host && host.shadowRoot;
    return {
      markers,
      paras: paras.length,
      translatedParas,
      firstPara: document.querySelector(".para").textContent.slice(0, 50),
      code: document.querySelector("code").textContent,
      hidden: document.getElementById("hiddenMenu").textContent,
      pill: sr ? { label: sr.querySelector(".label").textContent, count: sr.querySelector(".count").textContent } : null,
    };
  });

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(900);
const before = await snapshot();
check("初始页面没有译文标记", before.markers === 0, `标记数 ${before.markers}`);

await send("translate");
const growth = [];
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(150);
  const s = await snapshot();
  if (growth.length === 0 || growth[growth.length - 1] !== s.markers) growth.push(s.markers);
  if (i === 6) await page.screenshot({ path: path.join(SHOT_DIR, "14-假接口流式写入中.png") });
  if (s.pill && s.pill.count.startsWith(`${s.paras} / ${s.paras}`)) break;
}
console.log(`标记增长曲线：${growth.join(" -> ")}`);
check("译文逐步写入而不是一次性替换", growth.length >= 4, `出现 ${growth.length} 个不同阶段`);
check("标记数单调增长", growth.every((v, i) => i === 0 || v >= growth[i - 1]), growth.join(","));

await page.waitForTimeout(1200);
const after = await snapshot();
const stats = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json();
console.log(`假接口统计：请求 ${stats.requests} 次，累计段数 ${stats.uniqueSegments}，页面标记 ${after.markers}`);
check("整页全部译出", after.translatedParas >= after.paras, `${after.translatedParas} / ${after.paras} 段`);
check("同批重复句只请求一次", stats.duplicatesInRequest === 0, `接口共收到 ${stats.requests} 次请求，批内重复段 ${stats.duplicatesInRequest} 条`);
check("代码块未被改写", /new Map/.test(after.code), after.code);
check("隐藏块未被改写", /Hidden menu/.test(after.hidden), after.hidden);
check("同批多对象合并返回被正确拆开", after.markers >= stats.uniqueSegments, `标记 ${after.markers} 段`);
await page.screenshot({ path: path.join(SHOT_DIR, "15-假接口整页译完.png") });

await page.evaluate(() => document.querySelector(".ez-ui-host").shadowRoot.querySelector(".toggle").click());
await page.waitForTimeout(300);
const restored = await snapshot();
check("还原原文无损", restored.markers === 0 && /Content scripts/.test(restored.firstPara), restored.firstPara);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const requestsBefore = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json()).requests;
const t1 = Date.now();
await send("translate");
let cachedMs = null;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(100);
  const s = await snapshot();
  if (s.translatedParas >= s.paras) {
    cachedMs = Date.now() - t1;
    break;
  }
}
const requestsAfter = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json()).requests;
const cachedState = (await send("status")).state;
console.log(`复访：${cachedMs} 毫秒译完，缓存命中 ${cachedState.cached} 段，复访期间接口请求 ${requestsAfter - requestsBefore} 次`);
check("复访完全命中缓存，零接口请求", requestsAfter === requestsBefore && cachedState.cached > 0, `新增请求 ${requestsAfter - requestsBefore} 次，缓存命中 ${cachedState.cached} 段`);
check("页面无 JavaScript 报错", errors.length === 0, errors.slice(0, 2).join(" | ") || "无");

// shadow DOM 专项：静态影子树、动态插入的影子节点、外层 light DOM 必须同时翻到，还原也要无损。
const shadowUrl = `http://127.0.0.1:${PAGE_PORT}/shadow_page.html`;
const shadowPage = await ctx.newPage();
shadowPage.on("pageerror", (e) => errors.push(`shadow pageerror: ${e.message}`));
shadowPage.on("console", (m) => {
  if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(`shadow console: ${m.text()}`);
});
await shadowPage.goto(shadowUrl, { waitUntil: "domcontentloaded" });
await shadowPage.waitForFunction(
  () => {
    const host = document.getElementById("shadowHost");
    return host && host.shadowRoot && host.shadowRoot.querySelector("#dynamicP");
  },
  null,
  { timeout: 5000 }
);
await send("translate", shadowUrl);

const readShadow = () =>
  shadowPage.evaluate(() => {
    const deepText = (start) => {
      let text = "";
      const walk = (node) => {
        if (node.nodeType === 3) {
          text += node.nodeValue || "";
          return;
        }
        for (const child of node.childNodes || []) walk(child);
        if (node.shadowRoot) walk(node.shadowRoot);
      };
      walk(start);
      return text;
    };
    const root = document.getElementById("shadowHost").shadowRoot;
    return {
      all: deepText(document.body),
      shadow: root.textContent,
      staticP: root.querySelector("#staticP")?.textContent || "",
      dynamicP: root.querySelector("#dynamicP")?.textContent || "",
      light: document.querySelector("body > p")?.textContent || "",
    };
  });

let shadowState = await readShadow();
for (let i = 0; i < 80; i++) {
  shadowState = await readShadow();
  if (/译\d+：/.test(shadowState.staticP) && /译\d+：/.test(shadowState.dynamicP) && /译\d+：/.test(shadowState.light)) break;
  await shadowPage.waitForTimeout(150);
}
check("开放 shadow root 内的静态文字已翻译", /译\d+：/.test(shadowState.staticP), shadowState.staticP.slice(0, 40));
check("动态插入 shadow root 的文字也已翻译", /译\d+：/.test(shadowState.dynamicP), shadowState.dynamicP.slice(0, 40));
check("shadow 外层 light DOM 仍正常翻译", /译\d+：/.test(shadowState.light), shadowState.light.slice(0, 40));

await shadowPage.evaluate(() => document.querySelector(".ez-ui-host").shadowRoot.querySelector(".toggle").click());
await shadowPage.waitForTimeout(300);
const restoredShadow = await readShadow();
check(
  "shadow DOM 还原后原文无损",
  /Text living inside an open shadow root/.test(restoredShadow.staticP) && !/译\d+：/.test(restoredShadow.shadow),
  restoredShadow.staticP.slice(0, 60)
);

await ctx.close();
pageServer.close();
mock.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length} 项检查，通过 ${results.length - failed.length}，未通过 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`失败项：${f.name} -> ${f.detail}`);
  process.exit(1);
}
