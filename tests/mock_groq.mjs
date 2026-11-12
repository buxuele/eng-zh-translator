// 本地假接口：按 Groq 的真实分片格式回放流式响应，用于零额度消耗的确定性回归。
// 每个 JSON 对象之间加固定延迟，用来证明译文是逐条写入页面而不是一次性替换。
import http from "node:http";

export function createMockGroq({ delayMs = 150, reasoningDelayMs = 60 } = {}) {
  const state = { requests: 0, uniqueSegments: 0, duplicatesInRequest: 0, segmentsSeen: [], batches: [] };

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/stats")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
      return;
    }
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const payload = JSON.parse(body);
      const system = payload.messages.find((m) => m.role === "system")?.content || "";
      const user = payload.messages.find((m) => m.role === "user").content;
      const isSelection = /Output only the translation/i.test(system);
      if (isSelection) {
        state.requests++;
        state.uniqueSegments += 1;
        state.batches.push({ count: 1, at: Date.now(), selection: true });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-ratelimit-limit-tokens": "8000",
          "x-ratelimit-remaining-tokens": "7000",
          "x-ratelimit-reset-tokens": "3s",
        });
        const sendPlain = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const sleepPlain = (ms) => new Promise((r) => setTimeout(r, ms));
        sendPlain({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        const parts = ["划词", "译文：", String(user).slice(0, 16)];
        for (const part of parts) {
          sendPlain({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
          await sleepPlain(delayMs);
        }
        sendPlain({
          id: "mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const lines = user.split("\n").filter(Boolean);
      const segs = lines.map((l) => {
        const idx = l.indexOf("\t");
        return { i: Number(l.slice(0, idx)), text: l.slice(idx + 1) };
      });
      const seen = new Set();
      let duplicates = 0;
      for (const seg of segs) {
        if (seen.has(seg.text)) duplicates++;
        seen.add(seg.text);
      }
      state.requests++;
      state.uniqueSegments += segs.length;
      state.duplicatesInRequest += duplicates;
      state.batches.push({ count: segs.length, duplicates, at: Date.now() });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-remaining-tokens": "7000",
        "x-ratelimit-reset-tokens": "3s",
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": "999",
      });

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      send({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      send({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning: "planning the translation" }, finish_reason: null }] });
      await sleep(reasoningDelayMs);

      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k];
        const translated = `译${seg.i}：${seg.text.slice(0, 12)}`;
        state.segmentsSeen.push(seg.text);
        const line = JSON.stringify({ i: seg.i, t: translated });
        // 每三段里故意把两条对象拼在同一行，复现 gpt-oss-20b 的返回习惯
        if (k % 3 === 2 && k + 1 < segs.length) {
          const next = segs[k + 1];
          state.segmentsSeen.push(next.text);
          const line2 = JSON.stringify({ i: next.i, t: `译${next.i}：${next.text.slice(0, 12)}` });
          send({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: line + line2 }, finish_reason: null }] });
          k++;
        } else {
          send({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: line }, finish_reason: null }] });
        }
        await sleep(delayMs);
      }
      send({
        id: "mock",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100 + segs.length * 10, completion_tokens: segs.length * 20, total_tokens: 100 + segs.length * 30 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return {
    server,
    state,
    listen: (port) => new Promise((r) => server.listen(port, "127.0.0.1", r)),
    close: () => server.close(),
    baseUrl: (port) => `http://127.0.0.1:${port}/openai/v1`,
  };
}
