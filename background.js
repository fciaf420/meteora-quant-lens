/* Meteora Quant Lens — background service worker (MV3)
 * Data fetching + ALL math + message handling.
 * Vanilla JS, no imports/modules. Everything defensive; never throw across the
 * message boundary — always sendResponse({ok:false,error}) on failure.
 */

'use strict';

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

const DATAPI = 'https://dlmm.datapi.meteora.ag';
const JUP = 'https://api.jup.ag';
const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// per-pool cache: address -> { ts, data }
const poolCache = new Map();  // L1: dies with the MV3 service worker (~30s idle)

// L2 cache in chrome.storage.session: survives service-worker unloads. Without
// it every 1-min alarm woke a COLD worker and refetched the whole board
// (~25 API calls/min); the in-memory TTLs effectively never applied.
async function sessionCacheGet(key, ttlMs) {
  try {
    const o = await chrome.storage.session.get(key);
    const v = o && o[key];
    if (v && Date.now() - v.ts < ttlMs) return v;
  } catch (e) {}
  return null;
}
function sessionCacheSet(key, data) {
  try { chrome.storage.session.set({ [key]: { ts: Date.now(), data } }); } catch (e) {}
}

function num(v, dflt = 0) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return (typeof n === 'number' && isFinite(n)) ? n : dflt;
}

// pick first defined value across candidate keys / paths
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (k == null) continue;
    if (k.indexOf('.') >= 0) {
      let cur = obj, ok = true;
      for (const part of k.split('.')) {
        if (cur == null || typeof cur !== 'object') { ok = false; break; }
        cur = cur[part];
      }
      if (ok && cur !== undefined && cur !== null) return cur;
    } else if (obj[k] !== undefined && obj[k] !== null) {
      return obj[k];
    }
  }
  return undefined;
}

async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: headers || {},
      signal: ctrl.signal
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: 'HTTP ' + res.status + ' for ' + url };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get({ jupApiKey: '', mqlWidthPct: 20 }, (items) => {
        if (chrome.runtime.lastError) {
          resolve({ jupApiKey: '', mqlWidthPct: 20 });
        } else {
          resolve({
            jupApiKey: (items && items.jupApiKey) ? String(items.jupApiKey) : '',
            mqlWidthPct: num(items && items.mqlWidthPct, 20) || 20
          });
        }
      });
    } catch (e) {
      resolve({ jupApiKey: '', mqlWidthPct: 20 });
    }
  });
}

// ---------------------------------------------------------------------------
// Raw data fetching
// ---------------------------------------------------------------------------

async function fetchPoolRaw(address) {
  return fetchJson(DATAPI + '/pools/' + encodeURIComponent(address));
}

async function fetchOhlcvRaw(address) {
  // datapi caps the 5m range at ~8h (a 24h/5m request 400s "time range too large"),
  // so: 6h of 5m candles for realized vol + 24h of 1h candles for day structure, in parallel
  const nowSec = Math.floor(Date.now() / 1000);
  const [rv, day] = await Promise.all([
    fetchJson(DATAPI + '/pools/' + encodeURIComponent(address) + '/ohlcv?timeframe=5m&start_time=' + (nowSec - 6 * 3600) + '&end_time=' + nowSec),
    fetchJson(DATAPI + '/pools/' + encodeURIComponent(address) + '/ohlcv?timeframe=1h&start_time=' + (nowSec - 86400) + '&end_time=' + nowSec)
  ]);
  return { ok: !!((rv && rv.ok) || (day && day.ok)), rv, day };
}

// EWMA realized vol from 5m closes, annualized to %/day.
// Replaces the legacy max(|5m|*17, ...) single-print estimator whose noise made
// edge (~1/sigma^2) swing 9x between polls.
function computeRealizedVol(candles) {
  const closes = [];
  for (const c of candles) {
    const cl = num(pick(c, 'close', 'c', 'Close'), NaN);
    if (isFinite(cl) && cl > 0) closes.push(cl);
  }
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const recent = rets.slice(-48);          // last ~4h of 5m returns
  if (recent.length >= 6) {
    const lambda = 0.9;                    // EWMA: newest return ~10% weight, smooth but responsive
    let v = 0, wsum = 0, w = 1;
    for (let i = recent.length - 1; i >= 0; i--) { v += w * recent[i] * recent[i]; wsum += w; w *= lambda; }
    v /= Math.max(wsum, 1e-12);
    return Math.sqrt(v) * Math.sqrt(288) * 100;  // per-5m -> %/day
  }
  // Young pool (<~35 min): Parkinson estimator on high-low ranges — ~5x more
  // information per candle than close-to-close, usable from 3 candles (~15 min).
  // Kills the absurd legacy prints (11,000%/day) on fresh launches.
  const hl = [];
  for (const c of candles || []) {
    const h = num(pick(c, 'high', 'h', 'High'), NaN), l = num(pick(c, 'low', 'l', 'Low'), NaN);
    if (isFinite(h) && isFinite(l) && l > 0 && h >= l) hl.push(Math.log(h / l));
  }
  if (hl.length >= 3) {
    const m = hl.reduce((a, b) => a + b * b, 0) / hl.length;
    return Math.sqrt(m / (4 * Math.LN2)) * Math.sqrt(288) * 100;
  }
  return null;  // <15 min of candles: caller falls back to legacy estimator (marked ~)
}

async function fetchJupToken(tokenAddress, apiKey) {
  if (!tokenAddress || !apiKey) return { ok: false, error: 'no key or token address' };
  const url = JUP + '/tokens/v2/search?query=' + encodeURIComponent(tokenAddress);
  return fetchJson(url, { 'x-api-key': apiKey });
}

// pull the latest OHLCV candle out of whatever shape datapi returns
function latestCandle(ohlcv) {
  if (!ohlcv) return null;
  let arr = null;
  if (Array.isArray(ohlcv)) arr = ohlcv;
  else if (Array.isArray(ohlcv.data)) arr = ohlcv.data;
  else if (Array.isArray(ohlcv.candles)) arr = ohlcv.candles;
  else if (Array.isArray(ohlcv.ohlcv)) arr = ohlcv.ohlcv;
  else if (Array.isArray(ohlcv.result)) arr = ohlcv.result;
  if (!arr || !arr.length) {
    // maybe it's a single candle object
    if (ohlcv && (ohlcv.high !== undefined || ohlcv.h !== undefined || ohlcv.close !== undefined)) {
      return ohlcv;
    }
    return null;
  }
  return arr[arr.length - 1];
}

// find the correct token entry from a Jupiter search response (array or object)
function pickJupToken(resp, tokenAddress) {
  if (!resp) return null;
  let arr = null;
  if (Array.isArray(resp)) arr = resp;
  else if (Array.isArray(resp.tokens)) arr = resp.tokens;
  else if (Array.isArray(resp.data)) arr = resp.data;
  else if (Array.isArray(resp.result)) arr = resp.result;
  else if (resp.id || resp.address) return resp; // single token object
  if (!arr || !arr.length) return null;
  if (tokenAddress) {
    const lc = String(tokenAddress).toLowerCase();
    const hit = arr.find((t) => {
      const id = String(pick(t, 'id', 'address', 'mint') || '').toLowerCase();
      return id === lc;
    });
    if (hit) return hit;
  }
  return arr[0];
}

// ---------------------------------------------------------------------------
// MATH
// ---------------------------------------------------------------------------

// sigma: age-aware realized vol %/day. rvSigma (EWMA over 5m closes) is the
// primary source; the legacy single-print estimator is only a fallback.
function computeSigma(ageH, pc5, pc1, pc24, rvSigma) {
  if (rvSigma != null && isFinite(rvSigma) && rvSigma > 0) {
    return ageH < 24 ? Math.max(rvSigma, 60) : rvSigma;
  }
  const a5 = Math.abs(num(pc5));
  const a1 = Math.abs(num(pc1));
  if (ageH >= 24) {
    return Math.max(a5 * 17, a1 * 4.9, Math.abs(num(pc24)));
  }
  // age < 24h: exclude pc24 (since-launch), floor of 60
  return Math.max(a5 * 17, a1 * 4.9, 60);
}

// edge = (feeRate1h*0.9/max(sigma,0.001)) / max(1.3*sigma/(8*W),0.001)
function computeEdge(feeRate1h, sigma, W) {
  const s = Math.max(num(sigma), 0.001);
  const numer = num(feeRate1h) * 0.9 / s;
  const denom = Math.max(1.3 * num(sigma) / (8 * W), 0.001);
  return numer / denom;
}

// breakevenFeePerDay = sigma*sigma/(8*W) / 0.9 * 1.0
function computeBreakeven(sigma, W) {
  const s = num(sigma);
  return (s * s) / (8 * W) / 0.9 * 1.0;
}

// path classification
function computePath(pc5, pc1, ddHigh, rangePos) {
  const p5 = num(pc5), p1 = num(pc1);
  if (p1 <= -25 || (p5 <= -8 && p1 < 0)) return 'FREEFALL';
  if (num(ddHigh) >= 40 && Math.abs(p5) < 5 && p1 > -15) return 'BASING';
  if (num(rangePos) > 0.85 && p1 > 40) return 'BLOWOFF';
  if (p1 > 0) return 'GRIND-UP';
  return 'CHOP';
}


