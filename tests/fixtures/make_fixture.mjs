// 生成本地英文测试页：40 段正文、导航、代码块、隐藏块、动态注入块，用来验证滚动优先与跳过规则。
import fs from "node:fs";
import path from "node:path";

const topics = [
  ["Content scripts", "run inside an isolated world and therefore cannot touch the page's JavaScript variables directly"],
  ["The service worker", "suspends itself after a short idle period, so every request must be resumable after a restart"],
  ["IntersectionObserver", "reports visibility changes without forcing a layout pass on every scroll event"],
  ["Token budgets", "decide how many paragraphs a single request can carry before the gateway starts rejecting traffic"],
  ["Caching", "turns a repeat visit into an instant render because the same sentence never needs a second round trip"],
  ["Streaming responses", "let the reader watch sentences arrive instead of waiting for the whole article to finish"],
  ["Batch assembly", "groups neighbouring paragraphs so the model keeps terminology consistent across a section"],
  ["Restoring the original", "must be lossless, which means the untouched text is kept in memory for every written node"],
  ["Mutation observers", "catch infinite scroll feeds and single page navigation without a full rescan of the document"],
  ["Rate limiting", "is reported by response headers, and the extension waits for the reset window before retrying"],
  ["Scroll prefetching", "starts the next two screens early so the reader rarely notices a placeholder"],
  ["Whitespace handling", "keeps the leading and trailing spaces around inline links so the sentence still reads correctly"],
  ["Error reporting", "shows the raw gateway message instead of a friendly lie when a request is rejected"],
  ["Selection of units", "skips code blocks, form inputs and hidden menus because those strings are not prose"],
  ["Concurrency", "stays low enough to avoid throttling while keeping two requests in flight for smoother output"],
  ["Progress reporting", "counts finished paragraphs from the queue rather than estimating a percentage"],
  ["Dynamic pages", "inject fresh paragraphs long after load, and those paragraphs must join the same queue"],
  ["Long articles", "are translated from the reader's viewpoint outward, not from the top of the document"],
  ["Interface labels", "inside buttons and navigation bars are translated as ordinary text segments"],
  ["Language detection", "keeps numeric tables and URL strings untouched because translating them adds noise"],
];

