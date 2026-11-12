window.EZ = window.EZ || {};

(() => {
  const MSG = window.EZ.MSG;

  const DEFAULTS = {
    targetLang: "简体中文",
    mode: "scroll",
    idleFill: "auto",
    idleFillMaxChars: 20000,
    idleDelayMs: 2500,
    prefetchScreens: 2,
    batchSegments: 16,
    batchChars: 1500,
    concurrency: 2,
    blacklist: [],
    autoTranslateHosts: [],
    scope: "all",
    hoverOriginal: true,
    idleFillMaxChars: 20000,
    flashHighlight: true,
  };

  function createEngine(onChange) {
    const C = window.EZ.collector;
    let settings = { ...DEFAULTS };
    const stats = {
      status: "idle",
      total: 0,
      rawTotal: 0,
      stale: 0,
      chars: 0,
      done: 0,
      cached: 0,
      cachedUnits: 0,
      failed: 0,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      collecting: false,
      waitMs: 0,
      waitedMs: 0,
      rateRemaining: null,
      rateLimit: null,
      errors: [],
      error: null,
      errorCode: "",
      errorTitle: "",
      errorDetail: "",
      retryable: false,
      blocked: false,
      blockedHost: "",
      skipped: false,
      elapsedMs: 0,
      durationMs: 0,
      showingOriginal: false,
    };

    let active = false;
    const units = [];
    const buckets = [[], [], []];
    const bucketed = new Set();
    const writes = [];
    const batches = new Map();
    let batchSeq = 0;
    let port = null;
    let portReady = false;
    let pumping = false;
    let pauseUntil = 0;
    let idleTimer = null;
    let lastScrollAt = 0;
    let pingTimer = null;
    let progressTimer = null;
    let scanCursor = null;
    let scanRunning = false;
    let startedAt = 0;
    let finishedAt = 0;
    let elapsedMs = 0;
    let settingsLoaded = null;

    const visObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) setPrio(unitOf(e.target), 0);
      }
      pump();
    }, { rootMargin: "0px", threshold: 0 });

    let nearObs = makeNearObserver();
    function makeNearObserver() {
      return new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const u = unitOf(e.target);
            if (u && u.prio > 1) setPrio(u, 1);
          }
        }
        pump();
      }, { rootMargin: `${settings.prefetchScreens * 100}% 0px ${settings.prefetchScreens * 100}% 0px`, threshold: 0 });
    }
    function rebuildNearObserver() {
      nearObs.disconnect();
      nearObs = makeNearObserver();
      for (const u of units) if (u.state === "pending" || u.state === "inflight") nearObs.observe(u.el);
    }

    const unitMap = new WeakMap();
    function unitOf(el) {
      return el ? unitMap.get(el) : null;
    }

    window.addEventListener("scroll", () => { lastScrollAt = Date.now(); pump(); }, { passive: true, capture: true });
    window.addEventListener("resize", () => {
      visObs.disconnect();
      nearObs.disconnect();
      for (const u of units) if (u.state === "pending") { visObs.observe(u.el); nearObs.observe(u.el); }
    }, { passive: true });

    let dirtyRoots = new Set();
    let mutationTimer = null;
    const mo = new MutationObserver((records) => {
      if (!active || stats.showingOriginal) return;
      for (const r of records) {
        if (r.type === "characterData") {
          if (r.target.__ezWritten) continue;
          if (r.target.parentElement) dirtyRoots.add(r.target.parentElement);
        } else if (r.type === "childList") {
          for (const n of r.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) {
              if (n.classList && n.classList.contains("ez-ui-host")) continue;
              if (n.hasAttribute && n.hasAttribute("data-ez")) continue;
              dirtyRoots.add(n);
            } else if (n.nodeType === Node.TEXT_NODE && n.parentElement) {
              dirtyRoots.add(n.parentElement);
            }
          }
        }
      }
      if (dirtyRoots.size && !mutationTimer) mutationTimer = setTimeout(handleDirty, 500);
    });

    // 页面脚本往开放 shadow root 里写字时，外层观察器看不到，必须给每个影子树单独挂观察器。
    const shadowSeen = new WeakSet();
    function watchShadows(root) {
      if (!root) return;
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.shadowRoot && !shadowSeen.has(node.shadowRoot)) {
          shadowSeen.add(node.shadowRoot);
          mo.observe(node.shadowRoot, { childList: true, subtree: true, characterData: true });
        }
        for (const child of node.children) stack.push(child);
        if (node.shadowRoot) for (const child of node.shadowRoot.children) stack.push(child);
      }
    }

    function handleDirty() {
      mutationTimer = null;
      const roots = [...dirtyRoots];
      dirtyRoots = new Set();
      if (!active) return;
      const scopeRoot = scanRoot();
      for (const root of roots) {
        if (!root.isConnected) continue;
        if ((settings.scope || "all") === "article" && scopeRoot !== document.body && !scopeRoot.contains(root)) continue;
        watchShadows(root);
        const cursor = C.createCollector(root);
        for (;;) {
          const { units: found, done } = cursor.next(120);
          for (const u of found) addUnit(u);
          if (done) break;
        }
      }
      stats.total = units.length;
      pump();
      scheduleProgress();
    }

    function addUnit(u) {
      if (unitMap.has(u.el)) {
        const existing = unitMap.get(u.el);
        if (existing && existing.segs.length && existing.state !== "stale") return;
      }
      u.prio = 2;
      u.map = new Map();
      u.cachedAll = true;
      for (const s of u.segs) u.map.set(s.node, s);
      units.push(u);
      stats.chars += u.chars;
      stats.total = units.length;
      stats.rawTotal = units.length;
      unitMap.set(u.el, u);
      buckets[2].push(u);
      bucketed.add(u);
      visObs.observe(u.el);
      nearObs.observe(u.el);
    }

    function setPrio(u, p) {
      if (!u || u.state !== "pending" || u.prio === p) return;
      u.prio = p;
      buckets[p].push(u);
      bucketed.add(u);
    }

    function requeue(u, prio) {
      if (!u) return;
      u.state = "pending";
      if (prio !== undefined) u.prio = prio;
      buckets[u.prio].push(u);
      bucketed.add(u);
    }

    let lastResyncAt = 0;
    function resync() {
      const now = Date.now();
      if (now - lastResyncAt < 10000) return 0;
      lastResyncAt = now;
      const vh = window.innerHeight;
      const reach = vh * (1 + (settings.prefetchScreens || 2));
      let moved = 0;
      let budget = 600;
      for (const u of units) {
        if (budget <= 0) break;
        if (u.state !== "pending") continue;
        if (bucketed.has(u)) continue;
        if (u.prio !== 2) {
          buckets[u.prio].push(u);
          bucketed.add(u);
          moved++;
          continue;
        }
        budget--;
        const rect = u.el.getBoundingClientRect();
        if (rect.bottom > -reach && rect.top < reach) {
          requeue(u, rect.top < vh && rect.bottom > 0 ? 0 : 1);
          moved++;
        }
      }
      return moved;
    }

    function pickBatch() {
      const order = [0, 1];
      const idle = Date.now() - lastScrollAt > settings.idleDelayMs;
      if (settings.mode === "full" || (idleFillOn() && idle && batches.size === 0)) order.push(2);
      for (const p of order) {
        const arr = buckets[p];
        if (!arr.length) continue;
        const out = [];
        let segs = 0;
        let chars = 0;
        const keep = [];
        const taken = new Set();
        for (const u of arr) {
          if (u.state !== "pending" || u.prio !== p || taken.has(u)) continue;
          if (out.length && (segs >= settings.batchSegments || chars >= settings.batchChars)) {
            keep.push(u);
            continue;
          }
          taken.add(u);
          out.push(u);
          segs += u.segs.length;
          chars += u.chars;
        }
        buckets[p] = keep;
        for (const u of out) bucketed.delete(u);
        if (out.length) {
          out.sort((a, b) => a.order - b.order);
          return out;
        }
      }
      return null;
    }

    function nextFrame() {
      return new Promise((r) => setTimeout(r, 0));
    }

    async function scan() {
      if (scanRunning) return;
      scanRunning = true;
      stats.collecting = true;
      notify();
      const root = scanRoot();
      scanCursor = C.createCollector(root);
      for (;;) {
        const { units: found, done } = scanCursor.next(250);
        for (const u of found) addUnit(u);
        stats.total = units.length;
        notify();
        scheduleProgress();
        if (done || !active) break;
        await nextFrame();
      }
      if (root) watchShadows(root);
      stats.collecting = false;
      scanCursor = null;
      scanRunning = false;
      notify();
    }

    function ensurePort() {
      if (portReady) return port;
      port = chrome.runtime.connect({ name: "eng_zh" });
      portReady = true;
      port.onMessage.addListener(onPortMessage);
      port.onDisconnect.addListener(() => {
        portReady = false;
        port = null;
        if (!active) return;
        for (const b of batches.values()) {
          if (b.watchdog) clearTimeout(b.watchdog);
          for (const u of b.units) requeue(u);
        }
        batches.clear();
        setTimeout(() => { if (active) { ensurePort(); pump(); } }, 400);
      });
      if (!pingTimer) {
        pingTimer = setInterval(() => {
          if (portReady && active) port.postMessage({ t: MSG.PING });
        }, 15000);
      }
      return port;
    }

    function onPortMessage(msg) {
      if (!msg || !msg.t) return;
      if (msg.t === MSG.SEG) return applySeg(msg);
      if (msg.t === MSG.DONE) return finishBatch(msg);
      if (msg.t === MSG.ERR) return failBatch(msg);
      if (msg.t === MSG.RATE) return noteWait(msg.waitMs, msg);
    }

    let waitTimer = null;
    function noteWait(waitMs, info) {
      if (info) {
        stats.rateRemaining = info.remainingTokens ?? null;
        stats.rateLimit = info.limitTokens ?? null;
      }
      if (!(waitMs > 0)) {
        updateStatus();
        return;
      }
      stats.waitMs = waitMs;
      stats.waitedMs += waitMs;
      updateStatus();
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = setTimeout(() => {
        waitTimer = null;
        stats.waitMs = 0;
        notify();
      }, waitMs + 50);
    }

    function applySeg(msg) {
      const batch = batches.get(msg.id);
      if (!batch) return;
      const entry = batch.map[msg.i];
      if (!entry) return;
      const { unit, seg } = entry;
      if (seg.applied) return;
      if (!seg.node.isConnected) {
        unit.state = "stale";
        return;
      }
      const value = msg.text || seg.text;
      seg.node.__ezWritten = true;
      if (!stats.showingOriginal) seg.node.nodeValue = seg.lead + value + seg.trail;
      seg.applied = true;
      seg.translated = value;
      writes.push({ node: seg.node, original: seg.raw, lead: seg.lead, trail: seg.trail, translated: value });
      if (msg.cached) stats.cached++;
      if (!msg.cached) unit.cachedAll = false;
      flash(seg.node, seg.lead.length, value.length);
      if (unit.segs.every((s) => s.applied || !s.node.isConnected)) {
        if (unit.segs.every((s) => s.applied)) {
          unit.state = "done";
          stats.done++;
          if (unit.cachedAll) stats.cachedUnits++;
        } else unit.state = "stale";
      }
      scheduleProgress();
    }

    let highlight = null;
    let flashTimer = null;
    function flash(node, offset, length) {
      if (!settings.flashHighlight || stats.showingOriginal) return;
      if (!window.CSS || !CSS.highlights || typeof Highlight !== "function") return;
      if (length <= 0 || !node.isConnected) return;
      if (typeof node.nodeValue !== "string" || offset + length > node.nodeValue.length) return;
      try {
        if (!highlight) {
          highlight = new Highlight();
          CSS.highlights.set("ez-flash", highlight);
        }
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + length);
        highlight.add(range);
        if (highlight.size > 400) highlight.clear();
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          CSS.highlights.delete("ez-flash");
          highlight = null;
          flashTimer = null;
        }, 900);
      } catch (error) {
        // shadow root 里的文本范围在个别浏览器版本上不被 Highlight 接受，高亮失败不能影响翻译本身。
        if (highlight) highlight.clear();
        highlight = null;
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = null;
      }
    }

    function finishBatch(msg) {
      const batch = closeBatch(msg.id);
      if (!batch) return;
      for (const u of batch.units) {
        if (u.state !== "inflight") continue;
        if (u.segs.every((s) => s.applied)) {
          u.state = "done";
          stats.done++;
          continue;
        }
        u.attempts = (u.attempts || 0) + 1;
        if (u.attempts > 5) {
          u.state = "failed";
          stats.failed++;
        } else {
          requeue(u);
        }
      }
      stats.requests++;
      if (msg.tokensIn) stats.tokensIn += msg.tokensIn;
      if (msg.tokensOut) stats.tokensOut += msg.tokensOut;
      stats.error = null;
      stats.errorCode = "";
      stats.errorTitle = "";
      stats.errorDetail = "";
      stats.retryable = false;
      notify();
      scheduleProgress();
      pump();
      if (msg.truncated) setError("模型输出被截断，已自动拆分重试", true, "truncated", "输出被截断");
    }

    function failBatch(msg) {
      const batch = closeBatch(msg.id);
      const code = msg.code;
      if (code === "aborted") {
        if (batch) for (const u of batch.units) if (u.state === "inflight") u.state = "done";
        pump();
        return;
      }
      if (code === "blocked") {
        if (batch) for (const u of batch.units) if (u.state === "inflight") requeue(u);
        active = false;
        stats.blocked = true;
        stats.blockedHost = (location.hostname || "").toLowerCase();
        setError(describeError(code, msg), false, code, msg.title);
        stats.status = "blocked";
        notify();
        return;
      }
      const quota = code === "rate";
      if (batch) {
        for (const u of batch.units) {
          if (u.state !== "inflight") continue;
          if (quota) {
            u.requeues = (u.requeues || 0) + 1;
            if (u.requeues > 40) {
              u.state = "failed";
              stats.failed++;
            } else {
              requeue(u);
            }
            continue;
          }
          u.attempts = (u.attempts || 0) + 1;
          if (u.attempts > 5) {
            u.state = "failed";
            stats.failed++;
          } else {
            requeue(u);
          }
        }
      }
      setError(describeError(code, msg), msg.retryable, code, msg.title, msg.detail);
      if (code === "auth" || code === "forbidden" || code === "permission") {
        active = false;
        stats.status = "error";
        notify();
        return;
      }
      const backoff = quota ? Math.min(msg.retryAfterMs || 15000, 600000) : 3000;
      pauseUntil = Date.now() + backoff;
      stats.waitMs = backoff;
      updateStatus();
      setTimeout(() => {
        stats.waitMs = 0;
        notify();
        pump();
      }, Math.min(backoff, 600000));
    }

    function describeError(code, msg) {
      if (msg && msg.message) return msg.message;
      if (code === "auth") return "密钥无效或未配置，请到设置页填写 Groq 密钥。";
      if (code === "permission") return "当前接口域名未授权，请到设置页点授权接口域名。";
      if (code === "forbidden") return "接口拒绝访问，通常与密钥权限或代理有关，请检查后重试。";
      if (code === "rate") {
        const wait = formatDuration(msg.retryAfterMs || 0);
        return msg.daily ? `今日接口额度已用尽，约 ${wait}后恢复，译文缓存会保留。` : `触发接口限流，约 ${wait}后自动继续。`;
      }
      if (code === "network") return "无法连接翻译接口，请检查网络或代理后点重试。";
      return `请求失败：${msg && msg.message ? msg.message : code}`;
    }

    function formatDuration(ms) {
      if (!ms) return "稍";
      if (ms >= 60000) return `${Math.ceil(ms / 60000)} 分钟`;
      return `${Math.max(1, Math.round(ms / 1000))} 秒`;
    }

    function setError(text, retryable, code, title, detail) {
      stats.error = text;
      stats.errorCode = code || "unknown";
      stats.errorTitle = title || "";
      stats.errorDetail = detail || "";
      stats.retryable = !!retryable;
      stats.errors.push({ code: code || "unknown", message: text, at: Date.now() });
      if (stats.errors.length > 5) stats.errors.shift();
      notify();
    }

    function sendBatch(picked) {
      const id = ++batchSeq;
      const segs = [];
      const map = [];
      for (const u of picked) {
        u.state = "inflight";
        for (const s of u.segs) {
          map.push({ unit: u, seg: s });
          segs.push(s.text);
        }
      }
      const watchdog = setTimeout(() => {
        const batch = batches.get(id);
        if (!batch) return;
        if (portReady) port.postMessage({ t: MSG.CANCEL, id });
        batches.delete(id);
        for (const u of batch.units) requeue(u);
        setError("请求超时，已把这段内容退回队列重试。", true);
        pump();
      }, 120000);
      batches.set(id, { units: picked, map, watchdog });
      ensurePort().postMessage({ t: MSG.BATCH, id, segs, lang: settings.targetLang });
      updateStatus();
    }

    function closeBatch(id) {
      const batch = batches.get(id);
      if (batch && batch.watchdog) clearTimeout(batch.watchdog);
      batches.delete(id);
      return batch;
    }

    function idleFillOn() {
      if (stats.showingOriginal) return false;
      const raw = settings.idleFill;
      if (raw === "off" || raw === false) return false;
      if (raw === "on" || raw === true) return true;
      return stats.chars <= (settings.idleFillMaxChars || DEFAULTS.idleFillMaxChars);
    }

    function eligibleLeft() {
      for (const p of [0, 1]) if (buckets[p].some((u) => u.state === "pending" && u.prio === p)) return true;
      const idle = Date.now() - lastScrollAt > settings.idleDelayMs;
      if ((settings.mode === "full" || (idleFillOn() && idle)) && buckets[2].some((u) => u.state === "pending" && u.prio === 2) && batches.size === 0) return true;
      return false;
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (active) {
          if (Date.now() < pauseUntil) {
            await new Promise((r) => setTimeout(r, Math.min(2000, pauseUntil - Date.now() + 20)));
            continue;
          }
          if (batches.size >= Math.max(1, settings.concurrency)) {
            await new Promise((r) => setTimeout(r, 40));
            continue;
          }
          const picked = pickBatch();
          if (!picked) {
            if (scanRunning) {
              await new Promise((r) => setTimeout(r, 80));
              continue;
            }
            if (resync() > 0) continue;
            break;
          }
          sendBatch(picked);
        }
      } finally {
        pumping = false;
      }
      updateStatus();
      scheduleIdleFill();
    }

    function scheduleIdleFill() {
      if (idleTimer || !active || !idleFillOn() || settings.mode === "full") return;
      if (!buckets[2].some((u) => u.state === "pending" && u.prio === 2)) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        pump();
      }, settings.idleDelayMs + 100);
    }

    function updateStatus() {
      if (stats.blocked) {
        stats.status = "blocked";
      } else if (!active) {
        stats.status = stats.showingOriginal ? "original" : "paused";
      } else if (batches.size || eligibleLeft() || scanRunning) {
        stats.status = "running";
      } else {
        stats.status = "done";
      }
      if (startedAt && !finishedAt) {
        if (stats.status === "running") elapsedMs = Date.now() - startedAt;
        else if (stats.status === "done") {
          finishedAt = Date.now();
          elapsedMs = finishedAt - startedAt;
        }
      } else if (startedAt && finishedAt && stats.status === "running") {
        // 滚动或动态内容带来新任务时继续累计耗时，而不是停在首次完成时间。
        finishedAt = 0;
        elapsedMs = Date.now() - startedAt;
      }
      notify();
    }

    function pickState() {
      if (active && startedAt && !finishedAt) elapsedMs = Date.now() - startedAt;
      let stale = 0;
      for (const u of units) if (u.state === "stale") stale++;
      const rawTotal = units.length;
      return {
        ...stats,
        rawTotal,
        stale,
        total: Math.max(0, rawTotal - stale),
        cachedUnits: stats.cachedUnits,
        elapsedMs,
        durationMs: finishedAt && startedAt ? finishedAt - startedAt : 0,
        idleFillActive: idleFillOn(),
        queue: units.filter((u) => u.state === "pending" || u.state === "inflight").length,
      };
    }

    function notify() {
      if (onChange) onChange(pickState());
    }

    function scheduleProgress() {
      if (progressTimer) return;
      progressTimer = setTimeout(() => {
        progressTimer = null;
        updateStatus();
        if (portReady && active) port.postMessage({ t: MSG.PROGRESS, done: stats.done, total: stats.total, status: stats.status, failed: stats.failed });
      }, 350);
    }

    function isBlockedHost() {
      const host = (location.hostname || "").toLowerCase();
      return host ? window.EZ.blacklist.hostMatchesBlacklist(host, settings.blacklist) : false;
    }

    function scanRoot() {
      if ((settings.scope || "all") !== "article") return document.body;
      const root = document.querySelector("article, main, [role='main']");
      return root || document.body;
    }

    function pageLooksTranslated() {
      const sample = document.body ? document.body.innerText.slice(0, 8000) : "";
      if (!sample) return false;
      const cjk = (sample.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
      const latin = (sample.match(/[A-Za-z]/g) || []).length;
      return cjk >= 40 && cjk > latin * 1.2;
    }

    function applyBlocked() {
      const host = (location.hostname || "").toLowerCase();
      stats.blocked = true;
      stats.blockedHost = host;
      stats.errorCode = "blocked";
      stats.errorTitle = "免翻译站点";
      stats.error = `当前站点 ${host} 在免翻译名单内，页面未翻译，也没有发送任何请求。可在设置页的站点黑名单中移除它。`;
      stats.retryable = false;
      stats.status = "blocked";
      updateElapsed();
      notify();
      if (portReady) port.postMessage({ t: MSG.PROGRESS, done: 0, total: 0 });
    }

    function updateElapsed() {
      if (startedAt && !finishedAt) elapsedMs = Date.now() - startedAt;
    }

    function ensureSettings() {
      return settingsLoaded || loadSettings();
    }

    async function start(options) {
      await ensureSettings();
      if (isBlockedHost()) {
        active = false;
        applyBlocked();
        return;
      }
      if (options && options.auto && !(options && options.force) && pageLooksTranslated()) {
        active = false;
        stats.skipped = true;
        stats.status = "skipped";
        stats.error = "";
        stats.errorCode = "";
        stats.errorTitle = "";
        stats.errorDetail = "";
        updateElapsed();
        notify();
        return;
      }
      stats.skipped = false;
      if (stats.blocked) {
        stats.blocked = false;
        stats.blockedHost = "";
        stats.error = null;
        stats.errorCode = "";
        stats.errorTitle = "";
        stats.errorDetail = "";
      }
      if (active && !stats.showingOriginal) return;
      active = true;
      stats.error = null;
      stats.errorCode = "";
      stats.errorTitle = "";
      stats.errorDetail = "";
      stats.retryable = false;
      if (stats.showingOriginal) {
        reapply();
        return;
      }
      if (!startedAt || finishedAt) {
        startedAt = Date.now();
        finishedAt = 0;
        elapsedMs = 0;
      }
      ensurePort();
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      if (!(options && options.rescan === false)) scan();
      updateStatus();
      pump();
    }

    async function retry() {
      await ensureSettings();
      if (isBlockedHost()) {
        applyBlocked();
        return;
      }
      stats.error = null;
      stats.errorCode = "";
      stats.errorTitle = "";
      stats.errorDetail = "";
      stats.retryable = false;
      stats.errors = [];
      pauseUntil = 0;
      stats.waitMs = 0;
      let revived = 0;
      for (const u of units) {
        if (u.state !== "failed") continue;
        u.state = "pending";
        u.attempts = 0;
        u.requeues = 0;
        if (typeof u.prio !== "number" || u.prio < 0 || u.prio > 2) u.prio = 2;
        buckets[u.prio].push(u);
        bucketed.add(u);
        revived++;
      }
      if (revived) stats.failed = Math.max(0, stats.failed - revived);
      if (active) {
        updateStatus();
        pump();
        return;
      }
      await start({ rescan: units.length === 0 });
    }

    function stop() {
      active = false;
      for (const [id, batch] of batches) {
        if (batch.watchdog) clearTimeout(batch.watchdog);
        if (portReady) port.postMessage({ t: MSG.CANCEL, id });
        for (const u of batch.units) requeue(u);
      }
      batches.clear();
      updateStatus();
    }

    function lookupOriginal(el) {
      let node = el;
      while (node && node !== document.body) {
        const unit = unitMap.get(node);
        if (unit && unit.state === "done") {
          const original = unit.segs.map((s) => s.raw.trim()).filter(Boolean).join(" ");
          const translated = unit.segs.map((s) => s.translated || "").join(" ").trim();
          if (original && translated && original !== translated) return { original, translated };
          return null;
        }
        node = node.parentElement;
      }
      return null;
    }

    function restore() {
      for (const w of writes) {
        if (w.node.isConnected) {
          w.node.nodeValue = w.original;
          w.node.__ezWritten = false;
        }
      }
      stats.showingOriginal = true;
      updateStatus();
    }

    function reapply() {
      for (const w of writes) {
        if (w.node.isConnected) {
          w.node.nodeValue = w.lead + w.translated + w.trail;
          w.node.__ezWritten = true;
        }
      }
      stats.showingOriginal = false;
      updateStatus();
    }

    async function loadSettings() {
      if (!settingsLoaded) {
        settingsLoaded = (async () => {
          const stored = await chrome.storage.local.get("settings");
          if (stored.settings) settings = { ...DEFAULTS, ...stored.settings };
        })();
      }
      return settingsLoaded;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings || !changes.settings.newValue) return;
      const prevScreens = settings.prefetchScreens;
      const prevScope = settings.scope;
      settings = { ...DEFAULTS, ...changes.settings.newValue };
      if (settings.prefetchScreens !== prevScreens) rebuildNearObserver();
      if (isBlockedHost()) {
        if (active) stop();
        applyBlocked();
      } else if (stats.blocked) {
        stats.blocked = false;
        stats.blockedHost = "";
        stats.error = null;
        stats.errorCode = "";
        stats.errorTitle = "";
        stats.errorDetail = "";
        updateStatus();
      }
      if (prevScope !== undefined && prevScope !== settings.scope && active) scan();
    });

    return {
      start,
      stop,
      retry,
      restore,
      reapply,
      lookupOriginal,
      loadSettings,
      getState: pickState,
      get settings() { return settings; },
      isActive: () => active,
      scanAgain() { scan(); pump(); },
    };
  }

  window.EZ.createEngine = createEngine;
})();