// ---- recommendation engine: turns signals into a concrete play ----
function buildRecommendation(s) {
  const r = { action: 'WAIT', headline: '', steps: [], watch: [] };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const W = Math.round(clamp((s.sigma || 60) / 4, 12, 30));
  // TP anchored to earnable PnL for two-sided Spot: capped appreciation (W/4) + ~half-day fee take.
  // (A clean pump-out of a +-W band only yields ~W/4 + traversal fees; chop/fees are the real engine.)
  // CAP-AWARE (mirror of dlmm-quant): min clamp 8->4 - a low-fee entry can only earn
  // ~W/4+fees, and a TP above that is fictional (OOR-UP books the pump-out anyway).
  const tp = Math.round(clamp(W / 4 + (s.feeRate1h || 0) * 0.5, 4, 25));
  // SL just inside the structural band-break value (~ -0.75W when fully exited below).
  const sl = Math.round(clamp(0.75 * W + 2, 8, 20));
  // hard warnings first
  if (s.path === 'FREEFALL') r.watch.push('🔪 Falling knife — price is actively dumping. Do NOTHING until the 5m flattens (then it may become a BASING entry).');
  if (!s.mintAuthorityDisabled) r.watch.push('⚠️ Mint authority is LIVE — team can print supply. Scalp only, never park capital.');
  if (s.ofi1h != null && s.ofi1h > 3) r.watch.push('⚠️ Organic wallets selling ' + s.ofi1h.toFixed(1) + ':1 — entering now = being their exit liquidity.');

  if (s.verdict && s.verdict.class === 'IGNITION') {
    r.params = (s.ofi1h > 2) ? { strategy: 'Spot', minPct: -W, maxPct: 0, mode: 'single' } : { strategy: 'Spot', minPct: -W, maxPct: W, mode: 'two' };
    r.plan = { cls: 'IGNITION', tp: tp, sl: sl, widthPct: W };
    r.action = 'SCALP'; r.headline = 'Event-driven scalp — fees overpay for risk AND a catalyst is live.';
    r.steps = [
      (s.ofi1h > 2 ? 'Single-sided SOL below price (flow is sell-skewed)' : 'Two-sided Spot centered on price') + ', width ±' + W + '%',
      'Brackets: TP +' + tp + '% / SL -' + sl + '% (σ-scaled)',
      'Exit early if the 1h fee rate halves or surge decays below ~1.05x',
      'Size small — this is a fee harvest, not a conviction bet'
    ];
  } else if (s.verdict && s.verdict.class === 'BASING') {
    r.params = { strategy: 'Spot', minPct: -18, maxPct: 18, mode: 'two' };
    // cap-aware: 18/4=4.5 appreciation cap + ~1 day of fees
    const tpB = Math.min(20, Math.max(6, Math.round(4.5 + (s.feeRate1h || 0))));
    r.plan = { cls: 'BASING', tp: tpB, sl: 15, widthPct: 18, stopPrice: (s.dayLow ? s.dayLow * 0.98 : null) };
    r.action = 'REVERSION'; r.headline = 'Crash is over, base is forming, real buyers absorbing — straddle the base.';
    r.steps = [
      'Two-sided Spot centered, width ±18%',
      'Stop: price below ' + (s.dayLow ? (s.dayLow * 0.98).toExponential(3) : 'the base low') + ' (thesis dead)',
      'Brackets: TP +' + tpB + '% / SL -15% (TP = W/4 cap + ~1 day of fees)',
      'Exit if the fee rate halves from here'
    ];
  } else if (s.verdict && s.verdict.class === 'CARRY') {
    r.params = { strategy: 'Spot', minPct: -35, maxPct: 35, mode: 'two' };
    // cap-aware: 35/4=8.75 appreciation cap + ~2 days of fees (carries are multi-day)
    const tpC = Math.min(15, Math.max(6, Math.round(8.75 + (s.feeRate1h || 0) * 2)));
    r.plan = { cls: 'CARRY', tp: tpC, sl: 12, widthPct: 35 };
    r.action = 'CARRY'; r.headline = 'Calm, mature, organic-buying pool that overpays for its risk — park and ride.';
    r.steps = [
      'Two-sided Spot, WIDE: ±35% (durability over density)',
      'Brackets: TP +' + tpC + '% / SL -12% (TP = W/4 cap + ~2 days of fees)',
      'Exit when the fee rate falls below 50% of today\'s ' + (s.feeRate1h || 0).toFixed(1) + '%/day',
      'No re-centering — carries ride'
    ];
  } else if (s.verdict && s.verdict.class === 'SQUEEZE') {
    const Wq = s.squeezeW || 20;
    r.params = { strategy: 'Bid Ask', minPct: -Wq, maxPct: Wq, mode: 'two' };
    const tpQ = Math.min(25, Math.max(5, Math.round(Wq/3 + (s.feeRate1h||0)*0.5)));
    r.plan = { cls: 'SQUEEZE', tp: tpQ, sl: Math.round(0.7*Wq+2), widthPct: Wq };
    r.action = 'SQUEEZE'; r.headline = 'Vol coiled to ' + (s.sigmaRatio ? Math.round(s.sigmaRatio*100) + '%' : '<60%') + ' of its norm \u2014 bet on range expansion, either direction.';
    r.steps = [
      'Two-sided BID-ASK, width \u00b1' + Wq + '% (edges loaded, center thin \u2014 pays on the breakout)',
      'Brackets: TP +' + tpQ + '% / SL -' + Math.round(0.7*Wq+2) + '%',
      'Time-stop: if unresolved in ~24h, take capital back (dead coil)',
      'This is the LONG-vol play \u2014 opposite book to Spot classes; it loses to endless chop, wins on the rip'
    ];
  } else {
    // WAIT: find the closest class and say what would flip it
    const flips = [];
    const near = [];
    const igGates = [
      ['edge ' + fmt2(s.edge) + ' → need ≥1.0 (fees must beat expected IL)', s.edge >= 1.0],
      ['surge ' + fmt2(s.surge) + 'x → need ≥1.25x (no catalyst yet)', s.surge >= 1.25],
      ['accel ' + fmt2(s.accel) + 'x → need ≥1.2x (volume not accelerating)', s.accel >= 1.2]
    ];
    const igFails = igGates.filter(g => !g[1]);
    if (igFails.length && igFails.length <= 2) { near.push('SCALP'); igFails.forEach(g => flips.push(g[0])); }
    if (s.path !== 'BASING' && s.ddHigh != null && s.ddHigh >= 40) flips.push('down ' + Math.round(s.ddHigh) + '% from high — becomes a BASING entry once the 5m flattens and 1h > -15%');
    if (s.edge >= 1.3 && s.ofi6h != null && s.ofi6h >= 1.0) flips.push('CARRY blocked only by flow: 6h organic sellers ' + fmt2(s.ofi6h) + ':1 → flips when < 1.0');
    if (s.edge >= 1.3 && s.ofi6h != null && s.ofi6h < 1.0 && s.feeRate1h < 2) flips.push('CARRY-grade quality but fees ' + fmt2(s.feeRate1h) + '%/day too thin — flips if activity picks up');
    r.headline = near.length ? 'Close to a ' + near.join('/') + ' setup — not there yet.' : 'Nothing pays for its risk here right now.';
    // override support: nearest-class params + which gates would be ignored
    if (near.indexOf('SCALP') >= 0 && s.path !== 'FREEFALL') {
      r.override = {
        cls: 'SCALP',
        params: (s.ofi1h > 2) ? { strategy: 'Spot', minPct: -W, maxPct: 0, mode: 'single' } : { strategy: 'Spot', minPct: -W, maxPct: W, mode: 'two' },
        ignoredGates: igFails.map(function (g) { return g[0]; }),
        sizeNote: 'half size — you are trading without the gates'
      };
    } else if (s.edge >= 1.3 && s.ofi6h != null && s.path !== 'FREEFALL') {
      r.override = {
        cls: 'CARRY',
        params: { strategy: 'Spot', minPct: -35, maxPct: 35, mode: 'two' },
        ignoredGates: flips.slice(0, 2),
        sizeNote: 'half size — carry gates not met'
      };
    }
    r.steps = flips.length ? flips.slice(0, 3) : ['This pool needs a volume/fee event or a vol collapse before any entry makes sense.'];
  }
  return r;
}
function fmt2(v){ return (v == null || isNaN(v)) ? '—' : (Math.round(v * 100) / 100).toString(); }

// verdict gate evaluator: returns { pass, reasons }
function gate(label, cond) {
  return { label, pass: !!cond };
}

function summarizeGates(name, gates) {
  return gates.map((g) => (g.pass ? '\u2713 ' : '\u2717 ') + g.label);
}

function computeVerdict(m) {
  // m = collected metrics
  const {
    edge, surge, accel, organicScore, path, ageH, ofi1h, ofi6h,
    feeRate1h, tvl, sigma, mintAuthorityDisabled, freezeAuthorityDisabled
  } = m;

  // IGNITION gates
  const ign = [
    gate('edge>=1.0', edge >= 1.0),
    gate('surge>=1.25', surge >= 1.25),
    gate('accel>=1.2', accel >= 1.2),
    gate('organicScore>=40', organicScore >= 40),
    gate('path!=FREEFALL', path !== 'FREEFALL'),
    gate('ageH>=6 OR (organicScore>=60 AND ofi1h<2)',
      (ageH >= 6) || (organicScore >= 60 && ofi1h < 2))
  ];
  const ignPass = ign.every((g) => g.pass);

  // BASING gates
  const bas = [
    gate('path==BASING', path === 'BASING'),
    gate('ofi1h<=1.0', ofi1h <= 1.0),
    gate('organicScore>=60', organicScore >= 60),
    gate('feeRate1h>=15', feeRate1h >= 15),
    gate('edge>=0.5', edge >= 0.5)
  ];
  const basPass = bas.every((g) => g.pass);

  // CARRY gates
  const feeCarry = (feeRate1h >= 2)
    || (feeRate1h >= 1.2 && edge >= 2)
    || (feeRate1h >= 0.6 && edge >= 3 && sigma < 10);
  const car = [
    gate('edge>=1.3', edge >= 1.3),
    gate('ofi6h<1.0', ofi6h < 1.0),
    gate('organicScore>=60', organicScore >= 60),
    gate('tvl>=100000', tvl >= 100000),
    gate('ageH>=72', ageH >= 72),
    gate('mint+freeze disabled', !!mintAuthorityDisabled && !!freezeAuthorityDisabled),
    gate('fee/edge tier ok', feeCarry),
    gate('path in CHOP/BASING/GRIND-UP',
      path === 'CHOP' || path === 'BASING' || path === 'GRIND-UP')
  ];
  const carPass = car.every((g) => g.pass);

  // Priority IGNITION > BASING > CARRY
  if (ignPass) return { class: 'IGNITION', reasons: summarizeGates('IGNITION', ign) };
  if (basPass) return { class: 'BASING', reasons: summarizeGates('BASING', bas) };
  if (carPass) return { class: 'CARRY', reasons: summarizeGates('CARRY', car) };

  // NONE: report the class that was closest (fewest failed gates) as top summary
  const cands = [
    { name: 'IGNITION', gates: ign },
    { name: 'BASING', gates: bas },
    { name: 'CARRY', gates: car }
  ];
  let best = cands[0];
  let bestFails = Infinity;
  for (const c of cands) {
    const fails = c.gates.filter((g) => !g.pass).length;
    if (fails < bestFails) { bestFails = fails; best = c; }
  }
  const failed = best.gates.filter((g) => !g.pass).map((g) => '\u2717 ' + g.label);
  const reasons = ['NO ENTRY — closest: ' + best.name].concat(failed);
  return { class: 'NONE', reasons };
}

// ---------------------------------------------------------------------------
// Assemble full pool payload
// ---------------------------------------------------------------------------