const p = [];
for (let i = 0; i < 40; i++) {
  const [subject, detail] = topics[i % topics.length];
  p.push(
    `<p class="para" id="p${i + 1}">${subject} ${detail}, which is why the extension keeps a queue keyed by document order and promotes whatever the reader is about to look at. See <a href="#">the reference page</a> for the full list of edge cases, or read <strong>the migration notes</strong> before shipping anything to production. Paragraph number ${i + 1}.</p>`,
  );
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Streaming Translation Sample Page</title>
    <style>
      body { max-width: 820px; margin: 0 auto; padding: 24px 20px 120px; font: 16px/1.7 Georgia, serif; color: #1b1d21; }
      nav { display: flex; gap: 16px; border-bottom: 1px solid #ddd; padding-bottom: 10px; margin-bottom: 22px; font: 14px/1.5 system-ui, sans-serif; }
      h1 { font-size: 30px; }
      h2 { font-size: 20px; margin-top: 34px; }
      .hidden { display: none; }
      pre { background: #f4f5f7; padding: 12px; overflow: auto; }
      footer { border-top: 1px solid #ddd; margin-top: 40px; padding-top: 14px; color: #555; }
      .note { background: #fdf3f8; border: 1px solid #f6d7e6; padding: 10px 14px; border-radius: 8px; }
    </style>
  </head>
  <body>
    <nav>
      <a href="#">Home</a><a href="#">Documentation</a><a href="#">Pricing</a><a href="#">Changelog</a><a href="#">Support</a>
    </nav>
    <h1>How streaming translation works on a long article</h1>
    <p class="note">This page exists to exercise the extension: it carries prose, links, code, hidden menus and content that appears later.</p>
    <h2>Reference paragraphs</h2>
    ${p.slice(0, 20).join("\n    ")}
    <h2>Code must stay untouched</h2>
    <pre><code>const client = new Groq();
completion.on("chunk", (c) => process.stdout.write(c.choices[0].delta.content || ""));</code></pre>
    <div class="hidden" id="hiddenMenu">Secret menu item that should never be translated.</div>
    <div translate="no" id="noTranslate">Brand asset text with translate no attribute.</div>
    <h2>More reference paragraphs</h2>
    ${p.slice(20).join("\n    ")}
    <footer id="footer">
      <p id="footerNote">This footer sentence is the last block on the page and it should be translated only when the reader arrives here.</p>
    </footer>
    <div id="dynamic"></div>
    <script>
      setTimeout(() => {
        const el = document.createElement("p");
        el.className = "para";
        el.id = "dynamicOne";
        el.textContent = "This paragraph was injected eight hundred milliseconds after load and it must still join the translation queue.";
        document.getElementById("dynamic").appendChild(el);
      }, 800);
    </script>
  </body>
</html>
`;

const verbose = process.argv.includes("--big");
const mini = process.argv.includes("--mini");
const scroll = process.argv.includes("--scroll");

const out = path.join(import.meta.dirname, "sample_page.html");
fs.writeFileSync(out, html);
console.log(`已写入 ${out}，段落数 ${p.length}，字符数 ${html.length}`);

if (verbose) {
  const many = [];
  for (let i = 0; i < 120; i++) {
    const [subject, detail] = topics[i % topics.length];
    many.push(
      `<p class="para" id="b${i + 1}">Variant number ${i + 1}. ${subject} ${detail}. A reader who lands on this section expects the paragraph to be translated before the next screen is drawn, which forces the queue to promote whatever is close to the viewport and to defer everything that sits far below the fold. The gateway only allows a limited number of tokens per minute, so the extension has to wait for the reset window instead of hammering the endpoint and losing segments in the process.</p>`,
    );
  }
  const bigHtml = html.replace('<h2>Reference paragraphs</h2>', `<h2>Reference paragraphs</h2>\n    ${many.join("\n    ")}`);
  const bigOut = path.join(import.meta.dirname, "big_page.html");
  fs.writeFileSync(bigOut, bigHtml);
  console.log(`已写入 ${bigOut}，段落数 ${p.length + many.length}，字符数 ${bigHtml.length}`);
}

if (mini) {
  const miniParas = [
    "Chrome extensions are built on web technologies such as HTML, CSS and JavaScript.",
    "A content script can read and change the document that the reader is looking at.",
    "The service worker performs the network requests so the page keeps its own origin.",
    "Translation quality improves when neighbouring sentences travel in the same request.",
    "Readers should never wait for a long article before the first sentence appears.",
    "Cached sentences return without a second request, which keeps the quota in check.",
  ];
  const miniHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Mini Sample</title></head>
  <body>
    <nav><a href="#">Home</a><a href="#">Docs</a></nav>
    <h1>A short page for a quick round trip</h1>
    ${miniParas.map((t, i) => `<p class="para" id="m${i + 1}">${t}</p>`).join("\n    ")}
    <pre><code>const queue = new Map();</code></pre>
    <div class="hidden" id="hiddenMenu" style="display:none">Hidden menu item.</div>
    <footer><p id="footerNote">That is the whole page.</p></footer>
  </body>
</html>
`;
  const miniOut = path.join(import.meta.dirname, "mini_page.html");
  fs.writeFileSync(miniOut, miniHtml);
  console.log(`已写入 ${miniOut}，段落数 ${miniParas.length}，字符数 ${miniHtml.length}`);
}

if (scroll) {
  const short = [
    "Content scripts read the page.",
    "The worker owns the network calls.",
    "The queue follows the reader.",
    "Cached lines return at once.",
    "Batches keep context together.",
    "Restoring text must be exact.",
    "Rate limits pace the drain.",
    "Streaming keeps readers calm.",
    "Hidden menus stay untouched.",
    "Code samples stay in English.",
  ];
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push(`<p class="para" id="s${i + 1}" style="margin-bottom:85vh">${short[i % short.length]} Section ${i + 1} continues here.</p>`);
  }
  const scrollHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Tall Scroll Sample</title>
  <style>body{margin:0;padding:20px;font:16px/1.6 system-ui,sans-serif}.hidden{display:none}</style></head>
  <body>
    <h1>Scroll driven translation on a tall page</h1>
    <nav><a href="#">Home</a><a href="#">Docs</a><a href="#">Pricing</a></nav>
    ${items.join("\n    ")}
    <pre><code>const cache = new Map();</code></pre>
    <div class="hidden" id="hiddenMenu">Hidden menu item that must stay English.</div>
    <footer><p id="footerNote">The footer sits at the very bottom of this tall page.</p></footer>
    <div id="dynamic"></div>
    <script>
      setTimeout(() => {
        const el = document.createElement("p");
        el.className = "para";
        el.id = "dynamicOne";
        el.textContent = "This paragraph was injected eight hundred milliseconds after load and it must still join the translation queue.";
        document.getElementById("dynamic").appendChild(el);
      }, 800);
    </script>
  </body>
</html>
`;
  const scrollOut = path.join(import.meta.dirname, "scroll_page.html");
  fs.writeFileSync(scrollOut, scrollHtml);
  console.log(`已写入 ${scrollOut}，段落数 40，字符数 ${scrollHtml.length}`);
}
