/*
 * Evil Panda module — pure math, no network, no chrome.* (Node-testable).
 *
 * Source strategy: @EvilPanda, "Summary of Evil Panda Strat" (Advanced Bootcamp #7),
 * https://x.com/EvilPanda/status/2004311197995446725
 *
 *   Coin selection  : MC >= 250k, 24h vol >= 1M, has a picture; GMGN fees > 30,
 *                     phishing < 30%, bundling < 60%, insiders < 10%, top10 < 30%.
 *   Entry           : closed candle breaks above Supertrend -> one-sided SOL DLMM,
 *                     80/100/125 bin-step pool, range -86% .. -94%, Spot or Bid-Ask.
 *   Exit (>=2 ind.) : RSI(2) close > 90 AND close > BB upper   (same candle)
 *                  OR RSI(2) close > 90 AND first green MACD histogram (same candle)
 *
 * Deviation from the source, on purpose: the source uses 15m candles. This module is
 * aimed at young tokens where 15m cannot warm MACD for ~9h, so it defaults to 5m
 * (1m optional). Indicator params are TradingView defaults (what Dexscreener charts use)
 * except RSI length 2 / upper 90 as specified.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MQLEvilPanda = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const TIMEFRAMES = { '5m': 300, '1m': 60 };
  const DEFAULT_TIMEFRAME = '5m';

  const DEFAULTS = Object.freeze({
    minMcapUsd: 250000,
    minVol24Usd: 1000000,
    minTotalFeesSol: 30,
    maxPhishing: 0.30,      // GMGN stat.top_entrapment_trader_percentage
    maxBundling: 0.60,      // GMGN stat.top_bundler_trader_percentage
    maxInsiders: 0.10,      // GMGN stat.top_rat_trader_percentage
    maxTop10: 0.30,         // GMGN top_10_holder_rate
    binSteps: [80, 100, 125],
    rangeDepthMin: 86,      // % below entry (top of range = current price)
    rangeDepthMax: 94,
    stPeriod: 10, stMult: 3,
    rsiLen: 2, rsiUpper: 90,
    bbLen: 20, bbMult: 2,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    // closed candles above Supertrend required after a flip before ENTRY fires
    confirmBars: { '5m': 1, '1m': 2 },
    // a flip older than this many candles is "late" (don't chase an extended move)
    entryFreshBars: { '5m': 3, '1m': 6 },
    noNewPositionsAfterHour: 18   // source: "don't open positions after 6pm" (local time)
  });

  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const toNum = (v) => (v === null || v === undefined || v === '') ? NaN : Number(v);
  const round = (v, p = 2) => finite(v) ? Math.round(v * 10 ** p) / 10 ** p : null;

  // ---------------------------------------------------------------- candles
  // GMGN token_kline rows: { time(ms), open, high, low, close, volume } as strings.
  // Also accepts Meteora datapi rows { timestamp(s), ... }. Returns ascending,
  // de-duplicated, CLOSED candles only (the still-forming bucket is dropped: every
  // signal in this strategy is a candle CLOSE condition).
  function normalizeCandles(rows, tfSec, nowMs) {
    const list = Array.isArray(rows) ? rows : (rows && (rows.list || rows.data || rows.candles)) || [];
    const out = new Map();
    for (const r of list) {
      if (!r) continue;
      let t = toNum(r.time !== undefined ? r.time : r.timestamp);
      if (!finite(t)) continue;
      if (t > 1e11) t = t / 1000;
      const c = { t: Math.floor(t), o: toNum(r.open), h: toNum(r.high), l: toNum(r.low), c: toNum(r.close), v: toNum(r.volume) };
      if (![c.o, c.h, c.l, c.c].every((x) => finite(x) && x > 0)) continue;
      out.set(c.t, c);
    }
    const nowSec = finite(nowMs) ? nowMs / 1000 : Date.now() / 1000;
    return [...out.values()].sort((a, b) => a.t - b.t).filter((c) => c.t + tfSec <= nowSec);
  }

  // ------------------------------------------------------------- indicators
  // All return arrays aligned with input; null until warm.
  function sma(src, len, i) {
    if (i < len - 1) return null;
    let s = 0; for (let k = i - len + 1; k <= i; k++) s += src[k];
    return s / len;
  }
  // TradingView ta.ema: seeded with the SMA of the first `len` values
  function ema(src, len, start = 0) {
    const out = new Array(src.length).fill(null);
    const a = 2 / (len + 1);
    let prev = null, n = 0, acc = 0;
    for (let i = start; i < src.length; i++) {
      const x = src[i]; if (!finite(x)) continue;
      if (prev === null) { acc += x; n++; if (n === len) { prev = acc / len; out[i] = prev; } continue; }
      prev = a * x + (1 - a) * prev; out[i] = prev;
    }
    return out;
  }
  // Wilder RMA (TradingView ta.rma): seeded with SMA of first `len`
  function rma(src, len) {
    const out = new Array(src.length).fill(null);
    let prev = null, n = 0, acc = 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i]; if (!finite(x)) continue;
      if (prev === null) { acc += x; n++; if (n === len) { prev = acc / len; out[i] = prev; } continue; }
      prev = (prev * (len - 1) + x) / len; out[i] = prev;
    }
    return out;
  }

  function rsi(closes, len) {
    const up = [NaN], dn = [NaN];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0));
    }
    const ru = rma(up, len), rd = rma(dn, len);
    return closes.map((_, i) => {
      if (ru[i] === null || rd[i] === null) return null;
      if (rd[i] === 0) return ru[i] === 0 ? 50 : 100;
      return 100 - 100 / (1 + ru[i] / rd[i]);
    });
  }

  function bollinger(closes, len, mult) {
    return closes.map((_, i) => {
      const m = sma(closes, len, i);
      if (m === null) return null;
      let v = 0; for (let k = i - len + 1; k <= i; k++) v += (closes[k] - m) ** 2;
      const sd = Math.sqrt(v / len);   // TV ta.stdev = population stdev
      return { basis: m, upper: m + mult * sd, lower: m - mult * sd };
    });
  }

  function macd(closes, fast, slow, sig) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
    const firstIdx = line.findIndex((x) => x !== null);
    const sigArr = firstIdx < 0 ? line.map(() => null) : ema(line.map((x) => x === null ? NaN : x), sig, firstIdx);
    return closes.map((_, i) => (line[i] !== null && sigArr[i] !== null)
      ? { macd: line[i], signal: sigArr[i], hist: line[i] - sigArr[i] } : null);
  }

  // TradingView built-in Supertrend(factor, atrPeriod), hl2 source, RMA ATR.
  // dir: 1 = up (green, price above line), -1 = down (red).
  function supertrend(cs, period, mult) {
    const tr = cs.map((c, i) => i === 0 ? c.h - c.l
      : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c)));
    const atr = rma(tr, period);
    const out = new Array(cs.length).fill(null);
    let prevUp = null, prevDn = null, prevDir = null;
    for (let i = 0; i < cs.length; i++) {
      if (atr[i] === null) continue;
      const hl2 = (cs[i].h + cs[i].l) / 2;
      let up = hl2 - mult * atr[i], dn = hl2 + mult * atr[i];
      const pc = i > 0 ? cs[i - 1].c : cs[i].c;
      if (prevUp !== null && pc > prevUp) up = Math.max(up, prevUp);
      if (prevDn !== null && pc < prevDn) dn = Math.min(dn, prevDn);
      let dir;
      if (prevDir === null) dir = cs[i].c > dn ? 1 : -1;   // first warm bar: TV starts in downtrend unless closing above the band
      else if (prevDir === -1 && cs[i].c > prevDn) dir = 1;
      else if (prevDir === 1 && cs[i].c < prevUp) dir = -1;
      else dir = prevDir;
      out[i] = { dir, line: dir === 1 ? up : dn, up, dn };
      prevUp = up; prevDn = dn; prevDir = dir;
    }
    return out;
  }

  function warmupNeeded(p = DEFAULTS) {
    return {
      supertrend: p.stPeriod + 1,             // ATR seed + one prior bar for a flip
      rsi: p.rsiLen + 1,
      bb: p.bbLen,
      macd: p.macdSlow + p.macdSignal,        // hist valid at slow+signal-1; +1 for "first green" needs previous bar
    };
  }

  // ------------------------------------------------------------- signals
  function evaluateSignals(candles, opts = {}) {
    const p = Object.assign({}, DEFAULTS, opts.params || {});
    const tf = TIMEFRAMES[opts.timeframe] ? opts.timeframe : DEFAULT_TIMEFRAME;
    const n = candles.length;
    const need = warmupNeeded(p);
    const tfMin = TIMEFRAMES[tf] / 60;
    const warm = {
      supertrend: n >= need.supertrend, rsi: n >= need.rsi, bb: n >= need.bb, macd: n >= need.macd,
    };
    const warmEta = (k) => warm[k] ? 0 : (need[k] - n) * tfMin;   // minutes until usable
    const base = { timeframe: tf, candles: n, warm, warmNeed: need,
      warmEtaMin: { supertrend: warmEta('supertrend'), bb: warmEta('bb'), macd: warmEta('macd') },
      lastClosedTs: n ? candles[n - 1].t : null, lastClose: n ? candles[n - 1].c : null };
    if (!n) return Object.assign(base, { entry: { state: 'NO_DATA' }, exit: { state: 'NO_DATA' } });

    const closes = candles.map((c) => c.c);
    const st = supertrend(candles, p.stPeriod, p.stMult);
    const r = rsi(closes, p.rsiLen);
    const bb = bollinger(closes, p.bbLen, p.bbMult);
    const md = macd(closes, p.macdFast, p.macdSlow, p.macdSignal);
    const i = n - 1;

    // ---- entry (Supertrend break) ----
    let entry;
    if (!warm.supertrend || !st[i]) {
      entry = { state: 'WARMING', etaMin: warmEta('supertrend') };
    } else if (st[i].dir === -1) {
      entry = { state: 'WAIT', stLine: st[i].line, distPct: round((st[i].line / closes[i] - 1) * 100, 1),
        why: 'price below Supertrend — wait for a close above it' };
    } else {
      // find the flip bar (first bar of the current up-run)
      let k = i; while (k > 0 && st[k - 1] && st[k - 1].dir === 1) k--;
      const flippedFromDown = k > 0 && st[k - 1] && st[k - 1].dir === -1;
      const barsSinceFlip = i - k;          // 0 = flipped on the last closed candle
      const heldBars = barsSinceFlip + 1;   // closed candles above the line incl. flip bar
      const confirmBars = (p.confirmBars && p.confirmBars[tf]) || 1;
      const freshBars = (p.entryFreshBars && p.entryFreshBars[tf]) || 3;
      let state, why;
      if (!flippedFromDown) { state = 'LATE'; why = 'already above Supertrend since warm-up — no fresh break seen'; }
      else if (heldBars < confirmBars) { state = 'CONFIRMING'; why = heldBars + '/' + confirmBars + ' closes above Supertrend'; }
      else if (barsSinceFlip < confirmBars - 1 + freshBars) { state = 'ENTRY'; why = 'broke above Supertrend ' + barsSinceFlip + ' candle(s) ago, held ' + heldBars; }
      else { state = 'LATE'; why = 'break was ' + barsSinceFlip + ' candles ago — don\'t chase, wait for the next reset'; }
      entry = { state, why, stLine: st[i].line, flipTs: flippedFromDown ? candles[k].t : null, barsSinceFlip, heldBars, confirmBars };
    }

    // ---- exit (RSI2 > 90 + BB upper | first green MACD hist), same closed candle ----
    const rsiNow = r[i];
    const rsiHot = rsiNow !== null && rsiNow > p.rsiUpper;
    const bbHit = !!(bb[i] && closes[i] > bb[i].upper);
    const firstGreen = !!(md[i] && md[i - 1] && md[i].hist >= 0 && md[i - 1].hist < 0);
    const legs = [];
    if (rsiHot && bbHit) legs.push('RSI2>' + p.rsiUpper + ' + close>BB upper');
    if (rsiHot && firstGreen) legs.push('RSI2>' + p.rsiUpper + ' + first green MACD');
    let exitState;
    if (legs.length) exitState = 'EXIT';
    else if (!warm.rsi || (!warm.bb && !warm.macd)) exitState = 'WARMING';
    else exitState = 'HOLD';
    const exit = {
      state: exitState, legs,
      rsi: round(rsiNow, 1), rsiHot,
      bbUpper: bb[i] ? bb[i].upper : null, bbHit, bbReady: warm.bb,
      macdHist: md[i] ? md[i].hist : null, macdFirstGreen: firstGreen, macdReady: warm.macd && !!md[i - 1],
      partial: !warm.macd ? 'MACD warming (' + warmEta('macd') + 'm) — exit uses RSI2 + BB only' : null,
    };
    return Object.assign(base, { entry, exit });
  }

  // ------------------------------------------------------------- coin screen
  function screenCoin(input, opts = {}) {
    const p = Object.assign({}, DEFAULTS, opts.params || {});
    const info = input.info || {}, sec = input.security || {}, pool = input.pool || {};
    const stat = info.stat || {}, px = info.price || {};
    const price = toNum(px.price);
    const circ = toNum(info.circulating_supply);
    const mcap = finite(price) && finite(circ) ? price * circ : toNum(input.fallbackMcap);
    const vol24 = toNum(px.volume_24h);
    const fees = toNum(info.total_fee);
    const phishing = toNum(stat.top_entrapment_trader_percentage);
    const bundling = toNum(stat.top_bundler_trader_percentage);
    const insiders = toNum(stat.top_rat_trader_percentage);
    const top10 = finite(toNum(sec.top_10_holder_rate)) ? toNum(sec.top_10_holder_rate) : toNum(stat.top_10_holder_rate);
    const createdSec = toNum(info.creation_timestamp || info.open_timestamp);
    const nowMs = finite(opts.nowMs) ? opts.nowMs : Date.now();
    const pct = (x) => finite(x) ? round(x * 100, 1) + '%' : '?';
    const usd = (x) => finite(x) ? '$' + (x >= 1e6 ? round(x / 1e6, 2) + 'M' : Math.round(x / 1e3) + 'k') : '?';
    const G = [];
    const gate = (key, label, value, pass, hard = true) => G.push({ key, label, value, pass: finite(value) || typeof value === 'boolean' ? pass : null, hard });
    gate('mcap', 'MC ≥ ' + usd(p.minMcapUsd) + ' (' + usd(mcap) + ')', mcap, mcap >= p.minMcapUsd);
    gate('vol24', '24h vol ≥ ' + usd(p.minVol24Usd) + ' (' + usd(vol24) + ')', vol24, vol24 >= p.minVol24Usd);
    gate('logo', 'has picture', !!info.logo, !!info.logo);
    gate('fees', 'GMGN fees > ' + p.minTotalFeesSol + ' (' + (finite(fees) ? round(fees, 1) : '?') + ')', fees, fees > p.minTotalFeesSol);
    gate('phishing', 'phishing < ' + pct(p.maxPhishing) + ' (' + pct(phishing) + ')', phishing, phishing < p.maxPhishing);
    gate('bundling', 'bundling < ' + pct(p.maxBundling) + ' (' + pct(bundling) + ')', bundling, bundling < p.maxBundling);
    gate('insiders', 'insiders < ' + pct(p.maxInsiders) + ' (' + pct(insiders) + ')', insiders, insiders < p.maxInsiders);
    gate('top10', 'top10 < ' + pct(p.maxTop10) + ' (' + pct(top10) + ')', top10, top10 < p.maxTop10);
    gate('solPair', 'SOL-quoted pool (one-sided SOL)', !!pool.supportedSolPair, !!pool.supportedSolPair);
    const bs = toNum(pool.binStep);
    gate('binStep', 'bin step 80/100/125 (' + (finite(bs) ? bs : '?') + ')', bs, p.binSteps.includes(bs), false);
    const failed = G.filter((g) => g.hard && g.pass === false);
    const unknown = G.filter((g) => g.hard && g.pass === null);
    return {
      pass: failed.length === 0 && unknown.length === 0,
      state: failed.length ? 'FAIL' : (unknown.length ? 'INCOMPLETE' : 'PASS'),
      gates: G, failed: failed.map((g) => g.key), unknown: unknown.map((g) => g.key),
      facts: { mcap, vol24, fees, phishing, bundling, insiders, top10, holders: toNum(info.holder_count),
        ageMin: finite(createdSec) ? Math.round((nowMs / 1000 - createdSec) / 60) : null,
        launchpad: info.launchpad_platform || info.launchpad || null },
    };
  }

  // ------------------------------------------------------------- range recipe
  // One-sided SOL below the active price. Bins to reach d% down at bin step bs:
  // price_k = P * (1 + bs/1e4)^-k  ->  k = ln(1/(1-d)) / ln(1 + bs/1e4)
  function binsForDepth(depthPct, binStep) {
    const d = toNum(depthPct) / 100, bs = toNum(binStep);
    if (!(d > 0 && d < 1 && bs > 0)) return null;
    return Math.ceil(Math.log(1 / (1 - d)) / Math.log(1 + bs / 1e4));
  }
  function rangeRecipe(binStep, price, opts = {}) {
    const p = Object.assign({}, DEFAULTS, opts.params || {});
    const P = toNum(price);
    const at = (d) => ({ depthPct: d, bins: binsForDepth(d, binStep), minPrice: finite(P) ? P * (1 - d / 100) : null });
    return { binStep: toNum(binStep), top: finite(P) ? P : null, shallow: at(p.rangeDepthMin), deep: at(p.rangeDepthMax),
      side: 'SOL only (below price)', shapes: ['Spot', 'Bid-Ask'] };
  }

  // Is an open position Panda-shaped? (deep one-sided: bottom <= ~20% of top)
  function isPandaShaped(minPrice, maxPrice) {
    const lo = toNum(minPrice), hi = toNum(maxPrice);
    return finite(lo) && finite(hi) && hi > 0 && lo > 0 && lo / hi <= 0.2;
  }

  function lateHour(nowMs, p = DEFAULTS) {
    const h = new Date(finite(nowMs) ? nowMs : Date.now()).getHours();
    return h >= p.noNewPositionsAfterHour;
  }

  return {
    TIMEFRAMES, DEFAULT_TIMEFRAME, DEFAULTS,
    normalizeCandles, ema, rma, rsi, bollinger, macd, supertrend, warmupNeeded,
    evaluateSignals, screenCoin, binsForDepth, rangeRecipe, isPandaShaped, lateHour,
  };
});
