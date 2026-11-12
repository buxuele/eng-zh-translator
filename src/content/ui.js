window.EZ = window.EZ || {};

(() => {
  const STYLE = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 15px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      color: #fff; pointer-events: none; max-width: min(560px, calc(100vw - 36px));
    }
    .pill {
      pointer-events: auto; position: relative; overflow: hidden;
      display: flex; align-items: center; gap: 12px;
      padding: 8px 10px 8px 14px; border-radius: 999px;
      background: rgba(18, 18, 20, .9);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .34), 0 0 0 1px rgba(255, 255, 255, .09) inset;
      backdrop-filter: blur(14px) saturate(160%);
      cursor: default; user-select: none; max-width: 100%; box-sizing: border-box;
    }
    .pill.dragging { cursor: grabbing; }
    .pill.mini {
      width: 52px; height: 52px; padding: 0; border-radius: 50%;
      justify-content: center; align-items: center; cursor: pointer; gap: 0;
    }
    .pill.mini .label, .pill.mini .count, .pill.mini .btn, .pill.mini .bar { display: none; }
    .pill.mini .dot { position: absolute; top: 8px; right: 8px; }
    .pill.mini .miniText { display: block; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .miniText { display: none; }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: #fc0377; transition: background .3s; }
    .dot.run { animation: pulse 1.1s ease-in-out infinite; }
    .dot.done { background: #9adb37; }
    .dot.warn { background: #f5a524; }
    .dot.err { background: #fc3b3b; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    .label { white-space: nowrap; font-weight: 600; }
    .count { white-space: nowrap; color: rgba(255, 255, 255, .8); font-variant-numeric: tabular-nums; }
    .btn {
      pointer-events: auto; border: 1px solid rgba(255, 255, 255, .26); background: rgba(255, 255, 255, .07);
      color: #fff; border-radius: 999px; padding: 5px 12px; font-size: 14px; line-height: 1.4; cursor: pointer;
      white-space: nowrap; font-family: inherit;
    }
    .btn:hover { background: rgba(255, 255, 255, .16); }
    .btn.primary { border-color: transparent; background: #fc0377; font-weight: 600; }
    .btn.primary:hover { background: #e00269; }
    .btn.ghost { border-color: transparent; background: transparent; color: rgba(255, 255, 255, .62); padding: 5px 8px; }
    .btn.ghost:hover { color: #fff; }
    .btn:focus-visible { outline: 2px solid #9adb37; outline-offset: 2px; }
    .bar { position: absolute; left: 0; bottom: 0; height: 3px; width: 0; background: #fc0377; transition: width .25s ease, background .3s; }
    .bar.done { background: #9adb37; }
    .card {
      pointer-events: auto; padding: 12px 14px; border-radius: 14px; max-width: 100%;
      background: rgba(18, 18, 20, .93); color: rgba(255, 255, 255, .94);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .34), 0 0 0 1px rgba(255, 255, 255, .09) inset;
      backdrop-filter: blur(14px) saturate(160%); display: none; box-sizing: border-box;
    }
    .card.show { display: block; }
    .card .row { display: flex; align-items: center; gap: 8px; }
    .card .title { font-weight: 600; flex: 1; }
    .card .msg { margin: 6px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, .88); word-break: break-word; }
    .card .detail { display: none; margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: rgba(255, 255, 255, .06);
      font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: rgba(255, 255, 255, .76);
      max-height: 140px; overflow: auto; word-break: break-all; }
    .card .detail.show { display: block; }
    .card .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .details { display: none; }
    .details.show { display: block; }
    .details .count-line { font-size: 14px; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
    .selection-card { max-width: min(460px, calc(100vw - 28px)); }
    .selection-card .body { margin: 8px 0 0; max-height: 42vh; overflow: auto; font-size: 15px; line-height: 1.65; white-space: pre-wrap; }
    .selection-card .source { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .12); font-size: 13px; color: rgba(255, 255, 255, .6); }
    .pick {
      position: fixed; z-index: 2147483647; pointer-events: auto; border: 0; cursor: pointer;
      font: 14px/1 -apple-system, "PingFang SC", system-ui, sans-serif; color: #fff;
      background: #fc0377; padding: 9px 14px; border-radius: 999px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, .28); display: none;
    }
    .pick.show { display: block; }
    .pick:focus-visible { outline: 2px solid #9adb37; outline-offset: 2px; }
    .hover-tip {
      position: fixed; z-index: 2147483647; pointer-events: none; display: none;
      max-width: min(460px, calc(100vw - 28px)); padding: 10px 12px; border-radius: 10px;
      background: rgba(18, 18, 20, .95); color: rgba(255, 255, 255, .9);
      font: 14px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif;
      box-shadow: 0 10px 28px rgba(0, 0, 0, .32), 0 0 0 1px rgba(255, 255, 255, .08) inset;
      box-sizing: border-box;
    }
    .hover-tip.show { display: block; }
    .hover-tip .tip-label { display: block; font-size: 12px; color: rgba(255, 255, 255, .55); margin-bottom: 2px; }
    .hidden { display: none !important; }
    @media (prefers-reduced-motion: reduce) {
      .dot.run { animation: none; }
      .bar { transition: none; }
    }
  `;

  function create(handlers) {
    const host = document.createElement("div");
    host.className = "ez-ui-host";
    host.setAttribute("data-ez", "pill");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="card note" role="alert">
        <div class="row">
          <span class="title"></span>
          <button class="btn ghost note-detail" type="button" aria-expanded="false">详情</button>
          <button class="btn ghost note-close" type="button" aria-label="关闭提示">关闭</button>
        </div>
        <p class="msg"></p>
        <pre class="detail"></pre>
        <div class="actions">
          <button class="btn primary note-retry hidden" type="button">重试</button>
          <button class="btn note-stop hidden" type="button">停止翻译</button>
        </div>
      </div>
      <div class="card details">
        <div class="count-line"></div>
        <div class="actions">
          <button class="btn ghost detail-stop" type="button">停止翻译</button>
          <button class="btn ghost detail-hide" type="button">收起面板</button>
        </div>
      </div>
      <div class="pill" role="status">
        <span class="dot"></span>
        <span class="miniText"></span>
        <span class="label">准备中</span>
        <span class="count" aria-live="polite" aria-atomic="true"></span>
        <button class="btn ghost detail-toggle" type="button" aria-expanded="false">详情</button>
        <button class="btn toggle" type="button">显示原文</button>
        <button class="btn ghost collapse" type="button" aria-label="收起翻译面板">收起</button>
        <span class="bar"></span>
      </div>`;
    shadow.appendChild(wrap);

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick";
    pick.textContent = "翻译选中";
    shadow.appendChild(pick);

    const tip = document.createElement("div");
    tip.className = "hover-tip";
    shadow.appendChild(tip);

    const selection = document.createElement("div");
    selection.className = "card selection-card";
    selection.innerHTML = `
      <div class="row">
        <span class="title">划词译文</span>
        <button class="btn ghost sel-copy" type="button">复制</button>
        <button class="btn ghost sel-close" type="button" aria-label="关闭划词面板">关闭</button>
      </div>
      <p class="body"></p>
      <div class="source"></div>`;
    shadow.appendChild(selection);

    const $ = (sel) => wrap.querySelector(sel);
    const $$ = (sel) => shadow.querySelector(sel);
    const pill = $(".pill");
    const dot = $(".dot");
    const label = $(".label");
    const count = $(".count");
    const miniText = $(".miniText");
    const bar = $(".bar");
    const note = $(".note");
    const noteTitle = $(".note .title");
    const noteMsg = $(".note .msg");
    const noteDetail = $(".note .detail");
    const noteDetailBtn = $(".note .note-detail");
    const noteRetry = $(".note .note-retry");
    const noteStop = $(".note .note-stop");
    const noteClose = $(".note .note-close");
    const details = $(".details");
    const detailLine = $(".details .count-line");
    const detailToggle = $(".detail-toggle");
    const toggleBtn = $(".toggle");
    const collapseBtn = $(".collapse");
    const detailStop = $(".detail-stop");
    const detailHide = $(".detail-hide");

    let visible = false;
    let collapsed = false;
    let lastState = null;
    let pickText = "";
    let pickRect = null;
    let tipTimer = null;
    let selectionTimer = null;

    chrome.storage.local.get("uiCollapsed").then(({ uiCollapsed }) => {
      collapsed = !!uiCollapsed;
      if (visible) applyCollapsed();
    });

    function applyCollapsed() {
      pill.classList.toggle("mini", collapsed);
      if (collapsed) {
        wrap.classList.toggle("hidden", false);
        details.classList.remove("show");
        note.classList.remove("show");
      }
      if (collapsed) miniText.textContent = lastState ? percentOf(lastState) : "译";
    }

    function setCollapsed(next) {
      collapsed = next;
      chrome.storage.local.set({ uiCollapsed: collapsed });
      applyCollapsed();
    }

    function percentOf(state) {
      const total = state.total || 0;
      const done = state.done || 0;
      if (!total) return state.blocked ? "免" : "译";
      return `${Math.min(100, Math.round((done / total) * 100))}%`;
    }

    toggleBtn.addEventListener("click", () => handlers.onToggle());
    collapseBtn.addEventListener("click", () => setCollapsed(true));
    pill.addEventListener("click", (e) => {
      if (!collapsed) return;
      if (e.target.closest(".btn")) return;
      setCollapsed(false);
    });
    noteRetry.addEventListener("click", () => handlers.onRetry());
    noteStop.addEventListener("click", () => handlers.onStop());
    noteClose.addEventListener("click", () => {
      note.classList.remove("show");
      handlers.onDismissError();
    });
    noteDetailBtn.addEventListener("click", () => {
      const open = noteDetail.classList.toggle("show");
      noteDetailBtn.textContent = open ? "收起详情" : "详情";
      noteDetailBtn.setAttribute("aria-expanded", String(open));
    });
    detailToggle.addEventListener("click", () => {
      const open = details.classList.toggle("show");
      detailToggle.textContent = open ? "收起详情" : "详情";
      detailToggle.setAttribute("aria-expanded", String(open));
    });
    detailHide.addEventListener("click", () => {
      details.classList.remove("show");
      detailToggle.textContent = "详情";
      detailToggle.setAttribute("aria-expanded", "false");
    });
    detailStop.addEventListener("click", () => handlers.onStop());

    pick.addEventListener("click", () => {
      const text = pickText;
      const rect = pickRect;
      hidePick();
      if (text) handlers.onSelection(text, rect);
    });
    $$(".sel-close").addEventListener("click", () => hideSelection());
    $$(".sel-copy").addEventListener("click", async () => {
      const btn = $$(".sel-copy");
      await handlers.onCopy($$(".selection-card .body").textContent);
      btn.textContent = "已复制";
      setTimeout(() => {
        btn.textContent = "复制";
      }, 1200);
    });

    let dragState = null;
    pill.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".btn")) return;
      const rect = wrap.getBoundingClientRect();
      dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false, w: rect.width, h: rect.height };
      pill.classList.add("dragging");
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener("pointermove", (e) => {
      if (!dragState) return;
      dragState.moved = true;
      const x = Math.min(Math.max(0, e.clientX - dragState.dx), window.innerWidth - dragState.w);
      const y = Math.min(Math.max(0, e.clientY - dragState.dy), window.innerHeight - dragState.h);
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
      wrap.style.left = x + "px";
      wrap.style.top = y + "px";
    });
    pill.addEventListener("pointerup", (e) => {
      if (!dragState) return;
      pill.classList.remove("dragging");
      const moved = dragState.moved;
      dragState = null;
      try { pill.releasePointerCapture(e.pointerId); } catch {}
      if (moved) {
        const rect = wrap.getBoundingClientRect();
        chrome.storage.local.set({ uiPos: { x: Math.round(rect.left), y: Math.round(rect.top) } });
      }
    });

    function formatSeconds(ms) {
      const value = Number(ms) || 0;
      if (value <= 0) return "0 秒";
      if (value < 100) return "0.1 秒";
      if (value >= 60000) return `${(value / 60000).toFixed(1)} 分钟`;
      if (value >= 10000) return `${Math.round(value / 1000)} 秒`;
      return `${(value / 1000).toFixed(1)} 秒`;
    }

    function ensureHost() {
      if (!visible) {
        document.body.appendChild(host);
        visible = true;
        chrome.storage.local.get("uiPos").then(({ uiPos }) => {
          if (uiPos && Number.isFinite(uiPos.x)) {
            wrap.style.right = "auto";
            wrap.style.bottom = "auto";
            wrap.style.left = `${Math.max(4, Math.min(uiPos.x, window.innerWidth - 160))}px`;
            wrap.style.top = `${Math.max(4, Math.min(uiPos.y, window.innerHeight - 60))}px`;
          }
        });
      }
      wrap.classList.remove("hidden");
    }

    function render(state) {
      lastState = state;
      ensureHost();
      const total = state.total || 0;
      const done = state.done || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const statusClass = state.blocked
        ? "warn"
        : state.status === "running"
          ? "run"
          : state.status === "done" || state.status === "skipped"
            ? "done"
            : state.status === "error" || state.status === "blocked"
              ? "err"
              : state.status === "paused"
                ? "warn"
                : "done";
      dot.className = "dot " + statusClass;
      miniText.textContent = percentOf(state);

      if (collapsed) {
        applyCollapsed();
        return;
      }
      bar.style.width = `${total > 0 ? pct : 0}%`;
      count.textContent = total > 0 ? `${done} / ${total}` : "";

      const parts = [];
      if (state.queue > 0) parts.push(`队列 ${state.queue}`);
      if (state.cachedUnits > 0) parts.push(`缓存 ${state.cachedUnits}`);
      if (state.failed > 0) parts.push(`失败 ${state.failed}`);
      if (state.stale > 0) parts.push(`失效 ${state.stale}`);
      if (state.status === "done" && state.durationMs > 0) parts.push(`用时 ${formatSeconds(state.durationMs)}`);
      else if (state.elapsedMs > 0) parts.push(`已用 ${formatSeconds(state.elapsedMs)}`);
      detailLine.textContent = parts.join("  ·  ") || "暂无队列任务";

      if (state.blocked) {
        label.textContent = "免译站点";
        bar.classList.remove("done");
        bar.style.width = "0%";
      } else if (state.status === "running") {
        label.textContent = state.collecting
          ? "扫描页面"
          : state.waitMs > 90000
            ? `限流等待 ${Math.ceil(state.waitMs / 60000)} 分钟`
            : state.waitMs > 0
              ? `限流等待 ${Math.ceil(state.waitMs / 1000)} 秒`
              : "翻译中";
        bar.classList.remove("done");
      } else if (state.status === "done") {
        label.textContent = state.idleFillActive ? "已完成" : "可见区域已译";
        bar.classList.add("done");
      } else if (state.status === "skipped") {
        label.textContent = "已是中文";
        bar.classList.remove("done");
      } else if (state.status === "error" || state.status === "blocked") {
        label.textContent = "已暂停";
      } else if (state.status === "paused") {
        label.textContent = "已停止";
      } else {
        label.textContent = "原文";
      }

      const running = state.status === "running";
      toggleBtn.classList.toggle("hidden", !!state.blocked || state.status === "skipped" || (!running && !done));
      toggleBtn.textContent = state.showingOriginal ? "恢复译文" : "显示原文";
      detailToggle.classList.toggle("hidden", parts.length === 0);
      noteStop.classList.toggle("hidden", !running);

      if (state.error) {
        noteTitle.textContent = state.errorTitle || "翻译遇到问题";
        noteMsg.textContent = state.error;
        noteDetail.textContent = state.errorDetail || "";
        noteDetailBtn.classList.toggle("hidden", !state.errorDetail);
        note.classList.add("show");
        noteRetry.classList.toggle("hidden", !state.retryable);
      } else {
        note.classList.remove("show");
      }
    }

    function hidePick() {
      pick.classList.remove("show");
      pickText = "";
      pickRect = null;
    }

    function showPick(rect, text) {
      if (!rect) return hidePick();
      pickText = text;
      pickRect = { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right };
      pick.classList.add("show");
      const width = 104;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
      const top = rect.top > 56 ? rect.top - 44 : rect.bottom + 10;
      pick.style.left = `${left}px`;
      pick.style.top = `${Math.max(8, top)}px`;
    }

    function placeCard(el, rect) {
      if (!rect) {
        el.style.left = "18px";
        el.style.top = "80px";
        return;
      }
      const width = Math.min(460, window.innerWidth - 28);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const top = Math.min(Math.max(8, rect.bottom + 10), window.innerHeight - 80);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    function beginSelection(rect) {
      ensureHost();
      selection.classList.add("show");
      selection.style.position = "fixed";
      selection.style.zIndex = "2147483647";
      $$(".selection-card .body").textContent = "翻译中…";
      $$(".selection-card .source").textContent = "";
      $$(".sel-copy").classList.add("hidden");
      placeCard(selection, rect);
      if (selectionTimer) clearTimeout(selectionTimer);
    }

    function appendSelection(text) {
      $$(".selection-card .body").textContent = text || "翻译中…";
    }

    function endSelection(text, source) {
      $$(".selection-card .body").textContent = text || "没有返回译文";
      $$(".sel-copy").classList.toggle("hidden", !text);
      $$(".selection-card .source").textContent = source ? `原文：${source}` : "";
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => hideSelection(), 45000);
    }

    function selectionError(message) {
      $$(".selection-card .body").textContent = message || "翻译失败";
      $$(".sel-copy").classList.add("hidden");
    }

    function hideSelection() {
      selection.classList.remove("show");
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = null;
    }

    function showTip(rect, text) {
      if (!rect || !text) return;
      tip.innerHTML = `<span class="tip-label">原文</span>${escapeHtml(text)}`;
      tip.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 460)}px`;
      tip.style.top = `${Math.max(8, rect.top - 8)}px`;
      tip.classList.add("show");
    }

    function hideTip() {
      tip.classList.remove("show");
    }

    function escapeHtml(text) {
      return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    return {
      host,
      render,
      showPick,
      hidePick,
      beginSelection,
      appendSelection,
      endSelection,
      selectionError,
      hideSelection,
      showTip,
      hideTip,
      getState: () => lastState,
      isCollapsed: () => collapsed,
    };
  }

  window.EZ.ui = { create };
})();
