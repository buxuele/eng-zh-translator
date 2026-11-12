// 第三轮探测：20b 为何解析失败；含难点字符的段落能否保序；空段与短段表现。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = env.GROQ_API_KEY;
const URL = env.GROQ_BASE_URL + "/chat/completions";
const HEAD = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const SYS =
  "You are a professional translator for a browser extension. Input: numbered segments separated by a TAB, they come from the same web page region. " +
  "Translate every segment into Simplified Chinese. Keep meaning, tone, and trailing punctuation. Never merge, split, reorder or drop segments. " +
  "Translate directly, do not analyse, do not explain. Output one JSON object per line and nothing else: {\"i\":<index>,\"t\":\"<translation>\"}";

async function run(model, segs, effort = "low") {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYS }, { role: "user", content: segs.map((s, i) => `${i}\t${s}`).join("\n") }],
      temperature: 1, max_completion_tokens: 4096, top_p: 1, reasoning_effort: effort, stream: true,
    }),
  });
  if (!res.ok) return { status: res.status, err: (await res.text()).slice(0, 200), content: "" };
  let content = "", first = null;
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n"); buf = parts.pop();
    for (const p of parts) {
      const s = p.trim(); if (!s.startsWith("data:")) continue;
      const b = s.slice(5).trim(); if (b === "[DONE]") continue;
      let j; try { j = JSON.parse(b); } catch { continue; }
      const d = j.choices?.[0]?.delta; if (!d) continue;
      if (d.content) { if (first === null) first = Date.now() - t0; content += d.content; }
    }
  }
  return { status: 200, totalMs: Date.now() - t0, first, content };
}

console.log("=== 20b 原始输出（六段）===");
const r20 = await run("openai/gpt-oss-20b", [
  "Chrome extensions are built on web technologies.",
  "A content script runs in the context of the page.",
  "The service worker handles network requests.",
  "Translation quality depends on context.",
  "Users keep scrolling while translation runs.",
  "Failed segments are retried once.",
]);
console.log("耗时=" + r20.totalMs + "ms 首字=" + r20.first + "ms");
console.log(JSON.stringify(r20.content));

console.log("\n=== 120b 难点字符保序 ===");
const tricky = [
  'He said "hello" and left.',
  "She replied:\nNot today.",
  "Use the &amp; symbol and 100% of the budget.",
  'A path like C:\\Users\\dev inside text.',
  "Read more",
  "“Curly quotes” and ‘single’ ones.",
  'It costs $19.99 (about ¥140).',
  "The <b>bold</b> tag is stripped before translation.",
  "Trailing punctuation!?",
  " ", // 纯空白，应当被前端提前过滤
];
const r12 = await run("openai/gpt-oss-120b", tricky);
console.log("耗时=" + r12.totalMs + "ms 首字=" + r12.first + "ms");
console.log(r12.content);
const ok = [];
for (const l of r12.content.split("\n")) {
  const s = l.trim(); if (!s) continue;
  try { const o = JSON.parse(s); if (typeof o.i === "number") ok.push(o.i + ":" + JSON.stringify(o.t)); } catch { ok.push("坏行:" + s.slice(0, 60)); }
}
console.log("解析: " + ok.join(" | "));