async function buildPoolData(address, settings) {
  const W = num(settings.mqlWidthPct, 20) || 20;
  const hasKey = !!settings.jupApiKey;

  // --- Meteora datapi (required) ---
  const poolResp = await fetchPoolRaw(address);
  if (!poolResp.ok) {
    return { ok: false, error: 'datapi pool fetch failed: ' + (poolResp.error || poolResp.status) };
  }
  const p = poolResp.json || {};

  // pool descriptors (defensive field names)
  const name = pick(p, 'name', 'pool_name', 'poolName') || address;
  const tvl = num(pick(p, 'tvl', 'liquidity', 'pool_tvl'), 0);
  const binStep = num(pick(p.pool_config || {}, 'bin_step', 'binStep'), 0) || num(pick(p, 'bin_step', 'binStep'), 0);
  const baseFeePct = num(pick(p, 'pool_config.base_fee_pct', 'base_fee_pct', 'base_fee_percentage', 'baseFeePct'), 0);
  const currentPrice = num(pick(p, 'current_price', 'currentPrice', 'price'), 0);

  const ftr = pick(p, 'fee_tvl_ratio', 'feeTvlRatio') || {};
  const feeRate24h = num(pick(ftr, '24h', '24H', 'h24'), 0); // already %/day
  const feeRate1h = num(pick(ftr, '1h', '1H', 'h1'), 0) * 24; // *24 -> %/day

  // trend
  let trend = 'steady';
  if (feeRate1h >= feeRate24h * 1.05) trend = 'HEATING';
  else if (feeRate1h <= feeRate24h * 0.6) trend = 'COOLING';

  // surge
  const dynFee = num(pick(p, 'dynamic_fee_pct', 'dynamic_fee_percentage', 'dynamicFeePct'), 0);
  const surge = baseFeePct > 0 ? dynFee / baseFeePct : 0;

  // accel
  const vol = pick(p, 'volume', 'volumes') || {};
  const v30m = num(pick(vol, '30m', '30M', 'm30'), 0);
  const v4h = num(pick(vol, '4h', '4H', 'h4'), 0);
  const accel = (v30m * 48) / Math.max(v4h * 6, 1);

  // --- OHLCV (best effort) ---
  let ddHigh = null, rangePos = null, dayLow = null;
  let candleClose = null;
  let rvSigma = null;
  let trailOut = null;   // recent sigma/fee trail (exported for the HUD sparkline)
  try {
    const ohResp = await fetchOhlcvRaw(address);
    recordHealth('ohlcv', !!(ohResp && ohResp.rv && ohResp.rv.ok));
    if (ohResp.ok) {
      const arrOf = (r) => {
        const oj = r && r.ok ? r.json : null;
        if (Array.isArray(oj)) return oj;
        if (oj && Array.isArray(oj.data)) return oj.data;
        if (oj && Array.isArray(oj.candles)) return oj.candles;
        return [];
      };
      const rvC = arrOf(ohResp.rv), dayC = arrOf(ohResp.day);
      // rolling-24h structure from the 1h candles
      let hi = -Infinity, lo = Infinity;
      for (const c of dayC) {
        const h = num(pick(c, 'high', 'h', 'High'), NaN);
        const l = num(pick(c, 'low', 'l', 'Low'), NaN);
        if (isFinite(h) && h > hi) hi = h;
        if (isFinite(l) && l > 0 && l < lo) lo = l;
      }
      const closeSrc = rvC.length ? rvC : dayC;
      const close = closeSrc.length ? num(pick(closeSrc[closeSrc.length - 1], 'close', 'c', 'Close'), NaN) : NaN;
      if (isFinite(hi) && isFinite(close) && hi > 0) ddHigh = (hi - close) / hi * 100;
      if (isFinite(hi) && isFinite(lo) && lo < Infinity && isFinite(close)) {
        rangePos = (close - lo) / Math.max(hi - lo, 1e-9);
      }
      if (isFinite(lo) && lo < Infinity) dayLow = lo;
      if (isFinite(close)) candleClose = close;
      rvSigma = computeRealizedVol(rvC);
    }
  } catch (e) { /* keep nulls */ }

  // --- Jupiter (optional; graceful degradation) ---
  const jupNullPayload = {
    sigma: null, edge: null, ofi1h: null, ofi6h: null, organicScore: null, orgBuy1h: null,
    tokenAgeHours: null, mintAuthorityDisabled: null, freezeAuthorityDisabled: null,
    topHoldersPct: null, path: null,
    verdict: { class: 'NONE', reasons: ['no Jupiter key (set in options)'] }
  };

  let jup = null;
  if (hasKey) {
    const tokenAddr = pick(p, 'token_x.address', 'tokenX.address', 'mint_x', 'mintX', 'token_x_mint');
    const jResp = await fetchJupToken(tokenAddr, settings.jupApiKey);
    if (jResp.ok) {
      jup = pickJupToken(jResp.json, tokenAddr);
    }
  }

  if (!hasKey) {
    return finalize({
      ok: true,
      pool: { name, address, tvl, binStep, baseFeePct, currentPrice },
      feeRate1h, feeRate24h, trend, surge, accel,
      ddHigh, rangePos, dayLow,
      ts: Date.now()
    }, jupNullPayload);
  }

  if (!jup) {
    // key present but token lookup failed — degrade gracefully, still no throw
    const degraded = Object.assign({}, jupNullPayload);
    degraded.verdict = { class: 'NONE', reasons: ['Jupiter token lookup failed'] };
    return finalize({
      ok: true,
      pool: { name, address, tvl, binStep, baseFeePct, currentPrice },
      feeRate1h, feeRate24h, trend, surge, accel,
      ddHigh, rangePos, dayLow,
      ts: Date.now()
    }, degraded);
  }

  // --- Jupiter-derived metrics ---
  const s5 = pick(jup, 'stats5m', 'stats_5m') || {};
  const s1 = pick(jup, 'stats1h', 'stats_1h') || {};
  const s6 = pick(jup, 'stats6h', 'stats_6h') || {};
  const s24 = pick(jup, 'stats24h', 'stats_24h') || {};

  const pc5 = num(pick(s5, 'priceChange', 'price_change'), 0);
  const pc1 = num(pick(s1, 'priceChange', 'price_change'), 0);
  const pc24 = num(pick(s24, 'priceChange', 'price_change'), 0);

  // token age
  const createdAt = pick(jup, 'firstPool.createdAt', 'createdAt', 'created_at', 'firstPool.created_at');
  let ageH = 0;
  if (createdAt) {
    const t = (typeof createdAt === 'number') ? createdAt : Date.parse(createdAt);
    if (isFinite(t)) ageH = Math.max((Date.now() - t) / 3600000, 0);
  }

  const sigmaRaw = computeSigma(ageH, pc5, pc1, pc24, rvSigma);
  // ---- sigma damping: record the raw read, then use a rolling median of the last 3
  // reads (~3 min) for edge/verdict. Edge ~ 1/sigma^2 and sigma is driven by |5m|*17,
  // so a single jumpy candle can 9x the edge between two polls without this.
  let sigma = sigmaRaw;
  try {
    const histKeyE = pick(p, 'token_x.address', 'tokenX.address', 'mint_x', 'mintX', 'token_x_mint') || address;
    const hsE = await chrome.storage.local.get({ mqlHistory: {} });
    const HE = hsE.mqlHistory || {};
    const arrE = HE[histKeyE] || [];
    const lastE = arrE[arrE.length - 1];
    if (!lastE || Date.now() - lastE.ts > 50e3) {
      arrE.push({ ts: Date.now(), sigma: Math.round(sigmaRaw * 10) / 10, feeRate: Math.round(feeRate1h * 100) / 100, src: (rvSigma != null ? 'rv' : 'lg') });
      HE[histKeyE] = arrE.slice(-60);
      trailOut = HE[histKeyE];
      for (const k of Object.keys(HE)) { const a = HE[k]; if (!a.length || Date.now() - a[a.length - 1].ts > 24 * 3600e3) delete HE[k]; }
      await chrome.storage.local.set({ mqlHistory: HE });
    }
    const srcE = (rvSigma != null ? 'rv' : 'lg');
    const recentE = arrE.filter((x) => x.src === srcE).slice(-3)
      .filter((x) => Date.now() - x.ts <= 10 * 60e3)
      .map((x) => x.sigma).filter((x) => x > 0)
      .sort((a, b) => a - b);
    if (recentE.length >= 2) sigma = recentE[Math.floor(recentE.length / 2)];
  } catch (e) { /* best-effort damping; fall back to raw sigma */ }
  const edge = computeEdge(feeRate1h, sigma, W);

  // OFI per window: sellOrganicVolume / max(buyOrganicVolume,1)
  const buy1 = num(pick(s1, 'buyOrganicVolume', 'buy_organic_volume'), 0);
  const sell1 = num(pick(s1, 'sellOrganicVolume', 'sell_organic_volume'), 0);
  const buy6 = num(pick(s6, 'buyOrganicVolume', 'buy_organic_volume'), 0);
  const sell6 = num(pick(s6, 'sellOrganicVolume', 'sell_organic_volume'), 0);
  const ofi1h = sell1 / Math.max(buy1, 1);
  const ofi6h = sell6 / Math.max(buy6, 1);

  const organicScore = num(pick(jup, 'organicScore', 'organic_score'), 0);
  const audit = pick(jup, 'audit', 'audits') || {};
  const mintAuthorityDisabled = !!pick(audit, 'mintAuthorityDisabled', 'mint_authority_disabled');
  const freezeAuthorityDisabled = !!pick(audit, 'freezeAuthorityDisabled', 'freeze_authority_disabled');
  const topHoldersPct = num(pick(audit, 'topHoldersPercentage', 'top_holders_percentage', 'topHoldersPct'), null);

  const path = computePath(pc5, pc1, ddHigh == null ? 0 : ddHigh, rangePos == null ? 0 : rangePos);

  const verdict = computeVerdict({
    edge, surge, accel, organicScore, path, ageH, ofi1h, ofi6h,
    feeRate1h, tvl, sigma, mintAuthorityDisabled, freezeAuthorityDisabled
  });

  // ---- delta history + squeeze detection (data-gated) ----
  let sigmaTrail = null, sigmaRatio = null, sigmaRatioPersisted = false;
  try {
    const hs = await chrome.storage.local.get({ mqlHistory: {} });
    const H = hs.mqlHistory || {};
    const histKey = pick(p, 'token_x.address', 'tokenX.address', 'mint_x', 'mintX', 'token_x_mint') || address;  // sigma is TOKEN-level: key by mint so all pool variants share one vol baseline
    const arr = H[histKey] || [];
    const last = arr[arr.length - 1];
    if (!last || Date.now() - last.ts > 50e3) {
      arr.push({ ts: Date.now(), sigma: Math.round(sigmaRaw * 10) / 10, feeRate: Math.round(feeRate1h * 100) / 100, src: (rvSigma != null ? 'rv' : 'lg') });
      H[histKey] = arr.slice(-60);
      // prune stale pools
      for (const k of Object.keys(H)) { const a = H[k]; if (!a.length || Date.now() - a[a.length-1].ts > 24*3600e3) delete H[k]; }
      chrome.storage.local.set({ mqlHistory: H });
    }
    // CONTAMINATION GUARD: ratios only within same-source entries. When the sigma
    // model changed (legacy -> rv5m), the level shift read as a ~50% "compression"
    // and fired false SQUEEZEs board-wide (caught live 2026-08-02: CATE alert at
    // edge 0.16). After a model change the detector must re-accumulate 6+ readings.
    const curSrc = (rvSigma != null ? 'rv' : 'lg');
    const sameSrc = arr.filter((x) => x.src === curSrc);
    const prior = sameSrc.slice(0, -1).map((x) => x.sigma).filter((x) => x > 0);
    const spanMin = sameSrc.length >= 2 ? (sameSrc[sameSrc.length-1].ts - sameSrc[0].ts) / 60e3 : 0;
    if (prior.length >= 6 && spanMin >= 45) {
      const srt = [...prior].sort((a, b) => a - b);
      sigmaTrail = srt[Math.floor(srt.length / 2)];
      // SMOOTHED current sigma: median of last 3 same-source readings
      const recent = sameSrc.slice(-3).map((x) => x.sigma).sort((a, b) => a - b);
      const sigmaNow = recent[Math.floor(recent.length / 2)];
      sigmaRatio = sigmaNow / Math.max(sigmaTrail, 0.001);
      // persistence: store ratio on the latest same-source entry; squeeze needs 2 consecutive
      sameSrc[sameSrc.length - 1].ratio = Math.round(sigmaRatio * 100) / 100;
      const prevRatio = sameSrc.length >= 2 ? sameSrc[sameSrc.length - 2].ratio : null;
      sigmaRatioPersisted = (sigmaRatio <= 0.6 && prevRatio != null && prevRatio <= 0.6);
      chrome.storage.local.set({ mqlHistory: (typeof H !== 'undefined' ? H : undefined) || undefined });
    }
  } catch (e) {}
  let squeezeW = null;
  if (verdict.class === 'NONE' && sigmaRatioPersisted && path === 'CHOP'
      && (rangePos == null || (rangePos >= 0.35 && rangePos <= 0.65))
      && ofi1h != null && ofi1h >= 0.5 && ofi1h <= 2 && organicScore >= 60 && ageH >= 24
      && tvl >= 80000 && feeRate1h >= 1) {
    squeezeW = Math.min(30, Math.max(15, Math.round(sigmaTrail / 4)));
    verdict.class = 'SQUEEZE';
    verdict.reasons = ['\u2713 \u03c3 compressed to ' + Math.round(sigmaRatio * 100) + '% of trailing median (' + Math.round(sigmaTrail) + ' \u2192 ' + Math.round(sigma) + ')',
      '\u2713 CHOP mid-range, balanced organic flow', '\u2713 data-gated: ' + '6+ readings over 45+ min'];
  }
  const recommendation = buildRecommendation({ verdict, squeezeW, sigmaTrail, sigmaRatio, edge, surge, accel, sigma, ofi1h, ofi6h, organicScore, feeRate1h, path, ddHigh, dayLow, currentPrice, mintAuthorityDisabled, freezeAuthorityDisabled, ageH, tvl });
  // Edge quoted at the RECIPE's width, not the generic default W: edge scales
  // linearly with band width, so a CARRY judged at +-20 math is ~1.75x better at
  // its real +-35 band. Display-level only; verdict gates untouched (calibration).
  const recipeW = (recommendation && recommendation.plan && recommendation.plan.widthPct) ? recommendation.plan.widthPct : null;
  const edgeRecipe = (recipeW && recipeW !== W) ? Math.round(edge * recipeW / W * 100) / 100 : null;
  // health: legacy sigma on a mature (>1h) token should not happen when candles flow
  if (ageH > 1 && rvSigma == null) recordHealth('legacyMature', address);

  const data = {
    ok: true,
    pool: { name, address, tvl, binStep, baseFeePct, currentPrice },
    feeRate1h, feeRate24h, trend, surge, accel,
    sigma, sigmaRaw, sigmaSource: (rvSigma != null ? 'rv5m' : 'legacy'), edge, edgeRecipe, recipeW, trail: trailOut,
    ofi1h, ofi6h, organicScore,
    orgBuy1h: buy1,   // 1h organic buy volume (ACCUM gate: flow must exist)
    tokenAgeHours: ageH,
    mintAuthorityDisabled, freezeAuthorityDisabled, topHoldersPct,
    path, ddHigh, rangePos, dayLow,
    pc1h: pc1, pc5m: pc5,
    sigmaTrail, sigmaRatio,
    verdict,
    recommendation,
    ts: Date.now()
  };
  // stash sigma+W for breakeven reuse (not part of contract but harmless)
  data._sigma = sigma;
  data._W = W;
  return data;
}

