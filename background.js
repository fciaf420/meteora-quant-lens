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
const poolCache = new Map();

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
  return fetchJson(DATAPI + '/pools/' + encodeURIComponent(address) + '/ohlcv');
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

// sigma: age-aware realized vol %/day
function computeSigma(ageH, pc5, pc1, pc24) {
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
  const tp = Math.round(clamp(W / 4 + (s.feeRate1h || 0) * 0.5, 8, 25));
  // SL just inside the structural band-break value (~ -0.75W when fully exited below).
  const sl = Math.round(clamp(0.75 * W + 2, 8, 20));
  // hard warnings first
  if (s.path === 'FREEFALL') r.watch.push('🔪 Falling knife — price is actively dumping. Do NOTHING until the 5m flattens (then it may become a BASING entry).');
  if (!s.mintAuthorityDisabled) r.watch.push('⚠️ Mint authority is LIVE — team can print supply. Scalp only, never park capital.');
  if (s.ofi1h != null && s.ofi1h > 3) r.watch.push('⚠️ Organic wallets selling ' + s.ofi1h.toFixed(1) + ':1 — entering now = being their exit liquidity.');

  if (s.verdict && s.verdict.class === 'IGNITION') {
    r.params = (s.ofi1h > 2) ? { strategy: 'Spot', minPct: -W, maxPct: 0, mode: 'single' } : { strategy: 'Spot', minPct: -W, maxPct: W, mode: 'two' };
    r.action = 'SCALP'; r.headline = 'Event-driven scalp — fees overpay for risk AND a catalyst is live.';
    r.steps = [
      (s.ofi1h > 2 ? 'Single-sided SOL below price (flow is sell-skewed)' : 'Two-sided Spot centered on price') + ', width ±' + W + '%',
      'Brackets: TP +' + tp + '% / SL -' + sl + '% (σ-scaled)',
      'Exit early if the 1h fee rate halves or surge decays below ~1.05x',
      'Size small — this is a fee harvest, not a conviction bet'
    ];
  } else if (s.verdict && s.verdict.class === 'BASING') {
    r.params = { strategy: 'Spot', minPct: -18, maxPct: 18, mode: 'two' };
    r.action = 'REVERSION'; r.headline = 'Crash is over, base is forming, real buyers absorbing — straddle the base.';
    r.steps = [
      'Two-sided Spot centered, width ±18%',
      'Stop: price below ' + (s.dayLow ? (s.dayLow * 0.98).toExponential(3) : 'the base low') + ' (thesis dead)',
      'Brackets: TP +20% / SL -15%',
      'Exit if the fee rate halves from here'
    ];
  } else if (s.verdict && s.verdict.class === 'CARRY') {
    r.params = { strategy: 'Spot', minPct: -35, maxPct: 35, mode: 'two' };
    r.action = 'CARRY'; r.headline = 'Calm, mature, organic-buying pool that overpays for its risk — park and ride.';
    r.steps = [
      'Two-sided Spot, WIDE: ±35% (durability over density)',
      'Brackets: TP +15% / SL -12%',
      'Exit when the fee rate falls below 50% of today\'s ' + (s.feeRate1h || 0).toFixed(1) + '%/day',
      'No re-centering — carries ride'
    ];
  } else if (s.verdict && s.verdict.class === 'SQUEEZE') {
    const Wq = s.squeezeW || 20;
    r.params = { strategy: 'Bid Ask', minPct: -Wq, maxPct: Wq, mode: 'two' };
    r.action = 'SQUEEZE'; r.headline = 'Vol coiled to ' + (s.sigmaRatio ? Math.round(s.sigmaRatio*100) + '%' : '<60%') + ' of its norm \u2014 bet on range expansion, either direction.';
    r.steps = [
      'Two-sided BID-ASK, width \u00b1' + Wq + '% (edges loaded, center thin \u2014 pays on the breakout)',
      'Brackets: TP +' + Math.round(Wq/3 + (s.feeRate1h||0)*0.5) + '% / SL -' + Math.round(0.7*Wq+2) + '%',
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
  try {
    const ohResp = await fetchOhlcvRaw(address);
    if (ohResp.ok) {
      const c = latestCandle(ohResp.json);
      if (c) {
        const high = num(pick(c, 'high', 'h', 'High'), NaN);
        const low = num(pick(c, 'low', 'l', 'Low'), NaN);
        const close = num(pick(c, 'close', 'c', 'Close'), NaN);
        if (isFinite(high) && isFinite(close) && high > 0) {
          ddHigh = (high - close) / high * 100;
        }
        if (isFinite(high) && isFinite(low) && isFinite(close)) {
          const denom = Math.max(high - low, 1e-9);
          rangePos = (close - low) / denom;
        }
        if (isFinite(low)) dayLow = low;
        if (isFinite(close)) candleClose = close;
      }
    }
  } catch (e) { /* keep nulls */ }

  // --- Jupiter (optional; graceful degradation) ---
  const jupNullPayload = {
    sigma: null, edge: null, ofi1h: null, ofi6h: null, organicScore: null,
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

  const sigma = computeSigma(ageH, pc5, pc1, pc24);
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
  let sigmaTrail = null, sigmaRatio = null;
  try {
    const hs = await chrome.storage.local.get({ mqlHistory: {} });
    const H = hs.mqlHistory || {};
    const arr = H[address] || [];
    const last = arr[arr.length - 1];
    if (!last || Date.now() - last.ts > 50e3) {
      arr.push({ ts: Date.now(), sigma: Math.round(sigma * 10) / 10, feeRate: Math.round(feeRate1h * 100) / 100 });
      H[address] = arr.slice(-60);
      // prune stale pools
      for (const k of Object.keys(H)) { const a = H[k]; if (!a.length || Date.now() - a[a.length-1].ts > 24*3600e3) delete H[k]; }
      chrome.storage.local.set({ mqlHistory: H });
    }
    const prior = arr.slice(0, -1).map((x) => x.sigma).filter((x) => x > 0);
    const spanMin = arr.length >= 2 ? (arr[arr.length-1].ts - arr[0].ts) / 60e3 : 0;
    if (prior.length >= 6 && spanMin >= 45) {
      const srt = [...prior].sort((a, b) => a - b);
      sigmaTrail = srt[Math.floor(srt.length / 2)];
      sigmaRatio = sigma / Math.max(sigmaTrail, 0.001);
    }
  } catch (e) {}
  let squeezeW = null;
  if (verdict.class === 'NONE' && sigmaRatio != null && sigmaRatio <= 0.6 && path === 'CHOP'
      && (rangePos == null || (rangePos >= 0.35 && rangePos <= 0.65))
      && ofi1h != null && ofi1h >= 0.5 && ofi1h <= 2 && organicScore >= 60 && ageH >= 24
      && tvl >= 80000 && feeRate1h >= 1) {
    squeezeW = Math.min(30, Math.max(15, Math.round(sigmaTrail / 4)));
    verdict.class = 'SQUEEZE';
    verdict.reasons = ['\u2713 \u03c3 compressed to ' + Math.round(sigmaRatio * 100) + '% of trailing median (' + Math.round(sigmaTrail) + ' \u2192 ' + Math.round(sigma) + ')',
      '\u2713 CHOP mid-range, balanced organic flow', '\u2713 data-gated: ' + '6+ readings over 45+ min'];
  }
  const recommendation = buildRecommendation({ verdict, squeezeW, sigmaTrail, sigmaRatio, edge, surge, accel, sigma, ofi1h, ofi6h, organicScore, feeRate1h, path, ddHigh, dayLow, currentPrice, mintAuthorityDisabled, freezeAuthorityDisabled, ageH, tvl });

  const data = {
    ok: true,
    pool: { name, address, tvl, binStep, baseFeePct, currentPrice },
    feeRate1h, feeRate24h, trend, surge, accel,
    sigma, edge, ofi1h, ofi6h, organicScore,
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
  const settings = await getSettings();
  const data = await buildPoolData(address, settings);
  if (data && data.ok) {
    poolCache.set(address, { ts: Date.now(), data });
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
  const boardResp = await fetchJson(DATAPI + '/pools?sort_by=volume_24h:desc&page_size=100');
  if (!boardResp.ok) return { ok: false, error: 'board fetch failed' };
  const arr = (boardResp.json.data || boardResp.json.pools || boardResp.json || []).filter(
    (p) => (p.tvl || 0) >= 60000 && ((p.volume && p.volume['24h']) || 0) >= 150000
  );
  arr.forEach((p) => { p._fr = ((p.fee_tvl_ratio && p.fee_tvl_ratio['1h']) || 0) * 24; });
  arr.sort((a, b) => b._fr - a._fr);
  const items = [];
  for (const p of arr.slice(0, 8)) {
    try {
      const d = await getPoolData(p.address);
      if (!d || !d.ok) continue;
      if (d.verdict && d.verdict.class !== 'NONE') {
        items.push({ address: p.address, name: d.pool.name, binStep: d.pool.binStep, cls: d.verdict.class, edge: d.edge, feeRate1h: d.feeRate1h, kind: 'FULL' });
      } else if (d.path !== 'FREEFALL') {
        const fails = [];
        if (d.edge < 1.0) fails.push('edge ' + (Math.round(d.edge * 100) / 100));
        if (d.surge < 1.25) fails.push('surge ' + (Math.round(d.surge * 100) / 100));
        if (d.accel < 1.2) fails.push('accel ' + (Math.round(d.accel * 100) / 100));
        if (fails.length > 0 && fails.length <= 2) {
          items.push({ address: p.address, name: d.pool.name, binStep: d.pool.binStep, cls: 'NEAR', edge: d.edge, feeRate1h: d.feeRate1h, kind: 'NEAR', fails });
        }
      }
    } catch (e) {}
  }
  items.sort((a, b) => (a.kind === b.kind ? (b.edge || 0) - (a.edge || 0) : a.kind === 'FULL' ? -1 : 1));
  const out = { ok: true, ts: Date.now(), items: items.slice(0, 6) };
  radarCache = { ts: Date.now(), data: out };
  return out;
}


// ---- REMOTE ALERTS: wallet watcher -> Discord webhook (works without any Meteora tab open) ----
async function postDiscord(url, content) {
  try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 1900) }) }); } catch (e) {}
}
function clampB(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
async function watchPositions() {
  const cfg = await chrome.storage.sync.get({ webhookUrl: '', walletAddress: '' });
  if (!cfg.webhookUrl || !cfg.walletAddress) return;
  const st = await chrome.storage.local.get({ mqlAlertStates: {} });
  const states = st.mqlAlertStates || {};
  let port;
  try {
    const r = await fetchJson(DATAPI + '/portfolio/open?user=' + cfg.walletAddress.trim());
    if (!r.ok) return;
    port = r.json;
  } catch (e) { return; }
  const pools = (port.pools || port.data || []).map(x => x.poolAddress || x.pool_address || x.address).filter(Boolean);
  const seen = {};
  for (const pool of pools.slice(0, 6)) {
    try {
      const pr = await fetchJson(DATAPI + '/positions/' + pool + '/pnl?user=' + cfg.walletAddress.trim() + '&status=open');
      if (!pr.ok || !pr.json.positions) continue;
      const pd = await getPoolData(pool);
      const feeRate = (pd && pd.ok) ? pd.feeRate1h : 0;
      const name = (pd && pd.ok) ? pd.pool.name : pool.slice(0, 8);
      for (const pos of pr.json.positions) {
        const key = pool + ':' + (pos.positionAddress || '');
        seen[key] = true;
        // rolling snapshot so a close (from ANY device) can be journaled with last-seen PnL
        if (!st.mqlLastPos) st.mqlLastPos = {};
        st.mqlLastPos[key] = { pool, name, pnl: Number(pos.pnlSolPctChange), ts: Date.now(),
          firstSeen: (st.mqlLastPos[key] && st.mqlLastPos[key].firstSeen) || Date.now() };
        const pnl = Number(pos.pnlSolPctChange);
        const minP = Number(pos.minPrice), maxP = Number(pos.maxPrice), cur = Number(pos.poolActivePrice);
        const mid = (minP + maxP) / 2;
        const W = mid > 0 ? ((maxP - minP) / 2 / mid) * 100 : 20;
        const tp = Math.round(clampB(W / 4 + feeRate * 0.5, 8, 25));
        const sl = Math.round(clampB(0.75 * W + 2, 8, 20));
        const cond = {};
        cond.OOR_DOWN = cur < minP;
        cond.OOR_UP = cur > maxP;
        cond.HIT_TP = pnl >= tp;
        cond.NEAR_TP = !cond.HIT_TP && pnl >= 0.8 * tp;
        cond.HIT_SL = pnl <= -sl;
        cond.NEAR_SL = !cond.HIT_SL && pnl <= -0.8 * sl;
        const msgs = {
          OOR_DOWN: '🔻 OUT OF RANGE (below): ' + name + ' — price ' + cur.toExponential(3) + ' under your band. Holding 100% token, earning nothing. PnL ' + pnl.toFixed(1) + '%',
          OOR_UP: '🔺 OUT OF RANGE (above): ' + name + ' — fully converted to quote. PnL ' + pnl.toFixed(1) + '%. Consider closing to lock + stop rent.',
          HIT_TP: '🟢 TP HIT: ' + name + ' at ' + pnl.toFixed(1) + '% (target +' + tp + '%). Take it.',
          NEAR_TP: '🎯 Approaching TP: ' + name + ' at ' + pnl.toFixed(1) + '% of +' + tp + '% target.',
          HIT_SL: '🔴 SL HIT: ' + name + ' at ' + pnl.toFixed(1) + '% (stop -' + sl + '%). Cut it.',
          NEAR_SL: '⚠️ Approaching SL: ' + name + ' at ' + pnl.toFixed(1) + '% vs -' + sl + '% stop.'
        };
        for (const k of Object.keys(cond)) {
          const skey = key + ':' + k;
          if (cond[k] && !states[skey]) {
            states[skey] = Date.now();
            await postDiscord(cfg.webhookUrl, '**Meteora Lens** · ' + msgs[k] + '\nhttps://www.meteora.ag/dlmm/' + pool);
            try { chrome.notifications.create('mql-' + Date.now(), { type: 'basic', iconUrl: 'icon128.png', title: 'Meteora Lens', message: msgs[k], priority: 2 }); } catch (e) {}
          } else if (!cond[k] && states[skey]) {
            delete states[skey]; // re-arm when condition clears
          }
        }
      }
    } catch (e) {}
  }
  // detect closes (any device): journal round trip + clean up
  try {
    const lp = st.mqlLastPos || {};
    const closed = Object.keys(lp).filter((k) => !seen[k]);
    if (closed.length) {
      const jr = await chrome.storage.local.get({ mqlTradeLog: [] });
      const logArr = jr.mqlTradeLog || [];
      const bl = await chrome.storage.local.get({ mqlPosBaseline: {} });
      for (const k of closed) {
        const rec = lp[k];
        logArr.push({ pool: rec.pool, name: rec.name, lastSeenPnlPct: rec.pnl,
          openedFirstSeen: rec.firstSeen, closedDetected: Date.now(),
          holdMinutes: Math.round((Date.now() - rec.firstSeen) / 60e3) });
        delete lp[k];
        if (bl.mqlPosBaseline && bl.mqlPosBaseline[rec.pool]) delete bl.mqlPosBaseline[rec.pool];
        await postDiscord(cfg.webhookUrl, '**Meteora Lens** \u00b7 \ud83d\udccb Position closed: ' + rec.name + ' \u2014 last seen PnL ' + (rec.pnl >= 0 ? '+' : '') + rec.pnl.toFixed(1) + '% after ~' + Math.round((Date.now() - rec.firstSeen) / 60e3) + 'min. Journaled.');
      }
      await chrome.storage.local.set({ mqlTradeLog: logArr.slice(-200), mqlPosBaseline: bl.mqlPosBaseline || {} });
    }
    st.mqlLastPos = lp;
  } catch (e) {}
  // prune states for positions no longer open
  for (const k of Object.keys(states)) { const base = k.split(':').slice(0, 2).join(':'); if (!seen[base]) delete states[k]; }
  await chrome.storage.local.set({ mqlAlertStates: states, mqlLastPos: st.mqlLastPos || {} });
}
chrome.alarms.create('mql-watch', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mql-watch') watchPositions(); });
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('mql-watch', { periodInMinutes: 1 }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
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
