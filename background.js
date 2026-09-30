/* Meteora Quant Lens — background service worker (MV3)
 * Data fetching + ALL math + message handling.
 * Vanilla JS, no imports/modules. Everything defensive; never throw across the
 * message boundary — always sendResponse({ok:false,error}) on failure.
 */

'use strict';

importScripts('candle-analysis.js', 'evil-panda.js');

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

const DATAPI = 'https://dlmm.datapi.meteora.ag';
const JUP = 'https://api.jup.ag';
const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const SUPPORTED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const BID_ASK_FRESH_MS = 2 * 60 * 1000;

// per-pool cache: address -> { ts, data }
const poolCache = new Map();  // L1: dies with the MV3 service worker (~30s idle)
const jupTokenCache = new Map();
const jupTokenInflight = new Map();

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

function usablePoolSeed(address, p) {
  if (!p || String(p.address || '') !== String(address)) return false;
  const pair = getPoolPairMeta(p);
  const ftr = pick(p, 'fee_tvl_ratio', 'feeTvlRatio') || {};
  const vol = pick(p, 'volume', 'volumes') || {};
  return !!pair.tokenX.address && !!pair.tokenY.address
    && pick(p, 'current_price', 'currentPrice', 'price') !== undefined
    && pick(p, 'tvl', 'liquidity', 'pool_tvl') !== undefined
    && pick(ftr, '1h', '1H', 'h1') !== undefined && pick(ftr, '24h', '24H', 'h24') !== undefined
    && pick(vol, '30m', '30M', 'm30') !== undefined && pick(vol, '4h', '4H', 'h4') !== undefined
    && pick(p, 'dynamic_fee_pct', 'dynamic_fee_percentage', 'dynamicFeePct') !== undefined
    && (pick(p.pool_config || {}, 'base_fee_pct', 'baseFeePct') !== undefined
      || pick(p, 'base_fee_pct', 'base_fee_percentage', 'baseFeePct') !== undefined);
}

const candleHistoryLoader = globalThis.MQLCandleAnalysis.createCandleHistoryLoader({
  fetchJson: async (url) => {
    const response = await fetchJson(url);
    if (!response || !response.ok) throw new Error((response && response.error) || 'candle fetch failed');
    return response.json;
  },
  maxPools: 12
});
const candleHistoryPrimed = new Set();
let candleHistoryPersistChain = Promise.resolve();

async function persistCandleHistory(address, candles, poolCreatedAt) {
  const key = 'mqlc:candles:' + address;
  candleHistoryPersistChain = candleHistoryPersistChain.catch(() => {}).then(async () => {
    const stored = await chrome.storage.session.get({ mqlCandleCacheIndex: [] });
    const prior = (stored.mqlCandleCacheIndex || []).filter((row) => row && row.address !== address);
    const next = prior.concat([{ address, ts: Date.now() }]).slice(-12);
    const keep = new Set(next.map((row) => row.address));
    const evicted = prior.filter((row) => !keep.has(row.address)).map((row) => 'mqlc:candles:' + row.address);
    if (evicted.length) await chrome.storage.session.remove(evicted);
    await chrome.storage.session.set({
      mqlCandleCacheIndex: next,
      [key]: { ts: Date.now(), data: { candles, poolCreatedAt } }
    });
  });
  try { await candleHistoryPersistChain; } catch (e) {}
}

async function loadCandleEvidence(address, poolCreatedAt, recentCandles) {
  const key = 'mqlc:candles:' + address;
  if (!candleHistoryPrimed.has(address)) {
    candleHistoryPrimed.add(address);
    const stored = await sessionCacheGet(key, 26 * 3600e3);
    if (stored && stored.data && Array.isArray(stored.data.candles)) {
      candleHistoryLoader.seed(address, stored.data.candles,
        { poolCreatedAt: poolCreatedAt == null ? stored.data.poolCreatedAt : poolCreatedAt });
    } else if (Array.isArray(recentCandles) && recentCandles.length) {
      candleHistoryLoader.seed(address, recentCandles, { poolCreatedAt });
    }
  }
  const result = await candleHistoryLoader.load(address, { poolCreatedAt });
  // Never persist normalized remnants from an invalid/conflicting response. A
  // worker restart must refetch that history instead of treating sanitized rows
  // as proof that the original response was complete and internally consistent.
  if (result.analysis.state === 'READY' || result.analysis.state === 'LIMITED') {
    await persistCandleHistory(address, result.candles, poolCreatedAt);
  }
  return result.analysis;
}

