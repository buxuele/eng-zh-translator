window.EZ = window.EZ || {};

(() => {
  // 页面里只保留悬停看原文，且只在悬停时插入，移开立刻移除，不留常驻浮层。
  const STYLE = `
    :host { all: initial; }
    .tip {
      position: fixed; z-index: 2147483647; pointer-events: none;
      max-width: min(460px, calc(100vw - 28px)); padding: 10px 12px; border-radius: 10px;
      background: rgba(18, 18, 20, .95); color: rgba(255, 255, 255, .92);
      font: 14px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif;
      box-shadow: 0 10px 28px rgba(0, 0, 0, .32), 0 0 0 1px rgba(255, 255, 255, .08) inset;
      box-sizing: border-box; white-space: pre-wrap; word-break: break-word;
    }
    .label { display: block; font-size: 12px; color: rgba(255, 255, 255, .55); margin-bottom: 2px; }
  `;

  function create() {
    let host = null;
    let tip = null;

    function ensure() {
      if (host) return;
      host = document.createElement("div");
      host.setAttribute("data-ez", "tip");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      shadow.appendChild(style);
      tip = document.createElement("div");
      tip.className = "tip";
      shadow.appendChild(tip);
    }

    function show(rect, text) {
      if (!rect || !text) return;
      ensure();
      tip.innerHTML = `<span class="label">原文</span>${escapeHtml(text)}`;
      const width = Math.min(460, window.innerWidth - 28);
      tip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      tip.style.top = `${Math.max(8, rect.top - 8)}px`;
      if (!host.isConnected) document.body.appendChild(host);
    }

    function hide() {
      if (host && host.isConnected) host.remove();
    }

    return { show, hide };
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  window.EZ.ui = { create };
})();