// merge base payload with a jup-null payload for degraded cases
function finalize(base, jupPayload) {
  const out = Object.assign({}, base, jupPayload);
  out._sigma = null;
  return out;
}

// ---------------------------------------------------------------------------
// Cache-aware getters
// ---------------------------------------------------------------------------

async function getPoolData(address) {
  const cached = poolCache.get(address);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }
  const sc = await sessionCacheGet('mqlc:pool:' + address, CACHE_TTL_MS);
  if (sc) {
    poolCache.set(address, { ts: sc.ts, data: sc.data });
    return sc.data;
  }
  const settings = await getSettings();
  const data = await buildPoolData(address, settings);
  if (data && data.ok) {
    poolCache.set(address, { ts: Date.now(), data });
    sessionCacheSet('mqlc:pool:' + address, data);
  }
  return data;
}

async function getBreakeven(address, widthPct) {
  const settings = await getSettings();
  const W = num(widthPct, settings.mqlWidthPct) || num(settings.mqlWidthPct, 20) || 20;
  // reuse pool data (cache) to obtain sigma + feeRate1h
  const data = await getPoolData(address);
  if (!data || !data.ok) {
    return { ok: false, error: (data && data.error) || 'pool data unavailable' };
  }
  const sigma = (data._sigma != null) ? data._sigma : data.sigma;
  if (sigma == null) {
    return {
      ok: false,
      error: 'sigma unavailable (no Jupiter key or token lookup failed)'
    };
  }
  const breakevenFeePerDay = computeBreakeven(sigma, W);
  const breakevenFeePerDayMargin = breakevenFeePerDay * 1.3; // 1.3 margin variant
  const poolFeePerDay = num(data.feeRate1h, 0);
  const clears = poolFeePerDay >= breakevenFeePerDay;
  return {
    ok: true,
    breakevenFeePerDay,
    breakevenFeePerDayMargin,
    poolFeePerDay,
    clears,
    widthPct: W,
    sigma
  };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------


// ---- RADAR: board-wide scan for actionable pools ----
let radarCache = { ts: 0, data: null };
async function getRadar() {
  if (radarCache.data && Date.now() - radarCache.ts < 180e3) return radarCache.data;
  const scr = await sessionCacheGet('mqlc:radar', 180e3);
  if (scr) { radarCache = { ts: scr.ts, data: scr.data }; return scr.data; }
  const boardResp = await fetchJson(DATAPI + '/pools?sort_by=volume_24h:desc&page_size=100');
  if (!boardResp.ok) return { ok: false, error: 'board fetch failed' };
  const arr = (boardResp.json.data || boardResp.json.pools || boardResp.json || []).filter(
    (p) => (p.tvl || 0) >= 60000 && ((p.volume && p.volume['24h']) || 0) >= 150000
  );
  arr.forEach((p) => { p._fr = ((p.fee_tvl_ratio && p.fee_tvl_ratio['1h']) || 0) * 24; });
  arr.sort((a, b) => b._fr - a._fr);
  const items = [];
  // parallel but chunked to 4: 8 concurrent analyses x ~4 fetches each brushed
  // the datapi's 30 RPS limit in one burst
  const top8 = arr.slice(0, 8);
  const results = [];
  for (let ci = 0; ci < top8.length; ci += 4) {
    const chunk = await Promise.all(top8.slice(ci, ci + 4).map((p) => getPoolData(p.address).then((d) => ({ p, d })).catch(() => null)));
    results.push(...chunk);
  }
  for (const rp of results) {
    try {
      if (!rp) continue;
      const p = rp.p, d = rp.d;
      if (!d || !d.ok) continue;
      if (d.verdict && d.verdict.class !== 'NONE') {
        items.push({ address: p.address, name: d.pool.name, binStep: d.pool.binStep, cls: d.verdict.class, edge: d.edge, feeRate1h: d.feeRate1h, kind: 'FULL', rec: d.recommendation, dataTs: d.ts });
      } else if (d.path !== 'FREEFALL') {
        const fails = [];
        if (d.edge < 1.0) fails.push('edge ' + (Math.round(d.edge * 100) / 100));
        if (d.surge < 1.25) fails.push('surge ' + (Math.round(d.surge * 100) / 100));
        if (d.accel < 1.2) fails.push('accel ' + (Math.round(d.accel * 100) / 100));
        if (fails.length > 0 && fails.length <= 2) {
          items.push({ address: p.address, name: d.pool.name, binStep: d.pool.binStep, cls: 'NEAR', edge: d.edge, feeRate1h: d.feeRate1h, kind: 'NEAR', fails, dataTs: d.ts });
        }
      }
    } catch (e) {}
  }
  items.sort((a, b) => (a.kind === b.kind ? (b.edge || 0) - (a.edge || 0) : a.kind === 'FULL' ? -1 : 1));
  // SHADOW LOG (mirror of dlmm-quant): persist every fresh radar evaluation for
  // counterfactual replay. Chrome is open far more than the daemon runs, so this
  // is the primary collector. Export from Options -> drop into the CLI folder ->
  // node replay.cjs. Capped FIFO ~15k rows (~2 weeks at 3-min builds).
  try {
    const shRows = [];
    for (const rp of results) {
      if (!rp || !rp.d || !rp.d.ok) continue;
      const d = rp.d;
      shRows.push({ t: Date.now(), pool: d.pool.address, name: d.pool.name, tvl: Math.round(d.pool.tvl || 0),
        fr: +(d.feeRate1h || 0).toFixed(2), sg: +(d.surge || 0).toFixed(2), ac: +(d.accel || 0).toFixed(2),
        sigma: d.sigma != null ? +d.sigma.toFixed(1) : null, src: d.sigmaSource === 'rv5m' ? 'rv' : 'lg',
        edge: d.edge != null ? +d.edge.toFixed(3) : null, ofi: d.ofi1h != null ? +d.ofi1h.toFixed(2) : null,
        ofi6: d.ofi6h != null ? +d.ofi6h.toFixed(2) : null, org: Math.round(d.organicScore || 0), path: d.path,
        ageH: d.tokenAgeHours != null ? +d.tokenAgeHours.toFixed(1) : null,
        dd: d.ddHigh != null ? Math.round(d.ddHigh) : null,
        sig: (d.verdict && d.verdict.class !== 'NONE') ? d.verdict.class : null,
        w: (d.recommendation && d.recommendation.plan && d.recommendation.plan.widthPct) || null });
    }
    if (shRows.length) {
      const shSt = await chrome.storage.local.get({ mqlShadow: [] });
      const shAll = (shSt.mqlShadow || []).concat(shRows);
      await chrome.storage.local.set({ mqlShadow: shAll.slice(-15000) });
    }
  } catch (e) {}
  const kept = items.slice(0, 6);
  // oldestDataTs = true age of the stalest per-pool snapshot inside this build
  // (poolCache can serve reads up to 60s older than the radar build itself)
  const oldestDataTs = kept.length ? Math.min(...kept.map((it) => it.dataTs || Date.now())) : Date.now();
  const out = { ok: true, ts: Date.now(), oldestDataTs, items: kept };
  radarCache = { ts: Date.now(), data: out };
  sessionCacheSet('mqlc:radar', out);
  return out;
}


// ---- REMOTE ALERTS: wallet watcher -> Discord webhook (works without any Meteora tab open) ----
async function postDiscord(url, content) {
  try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 1900) }) }); } catch (e) {}
}
function clampB(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ---- position summarization (ACCUM/COMBO-aware) ---------------------------
// Fill fraction of a below-price accumulation position = token-side share of
// position value. Prefers explicit value fields from the pnl API; falls back to
// amount*price if scales look sane; last resort = linear price-traversal
// estimate (honest approximation, labeled as such downstream). Never fakes math.
function positionFill(pos, cur) {
  try {
    const xVal = num(pick(pos, 'currentXValue', 'current_x_value', 'xValueUsd', 'totalXValueUsd', 'currentTokenXValue'), NaN);
    const yVal = num(pick(pos, 'currentYValue', 'current_y_value', 'yValueUsd', 'totalYValueUsd', 'currentTokenYValue'), NaN);
    if (isFinite(xVal) && isFinite(yVal) && (xVal + yVal) > 0) {
      const f = xVal / (xVal + yVal);
      if (f >= 0 && f <= 1) return { fill: f, method: 'value' };
    }
    const xAmt = num(pick(pos, 'totalXAmount', 'total_x_amount', 'xAmount', 'amountX'), NaN);
    const yAmt = num(pick(pos, 'totalYAmount', 'total_y_amount', 'yAmount', 'amountY'), NaN);
    if (isFinite(xAmt) && isFinite(yAmt) && isFinite(cur) && cur > 0) {
      const xv = xAmt * cur, tot = xv + yAmt;
      if (tot > 0) {
        const f = xv / tot;
        if (f >= 0 && f <= 1) return { fill: f, method: 'amount' };
      }
    }
    const minP = Number(pos.minPrice), maxP = Number(pos.maxPrice);
    if (isFinite(minP) && isFinite(maxP) && maxP > minP && isFinite(cur)) {
      const f = Math.min(1, Math.max(0, (maxP - cur) / (maxP - minP)));
      return { fill: f, method: 'traversal' };
    }
  } catch (e) {}
  return { fill: null, method: null };
}

function summarizePositions(ps) {
  const legs = [];
  let cur = NaN;
  let depSum = 0; // all-time deposits (SOL) across legs — combo leg-2 detection
  for (const pp of ps) {
    try { depSum += Number((pp.allTimeDeposits && pp.allTimeDeposits.total && pp.allTimeDeposits.total.sol) || 0); } catch (e) {}
    const minP = Number(pp.minPrice), maxP = Number(pp.maxPrice), mid = (minP + maxP) / 2;
    const c = Number(pp.poolActivePrice);
    if (isFinite(c)) cur = c;
    const W = mid > 0 ? ((maxP - minP) / 2 / mid) * 100 : 20;
    legs.push({
      sig: String(pp.positionAddress || pp.position_address || ''),
      pnlPct: Number(pp.pnlSolPctChange),
      minPrice: minP, maxPrice: maxP,
      widthPct: Math.round(W)
    });
  }
  const minAll = Math.min(...legs.map((l) => l.minPrice));
  const maxAll = Math.max(...legs.map((l) => l.maxPrice));
  const midAll = (minAll + maxAll) / 2;
  const wAll = midAll > 0 ? Math.round(((maxAll - minAll) / 2 / midAll) * 100) : 20;
  // aggregate PnL: value-weighted when the API exposes position value, else simple mean
  let wsum = 0, vsum = 0, weighted = true;
  for (let i = 0; i < ps.length; i++) {
    const tv = num(pick(ps[i], 'totalValue', 'total_value', 'currentValue', 'current_value', 'positionValue', 'totalCurrentValue'), NaN);
    if (!isFinite(tv) || tv <= 0) { weighted = false; break; }
    wsum += legs[i].pnlPct * tv; vsum += tv;
  }
  const aggPnl = (weighted && vsum > 0) ? (wsum / vsum)
    : legs.reduce((s, l) => s + (isFinite(l.pnlPct) ? l.pnlPct : 0), 0) / Math.max(legs.length, 1);
  // accumulation profile: whole book sits at/below price, or price already fell through
  const accum = isFinite(cur) && (maxAll <= cur * 1.05 || cur < minAll);
  let fillSum = 0, fillN = 0, fillMethod = null;
  for (let i = 0; i < ps.length; i++) {
    const f = positionFill(ps[i], cur);
    if (f.fill != null) { fillSum += f.fill; fillN++; if (!fillMethod) fillMethod = f.method; legs[i].fillPct = Math.round(f.fill * 100); }
  }
  const fillPct = fillN ? Math.round((fillSum / fillN) * 100) : null;
  return {
    ok: true, has: true,
    count: legs.length,
    pnlPct: Math.round(aggPnl * 10) / 10,   // backward compat (aggregate)
    widthPct: wAll,                          // backward compat (combined range)
    poolActivePrice: cur,
    combo: legs.length > 1,
    depositsSol: Math.round(depSum * 1e6) / 1e6,
    accum, fillPct, fillMethod,
    minPrice: minAll, maxPrice: maxAll,
    legs
  };
}
// ---- DATA-HEALTH WATCHDOG: the extension must say when it is degraded ----
// (the OHLCV range-cap bug ran silently on legacy sigma for hours - never again)
function recordHealth(kind, val) {
  try {
    chrome.storage.session.get({ mqlHealth: { ohlcv: [], legacyMature: [] } }).then((h) => {
      const H = h.mqlHealth || { ohlcv: [], legacyMature: [] };
      const cut = Date.now() - 15 * 60e3;
      if (kind === 'ohlcv') H.ohlcv = (H.ohlcv || []).filter((x) => x.t > cut).concat([{ t: Date.now(), ok: !!val }]);
      if (kind === 'legacyMature') H.legacyMature = (H.legacyMature || []).filter((x) => x.t > cut).concat([{ t: Date.now(), pool: String(val) }]);
      chrome.storage.session.set({ mqlHealth: H });
    });
  } catch (e) {}
}
async function healthCheck() {
  try {
    const cfg = await chrome.storage.sync.get({ webhookUrl: '' });
    if (!cfg.webhookUrl) return;
    const h = await chrome.storage.session.get({ mqlHealth: { ohlcv: [], legacyMature: [] } });
    const H = h.mqlHealth || {};
    const cut = Date.now() - 10 * 60e3;
    const oh = (H.ohlcv || []).filter((x) => x.t > cut);
    const lm = (H.legacyMature || []).filter((x) => x.t > cut);
    const fails = oh.filter((x) => !x.ok).length;
    const lmPools = [...new Set(lm.map((x) => x.pool))];
    let msg = null;
    if (oh.length >= 5 && fails / oh.length > 0.5) msg = '\u26a0\ufe0f **Meteora Lens \u2014 DEGRADED**: OHLCV fetch failing ' + Math.round(fails / oh.length * 100) + '% over 10 min (' + fails + '/' + oh.length + '). Sigma is running on the legacy estimator \u2014 edge/verdict numbers are low-quality until this clears.';
    else if (lmPools.length >= 2) msg = '\u26a0\ufe0f **Meteora Lens \u2014 DEGRADED**: legacy sigma on ' + lmPools.length + ' mature pools (candle data missing where it should exist). Treat edge/verdicts with suspicion.';
    if (!msg) return;
    const st = await chrome.storage.local.get({ mqlHealthPingTs: 0 });
    if (Date.now() - (st.mqlHealthPingTs || 0) < 6 * 3600e3) return;  // one ping / 6h
    await postDiscord(cfg.webhookUrl, msg);
    try { chrome.notifications.create('mql-health-' + Date.now(), { type: 'basic', iconUrl: 'icon128.png', title: '\u26a0\ufe0f Lens degraded', message: 'Vol data quality dropped \u2014 check Discord.', priority: 2 }); } catch (e) {}
    await chrome.storage.local.set({ mqlHealthPingTs: Date.now() });
  } catch (e) {}
}

function parseWallets(s) {
  return String(s || '').split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean).slice(0, 3);
}
async function watchPositions() {
  const cfg = await chrome.storage.sync.get({ webhookUrl: '', walletAddress: '' });
  if (!cfg.webhookUrl || !cfg.walletAddress) return;
  // NB: mqlLastPos/mqlPosBaseline MUST be loaded here — they were previously never
  // read back, so every tick started with an empty snapshot: entry baselines reset to
  // the current fee rate each minute (DECAY could never fire) and the close-journal
  // never triggered. Found live 2026-08-02 when an 80% fee decay produced no ping.
  const st = await chrome.storage.local.get({ mqlAlertStates: {}, mqlEntryPlan: {}, mqlLastPos: {}, mqlPosBaseline: {} });
  const states = st.mqlAlertStates || {};
  const plans = st.mqlEntryPlan || {};
  const posBaseAll = st.mqlPosBaseline || {};
  const failedPools = new Set();   // API errors this tick: position state UNKNOWN, not closed
  const failedWallets = new Set(); // whole-wallet portfolio failures: skip close detection for its keys
  const wallets = parseWallets(cfg.walletAddress);
  const pools = [];        // union across wallets (close detection)
  const walletPools = [];  // [wallet, pool] pairs actually processed
  for (const wallet of wallets) {
    try {
      const r = await fetchJson(DATAPI + '/portfolio/open?user=' + wallet);
      if (!r.ok) { failedWallets.add(wallet); continue; }
      const wp = ((r.json.pools || r.json.data || [])).map(x => x.poolAddress || x.pool_address || x.address).filter(Boolean);
      pools.push(...wp);
      for (const p of wp.slice(0, 6)) walletPools.push([wallet, p]);
    } catch (e) { failedWallets.add(wallet); }
  }
  if (failedWallets.size === wallets.length && wallets.length > 0) return;  // nothing readable this tick
  const seen = {};
  for (const [wallet, pool] of walletPools) {
    try {
      const pr = await fetchJson(DATAPI + '/positions/' + pool + '/pnl?user=' + wallet + '&status=open');
      if (!pr.ok || !pr.json.positions) { failedPools.add(pool); continue; }
      const pd = await getPoolData(pool);
      const feeRate = (pd && pd.ok) ? pd.feeRate1h : 0;
      const name = (pd && pd.ok) ? pd.pool.name : pool.slice(0, 8);
      const ofi1h = (pd && pd.ok) ? pd.ofi1h : null;
      const pc1h = (pd && pd.ok) ? pd.pc1h : null;
      const surgeV = (pd && pd.ok) ? pd.surge : null;
      const pathV = (pd && pd.ok) ? pd.path : null;
      const poolFill = { sum: 0, n: 0 };   // aggregate fill across accumulation legs (COMBO-aware)
      for (const pos of pr.json.positions) {
        const key = pool + ':' + (pos.positionAddress || '');
        seen[key] = true;
        // rolling snapshot so a close (from ANY device) can be journaled with last-seen PnL
        if (!st.mqlLastPos) st.mqlLastPos = {};
        const prevSnap = st.mqlLastPos[key];
        // Baseline preference: Apply-time (journaled) > HUD first-seen store > own
        // rolling snapshot > current rate. Keeps HUD and background on ONE baseline.
        const planEarly = plans[pool] && (Date.now() - (plans[pool].ts || 0) < 7 * 86400e3) ? plans[pool] : null;
        const hudBase = posBaseAll[pool];
        const entryFeeRate = (planEarly && planEarly.entryFeeRate > 0) ? planEarly.entryFeeRate
          : (hudBase && hudBase.entryFeeRate > 0) ? hudBase.entryFeeRate
          : (prevSnap && prevSnap.entryFeeRate != null) ? prevSnap.entryFeeRate : feeRate;
        if (!hudBase && feeRate > 0) {
          posBaseAll[pool] = { entryFeeRate, sigma: (pd && pd.ok) ? pd.sigma : null, ts: Date.now() };
        }
        let belowCount = (prevSnap && prevSnap.belowCount) || 0;
        if (entryFeeRate > 2 && feeRate < 0.5 * entryFeeRate) belowCount++; else belowCount = 0;
        st.mqlLastPos[key] = { pool, name, wallet, pnl: Number(pos.pnlSolPctChange), ts: Date.now(),
          firstSeen: (prevSnap && prevSnap.firstSeen) || Date.now(),
          entryFeeRate, belowCount };
        const pnl = Number(pos.pnlSolPctChange);
        const minP = Number(pos.minPrice), maxP = Number(pos.maxPrice), cur = Number(pos.poolActivePrice);
        const mid = (minP + maxP) / 2;
        const W = mid > 0 ? ((maxP - minP) / 2 / mid) * 100 : 20;
        // Entry plan (journaled by the HUD Apply button) outranks generic width-math:
        // the class brackets the user actually entered on (e.g. BASING +20/-15 + stop).
        const plan = planEarly;
        const tp = (plan && plan.tp) ? plan.tp : Math.round(clampB(W / 4 + feeRate * 0.5, 8, 25));
        const sl = (plan && plan.sl) ? plan.sl : Math.round(clampB(0.75 * W + 2, 8, 20));
        const cond = {};
        if (plan && plan.stopPrice > 0 && isFinite(cur)) cond.PLAN_STOP = cur < plan.stopPrice;
        cond.OOR_DOWN = cur < minP;
        cond.OOR_UP = cur > maxP;
        cond.HIT_TP = pnl >= tp;
        cond.NEAR_TP = !cond.HIT_TP && pnl >= 0.8 * tp;
        cond.HIT_SL = pnl <= -sl;
        cond.NEAR_SL = !cond.HIT_SL && pnl <= -0.8 * sl;
        cond.DECAY = belowCount >= 2;  // fee engine died: 1h rate < 50% of entry, two reads
        cond.FLOW = ofi1h != null && ofi1h > 3 && pc1h != null && pc1h < -15;  // organic distribution
        // parity with the HUD card: FREEFALL = EXIT verdict; TIGHTEN = fee-harvest nudge
        cond.FREEFALL = pathV === 'FREEFALL';
        cond.TIGHTEN = W < 30 && surgeV != null && surgeV < 1.05 && ofi1h != null && ofi1h > 2.5
          && !cond.DECAY && !cond.FLOW && !cond.FREEFALL && !cond.HIT_SL && !cond.NEAR_SL && !cond.OOR_DOWN && !cond.OOR_UP;
        const msgs = {
          OOR_DOWN: '🔻 OUT OF RANGE (below): ' + name + ' — price ' + cur.toExponential(3) + ' under your band. Holding 100% token, earning nothing. PnL ' + pnl.toFixed(1) + '%',
          OOR_UP: '🔺 OUT OF RANGE (above): ' + name + ' — fully converted to quote. PnL ' + pnl.toFixed(1) + '%. Consider closing to lock + stop rent.',
          HIT_TP: '🟢 TP HIT: ' + name + ' at ' + pnl.toFixed(1) + '% (target +' + tp + '%). Take it.',
          NEAR_TP: '🎯 Approaching TP: ' + name + ' at ' + pnl.toFixed(1) + '% of +' + tp + '% target.',
          HIT_SL: '🔴 SL HIT: ' + name + ' at ' + pnl.toFixed(1) + '% (stop -' + sl + '%). Cut it.',
          NEAR_SL: '⚠️ Approaching SL: ' + name + ' at ' + pnl.toFixed(1) + '% vs -' + sl + '% stop.',
          DECAY: '📉 FEE ENGINE DYING: ' + name + ' — 1h fee rate ' + feeRate.toFixed(1) + '%/d, ~' + Math.round((1 - feeRate / entryFeeRate) * 100) + '% below your entry (' + entryFeeRate.toFixed(1) + '%/d). The fees WERE the trade — exit even if price looks fine. PnL ' + pnl.toFixed(1) + '%',
          PLAN_STOP: '⛔ PLAN STOP BROKEN: ' + name + ' — price ' + cur.toExponential(3) + ' fell below your ' + (plan && plan.cls ? plan.cls : '') + ' stop ' + (plan && plan.stopPrice ? plan.stopPrice.toExponential(3) : '') + '. Thesis dead — exit regardless of PnL (' + pnl.toFixed(1) + '%).',
          FLOW: '🩸 DISTRIBUTION: ' + name + ' — organic sellers ' + (ofi1h != null ? ofi1h.toFixed(1) : '?') + ':1 while price ' + (pc1h != null ? pc1h.toFixed(1) : '?') + '%/1h. Real wallets are exiting through you. Cut it. PnL ' + pnl.toFixed(1) + '%',
          FREEFALL: '🔪 FREEFALL: ' + name + ' — price is actively dumping; your bins are converting into the falling token. HUD verdict: EXIT. PnL ' + pnl.toFixed(1) + '%',
          TIGHTEN: '🧰 TIGHTEN: ' + name + ' — vol premium dead (surge ' + (surgeV != null ? surgeV.toFixed(2) : '?') + 'x) + sell-skewed organic flow (' + (ofi1h != null ? ofi1h.toFixed(1) : '?') + ':1). Claim accrued fees NOW and consider pulling partial size — keep a runner. PnL ' + pnl.toFixed(1) + '%'
        };
        // ---- ACCUMULATION profile: own rulebook (priors pending calibration) ----
        // detected once at first sight (band at/below price) and persisted; scalp
        // TP/SL alerts don't apply to a bag-building band.
        const isAccum = (prevSnap && typeof prevSnap.accum === 'boolean')
          ? prevSnap.accum
          : (isFinite(maxP) && isFinite(cur) && (maxP <= cur * 1.05 || cur < minP));
        st.mqlLastPos[key].accum = isAccum;
        if (isAccum) {
          delete cond.HIT_TP; delete cond.NEAR_TP; delete cond.HIT_SL; delete cond.NEAR_SL;
          delete cond.TIGHTEN; delete cond.FREEFALL;  // accum: freefall is the design; scalp nudges don't apply
          cond.FULLY_FILLED = cond.OOR_DOWN; delete cond.OOR_DOWN;
          msgs.FULLY_FILLED = '🪣 FULLY FILLED: ' + name + ' — price fell through the whole accumulation band. You are 100% token now. Decide: hold the bag you built, or cut. PnL ' + pnl.toFixed(1) + '%';
          msgs.OOR_UP = '🟢 POPPED ABOVE BAND: ' + name + ' — price rose above your accumulation range: 100% SOL with fees banked. Re-arm lower if you still want the bag. PnL ' + pnl.toFixed(1) + '%';
          msgs.DECAY = '📉 DYING WHILE YOU ACCUMULATE: ' + name + ' — 1h fee rate ' + feeRate.toFixed(1) + '%/d, ~' + Math.round((1 - feeRate / entryFeeRate) * 100) + '% below entry. Volume is leaving the token you are buying — the one alert that matters on an accumulation. PnL ' + pnl.toFixed(1) + '%';
          msgs.FLOW = '🩸 DISTRIBUTION INTO YOUR BAND: ' + name + ' — organic sellers ' + (ofi1h != null ? ofi1h.toFixed(1) : '?') + ':1 while price ' + (pc1h != null ? pc1h.toFixed(1) : '?') + '%/1h. You are the exit liquidity for the token you are accumulating. PnL ' + pnl.toFixed(1) + '%';
          const pf = positionFill(pos, cur);
          if (pf.fill != null) { poolFill.sum += pf.fill; poolFill.n++; }
        }
        for (const k of Object.keys(cond)) {
          const skey = key + ':' + k;
          const s0 = states[skey];
          if (cond[k]) {
            if (!s0) {
              states[skey] = { ts: Date.now(), clear: 0 };
              await postDiscord(cfg.webhookUrl, '**Meteora Lens** · ' + msgs[k] + '\nhttps://www.meteora.ag/dlmm/' + pool);
              try { chrome.notifications.create('mql-' + Date.now(), { type: 'basic', iconUrl: 'icon128.png', title: 'Meteora Lens', message: msgs[k], priority: 2 }); } catch (e) {}
            } else if (typeof s0 === 'object') {
              s0.clear = 0;  // condition back on: cancel any pending re-arm
            }
          } else if (s0 && k !== 'TIGHTEN') {
            // hysteresis re-arm: 3 consecutive clear reads AND 30 min since it fired.
            // (the old instant-delete re-arm let an oscillating NEAR_SL spam a ping per flip;
            // TIGHTEN stays one-shot per position — it is a nudge, not a state)
            const so = (typeof s0 === 'object') ? s0 : { ts: s0, clear: 0 };
            so.clear = (so.clear || 0) + 1;
            if (so.clear >= 3 && Date.now() - (so.ts || 0) > 30 * 60e3) delete states[skey];
            else states[skey] = so;
          }
        }
      }
      // pool-level fill crossings for accumulation books (averaged across combo legs)
      if (poolFill.n) {
        const fp = (poolFill.sum / poolFill.n) * 100;
        for (const th of [25, 50, 75]) {
          const fkey = pool + ':FILL_' + th;
          seen[fkey] = true; // protect from state pruning below
          if (fp >= th && !states[fkey]) {
            states[fkey] = Date.now();
            await postDiscord(cfg.webhookUrl, '**Meteora Lens** · 🪣 ACCUMULATING: ' + name + ' — band ' + Math.round(fp) + '% filled (crossed ' + th + '%). SOL is converting to token as designed.\nhttps://www.meteora.ag/dlmm/' + pool);
          } else if (fp < th && states[fkey]) { delete states[fkey]; }
        }
      }
    } catch (e) {}
  }
  // detect closes (any device): journal round trip + clean up.
  // Guards: an API-failed pool is UNKNOWN (skip), and a close needs 3 consecutive
  // confirmed-missing ticks — one flaky response must not delete the baseline and
  // re-anchor entryFeeRate at the current (possibly already-decayed) rate.
  try {
    const lp = st.mqlLastPos || {};
    const inPortfolio = new Set(pools);
    const processed = new Set(walletPools.map((wp) => wp[1]));
    const closed = [];
    for (const k of Object.keys(lp)) {
      if (seen[k]) { if (lp[k]) lp[k].miss = 0; continue; }
      const rec = lp[k];
      const poolOfK = (rec && rec.pool) || k.split(':')[0];
      if (failedPools.has(poolOfK)) continue;                       // API error: unknown
      if (rec && rec.wallet && failedWallets.has(rec.wallet)) continue;   // whole wallet unreadable: unknown
      if (!rec.wallet && failedWallets.size > 0) continue;               // pre-tag snapshot + any wallet down: play safe
      if (inPortfolio.has(poolOfK) && !processed.has(poolOfK)) continue;  // truncated (>6 pools): unknown
      // pool absent from a SUCCESSFUL portfolio response = positively gone -> count it
      rec.miss = (rec.miss || 0) + 1;
      if (rec.miss >= 3) closed.push(k);
    }
    if (closed.length) {
      const jr = await chrome.storage.local.get({ mqlTradeLog: [], mqlOverrideJournal: [] });
      const logArr = jr.mqlTradeLog || [];
      const ovrAll = jr.mqlOverrideJournal || [];
      const bl = { mqlPosBaseline: posBaseAll };
      for (const k of closed) {
        const rec = lp[k];
        // TRUE realized PnL from on-chain events (indexed in seconds, unlike the
        // closed-pnl rollup which lags): removes + fee claims - adds, in USD.
        // lastSeen kept as fallback (watcher's final 1-min-tick observation).
        let realizedPnlUsd = null, realizedPnlPct = null, feesUsd = null, ownerAddress = null;
        let evSigs = null, evTokenMint = null, evWindow = null;
        const posAddr = k.split(':')[1] || null;
        try {
          if (posAddr) {
            const hev = await fetchJson(DATAPI + '/positions/' + posAddr + '/historical?page_size=100');
            const evs = (hev.ok && hev.json && hev.json.events) || [];
            if (evs.length) {
              ownerAddress = evs[0].userAddress || null;  // on-chain owner: the key the closed-pnl rollup indexes by
              // signatures + token mint + time window: consumed by the Helius wallet-truth
              // pass to attribute wallet SOL flows to THIS trade (overlap-proof)
              evSigs = [...new Set(evs.map((ev) => ev.signature).filter(Boolean))].slice(0, 40);
              evTokenMint = evs[0].tokenX || null;
              const bts = evs.map((ev) => Number(ev.blockTime)).filter((t) => t > 0);
              if (bts.length) evWindow = { start: Math.min(...bts), end: Math.max(...bts) };
              const su = { add: 0, remove: 0, claim_fee: 0, claim_reward: 0 };
              for (const ev of evs) { if (su[ev.eventType] != null) su[ev.eventType] += Number(ev.totalUsd || 0); }
              if (su.add > 0) {
                realizedPnlUsd = Math.round((su.remove + su.claim_fee + su.claim_reward - su.add) * 100) / 100;
                realizedPnlPct = Math.round((su.remove + su.claim_fee + su.claim_reward - su.add) / su.add * 10000) / 100;
                feesUsd = Math.round((su.claim_fee + su.claim_reward) * 100) / 100;
              }
            }
          }
        } catch (e) { /* fall back to last-seen */ }
        // ---- ENTRY-CONTEXT JOIN: stitch the entry-time signal snapshot into the
        // close row so the journal is a calibration dataset (trade-origin-tagged
        // per the standing rule), not just a diary.
        let entryOrigin = 'untracked', entryCls = null, entryEdge = null, entrySigma = null, entrySigmaSource = null;
        try {
          const planC = plans[rec.pool] || null;
          const ovrsC = ovrAll.filter((o) => o.pool === rec.pool && Date.now() - (o.ts || 0) < 7 * 86400e3);
          const ovrC = ovrsC.length ? ovrsC[ovrsC.length - 1] : null;
          if (ovrC && (!planC || (ovrC.ts || 0) >= (planC.ts || 0))) {
            entryOrigin = 'override'; entryCls = ovrC.cls || null;
            entryEdge = (ovrC.edge != null) ? ovrC.edge : null;
            entrySigma = (ovrC.sigma != null) ? ovrC.sigma : null;
          } else if (planC) {
            entryOrigin = 'signal'; entryCls = planC.cls || null;
            entryEdge = (planC.entryEdge != null) ? planC.entryEdge : null;
            entrySigma = (planC.entrySigma != null) ? planC.entrySigma : null;
            entrySigmaSource = planC.entrySigmaSource || null;
          }
        } catch (e) {}
        logArr.push({ pool: rec.pool, name: rec.name, wallet: rec.wallet || null, positionAddress: posAddr, ownerAddress,
          evSigs, evTokenMint, evWindow,
          settled: false, lastSeenPnlPct: rec.pnl,
          realizedPnlPct, realizedPnlUsd, feesUsd,
          entryOrigin, entryCls, entryEdge, entrySigma, entrySigmaSource,
          entryFeeRateAtOpen: (rec.entryFeeRate != null ? Math.round(rec.entryFeeRate * 100) / 100 : null),
          openedFirstSeen: rec.firstSeen, closedDetected: Date.now(),
          holdMinutes: Math.round((Date.now() - rec.firstSeen) / 60e3) });
        delete lp[k];
        if (bl.mqlPosBaseline && bl.mqlPosBaseline[rec.pool]) delete bl.mqlPosBaseline[rec.pool];
        const pnlShow = (realizedPnlPct != null) ? realizedPnlPct : rec.pnl;
        const pnlTag = (realizedPnlPct != null) ? 'realized' : 'last seen';
        await postDiscord(cfg.webhookUrl, '**Meteora Lens** \u00b7 \ud83d\udccb Position closed: ' + rec.name + ' \u2014 ' + pnlTag + ' PnL ' + (pnlShow >= 0 ? '+' : '') + pnlShow.toFixed(1) + '%' + (realizedPnlUsd != null ? ' ($' + (realizedPnlUsd >= 0 ? '+' : '') + realizedPnlUsd.toFixed(2) + (feesUsd ? ', fees $' + feesUsd.toFixed(2) : '') + ')' : '') + ' after ~' + Math.round((Date.now() - rec.firstSeen) / 60e3) + 'min. Journaled.');
      }
      await chrome.storage.local.set({ mqlTradeLog: logArr.slice(-200), mqlPosBaseline: bl.mqlPosBaseline || {} });
    }
    st.mqlLastPos = lp;
  } catch (e) {}
  // prune entry plans for pools with no open position anymore (>24h grace so a
  // freshly-applied plan survives the gap between Apply and signing)
  try {
    let planDirty = false;
    for (const pk of Object.keys(plans)) {
      if (!pools.includes(pk) && Date.now() - (plans[pk].ts || 0) > 86400e3) { delete plans[pk]; planDirty = true; }
    }
    if (planDirty) await chrome.storage.local.set({ mqlEntryPlan: plans });
  } catch (e) {}
  // prune states for positions no longer open
  for (const k of Object.keys(states)) { const base = k.split(':').slice(0, 2).join(':'); if (!seen[base]) delete states[k]; }
  await chrome.storage.local.set({ mqlAlertStates: states, mqlLastPos: st.mqlLastPos || {}, mqlPosBaseline: posBaseAll });
}

