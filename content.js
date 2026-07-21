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

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          // swallow "message port closed" / context invalidated errors
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message }); return; }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: e && e.message });
      }
    });
  }

  // ========================================================================
  // DATA FETCH + POLLING
  // ========================================================================
  var fetchData = safe(function fetchData() {
    if (!state.pool || state.fetching) return;
    if (document.visibilityState !== "visible") return;
    state.fetching = true;
    sendMessage({ type: "getPoolData", pool: state.pool }).then(safe(function (resp) {
      state.fetching = false;
      if (resp && resp.ok) {
        state.data = resp;
        state.lastFetchTs = Date.now();
        renderHUD(); renderPosWatch(); pollMyPosition();
        (function pwRetry(n) {
          if (n <= 0) return;
          setTimeout(safe(function () {
            if (!document.getElementById("mql-poswatch") && state.data) { renderPosWatch(); pwRetry(n - 1); }
          }), 3000);
        })(12);
        renderFeeBadge();
        renderGuard(); // guard uses feeRate for the breakeven-vs-pays line context
      } else {
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


  // ---- hover explainer tooltips ----
  var MQL_TIPS = {
    "verdict": "The bottom line. The Lens tests this pool against three entry playbooks (SCALP / REVERSION / CARRY). NO ENTRY means none of them clear their bars \u2014 whatever the APR looks like.",
    "edge": "THE core number. LPing = selling insurance: fees are your premium, impermanent loss is the claims you pay when price moves. Edge = fees \u00f7 expected IL (with a 30% safety margin). Above 1.0 = you're being overpaid for the risk. Below 1 = the pool is farming YOU.",
    "fee": "The truth about yield. The site's 24h number is backward-looking; the 1h rate is what the pool pays RIGHT NOW, annualized to %/day. \u25b2 HEATING = accelerating. \u25bc COOLING = the party already happened.",
    "sigma": "Realized volatility, %/day \u2014 how violently this token actually moves (measured from 5m/1h/24h price changes, \u221at-scaled). High \u03c3 means high IL risk: the same fees buy you much less safety.",
    "surge": "DLMM raises fees automatically during volatility (the accumulator). Surge = current dynamic fee \u00f7 base fee. \u22651.25x = the premium is elevated \u2014 the best moments to provide liquidity. ~0 = premium fully decayed.",
    "accel": "Volume acceleration: last-30-min pace vs last-4h pace. \u22651.2x = flow is building (a catalyst). Below 1 = activity fading \u2014 you'd be arriving after the party.",
    "flow": "Organic Flow Imbalance from Jupiter: real-wallet sells \u00f7 buys (bots filtered out). Over 2 = genuine holders are DISTRIBUTING \u2014 entering means buying their exit. Under 0.5 = organic accumulation. Shown for 1h / 6h windows.",
    "path": "Where price is in its story, from today's candle: FREEFALL (actively dumping \u2014 never enter), BASING (crashed, then stabilized \u2014 the reversion setup), BLOWOFF (extended at highs), GRIND-UP, CHOP. Also shows drawdown from the day's high.",
    "token": "Safety sheet: Organic Score (0-100, how real the trading is), token age, whether mint & freeze authority are burned (\u26a0\ufe0f live mint authority = team can print supply), and top-10 holder concentration.",
    "rec": "What to actually do, translated from all the signals: either a concrete recipe (shape, width, TP/SL brackets, exits) or WAIT with the exact conditions that would flip it to an entry.",
    "feebadge": "Live 1h fee run-rate \u2014 the number the native 24h stat hides. Green \u25b2 heating, red \u25bc cooling.",
    "radar": "Board-wide scanner: every 3 min it screens the most active DLMM pools and pins the actionable ones here. \ud83d\udd25 = full signal (all gates green). \u26a0 = near-miss (1-2 gates short \u2014 override territory). Click a chip to jump to that pool. Click RADAR to collapse.",
    "pwbrackets": "Suggested exit brackets, anchored to what a two-sided Spot can ACTUALLY earn: TP = W/4 (capped appreciation of a \u00b1W band \u2014 a clean pump-out only yields ~W/4) + half a day of the fee rate (chop income is the real engine). SL sits just inside the structural band-break value (~-0.75W). \u2018Away\u2019 = how far your current PnL sits from each. These are guidance \u2014 the hard rules (fee-decay, flow-flip, freefall) fire on their own regardless.",
    "poswatch": "Exit intelligence for the position you hold in THIS pool: it snapshots the fee rate when it first sees your position, then applies the bot\u2019s exit rules \u2014 fee-decay (exit at 50% decay), organic flow-flip, freefall, surge-death. HOLD / WATCH / TIGHTEN / EXIT with the reason.",
    "breakeven": "IL-breakeven check for YOUR current range: at this pool's volatility, a range this wide must earn at least X%/day in fees just to offset expected impermanent loss. \u2713 = the pool pays more than that. \u2717 = your range loses money on expectation."
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

  function pollMyPosition() {
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
        base = { entryFeeRate: d.feeRate1h, sigma: d.sigma, ts: Date.now() };
        st.mqlPosBaseline[state.pool] = base;
        chrome.storage.local.set({ mqlPosBaseline: st.mqlPosBaseline });
      }
      // real position width: parse the range prices from the position row (handles 0.0\u2084426-style subscripts)
      var Wp = (state.apiPos && state.apiPos.widthPct) ? state.apiPos.widthPct : 20;
      try {
        var rowN = document.querySelector('[data-sentry-component="PositionItem"]');
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
      // exit rules (same as the bot manager)
      var verdict = "HOLD", cls = "mql-pw-hold", reasons = [];
      if (d.feeRate1h < 0.5 * base.entryFeeRate && base.entryFeeRate > 2) {
        verdict = "EXIT"; cls = "mql-pw-exit";
        reasons.push("fee engine decayed " + Math.round(decayPct) + "% from your baseline (" + fmtNum(base.entryFeeRate,1) + " → " + fmtNum(d.feeRate1h,1) + "%/d) — the fees were the trade");
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
      // explicit action guidance per verdict
      var doLine = null, assist = null;
      if (verdict === "HOLD") doLine = "DO: nothing — let it print.";
      else if (verdict === "WATCH") doLine = "DO: nothing yet — stop adding size, re-check often; EXIT arms at 50% decay.";
      else if (verdict === "TIGHTEN") { doLine = "DO: claim accrued fees NOW (bank the harvest) and consider pulling partial size. Keep a runner."; assist = { kind: "claim", label: "→ show me the Claim button" }; }
      else if (verdict === "EXIT") { doLine = "DO: close 100% → Zap Out to SOL. Do not negotiate with a fired rule."; assist = { kind: "exit", label: "→ open the Withdraw panel" }; }

      var card = existing || el("div", "mql-card");
      card.id = "mql-poswatch";
      card.innerHTML = "";
      var head = el("div", "mql-pw-head");
      head.appendChild(el("span", "mql-pw-title", "POSITION WATCH"));
      var pill = el("span", "mql-pw-pill " + cls, verdict);
      tipify(pill, "poswatch");
      head.appendChild(pill);
      card.appendChild(head);
      reasons.forEach(function (r) { card.appendChild(el("div", "mql-pw-reason", "• " + r)); });
      if (doLine) card.appendChild(el("div", "mql-pw-do", doLine));
      // live sigma-scaled brackets + distance from current PnL (parsed from the position row)
      try {
        var clampN = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
        var tpB = Math.round(clampN(Wp / 4 + (base.entryFeeRate || d.feeRate1h || 0) * 0.5, 8, 25));
        var slB = Math.round(clampN(0.75 * Wp + 2, 8, 20));
        var pnlNow = (state.apiPos && state.apiPos.pnlPct != null) ? state.apiPos.pnlPct : null;  // API only — DOM rows contain unrelated %s
        var btxt = "Brackets (\u00b1" + Wp + "% band): TP +" + tpB + "% / SL -" + slB + "%";
        if (pnlNow != null && !isNaN(pnlNow)) {
          btxt += "  \u00b7  now " + (pnlNow >= 0 ? "+" : "") + pnlNow.toFixed(1) + "%  (TP " + (tpB - pnlNow).toFixed(1) + " away, SL " + (pnlNow + slB).toFixed(1) + " of cushion)";
        }
        var bEl = el("div", "mql-pw-brackets", btxt);
        tipify(bEl, "pwbrackets");
        card.appendChild(bEl);
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
    var head = el("span", "mql-radar-title", "📡 RADAR");
    tipify(head, "radar");
    head.style.cursor = "pointer";
    head.addEventListener("click", function () { radarCollapsed = !radarCollapsed; bar.classList.toggle("mql-radar-min", radarCollapsed); renderRadar(null); });
    bar.appendChild(head);
    if (radarCollapsed) {
      var n = (r && r.items) ? r.items.length : 0;
      var full = (r && r.items) ? r.items.filter(function(i){return i.kind==="FULL";}).length : 0;
      bar.appendChild(el("span", "mql-radar-empty", full > 0 ? full + "🔥 " + (n-full) + "⚠" : n + " watched"));
      return;
    }
    if (!r || !r.ok || !r.items || !r.items.length) {
      bar.appendChild(el("span", "mql-radar-empty", "nothing actionable on the board"));
      return;
    }
    r.items.forEach(function (it) {
      var chip = el("button", "mql-chip " + (it.kind === "FULL" ? "mql-chip-full mql-chip-" + it.cls.toLowerCase() : "mql-chip-near"));
      var bs = it.binStep ? (it.binStep + "bps ") : "";
      var lbl = it.kind === "FULL" ? ("🔥 " + it.name + " " + bs + "· " + it.cls + " · edge " + fmtNum(it.edge, 2)) : ("⚠ " + it.name + " " + bs + "· edge " + fmtNum(it.edge, 2) + " · misses " + (it.fails || []).map(function(f){return f.split(" ")[0];}).join("+"));
      chip.textContent = lbl;
      chip.title = it.kind === "FULL" ? "All gates green — full " + it.cls + " signal. Click to open." : "Near-miss (override-eligible): fails " + (it.fails || []).join(", ") + ". Click to open.";
      chip.addEventListener("click", function () { window.location.href = "/dlmm/" + it.address; });
      bar.appendChild(chip);
    });
    var ago = el("span", "mql-radar-ts", Math.round((Date.now() - r.ts) / 60000) + "m");
    bar.appendChild(ago);
  });
  function pollRadar() {
    if (document.visibilityState !== "visible") return;
    try {
      chrome.runtime.sendMessage({ type: "getRadar" }, function (r) {
        if (chrome.runtime.lastError) return;
        renderRadar(r);
      });
    } catch (e) {}
  }
  setInterval(safe(pollRadar), 180e3);
  setTimeout(safe(pollRadar), 4000);

  var renderHUD = safe(function renderHUD() {
    var hud = document.getElementById("mql-hud");
    if (!hud) return;
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
    hud.appendChild(edgeRow);
    var barWrap = el("div", "mql-barwrap");
    var bar = el("div", "mql-bar " + colorForEdge(edge));
    var pct = Math.max(0, Math.min(100, ((edge || 0) / 2) * 100)); // 2.0 = full bar
    bar.style.width = pct + "%";
    barWrap.appendChild(bar);
    hud.appendChild(barWrap);
    hud.appendChild(el("div", "mql-sub", "fees vs IL-breakeven"));

    // Fee rate row
    var frRow = el("div", "mql-row");
    frRow.appendChild(el("span", "mql-label", "Fee"));
    var frTxt = "1h " + fmtPct(d.feeRate1h, 1) + "/d vs 24h " + fmtPct(d.feeRate24h, 1);
    var frVal = el("span", "mql-val", frTxt);
    frRow.appendChild(frVal);
    hud.appendChild(frRow);
    var trendRow = el("div", "mql-row");
    var trend = d.trend || "steady";
    var tSpan = el("span", "mql-trend");
    if (trend === "HEATING") { tSpan.className = "mql-trend mql-good"; tSpan.textContent = "▲ HEATING"; }
    else if (trend === "COOLING") { tSpan.className = "mql-trend mql-bad"; tSpan.textContent = "▼ COOLING"; }
    else { tSpan.className = "mql-trend mql-muted"; tSpan.textContent = "– steady"; }
    trendRow.appendChild(tSpan);
    hud.appendChild(trendRow);

    // sigma / surge / accel
    var grid = el("div", "mql-grid3");
    grid.appendChild(metricCell("σ", fmtPct(d.sigma, 1) + "/d", "mql-neutral"));
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
        applyBtn.addEventListener("click", function () { applySetup(rec.params, applyBtn); });
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
            chrome.storage.local.get({ mqlOverrideJournal: [] }, function (st) {
              var j = st.mqlOverrideJournal || [];
              j.push({ ts: Date.now(), pool: state.pool, cls: ov.cls, ignoredGates: ov.ignoredGates, edge: state.data && state.data.edge, sigma: state.data && state.data.sigma, feeRate1h: state.data && state.data.feeRate1h });
              chrome.storage.local.set({ mqlOverrideJournal: j.slice(-100) });
            });
          } catch (e) {}
        }));
        recWrap.appendChild(ovBtn);
      }
      (rec.watch || []).forEach(function (w) { recWrap.appendChild(el("div", "mql-rec-warn", w)); });
      hud.appendChild(recWrap);
    }


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

  function widthPctFromRange(r) {
    if (!r) return 20;
    var w = (Math.abs(r.min) + Math.abs(r.max)) / 2;
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

    sendMessage({ type: "getBreakeven", pool: state.pool, widthPct: w }).then(safe(function (resp) {
      var strip2 = document.getElementById("mql-guard-strip");
      if (!strip2) return;
      if (!resp || !resp.ok) {
        strip2.className = "mql-guard-strip mql-muted";
        strip2.textContent = "±" + fmtNum(w, 1) + "% breakeven unavailable" +
          (resp && resp.error ? " (" + resp.error + ")" : "");
        return;
      }
      var need = resp.breakevenFeePerDay;
      var pays = resp.poolFeePerDay;
      var clears = !!resp.clears;
      strip2.className = "mql-guard-strip " + (clears ? "mql-good" : "mql-bad");
      strip2.textContent = "±" + fmtNum(w, 1) + "% needs ≥" + fmtPct(need, 1) +
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
  function teardownForNavigation() {
    stopPolling();
    ["mql-hud", "mql-feebadge", "mql-guard"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n && n.parentElement) n.parentElement.removeChild(n);
    });
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
    if (state.pool) {
      mountAll();
      startPolling();
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
    if (state.pool) {
      mountAll();
      startPolling();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