async function fetchPoolRaw(address, seed) {
  if (usablePoolSeed(address, seed)) return { ok: true, json: seed, source: 'board' };
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
  const key = String(tokenAddress);
  const cached = jupTokenCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  if (jupTokenInflight.has(key)) return jupTokenInflight.get(key);
  const pending = (async () => {
    const stored = await sessionCacheGet('mqlc:jup:' + key, CACHE_TTL_MS);
    if (stored) {
      jupTokenCache.set(key, { ts: stored.ts, value: stored.data });
      return stored.data;
    }
    const url = JUP + '/tokens/v2/search?query=' + encodeURIComponent(tokenAddress);
    const value = await fetchJson(url, { 'x-api-key': apiKey });
    if (value && value.ok) {
      jupTokenCache.set(key, { ts: Date.now(), value });
      sessionCacheSet('mqlc:jup:' + key, value);
    }
    return value;
  })();
  jupTokenInflight.set(key, pending);
  try { return await pending; }
  finally { jupTokenInflight.delete(key); }
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

// ---- pool-age-aware window rates -------------------------------------------
// Meteora's datapi windows (30m/1h/2h/4h/12h/24h) can only cover the time a pool
// has existed. On a 1.7h-old pool every window from 2h up returns the same
// since-creation total, so reading fee_tvl_ratio['24h'] as "%/day" understated
// a young pool ~14x (caught live on NEARPAD-SOL, 2026-09-27: 6.4% in 1.7h was
// read as 6.4%/day and failed BID ASK fee persistence; it also froze Position
// Watch's "pool normal" baseline so low that DECAY could not fire).
// Every window-based rate is divided by the hours the window actually covered.
// POOL age drives this (these are pool windows); token age stays a separate fact.
const FEE_BASIS = 'pool-age-v1';   // stamped on stored baselines computed this way
const MIN_FEE_HISTORY_H = 1;       // under 1h of fees, persistence/entry checks cannot judge
const MIN_COVERED_H = 0.25;        // floor so a minutes-old pool never divides by ~0
function poolAgeHours(createdAt, nowMs) {
  const n = Number(createdAt);
  if (!isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;   // datapi sends ms; accept seconds too
  const h = ((isFinite(nowMs) ? nowMs : Date.now()) - ms) / 3600e3;
  return h >= 0 ? h : null;
}
function coveredHours(windowH, ageH) {
  return ageH == null ? windowH : Math.min(windowH, Math.max(ageH, MIN_COVERED_H));
}
// a window's fee/TVL (or volume) expressed per day over the time it really covered
function windowPerDay(windowValue, windowH, ageH) {
  return num(windowValue, 0) * 24 / coveredHours(windowH, ageH);
}
function poolAgeStage(ageH) {
  if (ageH == null) return 'UNKNOWN';
  if (ageH < MIN_FEE_HISTORY_H) return 'LAUNCH';
  if (ageH < 24) return 'YOUNG';
  return 'MATURE';
}
// Baselines journaled before FEE_BASIS were computed as ratio*24/windowH even when
// the pool was younger than the window. Rescale them by the pool's age at the time
// they were recorded so already-open positions get a correct "pool normal" too.
function legacyWindowRate(value, windowH, recordedAtMs, poolCreatedAt, basis) {
  const v = Number(value);
  if (!(v > 0)) return null;
  if (basis === FEE_BASIS) return v;
  const ageAt = poolAgeHours(poolCreatedAt, Number(recordedAtMs));
  if (ageAt == null || ageAt >= windowH) return v;
  return v * windowH / coveredHours(windowH, ageAt);
}

// ---- fee vs IL math (checked against docs.meteora.ag DLMM formulas) ----------
// LP_NET_FEES: datapi's fee_tvl_ratio is ALREADY net of the protocol cut. Proven
// live 2026-09-27: on a 0.04%-base SOL-USDC pool fees/volume = 0.0382% (below the
// base fee, impossible for gross fees); (fees + protocol_fees)/volume = 0.0424%.
// protocol/(fees+protocol) is ~10% standard, ~20% on launch pools, matching the
// docs. The old extra *0.9 took the cut a second time.
const LP_NET_FEES = 1.0;
// IL of a uniform +-W band (W = HALF-width %, sigma = %/day): sigma^2/(4W) %/day.
// Small-range LVR of concentrated liquidity (sigma^2/8 full-range * 2/w). A DLMM
// Spot bin simulation (uniform L per bin) fits k = 1.42 vs 1/(4w) = 1.25 at
// w = 20%, so this is if anything slightly generous. The old sigma^2/(8W) was
// half of it (and inconsistent with the W/4 cap derived from the same payoff).
const EDGE_MARGIN = 1.3;
const EDGE_BASIS = 'il4w-net-v1';   // stamped on stored/shadow edges (old basis read ~1.8x high)
// General form: IL %/day = sigma^2 / (2 * full band width %), while price is in
// the band. The edge heuristic assumes capital earns the pool fee rate while
// active, so the matching IL is the in-range IL. A one-sided 0 -> -W band holds
// the same capital in half the width of a +-W band (2x gamma): sigma^2/(2W).
function ilPerDayForRange(sigma, fullWidthPct) {
  const s = num(sigma);
  return (s * s) / (2 * Math.max(num(fullWidthPct), 0.001));
}
// two-sided +-W alias: full width 2W -> sigma^2/(4W)
function ilPerDay(sigma, W) {
  return ilPerDayForRange(sigma, 2 * num(W));
}
// the +-W half-width that has the same IL as a one-sided band of depth D
function oneSidedEquivalentW(depthPct) {
  return num(depthPct) / 2;
}
// edge = LP fee rate / (EDGE_MARGIN * IL): >= 1 means fees clear IL with margin.
// Same guard structure as before so tiny sigma cannot divide by zero.
function computeEdge(feeRate1h, sigma, W) {
  const s = Math.max(num(sigma), 0.001);
  const numer = num(feeRate1h) * LP_NET_FEES / s;
  const denom = Math.max(EDGE_MARGIN * num(sigma) / (4 * Math.max(num(W), 0.001)), 0.001);
  return numer / denom;
}

function getPoolPairMeta(p) {
  const x = pick(p, 'token_x', 'tokenX') || {};
  const y = pick(p, 'token_y', 'tokenY') || {};
  const tokenX = {
    address: pick(x, 'address', 'mint') || pick(p, 'mint_x', 'mintX', 'token_x_mint') || null,
    symbol: pick(x, 'symbol', 'token_symbol') || null,
    name: pick(x, 'name', 'token_name') || null
  };
  const tokenY = {
    address: pick(y, 'address', 'mint') || pick(p, 'mint_y', 'mintY', 'token_y_mint') || null,
    symbol: pick(y, 'symbol', 'token_symbol') || null,
    name: pick(y, 'name', 'token_name') || null
  };
  return {
    tokenX,
    tokenY,
    supportedSolPair: !!tokenX.address && tokenX.address !== SUPPORTED_SOL_MINT && tokenY.address === SUPPORTED_SOL_MINT
  };
}

function ignitionWidth(sigma) {
  return Math.round(Math.min(30, Math.max(12, num(sigma, 60) / 4)));
}

function basingGeometry(s) {
  const px = num(s.currentPrice, 0);
  const floor = (s.low6h > 0 && s.low6h < px) ? s.low6h
    : ((s.dayLow > 0 && s.dayLow < px) ? s.dayLow : px * 0.85);
  const rawW = px > 0 ? ((px - floor) / px) * 100 : 18;
  const widthPct = Math.min(30, Math.max(8, Math.round(rawW)));
  return { floor, widthPct, stopPrice: px > 0 ? px * (1 - widthPct / 100) * 0.98 : null };
}

function computeRecipeEdges(m) {
  // IGNITION deploys single-sided 0 -> -W when organic sellers outrun buyers
  // 2:1 (see buildRecommendation), so its edge uses the one-sided IL there.
  const igW = ignitionWidth(m.sigma);
  const igSingle = typeof m.ofi1h === 'number' && m.ofi1h > 2;
  return {
    IGNITION: computeEdge(m.feeRate1h, m.sigma, igSingle ? oneSidedEquivalentW(igW) : igW),
    BASING: computeEdge(m.feeRate1h, m.sigma, basingGeometry(m).widthPct),
    CARRY: computeEdge(m.feeRate1h, m.sigma, 35)
  };
}

function computeBidAskSignal(d, now) {
  now = isFinite(now) ? now : Date.now();
  d = d || {};
  const finite = (v) => typeof v === 'number' && isFinite(v);
  const pairOK = d.supportedSolPair !== undefined ? d.supportedSolPair === true
    : !!(d.pool && d.pool.supportedSolPair === true);
  const knownPath = ['FREEFALL', 'BASING', 'BLOWOFF', 'GRIND-UP', 'CHOP'].includes(d.path);
  const complete = d.ok === true && finite(d.ts) && finite(d.topHoldersPct) && d.topHoldersPct >= 0
    && finite(d.orgBuy1h) && d.orgBuy1h >= 0 && finite(d.feeRate1h) && d.feeRate1h >= 0
    && finite(d.feeRate24h) && d.feeRate24h >= 0 && finite(d.ofi1h) && d.ofi1h >= 0
    && finite(d.sigma) && d.sigma > 0 && knownPath
    && typeof d.mintAuthorityDisabled === 'boolean' && typeof d.freezeAuthorityDisabled === 'boolean';
  const feeHistoryShort = finite(d.poolAgeH) && d.poolAgeH < MIN_FEE_HISTORY_H;
  const gates = [
    gate('fresh', finite(d.ts) && now >= d.ts && now - d.ts <= BID_ASK_FRESH_MS),
    gate('complete inputs', complete),
    gate('token X / SOL Y pair', pairOK),
    gate('mint+freeze disabled', d.mintAuthorityDisabled === true && d.freezeAuthorityDisabled === true),
    gate('top10<=35%', finite(d.topHoldersPct) && d.topHoldersPct <= 35),
    gate('organic buyers present', finite(d.orgBuy1h) && d.orgBuy1h > 0),
    // feeRate24h is pool-age-aware (since-launch %/day on a young pool). Under an
    // hour there is no history to measure persistence against, so it cannot pass.
    gate(feeHistoryShort ? 'fee persistence (pool ' + Math.max(1, Math.round(d.poolAgeH * 60)) + 'm old; needs 1h of fees)' : 'fee persistence',
      !feeHistoryShort && finite(d.feeRate1h) && finite(d.feeRate24h) && d.feeRate24h >= 8 && d.feeRate1h >= 0.5 * d.feeRate24h),
    gate('no unbought freefall', typeof d.path === 'string' && finite(d.ofi1h) && !(d.path === 'FREEFALL' && d.ofi1h >= 1.43))
  ];
  const baseReady = gates.every((g) => g.pass);
  const candleQualification = globalThis.MQLCandleAnalysis.qualifyBidAskCandle(
    d.candleAnalysis, { nowMs: now });
  const ready = baseReady && candleQualification.ready;
  const state = ready ? 'READY' : (baseReady ? 'WATCH' : 'WAIT');
  const missing = [];
  if (d.ok !== true) missing.push('pool data');
  if (!finite(d.ts)) missing.push('snapshot time');
  if (!finite(d.sigma) || d.sigma <= 0) missing.push('volatility');
  if (!finite(d.ofi1h) || d.ofi1h < 0) missing.push('organic flow');
  if (!finite(d.orgBuy1h) || d.orgBuy1h < 0) missing.push('organic buy volume');
  if (!finite(d.feeRate1h) || !finite(d.feeRate24h)) missing.push('fee rates');
  if (!finite(d.topHoldersPct)) missing.push('holder concentration');
  if (!knownPath) missing.push('price path');
  let depthPct = null, bidAskPct = null;
  if (finite(d.sigma) && d.sigma > 0) {
    const sig = d.sigma;
    let depth = sig >= 150 ? 75 : (sig <= 80 ? 60 : 60 + ((sig - 80) / 70) * 15);
    if (finite(d.ddHigh) && d.ddHigh < 20) depth = Math.min(75, depth + 5);
    if (finite(d.ddHigh) && d.ddHigh > 50) depth = Math.max(60, depth - 5);
    depthPct = Math.round(depth);
    let share = 0.55 + (sig - 100) / 1000 + (d.ofi1h > 1 ? 0.05 : 0) + (d.path === 'FREEFALL' ? 0.05 : 0);
    share = Math.min(0.80, Math.max(0.60, share));
    bidAskPct = Math.round((Math.round(share * 20) / 20) * 100);
  }
  let reasons;
  if (ready) {
    reasons = ['base and candle qualification gates pass; manual wallet approval required'];
  } else if (!baseReady) {
    reasons = !pairOK
      ? ['Unsupported orientation: BID ASK requires a non-SOL token X and wrapped SOL token Y.']
      : (missing.length
        ? ['Waiting for current ' + missing.join(', ') + ' data.']
        : gates.filter((g) => !g.pass).map((g) => '\u2717 ' + g.label));
  } else {
    const candleReasonText = {
      fresh: 'Waiting for the latest completed 5m candle.',
      history: 'Waiting for contiguous candle history.',
      volume: 'Last completed hour is below half the prior hourly median, or its baseline is incomplete.',
      repeatedRecoveries: 'Fewer than two distinct completed pullback recoveries are available.',
      recentRecovery: 'No completed recovery within the last three hours.',
      support: 'Three completed 15m blocks have not formed two non-lower close supports.',
      cycle: 'The active pullback timed out or has not risen from its running trough.'
    };
    reasons = candleQualification.reasons.map((key) => candleReasonText[key] || ('Candle gate: ' + key));
  }
  return {
    name: 'BID ASK',
    profile: 'ACCUM',
    state,
    ready,
    baseReady,
    manual: true,
    heuristic: true,
    strategy: 'Bid-Ask + Spot',
    depthPct,
    allocation: bidAskPct == null ? null : { bidAskPct, spotPct: 100 - bidAskPct },
    gates: gates.map((g, i) => ({ key: ['fresh','data','pair','auth','top10','flow','fees','path'][i], label: g.label, pass: g.pass })),
    candleQualification,
    candleAnalysis: d.candleAnalysis || null,
    reasons
  };
}

// LP fee/day a +-W band needs just to offset expected IL (no margin)
function computeBreakeven(sigma, W) {
  return ilPerDay(sigma, W) / LP_NET_FEES;
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


// BASING requires a consolidation floor within this % of price (see the gate below)
const BASING_MAX_FLOOR = 25;

// ---- recommendation engine: turns signals into a concrete play ----
function buildRecommendation(s) {
  const r = { action: 'WAIT', headline: '', steps: [], watch: [] };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const W = ignitionWidth(s.sigma);
  const recipeEdges = s.recipeEdges || computeRecipeEdges(s);
  // TP anchored to earnable PnL for two-sided Spot: capped appreciation (W/4) + ~half-day fee take.
  // (A clean pump-out of a +-W band only yields ~W/4 + traversal fees; chop/fees are the real engine.)
  // CAP-AWARE (mirror of dlmm-quant): min clamp 8->4 - a low-fee entry can only earn
  // ~W/4+fees, and a TP above that is fictional (OOR-UP books the pump-out anyway).
  // ONE-SIDED (IGNITION deploys 0 -> -W SOL-only when organic sellers > 2:1):
  // there is NO price-driven upside (above the band it is 100% SOL, unchanged),
  // so the TP is the fee term only; and fully filled at the bottom it loses ~0.5W,
  // not 0.75W (sim, equal SOL per log bin: 6.1 / 10.4 / 15.9% at W = 12/20/30 vs
  // two-sided 9.1 / 15.2 / 22.9%). Same clamps as the two-sided brackets.
  const single = typeof s.ofi1h === 'number' && s.ofi1h > 2;
  const tp = Math.round(clamp((single ? 0 : W / 4) + (s.feeRate1h || 0) * 0.5, 4, 25));
  // SL just inside the structural band-break value (~ -0.75W two-sided, ~ -0.5W one-sided).
  const sl = Math.round(clamp((single ? 0.5 : 0.75) * W + 2, 8, 20));
  // hard warnings first
  if (s.path === 'FREEFALL') r.watch.push('🔪 Falling knife — price is actively dumping. Do NOTHING until the 5m flattens (then it may become a BASING entry).');
  if (!s.mintAuthorityDisabled) r.watch.push('⚠️ Mint authority is LIVE — team can print supply. Scalp only, never park capital.');
  if (s.ofi1h != null && s.ofi1h > 3) r.watch.push('⚠️ Organic wallets selling ' + s.ofi1h.toFixed(1) + ':1 — entering now = being their exit liquidity.');

  if (s.verdict && s.verdict.class === 'IGNITION') {
    r.params = (s.ofi1h > 2) ? { strategy: 'Spot', minPct: -W, maxPct: 0, mode: 'single' } : { strategy: 'Spot', minPct: -W, maxPct: W, mode: 'two' };
    r.plan = { cls: 'IGNITION', profile: 'TRADE', tp: tp, sl: sl, widthPct: W,
      minPct: r.params.minPct, maxPct: r.params.maxPct, mode: r.params.mode };
    r.action = 'SCALP'; r.headline = 'Event-driven scalp — fees overpay for risk AND a catalyst is live.';
    r.steps = [
      (s.ofi1h > 2 ? 'Single-sided SOL below price (flow is sell-skewed), range 0 → -' + W + '%' : 'Two-sided Spot centered on price, width ±' + W + '%'),
      'Brackets: TP +' + tp + '% / SL -' + sl + '% (σ-scaled' + (single ? '; one-sided: TP is fees only, no price upside' : '') + ')',
      'Exit early if the 1h fee rate halves or surge decays below ~1.05x',
      'Size small — this is a fee harvest, not a conviction bet'
    ];
    if (r.params.mode === 'single') r.watch.push('Single-sided 0 → -' + W + '%: the recipe edge uses the one-sided IL (same capital in half the width), so it is half the two-sided figure. Still a pool-wide fee/IL proxy.');
  } else if (s.verdict && s.verdict.class === 'BASING') {
    // BASE-ANCHORED BAND: the thesis is "price is chopping on a floor", so the band's
    // BOTTOM is placed AT that floor (recent consolidation low). Leaving the band
    // downward then IS the base breaking - the structural stop and the range agree
    // instead of contradicting. Previously: fixed +-18%% with a stop at the DAY low,
    // which on a crash-then-rally chart sat multiples below the base (unreachable),
    // leaving a -15%% PnL stop to end every trade well before the thesis died.
    const bg = basingGeometry(s);
    const floorB = bg.floor, Wb = bg.widthPct, stopB = bg.stopPrice;
    const tpB = Math.min(20, Math.max(6, Math.round(Wb / 4 + (s.feeRate1h || 0))));
    // PnL SL is a BACKSTOP below the band-break loss (~0.75W), not the primary rule:
    // a mean-reversion straddle is structurally long the dip, so a tight PnL stop
    // fights its own premise.
    const slB = Math.min(25, Math.max(10, Math.round(0.75 * Wb + 5)));
    r.params = { strategy: 'Spot', minPct: -Wb, maxPct: Wb, mode: 'two' };
    r.plan = { cls: 'BASING', profile: 'TRADE', tp: tpB, sl: slB, widthPct: Wb, stopPrice: stopB, minPct: -Wb, maxPct: Wb, mode: 'two' };
    r.action = 'REVERSION'; r.headline = 'Crash is over, base is forming, real buyers absorbing — straddle the base.';
    r.steps = [
      'Two-sided Spot centered, width ±' + Wb + '% — bottom sits ON the base (' + (floorB ? floorB.toExponential(3) : '?') + ')',
      'Stop: price below ' + (stopB ? stopB.toExponential(3) : 'the base') + ' — the base broke, thesis dead',
      'Brackets: TP +' + tpB + '% / SL -' + slB + '% (SL is a backstop; the base break is the real exit)',
      'Exit if the fee rate falls below the pool\'s normal'
    ];
  } else if (s.verdict && s.verdict.class === 'CARRY') {
    r.params = { strategy: 'Spot', minPct: -35, maxPct: 35, mode: 'two' };
    // cap-aware: 35/4=8.75 appreciation cap + ~2 days of fees (carries are multi-day)
    const tpC = Math.min(15, Math.max(6, Math.round(8.75 + (s.feeRate1h || 0) * 2)));
    r.plan = { cls: 'CARRY', profile: 'TRADE', tp: tpC, sl: 12, widthPct: 35, minPct: -35, maxPct: 35, mode: 'two' };
    r.action = 'CARRY'; r.headline = 'Calm, mature, organic-buying pool that overpays for its risk — park and ride.';
    r.steps = [
      'Two-sided Spot, WIDE: ±35% (durability over density)',
      'Brackets: TP +' + tpC + '% / SL -12% (TP = W/4 cap + ~2 days of fees)',
      'Exit when the fee rate falls below 50% of today\'s ' + (s.feeRate1h || 0).toFixed(1) + '%/day',
      'No re-centering — carries ride'
    ];
  } else {
    // WAIT: find the closest class and say what would flip it
    const flips = [];
    const near = [];
    const launchMsg = (s.poolStage === 'LAUNCH' && s.poolAgeH != null)
      ? 'pool is ' + Math.max(1, Math.round(s.poolAgeH * 60)) + 'm old → need ≥1h of fee history before an entry signal'
      : null;
    const igGates = [
      ['recipe edge ' + fmt2(recipeEdges.IGNITION) + ' → need ≥1.0 (pool-wide fee/IL heuristic at the recommended width)', recipeEdges.IGNITION >= 1.0],
      ['surge ' + fmt2(s.surge) + 'x → need ≥1.25x (no catalyst yet)', s.surge >= 1.25],
      ['accel ' + fmt2(s.accel) + 'x → need ≥1.2x (volume not accelerating)', s.accel >= 1.2]
    ];
    // the launch hold is an ignorable gate like any other, so the SCALP override
    // stays reachable on a sub-1h pool whose other scalp gates already pass
    if (launchMsg) igGates.unshift([launchMsg, false]);
    const igFails = igGates.filter(g => !g[1]);
    if (igFails.length && igFails.length <= 2) { near.push('SCALP'); igFails.forEach(g => flips.push(g[0])); }
    else if (launchMsg) flips.push(launchMsg);
    if (s.path !== 'BASING' && s.ddHigh != null && s.ddHigh >= 40) flips.push('down ' + Math.round(s.ddHigh) + '% from high — becomes a BASING entry once the 5m flattens and 1h > -15%');
    if (recipeEdges.CARRY >= 1.3 && s.ofi6h != null && s.ofi6h >= 1.0) flips.push('CARRY blocked only by flow: 6h organic sellers ' + fmt2(s.ofi6h) + ':1 → flips when < 1.0');
    if (recipeEdges.CARRY >= 1.3 && s.ofi6h != null && s.ofi6h < 1.0 && s.feeRate1h < 2) flips.push('CARRY-grade quality but fees ' + fmt2(s.feeRate1h) + '%/day too thin — flips if activity picks up');
    r.headline = near.length ? 'Close to a ' + near.join('/') + ' setup — not there yet.' : 'Nothing pays for its risk here right now.';
    // override support: nearest-class params + which gates would be ignored
    if (near.indexOf('SCALP') >= 0 && s.path !== 'FREEFALL') {
      r.override = {
        cls: 'SCALP',
        params: (s.ofi1h > 2) ? { strategy: 'Spot', minPct: -W, maxPct: 0, mode: 'single' } : { strategy: 'Spot', minPct: -W, maxPct: W, mode: 'two' },
        plan: { cls: 'IGNITION_OVERRIDE', profile: 'TRADE', widthPct: W, tp: tp, sl: sl },
        ignoredGates: igFails.map(function (g) { return g[0]; }),
        sizeNote: 'half size — you are trading without the gates'
      };
    } else if (recipeEdges.CARRY >= 1.3 && s.ofi6h != null && s.path !== 'FREEFALL') {
      r.override = {
        cls: 'CARRY',
        params: { strategy: 'Spot', minPct: -35, maxPct: 35, mode: 'two' },
        plan: { cls: 'CARRY_OVERRIDE', profile: 'TRADE', widthPct: 35, tp: Math.min(15, Math.max(6, Math.round(8.75 + (s.feeRate1h || 0) * 2))), sl: 12 },
        ignoredGates: flips.slice(0, 2),
        sizeNote: 'half size — carry gates not met'
      };
    }
    r.steps = flips.length ? flips.slice(0, 3) : ['This pool needs a volume/fee event or a vol collapse before any entry makes sense.'];
  }
  if (s.squeezeDiagnostic && s.squeezeDiagnostic.compressed) {
    r.watch.push('Volatility compression detected. Informational only: Bid-Ask remains passive liquidity with inventory risk, not a long-vol breakout trade.');
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
  const recipeEdges = m.recipeEdges || computeRecipeEdges(m);
  const pairOK = m.supportedSolPair === true;
  // Every class below is priced off the pool's fee rate. Under an hour of fee
  // history that rate is a few minutes of launch trading scaled to a day, so no
  // class issues an entry yet (the manual override remains available).
  const feeHistoryOK = m.poolAgeH == null || m.poolAgeH >= MIN_FEE_HISTORY_H;
  const feeHistoryGate = () => gate('pool fee history>=1h', feeHistoryOK);

  // IGNITION gates
  const ign = [
    gate('token X / SOL Y pair', pairOK),
    feeHistoryGate(),
    gate('recipe edge>=1.0', recipeEdges.IGNITION >= 1.0),
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
    gate('token X / SOL Y pair', pairOK),
    feeHistoryGate(),
    gate('path==BASING', path === 'BASING'),
    gate('ofi1h<=1.0', ofi1h <= 1.0),
    gate('organicScore>=60', organicScore >= 60),
    gate('feeRate1h>=15', feeRate1h >= 15),
    gate('recipe edge>=0.5', recipeEdges.BASING >= 0.5),
    // TIGHT-BASE GATE: a "base" is a level price is chopping ON. If the nearest
    // consolidation floor is a third of the way down there is no base to straddle -
    // the token just hasn't found one yet. Those setups produced the worst losses
    // (band clamped to max, structure meaningless).
    gate('floor within ' + BASING_MAX_FLOOR + '%', m.floorPct != null && m.floorPct <= BASING_MAX_FLOOR)
  ];
  const basPass = bas.every((g) => g.pass);

  // CARRY gates
  const feeCarry = (feeRate1h >= 2)
    || (feeRate1h >= 1.2 && recipeEdges.CARRY >= 2)
    || (feeRate1h >= 0.6 && recipeEdges.CARRY >= 3 && sigma < 10);
  const car = [
    gate('token X / SOL Y pair', pairOK),
    feeHistoryGate(),
    gate('recipe edge>=1.3', recipeEdges.CARRY >= 1.3),
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

async function buildPoolData(address, settings, poolSeed, options = {}) {
  const W = num(settings.mqlWidthPct, 20) || 20;
  const hasKey = !!settings.jupApiKey;
  const deferCandle = options.deferCandle === true;

  // --- Meteora datapi (required) ---
  const poolResp = await fetchPoolRaw(address, poolSeed);
  if (!poolResp.ok) {
    return { ok: false, error: 'datapi pool fetch failed: ' + (poolResp.error || poolResp.status) };
  }
  const p = poolResp.json || {};
  const sourceTs = num(p._mqlBoardTs, Date.now());
  const pair = getPoolPairMeta(p);

  // pool descriptors (defensive field names)
  const name = pick(p, 'name', 'pool_name', 'poolName') || address;
  const tvl = num(pick(p, 'tvl', 'liquidity', 'pool_tvl'), 0);
  const binStep = num(pick(p.pool_config || {}, 'bin_step', 'binStep'), 0) || num(pick(p, 'bin_step', 'binStep'), 0);
  const baseFeePct = num(pick(p, 'pool_config.base_fee_pct', 'base_fee_pct', 'base_fee_percentage', 'baseFeePct'), 0);
  const currentPrice = num(pick(p, 'current_price', 'currentPrice', 'price'), 0);
  const poolCreatedAt = pick(p, 'created_at', 'createdAt');
  // Collect Fee Mode (docs: 0 = InputOnly, fees in the token ENTERING the swap;
  // 1 = OnlyY, fees always in token Y). For a below-price SOL ladder, sellers
  // bring token X into your bins, so InputOnly pays you in the token you buy.
  const cfmRaw = pick(p.pool_config || {}, 'collect_fee_mode', 'collectFeeMode');
  const collectFeeMode = (cfmRaw === 0 || cfmRaw === 1) ? (cfmRaw === 1 ? 'OnlyY' : 'InputOnly') : null;
  const poolMeta = { name, address, tvl, binStep, baseFeePct, currentPrice, collectFeeMode,
    createdAt: poolCreatedAt,
    tokenX: pair.tokenX, tokenY: pair.tokenY, supportedSolPair: pair.supportedSolPair };

  const ftr = pick(p, 'fee_tvl_ratio', 'feeTvlRatio') || {};
  // Pool-age-aware: each window is divided by the hours it actually covered, so a
  // young pool's "24h" (really since-creation) is a true %/day. Mature pools are
  // unchanged: 24h ratio * 24/24, 1h ratio * 24/1.
  const poolAgeH = poolAgeHours(poolCreatedAt, sourceTs);
  const poolStage = poolAgeStage(poolAgeH);
  const feeRate24h = windowPerDay(pick(ftr, '24h', '24H', 'h24'), 24, poolAgeH);
  const feeRate1h = windowPerDay(pick(ftr, '1h', '1H', 'h1'), 1, poolAgeH);
  const feeWindowH = coveredHours(24, poolAgeH);   // hours behind feeRate24h ("since launch" when <24)
  const ageCtx = { poolAgeH, poolStage, feeWindowH, feeBasis: FEE_BASIS, edgeBasis: EDGE_BASIS };

  // trend (meaningless until there is at least an hour of fee history)
  let trend = 'steady';
  if (poolStage === 'LAUNCH') trend = 'NEW';
  else if (feeRate1h >= feeRate24h * 1.05) trend = 'HEATING';
  else if (feeRate1h <= feeRate24h * 0.6) trend = 'COOLING';

  // surge
  const dynFee = num(pick(p, 'dynamic_fee_pct', 'dynamic_fee_percentage', 'dynamicFeePct'), 0);
  const surge = baseFeePct > 0 ? dynFee / baseFeePct : 0;

  // accel
  const vol = pick(p, 'volume', 'volumes') || {};
  const v30m = num(pick(vol, '30m', '30M', 'm30'), 0);
  const v4h = num(pick(vol, '4h', '4H', 'h4'), 0);
  // hourly pace over the last 30m vs over the last 4h, each over the time it covered
  // (the old fixed 4h divisor inflated accel ~2x on a 2h-old pool)
  const accel = (v30m / coveredHours(0.5, poolAgeH)) / Math.max(v4h / coveredHours(4, poolAgeH), 1 / 24);

  // --- OHLCV (best effort) ---
  let ddHigh = null, rangePos = null, dayLow = null, low6h = null;
  let candleClose = null;
  let rvCandles = [];
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
      rvCandles = rvC;
      // rolling-24h structure from the 1h candles
      let hi = -Infinity, lo = Infinity;
      for (const c of dayC) {
        const h = num(pick(c, 'high', 'h', 'High'), NaN);
        const l = num(pick(c, 'low', 'l', 'Low'), NaN);
        if (isFinite(h) && h > hi) hi = h;
        if (isFinite(l) && l > 0 && l < lo) lo = l;
      }
      // consolidation floor: lowest low of the recent 5m window (the base a BASING
      // setup is straddling) - distinct from the DAY low, which on a crash-then-rally
      // chart can sit multiples below the base and make a structural stop unreachable
      let lo6 = Infinity;
      for (const c of rvC) {
        const l = num(pick(c, 'low', 'l', 'Low'), NaN);
        if (isFinite(l) && l > 0 && l < lo6) lo6 = l;
      }
      if (lo6 < Infinity) low6h = lo6;
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
  if (hasKey && pair.supportedSolPair) {
    const tokenAddr = pair.tokenX.address;
    const jResp = await fetchJupToken(tokenAddr, settings.jupApiKey);
    if (jResp.ok) {
      jup = pickJupToken(jResp.json, tokenAddr);
    }
  }

  if (!pair.supportedSolPair) {
    const unsupported = Object.assign({}, jupNullPayload, {
      verdict: { class: 'NONE', reasons: ['SOL recipes require a non-SOL token X and wrapped SOL token Y'] }
    });
    return finalize({
      ok: true, pool: poolMeta, supportedSolPair: false,
      feeRate1h, feeRate24h, trend, surge, accel, ...ageCtx,
      ddHigh, rangePos, dayLow, ts: sourceTs
    }, unsupported);
  }

  if (!hasKey) {
    return finalize({
      ok: true,
      pool: poolMeta, supportedSolPair: true,
      feeRate1h, feeRate24h, trend, surge, accel, ...ageCtx,
      ddHigh, rangePos, dayLow,
      ts: sourceTs
    }, jupNullPayload);
  }

  if (!jup) {
    // key present but token lookup failed — degrade gracefully, still no throw
    const degraded = Object.assign({}, jupNullPayload);
    degraded.verdict = { class: 'NONE', reasons: ['Jupiter token lookup failed'] };
    return finalize({
      ok: true,
      pool: poolMeta, supportedSolPair: true,
      feeRate1h, feeRate24h, trend, surge, accel, ...ageCtx,
      ddHigh, rangePos, dayLow,
      ts: sourceTs
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

  // distance from price down to the recent consolidation floor (BASING's tight-base gate)
  const floorPct = (low6h > 0 && currentPrice > 0 && low6h < currentPrice)
    ? ((currentPrice - low6h) / currentPrice) * 100 : null;
  const recipeEdges = computeRecipeEdges({ feeRate1h, sigma, currentPrice, low6h, dayLow, ofi1h });
  const verdict = computeVerdict({
    edge, surge, accel, organicScore, path, ageH, ofi1h, ofi6h,
    feeRate1h, tvl, sigma, mintAuthorityDisabled, freezeAuthorityDisabled, floorPct,
    currentPrice, low6h, dayLow, recipeEdges, supportedSolPair: pair.supportedSolPair, poolAgeH
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
  let squeezeDiagnostic = null;
  if (verdict.class === 'NONE' && sigmaRatioPersisted && path === 'CHOP'
      && (rangePos == null || (rangePos >= 0.35 && rangePos <= 0.65))
      && ofi1h != null && ofi1h >= 0.5 && ofi1h <= 2 && organicScore >= 60 && ageH >= 24
      && tvl >= 80000 && feeRate1h >= 1) {
    squeezeDiagnostic = {
      compressed: true,
      ratio: sigmaRatio,
      note: 'Volatility compression is informational only; passive Bid-Ask liquidity is not a long-vol breakout payoff.'
    };
  }
  const recommendation = buildRecommendation({ verdict, squeezeDiagnostic, sigmaTrail, sigmaRatio, edge, recipeEdges, surge, accel, sigma, ofi1h, ofi6h, organicScore, feeRate1h, path, ddHigh, dayLow, low6h, currentPrice, mintAuthorityDisabled, freezeAuthorityDisabled, ageH, tvl, poolAgeH, poolStage });
  // Keep the configured-width yardstick and expose the selected recipe-width quote.
  // Verdict gates above use the same recipe-width value; both remain pool-wide
  // heuristics and do not model a position's bin shape, share, or execution costs.
  const recipeW = (recommendation && recommendation.plan && recommendation.plan.widthPct) ? recommendation.plan.widthPct : null;
  // one-sided recipes (IGNITION single when ofi > 2) re-quote at the one-sided IL
  const recipeSingle = !!(recommendation && recommendation.plan && recommendation.plan.mode === 'single');
  const recipeEqW = recipeW ? (recipeSingle ? oneSidedEquivalentW(recipeW) : recipeW) : null;
  const edgeRecipe = (recipeEqW && recipeEqW !== W) ? Math.round(edge * recipeEqW / W * 100) / 100 : null;
  // health: legacy sigma on a mature (>1h) token should not happen when candles flow
  if (ageH > 1 && rvSigma == null) recordHealth('legacyMature', address);

  const data = {
    ok: true,
    pool: poolMeta, supportedSolPair: true,
    feeRate1h, feeRate24h, trend, surge, accel, ...ageCtx,
    sigma, sigmaRaw, sigmaSource: (rvSigma != null ? 'rv5m' : 'legacy'), edge, edgeRecipe, recipeEdges, recipeW, recipeSingle, trail: trailOut,
    ofi1h, ofi6h, organicScore,
    orgBuy1h: buy1,   // 1h organic buy volume (ACCUM gate: flow must exist)
    tokenAgeHours: ageH,
    mintAuthorityDisabled, freezeAuthorityDisabled, topHoldersPct,
    path, ddHigh, rangePos, dayLow, low6h, floorPct,
    pc1h: pc1, pc5m: pc5,
    sigmaTrail, sigmaRatio, squeezeDiagnostic,
    verdict,
    recommendation,
    ts: sourceTs
  };
  // Keep the already-fetched six-hour window available to the Radar selector
  // without putting it in the public payload or session cache. The selected
  // sibling can seed the shared loader before it backfills older windows.
  try {
    Object.defineProperty(data, '_recentCandles', { value: rvCandles, enumerable: false, configurable: true });
  } catch (e) {}
  // stash sigma+W for breakeven reuse (not part of contract but harmless)
  data._sigma = sigma;
  data._W = W;
  data.candleAnalysis = {
    state: 'NOT_COLLECTED', reason: deferCandle ? 'deferred-for-radar-selection' : 'BID ASK base gates not ready',
    note: 'provisional candle qualification; required for BID ASK READY'
  };
  data.bidAsk = computeBidAskSignal(data);
  if (data.bidAsk && data.bidAsk.baseReady && !deferCandle) {
    try {
      data.candleAnalysis = await loadCandleEvidence(address, poolCreatedAt, rvCandles);
    } catch (e) {
      data.candleAnalysis = { state: 'WAIT', reason: 'fetch-failed',
        note: 'candle qualification required for BID ASK READY', events: null };
    }
    data.bidAsk = computeBidAskSignal(data);
  }
  return data;
}

// merge base payload with a jup-null payload for degraded cases
function finalize(base, jupPayload) {
  const out = Object.assign({}, base, jupPayload);
  out._sigma = null;
  out.bidAsk = computeBidAskSignal(out);
  return out;
}

// ---------------------------------------------------------------------------
// Cache-aware getters
// ---------------------------------------------------------------------------

function freshBidAskSnapshot(data, now) {
  now = isFinite(now) ? now : Date.now();
  const ts = num(data && data.ts, NaN);
  return isFinite(ts) && now >= ts && now - ts <= BID_ASK_FRESH_MS;
}

function freshCandleAnalysis(analysis, now) {
  now = isFinite(now) ? now : Date.now();
  return !!analysis && Number(analysis.latestCompletedTs) === currentCompleted5m(now);
}

async function refreshBidAskEvidence(address, data, now) {
  if (!data || !data.ok) return data;
  data.bidAsk = computeBidAskSignal(data, now);
  if (!data.bidAsk || !data.bidAsk.baseReady) return data;
  if (!freshCandleAnalysis(data.candleAnalysis, now)) {
    try {
      data.candleAnalysis = await loadCandleEvidence(
        address,
        data.pool && data.pool.createdAt,
        data._recentCandles
      );
    } catch (e) {
      data.candleAnalysis = {
        state: 'WAIT', reason: 'fetch-failed', events: null,
        note: 'candle qualification required for BID ASK READY'
      };
    }
  }
  data.bidAsk = computeBidAskSignal(data, Date.now());
  return data;
}

async function getPoolData(address, poolSeed, options = {}) {
  const deferCandle = options.deferCandle === true;
  const now = Date.now();
  const cached = poolCache.get(address);
  if (cached && (now - cached.ts) < CACHE_TTL_MS && freshBidAskSnapshot(cached.data, now)) {
    if (deferCandle) {
      cached.data.bidAsk = computeBidAskSignal(cached.data, now);
      return cached.data;
    }
    await refreshBidAskEvidence(address, cached.data, now);
    sessionCacheSet('mqlc:pool:' + address, cached.data);
    return cached.data;
  }
  const sc = await sessionCacheGet('mqlc:pool:' + address, CACHE_TTL_MS);
  if (sc && freshBidAskSnapshot(sc.data, now)) {
    if (deferCandle) {
      sc.data.bidAsk = computeBidAskSignal(sc.data, now);
      poolCache.set(address, { ts: sc.ts, data: sc.data });
      return sc.data;
    }
    await refreshBidAskEvidence(address, sc.data, now);
    poolCache.set(address, { ts: sc.ts, data: sc.data });
    sessionCacheSet('mqlc:pool:' + address, sc.data);
    return sc.data;
  }
  const settings = await getSettings();
  const data = await buildPoolData(address, settings, poolSeed, options);
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
function currentCompleted5m(now) {
  now = isFinite(now) ? now : Date.now();
  return Math.floor(now / 1000 / 300) * 300 - 300;
}
function radarBidAskFresh(it, now) {
  now = isFinite(now) ? now : Date.now();
  if (!it || (it.kind !== 'BID_ASK' && it.kind !== 'BID_WATCH')) return true;
  if (now < num(it.dataTs, 0) || now - num(it.dataTs, 0) > BID_ASK_FRESH_MS) return false;
  if (!it.bidAsk || it.bidAsk.baseReady !== true) return false;
  if (it.kind === 'BID_ASK') {
    // A cached legacy payload can say READY without carrying the new shared
    // qualifier. Recompute on the next pool read; never expose it as an entry.
    return !!(it.bidAsk.ready && it.bidAsk.candleQualification
      && it.bidAsk.candleQualification.ready === true && it.candleAnalysis
      && it.candleAnalysis.latestCompletedTs === currentCompleted5m(now));
  }
  // A fresh base with unavailable/failed history remains a useful WATCH row;
  // it is explicitly non-actionable and carries its reason in the UI. If
  // evidence exists, it must still be for the current completed bucket.
  if (!it.candleAnalysis || it.candleAnalysis.state === 'NOT_COLLECTED') return true;
  if (it.candleAnalysis.state === 'WAIT' && it.candleAnalysis.latestCompletedTs == null) return true;
  return it.candleAnalysis.latestCompletedTs === currentCompleted5m(now);
}
function radarSnapshotUsable(r, now) {
  now = isFinite(now) ? now : Date.now();
  return !!r && Array.isArray(r.items) && isFinite(r.ts)
    && now >= r.ts && now - r.ts < 180e3
    && r.items.every((it) => radarBidAskFresh(it, now));
}
function freshRadarSnapshot(r) {
  if (!r || !Array.isArray(r.items)) return r;
  const now = Date.now();
  const fresh = (arr) => (arr || []).filter((it) => radarBidAskFresh(it, now));
  return Object.assign({}, r, { items: fresh(r.items), alertItems: fresh(r.alertItems || r.items).filter((it) => it.kind === 'FULL' || it.kind === 'BID_ASK' || it.kind === 'PANDA') });
}
function selectRadarPayload(items, now) {
  now = isFinite(now) ? now : Date.now();
  const freshItems = items.filter((it) => radarBidAskFresh(it, now));
  const actionable = freshItems.filter((it) => (it.kind === 'FULL' || it.kind === 'BID_ASK' || it.kind === 'PANDA')
    && radarBidAskFresh(it, now));
  const visible = freshItems.slice(0, 6);
  const firstBidAsk = actionable.find((it) => it.kind === 'BID_ASK')
    || freshItems.find((it) => it.kind === 'BID_WATCH');
  if (firstBidAsk && !visible.some((it) => it.kind === 'BID_ASK' || it.kind === 'BID_WATCH')) {
    if (visible.length >= 6) visible[visible.length - 1] = firstBidAsk;
    else visible.push(firstBidAsk);
  }
  const firstPanda = freshItems.find((it) => it.kind === 'PANDA') || freshItems.find((it) => it.kind === 'PANDA_WATCH');
  if (firstPanda && !visible.includes(firstPanda)) {
    if (visible.length >= 6) {
      // replace the lowest-priority non-BID-ASK chip so neither module gets evicted
      let idx = -1;
      for (let i = visible.length - 1; i >= 0; i--) if (!/^BID_/.test(visible[i].kind)) { idx = i; break; }
      if (idx >= 0) visible[idx] = firstPanda;
    } else visible.push(firstPanda);
  }
  return { items: visible, alertItems: actionable };
}
function radarBidCandidateScore(candidate, now) {
  const d = candidate && candidate.bidAsk;
  const currentlyQualified = !!(d && d.ready && d.candleQualification
    && d.candleQualification.ready === true && freshCandleAnalysis(candidate.candleAnalysis, now));
  return (currentlyQualified ? 1e12 : 0) + num(candidate && candidate.feeRate1h, 0);
}
function chooseRadarBidCandidates(candidates, now) {
  const byMint = new Map();
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.bidAsk || candidate.bidAsk.baseReady !== true) continue;
    const key = candidate.mint || candidate.address;
    const prior = byMint.get(key);
    if (!prior || radarBidCandidateScore(candidate, now) > radarBidCandidateScore(prior, now)) {
      byMint.set(key, candidate);
    }
  }
  return [...byMint.values()];
}
async function getRadar() {
  const now = Date.now();
  if (radarCache.data && now - radarCache.ts < 180e3 && radarSnapshotUsable(radarCache.data, now)) {
    return freshRadarSnapshot(radarCache.data);
  }
  const scr = await sessionCacheGet('mqlc:radar', 180e3);
  if (scr && radarSnapshotUsable(scr.data, now)) {
    radarCache = { ts: scr.ts, data: scr.data };
    return freshRadarSnapshot(scr.data);
  }
  const boardResp = await fetchJson(DATAPI + '/pools?sort_by=volume_24h:desc&page_size=100');
  if (!boardResp.ok) return { ok: false, error: 'board fetch failed' };
  const boardTs = Date.now();
  const arr = (boardResp.json.data || boardResp.json.pools || boardResp.json || []).filter(
    (p) => (p.tvl || 0) >= 60000 && ((p.volume && p.volume['24h']) || 0) >= 150000
      && getPoolPairMeta(p).supportedSolPair
  );
  arr.forEach((p) => { p._mqlBoardTs = boardTs; });
  // Pool-age-aware 1h rate for ranking. Pools under an hour old cannot issue any
  // entry yet (fee history too short), so they are not given one of the 8 slots.
  const radarPools = arr.filter((p) => {
    const a = poolAgeHours(p.created_at, boardTs);
    return a == null || a >= MIN_FEE_HISTORY_H;
  });
  radarPools.forEach((p) => {
    p._fr = windowPerDay(p.fee_tvl_ratio && p.fee_tvl_ratio['1h'], 1, poolAgeHours(p.created_at, boardTs));
  });
  radarPools.sort((a, b) => b._fr - a._fr);
  const items = [];
  // First fetch only the normal pool/Jupiter metrics. Candle history is loaded
  // after this pass so sibling pools for the same token cannot consume several
  // history slots before Radar deduplicates them.
  const top8 = radarPools.slice(0, 8);
  const results = [];
  for (let ci = 0; ci < top8.length; ci += 4) {
    const chunk = await Promise.all(top8.slice(ci, ci + 4).map((p) => getPoolData(p.address, p, { deferCandle: true }).then((d) => ({ p, d })).catch(() => null)));
    results.push(...chunk);
  }
  const bidCandidatesRaw = [];
  for (const rp of results) {
    try {
      if (!rp) continue;
      const p = rp.p, d = rp.d;
      if (!d || !d.ok) continue;
      if (d.verdict && d.verdict.class !== 'NONE') {
        items.push({ address: p.address, name: d.pool.name, binStep: d.pool.binStep, cls: d.verdict.class, edge: d.edge, feeRate1h: d.feeRate1h, kind: 'FULL', rec: d.recommendation, dataTs: d.ts });
      }
      if (d.bidAsk && d.bidAsk.baseReady) {
        const mint = d.pool && d.pool.tokenX && d.pool.tokenX.address;
        const candidate = { address: p.address, mint, name: d.pool.name, binStep: d.pool.binStep,
          cls: 'BID ASK', feeRate1h: d.feeRate1h, kind: 'BID_WATCH', bidAsk: d.bidAsk,
          candleAnalysis: d.candleAnalysis, dataTs: d.ts };
        bidCandidatesRaw.push(candidate);
      }
      if ((!d.verdict || d.verdict.class === 'NONE') && d.path !== 'FREEFALL' && !(d.bidAsk && d.bidAsk.baseReady)) {
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
  const bidCandidates = chooseRadarBidCandidates(bidCandidatesRaw, now);
  // Only the selected sibling per token gets a candle request for this Radar
  // build. Keep this bounded like the board fetches; direct pool HUD requests
  // still fetch their own history through getPoolData().
  for (let ci = 0; ci < bidCandidates.length; ci += 4) {
    const chunk = await Promise.all(bidCandidates.slice(ci, ci + 4).map(async (candidate) => {
      const rp = results.find((row) => row && row.p && row.p.address === candidate.address);
      const d = rp && rp.d;
      if (!d) return candidate;
      if (!freshCandleAnalysis(d.candleAnalysis, now)) {
        try {
          d.candleAnalysis = await loadCandleEvidence(
            candidate.address,
            d.pool && d.pool.createdAt,
            d._recentCandles
          );
        } catch (e) {
          d.candleAnalysis = {
            state: 'WAIT', reason: 'fetch-failed', events: null,
            note: 'candle qualification required for BID ASK READY'
          };
        }
      }
      d.bidAsk = computeBidAskSignal(d, Date.now());
      candidate.bidAsk = d.bidAsk;
      candidate.candleAnalysis = d.candleAnalysis;
      candidate.kind = d.bidAsk.ready ? 'BID_ASK' : 'BID_WATCH';
      return candidate;
    }));
    items.push(...chunk);
  }
  // ---- EVIL PANDA candidates. Source: sort by AGE, MC >= 250k, SOL pair, bin step
  // 80/100/125. Board fields prescreen for free; GMGN (rate-limited) only for the
  // 3 youngest distinct tokens. Young pools are allowed here (unlike the fee
  // radar's >=1h gate): Panda is a young-token play.
  try {
    const PZ = globalThis.MQLEvilPanda;
    const allBoard = (boardResp.json.data || boardResp.json.pools || boardResp.json || []);
    const seenMint = new Set();
    const pandaPre = allBoard.filter((p) => {
      const meta = getPoolPairMeta(p);
      if (!meta.supportedSolPair) return false;
      const bs = num(pick(p.pool_config || {}, 'bin_step', 'binStep'), 0) || num(pick(p, 'bin_step', 'binStep'), 0);
      if (!PZ.DEFAULTS.binSteps.includes(bs)) return false;
      const mc = num(pick(p, 'token_x.market_cap'), NaN);
      if (isFinite(mc) && mc < PZ.DEFAULTS.minMcapUsd) return false;
      if ((p.tvl || 0) < 10000) return false;
      return true;
    }).sort((a, b) => num(b.created_at, 0) - num(a.created_at, 0))
      .filter((p) => { const m = getPoolPairMeta(p).tokenX.address; if (seenMint.has(m)) return false; seenMint.add(m); return true; })
      .slice(0, 3);
    for (const p of pandaPre) {
      p._mqlBoardTs = p._mqlBoardTs || boardTs;
      const z = await getPanda(p.address, { seed: p });
      if (!z || !z.ok || !z.signals || !z.screen || z.screen.state !== 'PASS') continue;
      const e = z.signals.entry.state;
      if (e === 'LATE' || e === 'NO_DATA') continue;
      items.push({ address: p.address, mint: z.mint, name: z.name, binStep: z.recipe && z.recipe.binStep,
        cls: 'PANDA', kind: e === 'ENTRY' ? 'PANDA' : 'PANDA_WATCH', dataTs: z.ts,
        panda: { entry: e, why: z.signals.entry.why || null, tf: z.timeframe, ageMin: z.screen.facts.ageMin,
          lastClosedTs: z.signals.lastClosedTs, depth: z.recipe && z.recipe.deep && z.recipe.deep.depthPct } });
    }
  } catch (ePz) {}
  const rank = { FULL: 0, BID_ASK: 1, PANDA: 1.5, BID_WATCH: 2, PANDA_WATCH: 2.5, NEAR: 3 };
  items.sort((a, b) => (a.kind === b.kind ? (b.edge || b.feeRate1h || 0) - (a.edge || a.feeRate1h || 0) : rank[a.kind] - rank[b.kind]));
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
        // fee-rate basis tag: rows before this field used the full-window divisor,
        // so replay must not mix young-pool fr/ac values across the two bases
        fb: d.feeBasis || null, pAgeH: d.poolAgeH != null ? +d.poolAgeH.toFixed(2) : null,
        eb: d.edgeBasis || null,
        dd: d.ddHigh != null ? Math.round(d.ddHigh) : null,
        sig: (d.verdict && d.verdict.class !== 'NONE') ? d.verdict.class : (d.bidAsk && d.bidAsk.ready ? 'BID_ASK' : null),
        w: (d.recommendation && d.recommendation.plan && d.recommendation.plan.widthPct) || null,
        candle: d.candleAnalysis && (d.candleAnalysis.state === 'READY' || d.candleAnalysis.state === 'LIMITED') ? {
          state: d.candleAnalysis.state, hours: d.candleAnalysis.historyHours,
          total: d.candleAnalysis.events && d.candleAnalysis.events.total,
          matured: d.candleAnalysis.events && d.candleAnalysis.events.matured,
          recovered: d.candleAnalysis.events && d.candleAnalysis.events.recovered,
          timedOut: d.candleAnalysis.events && d.candleAnalysis.events.timedOut,
          pending: d.candleAnalysis.events && d.candleAnalysis.events.pending,
          medianDepthPct: d.candleAnalysis.medianDepthPct,
          medianRecoveryMinutes: d.candleAnalysis.medianRecoveryMinutes,
          currentDrawdownPct: d.candleAnalysis.currentDrawdownPct,
          recentVolumeRatio: d.candleAnalysis.recentVolumeRatio
        } : { state: d.candleAnalysis && d.candleAnalysis.state, reason: d.candleAnalysis && d.candleAnalysis.reason } });
    }
    if (shRows.length) {
      const shSt = await chrome.storage.local.get({ mqlShadow: [] });
      const shAll = (shSt.mqlShadow || []).concat(shRows);
      await chrome.storage.local.set({ mqlShadow: shAll.slice(-15000) });
    }
  } catch (e) {}
  const selected = selectRadarPayload(items, Date.now());
  const kept = selected.items;
  // oldestDataTs = true age of the stalest per-pool snapshot inside this build
  // (poolCache can serve reads up to 60s older than the radar build itself)
  const oldestDataTs = kept.length ? Math.min(...kept.map((it) => it.dataTs || Date.now())) : Date.now();
  const out = { ok: true, ts: Date.now(), oldestDataTs, items: kept, alertItems: selected.alertItems };
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
// Fill of a below-price SOL ladder = share of the deposited SOL that swaps have
// already spent buying the token:  1 - SOL still in the bins / net SOL deposited.
// Fields per the datapi PositionPnL schema (docs.meteora.ag, positions pnl):
//   unrealizedPnl.balanceTokenY.amount (current SOL in bins, fees excluded)
//   allTimeDeposits.tokenY.amount / allTimeWithdrawals.tokenY.amount
// The previous version read currentXValue/totalXAmount, which that schema does
// not have, so it always fell through to the price-traversal guess ("fill:
// unknown" / linear), and a value share would understate SOL spent once price
// sits below your average buy. Only meaningful for SOL-only deposits.
function positionFill(pos, cur) {
  try {
    const depX = num(pick(pos, 'allTimeDeposits.tokenX.amount'), NaN);
    const depY = num(pick(pos, 'allTimeDeposits.tokenY.amount'), NaN);
    const wdY = num(pick(pos, 'allTimeWithdrawals.tokenY.amount'), 0);
    const balY = num(pick(pos, 'unrealizedPnl.balanceTokenY.amount'), NaN);
    const netY = depY - (isFinite(wdY) ? wdY : 0);
    if (isFinite(netY) && netY > 0 && isFinite(balY) && balY >= 0 && !(depX > 0)) {
      const spentY = Math.max(0, netY - balY);
      return { fill: Math.min(1, spentY / netY), method: 'sol-spent', spentY, netY };
    }
    const minP = Number(pos.minPrice), maxP = Number(pos.maxPrice);
    if (isFinite(minP) && isFinite(maxP) && maxP > minP && isFinite(cur)) {
      const f = Math.min(1, Math.max(0, (maxP - cur) / (maxP - minP)));
      return { fill: f, method: 'traversal' };
    }
  } catch (e) {}
  return { fill: null, method: null };
}

function summarizePositions(ps, entryPlan) {
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
  // aggregate PnL: weighted by current position value in SOL (datapi
  // unrealizedPnl.balancesSol; the old field names did not exist, so this was
  // always a simple mean), else simple mean
  let wsum = 0, vsum = 0, weighted = true;
  for (let i = 0; i < ps.length; i++) {
    const tv = num(pick(ps[i], 'unrealizedPnl.balancesSol', 'unrealizedPnl.balances'), NaN);
    if (!isFinite(tv) || tv <= 0) { weighted = false; break; }
    wsum += legs[i].pnlPct * tv; vsum += tv;
  }
  const aggPnl = (weighted && vsum > 0) ? (wsum / vsum)
    : legs.reduce((s, l) => s + (isFinite(l.pnlPct) ? l.pnlPct : 0), 0) / Math.max(legs.length, 1);
  // accumulation profile: DEPOSIT COMPOSITION is the truth (caught live: the old
  // geometry check "band top at/above price" flips FALSE once price falls >5% INTO
  // the band - i.e. the accumulation working as designed - and the scalp rulebook
  // then fires EXIT on FREEFALL). A book whose deposits were ~100% SOL is a
  // below-price ladder, permanently, regardless of where price sits now.
  const createdAt = Math.min(...ps.map((p) => Number(p.createdAt || 0)).filter((t) => t > 0).concat([Infinity])) || null;
  const boundPlan = planMatchesPosition(entryPlan, wAll, createdAt, Date.now()) ? entryPlan : null;
  const depAcc = ps.map(depositAccum).filter((v) => v != null);
  let profile;
  if (boundPlan) {
    profile = resolvePositionProfile(boundPlan, ps[0], null);
  } else {
    const inferredAccum = depAcc.length ? depAcc.every((v) => v === true)
      : (isFinite(cur) && (maxAll <= cur * 1.05 || cur < minAll));
    profile = globalThis.MQLEvilPanda.isPandaShaped(minAll, maxAll) ? 'PANDA_INFERRED'
      : (inferredAccum ? 'ACCUM_INFERRED' : 'TRADE_INFERRED');
  }
  const accum = profile === 'ACCUM' || profile === 'ACCUM_INFERRED';
  // pool-level fill: total SOL spent / total SOL deposited when every leg has
  // exact SOL figures, else the mean of whatever each leg could report
  let fillSum = 0, fillN = 0, fillMethod = null, spentSum = 0, netSum = 0, allExact = true;
  for (let i = 0; i < ps.length; i++) {
    const f = positionFill(ps[i], cur);
    if (f.fill != null) { fillSum += f.fill; fillN++; if (!fillMethod) fillMethod = f.method; legs[i].fillPct = Math.round(f.fill * 100); }
    if (f.method === 'sol-spent') { spentSum += f.spentY; netSum += f.netY; } else allExact = false;
  }
  const fillPct = (allExact && netSum > 0) ? Math.round((spentSum / netSum) * 100)
    : (fillN ? Math.round((fillSum / fillN) * 100) : null);
  if (allExact && netSum > 0) fillMethod = 'sol-spent';
  return {
    ok: true, has: true,
    count: legs.length,
    pnlPct: Math.round(aggPnl * 10) / 10,   // backward compat (aggregate)
    widthPct: wAll,                          // backward compat (combined range)
    poolActivePrice: cur,
    combo: legs.length > 1,
    depositsSol: Math.round(depSum * 1e6) / 1e6,
    accum, profile, profileInferred: /_INFERRED$/.test(profile), fillPct, fillMethod,
    createdAt,
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
// deposit-composition accum test: <5% of all-time deposits on the token side
// = single-sided SOL ladder (time-invariant, unlike band-vs-price geometry)
function depositAccum(pos) {
  try {
    const dep = pos.allTimeDeposits || pos.all_time_deposits;
    if (!dep) return null;
    const xU = Number((dep.tokenX && dep.tokenX.usd) || (dep.token_x && dep.token_x.usd) || 0);
    const tU = Number((dep.total && dep.total.usd) || 0);
    if (!(tU > 0)) return null;
    return xU / tU < 0.05;
  } catch (e) { return null; }
}

function positionWidthPct(pos) {
  const minP = Number(pos && pos.minPrice), maxP = Number(pos && pos.maxPrice);
  const mid = (minP + maxP) / 2;
  return mid > 0 && isFinite(minP) && isFinite(maxP) ? ((maxP - minP) / 2 / mid) * 100 : 20;
}

function planMatchesPosition(plan, widthPct, createdAtSec, now) {
  if (!plan) return false;
  now = isFinite(now) ? now : Date.now();
  if (now - num(plan.ts, 0) >= 7 * 86400e3) return false;
  if (plan.widthPct && isFinite(widthPct)
      && Math.abs(widthPct - plan.widthPct) > Math.max(12, plan.widthPct * 0.6)) return false;
  const createdMs = Number(createdAtSec || 0) * 1000;
  return !createdMs || (createdMs >= num(plan.ts, 0) - 900e3 && createdMs - num(plan.ts, 0) < 6 * 3600e3);
}

function isPandaPlan(plan) {
  return !!(plan && (plan.profile === 'PANDA' || plan.cls === 'PANDA' || plan.cls === 'PANDA_OVERRIDE'));
}
function resolvePositionProfile(plan, pos, previousProfile) {
  if (isPandaPlan(plan)) return 'PANDA';
  // no plan + deep one-sided band (bottom <= 20% of top, i.e. >= 80% deep; BID ASK
  // tops out at 75%) = a Panda-style dump-fee band. Checked before the persisted
  // profile so legacy ACCUM_INFERRED snapshots of these bands upgrade.
  if (!plan && globalThis.MQLEvilPanda.isPandaShaped(pos && pos.minPrice, pos && pos.maxPrice)) return 'PANDA_INFERRED';
  if (plan && (plan.profile === 'ACCUM' || plan.cls === 'BID_ASK' || plan.accum === true)) return 'ACCUM';
  if (plan && (plan.profile || ['IGNITION', 'BASING', 'CARRY', 'SQUEEZE', 'IGNITION_OVERRIDE', 'CARRY_OVERRIDE'].includes(plan.cls))) return 'TRADE';
  if (typeof previousProfile === 'string' && ['ACCUM', 'TRADE', 'ACCUM_INFERRED', 'TRADE_INFERRED'].includes(previousProfile)) return previousProfile;
  const inferred = depositAccum(pos);
  if (inferred != null) return inferred ? 'ACCUM_INFERRED' : 'TRADE_INFERRED';
  if (typeof previousProfile === 'boolean') return previousProfile ? 'ACCUM_INFERRED' : 'TRADE_INFERRED';
  const minP = Number(pos && pos.minPrice), maxP = Number(pos && pos.maxPrice), cur = Number(pos && pos.poolActivePrice);
  return (isFinite(maxP) && isFinite(cur) && (maxP <= cur * 1.05 || cur < minP)) ? 'ACCUM_INFERRED' : 'TRADE_INFERRED';
}

function evaluateAccumLifecycle(flags) {
  flags = flags || {};
  if (flags.dataReady === false) return 'WAIT';
  if (flags.decay && flags.flow) return 'EXIT';
  if (flags.decay || flags.flow || flags.soft) return 'WAIT';
  return 'ACCUMULATING';
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
      const positionSignalsReady = !!(pd && pd.ok && typeof pd.ts === 'number' && isFinite(pd.ts) && Date.now() - pd.ts <= BID_ASK_FRESH_MS
        && typeof pd.feeRate1h === 'number' && isFinite(pd.feeRate1h)
        && typeof pd.ofi1h === 'number' && isFinite(pd.ofi1h)
        && typeof pd.pc1h === 'number' && isFinite(pd.pc1h));
      const poolFill = { sum: 0, n: 0, spent: 0, net: 0, exact: true };   // aggregate fill across accumulation legs (COMBO-aware)
      for (const pos of pr.json.positions) {
        const key = pool + ':' + (pos.positionAddress || '');
        seen[key] = true;
        // rolling snapshot so a close (from ANY device) can be journaled with last-seen PnL
        if (!st.mqlLastPos) st.mqlLastPos = {};
        const prevSnap = st.mqlLastPos[key];
        // Baseline preference: Apply-time (journaled) > HUD first-seen store > own
        // rolling snapshot > current rate. Keeps HUD and background on ONE baseline.
        // PLAN-BINDING GUARD (caught live: a BASING plan journaled at Apply-click but
        // never executed poisoned a LATER accum position's baseline, firing a fake
        // 65% fee-decay EXIT): a plan only binds if the position was CREATED within
        // [plan - 15min, plan + 6h]. Intent is not execution.
        const minP = Number(pos.minPrice), maxP = Number(pos.maxPrice), cur = Number(pos.poolActivePrice);
        const W = positionWidthPct(pos);
        try { if (globalThis.MQLEvilPanda.isPandaShaped(minP, maxP)) pandaShapes[pool] = { name, wallet, minP, maxP, ts: Date.now() }; } catch (eP) {}
        const planRaw9 = plans[pool] || null;
        const planEarly = planMatchesPosition(planRaw9, W, pos.createdAt, Date.now()) ? planRaw9 : null;
        const hudBase = posBaseAll[pool];
        // Baselines stored before FEE_BASIS used the full-window divisor even on a
        // young pool (a 1.7h pool's "24h normal" stored ~14x too low, which left
        // DECAY effectively unarmable). Rescale each by the pool's age when recorded.
        const poolCreated = (pd && pd.ok && pd.pool) ? pd.pool.createdAt : null;
        const basisKnown = poolAgeHours(poolCreated, Date.now()) != null;
        const baseRate = (rec, field, windowH, tsField) => (rec
          ? legacyWindowRate(rec[field], windowH, rec[tsField], poolCreated, rec.feeBasis) : null);
        const snapE1 = baseRate(prevSnap, 'entryFeeRate', 1, 'firstSeen');
        const entryFeeRate = baseRate(planEarly, 'entryFeeRate', 1, 'ts')
          || baseRate(hudBase, 'entryFeeRate', 1, 'ts')
          || ((prevSnap && prevSnap.entryFeeRate != null) ? (snapE1 != null ? snapE1 : prevSnap.entryFeeRate) : feeRate);
        // pool's NORMAL fee level at entry (spike-bias guard for DECAY); since-launch
        // %/day when the pool was younger than 24h at entry
        const norm24 = baseRate(planEarly, 'entryFeeRate24h', 24, 'ts')
          || baseRate(hudBase, 'feeRate24h', 24, 'ts')
          || baseRate(prevSnap, 'entryFeeRate24h', 24, 'firstSeen')
          || ((pd && pd.ok && pd.feeRate24h > 0) ? pd.feeRate24h : null);
        if (!hudBase && feeRate > 0) {
          posBaseAll[pool] = { entryFeeRate, feeRate24h: norm24, sigma: (pd && pd.ok) ? pd.sigma : null, ts: Date.now(),
            feeBasis: basisKnown ? FEE_BASIS : undefined };
        }
        let belowCount = (prevSnap && prevSnap.belowCount) || 0;
        // spike-bias guard: decay must be below entry-relative threshold AND the pool's normal
        const feeDataTs = (pd && pd.ok && isFinite(pd.ts)) ? pd.ts : null;
        const distinctFeeSample = positionSignalsReady && feeDataTs != null && (!prevSnap || prevSnap.feeDataTs !== feeDataTs);
        if (distinctFeeSample) {
          if (entryFeeRate > 2 && feeRate < 0.5 * entryFeeRate && (!norm24 || feeRate < norm24)) belowCount++; else belowCount = 0;
        }
        st.mqlLastPos[key] = { pool, name, wallet, pnl: Number(pos.pnlSolPctChange), ts: Date.now(),
          firstSeen: (prevSnap && prevSnap.firstSeen) || Date.now(),
          entryFeeRate, entryFeeRate24h: norm24, belowCount, feeDataTs: feeDataTs != null ? feeDataTs : (prevSnap && prevSnap.feeDataTs),
          feeBasis: basisKnown ? FEE_BASIS : ((prevSnap && prevSnap.feeBasis) || undefined) };
        const pnl = Number(pos.pnlSolPctChange);
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
        const profile = resolvePositionProfile(plan, pos, prevSnap && (prevSnap.profile || prevSnap.accum));
        const isAccum = profile === 'ACCUM' || profile === 'ACCUM_INFERRED';
        st.mqlLastPos[key].profile = profile;
        st.mqlLastPos[key].accum = isAccum;
        if (isAccum) {
          delete cond.HIT_TP; delete cond.NEAR_TP; delete cond.HIT_SL; delete cond.NEAR_SL;
          delete cond.TIGHTEN; delete cond.FREEFALL;  // accum: freefall is the design; scalp nudges don't apply
          const accumDecay = cond.DECAY, accumFlow = cond.FLOW;
          delete cond.DECAY; delete cond.FLOW;
          cond.ACCUM_DATA_WAIT = !positionSignalsReady;
          cond.ACCUM_WAIT_DECAY = false;
          cond.ACCUM_WAIT_FLOW = false;
          cond.ACCUM_EXIT = false;
          if (!positionSignalsReady) {
            msgs.ACCUM_DATA_WAIT = '⏸ BID ASK WAIT: ' + name + ' — current fee/organic-flow data is unavailable. No lifecycle decision is being inferred from missing inputs.';
          } else {
            const accumState = evaluateAccumLifecycle({ decay: accumDecay, flow: accumFlow, soft: false });
            cond.ACCUM_WAIT_DECAY = accumState === 'WAIT' && accumDecay;
            cond.ACCUM_WAIT_FLOW = accumState === 'WAIT' && accumFlow;
            cond.ACCUM_EXIT = accumState === 'EXIT';
          }
          cond.FULLY_FILLED = cond.OOR_DOWN; delete cond.OOR_DOWN;
          msgs.ACCUM_WAIT_DECAY = '⏸ BID ASK WAIT: ' + name + ' — fee engine has decayed. Stop adding; EXIT arms only if organic flow also flips to hard distribution. PnL ' + pnl.toFixed(1) + '%';
          msgs.ACCUM_WAIT_FLOW = '⏸ BID ASK WAIT: ' + name + ' — organic distribution is filling the band. Stop adding; EXIT arms only if the fee engine also dies. PnL ' + pnl.toFixed(1) + '%';
          msgs.ACCUM_EXIT = '🛑 BID ASK EXIT: ' + name + ' — fee decay AND hard organic distribution both fired. The accumulation thesis is broken. PnL ' + pnl.toFixed(1) + '%';
          msgs.FULLY_FILLED = '🪣 FULLY FILLED: ' + name + ' — price fell through the whole accumulation band. You are 100% token now. Decide: hold the bag you built, or cut. PnL ' + pnl.toFixed(1) + '%';
          msgs.OOR_UP = '🟢 POPPED ABOVE BAND: ' + name + ' — price rose above your accumulation range: 100% SOL with fees banked. Re-arm lower if you still want the bag. PnL ' + pnl.toFixed(1) + '%';
          msgs.DECAY = '📉 DYING WHILE YOU ACCUMULATE: ' + name + ' — 1h fee rate ' + feeRate.toFixed(1) + '%/d, ~' + Math.round((1 - feeRate / entryFeeRate) * 100) + '% below entry. Volume is leaving the token you are buying — the one alert that matters on an accumulation. PnL ' + pnl.toFixed(1) + '%';
          msgs.FLOW = '🩸 DISTRIBUTION INTO YOUR BAND: ' + name + ' — organic sellers ' + (ofi1h != null ? ofi1h.toFixed(1) : '?') + ':1 while price ' + (pc1h != null ? pc1h.toFixed(1) : '?') + '%/1h. You are the exit liquidity for the token you are accumulating. PnL ' + pnl.toFixed(1) + '%';
          const pf = positionFill(pos, cur);
          if (pf.fill != null) { poolFill.sum += pf.fill; poolFill.n++; }
          if (pf.method === 'sol-spent') { poolFill.spent += pf.spentY; poolFill.net += pf.netY; } else poolFill.exact = false;
        }
        // ---- EVIL PANDA profile: the dump IS the trade (fees on the way down), so
        // TP/SL/decay/flow/freefall/tighten are all wrong here. Only the strategy's
        // own exit (RSI2>90 + BB upper | first green MACD, same closed candle) plus
        // band-geometry facts fire.
        if (profile === 'PANDA' || profile === 'PANDA_INFERRED') {
          for (const k of ['HIT_TP', 'NEAR_TP', 'HIT_SL', 'NEAR_SL', 'DECAY', 'FLOW', 'FREEFALL', 'TIGHTEN', 'PLAN_STOP']) delete cond[k];
          let pz = null;
          try { pz = await getPanda(pool); } catch (eZ) {}
          const ex = pz && pz.ok && pz.signals ? pz.signals.exit : null;
          const pf = positionFill(pos, cur);
          const gate = globalThis.MQLEvilPanda.pandaExitGate({ exit: ex, timeframe: pz && pz.timeframe,
            fillPct: pf.fill != null ? pf.fill * 100 : null, createdAtSec: Number(pos.createdAt) || null,
            lastClosedTs: pz && pz.signals ? pz.signals.lastClosedTs : null });
          cond.PANDA_EXIT = gate.state === 'EXIT';
          msgs.PANDA_EXIT = '🐼 PANDA EXIT: ' + name + ' — ' + (ex && ex.legs ? ex.legs.join(' | ') : '') + ' on the ' + (pz && pz.timeframe) + ' close. First bounce is here: close 100% → SOL. Don\'t wait for higher. PnL ' + pnl.toFixed(1) + '%';
          msgs.OOR_DOWN = '🐼 BELOW PANDA FLOOR: ' + name + ' — price fell through the whole -86..-94% band. 100% token, no more fees. Panda rule: admit it and cut if the thesis is dead. PnL ' + pnl.toFixed(1) + '%';
          msgs.OOR_UP = '🐼 ABOVE PANDA BAND: ' + name + ' — price back above your top, band is 100% SOL + fees. Nothing left to sell into; close to bank it. PnL ' + pnl.toFixed(1) + '%';
          st.mqlLastPos[key].panda = true;
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
        const fp = (poolFill.exact && poolFill.net > 0)
          ? (poolFill.spent / poolFill.net) * 100 : (poolFill.sum / poolFill.n) * 100;
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
        let entryOrigin = 'untracked', entryCls = null, entryEdge = null, entrySigma = null, entrySigmaSource = null, entryEdgeBasis = null;
        try {
          const planC = plans[rec.pool] || null;
          const ovrsC = ovrAll.filter((o) => o.pool === rec.pool && Date.now() - (o.ts || 0) < 7 * 86400e3);
          const ovrC = ovrsC.length ? ovrsC[ovrsC.length - 1] : null;
          if (ovrC && (!planC || (ovrC.ts || 0) >= (planC.ts || 0))) {
            entryOrigin = 'override'; entryCls = ovrC.cls || null;
            entryEdge = (ovrC.edge != null) ? ovrC.edge : null;
            entrySigma = (ovrC.sigma != null) ? ovrC.sigma : null;
            entryEdgeBasis = ovrC.edgeBasis || null;
          } else if (planC) {
            entryOrigin = 'signal'; entryCls = planC.cls || null;
            entryEdge = (planC.entryEdge != null) ? planC.entryEdge : null;
            entrySigma = (planC.entrySigma != null) ? planC.entrySigma : null;
            entrySigmaSource = planC.entrySigmaSource || null;
            entryEdgeBasis = planC.entryEdgeBasis || null;   // null = pre-v0.7.13 edge (read ~1.8x high)
          }
        } catch (e) {}
        logArr.push({ pool: rec.pool, name: rec.name, wallet: rec.wallet || null, positionAddress: posAddr, ownerAddress,
          evSigs, evTokenMint, evWindow,
          settled: false, lastSeenPnlPct: rec.pnl,
          realizedPnlPct, realizedPnlUsd, feesUsd,
          entryOrigin, entryCls, entryEdge, entrySigma, entrySigmaSource, entryEdgeBasis,
          entryFeeRateAtOpen: (rec.entryFeeRate != null ? Math.round(rec.entryFeeRate * 100) / 100 : null),
          openedFirstSeen: rec.firstSeen, closedDetected: Date.now(),
          holdMinutes: Math.round((Date.now() - rec.firstSeen) / 60e3) });
        delete lp[k];
        if (bl.mqlPosBaseline && bl.mqlPosBaseline[rec.pool]) delete bl.mqlPosBaseline[rec.pool];
        // PLAN CONSUMED ON CLOSE: a plan that predates the trade that just closed
        // belonged to THAT trade - it must not survive to bind a later position
        // (caught live: a BASING plan outlived its +1.9%% win and poisoned the
        // next position's baseline 37 minutes later).
        if (plans[rec.pool] && (plans[rec.pool].ts || 0) <= (rec.firstSeen || Date.now()) + 600e3) {
          delete plans[rec.pool];
          await chrome.storage.local.set({ mqlEntryPlan: plans });
        }
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

// ===========================================================================
// EVIL PANDA module (see evil-panda.js for the strategy + math)
// Data: GMGN openapi token-level candles (follow the token across venues, so a
// young token has candles from launch, not just from when its Meteora pool was
// made) + GMGN token info/security for the coin-selection filters. Fallback when
// no GMGN key: Meteora pool-level 5m candles (signals only, filters INCOMPLETE).
// GMGN free tier rate-limits hard (429 after ~3 quick calls), so: one serialized
// queue with spacing, honor reset_at, cache filters 3 min, and only re-pull
// candles once a new bucket has closed.
// ===========================================================================
const GMGN = 'https://openapi.gmgn.ai';
const GMGN_GAP_MS = 1500;
const PANDA_INFO_TTL_MS = 3 * 60 * 1000;
const PANDA_KLINE_RETRY_MS = 20 * 1000;
const PANDA_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let gmgnChain = Promise.resolve();
let gmgnLastAt = 0;
let gmgnBlockedUntil = 0;
const pandaInfoCache = new Map();   // mint -> { ts, info, security }
const pandaKlineCache = new Map();  // mint:tf -> { fetchedAt, candles, source }
const pandaShapes = {};             // pool -> { name, wallet, minP, maxP, ts } (filled by watchPositions)

function getPandaSettings() {
  return chrome.storage.sync.get({ gmgnApiKey: '', pandaTimeframe: '5m', pandaExitAlerts: true, webhookUrl: '' })
    .then((s) => ({ gmgnApiKey: String(s.gmgnApiKey || '').trim(),
      pandaTimeframe: globalThis.MQLEvilPanda.TIMEFRAMES[s.pandaTimeframe] ? s.pandaTimeframe : '5m',
      pandaExitAlerts: s.pandaExitAlerts !== false, webhookUrl: s.webhookUrl || '' }))
    .catch(() => ({ gmgnApiKey: '', pandaTimeframe: '5m', pandaExitAlerts: true, webhookUrl: '' }));
}

function gmgnGet(path, params, apiKey) {
  const run = async () => {
    if (!apiKey) return { ok: false, error: 'no GMGN key' };
    if (Date.now() < gmgnBlockedUntil) return { ok: false, rateLimited: true, error: 'GMGN rate limited for ' + Math.ceil((gmgnBlockedUntil - Date.now()) / 1000) + 's' };
    const wait = gmgnLastAt + GMGN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gmgnLastAt = Date.now();
    const q = new URLSearchParams(Object.assign({}, params, {
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) }));
    const r = await fetchJson(GMGN + path + '?' + q.toString(), { 'X-APIKEY': apiKey });
    const j = r && r.json;
    if (j && (j.code === 429 || j.error === 'RATE_LIMIT_EXCEEDED' || r.status === 429)) {
      gmgnBlockedUntil = j && j.reset_at ? Number(j.reset_at) * 1000 + 1000 : Date.now() + 60e3;
      return { ok: false, rateLimited: true, error: 'GMGN rate limited' };
    }
    if (!r.ok || !j || j.code !== 0) return { ok: false, error: 'GMGN ' + path + ' ' + (r.status || '') + ' ' + ((j && (j.message || j.error)) || (r.error || '')) };
    return { ok: true, data: j.data };
  };
  const p = gmgnChain.then(run, run);
  gmgnChain = p.catch(() => {});
  return p;
}

async function pandaCoinData(mint, apiKey) {
  const now = Date.now();
  const hit = pandaInfoCache.get(mint);
  if (hit && now - hit.ts < PANDA_INFO_TTL_MS) return Object.assign({ fresh: true }, hit);
  if (!apiKey) return hit ? Object.assign({ fresh: false }, hit) : null;
  const info = await gmgnGet('/v1/token/info', { chain: 'sol', address: mint }, apiKey);
  const sec = info.ok ? await gmgnGet('/v1/token/security', { chain: 'sol', address: mint }, apiKey) : { ok: false };
  if (info.ok) {
    const rec = { ts: now, info: info.data, security: sec.ok ? sec.data : (hit && hit.security) || null };
    pandaInfoCache.set(mint, rec);
    return Object.assign({ fresh: true }, rec);
  }
  return hit ? Object.assign({ fresh: false, error: info.error }, hit) : { error: info.error };
}

async function pandaCandles(mint, pool, tf, apiKey) {
  const P = globalThis.MQLEvilPanda;
  const tfSec = P.TIMEFRAMES[tf];
  const now = Date.now();
  const key = mint + ':' + tf;
  const lastClosedStart = Math.floor(now / 1000 / tfSec) * tfSec - tfSec;
  const hit = pandaKlineCache.get(key);
  if (hit && (hit.lastTs >= lastClosedStart || now - hit.fetchedAt < PANDA_KLINE_RETRY_MS)) return hit;
  let res = null;
  if (apiKey) {
    const toS = Math.floor(now / 1000);
    const r = await gmgnGet('/v1/market/token_kline', { chain: 'sol', address: mint, resolution: tf,
      from: String((toS - 101 * tfSec) * 1000), to: String(toS * 1000) }, apiKey);
    if (r.ok) {
      const c = P.normalizeCandles(r.data, tfSec, now);
      res = { fetchedAt: now, candles: c, source: 'gmgn-token', lastTs: c.length ? c[c.length - 1].t : 0 };
    } else if (hit) {
      return Object.assign({}, hit, { stale: true, error: r.error });
    } else {
      res = { error: r.error };
    }
  }
  // fallback: Meteora pool-level 5m (no 1m on datapi; <=8h per request). Pool-level
  // only starts when the Meteora pool was created, which can be after token launch.
  if ((!res || res.error) && tf === '5m') {
    const nowS = Math.floor(now / 1000);
    const r = await fetchJson(DATAPI + '/pools/' + encodeURIComponent(pool) + '/ohlcv?timeframe=5m&start_time=' + (nowS - 8 * 3600) + '&end_time=' + nowS);
    if (r.ok) {
      const c = P.normalizeCandles(r.json, tfSec, now);
      res = { fetchedAt: now, candles: c, source: 'meteora-pool', lastTs: c.length ? c[c.length - 1].t : 0, gmgnError: res && res.error };
    }
  }
  if (res && !res.error) pandaKlineCache.set(key, res);
  return res || { error: 'no candle source' };
}

async function getPanda(pool, opts = {}) {
  const P = globalThis.MQLEvilPanda;
  const s = await getPandaSettings();
  const tf = P.TIMEFRAMES[opts.timeframe] ? opts.timeframe : s.pandaTimeframe;
  const pd = await getPoolData(pool, opts.seed || null, { deferCandle: true });
  if (!pd || !pd.ok) return { ok: false, error: (pd && pd.error) || 'pool data unavailable' };
  const meta = pd.pool || {};
  const mint = meta.tokenX && meta.tokenX.address;
  if (!mint) return { ok: false, error: 'token mint unknown' };
  const coin = await pandaCoinData(mint, s.gmgnApiKey);
  const kl = await pandaCandles(mint, pool, tf, s.gmgnApiKey);
  const screen = P.screenCoin({ info: coin && coin.info, security: coin && coin.security,
    pool: { supportedSolPair: meta.supportedSolPair, binStep: meta.binStep } });
  const signals = kl && kl.candles ? P.evaluateSignals(kl.candles, { timeframe: tf }) : null;
  const price = kl && kl.candles && kl.candles.length ? kl.candles[kl.candles.length - 1].c : null;
  return {
    ok: true, pool, mint, name: meta.name, timeframe: tf, hasKey: !!s.gmgnApiKey,
    screen, signals, candleSource: kl && kl.source, candleError: kl && (kl.error || kl.gmgnError) || null,
    candlesStale: !!(kl && kl.stale), coinError: coin && coin.error || null, coinStale: !!(coin && coin.fresh === false),
    recipe: P.rangeRecipe(meta.binStep, meta.currentPrice || price),
    lateHour: P.lateHour(Date.now()), watched: !!pandaShapes[pool],
    ts: Date.now(),
  };
}

async function pandaWatch() {
  try {
    const P = globalThis.MQLEvilPanda;
    const s = await getPandaSettings();
    if (!s.pandaExitAlerts) return;
    const st = await chrome.storage.local.get({ mqlPandaPins: {}, mqlPandaAlerted: {} });
    const pins = st.mqlPandaPins || {}, alerted = st.mqlPandaAlerted || {};
    const now = Date.now();
    const targets = {};
    // positions get PANDA_EXIT through watchPositions; here only pinned pools that
    // don't hold an open Panda-shaped position yet (ENTRY alerts)
    for (const [pool, v] of Object.entries(pins)) {
      const shp = pandaShapes[pool];
      if (shp && now - shp.ts < 3 * 60e3) continue;
      targets[pool] = { name: v.name, why: 'pin' };
    }
    let dirty = false;
    for (const [pool, t] of Object.entries(targets).slice(0, 6)) {
      const d = await getPanda(pool);
      if (!d.ok || !d.signals) continue;
      const sig = d.signals;
      const isPos = t.why === 'position';
      // positions: exit alerts. pins (no position yet): entry alerts.
      const fire = isPos ? sig.exit.state === 'EXIT' : sig.entry.state === 'ENTRY' && d.screen.state !== 'FAIL';
      if (!fire) continue;
      const kind = isPos ? 'EXIT' : 'ENTRY';
      const k = pool + ':' + kind;
      const prev = alerted[k];
      if (prev && (prev.candle === sig.lastClosedTs || now - prev.at < PANDA_ALERT_COOLDOWN_MS)) continue;
      alerted[k] = { candle: sig.lastClosedTs, at: now }; dirty = true;
      const name = d.name || t.name || pool.slice(0, 8);
      const body = isPos
        ? 'EXIT signal (' + d.timeframe + '): ' + sig.exit.legs.join(' | ') + (sig.exit.partial ? ' · ' + sig.exit.partial : '')
        : 'ENTRY: closed above Supertrend (' + d.timeframe + ') · filters ' + d.screen.state + ' · one-sided SOL -' + d.recipe.shallow.depthPct + '%..-' + d.recipe.deep.depthPct + '%';
      try { chrome.notifications.create('mqlpanda-' + now + '-' + pool.slice(0, 4), { type: 'basic', iconUrl: 'icon128.png', title: '🐼 Panda ' + kind + ' · ' + name, message: body, priority: 2 }); } catch (e) {}
      if (s.webhookUrl) await postDiscord(s.webhookUrl, '**Meteora Lens** · 🐼 Evil Panda **' + kind + '** · ' + name + '\n' + body + '\nhttps://www.meteora.ag/dlmm/' + pool);
    }
    for (const k of Object.keys(alerted)) if (now - alerted[k].at > 24 * 3600e3) { delete alerted[k]; dirty = true; }
    if (dirty) await chrome.storage.local.set({ mqlPandaAlerted: alerted });
  } catch (e) {}
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
  for (const it of (r.alertItems || r.items)) {
    if (it.kind !== 'FULL' && it.kind !== 'BID_ASK' && it.kind !== 'PANDA') continue;
    if (it.kind === 'PANDA') {
      const pk = 'PANDA:' + (it.mint || it.address);
      if (alerted[pk] && now - alerted[pk] < 2 * 3600e3) continue;
      const pz = it.panda || {};
      await postDiscord(cfg.webhookUrl, '🐼 **Meteora Lens — EVIL PANDA ENTRY** · ' + it.name + ' ' + (it.binStep ? it.binStep + 'bps' : '') + '\nFilters pass · closed above Supertrend (' + pz.tf + ') · token ' + (pz.ageMin != null ? Math.round(pz.ageMin / 60 * 10) / 10 + 'h' : '?') + ' old\nOne-sided SOL, -86% .. -94%, Spot or Bid-Ask. Exit on RSI2>90 + BB upper / first green MACD.\nhttps://www.meteora.ag/dlmm/' + it.address);
      try { chrome.notifications.create('mqlpz-' + now + '-' + it.address.slice(0,4), { type: 'basic', iconUrl: 'icon128.png', title: '🐼 PANDA ENTRY', message: it.name + ' · one-sided SOL -86..-94%', priority: 2 }); } catch (e) {}
      alerted[pk] = now;
      continue;
    }
    const alertKey = it.kind === 'BID_ASK'
      ? 'BID_ASK:' + (it.mint || it.address)
      : it.address + ':' + it.kind;
    if (alerted[alertKey] && now - alerted[alertKey] < 2 * 3600e3) continue; // 2h cooldown per pool/signal
    if (it.kind === 'BID_ASK') {
      const ba = it.bidAsk || {};
      if (!radarBidAskFresh(it, Date.now()) || !ba.ready || !ba.candleQualification
          || ba.candleQualification.ready !== true || !ba.allocation || !ba.depthPct) continue;
      const msgBA = '🪣 **Meteora Lens — BID ASK READY** · ' + it.name + '\nManual Bid-Ask + Spot accumulation · range 0% to -' + ba.depthPct + '% · allocation ' + ba.allocation.bidAskPct + '/' + ba.allocation.spotPct + '%. Choose your own SOL amount and approve both legs in your wallet. Heuristic priors; position costs are not modeled.\nhttps://www.meteora.ag/dlmm/' + it.address;
      // The Discord request is awaited. Recheck immediately before and after
      // it so a boundary crossing cannot create a fresh-looking UI alert.
      if (!radarBidAskFresh(it, Date.now())) continue;
      await postDiscord(cfg.webhookUrl, msgBA);
      const sentAt = Date.now();
      if (radarBidAskFresh(it, sentAt)) {
        try { chrome.notifications.create('mqlba-' + sentAt + '-' + it.address.slice(0,4), { type: 'basic', iconUrl: 'icon128.png', title: 'BID ASK READY', message: it.name + ' · manual Bid-Ask + Spot · 0% to -' + ba.depthPct + '%', priority: 2 }); } catch (e) {}
      }
      alerted[alertKey] = sentAt;
      continue;
    }
    const rec = it.rec || {};
    const recipe = (rec.steps && rec.steps.length) ? rec.steps.slice(0, 2).join(' · ') : (rec.headline || '');
    const bs = it.binStep ? it.binStep + 'bps ' : '';
    const msg = '🔥 **Meteora Lens — signal** · ' + it.name + ' ' + bs + '· ' + it.cls + ' · edge ' + (Math.round(it.edge * 100) / 100) + '\n' + recipe + '\nhttps://www.meteora.ag/dlmm/' + it.address;
    await postDiscord(cfg.webhookUrl, msg);
    try { chrome.notifications.create('mqlr-' + now + '-' + it.address.slice(0,4), { type: 'basic', iconUrl: 'icon128.png', title: '🔥 ' + it.cls + ' signal', message: it.name + ' · edge ' + (Math.round(it.edge * 100) / 100), priority: 2 }); } catch (e) {}
    alerted[alertKey] = now;
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
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mql-watch') { watchPositions().catch(() => {}).then(() => pandaWatch()); radarAlertScan(); healthCheck(); reconcileJournal(); walletTruthPass(); dailyRecon(); } });
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
  if (msg.type === 'getTradeMarks') {
    (async () => {
      try {
        if (!msg.pool) { sendResponse({ ok: false, error: 'missing pool' }); return; }
        const cfg = await chrome.storage.sync.get({ walletAddress: '', heliusApiKey: '' });
        const jr = await chrome.storage.local.get({ mqlTradeLog: [] });
        // candidate on-chain wallets: configured + any owner discovered by the journal
        const wallets = new Set(parseWallets(cfg.walletAddress));
        for (const t of jr.mqlTradeLog) if (t.ownerAddress) wallets.add(t.ownerAddress);
        const pd = await fetchJson(DATAPI + '/pools/' + msg.pool);
        const tokenMint = pd.ok ? pick(pd.json, 'token_x.address', 'tokenX.address', 'mint_x') : null;
        // cache: long TTL, but a cheap staleness probe on every hit - if a new
        // swap of THIS token or a position change happened since the build,
        // fall through to a full rebuild. Fresh trades appear on next refresh.
        const sc9 = await sessionCacheGet('mqlc:marks:' + msg.pool, 60 * 60e3);
        if (sc9 && sc9.data && sc9.data.ok) {
          let stale = false;
          const builtAt = Math.floor((sc9.ts || 0) / 1000);
          const w0 = [...wallets][0];
          try {
            if (cfg.heliusApiKey && tokenMint && w0) {
              const pr = await fetchJson('https://api.helius.xyz/v0/addresses/' + w0 + '/transactions?api-key=' + cfg.heliusApiKey + '&type=SWAP&limit=10');
              for (const tx of (Array.isArray(pr.json) ? pr.json : [])) {
                if (tx.timestamp > builtAt && (tx.tokenTransfers || []).some((tt) => tt.mint === tokenMint)) { stale = true; break; }
              }
            }
            if (!stale && w0) {
              const op = await fetchJson(DATAPI + '/positions/' + msg.pool + '/pnl?user=' + w0 + '&status=open&page_size=20');
              const posKey = ((op.ok && op.json.positions) || []).map((p) => p.positionAddress).sort().join(',');
              if (posKey !== (sc9.data.posKey || '')) stale = true;
            }
          } catch (e) {}
          if (!stale) { sendResponse(sc9.data); return; }
        }
        const marks = [];
        const posSigs = new Set();
        const openPosKey = [];
        // DLMM entries/exits: every position (open+closed) in this pool per wallet
        for (const w of [...wallets].slice(0, 3)) {
          for (const status of ['open', 'closed']) {
            try {
              const r = await fetchJson(DATAPI + '/positions/' + msg.pool + '/pnl?user=' + w + '&status=' + status + '&page_size=20');
              for (const p of ((r.ok && r.json.positions) || [])) {
                if (status === 'open') openPosKey.push(p.positionAddress);
                try {
                  const hev = await fetchJson(DATAPI + '/positions/' + p.positionAddress + '/historical?page_size=100');
                  for (const ev of ((hev.ok && hev.json.events) || [])) {
                    posSigs.add(ev.signature);
                    const t = Math.floor(Number(ev.blockTime) / 1000);
                    const usd = Number(ev.totalUsd || 0);
                    if (ev.eventType === 'add')    marks.push({ t, side: 'entry', usd, text: 'LP+ $' + usd.toFixed(0) });
                    if (ev.eventType === 'remove') marks.push({ t, side: 'exit',  usd, text: 'LP\u2212 $' + usd.toFixed(0) });
                  }
                } catch (e) {}
              }
            } catch (e) {}
          }
        }
        // spot buys/sells of the token via Helius ENHANCED transactions.
        // (v1 wallet/transfers silently misses swap/DLMM token legs - confirmed
        // live 2026-08-08: a Jupiter buy and a position deposit both absent.)
        if (cfg.heliusApiKey && tokenMint) {
          for (const w of [...wallets].slice(0, 3)) {
            try {
              let before = null;
              for (let pg = 0; pg < 3; pg++) {
                const r = await fetchJson('https://api.helius.xyz/v0/addresses/' + w + '/transactions?api-key=' + cfg.heliusApiKey + '&type=SWAP&limit=100' + (before ? '&before=' + before : ''));
                if (!r.ok || !Array.isArray(r.json) || !r.json.length) break;
                for (const tx of r.json) {
                  if (posSigs.has(tx.signature)) continue;
                  // net flow of the token for this wallet in this tx
                  let net = 0;
                  for (const tt of (tx.tokenTransfers || [])) {
                    if (tt.mint !== tokenMint) continue;
                    if (tt.toUserAccount === w) net += Number(tt.tokenAmount) || 0;
                    if (tt.fromUserAccount === w) net -= Number(tt.tokenAmount) || 0;
                  }
                  if (!net) continue;
                  const amt = Math.abs(net);
                  marks.push({ t: tx.timestamp, side: net > 0 ? 'buy' : 'sell', amt,
                    text: (net > 0 ? 'B ' : 'S ') + amt.toLocaleString(undefined, { maximumFractionDigits: 0 }) });
                }
                before = r.json[r.json.length - 1].signature;
                if (r.json.length < 100) break;
              }
            } catch (e) {}
          }
        }
        // collapse same-second duplicates (multi-leg txs) and price every mark in SOL
        marks.sort((a, b) => a.t - b.t);
        const dedup = [];
        for (const m of marks) {
          const prev = dedup[dedup.length - 1];
          if (prev && prev.side === m.side && Math.abs(prev.t - m.t) <= 2) { prev.usd = (prev.usd || 0) + (m.usd || 0); continue; }
          dedup.push(m);
        }
        // nearest-candle SOL price for vertical placement (chart calibrates units itself)
        const nowS = Math.floor(Date.now() / 1000);
        const span = dedup.length ? Math.max(nowS - dedup[0].t + 3600, 6 * 3600) : 24 * 3600;
        const oh = await fetchJson(DATAPI + '/pools/' + msg.pool + '/ohlcv?timeframe=30m&start_time=' + (nowS - Math.min(span, 7 * 86400)) + '&end_time=' + nowS);
        const candles = (oh.ok && oh.json.data) || [];
        const priceAt = (t) => {
          let best = null, bd = Infinity;
          for (const c of candles) { const d = Math.abs(c.timestamp - t); if (d < bd) { bd = d; best = c; } }
          return best ? { close: Number(best.close), high: Number(best.high || best.close) } : null;
        };
        const out = { ok: true, lastSol: candles.length ? Number(candles[candles.length - 1].close) : null,
          posKey: openPosKey.sort().join(','),
          marks: dedup.map((m) => { const c = priceAt(m.t); return { t: m.t, side: m.side, text: m.text, usd: m.usd, pSol: c && c.close, pHigh: c && c.high }; }).filter((m) => m.pSol > 0) };
        sessionCacheSet('mqlc:marks:' + msg.pool, out);
        sendResponse(out);
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
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
        const planState = await chrome.storage.local.get({ mqlEntryPlan: {} });
        const entryPlan = planState.mqlEntryPlan && planState.mqlEntryPlan[msg.pool];
        sendResponse(summarizePositions(merged, entryPlan));
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.type === 'getPanda') {
    (async () => {
      try {
        if (!msg.pool) { sendResponse({ ok: false, error: 'missing pool address' }); return; }
        sendResponse(await getPanda(String(msg.pool), { timeframe: msg.timeframe }));
      } catch (e) { sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) }); }
    })();
    return true;
  }
  if (msg.type === 'pandaPin') {
    (async () => {
      try {
        const st = await chrome.storage.local.get({ mqlPandaPins: {} });
        const pins = st.mqlPandaPins || {};
        if (msg.on) pins[String(msg.pool)] = { name: msg.name || null, ts: Date.now() }; else delete pins[String(msg.pool)];
        await chrome.storage.local.set({ mqlPandaPins: pins });
        sendResponse({ ok: true, pinned: !!msg.on });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
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
