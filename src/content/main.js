(() => {
  if (window.top !== window) return;

  let engine = null;
  let ui = null;
  let settings = null;
  let selectionBuffer = "";
  let tipTimer = null;

  function boot() {
    ui = window.EZ.ui.create({
      onToggle: () => toggle(),
      onStop: () => {
        engine.stop();
      },
      onRetry: () => {
        engine.retry();
      },
      onDismissError: () => {},
      onSelection: (text, rect) => translateSelection(text, rect),
      onCopy: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          area.remove();
        }
      },
    });
    engine = window.EZ.createEngine((state) => {
      ui.render(state);
    });
    engine.loadSettings().then(maybeAutoTranslate);
  }

  function maybeAutoTranslate() {
    chrome.storage.local.get("settings").then(({ settings: stored }) => {
      settings = stored || {};
      const host = (location.hostname || "").toLowerCase();
      const list = Array.isArray(settings.autoTranslateHosts) ? settings.autoTranslateHosts : [];
      const hit = list.some((item) => {
        const domain = String(item || "").trim().toLowerCase().replace(/^\*\./, "");
        return domain && (host === domain || host.endsWith("." + domain));
      });
      if (hit && settings.apiKey) engine.start({ auto: true });
    });
  }

  function toggle() {
    const state = engine.getState();
    if (state.showingOriginal) {
      engine.reapply();
      engine.start();
      return;
    }
    if (engine.isActive()) {
      engine.restore();
      engine.stop();
      return;
    }
    engine.start({ force: true });
  }

  async function translateSelection(text, rect) {
    selectionBuffer = "";
    ui.beginSelection(rect);
    engine.translateText(text, {
      onDelta: (delta) => {
        selectionBuffer += delta;
        ui.appendSelection(selectionBuffer);
      },
      onDone: (result) => {
        ui.endSelection(result.text || selectionBuffer, text.slice(0, 120));
      },
      onError: (msg) => {
        ui.selectionError(msg && msg.message ? msg.message : "翻译失败");
      },
      onWait: (waitMs) => {
        if (waitMs > 0) ui.appendSelection(`排队等待 ${Math.ceil(waitMs / 1000)} 秒…`);
      },
    });
  }

  function selectionReady() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 600) return null;
    if (!/[A-Za-z]/.test(text)) return null;
    if (!settings || settings.selectionTranslate === false) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  document.addEventListener("mouseup", (event) => {
    if (!engine) return;
    if (event.target && event.target.closest && event.target.closest(".ez-ui-host")) return;
    setTimeout(() => {
      const hit = selectionReady();
      if (hit) ui.showPick(hit.rect, hit.text);
      else ui.hidePick();
    }, 10);
  });

  document.addEventListener("mousedown", (event) => {
    if (!engine) return;
    if (event.target && event.target.closest && event.target.closest(".ez-ui-host")) return;
    ui.hidePick();
  });

  document.addEventListener("scroll", () => {
    if (!engine) return;
    ui.hidePick();
    ui.hideTip();
  }, { passive: true, capture: true });

  document.addEventListener("mouseover", (event) => {
    if (!engine || !settings || settings.hoverOriginal === false) return;
    const target = event.target;
    if (!target || !target.closest || target.closest(".ez-ui-host")) return;
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const info = engine.lookupOriginal(target);
      if (info) ui.showTip(target.getBoundingClientRect(), info.original);
      else ui.hideTip();
    }, 500);
  });

  document.addEventListener("mouseout", (event) => {
    if (!engine) return;
    if (tipTimer) clearTimeout(tipTimer);
    ui.hideTip();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.t !== "CMD") return false;
    if (!engine) boot();
    if (msg.cmd === "toggle") {
      toggle();
      sendResponse({ ok: true, state: engine.getState() });
      return true;
    }
    if (msg.cmd === "translate") {
      engine.start({ force: true });
      sendResponse({ ok: true, state: engine.getState() });
      return true;
    }
    if (msg.cmd === "restore") {
      engine.restore();
      engine.stop();
      sendResponse({ ok: true, state: engine.getState() });
      return true;
    }
    if (msg.cmd === "stop") {
      engine.stop();
      sendResponse({ ok: true, state: engine.getState() });
      return true;
    }
    if (msg.cmd === "retry") {
      engine.retry().then(() => sendResponse({ ok: true, state: engine.getState() }));
      return true;
    }
    if (msg.cmd === "rescan") {
      engine.scanAgain();
      sendResponse({ ok: true, state: engine.getState() });
      return true;
    }
    if (msg.cmd === "status") {
      sendResponse({ ok: true, state: engine.getState() });
      return true;
    }
    sendResponse({ ok: false, message: "未知指令" });
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const next = changes.settings.newValue || {};
    const prev = changes.settings.oldValue || {};
    settings = next;
    if (!engine) return;
    if (prev.mode !== next.mode || prev.targetLang !== next.targetLang) {
      if (engine.isActive()) engine.start();
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