// ---- RADAR ALERTS: ping Discord when a pool passes ALL gates (a 🔥 full signal) ----
async function radarAlertScan() {
  const cfg = await chrome.storage.sync.get({ radarAlerts: false, webhookUrl: '' });
  if (!cfg.radarAlerts || !cfg.webhookUrl) return;
  let r; try { r = await getRadar(); } catch (e) { return; }
  if (!r || !r.ok || !r.items) return;
  const stx = await chrome.storage.local.get({ mqlRadarAlerted: {} });
  const alerted = stx.mqlRadarAlerted || {};
  const now = Date.now();
  for (const it of r.items) {
    if (it.kind !== 'FULL') continue;
    if (alerted[it.address] && now - alerted[it.address] < 2 * 3600e3) continue; // 2h cooldown per pool
    const rec = it.rec || {};
    const recipe = (rec.steps && rec.steps.length) ? rec.steps.slice(0, 2).join(' · ') : (rec.headline || '');
    const bs = it.binStep ? it.binStep + 'bps ' : '';
    const msg = '🔥 **Meteora Lens — signal** · ' + it.name + ' ' + bs + '· ' + it.cls + ' · edge ' + (Math.round(it.edge * 100) / 100) + '\n' + recipe + '\nhttps://www.meteora.ag/dlmm/' + it.address;
    await postDiscord(cfg.webhookUrl, msg);
    try { chrome.notifications.create('mqlr-' + now + '-' + it.address.slice(0,4), { type: 'basic', iconUrl: 'icon128.png', title: '🔥 ' + it.cls + ' signal', message: it.name + ' · edge ' + (Math.round(it.edge * 100) / 100), priority: 2 }); } catch (e) {}
    alerted[it.address] = now;
  }
  for (const k of Object.keys(alerted)) if (now - alerted[k] > 24 * 3600e3) delete alerted[k];
  await chrome.storage.local.set({ mqlRadarAlerted: alerted });
}

