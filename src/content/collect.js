window.EZ = window.EZ || {};

(() => {
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "VAR", "SVG", "CANVAS", "IFRAME", "VIDEO", "AUDIO",
    "MATH", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "IMG", "OBJECT", "EMBED",
    "MAP", "AREA", "TRACK", "SOURCE", "PROGRESS", "METER",
  ]);

  const INLINE_TAGS = new Set([
    "A", "ABBR", "ACRONYM", "B", "BDI", "BDO", "BIG", "BLINK", "BUTTON", "CITE", "DATA",
    "DEL", "DFN", "EM", "FONT", "I", "INS", "LABEL", "MARK", "NOBR", "OUTPUT", "Q",
    "RP", "RT", "RUBY", "S", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP",
    "TIME", "TT", "U", "WBR",
  ]);

  const SKIP_CLASS_RE = /(^|[-_\s])(notranslate|no-translate|code|highlight|hljs|katex|mathjax|monaco|ace_editor|cm-editor|codemirror)([-_\s]|$)/i;

  function isSkipped(el) {
    if (el.__ezWritten) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute && el.getAttribute("translate") === "no") return true;
    if (el.isContentEditable) return true;
    if (el.classList && el.classList.contains("ez-ui-host")) return true;
    if (el.hasAttribute && el.hasAttribute("data-ez")) return true;
    if (el.classList && el.classList.contains("notranslate")) return true;
    if (el.className && typeof el.className === "string" && SKIP_CLASS_RE.test(el.className)) return true;
    return false;
  }

  function isBlockLike(el) {
    return !INLINE_TAGS.has(el.tagName);
  }

  function translatable(raw) {
    const text = raw.trim();
    if (text.length < 2) return false;
    if (!/[A-Za-z]/.test(text)) return false;
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    if (cjk > 0 && cjk * 3 > text.length) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(text)) return false;
    if (/[{}]|=>|\b(function|const|let|var|return)\s*\(|;\s*$/.test(text)) return false;
    if (/^[-=_*~#|/\\<>.\s\d]+$/.test(text)) return false;
    return true;
  }

  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  // 开放 shadow root 里的文字同样要翻译。childNodes 不含 shadow 内容，
  // 所以凡是遍历子节点的地方都走这个函数统一补齐。
  function childNodesOf(el) {
    const nodes = Array.from(el.childNodes);
    if (el.shadowRoot) {
      for (const node of el.shadowRoot.childNodes) nodes.push(node);
    }
    return nodes;
  }

  function segmentsOf(root) {
    const segs = [];
    const stack = childNodesOf(root).reverse();
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.__ezWritten) continue;
        const parent = node.parentElement;
        if (!parent || isSkipped(parent)) continue;
        const raw = node.nodeValue;
        if (!raw) continue;
        const core = raw.trim();
        if (!translatable(core)) continue;
        const lead = raw.slice(0, raw.indexOf(core));
        const trail = raw.slice(raw.indexOf(core) + core.length);
        segs.push({ node, text: normalize(core), raw, lead, trail, applied: false, translated: null });
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (isSkipped(node)) continue;
      const kids = childNodesOf(node);
      for (let index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
    }
    return segs;
  }

  function unitIsUsable(el) {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.whiteSpace.startsWith("pre")) return false;
    return true;
  }

  function createCollector(root) {
    const queue = [];
    for (const child of childNodesOf(root)) if (child.nodeType === Node.ELEMENT_NODE) queue.push(child);
    let order = 0;

    function emit(el, units) {
      if (!unitIsUsable(el)) return;
      const segs = segmentsOf(el);
      if (!segs.length) return;
      let chars = 0;
      for (const s of segs) chars += s.text.length;
      units.push({ el, segs, chars, order: order++, state: "pending", attempts: 0 });
    }

    function walkDeep(el, units) {
      if (isSkipped(el)) return;
      const kids = childNodesOf(el);
      let hasBlockChild = false;
      for (const child of kids) {
        if (child.nodeType === Node.ELEMENT_NODE && isBlockLike(child) && !isSkipped(child)) {
          hasBlockChild = true;
          break;
        }
      }
      if (!hasBlockChild) {
        emit(el, units);
        return;
      }
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const host = run[0].parentElement || el;
        const segs = [];
        for (const node of run) {
          if (node.nodeType === Node.TEXT_NODE) {
            const raw = node.nodeValue;
            const core = raw ? raw.trim() : "";
            if (!core || !translatable(core)) continue;
            segs.push({ node, text: normalize(core), raw, lead: raw.slice(0, raw.indexOf(core)), trail: raw.slice(raw.indexOf(core) + core.length), applied: false, translated: null });
          } else {
            for (const seg of segmentsOf(node)) segs.push(seg);
          }
        }
        run = [];
        if (!segs.length) return;
        if (!unitIsUsable(host)) return;
        let chars = 0;
        for (const s of segs) chars += s.text.length;
        units.push({ el: host, segs, chars, order: order++, state: "pending", attempts: 0 });
      };
      for (const node of kids) {
        if (node.nodeType === Node.TEXT_NODE) {
          run.push(node);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (isBlockLike(node) || isSkipped(node)) {
          flush();
          if (!isSkipped(node)) walkDeep(node, units);
          continue;
        }
        run.push(node);
      }
      flush();
    }

    return {
      next(budget) {
        const units = [];
        let processed = 0;
        while (queue.length && processed < budget) {
          const el = queue.shift();
          processed++;
          if (isSkipped(el)) continue;
          walkDeep(el, units);
        }
        return { units, done: queue.length === 0 };
      },
      add(root2) {
        for (const child of childNodesOf(root2)) if (child.nodeType === Node.ELEMENT_NODE) queue.push(child);
      },
    };
  }

  window.EZ.collector = { createCollector, segmentsOf, translatable, normalize, isSkipped, unitIsUsable };

  // 与 src/shared/config.js 中的同名逻辑保持一致，内容脚本无法直接引用模块。
  function normalizeDomain(value) {
    let host = String(value || "").trim().toLowerCase();
    if (!host) return "";
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    host = host.split("/")[0].split("?")[0].split("#")[0];
    host = host.replace(/:\d+$/, "");
    host = host.replace(/^\*\./, "").replace(/^\./, "");
    if (!host || host.length > 253) return "";
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return "";
    if (host.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return "";
    return host;
  }

  function hostMatchesBlacklist(host, list) {
    const target = String(host || "").trim().toLowerCase();
    if (!target || !Array.isArray(list)) return false;
    for (const item of list) {
      const domain = normalizeDomain(item);
      if (!domain) continue;
      if (target === domain || target.endsWith("." + domain)) return true;
    }
    return false;
  }

  window.EZ.blacklist = { normalizeDomain, hostMatchesBlacklist };
})();
