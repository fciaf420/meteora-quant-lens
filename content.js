/* Meteora Quant Lens — content.js (Agent B)
 * Content-script UI: HUD panel, fees/TVL truth badge, form guardian.
 * NEVER break the page: every entry point wrapped in try/catch, idempotent mounts.
 * Talks to background via chrome.runtime message contract (see SPEC.md).
 */
(function () {
  "use strict";

  // ---- guard against double injection ------------------------------------
  if (window.__mqlLoaded) return;
  window.__mqlLoaded = true;

  // ---- constants ---------------------------------------------------------
  var POOL_RE = /\/dlmm\/([1-9A-HJ-NP-Za-km-z]{32,44})/;
  var POLL_MS = 60000;      // background poll cadence while visible
  var OBS_DEBOUNCE = 500;   // mutation observer debounce
  var INPUT_DEBOUNCE = 500; // range input debounce
  var AUTOFILL_CHECK_MS = 1800; // when to compare range after Auto-Fill click

  // Default (auto-fill) range fingerprints. Auto-Fill snaps to ~±default and
  // Total Bins to 69/70. We treat these as "reset" indicators.
  var DEFAULT_BIN_COUNTS = [69, 70];

  // ---- pool-age-aware fee baselines (mirror of background.js) ------------
  // Baselines stored before this basis divided a young pool's since-creation
  // fee/TVL by the full window (a 1.7h pool's "24h normal" read ~14x too low).
  // Rescale them by the pool's age when they were recorded.
  var FEE_BASIS = "pool-age-v1";
  function poolAgeHoursAt(createdAt, atMs) {
    var n = Number(createdAt);
    if (!isFinite(n) || n <= 0) return null;
    var ms = n > 1e11 ? n : n * 1000;
    var h = (Number(atMs) - ms) / 3600e3;
    return isFinite(h) && h >= 0 ? h : null;
  }
  function legacyWindowRate(value, windowH, recordedAtMs, poolCreatedAt, basis) {
    var v = Number(value);
    if (!(v > 0)) return null;
    if (basis === FEE_BASIS) return v;
    var ageAt = poolAgeHoursAt(poolCreatedAt, recordedAtMs);
    if (ageAt == null || ageAt >= windowH) return v;
    return v * windowH / Math.min(windowH, Math.max(ageAt, 0.25));
  }
  // "24h" label for a pool rate: since launch when the pool is younger than a day
  function feeWindowLabel(d) {
    if (!d || d.poolStage === "MATURE" || d.poolStage === "UNKNOWN" || !isFinite(Number(d.poolAgeH))) return "24h";
    var h = Number(d.poolAgeH);
    return "since launch (" + (h < 1 ? Math.max(1, Math.round(h * 60)) + "m" : (Math.round(h * 10) / 10) + "h") + ")";
  }

  // ---- module state ------------------------------------------------------
  var state = {
    pool: null,          // current pool address
    data: null,          // last getPoolData response
    lastFetchTs: 0,      // Date.now of last successful fetch
    pollTimer: null,
    obs: null,
    tickTimer: null,     // "refreshed Xs ago" ticker
    guardDebounce: null,
    autofillTimer: null,
    lastRange: null,     // { min, max, bins }
    fetching: false,
    accumDecayDataTs: 0,
    accumDecayCount: 0,
    accumPositionKey: null,
    accumBaselineTs: 0,
  };

  // ---- tiny utils --------------------------------------------------------
  function log() {
    try {
      if (window.__mqlDebug) console.log.apply(console, ["[MQL]"].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { log("err", e && e.message); }
    };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtNum(v, dp) {
    if (v == null || isNaN(v)) return "—";
    var d = dp == null ? 2 : dp;
    return Number(v).toFixed(d);
  }

  function fmtPct(v, dp) {
    if (v == null || isNaN(v)) return "—";
    return fmtNum(v, dp) + "%";
  }

  function fmtCompact(v) {
    if (v == null || isNaN(v)) return "—";
    var n = Number(v);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  function getPoolAddress() {
    try {
      var m = location.pathname.match(POOL_RE);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  // When the extension is reloaded/updated, this (now-orphaned) content script's
  // chrome.* APIs die permanently — retrying can never succeed; only a page
  // refresh reconnects. Detect it once, stop all polling, prompt to refresh.
  var ctxDead = false;
  function markCtxDead() {
    if (ctxDead) return;
    ctxDead = true;
    try { stopPolling(); } catch (e) {}
    try { if (comboFlow && comboFlow.timer) { clearInterval(comboFlow.timer); comboFlow.timer = null; } } catch (e) {}
    try { renderDeadPrompt(); } catch (e) {}
  }
  function renderDeadPrompt() {
    var hud = document.getElementById("mql-hud");
    if (!hud) return;
    hud.innerHTML = "";
    var row = document.createElement("div");
    row.className = "mql-row";
    row.textContent = "\u26a1 Lens was updated \u2014 refresh this page to reconnect.";
    hud.appendChild(row);
    var btn = document.createElement("button");
    btn.className = "mql-refresh";
    btn.type = "button";
    btn.textContent = "\u21bb refresh page";
    btn.addEventListener("click", function () { location.reload(); });
    hud.appendChild(btn);
  }
  function isCtxDeadError(m) { return /context invalidated/i.test(String(m || "")); }
  function sendMessage(msg) {
    return new Promise(function (resolve) {
      if (ctxDead) { resolve({ ok: false, error: "extension updated \u2014 refresh page" }); return; }
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          // swallow "message port closed" / context invalidated errors
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            if (isCtxDeadError(err.message)) markCtxDead();
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        if (isCtxDeadError(e && e.message)) markCtxDead();
        resolve({ ok: false, error: e && e.message });
      }
    });
  }

  // ========================================================================
  // DATA FETCH + POLLING
  // ========================================================================
  var fetchData = safe(function fetchData() {
    if (ctxDead) return;
    if (!state.pool || state.fetching) return;
    if (document.visibilityState !== "visible") return;
    state.fetching = true;
    sendMessage({ type: "getPoolData", pool: state.pool }).then(safe(function (resp) {
      state.fetching = false;
      if (resp && resp.ok) {
        state.data = resp;
        state.lastFetchTs = Date.now();
        renderHUD(); renderPosWatch(); pollMyPosition();
        fetchPanda();
        loadTracker(false);
        (function pwRetry(n) {
          if (n <= 0) return;
          setTimeout(safe(function () {
            if (!document.getElementById("mql-poswatch") && state.data) { renderPosWatch(); pwRetry(n - 1); }
          }), 3000);
        })(12);
        renderFeeBadge();
        if (MARKS_ENABLED && marksState.pool !== state.pool) { marksState.tries = 0; pushMarksToChart(); }
        // renderGuard last + isolated: it can throw (see debug 2026-08-06) and
        // must never take down the rest of the render chain with it
        try { renderGuard(); } catch (eG) { window.postMessage({ mql: 'tv-push-debug', why: 'guard-threw', err: String(eG && eG.message || eG) }, '*'); }
      } else if (!ctxDead) {
        renderHUDError(resp && resp.error);
      }
    }));
  });

  var startPolling = safe(function startPolling() {
    stopPolling();
    // immediate fetch then interval
    fetchData();
    state.pollTimer = setInterval(safe(function () {
      if (document.visibilityState === "visible") fetchData();
    }), POLL_MS);
    // ticker to update "refreshed Xs ago"
    state.tickTimer = setInterval(safe(updateAgeLabel), 1000);
  });

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  }

  // ========================================================================
  // 1. HUD PANEL (#mql-hud)
  // ========================================================================
  function findHudAnchor() {
    return document.querySelector('[data-sentry-component="PoolDetails"]') ||
      (function () {
        var stat = document.querySelector('[data-sentry-component="StatItem"]');
        return stat ? stat.parentElement : null;
      })();
  }

  var mountHUD = safe(function mountHUD() {
    if (document.getElementById("mql-hud")) return true; // idempotent
    var anchor = findHudAnchor();
    if (!anchor) return false;

    var hud = el("div", "mql-card");
    hud.id = "mql-hud";
    hud.innerHTML = ""; // built via render

    // insert above the anchor
    if (anchor.parentElement) {
      anchor.parentElement.insertBefore(hud, anchor);
    } else {
      return false;
    }
    renderHUD(); renderPosWatch(); pollMyPosition();
        (function pwRetry(n) {
          if (n <= 0) return;
          setTimeout(safe(function () {
            if (!document.getElementById("mql-poswatch") && state.data) { renderPosWatch(); pwRetry(n - 1); }
          }), 3000);
        })(12);
    return true;
  });

  function verdictClassColor(cls) {
    switch (cls) {
      case "IGNITION": return "mql-v-ignition";
      case "BASING": return "mql-v-basing";
      case "CARRY": return "mql-v-carry";
      default: return "mql-v-none";
    }
  }

  function colorForEdge(edge) {
    if (edge == null || isNaN(edge)) return "mql-neutral";
    if (edge >= 1) return "mql-good";
    if (edge >= 0.5) return "mql-warn";
    return "mql-bad";
  }


  // ---- Apply setup: pre-fill strategy + range from recommendation params ----
  function setNativeInput(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.blur && input.blur();
  }
  var applySetup = safe(function applySetup(params, btn) {
    if (!params) return;
    if (!state.data || state.data.supportedSolPair !== true) {
      if (btn) btn.textContent = "✗ requires non-SOL token X / SOL token Y";
      return;
    }
    // 1) strategy button by exact text
    var stratWrap = document.querySelector('[data-sentry-component="StrategySelection"]');
    if (stratWrap) {
      var btns = stratWrap.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || "").replace(/\s+/g, " ").trim().endsWith(params.strategy || "Spot")) { btns[i].click(); break; }
      }
    }
    // 2) range inputs (after slight delay so strategy click settles)
    setTimeout(safe(function () {
      var bpis = document.querySelectorAll('[data-sentry-component="BinPriceInput"] input');
      if (bpis.length >= 2) {
        setNativeInput(bpis[0], String(params.minPct));
        setTimeout(safe(function () {
          setNativeInput(bpis[1], String(params.maxPct));
          if (btn) { btn.textContent = "✓ Applied — enter amount, then click Create Position"; btn.classList.add("mql-applied"); }
          if (params.mode === "single") {
            setTimeout(safe(function(){ if (btn) btn.textContent = "✓ Applied (single-sided: keep Auto-Fill OFF, SOL only)"; }), 400);
          }
        }), 500);
      } else if (btn) { btn.textContent = "✗ form not found — open Create Position panel"; }
    }), 400);
  });


  // ========================================================================
  // ACCUM COMBO — deep single-sided SOL accumulation band, two legs in one
  // range: Bid-Ask base (~70%, bottom-weighted) + Spot layer (~30%, uniform).
  // ALL thresholds below are structured priors pending calibration (PLAYBOOK).
  // ========================================================================
  var comboUI = { open: false, total: 1.0 };

  function currentCompleted5mTs() {
    return Math.floor(Date.now() / 300000) * 300 - 300;
  }

  function bidAskCandleFresh(ba) {
    return !!(ba && ba.candleAnalysis
      && ba.candleQualification && ba.candleQualification.ready === true
      && Number(ba.candleAnalysis.latestCompletedTs) === currentCompleted5mTs());
  }

  // Manual BID ASK override deliberately bypasses the candle/base
  // qualification, but it must still have a real executable plan: supported
  // X/SOL orientation, finite depth and split, and two practical non-zero
  // rounded legs. Keep this structural check separate from accumComboCheck so
  // the normal READY path remains unchanged.
  function bidAskOverridePlan(d) {
    var ba = d && d.bidAsk;
    var reasons = [];
    if (!d || d.ok !== true) reasons.push("BID ASK plan unavailable — refresh pool data");
    if (!d || d.supportedSolPair !== true) reasons.push("requires a non-SOL token X and wrapped SOL token Y");
    var depth = Number(ba && ba.depthPct);
    if (!isFinite(depth) || depth <= 0 || depth >= 100) reasons.push("valid BID ASK depth is unavailable");
    var sharePct = Number(ba && ba.allocation && ba.allocation.bidAskPct);
    var share = sharePct / 100;
    if (!isFinite(sharePct) || !isFinite(share) || share <= 0 || share >= 1) reasons.push("valid Bid-Ask / Spot split is unavailable");
    // What the override actually skips: only checks that ran and failed, in
    // plain words, each once. Candle checks only run after the base checks pass,
    // so when they never ran they are reported as "not run", not as 11 failures
    // (the old list mixed raw keys, long reason text and duplicates).
    var ignored = [];
    var gates = ba && Array.isArray(ba.gates) ? ba.gates : [];
    gates.forEach(function (g) {
      if (g && g.pass === false) ignored.push(String(g.label || g.key || "base gate"));
    });
    var baseFailed = ignored.length > 0;
    var ca = (ba && ba.candleAnalysis) || (d && d.candleAnalysis) || null;
    var candlesRan = !!ca && ca.state !== "NOT_COLLECTED" && (ca.state != null || ca.latestCompletedTs != null);
    var cq = ba && ba.candleQualification;
    if (!candlesRan) {
      if (!(cq && cq.ready === true)) ignored.push(baseFailed ? "candle checks not run (base checks failing)" : "candle checks not run yet");
    } else {
      var candleCurrent = Number(ca.latestCompletedTs) === currentCompleted5mTs();
      if (!candleCurrent) ignored.push("candle data stale");
      (cq && Array.isArray(cq.reasons) ? cq.reasons : []).forEach(function (key) {
        if (key === "fresh" && !candleCurrent) return;   // same fact as "candle data stale"
        ignored.push(CANDLE_GATE_LABELS[key] || String(key));
      });
      if (!cq) ignored.push("candle qualification unavailable");
    }
    var snapTs = Number(d && d.ts);
    if (!isFinite(snapTs) || Date.now() - snapTs > 120000) ignored.push("pool data older than 2 min");
    var uniqueIgnored = [];
    ignored.forEach(function (reason) {
      if (uniqueIgnored.indexOf(reason) < 0) uniqueIgnored.push(reason);
    });
    return {
      ok: reasons.length === 0,
      depth: depth,
      share: share,
      sharePct: sharePct,
      spotPct: 100 - sharePct,
      reasons: reasons,
      ignoredGates: uniqueIgnored,
      signal: ba || null
    };
  }

  function validateComboTotal(value, share) {
    var raw = typeof value === "number" ? value : String(value == null ? "" : value).trim();
    var total = typeof raw === "number" ? raw : Number(raw);
    if (!isFinite(total) || total <= 0) return { ok: false, reason: "enter a positive TOTAL SOL amount" };
    var s = Number(share);
    if (!isFinite(s) || s <= 0 || s >= 1) return { ok: false, reason: "BID ASK split is unavailable" };
    var bidAskSol = Math.round(s * total * 1000) / 1000;
    var spotSol = Math.round((1 - s) * total * 1000) / 1000;
    if (!isFinite(bidAskSol) || !isFinite(spotSol) || !(bidAskSol > 0) || !(spotSol > 0)) {
      return { ok: false, reason: "TOTAL SOL is too small for two non-zero 0.001 SOL legs" };
    }
    return { ok: true, totalSol: total, bidAskSol: bidAskSol, spotSol: spotSol };
  }

  // Plain-word names for the candle checks (background candle-analysis keys)
  var CANDLE_GATE_LABELS = {
    fresh: "latest 5m candle",
    history: "complete candle history",
    volume: "last hour volume \u2265 half a typical hour",
    repeatedRecoveries: "2+ recovered 5% dips",
    recentRecovery: "a recovery in the last 3h",
    support: "flat-or-rising 15m lows",
    cycle: "current dip bouncing"
  };

  // Identity of an override = the plan you are confirming: pool, range, split,
  // amount. NOT the data snapshot time: the HUD refreshes every 60s, and a
  // refresh landing between the two clicks used to reset/reject the override
  // even though nothing about the plan changed.
  function sameOverrideSnapshot(a, b) {
    return !!(a && b && a.pool === b.pool
      && a.depth === b.depth && a.share === b.share && a.totalSol === b.totalSol);
  }
  // one confirmation state machine per pool+plan, kept outside the button so a
  // HUD re-render (new button element) does not drop the first click
  var overrideConfirmations = {};
  function overrideConfirmationFor(key) {
    if (!overrideConfirmations[key]) {
      overrideConfirmations[key] = createAccumOverrideConfirmation(8000, function () {
        var b = document.getElementById && document.getElementById("mql-ba-override");
        if (b) b.textContent = "\u26a0 Override BID ASK anyway (2 clicks)";
      });
    }
    return overrideConfirmations[key];
  }

  // Small pure seam for the two-click override confirmation. The DOM button
  // uses this state machine so a pool/plan change between clicks cannot apply
  // the first click's stale closure.
  function createAccumOverrideConfirmation(timeoutMs, onExpire) {
    var armed = null;
    var timer = null;
    var ttl = isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;
    function clear() {
      if (timer) { clearTimeout(timer); timer = null; }
      armed = null;
    }
    function arm(snapshot) {
      armed = { snapshot: snapshot, armedAt: Date.now() };
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        armed = null;
        if (typeof onExpire === "function") onExpire();
      }, ttl);
    }
    return {
      click: function (snapshot) {
        if (!armed) {
          arm(snapshot);
          return { armed: true, snapshot: snapshot };
        }
        if (Date.now() - armed.armedAt > ttl) {
          clear();
          if (typeof onExpire === "function") onExpire();
          return { armed: false, expired: true, reason: "confirmation expired — click again to arm" };
        }
        if (!sameOverrideSnapshot(armed.snapshot, snapshot)) {
          clear();
          return { armed: false, rejected: true, reason: "pool or BID ASK plan changed — confirm again" };
        }
        var confirmed = armed.snapshot;
        clear();
        return { armed: false, confirmed: true, snapshot: confirmed };
      },
      reset: clear,
      isArmed: function () { return !!armed; }
    };
  }

  function accumComboCheck(d) {
    if (!d || !d.ok) return null;
    if (d.bidAsk) {
      var ba = d.bidAsk;
      var now = Date.now();
      var snapshotTs = Number(d.ts);
      var stale = !isFinite(snapshotTs) || now < snapshotTs || now - snapshotTs > 120000;
      var candleCurrent = !!(ba.candleAnalysis
        && Number(ba.candleAnalysis.latestCompletedTs) === currentCompleted5mTs());
      var candleStale = !bidAskCandleFresh(ba);
      if (ba.ready && ba.state === "READY" && !stale && !candleStale && d.supportedSolPair === true
          && ba.depthPct > 0 && ba.allocation && ba.allocation.bidAskPct > 0) {
        return { show: "full", state: "READY", depth: ba.depthPct,
          share: ba.allocation.bidAskPct / 100, reasons: ba.reasons || [], signal: ba };
      }
      var reasons = (ba.reasons || []).filter(function (r) {
        return !/base and candle qualification gates pass/i.test(String(r));
      });
      var ca = ba.candleAnalysis;
      var candlesRan = !!ca && ca.state !== "NOT_COLLECTED" && (ca.state != null || ca.latestCompletedTs != null);
      if (stale) reasons.unshift("✗ data stale — wait for a fresh snapshot");
      // Only call candles "stale" when they were actually loaded. When the base
      // checks fail, candles are never fetched; saying "stale" there was wrong.
      if (candlesRan && !candleCurrent) reasons.unshift("✗ candle data stale — wait for the latest completed 5m candle");
      else if (!candlesRan) reasons.push("candle checks run once the base checks pass");
      if (!reasons.length) reasons.push("BID ASK candle qualification is not complete");
      var state = ba.state || "WAIT";
      if (state === "READY") state = "WATCH";
      var overridePlan = bidAskOverridePlan(d);
      return { show: "wait", state: state, reasons: reasons, signal: ba, overridePlan: overridePlan };
    }
    // A missing BID ASK payload is unsafe to treat as a legacy-compatible
    // signal. The background worker is the single owner of these gates.
    return { show: "wait", state: "WAIT", reasons: ["BID ASK signal unavailable — reload the extension"], signal: null };
  }

  // Test-only seam: the production page never sets this object. Keeping the
  // pure display/guide gate observable lets the VM suite verify that a stale
  // or legacy READY payload cannot enable a manual position flow.
  if (window.__mqlTestExports && typeof window.__mqlTestExports === "object") {
    window.__mqlTestExports.accumComboCheck = accumComboCheck;
    window.__mqlTestExports.bidAskOverridePlan = bidAskOverridePlan;
    window.__mqlTestExports.validateComboTotal = validateComboTotal;
    window.__mqlTestExports.createAccumOverrideConfirmation = createAccumOverrideConfirmation;
    window.__mqlTestExports.bidAskBinPlan = bidAskBinPlan;
  }

  function appendCandleEvidence(body, analysis) {
    if (!analysis || analysis.state === "NOT_COLLECTED") return;
    var stateLabel = analysis.state === "LIMITED" ? "LIMITED HISTORY" : analysis.state;
    if (analysis.state === "WAIT" || !analysis.events) {
      var why = String(analysis.reason || "history unavailable").replace(/-/g, " ");
      body.appendChild(el("div", "mql-accum-line mql-muted", "CANDLE EVIDENCE · WAIT — " + why));
      body.appendChild(el("div", "mql-accum-prior", "event statistics withheld until completed candle history is current and contiguous"));
      return;
    }
    var e = analysis.events;
    body.appendChild(el("div", "mql-accum-line",
      "CANDLE EVIDENCE · " + stateLabel + " · " + fmtNum(analysis.historyHours, 2) + "h · 5% pullbacks " + e.total +
      ": " + e.recovered + " recovered · " + e.timedOut + " timed out · " + e.pending + " pending"));
    var outcome = e.matured > 0
      ? e.recovered + "/" + e.matured + " matured outcomes recovered within 6h (" + fmtNum(e.recoveryRatePct, 1) + "% descriptive; not a win probability)"
      : "no matured outcomes yet — current events are still within the six-hour observation window";
    body.appendChild(el("div", "mql-accum-line mql-muted", outcome));
    var drawdown = analysis.currentDrawdownPct == null ? "n/a" : fmtNum(analysis.currentDrawdownPct, 1) + "%";
    var volume = analysis.recentVolumeRatio == null ? "n/a" : fmtNum(analysis.recentVolumeRatio, 2) + "×";
    body.appendChild(el("div", "mql-accum-line mql-muted",
      "median max dip " + (analysis.medianDepthPct == null ? "n/a" : fmtNum(analysis.medianDepthPct, 1) + "%") +
      " · median recovery " + (analysis.medianRecoveryMinutes == null ? "n/a" : fmtNum(analysis.medianRecoveryMinutes, 0) + "m") +
      " · current close drawdown " + drawdown));
    body.appendChild(el("div", "mql-accum-line mql-muted",
      "last-hour total pool volume / prior hourly median " + volume +
      " (" + (analysis.volumeBaselineHours || 0) + " baseline hours)"));
    body.appendChild(el("div", "mql-accum-prior",
      "BID ASK candle checks: 0.5× volume floor · 2 recoveries with 1 within 3h · three wall-clock 15m support lows, each the minimum of 3 completed 5m closes · provisional thresholds"));
  }

  // Bins and rent for a 0 -> -depth range, from the DLMM bin formula
  // P_i = (1 + binStep/10000)^i (docs.meteora.ag/core-products/dlmm/formulas).
  // Bins are grouped in bin arrays of 70; creating an array nobody has used costs
  // ~0.075 SOL non-refundable (Meteora getting-started docs). One position holds
  // at most 1,400 bins. Worst case shown; Meteora prints the exact cost pre-sign.
  function bidAskBinPlan(binStep, depth) {
    var bs = Number(binStep), dp = Number(depth);
    if (!(bs > 0) || !(dp > 0) || !(dp < 100)) return null;
    var bins = Math.ceil(Math.abs(Math.log(1 - dp / 100)) / Math.log(1 + bs / 10000)) + 1;
    var arrays = Math.ceil(bins / 70) + 1;
    return { bins: bins, maxArrays: arrays, maxNonRefundableSol: Math.round(arrays * 0.075 * 100) / 100, overMax: bins > 1400 };
  }
  function appendBidAskPoolFacts(body, d, depth) {
    try {
      var pool = (d && d.pool) || {};
      var plan = bidAskBinPlan(pool.binStep, depth);
      if (plan) {
        body.appendChild(el("div", plan.overMax ? "mql-rec-warn" : "mql-accum-note",
          "\u2248" + plan.bins + " bins at " + pool.binStep + " bps" +
          (plan.overMax ? " \u2014 over the 1,400-bin max for one position" : "") +
          " \u00b7 if nobody has used these price levels: up to ~" + plan.maxNonRefundableSol +
          " SOL non-refundable bin-array rent (+ refundable position rent). Meteora shows the exact cost before you sign."));
      }
      var sym = (pool.tokenX && pool.tokenX.symbol) || "the token";
      if (pool.collectFeeMode === "InputOnly") {
        body.appendChild(el("div", "mql-accum-note", "fees: paid in " + sym + " when sellers hit your bins (this pool collects fees in the token entering the swap)"));
      } else if (pool.collectFeeMode === "OnlyY") {
        body.appendChild(el("div", "mql-accum-note", "fees: paid in SOL (this pool collects all fees in token Y)"));
      }
    } catch (e) {}
  }

  function appendAccumTotalControls(body, chk, total, actionText, onValid) {
    var splitLine = el("div", "mql-accum-line");
    splitLine.id = "mql-accum-split";
    var setSplitText = function (tot) {
      var a = Math.round(chk.share * tot * 1000) / 1000;
      var b = Math.round((1 - chk.share) * tot * 1000) / 1000;
      splitLine.textContent = "split " + Math.round(chk.share * 100) + "/" + Math.round((1 - chk.share) * 100) +
        ": " + a + " SOL Bid-Ask + " + b + " SOL Spot (same range)";
    };
    setSplitText(total);
    tipify(splitLine, "accumsplit");
    body.appendChild(splitLine);
    var totRow = el("div", "mql-accum-total");
    totRow.appendChild(el("span", "", "your chosen TOTAL SOL (both legs)"));
    var totInp = el("input", "");
    totInp.type = "number"; totInp.step = "0.001"; totInp.min = "0.001"; totInp.value = String(total);
    totInp.addEventListener("input", safe(function () {
      var check = validateComboTotal(totInp.value, chk.share);
      if (check.ok) {
        comboUI.total = check.totalSol;
        try { chrome.storage.local.set({ mqlComboTotal: check.totalSol }); } catch (e) {}
        totInp.classList.remove("mql-input-invalid");
        setSplitText(check.totalSol);
      } else {
        totInp.classList.add("mql-input-invalid");
      }
    }));
    totRow.appendChild(totInp);
    body.appendChild(totRow);
    var actionBtn = el("button", "mql-apply", actionText);
    actionBtn.addEventListener("click", safe(function () {
      var check = validateComboTotal(totInp.value, chk.share);
      if (!check.ok) {
        totInp.classList.add("mql-input-invalid");
        actionBtn.textContent = "✗ " + check.reason;
        return;
      }
      totInp.classList.remove("mql-input-invalid");
      onValid(check, actionBtn, totInp);
    }));
    body.appendChild(actionBtn);
    return { input: totInp, button: actionBtn, setSplitText: setSplitText };
  }

  var renderAccumBlock = safe(function renderAccumBlock(hud, d) {
    var chk = accumComboCheck(d);
    if (!chk) return;
    var wrap = el("div", "mql-accum");
    var head = el("div", "mql-accum-head");
    var title = el("span", "mql-accum-title", "🪣 BID ASK · " + (chk.state || (chk.show === "full" ? "READY" : "WAIT")));
    tipify(title, "accum");
    head.appendChild(title);
    head.appendChild(el("span", "mql-accum-caret", comboUI.open ? "▾" : "▸"));
    head.addEventListener("click", safe(function (e) {
      if (e.target && e.target.closest && e.target.closest("input,button")) return;
      comboUI.open = !comboUI.open; renderHUD();
    }));
    wrap.appendChild(head);
    if (comboUI.open) {
      var body = el("div", "mql-accum-body");
      body.appendChild(el("div", "mql-accum-line", "Bid-Ask + Spot accumulation · manual wallet-approved two-leg entry"));
      if (chk.show !== "full") {
        (chk.reasons || [chk.volMsg || "signal gates not met"]).slice(0, 4).forEach(function (reason) {
          body.appendChild(el("div", "mql-accum-note", reason));
        });
        appendCandleEvidence(body, d.candleAnalysis || (chk.signal && chk.signal.candleAnalysis), chk.signal && chk.signal.candleQualification);
        var ovPlan = chk.overridePlan;
        if (!ovPlan || !ovPlan.ok) {
          body.appendChild(el("div", "mql-accum-prior", (chk.state || "WAIT") + " — manual override unavailable: " +
            ((ovPlan && ovPlan.reasons || ["BID ASK plan unavailable"]).join(" · "))));
          wrap.appendChild(body); hud.appendChild(wrap); return;
        }
        body.appendChild(el("div", "mql-accum-line", "override plan · range 0% → -" + ovPlan.depth + "% · " +
          Math.round(ovPlan.share * 100) + "/" + Math.round((1 - ovPlan.share) * 100) + " Bid-Ask / Spot"));
        appendBidAskPoolFacts(body, d, ovPlan.depth);
        body.appendChild(el("div", "mql-accum-note", "⚠ Intentional override: standard BID ASK gates are ignored only after two clicks; review every failed gate."));
        body.appendChild(el("div", "mql-accum-note", "ignored gates: " +
          (ovPlan.ignoredGates.length ? ovPlan.ignoredGates.join(" · ") : "none reported")));
        var renderedOverrideIdentity = {
          pool: state.pool, dataTs: Number(d.ts), depth: ovPlan.depth, share: ovPlan.share
        };
        var overrideTotal = isFinite(Number(comboUI.total)) && Number(comboUI.total) > 0 ? Number(comboUI.total) : 1.0;
        var ovControls = appendAccumTotalControls(body, { share: ovPlan.share }, overrideTotal,
          "⚠ Override BID ASK anyway (2 clicks)", function (check, button) {
            var liveGateCheck = accumComboCheck(state.data);
            var planNow = liveGateCheck && liveGateCheck.overridePlan;
            if (!planNow) planNow = bidAskOverridePlan(state.data);
            if (!planNow || !planNow.ok || state.pool !== renderedOverrideIdentity.pool
                || planNow.depth !== renderedOverrideIdentity.depth
                || planNow.share !== renderedOverrideIdentity.share) {
              button.textContent = "✗ pool or BID ASK plan changed — refresh and review";
              return;
            }
            var snapshot = {
              pool: state.pool, dataTs: Number(state.data && state.data.ts), depth: planNow.depth,
              share: planNow.share, totalSol: check.totalSol,
              ignoredGates: planNow.ignoredGates.slice(), plan: planNow
            };
            if (!planNow.ok || !isFinite(snapshot.dataTs)) {
              button.textContent = "✗ BID ASK plan changed — refresh and review";
              return;
            }
            button.id = "mql-ba-override";
            var confirmation = overrideConfirmationFor(snapshot.pool + "|" + snapshot.depth + "|" + snapshot.share);
            var result = confirmation.click(snapshot);
            if (result.confirmed) {
              var finalGateCheck = accumComboCheck(state.data);
              var currentPlan = finalGateCheck && finalGateCheck.overridePlan;
              if (!currentPlan) currentPlan = bidAskOverridePlan(state.data);
              var amountCheck = validateComboTotal(snapshot.totalSol, currentPlan.share);
              var currentSnapshot = {
                pool: state.pool, dataTs: Number(state.data && state.data.ts), depth: currentPlan.depth,
                share: currentPlan.share, totalSol: snapshot.totalSol
              };
              if (!currentPlan.ok || !amountCheck.ok || !sameOverrideSnapshot(snapshot, currentSnapshot)) {
                button.textContent = "✗ pool or BID ASK plan changed — confirm again";
                return;
              }
              startCombo(currentPlan.depth, currentPlan.share, amountCheck.totalSol, {
                override: true, pool: snapshot.pool, dataTs: snapshot.dataTs,
                ignoredGates: snapshot.ignoredGates, plan: currentPlan
              });
              button.textContent = "⚠ Override started — review the two-leg banner";
            } else if (result.expired) {
              button.textContent = "⚠ Override BID ASK anyway (2 clicks)";
            } else if (result.rejected) {
              button.textContent = "✗ " + result.reason;
            } else {
              button.textContent = "⚠ Ignoring: " + (snapshot.ignoredGates.join(" · ") || "failed BID ASK gates") + " — click again within 8s";
            }
          });
        // a 60s refresh rebuilds this button; keep an armed first click visible
        var ovKey = renderedOverrideIdentity.pool + "|" + renderedOverrideIdentity.depth + "|" + renderedOverrideIdentity.share;
        if (ovControls && ovControls.button) {
          ovControls.button.id = "mql-ba-override";
          if (overrideConfirmations[ovKey] && overrideConfirmations[ovKey].isArmed()) {
            ovControls.button.textContent = "⚠ Armed — click again within 8s to start the override";
          }
        }
        wrap.appendChild(body); hud.appendChild(wrap); return;
      }
      var rangeLine = el("div", "mql-accum-line", "range 0% → -" + chk.depth + "% (σ-scaled depth)");
      tipify(rangeLine, "accumdepth");
      body.appendChild(rangeLine);
      appendBidAskPoolFacts(body, d, chk.depth);
      var total = isFinite(Number(comboUI.total)) && Number(comboUI.total) > 0 ? Number(comboUI.total) : 1.0;
      body.appendChild(el("div", "mql-accum-line mql-muted",
        "σ " + fmtNum(d.sigma, 0) + "%/d → depth " + chk.depth + "% · fees 1h " + fmtNum(d.feeRate1h, 1) +
        " vs " + feeWindowLabel(d) + " " + fmtNum(d.feeRate24h, 1) + "%/d (persisting) · OFI " + fmtNum(d.ofi1h, 2)));
      appendCandleEvidence(body, d.candleAnalysis || (chk.signal && chk.signal.candleAnalysis), chk.signal && chk.signal.candleQualification);
      body.appendChild(el("div", "mql-rec-warn", "⚠ directional bag risk: if the token dies you own it the whole way down — size for total loss"));
      body.appendChild(el("div", "mql-accum-prior", "uncalibrated heuristic · pool-wide fees and position costs are not modeled"));
      appendAccumTotalControls(body, chk, total, "⚡ Guide Bid-Ask + Spot (2 legs)", function (check) {
        startCombo(chk.depth, chk.share, check.totalSol);
      });
      wrap.appendChild(body);
    }
    hud.appendChild(wrap);
  });

  // ---- EVIL PANDA card (data + math live in background getPanda / evil-panda.js) ----
  var pandaUI = { open: true, tf: null, fetching: false, pinned: {}, depth: 90, shape: "Spot", armed: false };
  // Position Watch measures width as half-range / mid; a 0..-d band is d/(2-d).
  function pandaWidthPct(depth) { var d = depth / 100; return Math.round(d / (2 - d) * 1000) / 10; }
  var applyPanda = safe(function applyPanda(p, btn, override) {
    var depth = pandaUI.depth, shape = pandaUI.shape;
    var params = { strategy: shape, minPct: -depth, maxPct: 0, mode: "single" };
    applySetup(params, btn);
    var sig = p.signals || {}, sc = p.screen || {};
    var plan = { cls: override ? "PANDA_OVERRIDE" : "PANDA", profile: "PANDA", pool: state.pool, ts: Date.now(),
      widthPct: pandaWidthPct(depth), minPct: -depth, maxPct: 0, mode: "single", strategy: shape, depthPct: depth,
      timeframe: p.timeframe, entryState: sig.entry && sig.entry.state, screenState: sc.state,
      entryPrice: sig.lastClose, entryCandleTs: sig.lastClosedTs,
      entryFeeRate: (state.data && state.data.feeRate1h > 0) ? state.data.feeRate1h : null,
      feeBasis: (state.data && state.data.feeBasis) || undefined };
    try {
      chrome.storage.local.get({ mqlEntryPlan: {}, mqlOverrideJournal: [] }, safe(function (jr) {
        var plans = jr.mqlEntryPlan || {};
        plans[state.pool] = plan;
        var payload = { mqlEntryPlan: plans };
        if (override) {
          var j = jr.mqlOverrideJournal || [];
          var ignored = (sc.failed || []).concat(sc.unknown || []).map(function (k) { return "filter:" + k; });
          if (sig.entry && sig.entry.state !== "ENTRY") ignored.push("entry:" + sig.entry.state);
          j.push({ ts: Date.now(), pool: state.pool, cls: "PANDA", ignoredGates: ignored, edge: null, sigma: state.data && state.data.sigma, feeRate1h: state.data && state.data.feeRate1h });
          payload.mqlOverrideJournal = j.slice(-100);
        }
        chrome.storage.local.set(payload);
        state.entryPlan = plan;
      }));
    } catch (e) {}
  });
  var fetchPanda = safe(function fetchPanda() {
    if (ctxDead || !state.pool || pandaUI.fetching) return;
    pandaUI.fetching = true;
    var pool = state.pool;
    sendMessage({ type: "getPanda", pool: pool, timeframe: pandaUI.tf || undefined }).then(safe(function (r) {
      pandaUI.fetching = false;
      if (pool !== state.pool) return;
      state.panda = (r && r.ok) ? r : { ok: false, error: (r && r.error) || "panda data unavailable", pool: pool };
      state.panda.pool = pool;
      renderHUD();
      try { renderPosWatch(); } catch (e) {}
    }));
    try { chrome.storage.local.get({ mqlPandaPins: {} }, function (st) { pandaUI.pinned = (st && st.mqlPandaPins) || {}; }); } catch (e) {}
  });

  function pandaHeadState(p) {
    if (!p || !p.ok) return { txt: "…", cls: "mql-rec-wait" };
    var s = p.signals;
    if (s && s.exit && s.exit.state === "EXIT") {
      var ap0 = state.apiPos;
      var g0 = (ap0 && ap0.has && window.MQLEvilPanda) ? window.MQLEvilPanda.pandaExitGate({ exit: s.exit, timeframe: p.timeframe,
        fillPct: ap0.fillPct, createdAtSec: ap0.createdAt, lastClosedTs: s.lastClosedTs }) : null;
      if (g0 && g0.state === "WAITING_DUMP") return { txt: "WAITING FOR DUMP", cls: "mql-rec-wait" };
      return { txt: ap0 && ap0.has ? "EXIT" : "EXIT SIGNAL (no position)", cls: "mql-rec-scalp" };
    }
    var e = s && s.entry ? s.entry.state : "NO_DATA";
    if (p.screen && p.screen.state === "FAIL") return { txt: "FILTER FAIL · " + e, cls: "mql-rec-wait" };
    if (e === "ENTRY") return { txt: "ENTRY", cls: "mql-rec-carry" };
    return { txt: e, cls: e === "CONFIRMING" ? "mql-rec-rev" : "mql-rec-wait" };
  }

  var renderPandaBlock = safe(function renderPandaBlock(hud) {
    var p = state.panda;
    if (!p || p.pool !== state.pool) { fetchPanda(); return; }
    var wrap = el("div", "mql-accum mql-panda");
    var head = el("div", "mql-accum-head");
    var hs = pandaHeadState(p);
    var title = el("span", "mql-accum-title", "🐼 EVIL PANDA · ");
    title.appendChild(el("span", "mql-rec-pill " + hs.cls, hs.txt));
    if (p.ok) title.appendChild(el("span", "mql-sub", " " + p.timeframe));
    head.appendChild(title);
    head.appendChild(el("span", "mql-accum-caret", pandaUI.open ? "▾" : "▸"));
    head.addEventListener("click", safe(function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest("input,button")) return;
      pandaUI.open = !pandaUI.open; renderHUD();
    }));
    wrap.appendChild(head);
    if (!pandaUI.open) { hud.appendChild(wrap); return; }
    var body = el("div", "mql-accum-body");
    if (!p.ok) { body.appendChild(el("div", "mql-accum-note", p.error || "unavailable")); wrap.appendChild(body); hud.appendChild(wrap); return; }
    if (!p.hasKey) body.appendChild(el("div", "mql-rec-warn", "No GMGN key (Options) — filters INCOMPLETE, candles from Meteora pool 5m only"));

    // filters
    var sc = p.screen || { gates: [] };
    body.appendChild(el("div", "mql-accum-line", "Coin filters · " + sc.state + (p.coinStale ? " (stale)" : "")));
    var gl = el("div", "mql-panda-gates");
    (sc.gates || []).forEach(function (g) {
      var mark = g.pass === true ? "✓" : (g.pass === false ? (g.hard ? "✗" : "⚠") : "?");
      var n = el("div", "mql-accum-note mql-panda-g " + (g.pass === true ? "ok" : g.pass === false ? (g.hard ? "bad" : "soft") : "unk"), mark + " " + g.label);
      gl.appendChild(n);
    });
    body.appendChild(gl);
    var f = sc.facts || {};
    if (f.ageMin != null) body.appendChild(el("div", "mql-accum-prior", "token age " + (f.ageMin >= 120 ? (f.ageMin / 60).toFixed(1) + "h" : f.ageMin + "m") + (f.launchpad ? " · " + f.launchpad : "") + (f.holders ? " · " + f.holders + " holders" : "")));

    // entry / exit
    var s = p.signals;
    if (!s) {
      body.appendChild(el("div", "mql-accum-note", "no candles: " + (p.candleError || "unknown")));
    } else {
      var en = s.entry || {};
      var enTxt = "Entry (Supertrend 10,3): " + en.state + (en.why ? " — " + en.why : "") + (en.state === "WARMING" ? " (~" + en.etaMin + "m)" : "");
      body.appendChild(el("div", "mql-accum-line", enTxt));
      var ex = s.exit || {};
      var bits = [
        "RSI2 " + (ex.rsi == null ? "—" : ex.rsi) + (ex.rsiHot ? " 🔥" : ""),
        "BB↑ " + (ex.bbReady ? (ex.bbHit ? "above ✓" : "below") : "warming " + s.warmEtaMin.bb + "m"),
        "MACD " + (ex.macdReady ? (ex.macdFirstGreen ? "1st green ✓" : (ex.macdHist >= 0 ? "green" : "red")) : "warming " + s.warmEtaMin.macd + "m")
      ];
      var exRow = el("div", "mql-accum-line" + (ex.state === "EXIT" ? " mql-panda-exit" : ""), "Exit: " + ex.state + " · " + bits.join(" · "));
      body.appendChild(exRow);
      if (ex.legs && ex.legs.length) body.appendChild(el("div", "mql-rec-warn", "EXIT confluence: " + ex.legs.join(" | ")));
      if (ex.partial) body.appendChild(el("div", "mql-accum-prior", ex.partial));
      body.appendChild(el("div", "mql-accum-prior", s.candles + " closed " + s.timeframe + " candles · " +
        (p.candleSource === "gmgn-token" ? "GMGN token-level" : "Meteora pool-level") + (p.candlesStale ? " (stale)" : "")));
    }

    // recipe
    var rc = p.recipe;
    if (rc && rc.shallow && rc.shallow.bins) {
      body.appendChild(el("div", "mql-accum-line", "Recipe: one-sided SOL · " + rc.shapes.join(" or ") + " · range -" + rc.shallow.depthPct + "% → -" + rc.deep.depthPct + "%"));
      body.appendChild(el("div", "mql-accum-prior", rc.binStep + "bps bins: " + rc.shallow.bins + " (-" + rc.shallow.depthPct + "%) … " + rc.deep.bins + " (-" + rc.deep.depthPct + "%)"));
    }
    if (p.lateHour) body.appendChild(el("div", "mql-rec-warn", "⏰ After 6pm — Panda rule: don't open new positions you'd babysit overnight"));
    body.appendChild(el("div", "mql-rec-warn", "Split capital across ≥6 positions · exit when the strategy says, no revenge DLMM"));

    // setup: depth + shape, then Apply (signal) or 2-click Override (anything else)
    var setup = el("div", "mql-panda-ctrls");
    setup.appendChild(el("span", "mql-sub", "depth"));
    [86, 90, 94].forEach(function (dp) {
      var b = el("button", "mql-panda-btn" + (pandaUI.depth === dp ? " on" : ""), "-" + dp + "%");
      b.addEventListener("click", safe(function () { pandaUI.depth = dp; pandaUI.armed = false; renderHUD(); }));
      setup.appendChild(b);
    });
    setup.appendChild(el("span", "mql-sub", " shape"));
    ["Spot", "Bid Ask"].forEach(function (sh) {
      var b = el("button", "mql-panda-btn" + (pandaUI.shape === sh ? " on" : ""), sh);
      b.addEventListener("click", safe(function () { pandaUI.shape = sh; pandaUI.armed = false; renderHUD(); }));
      setup.appendChild(b);
    });
    body.appendChild(setup);
    if (rc && rc.binStep) {
      var bins = Math.ceil(Math.log(1 / (1 - pandaUI.depth / 100)) / Math.log(1 + rc.binStep / 1e4));
      body.appendChild(el("div", "mql-accum-prior", "selected: 0% → -" + pandaUI.depth + "% · " + bins + " bins · " + pandaUI.shape + " · SOL only (Auto-Fill OFF)"));
    }
    var sigOk = s && s.entry && s.entry.state === "ENTRY" && sc.state === "PASS";
    if (sigOk) {
      var apBtn = el("button", "mql-apply", "⚡ Apply Panda setup to form");
      apBtn.addEventListener("click", safe(function () { applyPanda(p, apBtn, false); }));
      body.appendChild(apBtn);
    } else {
      var why = [];
      if (sc.state !== "PASS") why.push("filters " + sc.state + ((sc.failed || []).length ? " (" + sc.failed.join(", ") + ")" : ""));
      if (!s || !s.entry || s.entry.state !== "ENTRY") why.push("entry " + (s && s.entry ? s.entry.state : "no data"));
      var ovLabel = "⚠ Override: apply Panda setup anyway";
      var ovB = el("button", "mql-apply mql-override", pandaUI.armed ? "Ignoring: " + why.join(" · ") + " — click again to apply" : ovLabel);
      ovB.addEventListener("click", safe(function () {
        if (!pandaUI.armed) {
          pandaUI.armed = true; ovB.textContent = "Ignoring: " + why.join(" · ") + " — click again to apply";
          setTimeout(function () { if (pandaUI.armed) { pandaUI.armed = false; ovB.textContent = ovLabel; } }, 8000);
          return;
        }
        pandaUI.armed = false;
        applyPanda(p, ovB, true);
      }));
      body.appendChild(ovB);
    }
    if (state.entryPlan && state.entryPlan.profile === "PANDA" && state.entryPlan.pool === state.pool && Date.now() - state.entryPlan.ts < 6 * 3600e3) {
      body.appendChild(el("div", "mql-accum-note", "✓ Panda plan journaled " + Math.round((Date.now() - state.entryPlan.ts) / 60000) + "m ago — once the position opens, Position Watch tracks the Panda exit"));
    }

    // controls
    var ctr = el("div", "mql-panda-ctrls");
    ["5m", "1m"].forEach(function (tf) {
      var b = el("button", "mql-panda-btn" + (p.timeframe === tf ? " on" : ""), tf);
      b.addEventListener("click", safe(function () { pandaUI.tf = tf; state.panda = null; fetchPanda(); renderHUD(); }));
      ctr.appendChild(b);
    });
    var pinned = !!pandaUI.pinned[state.pool];
    var pin = el("button", "mql-panda-btn" + (pinned ? " on" : ""), pinned ? "📌 pinned (entry alerts)" : "📌 pin for entry alert");
    pin.addEventListener("click", safe(function () {
      sendMessage({ type: "pandaPin", pool: state.pool, name: p.name, on: !pinned }).then(safe(function () {
        if (!pinned) pandaUI.pinned[state.pool] = { ts: Date.now() }; else delete pandaUI.pinned[state.pool];
        renderHUD();
      }));
    }));
    ctr.appendChild(pin);
    body.appendChild(ctr);
    body.appendChild(el("div", "mql-accum-prior", "Evil Panda strat (Bootcamp #7) · source uses 15m; young-token adaptation on " + p.timeframe + " · not calibrated on your trades"));
    wrap.appendChild(body);
    hud.appendChild(wrap);
  });


  // ========================================================================
  // WALLET TRACKER popup (data: background trackWalletsTick / getTracker)
  // ========================================================================
  var trackUI = { open: false, data: null, seenTs: 0, loading: false };
  function fmtAgo(ms) { var m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "now" : m < 90 ? m + "m" : m < 2880 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; }
  function fmtTokAge(ms) {
    if (!ms) return null;
    var m = Math.max(0, (Date.now() - ms) / 60000);
    return m < 60 ? Math.round(m) + "m" : m < 2880 ? Math.round(m / 60) + "h" : m < 525600 ? Math.round(m / 1440) + "d" : (m / 525600).toFixed(1) + "y";
  }
  function fmtUsdShort(v) {
    if (v == null || !isFinite(v)) return null;
    var a = Math.abs(v);
    return "$" + (a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M" : a >= 1e3 ? Math.round(v / 1e3) + "k" : Math.round(v));
  }
  function fmtCount(v) {
    if (v == null || !isFinite(v)) return null;
    return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e4 ? Math.round(v / 1e3) + "k" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v));
  }
  var loadTracker = safe(function loadTracker(refresh) {
    if (ctxDead || trackUI.loading) return;
    trackUI.loading = true;
    sendMessage({ type: "getTracker", refresh: !!refresh }).then(safe(function (r) {
      trackUI.loading = false;
      if (r && r.ok) { trackUI.data = r; if (!trackUI.open && r.seenTs > trackUI.seenTs) trackUI.seenTs = r.seenTs; renderTrackPanel(); renderTrackPoolLine(); }
    }));
  });
  function trackUnseen() {
    var f = (trackUI.data && trackUI.data.feed) || [];
    return f.filter(function (e) { return !e.baseline && e.ts > trackUI.seenTs; }).length;
  }
  // ---- bottom drawer: drag the handle up, Feed / Positions tabs ----
  var DRAWER_MIN = 30, DRAWER_DEF = 300;
  var lsGet = function (k, d) { try { var v = window.localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  var lsSet = function (k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) {} };
  trackUI.h = Math.max(DRAWER_MIN, parseInt(lsGet("mql-drawer-h", DRAWER_DEF), 10) || DRAWER_DEF);
  trackUI.open = lsGet("mql-drawer-open", "0") === "1";
  trackUI.tab = lsGet("mql-drawer-tab", "feed");
  trackUI.wallet = "all";
  function drawerHeight() { return trackUI.open ? Math.min(Math.max(trackUI.h, 120), Math.round(window.innerHeight * 0.85)) : DRAWER_MIN; }
  function applyDrawerLayout() {
    var dr = document.getElementById("mql-drawer"); if (!dr) return;
    var h = drawerHeight();
    dr.style.height = h + "px";
    dr.classList.toggle("mql-drawer-open", trackUI.open);
    var rb = document.getElementById("mql-radar"); if (rb) rb.style.bottom = (h + 8) + "px";
    try { document.body.style.paddingBottom = (DRAWER_MIN + 6) + "px"; } catch (e) {}
  }
  function feedItems() {
    var d = trackUI.data; if (!d) return [];
    var items = (d.feed || []).filter(function (e) { return !e.baseline; }).map(function (e) { return { t: e.ts, e: e, kind: e.type }; });
    var moved = {}; items.forEach(function (it) { moved[it.e.positionAddress + it.kind] = 1; });
    // positions that were already open when tracking started: show at their real open time
    (d.wallets || []).forEach(function (w) {
      Object.keys(w.positions || {}).forEach(function (k) {
        var p = w.positions[k]; if (moved[k + "ENTER"]) return;
        items.push({ t: p.createdAt ? p.createdAt * 1000 : (p.firstSeen || 0), kind: "OPENED", e: Object.assign({ label: w.label, wallet: w.address, positionAddress: k }, p) });
      });
    });
    if (trackUI.wallet !== "all") items = items.filter(function (it) { return it.e.wallet === trackUI.wallet; });
    return items.sort(function (a, b) { return b.t - a.t; }).slice(0, 200);
  }
  var renderTrackPanel = safe(function renderTrackPanel() {
    var dr = document.getElementById("mql-drawer");
    if (!dr) {
      dr = el("div", ""); dr.id = "mql-drawer"; document.body.appendChild(dr);
    }
    // don't rebuild under an open wallet <select>
    try { var ae = document.activeElement; if (ae && ae.tagName === "SELECT" && dr.contains(ae)) return; } catch (e) {}
    dr.innerHTML = "";
    var d = trackUI.data;
    var unseen = trackUnseen();
    var handle = el("div", "mql-drawer-handle");
    handle.appendChild(el("span", "mql-drawer-grip", ""));
    var nW = d && d.wallets ? d.wallets.length : 0;
    handle.appendChild(el("span", "mql-track-title", "👁 WALLET FEED"));
    handle.appendChild(el("span", "mql-sub", nW + " wallet" + (nW === 1 ? "" : "s") + (unseen ? " · " : "")));
    if (unseen) handle.appendChild(el("span", "mql-drawer-badge", unseen + " new"));
    var spacer = el("span", "mql-drawer-spacer", ""); handle.appendChild(spacer);
    if (trackUI.open) {
      ["feed", "positions"].forEach(function (t) {
        var b = el("button", "mql-panda-btn" + (trackUI.tab === t ? " on" : ""), t === "feed" ? "Feed" : "Positions");
        b.addEventListener("click", safe(function (ev) { ev.stopPropagation(); trackUI.tab = t; lsSet("mql-drawer-tab", t); renderTrackPanel(); }));
        handle.appendChild(b);
      });
      if (nW > 1) {
        var sel = el("select", "mql-drawer-sel");
        [["all", "all wallets"]].concat(d.wallets.map(function (w) { return [w.address, w.label]; })).forEach(function (o) {
          var op = el("option", "", o[1]); op.value = o[0]; if (trackUI.wallet === o[0]) op.selected = true; sel.appendChild(op); });
        sel.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
        sel.addEventListener("change", safe(function () { trackUI.wallet = sel.value; sel.blur(); renderTrackPanel(); }));
        handle.appendChild(sel);
      }
      var rf = el("button", "mql-panda-btn", trackUI.loading ? "…" : "↻"); rf.title = "Check wallets now";
      rf.addEventListener("click", safe(function (ev) { ev.stopPropagation(); loadTracker(true); }));
      handle.appendChild(rf);
    }
    var tg = el("button", "mql-panda-btn", trackUI.open ? "▾" : "▴");
    tg.addEventListener("click", safe(function (ev) { ev.stopPropagation(); toggleDrawer(); }));
    handle.appendChild(tg);
    // drag to resize (click without drag toggles)
    handle.addEventListener("mousedown", safe(function (ev) {
      if (ev.target.closest && ev.target.closest("button,select,a")) return;
      ev.preventDefault();
      var y0 = ev.clientY, h0 = drawerHeight(), moved = false;
      var mv = function (e2) {
        var dy = y0 - e2.clientY; if (Math.abs(dy) > 3) moved = true; if (!moved) return;
        trackUI.open = true; trackUI.h = Math.max(120, Math.min(Math.round(window.innerHeight * 0.85), h0 + dy));
        if (trackUI.h <= 125 && dy < 0 && h0 + dy < 90) trackUI.open = false;
        applyDrawerLayout();
      };
      var up = function () {
        document.removeEventListener("mousemove", mv, true); document.removeEventListener("mouseup", up, true);
        if (!moved) { toggleDrawer(); return; }
        lsSet("mql-drawer-h", trackUI.h); lsSet("mql-drawer-open", trackUI.open ? "1" : "0");
        renderTrackPanel();
      };
      document.addEventListener("mousemove", mv, true); document.addEventListener("mouseup", up, true);
    }));
    dr.appendChild(handle);
    if (trackUI.open) {
      var body = el("div", "mql-drawer-body");
      var link = function (pool, text) { var a = el("a", "mql-track-link", text); a.href = "/dlmm/" + pool; return a; };
      var fmtPos = function (p) {
        return (p.binStep ? p.binStep + "bps" : "") + (p.side ? " · " + p.side : "") + (p.range ? " " + p.range : "") +
          (p.depositSol != null ? " · " + Number(p.depositSol).toFixed(2) + "◎" : "");
      };
      // token info for the pair's non-SOL / non-USDC side (background: Jupiter, 2-min cache)
      var toks = (d && d.tokens) || {};
      var tokOf = function (o) { return o && o.tokMint ? toks[o.tokMint] || null : null; };
      var gmgnLink = function (mint) {
        var a = el("a", "mql-gmgn", "GMGN↗"); a.href = "https://gmgn.ai/sol/token/" + mint; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.title = "Open on GMGN · " + mint; a.addEventListener("click", function (ev) { ev.stopPropagation(); });
        return a;
      };
      var tokChip = function (e, live) {
        if (!e || !e.tokMint) return null;
        var t = tokOf(e), span = el("span", "mql-tok");
        var parts = [];
        if (t) {
          var age = fmtTokAge(t.createdAt); if (age) parts.push(age + " old");
          var mc = fmtUsdShort(t.mcap), mcAt = live && e.mcapAt != null ? fmtUsdShort(e.mcapAt) : null;
          if (mcAt && mc && mcAt !== mc) parts.push("mcap " + mcAt + "→" + mc); else if (mc || mcAt) parts.push("mcap " + (mc || mcAt));
          var h = fmtCount(t.holders); if (h) parts.push(h + " holders");
          if (t.launchpad) span.title = "launchpad: " + t.launchpad + (t.organic != null ? " · organic " + Math.round(t.organic) : "");
        }
        if (parts.length) span.appendChild(el("span", "", parts.join(" · ") + " "));
        span.appendChild(gmgnLink(e.tokMint));
        return span;
      };
      if (!d || !d.wallets || !d.wallets.length) {
        body.appendChild(el("div", "mql-accum-note", "No wallets yet — add addresses in the extension Options → 👁 Wallet tracker."));
      } else if (trackUI.tab === "positions") {
        var tbl = el("table", "mql-drawer-table");
        var hr = el("tr", ""); ["wallet", "pool", "token age", "mcap", "holders", "", "type", "range", "size", "PnL", "status", "opened"].forEach(function (h) { hr.appendChild(el("th", "", h)); }); tbl.appendChild(hr);
        d.wallets.filter(function (w) { return trackUI.wallet === "all" || w.address === trackUI.wallet; }).forEach(function (w) {
          Object.keys(w.positions || {}).map(function (k) { return w.positions[k]; }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).forEach(function (p) {
            var tr = el("tr", p.pool === state.pool ? "mql-track-here" : "");
            var c = function (x) { var td = el("td", ""); if (x instanceof Node) td.appendChild(x); else td.textContent = x == null ? "—" : String(x); tr.appendChild(td); return td; };
            c(w.label); c(link(p.pool, p.pair + (p.binStep ? " " + p.binStep + "bps" : "")));
            var tk = tokOf(p);
            c(tk ? fmtTokAge(tk.createdAt) : null); c(tk ? fmtUsdShort(tk.mcap) : null); c(tk ? fmtCount(tk.holders) : null);
            c(p.tokMint ? gmgnLink(p.tokMint) : null);
            c(p.side); c(p.range);
            c(p.depositSol != null ? Number(p.depositSol).toFixed(2) + "◎" : null);
            var pt = c(p.pnlSolPct != null ? (p.pnlSolPct >= 0 ? "+" : "") + Math.round(p.pnlSolPct) + "%" : null); if (p.pnlSolPct != null) pt.className = p.pnlSolPct >= 0 ? "jr-pos" : "jr-neg";
            c(p.oor ? "out of range" : "in range"); c(p.createdAt ? fmtAgo(p.createdAt * 1000) + " ago" : null);
            tbl.appendChild(tr);
          });
        });
        body.appendChild(tbl);
      } else {
        var items = feedItems();
        if (!items.length) body.appendChild(el("div", "mql-accum-note", "No moves yet."));
        items.forEach(function (it) {
          var e = it.e;
          var row = el("div", "mql-feed-row" + (it.kind !== "OPENED" && it.t > trackUI.seenTs ? " mql-track-new" : "") + (e.pool === state.pool ? " mql-track-here" : ""));
          var ic = { ENTER: "🟢 entered", ADD: "➕ added", EXIT: "🔴 exited", OPENED: "◽ opened" }[it.kind] || it.kind;
          row.appendChild(el("span", "mql-feed-time", fmtAgo(it.t)));
          row.appendChild(el("span", "mql-feed-who", e.label));
          row.appendChild(el("span", "mql-feed-act mql-feed-" + it.kind.toLowerCase(), ic));
          row.appendChild(link(e.pool, e.pair));
          var chip = tokChip(e, it.kind !== "OPENED"); if (chip) row.appendChild(chip);
          var tail = it.kind === "EXIT"
            ? fmtPos(e) + (e.lastPnlSolPct != null ? " · last " + Math.round(e.lastPnlSolPct) + "%" : "") + (e.heldMin != null ? " · held " + (e.heldMin >= 90 ? (e.heldMin / 60).toFixed(1) + "h" : e.heldMin + "m") : "")
            : (it.kind === "ADD" ? "+" + Number(e.addedSol).toFixed(2) + "◎ · " : "") + fmtPos(e) + (e.pnlSolPct != null && it.kind === "OPENED" ? " · now " + Math.round(e.pnlSolPct) + "%" : "");
          row.appendChild(el("span", "mql-sub", " " + tail));
          body.appendChild(row);
        });
        if (items.some(function (it) { return it.kind === "OPENED"; })) body.appendChild(el("div", "mql-accum-prior", "◽ = already open when tracking started (shown at its real open time). 🟢/➕/🔴 = moves seen live."));
      }
      dr.appendChild(body);
      trackUI.seenTs = Date.now();
      try { chrome.storage.local.set({ mqlTrackSeenTs: trackUI.seenTs }); } catch (e) {}
    }
    applyDrawerLayout();
  });
  function toggleDrawer() {
    trackUI.open = !trackUI.open; lsSet("mql-drawer-open", trackUI.open ? "1" : "0");
    if (trackUI.open) loadTracker(false);
    renderTrackPanel();
  }
  var startTrackDrawer = safe(function startTrackDrawer() {
    renderTrackPanel();
    loadTracker(false);
    setInterval(safe(function () { if (document.visibilityState === "visible") loadTracker(false); }), 30000);
    window.addEventListener("resize", safe(applyDrawerLayout));
  });
  // one line on the pool HUD when a tracked wallet is LPing this pool
  var renderTrackPoolLine = safe(function renderTrackPoolLine() {
    var hud = document.getElementById("mql-hud"); if (!hud) return;
    var old = document.getElementById("mql-track-here"); if (old) old.remove();
    var d = trackUI.data; if (!d || !d.wallets) return;
    var hits = [];
    d.wallets.forEach(function (w) { Object.keys(w.positions || {}).forEach(function (k) { var p = w.positions[k]; if (p.pool === state.pool) hits.push(w.label + " (" + (p.side || "?") + (p.range ? " " + p.range : "") + (p.depositSol != null ? ", " + Number(p.depositSol).toFixed(2) + "◎" : "") + ")"); }); });
    if (!hits.length) return;
    var line = el("div", "mql-row mql-track-hudline", "👁 tracked here: " + hits.join(" · "));
    line.id = "mql-track-here";
    var foot = hud.querySelector(".mql-footer");
    if (foot) hud.insertBefore(line, foot); else hud.appendChild(line);
  });

  // ---- guided two-leg apply flow (state survives reloads via storage) ----
  var comboFlow = { st: null, timer: null };

  function comboSave() { try { chrome.storage.local.set({ mqlComboState: comboFlow.st }); } catch (e) {} }
  function comboClear() {
    comboFlow.st = null;
    if (comboFlow.timer) { clearInterval(comboFlow.timer); comboFlow.timer = null; }
    try { chrome.storage.local.remove("mqlComboState"); } catch (e) {}
    var b = document.getElementById("mql-combo-banner"); if (b) b.remove();
  }
  function comboLegParams(st) {
    return st.leg === 1
      ? { strategy: "Bid Ask", minPct: -st.depth, maxPct: 0, mode: "single" }
      : { strategy: "Spot", minPct: -st.depth, maxPct: 0, mode: "single" };
  }
  function comboLegAmt(st) {
    var amt = st.leg === 1 ? st.share * st.totalSol : (1 - st.share) * st.totalSol;
    return Math.round(amt * 1000) / 1000;
  }

  // Fill the SOL amount input. DOM assumption (flagged for live review): each
  // AmountInput wrap shows its token symbol as text; we fill the unique wrap
  // mentioning SOL, else fall back to the 2nd of exactly two inputs (quote side).
  // Which deposit panel owns a node? Walk a BOUNDED set of ancestors and read the
  // panel's own submit button label. Meteora keeps the Create Position form mounted
  // next to a position's Add Liquidity panel, so anything document-wide is ambiguous.
  function panelKind(node) {
    var n = node, hops = 0;
    while (n && n !== document.body && hops < 10) {
      var btns = n.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || "").replace(/\s+/g, " ").trim();
        if (/^add liquidity$/i.test(t)) return { kind: "ADD", root: n };
        if (/^create position$/i.test(t)) return { kind: "CREATE", root: n };
      }
      n = n.parentElement; hops++;
    }
    return { kind: null, root: null };
  }

  function findPanelRoot(kind) {
    var wraps = document.querySelectorAll('[data-sentry-component="AmountInput"]');
    for (var i = 0; i < wraps.length; i++) {
      var pk = panelKind(wraps[i]);
      if (pk.kind === kind) return pk.root;
    }
    return null;
  }

  function fillSolAmount(amt, scopeEl) {
    try {
      if (!state.data || state.data.supportedSolPair !== true) return false;
      // NESTED-WRAP TRAP (caught live on the Add Liquidity panel): AmountInput wraps
      // can NEST - a parent wrap contains BOTH the token and SOL sections, so its
      // textContent matches /SOL/ and querySelector('input') returns the FIRST input
      // = the TOKEN box. Judge each input by its own LEAF section text instead:
      // climb ancestors while the container still holds only that one input.
      // TWO-PANEL TRAP (caught live on leg 2): with the Add Liquidity panel open the
      // page holds TWO enabled SOL inputs, so the "exactly one" rule below bailed and
      // the amount silently went unfilled. Callers pass the owning panel as scope.
      var root = scopeEl || document;
      var wraps = root.querySelectorAll('[data-sentry-component="AmountInput"]');
      var seen = [], inputs = [];
      for (var i = 0; i < wraps.length; i++) {
        var ins = wraps[i].querySelectorAll("input");
        for (var j = 0; j < ins.length; j++) {
          if (seen.indexOf(ins[j]) >= 0) continue;
          seen.push(ins[j]); inputs.push(ins[j]);
        }
      }
      function localText(inp) {
        var n = inp.parentElement, last = inp;
        while (n && n !== document.body && n.querySelectorAll("input").length <= 1) { last = n; n = n.parentElement; }
        return (last.textContent || "");
      }
      var solInputs = [];
      for (var k = 0; k < inputs.length; k++) {
        var lt = localText(inputs[k]);
        // WORD-BOUNDARY TRAP (caught live): the SOL section's leaf text concatenates
        // the symbol straight onto the wallet balance ("SOL48.50323..."), so /\bSOL\b/
        // never matched and the amount silently went unfilled. Use a LETTER boundary
        // instead: digits/symbols may touch "SOL", letters may not (keeps SOLCAT out).
        if (/(^|[^A-Za-z])SOL([^A-Za-z]|$)/.test(lt) && !/USDC|USDT/.test(lt)) solInputs.push(inputs[k]);
      }
      var enabledSol = solInputs.filter(function (x) { return !x.disabled; });
      var pick = enabledSol.length === 1 ? enabledSol[0] : null;
      if (pick) { setNativeInput(pick, String(amt)); return true; }
      return false;
    } catch (e) { return false; }
  }

  // Leg 2 = ADD LIQUIDITY into the leg-1 position (user-confirmed: ONE position,
  // bid-ask base + spot layered on top). Range is locked to the position's bins,
  // so we only drive: Add Liquidity button -> Spot strategy -> SOL amount.
  // OPENER only. Never returns the Add panel's own SUBMIT button: clicking that
  // would try to send the deposit instead of opening the form.
  function findAddLiquidityBtn(addRoot) {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").replace(/\s+/g, " ").trim();
      if (!/^add liquidity$/i.test(t)) continue;
      if (addRoot && addRoot.contains(btns[i])) continue;
      return btns[i];
    }
    return null;
  }

  var comboAddSpotLayer = safe(function comboAddSpotLayer() {
    var st = comboFlow.st; if (!st) return;
    var addRoot = findPanelRoot("ADD");
    var addBtn = addRoot ? null : findAddLiquidityBtn(null);
    if (addBtn) { try { addBtn.click(); } catch (e) {} }
    setTimeout(safe(function () {
      var st2 = comboFlow.st; if (!st2) return;
      // Re-resolve after the click: leg 2 must drive the position's Add panel, not
      // the Create Position form that stays mounted right next to it.
      var root = findPanelRoot("ADD");
      // strategy: Spot (same proven selector as applySetup, scoped to that panel)
      var stratWrap = (root || document).querySelector('[data-sentry-component="StrategySelection"]');
      if (stratWrap) {
        var btns = stratWrap.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
          if ((btns[i].textContent || "").replace(/\s+/g, " ").trim().endsWith("Spot")) { btns[i].click(); break; }
        }
      }
      setTimeout(safe(function () {
        var st3 = comboFlow.st; if (!st3) return;
        var root2 = findPanelRoot("ADD") || root;
        st3.amtFilled = fillSolAmount(comboLegAmt(st3), root2);
        comboSave();
        renderComboBanner(root2
          ? null
          : "couldn't find your position's Add Liquidity panel — open the position card, click Add Liquidity, pick Spot, enter " + comboLegAmt(st3) + " SOL, then sign");
      }), 700);
    }), 1300);
  });

  var comboApplyLeg = safe(function comboApplyLeg() {
    var st = comboFlow.st; if (!st) return;
    if (st.leg === 2) { comboAddSpotLayer(); return; }
    applySetup(comboLegParams(st), null);
    setTimeout(safe(function () {
      var st2 = comboFlow.st; if (!st2) return;
      var r = readRange();
      if (!r) { renderComboBanner("open the deposit / Add Position panel first, then hit ↻ re-apply"); return; }
      st2.amtFilled = fillSolAmount(comboLegAmt(st2), findPanelRoot("CREATE"));
      comboSave(); renderComboBanner();
      // re-verify the range stuck (Auto-Fill likes to reset it)
      setTimeout(safe(function () {
        var st3 = comboFlow.st; if (!st3) return;
        var r2 = readRange();
        if (r2 && (Math.abs(r2.min - (-st3.depth)) > 1 || Math.abs(r2.max) > 1)) {
          applySetup(comboLegParams(st3), null);
          flashResetWarning("Combo: range was reset — re-applied leg " + st3.leg + ". Keep Auto-Fill OFF.");
        }
      }), 2600);
    }), 1400);
  });

  function renderComboBanner(note) {
    var st = comboFlow.st; if (!st) return;
    var b = document.getElementById("mql-combo-banner");
    if (!b) { b = el("div", ""); b.id = "mql-combo-banner"; document.body.appendChild(b); }
    b.innerHTML = "";
    var amt = comboLegAmt(st);
    var overridePrefix = st.override ? "⚠ OVERRIDE · " : "";
    var stepTxt = st.leg === 1
      ? overridePrefix + "LEG 1/2 — BID-ASK " + amt + " SOL · range 0 → -" + st.depth + "% (creates the position)"
      : overridePrefix + "LEG 2/2 — ADD " + amt + " SOL as SPOT into the SAME position (range locked to leg 1)";
    b.appendChild(el("div", "mql-combo-step", stepTxt));
    if (st.override && st.ignoredGates && st.ignoredGates.length) {
      b.appendChild(el("div", "mql-combo-sub", "ignored gates: " + st.ignoredGates.join(" · ")));
    }
    var subTxt = note || (st.amtFilled
      ? "form filled — review & sign in wallet (keep Auto-Fill OFF, SOL side only)"
      : "strategy + range filled — ENTER " + amt + " SOL yourself, then sign (keep Auto-Fill OFF)");
    b.appendChild(el("div", "mql-combo-sub", subTxt));
    var row = el("div", "mql-combo-row");
    var re = el("button", "mql-apply", "↻ re-apply fills");
    re.addEventListener("click", safe(function () { comboApplyLeg(); }));
    row.appendChild(re);
    var manual = el("button", "mql-apply", "✓ leg " + st.leg + " signed → " + (st.leg === 1 ? "set up leg 2" : "finish"));
    manual.addEventListener("click", safe(function () { comboAdvance("manual"); }));
    row.appendChild(manual);
    var abort = el("button", "mql-apply mql-combo-abort", "✕ abort");
    abort.addEventListener("click", safe(function () { comboClear(); }));
    row.appendChild(abort);
    b.appendChild(row);
  }

  var comboAdvance = safe(function comboAdvance(how) {
    var st = comboFlow.st; if (!st) return;
    if (st.leg === 1) {
      st.leg = 2; st.leg1At = Date.now(); st.amtFilled = false; st.warned = false;
      comboSave();
      renderComboBanner();
      comboApplyLeg();
    } else {
      try {
        chrome.storage.local.get({ mqlTradeLog: [] }, function (jr) {
          var logArr = jr.mqlTradeLog || [];
          logArr.push({ type: "BID_ASK_OPEN", profile: "ACCUM", strategy: "Bid-Ask + Spot", pool: st.poolAddr, depth: st.depth, share: st.share,
            totalSol: st.totalSol, startedAt: st.startedAt, leg1At: st.leg1At || null,
            finishedAt: Date.now(), detectedBy: how, override: st.override === true,
            ignoredGates: st.ignoredGates || [], entryPlanTs: st.entryPlanTs || null });
          chrome.storage.local.set({ mqlTradeLog: logArr.slice(-200) });
        });
      } catch (e) {}
      var b = document.getElementById("mql-combo-banner");
      if (b) {
        b.innerHTML = "";
        b.appendChild(el("div", "mql-combo-step mql-good", (st.override ? "⚠ OVERRIDE · " : "") +
          "✅ BID ASK DEPLOYED — one position: Bid-Ask base + Spot layer. Position Watch is tracking fill %."));
        if (st.override && st.ignoredGates && st.ignoredGates.length) {
          b.appendChild(el("div", "mql-combo-sub", "override recorded; ignored gates: " + st.ignoredGates.join(" · ")));
        }
        setTimeout(safe(function () { var n = document.getElementById("mql-combo-banner"); if (n) n.remove(); }), 9000);
      }
      comboFlow.st = null;
      if (comboFlow.timer) { clearInterval(comboFlow.timer); comboFlow.timer = null; }
      try { chrome.storage.local.remove("mqlComboState"); } catch (e) {}
      pollMyPosition();
    }
  });

  function comboPollStart() {
    if (comboFlow.timer) clearInterval(comboFlow.timer);
    comboFlow.timer = setInterval(safe(function () {
      var st = comboFlow.st;
      if (!st) { clearInterval(comboFlow.timer); comboFlow.timer = null; return; }
      var legStart = st.leg === 1 ? st.startedAt : (st.leg1At || st.startedAt);
      if (Date.now() - legStart > 600e3 && !st.warned) {
        st.warned = true; comboSave();
        renderComboBanner("still waiting — did you sign? (auto-detect needs your wallet saved in Lens options; or use the ✓ button)");
      }
      sendMessage({ type: "getMyPosition", pool: st.poolAddr }).then(safe(function (r) {
        var st2 = comboFlow.st; if (!st2 || !r || !r.ok) return;
        var count = r.has ? (r.count || 0) : 0;
        var deps = (r.depositsSol != null && isFinite(Number(r.depositsSol))) ? Number(r.depositsSol) : null;
        if (st2.leg === 1) {
          // leg 1 = position created: count rises (or deposits jump if API lags count)
          var known = st2.lastCount == null ? st2.startCount : st2.lastCount;
          var leg1Amt = st2.share * st2.totalSol;
          var depBase = st2.startDeposits || 0;
          if (count > known || (deps != null && deps > depBase + 0.3 * leg1Amt)) {
            st2.lastCount = count; st2.leg1Deposits = deps; st2.warned = false; comboSave();
            comboAdvance("auto");
          }
        } else {
          // leg 2 = ADD into the SAME position: count stays flat — detect via
          // total deposits growing by ~the spot layer amount
          var leg2Amt = (1 - st2.share) * st2.totalSol;
          var base = (st2.leg1Deposits != null) ? st2.leg1Deposits
            : (st2.startDeposits || 0) + st2.share * st2.totalSol * 0.7;
          if (deps != null && deps > base + 0.3 * leg2Amt) {
            st2.warned = false; comboSave(); comboAdvance("auto");
          } else if (count > (st2.lastCount || 0)) {
            // user created a separate position instead — still counts as leg 2 done
            st2.lastCount = count; comboSave(); comboAdvance("auto");
          }
        }
      }));
    }), 15000);
  }

  var startCombo = safe(function startCombo(depth, share, totalSol, overrideMeta) {
    var startPool = state.pool;
    var startData = state.data;
    var ba = startData && startData.bidAsk;
    var comboNow = Date.now();
    var comboTs = Number(startData && startData.ts);
    var isOverride = !!(overrideMeta && overrideMeta.override === true);
    var structural = bidAskOverridePlan(startData);
    var amount = validateComboTotal(totalSol, share);
    if (!startPool || !ba || !structural.ok || !amount.ok
        || !isFinite(Number(depth)) || Number(depth) <= 0 || Number(depth) >= 100
        || Number(depth) !== structural.depth || Number(share) !== structural.share
        || !isFinite(comboTs)) return;
    if (isOverride) {
      // The second click captured this pool/data/plan identity. Manual override
      // skips candle/base qualification only; a changed plan must be confirmed
      // again rather than applying a stale closure to a new pool.
      if (!overrideMeta.pool || overrideMeta.pool !== startPool
          || Number(overrideMeta.dataTs) !== comboTs) return;
    } else if (!ba.ready || ba.state !== 'READY' || startData.supportedSolPair !== true
        || comboNow < comboTs || comboNow - comboTs > 120000 || !bidAskCandleFresh(ba)) {
      return;
    }
    var entryTs = isOverride && isFinite(Number(overrideMeta.entryTs)) ? Number(overrideMeta.entryTs) : comboNow;
    var ignoredGates = isOverride && Array.isArray(overrideMeta.ignoredGates)
      ? overrideMeta.ignoredGates.slice() : [];
    var entryContext = {
      feeRate1h: startData.feeRate1h,
      feeRate24h: startData.feeRate24h,
      feeBasis: startData.feeBasis || null,
      edge: startData.edge,
      sigma: startData.sigma,
      sigmaSource: startData.sigmaSource
    };
    var entryPlan = { cls: 'BID_ASK', profile: 'ACCUM', strategy: 'Bid-Ask + Spot', pool: startPool, ts: entryTs,
      widthPct: Math.round(Number(depth) / (2 - Number(depth) / 100)), minPct: -Number(depth), maxPct: 0, mode: 'single',
      depthPct: Number(depth), bidAskPct: Math.round(Number(share) * 100), spotPct: Math.round((1 - Number(share)) * 100), accum: true,
      totalSol: amount.totalSol,
      entryFeeRate: (entryContext.feeRate1h > 0) ? entryContext.feeRate1h : null,
      entryFeeRate24h: (entryContext.feeRate24h > 0) ? entryContext.feeRate24h : null,
      feeBasis: entryContext.feeBasis || undefined,
      entryEdge: (entryContext.edge != null) ? Math.round(entryContext.edge * 100) / 100 : null,
      entryEdgeBasis: startData.edgeBasis || null,
      entrySigma: (entryContext.sigma != null) ? Math.round(entryContext.sigma * 10) / 10 : null,
      entrySigmaSource: entryContext.sigmaSource || null };
    if (isOverride) {
      entryPlan.override = true;
      entryPlan.ignoredGates = ignoredGates.slice();
      entryPlan.overrideDataTs = comboTs;
    }
    var startCount = (state.apiPos && state.apiPos.count) || 0;
    comboFlow.st = { poolAddr: startPool, depth: Number(depth), share: Number(share), totalSol: amount.totalSol,
      leg: 1, startedAt: entryTs, entryPlanTs: entryTs, dataTs: comboTs,
      startCount: startCount, lastCount: startCount,
      startDeposits: (state.apiPos && state.apiPos.depositsSol != null ? Number(state.apiPos.depositsSol) : 0),
      leg1Deposits: null, amtFilled: false, warned: false,
      override: isOverride, ignoredGates: ignoredGates };
    // Journal the combo's OWN entry plan. For overrides, the plan and override
    // journal share the exact same timestamp so background entry-origin joining
    // cannot lose the intent across the asynchronous storage callbacks.
    try {
      chrome.storage.local.get({ mqlEntryPlan: {}, mqlOverrideJournal: [] }, safe(function (jr9) {
        var plans9 = jr9.mqlEntryPlan || {};
        plans9[startPool] = entryPlan;
        var payload = { mqlEntryPlan: plans9 };
        if (isOverride) {
          var overrides = jr9.mqlOverrideJournal || [];
          overrides.push({ ts: entryTs, pool: startPool, cls: 'BID_ASK', override: true,
            ignoredGates: ignoredGates.slice(), depth: Number(depth), share: Number(share),
            totalSol: amount.totalSol, dataTs: comboTs, edge: entryContext.edge, edgeBasis: startData.edgeBasis || null,
            sigma: entryContext.sigma, feeRate1h: entryContext.feeRate1h });
          payload.mqlOverrideJournal = overrides.slice(-100);
        }
        chrome.storage.local.set(payload, safe(function () {
          if (state.pool === startPool) state.entryPlan = entryPlan;
        }));
      }));
    } catch (e) {}
    comboSave();
    renderComboBanner();
    comboApplyLeg();
    comboPollStart();
  });

  // Additional VM seams cover the DOM click path without exposing production
  // controls. They are populated only by the existing test harness object.
  if (window.__mqlTestExports && typeof window.__mqlTestExports === "object") {
    window.__mqlTestExports.renderAccumBlock = renderAccumBlock;
    window.__mqlTestExports.startCombo = startCombo;
    window.__mqlTestExports.setState = function (patch) {
      if (patch && typeof patch === "object") Object.assign(state, patch);
    };
    window.__mqlTestExports.setComboOpen = function (open) { comboUI.open = !!open; };
    window.__mqlTestExports.getComboState = function () { return comboFlow.st; };
  }

  function loadEntryPlan() {
    try {
      chrome.storage.local.get({ mqlEntryPlan: {} }, safe(function (jr) {
        var plans = jr.mqlEntryPlan || {};
        state.entryPlan = (state.pool && plans[state.pool]) ? plans[state.pool] : null;
      }));
    } catch (e) {}
  }

  function comboResume() {
    try {
      chrome.storage.local.get({ mqlComboState: null }, safe(function (st) {
        var c = st.mqlComboState;
        if (!c || !c.poolAddr) return;
        if (Date.now() - c.startedAt > 2 * 3600e3) { chrome.storage.local.remove("mqlComboState"); return; }
        if (c.poolAddr !== state.pool) return;
        comboFlow.st = c;
        renderComboBanner("resumed — leg " + c.leg + " of 2 (↻ re-apply if the form is empty)");
        comboPollStart();
      }));
    } catch (e) {}
  }

  // ---- hover explainer tooltips ----
  var MQL_TIPS = {
    "verdict": "The bottom line. The Lens tests this pool against three entry playbooks (SCALP / REVERSION / CARRY). NO ENTRY means none of them clear their bars \u2014 whatever the APR looks like.",
    "edge": "Pool-wide fee/IL heuristic at the shown width. It does not model your bin shape, active-liquidity share, one-sided inventory path, execution costs, or rewards. Use it as a screening gate, not a profit forecast.",
    "fee": "The truth about yield. The site's 24h number is backward-looking; the 1h rate is what the pool pays RIGHT NOW, annualized to %/day. On a pool younger than a day, the comparison rate is fees since launch divided by the pool's real age (Meteora's 24h window only covers the time the pool has existed). Under 1h old the rate is provisional and no entry can pass. \u25b2 HEATING = accelerating. \u25bc COOLING = the party already happened.",
    "sigma": "Realized volatility, %/day \u2014 EWMA over the last ~4h of 5m closes. A trailing ~ means the token is too fresh for candle data (<30 min): the number is the legacy single-print estimate, typically inflated on launches \u2014 trust it less. High \u03c3 means high IL risk: the same fees buy you much less safety.",
    "surge": "DLMM raises fees automatically during volatility (the accumulator). Surge = current dynamic fee \u00f7 base fee. \u22651.25x = the premium is elevated \u2014 the best moments to provide liquidity. ~0 = premium fully decayed.",
    "accel": "Volume acceleration: last-30-min pace vs last-4h pace. \u22651.2x = flow is building (a catalyst). Below 1 = activity fading \u2014 you'd be arriving after the party.",
    "flow": "Organic Flow Imbalance from Jupiter: real-wallet sells \u00f7 buys (bots filtered out). Over 2 = genuine holders are DISTRIBUTING \u2014 entering means buying their exit. Under 0.5 = organic accumulation. Shown for 1h / 6h windows.",
    "path": "Where price is in its story, from today's candle: FREEFALL (actively dumping \u2014 never enter), BASING (crashed, then stabilized \u2014 the reversion setup), BLOWOFF (extended at highs), GRIND-UP, CHOP. Also shows drawdown from the day's high.",
    "token": "Safety sheet: Organic Score (0-100, how real the trading is), token age, whether mint & freeze authority are burned (\u26a0\ufe0f live mint authority = team can print supply), and top-10 holder concentration.",
    "rec": "What to actually do, translated from all the signals: either a concrete recipe (shape, width, TP/SL brackets, exits) or WAIT with the exact conditions that would flip it to an entry.",
    "feebadge": "Live 1h fee run-rate \u2014 the number the native 24h stat hides. Green \u25b2 heating, red \u25bc cooling.",
    "radar": "Bounded candidate scanner: every 3 min it analyzes up to eight high-fee pools selected from the top 100 by 24h volume. Fire = full trade signal, bucket = BID ASK READY, warning = near-miss. It is not an exhaustive market scan.",
    "pwbrackets": "Suggested exit brackets, anchored to what a two-sided Spot can ACTUALLY earn: TP = W/4 (capped appreciation of a \u00b1W band \u2014 a clean pump-out only yields ~W/4) + half a day of the fee rate (chop income is the real engine). SL sits just inside the structural band-break value (~-0.75W). \u2018Away\u2019 = how far your current PnL sits from each. These are guidance \u2014 the hard rules (fee-decay, flow-flip, freefall) fire on their own regardless.",
    "poswatch": "Exit intelligence for the position you hold in THIS pool: it snapshots the fee rate when it first sees your position, then applies the bot\u2019s exit rules \u2014 fee-decay (exit at 50% decay), organic flow-flip, freefall, surge-death. HOLD / WATCH / TIGHTEN / EXIT with the reason.",
    "breakeven": "IL-breakeven check for YOUR current range: at this pool's volatility, a range this wide must earn at least X%/day in fees just to offset expected impermanent loss. \u2713 = the pool pays more than that. \u2717 = your range loses money on expectation.",
    "accum": "BID ASK is a manual accumulation signal: a deep single-sided SOL band below price, built as Bid-Ask (bottom-heavy) plus Spot (uniform) in the same range. READY means its uncalibrated safety and persistence gates pass; it is not a profit forecast. You choose the amount and approve both wallet transactions.",
    "accumdepth": "How deep the band goes, scaled from realized vol: \u03c3\u2265150%/day \u2192 -75%, \u03c3\u226480 \u2192 -60% (linear between), nudged deeper near ATH and shallower if already crashed. A -70% wick is a normal day for a high-\u03c3 memecoin \u2014 the band must survive it. Prior pending calibration.",
    "accumsplit": "Capital split between the two legs. The Bid-Ask share rises with \u03c3 and with sell-skewed flow (deep fills more likely), clamped 60-80%. Default lands \u2248 70/30. Prior pending calibration.",
    "accumfill": "How much of the SOL you deposited has already been spent buying the token: 1 - SOL still in your bins / net SOL deposited (Meteora position data, fees excluded). Only when that data is missing does it fall back to \u2248 a linear price-traversal guess (labeled), which runs ahead of reality on a bottom-heavy Bid-Ask band."
  };
  var tipEl = null;
  function ensureTipEl() {
    if (tipEl && document.body.contains(tipEl)) return tipEl;
    tipEl = document.createElement("div");
    tipEl.id = "mql-tooltip";
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function showTip(target, key) {
    var txt = MQL_TIPS[key]; if (!txt) return;
    var t = ensureTipEl();
    t.textContent = txt;
    t.style.display = "block";
    var r = target.getBoundingClientRect();
    var top = r.bottom + 6, left = Math.min(r.left, window.innerWidth - 300);
    if (top + 120 > window.innerHeight) top = Math.max(8, r.top - 6 - t.offsetHeight);
    t.style.top = top + "px"; t.style.left = Math.max(8, left) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.display = "none"; }
  document.addEventListener("mouseover", function (e) {
    try {
      var m = e.target && e.target.closest && e.target.closest("[data-mql-tip]");
      if (m) showTip(m, m.getAttribute("data-mql-tip")); else hideTip();
    } catch (err) {}
  }, true);
  function tipify(node, key) { if (node) { node.setAttribute("data-mql-tip", key); node.classList.add("mql-tippable"); } }


  // ---- POSITION WATCH: exit intelligence when you hold a position in this pool ----
  function hasOpenPosition() {
    try {
      if (state.apiPos && state.apiPos.has) return true;  // saved-wallet API: shows even if desktop wallet not connected
      if (!document.querySelector('[data-sentry-component="PositionItem"]')) return false;
      var noLiq = [...document.querySelectorAll("h3")].some(function (h) { return /No Liquidity Positions/i.test(h.textContent || ""); });
      return !noLiq;
    } catch (e) { return false; }
  }

  // pulse-highlight a native control and scroll to it (assist, never click money buttons)
  function pulseTarget(elm) {
    if (!elm) return false;
    try {
      elm.scrollIntoView({ behavior: "smooth", block: "center" });
      elm.classList.add("mql-target-pulse");
      setTimeout(function () { elm.classList.remove("mql-target-pulse"); }, 4000);
      return true;
    } catch (e) { return false; }
  }
  var posAssist = safe(function posAssist(kind, btn) {
    if (kind === "claim") {
      var t = document.querySelector('[data-sentry-component="PositionClaimAllButton"]') ||
              document.querySelector('[data-sentry-component="Claim"]');
      if (!pulseTarget(t) && btn) btn.textContent = "open your position row first";
      return;
    }
    if (kind === "exit") {
      // open the Withdraw tab if the management panel is present, else pulse the position row
      var wTab = [...document.querySelectorAll('[role="tab"], button')].find(function (b) {
        return (b.textContent || "").trim() === "Withdraw";
      });
      if (wTab) {
        wTab.click();
        setTimeout(function () {
          var zap = [...document.querySelectorAll("*")].find(function (n) {
            return n.children.length <= 2 && /Zap Out/.test(n.textContent || "") && (n.textContent||"").length < 20;
          });
          pulseTarget(zap || wTab);
        }, 600);
      } else {
        var row = document.querySelector('[data-sentry-component="PositionItem"]');
        if (!pulseTarget(row) && btn) btn.textContent = "position row not found";
      }
    }
  });

  // a journaled plan binds to a position only if the position was CREATED shortly
  // after the plan was journaled (intent is not execution)
  function planMatchesPos(plan) {
    if (!plan) return false;
    // STRUCTURE GUARD (the decisive one): an Apply CLICK journals intent minutes
    // before a differently-shaped position can open, so time windows alone can't
    // reject it - but a plan whose width is wildly different from the actual band
    // is a different trade. (Caught live: BASING ±18 plan vs a -1..-72%% ladder.)
    var wp = state.apiPos && state.apiPos.widthPct;
    if (plan.widthPct && wp && isFinite(wp) && Math.abs(wp - plan.widthPct) > Math.max(12, plan.widthPct * 0.6)) return false;
    var ca = state.apiPos && state.apiPos.createdAt;
    if (!ca || !isFinite(ca)) return true;  // no creation data: keep old behavior
    var t = ca * 1000;
    return t >= (plan.ts || 0) - 900e3 && t - (plan.ts || 0) < 6 * 3600e3;
  }

  // ---- TRADE MARKS on Meteora's own TradingView chart ----------------------
  // Data (swaps + LP entries/exits) comes from the background; drawing happens in
  // the MAIN-world tv-bridge (the widget instance is a page variable). The chart
  // library itself repositions execution shapes on zoom/pan, so nothing drifts.
  // Feature flag: trade-mark bubbles on the TV chart (v0.7.1-0.7.7). Parked at
  // user request 2026-08-08 - flip to true to re-enable the whole feature
  // (bridge, background handler, and styling are all intact behind this gate).
  var MARKS_ENABLED = false;
  var marksState = { pool: null, tries: 0 };
  function pushMarksToChart() {
    if (!MARKS_ENABLED) return;
    if (ctxDead || !state.pool) { window.postMessage({ mql: 'tv-push-debug', why: 'dead-or-no-pool' }, '*'); return; }
    window.postMessage({ mql: 'tv-push-debug', why: 'requesting', pool: state.pool }, '*');
    sendMessage({ type: 'getTradeMarks', pool: state.pool }).then(safe(function (r) {
      if (!r || !r.ok || !r.marks || !r.marks.length) {
        window.postMessage({ mql: 'tv-push-debug', why: 'empty-or-error', ok: r && r.ok, err: r && r.error, n: r && r.marks && r.marks.length }, '*');
        return;
      }
      marksState.pool = state.pool;
      window.postMessage({ mql: 'tv-draw', marks: r.marks, lastSol: r.lastSol }, '*');
    }));
  }
  window.addEventListener('message', safe(function (ev) {
    if (ev.source !== window || !ev.data || ev.data.mql !== 'tv-status') return;
    if (ev.data.ready === false && marksState.tries < 6) {
      marksState.tries++;
      setTimeout(safe(pushMarksToChart), 5000);   // chart not up yet - retry
    }
  }));

  function pollMyPosition() {
    if (ctxDead) return;
    try {
      chrome.runtime.sendMessage({ type: "getMyPosition", pool: state.pool }, function (r) {
        if (chrome.runtime.lastError) return;
        state.apiPos = (r && r.ok && r.has) ? r : null;
        renderPosWatch();
      });
    } catch (e) {}
  }

  var renderPosWatch = safe(function renderPosWatch() {
    document.documentElement.setAttribute("data-mql-pw", "entered");
    var d = state.data;
    var existing = document.getElementById("mql-poswatch");
    document.documentElement.setAttribute("data-mql-pw", d ? "has-data" : "no-data");
    if (!d || !hasOpenPosition()) {
      if (existing) existing.remove();
      // clear baseline ONLY if we previously saw/rendered a position this session (true close),
      // not on page load before the positions panel has fetched (timing race).
      if (state.pwSeen && state.pool) {
        chrome.storage.local.get({ mqlPosBaseline: {} }, function (st) {
          if (st.mqlPosBaseline && st.mqlPosBaseline[state.pool]) { delete st.mqlPosBaseline[state.pool]; chrome.storage.local.set({ mqlPosBaseline: st.mqlPosBaseline }); }
        });
        state.pwSeen = false;
      }
      return;
    }
    document.documentElement.setAttribute("data-mql-pw", "storage-call");
    chrome.storage.local.get({ mqlPosBaseline: {} }, safe(function (st) {
      document.documentElement.setAttribute("data-mql-pw", "storage-cb");
      var base = st.mqlPosBaseline[state.pool];
      if (!base) {
        base = { entryFeeRate: d.feeRate1h, feeRate24h: d.feeRate24h, sigma: d.sigma, ts: Date.now(),
          feeBasis: d.feeBasis || undefined };
        st.mqlPosBaseline[state.pool] = base;
        chrome.storage.local.set({ mqlPosBaseline: st.mqlPosBaseline });
      }
      var poolCreated = d.pool && d.pool.createdAt;
      base = Object.assign({}, base, {
        entryFeeRate: legacyWindowRate(base.entryFeeRate, 1, base.ts, poolCreated, base.feeBasis) || base.entryFeeRate,
        feeRate24h: legacyWindowRate(base.feeRate24h, 24, base.ts, poolCreated, base.feeBasis) || base.feeRate24h
      });
      var boundPlan = (state.entryPlan && state.entryPlan.pool === state.pool &&
        Date.now() - (state.entryPlan.ts || 0) < 7 * 86400e3 && planMatchesPos(state.entryPlan)) ? state.entryPlan : null;
      // Apply-time baseline outranks first-seen (parity with the background watcher).
      // PLAN-BINDING GUARD: only when the position was created within [plan-15m, plan+6h]
      // — an Apply click without a signed trade must never bind to a later position.
      if (boundPlan && boundPlan.entryFeeRate > 0) {
        base = Object.assign({}, base, {
          entryFeeRate: legacyWindowRate(boundPlan.entryFeeRate, 1, boundPlan.ts, poolCreated, boundPlan.feeBasis) || boundPlan.entryFeeRate,
          feeRate24h: legacyWindowRate(boundPlan.entryFeeRate24h, 24, boundPlan.ts, poolCreated, boundPlan.feeBasis) || base.feeRate24h
        });
      }
      // spike-bias guard: decay must ALSO be below the pool's normal (24h at entry)
      var normFee = (base.feeRate24h > 0) ? base.feeRate24h : Infinity;
      // real position width: parse the range prices from the position row (handles 0.0\u2084426-style subscripts)
      var Wp = (state.apiPos && state.apiPos.widthPct) ? state.apiPos.widthPct : 20;
      try {
        var rowN = document.querySelector('[data-sentry-component="PositionItem"]');
        // DOM self-test: we KNOW a position exists (API said so) but the row
        // selector found nothing — Meteora likely redeployed their UI. Ping once.
        if (!rowN && state.apiPos && state.apiPos.has) {
          window.__mqlWidthMiss = (window.__mqlWidthMiss || 0) + 1;
          if (window.__mqlWidthMiss === 3) sendMessage({ type: "domSelfTest", what: "PositionItem row (width parsing)" });
        } else if (rowN) { window.__mqlWidthMiss = 0; }
        if (rowN) {
          var subMap = { "\u2080":0,"\u2081":1,"\u2082":2,"\u2083":3,"\u2084":4,"\u2085":5,"\u2086":6,"\u2087":7,"\u2088":8,"\u2089":9 };
          var decode = function (s) {
            var m = s.match(/0\.0([\u2080-\u2089])(\d+)/);
            if (m) return parseFloat("0." + "0".repeat(subMap[m[1]]) + m[2]);
            var f = parseFloat(s); return isNaN(f) ? null : f;
          };
          var nums = (rowN.textContent || "").match(/0\.0[\u2080-\u2089]\d+|0\.\d{3,}/g);
          if (nums && nums.length >= 2) {
            var lo = decode(nums[0]), hi = decode(nums[1]);
            if (lo && hi && hi > lo) { var mid = (lo + hi) / 2; Wp = Math.round(((hi - lo) / 2 / mid) * 100); }
          }
        }
      } catch (e) {}

      var decayPct = base.entryFeeRate > 0 ? (1 - d.feeRate1h / base.entryFeeRate) * 100 : 0;
      var ap = state.apiPos;
      var posProfile = boundPlan && boundPlan.profile ? boundPlan.profile : (ap && ap.profile);
      var isPanda = posProfile === "PANDA" || posProfile === "PANDA_INFERRED";
      var isAccum = !isPanda && (posProfile === "ACCUM" || (!posProfile && !!(ap && ap.accum)) || posProfile === "ACCUM_INFERRED");
      var profileInferred = !boundPlan && !!(ap && ap.profileInferred);
      var isCombo = !!(ap && ap.combo);
      // exit rules (same as the bot manager) — accumulation books get their own rulebook
      var verdict = "HOLD", cls = "mql-pw-hold", reasons = [];
      if (isPanda) {
        var pgate = null;
        var pz = state.panda && state.panda.ok && state.panda.pool === state.pool ? state.panda : null;
        var pex = pz && pz.signals ? pz.signals.exit : null;
        if (!pex) { verdict = "LOADING"; cls = "mql-pw-hold"; reasons.push("Panda exit signals loading…"); if (!pz) fetchPanda(); }
        else if ((pgate = window.MQLEvilPanda ? window.MQLEvilPanda.pandaExitGate({ exit: pex, timeframe: pz.timeframe,
            fillPct: ap && ap.fillPct, createdAtSec: ap && ap.createdAt, lastClosedTs: pz.signals.lastClosedTs }) : null)
            && pgate.state === "WAITING_DUMP") {
          verdict = "WAITING"; cls = "mql-pw-hold";
          reasons.push(pgate.reason + (pgate.signal ? " (the RSI2/BB pattern on screen is the pump you entered on, not a post-dump bounce — ignored)" : ""));
          reasons.push("exit arms once price dumps into the band (≥" + window.MQLEvilPanda.MIN_FILL_PCT + "% filled) — that's when you start earning");
        }
        else if (pex.state === "EXIT") { verdict = "EXIT"; cls = "mql-pw-exit"; reasons.push("Panda exit confluence on the " + pz.timeframe + " close: " + pex.legs.join(" | ")); }
        else {
          reasons.push("dumping = earning fees. Exit waits for RSI2>90 + (close>BB upper or first green MACD) on one closed " + pz.timeframe + " candle");
          reasons.push("now: RSI2 " + (pex.rsi == null ? "—" : pex.rsi) + (pex.rsiHot ? " 🔥" : "") + " · BB↑ " + (pex.bbReady ? (pex.bbHit ? "above" : "below") : "warming") + " · MACD " + (pex.macdReady ? (pex.macdHist >= 0 ? "green" : "red") : "warming"));
          if (pex.rsiHot) { verdict = "WATCH"; cls = "mql-pw-warn"; }
          if (pex.partial) reasons.push(pex.partial);
        }
        if (profileInferred || posProfile === "PANDA_INFERRED") reasons.push("profile inferred from band shape (≥80% deep, one-sided) — Apply the Panda setup before opening to bind a plan");
      } else if (isAccum) {
        // ACCUM profile: scalp TP/SL/TIGHTEN don't apply (priors pending calibration)
        var accumPositionKey = ap && ap.legs ? ap.legs.map(function (leg) { return leg.sig; }).sort().join(",") : String(ap && ap.createdAt || "unknown");
        if (state.accumPositionKey !== accumPositionKey || state.accumBaselineTs !== (base.ts || 0)) {
          state.accumPositionKey = accumPositionKey;
          state.accumBaselineTs = base.ts || 0;
          state.accumDecayDataTs = 0;
          state.accumDecayCount = 0;
        }
        var lifecycleDataReady = d.ok === true && d.ts && Date.now() - d.ts <= 120000
          && typeof d.feeRate1h === "number" && isFinite(d.feeRate1h)
          && typeof d.ofi1h === "number" && isFinite(d.ofi1h)
          && typeof d.pc1h === "number" && isFinite(d.pc1h);
        if (!lifecycleDataReady) {
          verdict = "WATCH"; cls = "mql-pw-warn";
          reasons.push("current fee and organic-flow data is unavailable — waiting for a fresh snapshot before changing the accumulation state");
        } else {
        var decayCandidate = d.feeRate1h < 0.5 * base.entryFeeRate && d.feeRate1h < normFee && base.entryFeeRate > 2;
        if (d.ts && d.ts !== state.accumDecayDataTs) {
          state.accumDecayDataTs = d.ts;
          state.accumDecayCount = decayCandidate ? state.accumDecayCount + 1 : 0;
        }
        var decayFire = decayCandidate && state.accumDecayCount >= 2;
        var flowFire = d.ofi1h != null && d.ofi1h > 3 && d.pc1h != null && d.pc1h < -15;
        if (decayFire && flowFire) {
          verdict = "EXIT"; cls = "mql-pw-exit";
          reasons.push("token dying while you accumulate — fee engine " + Math.round(decayPct) + "% below baseline AND organic distribution " + fmtNum(d.ofi1h, 1) + ":1. Both kill-rules fired.");
        } else if (decayFire || flowFire) {
          // Same lifecycle as the background watcher / Discord alerts: WAIT only
          // when one of the two kill-rules has actually fired.
          verdict = "WATCH"; cls = "mql-pw-warn";
          if (decayFire) reasons.push("fee engine decayed " + Math.round(decayPct) + "% — EXIT arms if the flow flips too");
          if (flowFire) reasons.push("organic distribution " + fmtNum(d.ofi1h, 1) + ":1 into your band — EXIT arms if the fee engine dies too");
        } else {
          reasons.push("accumulating as designed — volume alive (" + fmtNum(d.feeRate1h, 1) + "%/d), flow OFI " + fmtNum(d.ofi1h, 2));
          // Softening used to flip this card to WAIT ("stop adding") at 25% below
          // the entry rate. Entries usually happen on a fee spike, so that fired on
          // the normal post-spike cool-off (the FEE-DECAY spike bias the CLI fixed
          // in f2ea60d) while the Discord watcher stayed silent. Now a note only.
          if (decayPct > 25 || d.trend === "COOLING") {
            reasons.push(!isFinite(normFee)
              ? "note: fees " + Math.round(decayPct) + "% below your entry rate — decay arms at 50% below entry, two reads in a row"
              : d.feeRate1h >= normFee
              ? "note: fees " + Math.round(decayPct) + "% below your entry rate but still above the pool's normal (" + fmtNum(normFee, 1) + "%/d) — post-spike cool-off, not decay"
              : "note: fees " + Math.round(decayPct) + "% below your entry rate and under the pool's normal — decay arms at 50% below entry, two reads in a row");
          }
        }
        if (d.path === "FREEFALL" && verdict !== "EXIT") reasons.push("FREEFALL: band filling fast — that is the design; the kill-switch is fee-decay + flow-flip, not price");
        }
      } else {
      if (d.feeRate1h < 0.5 * base.entryFeeRate && d.feeRate1h < normFee && base.entryFeeRate > 2) {
        verdict = "EXIT"; cls = "mql-pw-exit";
        reasons.push("fee engine decayed " + Math.round(decayPct) + "% from your baseline (" + fmtNum(base.entryFeeRate,1) + " → " + fmtNum(d.feeRate1h,1) + "%/d) and is below the pool's normal (" + fmtNum(base.feeRate24h,1) + ") — the fees were the trade");
      }
      if (d.feeRate1h < 0.5 * base.entryFeeRate && d.feeRate1h >= normFee && verdict === "HOLD") {
        verdict = "WATCH"; cls = "mql-pw-warn";
        reasons.push("entry fee spike has passed (" + fmtNum(base.entryFeeRate,1) + " → " + fmtNum(d.feeRate1h,1) + ") but rate is still above the pool's normal " + fmtNum(base.feeRate24h,1) + "%/d — spike over, engine alive");
      }
      if (d.ofi1h != null && d.ofi1h > 3 && d.pc1h != null && d.pc1h < -15) {
        verdict = "EXIT"; cls = "mql-pw-exit";
        reasons.push("organic distribution " + fmtNum(d.ofi1h,1) + ":1 while price dumps " + fmtNum(d.pc1h,1) + "%/1h — real wallets are leaving through you");
      }
      if (d.path === "FREEFALL") {
        verdict = "EXIT"; cls = "mql-pw-exit";
        reasons.push("price in FREEFALL — your bins are converting into the falling token");
      }
      if (verdict === "HOLD" && Wp < 30 && d.surge != null && d.surge < 1.05 && d.ofi1h != null && d.ofi1h > 2.5) {
        verdict = "TIGHTEN"; cls = "mql-pw-warn";
        reasons.push("vol premium dead (surge " + fmtNum(d.surge,2) + "x) + sell-skewed flow — consider taking fees off");
      }
      if (verdict === "HOLD") {
        if (decayPct > 25) { verdict = "WATCH"; cls = "mql-pw-warn"; reasons.push("fee rate down " + Math.round(decayPct) + "% from baseline — exit rule fires at 50%"); }
        else reasons.push("fee engine healthy (" + fmtNum(d.feeRate1h,1) + "%/d, " + (decayPct >= 0 ? Math.round(decayPct) + "% below" : Math.round(-decayPct) + "% above") + " baseline) · flow OFI " + fmtNum(d.ofi1h,2));
      }
      }
      // explicit action guidance per verdict
      var doLine = null, assist = null;
      if (isPanda) {
        if (verdict === "EXIT") { doLine = "DO: close 100% → SOL now. First bounce is the exit; don't wait for higher."; assist = { kind: "exit", label: "→ open the Withdraw panel" }; }
        else if (verdict === "WATCH") doLine = "DO: get ready — RSI2 is hot; exit fires the moment a confirming leg closes with it.";
        else if (verdict === "WAITING") doLine = "DO: nothing — you're 100% SOL above the dump. Fees start when price falls into the band.";
        else doLine = "DO: nothing — let it dump into your band. Be happy, fees are accruing.";
      } else if (isAccum) {
        if (verdict === "HOLD") doLine = "DO: nothing — let the band fill. You only buy dips here.";
        else if (verdict === "WATCH") doLine = "DO: stop adding size. If the second kill-rule fires, cut — no negotiating.";
        else if (verdict === "EXIT") { doLine = "DO: close and take what's left back to SOL — accumulating a dying token is just slow bleeding."; assist = { kind: "exit", label: "→ open the Withdraw panel" }; }
      }
      else if (verdict === "HOLD") doLine = "DO: nothing — let it print.";
      else if (verdict === "WATCH") doLine = "DO: nothing yet — stop adding size, re-check often; EXIT arms at 50% decay.";
      else if (verdict === "TIGHTEN") { doLine = "DO: claim accrued fees NOW (bank the harvest) and consider pulling partial size. Keep a runner."; assist = { kind: "claim", label: "→ show me the Claim button" }; }
      else if (verdict === "EXIT") { doLine = "DO: close 100% → Zap Out to SOL. Do not negotiate with a fired rule."; assist = { kind: "exit", label: "→ open the Withdraw panel" }; }

      var displayVerdict = isPanda ? (verdict === "LOADING" ? "…" : verdict === "HOLD" ? "FARMING DUMP" : verdict === "WAITING" ? "WAITING FOR DUMP" : verdict === "WATCH" ? "EXIT ARMING" : verdict)
        : isAccum ? (verdict === "HOLD" ? "ACCUMULATING" : verdict === "WATCH" ? "WAIT" : verdict) : verdict;
      var card = existing || el("div", "mql-card");
      card.id = "mql-poswatch";
      card.innerHTML = "";
      var head = el("div", "mql-pw-head");
      head.appendChild(el("span", "mql-pw-title", "POSITION WATCH"));
      if (isCombo) head.appendChild(el("span", "mql-pw-combo", "COMBO ×" + ap.count));
      if (isAccum) head.appendChild(el("span", "mql-pw-combo", "🪣 BID ASK" + (profileInferred ? " · inferred legacy" : "")));
      if (isPanda) head.appendChild(el("span", "mql-pw-combo", "🐼 PANDA" + (posProfile === "PANDA_INFERRED" ? " · inferred" : "")));
      var pill = el("span", "mql-pw-pill " + cls, displayVerdict);
      tipify(pill, "poswatch");
      head.appendChild(pill);
      card.appendChild(head);
      reasons.forEach(function (r) { card.appendChild(el("div", "mql-pw-reason", "• " + r)); });
      if (doLine) card.appendChild(el("div", "mql-pw-do", doLine));
      // live sigma-scaled brackets (scalp books) OR fill tracking (accum books)
      try {
        if (isPanda) {
          var pzp = state.entryPlan && state.entryPlan.profile === "PANDA" ? state.entryPlan : null;
          card.appendChild(el("div", "mql-pw-brackets", "Panda band 0% → -" + (pzp ? pzp.depthPct : Math.round((1 - (ap && ap.minPrice / ap.maxPrice || 0.1)) * 100)) + "% · no TP/SL brackets — exit is indicator-driven (" + ((state.panda && state.panda.timeframe) || "5m") + ")"));
        } else if (!isAccum) {
          var clampN = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
          // entry plan (journaled at Apply) outranks generic width-math
          var plan = boundPlan;
          var tpB = plan && plan.tp ? plan.tp : Math.round(clampN(Wp / 4 + (base.entryFeeRate || d.feeRate1h || 0) * 0.5, 8, 25));
          var slB = plan && plan.sl ? plan.sl : Math.round(clampN(0.75 * Wp + 2, 8, 20));
          var pnlNow = (state.apiPos && state.apiPos.pnlPct != null) ? state.apiPos.pnlPct : null;  // API only — DOM rows contain unrelated %s
          var btxt = plan
            ? "Brackets (" + plan.cls + " plan · band \u00b1" + Wp + "%): TP +" + tpB + "% / SL -" + slB + "%"
            : "Brackets (\u00b1" + Wp + "% band): TP +" + tpB + "% / SL -" + slB + "%";
          if (pnlNow != null && !isNaN(pnlNow)) {
            btxt += "  \u00b7  now " + (pnlNow >= 0 ? "+" : "") + pnlNow.toFixed(1) + "%  (TP " + (tpB - pnlNow).toFixed(1) + " away, SL " + (pnlNow + slB).toFixed(1) + " of cushion)";
          }
          var bEl = el("div", "mql-pw-brackets", btxt);
          tipify(bEl, "pwbrackets");
          card.appendChild(bEl);
          if (plan) {
            // width drift: the band you actually hold vs the recipe you applied
            if (plan.widthPct && Math.abs(Wp - plan.widthPct) > 0.4 * plan.widthPct) {
              card.appendChild(el("div", "mql-pw-reason", "⚠ band \u00b1" + Wp + "% ≠ plan \u00b1" + plan.widthPct + "% — range likely reset before you signed (Auto-Fill trap). Brackets shown are the PLAN's; judge fills accordingly."));
            }
            if (plan.stopPrice > 0) {
              var curP = state.apiPos && state.apiPos.poolActivePrice;
              var broken = curP != null && isFinite(curP) && curP < plan.stopPrice;
              card.appendChild(el("div", broken ? "mql-pw-do" : "mql-pw-reason",
                broken ? "⛔ PLAN STOP BROKEN — price under " + plan.stopPrice.toExponential(3) + ": thesis dead, exit regardless of PnL"
                       : "plan stop " + plan.stopPrice.toExponential(3) + " ✓ price above"));
            }
          }
        } else {
          // band line relative to current price (no scalp brackets on a bag build)
          var bandTxt = "band ";
          if (ap && ap.minPrice != null && ap.poolActivePrice) {
            var hiRel = (ap.maxPrice / ap.poolActivePrice - 1) * 100;
            var loRel = (ap.minPrice / ap.poolActivePrice - 1) * 100;
            bandTxt += fmtNum(hiRel, 0) + "% → " + fmtNum(loRel, 0) + "% vs price";
            var pnlA = (ap.pnlPct != null && !isNaN(ap.pnlPct)) ? ap.pnlPct : null;
            if (pnlA != null) bandTxt += "  ·  PnL " + (pnlA >= 0 ? "+" : "") + fmtNum(pnlA, 1) + "%";
          } else if (state.entryPlan && state.entryPlan.pool === state.pool && Number(state.entryPlan.depthPct) > 0) {
            // no live price range yet: an accumulation band is 0 -> -depth below entry, not +-W
            bandTxt += "0% \u2192 -" + fmtNum(Number(state.entryPlan.depthPct), 0) + "% (entry plan)";
          } else bandTxt += "(range unavailable)";
          card.appendChild(el("div", "mql-pw-brackets", bandTxt));
          // fill progress bar — the bag you're building
          var fw = el("div", "mql-fillwrap");
          var flab = el("div", "mql-fill-label",
            (ap && ap.fillPct != null)
              ? ("FILLED " + ap.fillPct + "%" + (ap.fillMethod === "traversal" ? " (\u2248 price traversal)" : ap.fillMethod === "sol-spent" ? " of your SOL spent" : ""))
              : "fill: unknown");
          tipify(flab, "accumfill");
          fw.appendChild(flab);
          var fbw = el("div", "mql-fillbarwrap");
          var fb = el("div", "mql-fillbar");
          fb.style.width = Math.max(2, Math.min(100, (ap && ap.fillPct) || 0)) + "%";
          fbw.appendChild(fb);
          fw.appendChild(fbw);
          card.appendChild(fw);
        }
        // per-leg lines for combo books
        if (isCombo && ap && ap.legs) {
          ap.legs.forEach(function (l, i) {
            var rangeTxt = (l.minPrice != null && ap.poolActivePrice)
              ? fmtNum((l.maxPrice / ap.poolActivePrice - 1) * 100, 0) + "%→" + fmtNum((l.minPrice / ap.poolActivePrice - 1) * 100, 0) + "%"
              : "\u00b1" + l.widthPct + "%";
            card.appendChild(el("div", "mql-pw-leg",
              "leg " + (i + 1) + ": " + rangeTxt +
              " · PnL " + (l.pnlPct >= 0 ? "+" : "") + fmtNum(l.pnlPct, 1) + "%" +
              (l.fillPct != null ? " · fill " + l.fillPct + "%" : "")));
          });
        }
      } catch (e) {}
      if (assist) {
        var aBtn = el("button", "mql-apply mql-pw-assist", assist.label);
        aBtn.addEventListener("click", function () { posAssist(assist.kind, aBtn); });
        card.appendChild(aBtn);
      }
      var sub = el("div", "mql-pw-sub", "baseline: " + fmtNum(base.entryFeeRate,1) + "%/d fee rate, first seen " + fmtAge((Date.now()-base.ts)/3600000) + " ago" + (Math.abs(base.ts - Date.now()) < 90000 ? " (just now — baseline = first sight, not your true entry)" : ""));
      card.appendChild(sub);
      document.documentElement.setAttribute("data-mql-pw", "rendered");
      state.pwSeen = true;
      if (!existing) {
        var hud = document.getElementById("mql-hud");
        if (hud) hud.parentElement.insertBefore(card, hud.nextSibling);
      }
    }));
  });


  // ---- RADAR banner: clickable actionable pools, top of page ----
  var radarCollapsed = false;
  var lastRadarData = null;
  var renderRadar = safe(function renderRadar(r) {
    if (r) lastRadarData = r;
    r = r || lastRadarData;
    var bar = document.getElementById("mql-radar");
    if (!bar) {
      bar = el("div", "");
      bar.id = "mql-radar";
      document.body.appendChild(bar);
    }
    bar.innerHTML = "";
    try { applyDrawerLayout(); } catch (e) {}
    var head = el("span", "mql-radar-title", "📡 RADAR");
    tipify(head, "radar");
    head.style.cursor = "pointer";
    head.addEventListener("click", function () { radarCollapsed = !radarCollapsed; bar.classList.toggle("mql-radar-min", radarCollapsed); renderRadar(null); });
    bar.appendChild(head);
    if (radarCollapsed) {
      var n = (r && r.items) ? r.items.length : 0;
      var full = (r && r.items) ? r.items.filter(function(i){return i.kind==="FULL" || i.kind==="BID_ASK" || i.kind==="PANDA";}).length : 0;
      bar.appendChild(el("span", "mql-radar-empty", full > 0 ? full + "🔥 " + (n-full) + "⚠" : n + " watched"));
      return;
    }
    if (!r || !r.ok || !r.items || !r.items.length) {
      bar.appendChild(el("span", "mql-radar-empty", "nothing actionable on the board"));
      return;
    }
    r.items.forEach(function (it) {
      var isBidAsk = it.kind === "BID_ASK";
      var isBidWatch = it.kind === "BID_WATCH";
      var isPandaChip = it.kind === "PANDA" || it.kind === "PANDA_WATCH";
      var chip = el("button", "mql-chip " + (it.kind === "FULL" ? "mql-chip-full mql-chip-" + it.cls.toLowerCase() : isBidAsk ? "mql-chip-full mql-chip-carry" : isBidWatch ? "mql-chip-watch" : "mql-chip-near"));
      var bs = it.binStep ? (it.binStep + "bps ") : "";
      var lbl = isPandaChip ? ("🐼 " + it.name + " " + bs + "· PANDA " + (it.kind === "PANDA" ? "ENTRY" : ((it.panda && it.panda.entry) || "WATCH")) + " · " + ((it.panda && it.panda.tf) || "") + (it.panda && it.panda.ageMin != null ? " · " + (it.panda.ageMin >= 120 ? Math.round(it.panda.ageMin / 6) / 10 + "h" : it.panda.ageMin + "m") + " old" : ""))
        : it.kind === "FULL" ? ("🔥 " + it.name + " " + bs + "· " + it.cls + " · edge " + fmtNum(it.edge, 2))
        : isBidAsk ? ("🪣 " + it.name + " " + bs + "· BID ASK READY · 0→-" + (it.bidAsk && it.bidAsk.depthPct) + "%")
        : isBidWatch ? ("⚠ " + it.name + " " + bs + "· BID ASK WATCH · candle gates pending")
        : ("⚠ " + it.name + " " + bs + "· edge " + fmtNum(it.edge, 2) + " · misses " + (it.fails || []).map(function(f){return f.split(" ")[0];}).join("+"));
      if ((isBidAsk || isBidWatch) && it.candleAnalysis) {
        var ca = it.candleAnalysis;
        if (ca.events) lbl += ca.events.matured > 0
          ? " · dips " + ca.events.total + " (" + ca.events.recovered + "/" + ca.events.matured + " rec)"
          : " · dips " + ca.events.total + " (" + ca.events.pending + " pending)";
        else if (ca.state === "WAIT") lbl += " · candles WAIT";
      }
      chip.textContent = lbl;
      if (isPandaChip) chip.className = "mql-chip " + (it.kind === "PANDA" ? "mql-chip-full mql-chip-panda" : "mql-chip-watch");
      chip.title = isPandaChip ? (it.kind === "PANDA" ? "Evil Panda: filters pass + fresh Supertrend break. Click to open; Apply from the Panda card." : "Evil Panda: filters pass, waiting for the Supertrend break (" + ((it.panda && it.panda.why) || "") + ").")
        : it.kind === "FULL" ? "All gates green — full " + it.cls + " signal. Click to open."
        : isBidAsk ? "Base and candle qualification gates pass. Manual Bid-Ask + Spot guide; click to open."
        : isBidWatch ? "Base BID ASK gates pass, but candle qualification is incomplete. No entry guide yet; click to inspect the reason."
        : "Near-miss (override-eligible): fails " + (it.fails || []).join(", ") + ". Click to open.";
      chip.addEventListener("click", function () { window.location.href = "/dlmm/" + it.address; });
      bar.appendChild(chip);
    });
    // age from the stalest per-pool snapshot inside the build, not the build wrapper
    // (poolCache + radarCache stack: chips can be minutes older than the old label claimed)
    var ageMin = Math.round((Date.now() - (r.oldestDataTs || r.ts)) / 60000);
    var ago = el("span", "mql-radar-ts", ageMin + "m" + (ageMin >= 3 ? " ⏳" : ""));
    ago.title = "Age of the oldest pool snapshot in this radar build. HUD refreshes every 60s; radar every 3 min — a fast-moving σ can make chip edges lag the HUD.";
    bar.appendChild(ago);
  });
  function pollRadar() {
    if (ctxDead) return;
    if (document.visibilityState !== "visible") return;
    try {
      chrome.runtime.sendMessage({ type: "getRadar" }, function (r) {
        if (chrome.runtime.lastError) return;
        renderRadar(r);
      });
    } catch (e) { if (isCtxDeadError(e && e.message)) markCtxDead(); }
  }
  setInterval(safe(pollRadar), 180e3);
  setTimeout(safe(pollRadar), 4000);

  var renderHUD = safe(function renderHUD() {
    var hud = document.getElementById("mql-hud");
    if (!hud) return;
    // don't yank the DOM out from under the user while they type in a Lens input
    try {
      var ae = document.activeElement;
      if (ae && ae.tagName === "INPUT" && ae.closest && ae.closest("#mql-hud")) return;
    } catch (e) {}
    var d = state.data;

    if (!d) {
      hud.innerHTML = "";
      var loading = el("div", "mql-row mql-muted", "Meteora Quant Lens — loading…");
      hud.appendChild(headerNode());
      hud.appendChild(loading);
      return;
    }

    hud.innerHTML = "";
    hud.appendChild(headerNode());

    // VERDICT pill
    var v = d.verdict || { class: "NONE", reasons: [] };
    var vRow = el("div", "mql-row mql-verdict-row");
    var pill = el("span", "mql-pill " + verdictClassColor(v.class));
    pill.textContent = v.class === "NONE" ? "NO ENTRY" : v.class;
    if (v.reasons && v.reasons.length) pill.title = v.reasons.join("\n");
    vRow.appendChild(pill);
    hud.appendChild(vRow);

    // EDGE row with bar
    var edge = d.edge;
    var edgeRow = el("div", "mql-row");
    edgeRow.appendChild(el("span", "mql-label", "EDGE"));
    var edgeVal = el("span", "mql-val " + colorForEdge(edge), fmtNum(edge, 2));
    edgeRow.appendChild(edgeVal);
    // edge at the recipe's actual width (edge scales linearly with band width)
    if (d.edgeRecipe != null && d.recipeW != null) {
      var er = el("span", "mql-sub " + colorForEdge(d.edgeRecipe), (d.recipeSingle ? " 0\u2192-" + d.recipeW + "%: " : " \u00b1" + d.recipeW + "%: ") + fmtNum(d.edgeRecipe, 2));
      er.title = "Edge re-quoted at the recommended band width (\u00b1" + d.recipeW + "%). The headline number assumes the default \u00b1" + (d._W || 20) + "% \u2014 wider bands pay less IL per unit of vol, so the same pool quotes better at the recipe width.";
      edgeRow.appendChild(er);
    }
    // 60-min edge sparkline from the recorded trail (same-source entries only)
    try {
      var tr9 = (d.trail || []).filter(function (x) { return x.src === (d.sigmaSource === "rv5m" ? "rv" : "lg") && x.sigma > 0; }).slice(-60);
      if (tr9.length >= 5) {
        var Wsp = d._W || 20;
        // same formula as background computeEdge: LP-net fees / (1.3 * sigma^2/(4W))
        var es = tr9.map(function (x) { return (x.feeRate / x.sigma) / Math.max(1.3 * x.sigma / (4 * Wsp), 0.001); });
        var mx = Math.max.apply(null, es.concat([1.5])), mn = 0;
        var pts = es.map(function (v, i) {
          return (i / (es.length - 1) * 96 + 2).toFixed(1) + "," + (16 - ((v - mn) / (mx - mn)) * 14 + 1).toFixed(1);
        }).join(" ");
        var svgNS = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "100"); svg.setAttribute("height", "18");
        svg.setAttribute("class", "mql-spark");
        var yGate = (16 - ((1.0 - mn) / (mx - mn)) * 14 + 1).toFixed(1);
        var gate = document.createElementNS(svgNS, "line");
        gate.setAttribute("x1", "2"); gate.setAttribute("x2", "98");
        gate.setAttribute("y1", yGate); gate.setAttribute("y2", yGate);
        gate.setAttribute("stroke", "#555"); gate.setAttribute("stroke-dasharray", "2,2"); gate.setAttribute("stroke-width", "1");
        svg.appendChild(gate);
        var pl = document.createElementNS(svgNS, "polyline");
        pl.setAttribute("points", pts);
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", es[es.length - 1] >= 1 ? "#4ade80" : "#f87171");
        pl.setAttribute("stroke-width", "1.5");
        svg.appendChild(pl);
        svg.setAttribute("title", "edge over the last ~hour \u00b7 dashed line = 1.0 gate");
        edgeRow.appendChild(svg);
      }
    } catch (e) {}
    hud.appendChild(edgeRow);
    var barWrap = el("div", "mql-barwrap");
    var bar = el("div", "mql-bar " + colorForEdge(edge));
    var pct = Math.max(0, Math.min(100, ((edge || 0) / 2) * 100)); // 2.0 = full bar
    bar.style.width = pct + "%";
    barWrap.appendChild(bar);
    hud.appendChild(barWrap);
    hud.appendChild(el("div", "mql-sub", "pool-wide fee/IL heuristic · position shape and costs not modeled"));

    // Fee rate row
    var frRow = el("div", "mql-row");
    frRow.appendChild(el("span", "mql-label", "Fee"));
    var frTxt = d.poolStage === "LAUNCH"
      ? fmtPct(d.feeRate1h, 1) + "/d · pool " + Math.max(1, Math.round(Number(d.poolAgeH) * 60)) + "m old (provisional)"
      : "1h " + fmtPct(d.feeRate1h, 1) + "/d vs " + feeWindowLabel(d) + " " + fmtPct(d.feeRate24h, 1);
    var frVal = el("span", "mql-val", frTxt);
    frRow.appendChild(frVal);
    hud.appendChild(frRow);
    var trendRow = el("div", "mql-row");
    var trend = d.trend || "steady";
    var tSpan = el("span", "mql-trend");
    if (trend === "HEATING") { tSpan.className = "mql-trend mql-good"; tSpan.textContent = "▲ HEATING"; }
    else if (trend === "COOLING") { tSpan.className = "mql-trend mql-bad"; tSpan.textContent = "▼ COOLING"; }
    else if (trend === "NEW") { tSpan.className = "mql-trend mql-muted"; tSpan.textContent = "• NEW POOL (<1h)"; }
    else { tSpan.className = "mql-trend mql-muted"; tSpan.textContent = "– steady"; }
    trendRow.appendChild(tSpan);
    hud.appendChild(trendRow);

    // sigma / surge / accel
    var grid = el("div", "mql-grid3");
    grid.appendChild(metricCell("σ", fmtPct(d.sigma, 1) + "/d" + (d.sigmaSource === "legacy" ? " ~" : ""), "mql-neutral"));
    grid.appendChild(metricCell("Surge", fmtNum(d.surge, 2) + "x",
      (d.surge != null && d.surge >= 1.25) ? "mql-good" : "mql-neutral"));
    grid.appendChild(metricCell("Accel", fmtNum(d.accel, 2) + "x",
      (d.accel != null && d.accel >= 1.2) ? "mql-good" : "mql-neutral"));
    hud.appendChild(grid);

    // Flow / OFI
    var flowRow = el("div", "mql-row");
    flowRow.appendChild(el("span", "mql-label", "Flow"));
    var ofi1 = d.ofi1h, ofi6 = d.ofi6h;
    var flowTxt = "1h " + fmtNum(ofi1, 2) + " / 6h " + fmtNum(ofi6, 2);
    var flowCls = "mql-neutral";
    var flowTag = "";
    if (ofi1 != null && ofi1 > 2) { flowCls = "mql-bad"; flowTag = " distribution"; }
    else if (ofi1 != null && ofi1 < 0.5) { flowCls = "mql-good"; flowTag = " accumulation"; }
    var flowVal = el("span", "mql-val " + flowCls, flowTxt + flowTag);
    flowRow.appendChild(flowVal);
    hud.appendChild(flowRow);

    // Path + drawdown
    var pathRow = el("div", "mql-row");
    var pathLbl = el("span", "mql-label", "Path"); tipify(pathLbl, "path"); pathRow.appendChild(pathLbl);
    var pathTxt = (d.path || "—") + "  ▼" + fmtPct(d.ddHigh, 1) + " from high";
    pathRow.appendChild(el("span", "mql-val", pathTxt));
    hud.appendChild(pathRow);

    // Token safety
    var tokRow = el("div", "mql-row");
    var tokLbl = el("span", "mql-label", "Token"); tipify(tokLbl, "token"); tokRow.appendChild(tokLbl);
    var ageTxt = d.tokenAgeHours != null ? fmtAge(d.tokenAgeHours) : "—";
    var org = d.organicScore != null ? Math.round(d.organicScore) : "—";
    tokRow.appendChild(el("span", "mql-val", "org " + org + " · " + ageTxt));
    hud.appendChild(tokRow);

    var authRow = el("div", "mql-row mql-sub2");
    var mintOk = d.mintAuthorityDisabled;
    var freezeOk = d.freezeAuthorityDisabled;
    var mintSpan = el("span", mintOk ? "mql-good" : "mql-bad",
      (mintOk ? "✓" : "⚠️") + " mint");
    var freezeSpan = el("span", freezeOk ? "mql-good" : "mql-bad",
      (freezeOk ? "✓" : "⚠️") + " freeze");
    var topSpan = el("span", "mql-muted",
      "top10 " + (d.topHoldersPct != null ? fmtPct(d.topHoldersPct, 0) : "—"));
    authRow.appendChild(mintSpan);
    authRow.appendChild(document.createTextNode("  "));
    authRow.appendChild(freezeSpan);
    authRow.appendChild(document.createTextNode("  "));
    authRow.appendChild(topSpan);
    hud.appendChild(authRow);


    // WHAT TO DO (recommendation)
    if (d.recommendation) {
      var rec = d.recommendation;
      var recWrap = el("div", "mql-rec");
      var recHead = el("div", "mql-rec-head");
      var actCls = rec.action === "SCALP" ? "mql-rec-scalp" : rec.action === "REVERSION" ? "mql-rec-rev" : rec.action === "CARRY" ? "mql-rec-carry" : rec.action === "SQUEEZE" ? "mql-rec-squeeze" : "mql-rec-wait";
      recHead.appendChild(el("span", "mql-rec-pill " + actCls, rec.action === "WAIT" ? "⏸ WAIT" : "▶ " + rec.action));
      recWrap.appendChild(recHead);
      if (rec.headline) recWrap.appendChild(el("div", "mql-rec-headline", rec.headline));
      (rec.steps || []).forEach(function (s) { recWrap.appendChild(el("div", "mql-rec-step", "• " + s)); });
      if (rec.params && rec.action !== "WAIT") {
        var applyBtn = el("button", "mql-apply", "⚡ Apply setup to form");
        applyBtn.addEventListener("click", function () {
          applySetup(rec.params, applyBtn);
          // journal the ENTRY PLAN so Position Watch honors the class brackets
          // (BASING +20/-15 + stop, etc.) instead of re-deriving generic width-math
          if (rec.plan && state.pool) {
            try {
              chrome.storage.local.get({ mqlEntryPlan: {} }, safe(function (jr) {
                var plans = jr.mqlEntryPlan || {};
                plans[state.pool] = Object.assign({}, rec.plan, { pool: state.pool, ts: Date.now(),
                  // baseline at the moment you actually entered — Position Watch prefers
                  // this over the first-seen snapshot (which can catch a spike or a lull)
                  entryFeeRate: (state.data && state.data.feeRate1h > 0) ? state.data.feeRate1h : null,
                  entryFeeRate24h: (state.data && state.data.feeRate24h > 0) ? state.data.feeRate24h : null,
                  feeBasis: (state.data && state.data.feeBasis) || undefined,
                  // full entry-time signal snapshot: joined into the close journal row
                  // so every round trip is origin-tagged for calibration
                  entryEdge: (state.data && state.data.edge != null) ? Math.round(state.data.edge * 100) / 100 : null,
                  entryEdgeBasis: (state.data && state.data.edgeBasis) || null,
                  entrySigma: (state.data && state.data.sigma != null) ? Math.round(state.data.sigma * 10) / 10 : null,
                  entrySigmaSource: (state.data && state.data.sigmaSource) || null });
                chrome.storage.local.set({ mqlEntryPlan: plans });
                state.entryPlan = plans[state.pool];
              }));
            } catch (e) {}
          }
        });
        recWrap.appendChild(applyBtn);
      }
      // discretionary override on WAIT: 2-step confirm + journal
      if (rec.action === "WAIT" && rec.override && rec.override.params) {
        var ov = rec.override;
        var ovBtn = el("button", "mql-apply mql-override", "⚠ Override: apply " + ov.cls + " setup anyway");
        var armed = false;
        ovBtn.addEventListener("click", safe(function () {
          if (!armed) {
            armed = true;
            ovBtn.textContent = "Ignoring: " + (ov.ignoredGates || []).join(" · ").slice(0, 90) + " — click again to apply (" + (ov.sizeNote || "half size") + ")";
            setTimeout(function(){ if (armed) { armed = false; ovBtn.textContent = "⚠ Override: apply " + ov.cls + " setup anyway"; } }, 8000);
            return;
          }
          armed = false;
          applySetup(ov.params, ovBtn);
          try {
            if (ov.plan && state.pool) {
              chrome.storage.local.get({ mqlEntryPlan: {} }, function (ep) {
                var plans = ep.mqlEntryPlan || {};
                plans[state.pool] = Object.assign({}, ov.plan, { pool: state.pool, ts: Date.now(),
                  entryFeeRate: state.data && state.data.feeRate1h > 0 ? state.data.feeRate1h : null,
                  entryFeeRate24h: state.data && state.data.feeRate24h > 0 ? state.data.feeRate24h : null,
                  feeBasis: state.data && state.data.feeBasis || undefined,
                  entryEdge: state.data && state.data.edge != null ? Math.round(state.data.edge * 100) / 100 : null,
                  entryEdgeBasis: state.data && state.data.edgeBasis || null,
                  entrySigma: state.data && state.data.sigma != null ? Math.round(state.data.sigma * 10) / 10 : null,
                  entrySigmaSource: state.data && state.data.sigmaSource || null });
                chrome.storage.local.set({ mqlEntryPlan: plans });
                state.entryPlan = plans[state.pool];
              });
            }
            chrome.storage.local.get({ mqlOverrideJournal: [] }, function (st) {
              var j = st.mqlOverrideJournal || [];
              j.push({ ts: Date.now(), pool: state.pool, cls: ov.cls, ignoredGates: ov.ignoredGates, edge: state.data && state.data.edge, edgeBasis: state.data && state.data.edgeBasis || null, sigma: state.data && state.data.sigma, feeRate1h: state.data && state.data.feeRate1h });
              chrome.storage.local.set({ mqlOverrideJournal: j.slice(-100) });
            });
          } catch (e) {}
        }));
        recWrap.appendChild(ovBtn);
      }
      (rec.watch || []).forEach(function (w) { recWrap.appendChild(el("div", "mql-rec-warn", w)); });
      hud.appendChild(recWrap);
    }

    // ACCUM COMBO block (long-term accumulation recipe; priors pending calibration)
    try { renderAccumBlock(hud, d); } catch (e) {}
    try { renderPandaBlock(hud); } catch (e) {}


    // attach hover explainers to remaining zones
    try {
      var labMap = { "EDGE": "edge", "Fee": "fee", "\u03c3": "sigma", "Surge": "surge", "Accel": "accel", "Flow": "flow" };
      hud.querySelectorAll(".mql-label").forEach(function (n) {
        var t = (n.textContent || "").trim();
        for (var k in labMap) { if (t.indexOf(k) === 0) { tipify(n, labMap[k]); break; } }
      });
      var pill = hud.querySelector(".mql-pill, .mql-verdict"); if (pill) tipify(pill, "verdict");
      var recPill = hud.querySelector(".mql-rec-pill"); if (recPill) tipify(recPill, "rec");
    } catch (e) {}
    // Footer
    hud.appendChild(footerNode());
    try { renderTrackPoolLine(); } catch (e) {}
    updateAgeLabel();
  });

  function fmtAge(hours) {
    if (hours == null || isNaN(hours)) return "—";
    if (hours < 24) return fmtNum(hours, 0) + "h";
    var days = hours / 24;
    if (days < 30) return fmtNum(days, 1) + "d";
    return fmtNum(days / 30, 1) + "mo";
  }

  function metricCell(label, val, cls) {
    var c = el("div", "mql-cell");
    c.appendChild(el("div", "mql-cell-l", label));
    c.appendChild(el("div", "mql-cell-v " + (cls || ""), val));
    return c;
  }

  function headerNode() {
    var h = el("div", "mql-header");
    h.appendChild(el("span", "mql-title", "QUANT LENS"));
    h.appendChild(el("span", "mql-badge-dot", "●"));
    return h;
  }

  function footerNode() {
    var f = el("div", "mql-footer");
    var age = el("span", "mql-age");
    age.id = "mql-age";
    age.textContent = "refreshed just now";
    f.appendChild(age);
    var btn = el("button", "mql-refresh", "↻");
    btn.type = "button";
    btn.title = "Refresh now";
    btn.addEventListener("click", safe(function (e) {
      e.preventDefault();
      e.stopPropagation();
      fetchData();
    }));
    f.appendChild(btn);
    return f;
  }

  var updateAgeLabel = safe(function updateAgeLabel() {
    var age = document.getElementById("mql-age");
    if (!age || !state.lastFetchTs) return;
    var secs = Math.round((Date.now() - state.lastFetchTs) / 1000);
    age.textContent = "refreshed " + (secs <= 0 ? "just now" : secs + "s ago");
  });

  var renderHUDError = safe(function renderHUDError(msg) {
    var hud = document.getElementById("mql-hud");
    if (!hud) return;
    hud.innerHTML = "";
    hud.appendChild(headerNode());
    var row = el("div", "mql-row mql-bad", "data error: " + (msg || "unknown"));
    hud.appendChild(row);
    var f = el("div", "mql-footer");
    var btn = el("button", "mql-refresh", "↻ retry");
    btn.type = "button";
    btn.addEventListener("click", safe(function (e) { e.preventDefault(); fetchData(); }));
    f.appendChild(btn);
    hud.appendChild(f);
  });

  // ========================================================================
  // 2. FEES/TVL TRUTH BADGE (#mql-feebadge)
  // ========================================================================
  function findFeeTvlValueContainer() {
    // The label leaf DIV text starts with "24h Fees/TVL". Its row is
    // <div class="flex items-center justify-between gap-2.5"> label + value sibling.
    var candidates = document.querySelectorAll("div");
    for (var i = 0; i < candidates.length; i++) {
      var n = candidates[i];
      // leaf-ish check: no element children carrying more nested divs of text
      var txt = (n.textContent || "").trim();
      if (txt.indexOf("24h Fees/TVL") === 0 && txt.length < 40) {
        // make sure this is the label leaf, not a big wrapper
        var row = n.parentElement;
        if (!row) continue;
        // value cell may be the label's sibling OR the label-wrapper's sibling
        // (live DOM: row > labelWrap > leaf, value = labelWrap.nextElementSibling).
        // Climb up to 3 ancestors looking for the first element sibling.
        var node = n;
        for (var hop = 0; hop < 3 && node; hop++) {
          var sib = node.nextElementSibling;
          while (sib) {
            if (sib.nodeType === 1) return sib;
            sib = sib.nextElementSibling;
          }
          node = node.parentElement;
        }
      }
    }
    return null;
  }

  var renderFeeBadge = safe(function renderFeeBadge() {
    if (!state.data) return;
    var existing = document.getElementById("mql-feebadge");
    var container = findFeeTvlValueContainer();
    if (!container) return;

    var d = state.data;
    var trend = d.trend || "steady";
    var arrow = trend === "HEATING" ? "▲" : (trend === "COOLING" ? "▼" : "–");
    var cls = trend === "HEATING" ? "mql-good" : (trend === "COOLING" ? "mql-bad" : "mql-muted");
    var txt = "1h: " + fmtPct(d.feeRate1h, 1) + "/d " + arrow;

    if (existing) {
      // if it moved containers (SPA re-render), re-parent
      if (existing.parentElement !== container) {
        container.appendChild(existing);
      }
      existing.className = "mql-feebadge " + cls;
      existing.textContent = txt;
      existing.title = "Meteora Quant Lens: live 1h fee/TVL rate (annualized/day)";
      return;
    }
    var badge = el("span", "mql-feebadge " + cls, txt);
    badge.id = "mql-feebadge"; tipify(badge, "feebadge");
    badge.title = "Meteora Quant Lens: live 1h fee/TVL rate (annualized/day)";
    container.appendChild(badge);
  });

  // ========================================================================
  // 3. FORM GUARDIAN (#mql-guard)
  // ========================================================================
  function findRangePicker() {
    return document.querySelector('[data-sentry-component="RangePicker"]');
  }

  function getBinPriceInputs() {
    var wraps = document.querySelectorAll('[data-sentry-component="BinPriceInput"]');
    var inputs = [];
    for (var i = 0; i < wraps.length; i++) {
      var inp = wraps[i].querySelector("input");
      if (inp) inputs.push(inp);
    }
    return inputs;
  }

  function parsePct(str) {
    if (str == null) return null;
    var m = String(str).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function readRange() {
    var inputs = getBinPriceInputs();
    if (inputs.length < 2) return null;
    var a = parsePct(inputs[0].value);
    var b = parsePct(inputs[1].value);
    if (a == null || b == null) return null;
    var min = Math.min(a, b);
    var max = Math.max(a, b);
    return { min: min, max: max, raw0: a, raw1: b };
  }

  function readTotalBins() {
    // "Total Bins:" text somewhere in the right panel
    var nodes = document.querySelectorAll("div, span, p");
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || "").trim();
      if (/Total Bins:/i.test(t) && t.length < 40) {
        var m = t.match(/Total Bins:\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);
      }
    }
    return null;
  }

  // Equivalent +-W half-width = full band width / 2, so the background's
  // sigma^2/(4W) equals sigma^2/(2 * full width) for any range shape:
  // +-W -> W, one-sided 0 -> -75% -> 37.5, off-price -50% -> -20% -> 15.
  // (The old (|min| + |max|)/2 gave 35 for that last case instead of 15.)
  function widthPctFromRange(r) {
    if (!r) return 20;
    var w = (r.max - r.min) / 2;
    if (!w || isNaN(w) || w <= 0) return 20;
    return w;
  }

  function readAmountInputs() {
    var nodes = document.querySelectorAll('[data-sentry-component="AmountInput"] input, input[placeholder="0.00"]');
    var vals = [];
    for (var i = 0; i < nodes.length; i++) {
      vals.push(parsePct(nodes[i].value));
    }
    return vals;
  }

  var mountGuard = safe(function mountGuard() {
    if (document.getElementById("mql-guard")) return true; // idempotent
    var anchor = findRangePicker();
    if (!anchor) return false;
    var guard = el("div", "mql-card mql-guard"); tipify(guard, "breakeven");
    guard.id = "mql-guard";

    // place right after the RangePicker
    if (anchor.parentElement) {
      if (anchor.nextSibling) anchor.parentElement.insertBefore(guard, anchor.nextSibling);
      else anchor.parentElement.appendChild(guard);
    } else return false;

    // banner + status strip children
    var banner = el("div", "mql-guard-banner mql-hidden");
    banner.id = "mql-guard-banner";
    guard.appendChild(banner);

    var strip = el("div", "mql-guard-strip");
    strip.id = "mql-guard-strip";
    strip.textContent = "range analysis loading…";
    guard.appendChild(strip);

    var info = el("div", "mql-guard-info mql-hidden");
    info.id = "mql-guard-info";
    guard.appendChild(info);

    // seed last known range and start listeners
    state.lastRange = readRange();
    attachRangeListeners();
    updateGuard();
    return true;
  });

  function attachRangeListeners() {
    var inputs = getBinPriceInputs();
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp.__mqlBound) continue;
      inp.__mqlBound = true;
      inp.addEventListener("input", safe(onRangeInput));
      inp.addEventListener("change", safe(onRangeInput));
    }
  }

  var onRangeInput = safe(function onRangeInput() {
    if (state.guardDebounce) clearTimeout(state.guardDebounce);
    state.guardDebounce = setTimeout(safe(function () {
      state.lastRange = readRange();
      updateGuard();
    }), INPUT_DEBOUNCE);
  });

  var updateGuard = safe(function updateGuard() {
    var strip = document.getElementById("mql-guard-strip");
    if (!strip) return;
    var r = readRange();
    var w = widthPctFromRange(r);

    // single-sided notice
    updateSingleSided(r);

    if (!state.pool) { strip.textContent = "range analysis: no pool"; return; }

    // A range entirely below (or above) price is a one-sided ladder: it only
    // trades while price is inside it, where its IL is sigma^2/(2 * width) (same
    // capital in half the width of a +-W band). Show that number neutrally: on a
    // BID ASK accumulation, buying the dip is the plan, not a loss to avoid.
    var oneSided = !!r && (r.max <= 0 || r.min >= 0);
    var symmetric = !r || Math.abs(r.max + r.min) < 0.5;
    var rangeLbl = !r ? "\u00b1" + fmtNum(w, 1) + "%"
      : oneSided ? fmtNum(r.max, 0) + "% \u2192 " + fmtNum(r.min, 0) + "% (one-sided)"
      : symmetric ? "\u00b1" + fmtNum(w, 1) + "%"
      : fmtNum(r.min, 0) + "% \u2192 +" + fmtNum(r.max, 0) + "%";
    sendMessage({ type: "getBreakeven", pool: state.pool, widthPct: w }).then(safe(function (resp) {
      var strip2 = document.getElementById("mql-guard-strip");
      if (!strip2) return;
      if (!resp || !resp.ok) {
        strip2.className = "mql-guard-strip mql-muted";
        strip2.textContent = rangeLbl + " breakeven unavailable" +
          (resp && resp.error ? " (" + resp.error + ")" : "");
        return;
      }
      var need = resp.breakevenFeePerDay;
      var pays = resp.poolFeePerDay;
      var clears = !!resp.clears;
      if (oneSided) {
        strip2.className = "mql-guard-strip mql-muted";
        strip2.textContent = rangeLbl + " needs ≥" + fmtPct(need, 1) + "/day fees while price is inside it — this pool pays " +
          fmtPct(pays, 1) + "/day " + (clears ? "✓" : "✗") + " · on a BID ASK accumulation, buying the dip is the plan";
        return;
      }
      strip2.className = "mql-guard-strip " + (clears ? "mql-good" : "mql-bad");
      strip2.textContent = rangeLbl + " needs ≥" + fmtPct(need, 1) +
        "/day fees to breakeven — this pool pays " + fmtPct(pays, 1) + "/day " +
        (clears ? "✓" : "✗");
    }));
  });

  function updateSingleSided(r) {
    var info = document.getElementById("mql-guard-info");
    if (!info) return;
    var amounts = readAmountInputs();
    var hasZero = false, hasNonZero = false;
    for (var i = 0; i < amounts.length; i++) {
      var v = amounts[i];
      if (v == null || v === 0) hasZero = true;
      else hasNonZero = true;
    }
    // range entirely below current price => max <= 0%
    var belowPrice = r && r.max <= 0;
    if (belowPrice && hasZero && hasNonZero) {
      info.className = "mql-guard-info";
      info.textContent = "Single-sided (DCA-IN): converts to base token as price falls — intended?";
    } else {
      info.className = "mql-guard-info mql-hidden";
      info.textContent = "";
    }
  }

  function flashResetWarning(reason) {
    var banner = document.getElementById("mql-guard-banner");
    if (!banner) return;
    banner.className = "mql-guard-banner";
    banner.textContent = "⚠️ " + (reason || "Auto-Fill reset your range — re-enter your Min/Max");
    // auto-clear after a while but keep visible long enough to notice
    if (banner.__mqlHideTimer) clearTimeout(banner.__mqlHideTimer);
    banner.__mqlHideTimer = setTimeout(safe(function () {
      var b = document.getElementById("mql-guard-banner");
      if (b) b.className = "mql-guard-banner mql-hidden";
    }), 10000);
  }

  // Auto-Fill reset detection via delegated click listener on Toggle.
  var onDocClick = safe(function onDocClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var toggle = target.closest('[data-sentry-component="Toggle"]');
    if (!toggle) return;
    // snapshot range + bins now
    var before = readRange();
    var beforeBins = readTotalBins();
    if (state.autofillTimer) clearTimeout(state.autofillTimer);
    state.autofillTimer = setTimeout(safe(function () {
      var after = readRange();
      var afterBins = readTotalBins();
      var changed = false;
      if (before && after) {
        if (Math.abs((before.min || 0) - (after.min || 0)) > 0.5 ||
            Math.abs((before.max || 0) - (after.max || 0)) > 0.5) {
          changed = true;
        }
      }
      var snappedDefault = afterBins != null && DEFAULT_BIN_COUNTS.indexOf(afterBins) !== -1 &&
        beforeBins != null && DEFAULT_BIN_COUNTS.indexOf(beforeBins) === -1;
      if (changed || snappedDefault) {
        flashResetWarning("Auto-Fill reset your range — re-enter your Min/Max");
      }
      // refresh breakeven with the (possibly new) range
      state.lastRange = readRange();
      updateGuard();
    }), AUTOFILL_CHECK_MS);
  });

  // Generic watch: Total Bins jumping back to default after custom.
  function checkBinsRegression() {
    var bins = readTotalBins();
    if (bins == null) return;
    if (state.lastBins != null &&
        DEFAULT_BIN_COUNTS.indexOf(state.lastBins) === -1 &&
        DEFAULT_BIN_COUNTS.indexOf(bins) !== -1) {
      flashResetWarning("Total Bins reset to default (" + bins + ") — re-check your range");
    }
    state.lastBins = bins;
  }

  // ========================================================================
  // MOUNT ORCHESTRATION + OBSERVERS
  // ========================================================================
  var mountAll = safe(function mountAll() {
    if (!state.pool) return;
    mountHUD();
    renderFeeBadge();
    mountGuard();
    attachRangeListeners();
    checkBinsRegression();
  });

  var onMutations = (function () {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(safe(function () {
        mountAll();
      }), OBS_DEBOUNCE);
    };
  })();

  var startObserver = safe(function startObserver() {
    if (state.obs) return;
    state.obs = new MutationObserver(safe(onMutations));
    state.obs.observe(document.body, { childList: true, subtree: true });
  });

  // ========================================================================
  // SPA NAVIGATION HANDLING
  // ========================================================================
  function teardownForNavigationMarks() {
    try { window.postMessage({ mql: 'tv-clear' }, '*'); marksState.pool = null; } catch (e) {}
  }
  function teardownForNavigation() {
    teardownForNavigationMarks();
    stopPolling();
    ["mql-hud", "mql-feebadge", "mql-guard", "mql-combo-banner"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.parentElement) n.parentElement.removeChild(n);
    });
    // stop the combo poller (storage state persists — flow resumes if user returns)
    if (comboFlow.timer) { clearInterval(comboFlow.timer); comboFlow.timer = null; }
    comboFlow.st = null;
    state.data = null;
    state.lastFetchTs = 0;
    state.lastRange = null;
    state.lastBins = null;
  }

  var onUrlChange = safe(function onUrlChange() {
    var newPool = getPoolAddress();
    if (newPool === state.pool) return;
    teardownForNavigation();
    state.pool = newPool;
    state.accumDecayDataTs = 0;
    state.accumDecayCount = 0;
    state.accumPositionKey = null;
    state.accumBaselineTs = 0;
    if (state.pool) {
      mountAll();
      startPolling();
      comboResume();
      loadEntryPlan();
    }
  });

  function hookHistory() {
    try {
      var wrap = function (name) {
        var orig = history[name];
        if (!orig || orig.__mqlWrapped) return;
        var patched = function () {
          var ret = orig.apply(this, arguments);
          try { window.dispatchEvent(new Event("mql:locationchange")); } catch (e) {}
          return ret;
        };
        patched.__mqlWrapped = true;
        history[name] = patched;
      };
      wrap("pushState");
      wrap("replaceState");
      window.addEventListener("popstate", safe(onUrlChange));
      window.addEventListener("mql:locationchange", safe(onUrlChange));
    } catch (e) { log("history hook failed", e && e.message); }
    // ISOLATED-WORLD TRAP: the pushState wrap above only sees THIS world's calls.
    // Meteora's router pushes state in the MAIN world, which we cannot intercept -
    // so in-app pool navigation never fired onUrlChange and the HUD kept polling
    // the PREVIOUS pool (caught live: STONK tab rendering Doom-SOL's FREEFALL).
    // A dumb URL poll is the only world-proof detector.
    var lastHref = location.href;
    setInterval(safe(function () {
      if (location.href !== lastHref) { lastHref = location.href; onUrlChange(); }
    }), 800);
  }

  // ========================================================================
  // BOOT
  // ========================================================================
  var boot = safe(function boot() {
    state.pool = getPoolAddress();
    hookHistory();
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("visibilitychange", safe(function () {
      if (document.visibilityState === "visible" && state.pool) {
        // refetch on regaining focus if stale (> POLL interval)
        if (Date.now() - state.lastFetchTs > POLL_MS) fetchData();
      }
    }));
    startObserver();
    try { startTrackDrawer(); } catch (e) {}
    // restore persisted combo total for the ACCUM block
    try {
      chrome.storage.local.get({ mqlComboTotal: 1.0 }, function (st) {
        var v = parseFloat(st.mqlComboTotal);
        comboUI.total = (isFinite(v) && v > 0) ? v : 1.0;
      });
    } catch (e) {}
    if (state.pool) {
      mountAll();
      startPolling();
      comboResume();
      loadEntryPlan();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
