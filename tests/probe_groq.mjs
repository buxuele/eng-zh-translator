// 目的：用真实请求摸清 gpt-oss-120b 在 Groq 上的流式返回格式、首字延迟、单段与批量 JSON 行的可靠性。
// 用法：node tests/probe_groq.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const KEY = env.GROQ_API_KEY;
const MODEL = env.GROQ_MODEL;
const URL = env.GROQ_BASE_URL + "/chat/completions";

async function call(payload, label) {
  const t0 = Date.now();
  let firstTokenAt = null;
  let firstContentAt = null;
  let reasoningChars = 0;
  let content = "";
  let usage = null;
  const rawPreview = [];

  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text();
    console.log(`[${label}] HTTP ${res.status} ${t.slice(0, 400)}`);
    return null;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const body = s.slice(5).trim();
      if (body === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(body);
      } catch {
        continue;
      }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (firstTokenAt === null) firstTokenAt = Date.now() - t0;
      if (d.reasoning) reasoningChars += d.reasoning.length;
      if (d.content) {
        if (firstContentAt === null) firstContentAt = Date.now() - t0;
        content += d.content;
      }
      if (rawPreview.length < 3) rawPreview.push(JSON.stringify(j).slice(0, 300));
    }
  }

  console.log(`[${label}] 总耗时=${Date.now() - t0}ms 首包=${firstTokenAt}ms 首个正文=${firstContentAt}ms 思考字数=${reasoningChars}`);
  console.log(`[${label}] usage=${JSON.stringify(usage)}`);
  console.log(`[${label}] 原始分片样例:`);
  rawPreview.forEach((p) => console.log("   " + p));
  return content;
}

// 探测一：单段英译中，确认思考链与正文是否分离
const single = await call(
  {
    model: MODEL,
    messages: [
      { role: "system", content: "你是专业翻译。只输出译文，不要解释。" },
      { role: "user", content: "Translate into Simplified Chinese:\nThe quick brown fox jumps over the lazy dog, but the dog was not amused." },
    ],
    temperature: 1,
    max_completion_tokens: 2048,
    top_p: 1,
    reasoning_effort: "low",
    stream: true,
  },
  "单段 low",
);
console.log("单段正文=" + JSON.stringify(single));

// 探测二：批量 JSON 行协议，检验模型能否严格逐行输出且不串行
const segs = [
  "Chrome extensions are built on web technologies such as HTML, CSS, and JavaScript.",
  "A content script runs in the context of the page and can read and modify the DOM.",
  "The service worker handles network requests without blocking the user interface.",
  "Translation quality depends on how much context the model receives.",
  "Users should be able to keep scrolling while the page is being translated.",
  "If a segment fails, the extension retries it exactly once before giving up.",
];
const payload = {
  model: MODEL,
  messages: [
    {
      role: "system",
      content:
        "You are a professional translator. You receive numbered text segments that belong to the same web page paragraph group. " +
        "Translate each segment into Simplified Chinese. Keep the meaning, tone and inline punctuation. Do not merge, split, reorder or drop segments. " +
        "Output exactly one JSON object per line, no markdown fence, no extra text: {\"i\":<index>,\"t\":\"<translation>\"}",
    },
    { role: "user", content: segs.map((s, i) => `${i}\t${s}`).join("\n") },
  ],
  temperature: 1,
  max_completion_tokens: 4096,
  top_p: 1,
  reasoning_effort: "low",
  stream: true,
};
const batched = await call(payload, "批量 JSON 行");
console.log("批量原始输出=\n" + batched);
const lines = (batched || "").split("\n").map((l) => l.trim()).filter(Boolean);
let ok = 0;
const seen = new Set();
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    if (typeof o.i === "number" && typeof o.t === "string") {
      ok++;
      seen.add(o.i);
    }
  } catch {
    console.log("无法解析行: " + l);
  }
}
console.log(`批量解析结果: 行数=${lines.length} 合法=${ok} 覆盖下标=${[...seen].sort((a, b) => a - b).join(",")} 期望=${segs.length}`);
