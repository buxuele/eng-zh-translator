(() => {
  if (window.top !== window) return;

  let engine = null;
  let ui = null;
  let settings = null;
  let tipTimer = null;

  function boot() {
    ui = window.EZ.ui.create();
    engine = window.EZ.createEngine(() => {});
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

  document.addEventListener("scroll", () => {
    if (!engine) return;
    ui.hide();
  }, { passive: true, capture: true });

  document.addEventListener("mouseover", (event) => {
    if (!engine || !settings || settings.hoverOriginal === false) return;
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest("[data-ez]")) return;
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const info = engine.lookupOriginal(target);
      if (info) ui.show(target.getBoundingClientRect(), info.original);
      else ui.hide();
    }, 500);
  });

  document.addEventListener("mouseout", () => {
    if (!engine) return;
    if (tipTimer) clearTimeout(tipTimer);
    ui.hide();
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
    if (next.hoverOriginal === false) ui.hide();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