chrome.alarms.create('mql-watch', { periodInMinutes: 1 });
// ---- JOURNAL SETTLEMENT: reconcile provisional (event-derived) close rows against
// Meteora's official closed-position rollup once it indexes (30min+ lag observed;
// keyed by the ON-CHAIN owner address from the events, not the watched wallet).
// Two-phase books: fast provisional at close, official SOL+USD numbers stamped later.
async function reconcileJournal() {
  try {
    const jr = await chrome.storage.local.get({ mqlTradeLog: [] });
    const arr = jr.mqlTradeLog || [];
    const now = Date.now();
    const cands = arr.filter((x) => x.closedDetected && x.settled === false && x.positionAddress && (x.ownerAddress || x.wallet)
      && now - x.closedDetected > 30 * 60e3);
    if (!cands.length) return;
    cands.sort((a, b) => (a.reconLastTry || 0) - (b.reconLastTry || 0));
    const cand = cands[0];
    cand.reconLastTry = now;
    if (now - cand.closedDetected > 48 * 3600e3) { cand.settled = 'timeout'; await chrome.storage.local.set({ mqlTradeLog: arr }); return; }
    const owner = cand.ownerAddress || cand.wallet;
    const r = await fetchJson(DATAPI + '/positions/' + cand.pool + '/pnl?user=' + owner + '&status=closed&page_size=50');
    if (r.ok) {
      const hit = (r.json.positions || []).find((p) => p.positionAddress === cand.positionAddress);
      if (hit) {
        cand.officialPnlUsd = Math.round(Number(hit.pnlUsd) * 100) / 100;
        cand.officialPnlSol = Math.round(Number(hit.pnlSol) * 1e6) / 1e6;
        cand.officialPnlPct = Math.round(Number(hit.pnlPctChange) * 100) / 100;        // USD-denominated %
        cand.officialPnlSolPct = Math.round(Number(hit.pnlSolPctChange) * 100) / 100;  // SOL-denominated % (the user's accounting)
        cand.settled = true;
        // sanity: event math vs official USD% should agree closely
        if (cand.realizedPnlPct != null && Math.abs(cand.realizedPnlPct - cand.officialPnlPct) > 0.5) cand.reconMismatch = true;
      }
    }
    await chrome.storage.local.set({ mqlTradeLog: arr });
  } catch (e) {}
}
// ---- WALLET-TRUTH (Helius): the all-in per-trade PnL in SOL, friction included ----
// Meteora's official number is position-scoped: it excludes entry-swap slippage, the
// exit zap back to SOL, priority fees, and the rent cycle. Wallet SOL flows matched
// BY SIGNATURE (position txs) + swap txs touching the trade's token mint inside the
// trade window = the true round trip, immune to overlapping-trade contamination.
const SOL_NATIVE = 'So11111111111111111111111111111111111111111';   // 11 ones: native pseudo-mint
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';  // 12 ones: wSOL (swap legs often use this)
// Method: balance-at BRACKETING of the trade window (validated live: a 4-trade
// cluster reconciled to within 0.0007 SOL of the official sum). Same-owner trades
// with overlapping windows merge into one cluster (per-trade split is impossible
// on-chain when they interleave). Pure-SOL transfer txs (funding in/out) inside
// the bracket are subtracted. A sanity gate refuses to stamp a number when the
// residual is too large (other wallet activity in the window, e.g. selling
// pre-existing token inventory bought elsewhere) - 'unattributable' beats wrong.
async function walletTruth(row, heliusKey, allRows) {
  const wallet = row.ownerAddress || row.wallet;
  if (!wallet || !row.evWindow) { row.walletTruth = 'missing-context'; return; }
  // cluster = SESSION: same-owner trades chained transitively when gaps between
  // their event windows are under 10 min. Back-to-back scalp runs cannot be
  // separated on-chain (each trade's bracket contains its neighbors' flows);
  // the session is the smallest well-defined attribution unit.
  const GAP = 600;
  const pool9 = allRows.filter((x) => x.closedDetected && x.evWindow && (x.ownerAddress || x.wallet) === wallet);
  const cluster = [row];
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of pool9) {
      if (cluster.includes(x)) continue;
      if (cluster.some((c) => x.evWindow.start < c.evWindow.end + GAP && x.evWindow.end > c.evWindow.start - GAP)) {
        cluster.push(x); grew = true;
      }
    }
  }
  const startRaw = Math.min(...cluster.map((x) => x.evWindow.start));
  const endRaw = Math.max(...cluster.map((x) => x.evWindow.end));
  const bal = async (t) => {
    const r = await fetchJson('https://api.helius.xyz/v1/wallet/' + wallet + '/balance-at?mint=' + SOL_NATIVE + '&time=' + Math.floor(t) + '&api-key=' + heliusKey);
    return (r.ok && r.json && r.json.balance !== undefined) ? Number(r.json.balance) : null;
  };
  // transfers fetched once over the widest bracket (external-funding correction)
  const PADS = [300, 90, 45];
  const wideStart = startRaw - PADS[0], wideEnd = endRaw + PADS[0];
  const trs = [];
  try {
    let cursor = null;
    for (let pg = 0; pg < 5; pg++) {
      const r = await fetchJson('https://api.helius.xyz/v1/wallet/' + wallet + '/transfers?limit=100&api-key=' + heliusKey + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      if (!r.ok) break;
      const batch = (r.json && r.json.data) || [];
      trs.push(...batch);
      const oldest = batch.length ? batch[batch.length - 1].timestamp : 0;
      if (!r.json.pagination || !r.json.pagination.hasMore || oldest < wideStart) break;
      cursor = r.json.pagination.nextCursor;
    }
  } catch (e) {}
  const officialSum = cluster.reduce((s, x) => s + (x.officialPnlSol || 0), 0);
  // adaptive pads: prefer the widest bracket (captures entry/exit swaps = true
  // friction) but shrink when neighboring activity contaminates it; gate the rest
  for (const pad of PADS) {
    const s9 = startRaw - pad, e9 = endRaw + pad;
    const b0 = await bal(s9), b1 = await bal(e9);
    if (b0 == null || b1 == null) { row.walletTruth = 'helius-error'; return; }
    let extNet = 0;
    const bySig = {};
    for (const t of trs) { if (t.timestamp >= s9 && t.timestamp <= e9) (bySig[t.signature] = bySig[t.signature] || []).push(t); }
    for (const legs of Object.values(bySig)) {
      if (legs.some((l) => l.mint !== SOL_NATIVE && l.mint !== SOL_WRAPPED)) continue;
      extNet += legs.reduce((s, l) => s + (l.direction === 'in' ? 1 : -1) * Number(l.amount || 0), 0);
    }
    const allIn = Math.round((b1 - b0 - extNet) * 1e6) / 1e6;
    if (Math.abs(allIn - officialSum) <= Math.max(0.05, 3 * Math.abs(officialSum))) {
      for (const x of cluster) {
        x.walletTruth = (cluster.length > 1 ? 'cluster(' + cluster.length + ')' : 'ok') + (pad < PADS[0] ? ' pad' + pad : '');
        x.walletPnlSol = allIn;
        x.frictionSol = Math.round((allIn - officialSum) * 1e6) / 1e6;
      }
      return;
    }
  }
  for (const x of cluster) x.walletTruth = 'unattributable';
}
async function walletTruthPass() {
  try {
    const cfgH = await chrome.storage.sync.get({ heliusApiKey: '' });
    if (!cfgH.heliusApiKey) return;
    const jr = await chrome.storage.local.get({ mqlTradeLog: [] });
    const arr = jr.mqlTradeLog || [];
    const closesAll = arr.filter((x) => x.closedDetected);
    const cand = closesAll.find((x) => x.settled === true && x.walletTruth === undefined && x.evWindow);
    if (!cand) return;
    await walletTruth(cand, cfgH.heliusApiKey, closesAll);
    await chrome.storage.local.set({ mqlTradeLog: arr });
  } catch (e) {}
}
// ---- DAILY WALLET RECON: trial balance vs ledger. Wallet SOL at UTC midnight vs
// midnight (Helius balance-at, exact and cacheable) compared against the sum of that
// day's settled trade PnLs. Drift = untracked leakage (dust, failed swaps, unjournaled
// mobile trades). Runs once per UTC day per wallet.
async function dailyRecon() {
  try {
    const cfgH = await chrome.storage.sync.get({ heliusApiKey: '', walletAddress: '' });
    if (!cfgH.heliusApiKey || !cfgH.walletAddress) return;
    const today = new Date().toISOString().slice(0, 10);
    const st = await chrome.storage.local.get({ mqlDailyReconDone: '', mqlTradeLog: [] });
    if (st.mqlDailyReconDone === today) return;
    const y = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    const arr = st.mqlTradeLog || [];
    // recon the ON-CHAIN wallets: configured addresses plus any owner seen in
    // recent journal rows (UI-alias wallets return 0 forever on Helius)
    const reconWallets = new Set(parseWallets(cfgH.walletAddress));
    for (const x of arr) { if (x.ownerAddress && x.closedDetected && Date.now() - x.closedDetected < 7 * 86400e3) reconWallets.add(x.ownerAddress); }
    for (const wallet of [...reconWallets].slice(0, 4)) {
      const bal = async (d) => {
        const r = await fetchJson('https://api.helius.xyz/v1/wallet/' + wallet + '/balance-at?mint=' + SOL_NATIVE + '&datetime=' + d + '&api-key=' + cfgH.heliusApiKey);
        return r.ok ? Number(r.json.balance || 0) : null;
      };
      const [b0, b1] = [await bal(y), await bal(today)];
      if (b0 == null || b1 == null) continue;
      const dayStart = Date.parse(y + 'T00:00:00Z'), dayEnd = Date.parse(today + 'T00:00:00Z');
      const settledSum = arr.filter((x) => x.closedDetected >= dayStart && x.closedDetected < dayEnd && x.officialPnlSol != null && (!x.wallet || x.wallet === wallet))
        .reduce((s, x) => s + x.officialPnlSol, 0);
      arr.push({ kind: 'daily_recon', date: y, wallet, startSol: b0, endSol: b1,
        deltaSol: Math.round((b1 - b0) * 1e6) / 1e6,
        settledTradeSol: Math.round(settledSum * 1e6) / 1e6, ts: Date.now() });
    }
    await chrome.storage.local.set({ mqlTradeLog: arr.slice(-200), mqlDailyReconDone: today });
  } catch (e) {}
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mql-watch') { watchPositions(); radarAlertScan(); healthCheck(); reconcileJournal(); walletTruthPass(); dailyRecon(); } });
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('mql-watch', { periodInMinutes: 1 }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
  }

  if (msg.type === 'domSelfTest') {
    (async () => {
      try {
        const cfg = await chrome.storage.sync.get({ webhookUrl: '' });
        const st = await chrome.storage.local.get({ mqlDomPingTs: 0 });
        if (cfg.webhookUrl && Date.now() - (st.mqlDomPingTs || 0) > 24 * 3600e3) {
          await postDiscord(cfg.webhookUrl, '\ud83d\udd27 **Meteora Lens \u2014 selectors broke**: ' + (msg.what || 'DOM hook') + ' no longer matches Meteora\'s UI (site redeploy?). Width-math and form features are degraded until the extension is updated.');
          await chrome.storage.local.set({ mqlDomPingTs: Date.now() });
        }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false }); }
    })();
    return true;
  }

  if (msg.type === 'testWebhook') {
    (async () => {
      const cfg = await chrome.storage.sync.get({ webhookUrl: '' });
      if (!cfg.webhookUrl) { sendResponse({ ok: false, error: 'no webhook set' }); return; }
      await postDiscord(cfg.webhookUrl, '**Meteora Lens** · ✅ webhook test — remote alerts are wired. You will get: out-of-range, approaching/hit TP, approaching/hit SL.');
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'notify') {
    try {
      chrome.notifications.create('mql-' + Date.now(), {
        type: 'basic', iconUrl: 'icon128.png',
        title: String(msg.title || 'Meteora Quant Lens'),
        message: String(msg.message || ''), priority: 2
      });
    } catch (e) {}
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'getRadar') {
    (async () => {
      try { sendResponse(await getRadar()); }
      catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === 'getMyPosition') {
    (async () => {
      try {
        const cfg = await chrome.storage.sync.get({ walletAddress: '' });
        if (!cfg.walletAddress || !msg.pool) { sendResponse({ ok: true, has: false }); return; }
        const merged = [];
        for (const w of parseWallets(cfg.walletAddress)) {
          try {
            const r = await fetchJson(DATAPI + '/positions/' + msg.pool + '/pnl?user=' + w + '&status=open');
            if (r.ok && r.json.positions && r.json.positions.length) merged.push(...r.json.positions);
          } catch (e) {}
        }
        if (!merged.length) { sendResponse({ ok: true, has: false }); return; }
        sendResponse(summarizePositions(merged));
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'getPoolData') {
    (async () => {
      try {
        if (!msg.pool) { sendResponse({ ok: false, error: 'missing pool address' }); return; }
        const data = await getPoolData(String(msg.pool));
        sendResponse(data);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    })();
    return true; // async
  }

  if (msg.type === 'getBreakeven') {
    (async () => {
      try {
        if (!msg.pool) { sendResponse({ ok: false, error: 'missing pool address' }); return; }
        const res = await getBreakeven(String(msg.pool), msg.widthPct);
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    })();
    return true; // async
  }

  sendResponse({ ok: false, error: 'unknown message type: ' + msg.type });
  return false;
});
