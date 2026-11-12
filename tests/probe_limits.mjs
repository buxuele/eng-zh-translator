// 第二轮探测：限流额度、并发行为、批量上限、思考链对首字延迟的影响。
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

function sysPrompt(extra = "") {
  return (
    "You are a professional translator for a browser extension. Input: numbered segments separated by a TAB, from the same web page region. " +
    "Translate every segment into Simplified Chinese. Keep meaning, tone, and trailing punctuation. Never merge, split, reorder or drop segments. " +
    "Translate directly, do not analyse, do not explain. Output one JSON object per line and nothing else: {\"i\":<index>,\"t\":\"<translation>\"}" +
    extra
  );
}

async function streamRun(payload) {
  const t0 = Date.now();
  const res = await fetch(URL, { method: "POST", headers: HEAD, body: JSON.stringify(payload) });
  const hdr = {
    status: res.status,
    rpmLimit: res.headers.get("x-ratelimit-limit-requests"),
    tpmLimit: res.headers.get("x-ratelimit-limit-tokens"),
    tpmRemaining: res.headers.get("x-ratelimit-remaining-tokens"),
    retryAfter: res.headers.get("retry-after"),
  };
  if (!res.ok) return { ...hdr, err: (await res.text()).slice(0, 200) };
  let content = "";
  let firstContentAt = null;
  let reasoning = 0;
  let usage = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const p of parts) {
      const s = p.trim();
      if (!s.startsWith("data:")) continue;
      const b = s.slice(5).trim();
      if (b === "[DONE]") continue;
      let j;
      try { j = JSON.parse(b); } catch { continue; }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning) reasoning += d.reasoning.length;
      if (d.content) { if (firstContentAt === null) firstContentAt = Date.now() - t0; content += d.content; }
    }
  }
  return { ...hdr, totalMs: Date.now() - t0, firstContentAt, reasoningChars: reasoning, content, usage };
}

function parseLines(content) {
  const out = [];
  for (const l of (content || "").split("\n")) {
    const s = l.trim().replace(/^```(?:json)?|```$/g, "");
    if (!s) continue;
    try { const o = JSON.parse(s); if (typeof o.i === "number" && typeof o.t === "string") out.push(o); } catch {}
  }
  return out;
}

const SEGS = [
  "Chrome extensions are built on web technologies such as HTML, CSS, and JavaScript.",
  "A content script runs in the context of the page and can read and modify the DOM.",
  "The service worker handles network requests without blocking the user interface.",
  "Translation quality depends on how much context the model receives.",
  "Users should be able to keep scrolling while the page is being translated.",
  "If a segment fails, the extension retries it exactly once before giving up.",
  "The popup offers a single primary action: translate this page.",
  "Cached translations are reused across reloads to save tokens.",
  "Batch size trades request overhead against per-request token limits.",
  "Scroll position decides which region gets translated first.",
  "Reasoning tokens delay the first visible character of the translation.",
  "A floating badge reports progress using real counters from the queue.",
  "Restoring the original text must be instant and lossless.",
  "Mutation observers catch content injected after the first pass.",
  "Rate limits are the hard constraint on a free tier key.",
  "Concurrency should stay low enough to avoid throttling.",
];

const user = (segs) => segs.map((s, i) => `${i}\t${s}`).join("\n");

console.log("=== 探测 A：16 段批量、禁止思考的提示词、low 思考 ===");
const a = await streamRun({
  model: "openai/gpt-oss-120b", messages: [{ role: "system", content: sysPrompt() }, { role: "user", content: user(SEGS) }],
  temperature: 1, max_completion_tokens: 4096, top_p: 1, reasoning_effort: "low", stream: true,
});
const aLines = parseLines(a.content);
console.log(JSON.stringify({ ...a, content: undefined, parsed: aLines.length, idx: aLines.map((o) => o.i).join(",") }));
console.log("限流头: rpm=" + a.rpmLimit + " tpm=" + a.tpmLimit + " 剩余token=" + a.tpmRemaining);

console.log("\n=== 探测 B：同批次、reasoning_format=hidden 是否更快 ===");
const b = await streamRun({
  model: "openai/gpt-oss-120b", messages: [{ role: "system", content: sysPrompt() }, { role: "user", content: user(SEGS.slice(0, 6)) }],
  temperature: 1, max_completion_tokens: 4096, top_p: 1, reasoning_effort: "low", reasoning_format: "hidden", stream: true,
});
console.log(JSON.stringify({ ...b, content: undefined, parsed: parseLines(b.content).length }));

console.log("\n=== 探测 C：20b 模型的限流与速度 ===");
const c = await streamRun({
  model: "openai/gpt-oss-20b", messages: [{ role: "system", content: sysPrompt() }, { role: "user", content: user(SEGS.slice(0, 6)) }],
  temperature: 1, max_completion_tokens: 4096, top_p: 1, reasoning_effort: "low", stream: true,
});
console.log(JSON.stringify({ ...c, content: undefined, parsed: parseLines(c.content).length, rpm: c.rpmLimit, tpm: c.tpmLimit }));

console.log("\n=== 探测 D：四路并发 ===");
const t0 = Date.now();
const conc = await Promise.all([0, 1, 2, 3].map((k) =>
  streamRun({
    model: "openai/gpt-oss-120b", messages: [{ role: "system", content: sysPrompt() }, { role: "user", content: user(SEGS.slice(0, 4)) }],
    temperature: 1, max_completion_tokens: 2048, top_p: 1, reasoning_effort: "low", stream: true,
  }),
));
console.log(`并发总耗时=${Date.now() - t0}ms ` + JSON.stringify(conc.map((x) => ({ s: x.status, ms: x.totalMs, first: x.firstContentAt, ok: parseLines(x.content).length, err: x.err }))));
