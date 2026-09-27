const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get(keys, cb) {
      let out = {};
      if (typeof keys === 'string') out[keys] = data[keys];
      else if (Array.isArray(keys)) keys.forEach((key) => { out[key] = data[key]; });
      else if (keys && typeof keys === 'object') {
        out = { ...keys };
        Object.keys(keys).forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
        });
      } else out = { ...data };
      if (cb) { cb(structuredClone(out)); return; }
      return Promise.resolve(structuredClone(out));
    },
    set(values, cb) {
      Object.assign(data, structuredClone(values));
      if (cb) cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete data[key]);
      if (cb) cb();
      return Promise.resolve();
    }
  };
}

function loadBackground({ sync = {}, local = {}, session = {}, fetch } = {}) {
  const syncArea = storageArea(sync);
  const localArea = storageArea(local);
  const sessionArea = storageArea(session);
  const noopEvent = { addListener() {} };
  const context = {
    console,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetch || (async () => { throw new Error('unexpected fetch'); }),
    chrome: {
      storage: { sync: syncArea, local: localArea, session: sessionArea },
      runtime: { lastError: null, onInstalled: noopEvent, onMessage: noopEvent },
      alarms: { create() {}, onAlarm: noopEvent },
      notifications: { create() {} }
    }
  };
  vm.createContext(context);
  context.importScripts = (...names) => names.forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, name), 'utf8'), context, { filename: name });
  });
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const exports = `\n;globalThis.__mql = {
    computeEdge,
    computeVerdict,
    buildRecommendation,
    watchPositions,
    poolCache,
    fetchPoolRaw,
    fetchJupToken,
    getPoolPairMeta: typeof getPoolPairMeta === 'function' ? getPoolPairMeta : null,
    computeBidAskSignal: typeof computeBidAskSignal === 'function' ? computeBidAskSignal : null,
    resolvePositionProfile: typeof resolvePositionProfile === 'function' ? resolvePositionProfile : null,
    evaluateAccumLifecycle: typeof evaluateAccumLifecycle === 'function' ? evaluateAccumLifecycle : null
    ,selectRadarPayload: typeof selectRadarPayload === 'function' ? selectRadarPayload : null
    ,chooseRadarBidCandidates: typeof chooseRadarBidCandidates === 'function' ? chooseRadarBidCandidates : null
    ,radarBidAskFresh: typeof radarBidAskFresh === 'function' ? radarBidAskFresh : null
    ,loadCandleEvidence: typeof loadCandleEvidence === 'function' ? loadCandleEvidence : null
    ,buildPoolData: typeof buildPoolData === 'function' ? buildPoolData : null
    ,windowPerDay: typeof windowPerDay === 'function' ? windowPerDay : null
    ,poolAgeStage: typeof poolAgeStage === 'function' ? poolAgeStage : null
    ,legacyWindowRate: typeof legacyWindowRate === 'function' ? legacyWindowRate : null
    ,positionFill: typeof positionFill === "function" ? positionFill : null
    ,summarizePositions: typeof summarizePositions === "function" ? summarizePositions : null
    ,computeBreakeven: typeof computeBreakeven === "function" ? computeBreakeven : null
    ,computeRecipeEdges: typeof computeRecipeEdges === "function" ? computeRecipeEdges : null
    ,ilPerDayForRange: typeof ilPerDayForRange === "function" ? ilPerDayForRange : null
  };`;
  vm.runInContext(source + exports, context, { filename: 'background.js' });
  return { api: context.__mql, sync: syncArea.data, local: localArea.data, session: sessionArea.data };
}

test('verdict gates IGNITION on the recommended 12% band, not the 35% settings band', () => {
  const { api } = loadBackground();
  // 9.4 (was 5.2): the corrected edge (LP-net fees, sigma^2/(4W) IL) is 0.556x the
  // old one, so the same scenario needs ~1.8x the fee rate to clear 1.0 at 35%.
  const feeRate1h = 9.4;
  const sigma = 30;
  const settingsEdge = api.computeEdge(feeRate1h, sigma, 35);
  assert.ok(settingsEdge > 1);
  const verdict = api.computeVerdict({
    edge: settingsEdge, feeRate1h, sigma, supportedSolPair: true,
    surge: 1.3, accel: 1.3, organicScore: 80, path: 'CHOP', ageH: 100,
    ofi1h: 1, ofi6h: 0.8, tvl: 200000, floorPct: 10,
    currentPrice: 100, low6h: 90, dayLow: 80,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true
  });
  assert.equal(verdict.class, 'NONE');
  assert.ok(verdict.reasons.some((reason) => reason.includes('recipe edge>=1.0')));
});

test('pool orientation only supports a non-SOL token X quoted in SOL token Y', () => {
  const { api } = loadBackground();
  assert.equal(typeof api.getPoolPairMeta, 'function');
  const sol = 'So11111111111111111111111111111111111111112';
  assert.equal(api.getPoolPairMeta({ token_x: { address: 'TOKEN', symbol: 'TOK' }, token_y: { address: sol, symbol: 'SOL' } }).supportedSolPair, true);
  assert.equal(api.getPoolPairMeta({ token_x: { address: sol, symbol: 'SOL' }, token_y: { address: 'USDC', symbol: 'USDC' } }).supportedSolPair, false);
  assert.equal(api.getPoolPairMeta({ token_x: { address: 'TOKEN' }, token_y: { address: 'USDC' } }).supportedSolPair, false);
});

test('BID ASK is READY only for fresh, complete inputs and returns a hand-checkable allocation', () => {
  const { api } = loadBackground();
  assert.equal(typeof api.computeBidAskSignal, 'function');
  const now = 2_000_000;
  const base = {
    ok: true, ts: now - 30_000, supportedSolPair: true,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
    topHoldersPct: 20, orgBuy1h: 100, feeRate1h: 10, feeRate24h: 12,
    path: 'CHOP', ofi1h: 1.2, sigma: 100, ddHigh: 30,
    candleAnalysis: {
      state: 'READY', latestCompletedTs: 1500, recentVolumeRatio: 0.5,
      volumeBaselineHours: 1, events: { recovered: 2 }, lastRecoveryMinutes: 180,
      support15m: { ready: true }, activeEvent: null,
    }
  };
  const signal = api.computeBidAskSignal(base, now);
  assert.deepEqual(
    { state: signal.state, depthPct: signal.depthPct, bidAskPct: signal.allocation.bidAskPct, spotPct: signal.allocation.spotPct },
    { state: 'READY', depthPct: 64, bidAskPct: 60, spotPct: 40 }
  );
  assert.equal(api.computeBidAskSignal({ ...base, ts: now - 180_001 }, now).state, 'WAIT');
  assert.equal(api.computeBidAskSignal({ ...base, ofi1h: null }, now).state, 'WAIT');
  assert.equal(api.computeBidAskSignal({ ...base, sigma: 0 }, now).state, 'WAIT');
  assert.equal(api.computeBidAskSignal({ ...base, supportedSolPair: false }, now).state, 'WAIT');
  const watch = api.computeBidAskSignal({ ...base, candleAnalysis: null }, now);
  assert.equal(watch.baseReady, true);
  assert.equal(watch.state, 'WATCH');
  assert.equal(watch.ready, false);
});

test('BID ASK remains WATCH while only support or current-cycle recovery remains', () => {
  const { api } = loadBackground();
  const now = 2_000_000;
  const candleAnalysis = {
    state: 'READY', latestCompletedTs: 1500, recentVolumeRatio: 1,
    volumeBaselineHours: 8, events: { recovered: 3 }, lastRecoveryMinutes: 30,
    support15m: { ready: false }, activeEvent: null,
  };
  const signal = api.computeBidAskSignal({
    ok: true, ts: now, supportedSolPair: true,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
    topHoldersPct: 20, orgBuy1h: 100, feeRate1h: 10, feeRate24h: 12,
    path: 'CHOP', ofi1h: 1, sigma: 100, candleAnalysis,
  }, now);
  assert.equal(signal.state, 'WATCH');
  assert.deepEqual(Array.from(signal.candleQualification.reasons), ['support']);
});

test('explicit profiles outrank deposit-composition inference', () => {
  const { api } = loadBackground();
  assert.equal(typeof api.resolvePositionProfile, 'function');
  const quoteOnlyDeposit = { allTimeDeposits: { tokenX: { usd: 0 }, total: { usd: 100 } }, minPrice: 80, maxPrice: 100, poolActivePrice: 100 };
  assert.equal(api.resolvePositionProfile({ profile: 'TRADE' }, quoteOnlyDeposit, null), 'TRADE');
  assert.equal(api.resolvePositionProfile({ cls: 'IGNITION' }, quoteOnlyDeposit, null), 'TRADE');
  assert.equal(api.resolvePositionProfile({ profile: 'ACCUM' }, quoteOnlyDeposit, null), 'ACCUM');
  assert.equal(api.resolvePositionProfile(null, quoteOnlyDeposit, null), 'ACCUM_INFERRED');
});

test('accumulation lifecycle uses WAIT for one kill rule and EXIT only when both fire', () => {
  const { api } = loadBackground();
  assert.equal(typeof api.evaluateAccumLifecycle, 'function');
  assert.equal(api.evaluateAccumLifecycle({ decay: false, flow: false, soft: false }), 'ACCUMULATING');
  assert.equal(api.evaluateAccumLifecycle({ dataReady: false, decay: false, flow: false, soft: false }), 'WAIT');
  assert.equal(api.evaluateAccumLifecycle({ decay: true, flow: false, soft: false }), 'WAIT');
  assert.equal(api.evaluateAccumLifecycle({ decay: false, flow: true, soft: false }), 'WAIT');
  assert.equal(api.evaluateAccumLifecycle({ decay: true, flow: true, soft: false }), 'EXIT');
});

test('compression does not create a long-vol SQUEEZE recipe', () => {
  const { api } = loadBackground();
  const recommendation = api.buildRecommendation({ verdict: { class: 'SQUEEZE' }, sigma: 40, feeRate1h: 3, ofi1h: 1, path: 'CHOP' });
  assert.equal(recommendation.action, 'WAIT');
  assert.equal(recommendation.params, undefined);
});

test('full watcher flow binds a quote-only single-sided position to its TRADE plan', async () => {
  const pool = 'POOL';
  const position = 'POSITION';
  const now = Date.now();
  const webhookBodies = [];
  const fakeFetch = async (url, init = {}) => {
    if (url.includes('/portfolio/open?user=WALLET')) return { ok: true, json: async () => ({ pools: [{ address: pool }] }) };
    if (url.includes(`/positions/${pool}/pnl?user=WALLET&status=open`)) return { ok: true, json: async () => ({ positions: [{
      positionAddress: position, createdAt: Math.floor(now / 1000), minPrice: 80, maxPrice: 120,
      poolActivePrice: 100, pnlSolPctChange: 12,
      allTimeDeposits: { tokenX: { usd: 0 }, total: { usd: 100 } }
    }] }) };
    if (url === 'https://hook.example') { webhookBodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error(`unexpected fetch ${url}`);
  };
  const { api, local } = loadBackground({
    sync: { webhookUrl: 'https://hook.example', walletAddress: 'WALLET' },
    local: { mqlEntryPlan: { [pool]: { pool, ts: now - 60_000, cls: 'IGNITION', profile: 'TRADE', widthPct: 20, tp: 10, sl: 17, entryFeeRate: 5, entryFeeRate24h: 3 } } },
    fetch: fakeFetch
  });
  api.poolCache.set(pool, { ts: now, data: { ok: true, pool: { name: 'TOK-SOL' }, feeRate1h: 5, feeRate24h: 3, ofi1h: 1, pc1h: 1, surge: 1.3, path: 'CHOP', sigma: 30 } });
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].profile, 'TRADE');
  assert.equal(local.mqlLastPos[`${pool}:${position}`].accum, false);
  assert.ok(webhookBodies.some((body) => body.content.includes('TP HIT')));
});

test('watcher confirms BID ASK fee decay on two distinct pool snapshots', async () => {
  const pool = 'POOL2';
  const position = 'POSITION2';
  const now = Date.now();
  const webhookBodies = [];
  const fakeFetch = async (url, init = {}) => {
    if (url.includes('/portfolio/open?user=WALLET')) return { ok: true, json: async () => ({ pools: [{ address: pool }] }) };
    if (url.includes(`/positions/${pool}/pnl?user=WALLET&status=open`)) return { ok: true, json: async () => ({ positions: [{
      positionAddress: position, createdAt: Math.floor(now / 1000), minPrice: 40, maxPrice: 100,
      poolActivePrice: 80, pnlSolPctChange: 0,
      allTimeDeposits: { tokenX: { usd: 0 }, total: { usd: 100 } }
    }] }) };
    if (url === 'https://hook.example') { webhookBodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error(`unexpected fetch ${url}`);
  };
  const { api, local } = loadBackground({
    sync: { webhookUrl: 'https://hook.example', walletAddress: 'WALLET' },
    local: { mqlEntryPlan: { [pool]: { pool, ts: now - 60_000, cls: 'BID_ASK', profile: 'ACCUM', widthPct: 43, entryFeeRate: 10, entryFeeRate24h: 8 } } },
    fetch: fakeFetch
  });
  const data = (ts) => ({ ok: true, pool: { name: 'TOK-SOL' }, feeRate1h: 4, feeRate24h: 8, ofi1h: 1, pc1h: 1, surge: 1, path: 'CHOP', sigma: 100, ts });
  // Explicit, distinct snapshot times. Date.now() - 30_000 twice in the same
  // millisecond produced two "distinct" samples with one timestamp (flaky ~50%).
  const t0 = Date.now();
  api.poolCache.set(pool, { ts: Date.now(), data: data(t0 - 40_000) });
  await api.watchPositions();
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].belowCount, 1);
  assert.equal(webhookBodies.some((body) => body.content.includes('BID ASK WAIT')), false);
  api.poolCache.set(pool, { ts: Date.now(), data: data(t0 - 30_000) });
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].belowCount, 2);
  assert.equal(webhookBodies.some((body) => body.content.includes('BID ASK WAIT')), true);
  api.poolCache.set(pool, { ts: Date.now(), data: { ...data(t0 - 20_000), ofi1h: null } });
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].belowCount, 2);
  assert.equal(webhookBodies.some((body) => body.content.includes('current fee/organic-flow data is unavailable')), true);
});

test('radar keeps BID ASK visible and preserves every actionable item for alerts', () => {
  const { api } = loadBackground();
  assert.equal(typeof api.selectRadarPayload, 'function');
  const now = Date.now();
  const latest = Math.floor(now / 1000 / 300) * 300 - 300;
  const full = Array.from({ length: 6 }, (_, i) => ({ kind: 'FULL', address: `F${i}`, dataTs: now }));
  const bidAsk = { kind: 'BID_ASK', address: 'BA', dataTs: now,
    bidAsk: { baseReady: true, ready: true, candleQualification: { ready: true } },
    candleAnalysis: { latestCompletedTs: latest } };
  const selected = api.selectRadarPayload(full.concat([bidAsk]), now);
  assert.equal(selected.items.length, 6);
  assert.equal(selected.items.some((item) => item.kind === 'BID_ASK'), true);
  assert.equal(selected.alertItems.length, 7);
});

test('radar removes a BID ASK row when its current 5m candle or base snapshot expires', () => {
  const { api } = loadBackground();
  const now = Date.now();
  const latest = Math.floor(now / 1000 / 300) * 300 - 300;
  const common = {
    kind: 'BID_ASK', address: 'BA', dataTs: now - 30_000,
    bidAsk: { baseReady: true, ready: true, candleQualification: { ready: true } }
  };
  const staleCandle = { ...common, candleAnalysis: { latestCompletedTs: latest - 300 } };
  assert.equal(api.radarBidAskFresh(staleCandle, now), false);
  const staleBase = { ...common, dataTs: now - 120_001, candleAnalysis: { latestCompletedTs: latest } };
  assert.equal(api.radarBidAskFresh(staleBase, now), false);
  const visible = api.selectRadarPayload([staleCandle, staleBase], now);
  assert.equal(visible.items.length, 0);
  assert.equal(visible.alertItems.length, 0);
});

test('radar keeps fresh base WATCH rows visible without making them alerts', () => {
  const { api } = loadBackground();
  const now = Date.now();
  const watch = {
    kind: 'BID_WATCH', address: 'WATCH', mint: 'MINT', dataTs: now,
    bidAsk: { baseReady: true, ready: false, candleQualification: { ready: false } },
    candleAnalysis: { state: 'WAIT', reason: 'fetch-failed', latestCompletedTs: null }
  };
  assert.equal(api.radarBidAskFresh(watch, now), true);
  const selected = api.selectRadarPayload([watch], now);
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].kind, 'BID_WATCH');
  assert.equal(selected.alertItems.length, 0);
});

test('radar deduplicates BID ASK siblings by exact token mint and prefers a qualified one', () => {
  const { api } = loadBackground();
  const now = Date.now();
  const latest = Math.floor(now / 1000 / 300) * 300 - 300;
  const make = (address, feeRate1h, ready) => ({
    address, mint: 'TOKEN-MINT', feeRate1h,
    bidAsk: { baseReady: true, ready, candleQualification: { ready } },
    candleAnalysis: { state: 'READY', latestCompletedTs: latest }
  });
  const selected = api.chooseRadarBidCandidates([
    make('HIGH-FEE-WATCH', 40, false),
    make('LOW-FEE-READY', 8, true),
    { ...make('OTHER-TOKEN', 12, false), mint: 'OTHER-MINT' }
  ], now);
  assert.deepEqual(Array.from(selected.map((item) => item.address)), ['LOW-FEE-READY', 'OTHER-TOKEN']);
});

test('request coalescing reuses one Jupiter lookup and complete fresh board metadata', async () => {
  let requests = 0;
  const fakeFetch = async () => { requests++; return { ok: true, json: async () => ([{ id: 'TOKEN' }]) }; };
  const { api } = loadBackground({ fetch: fakeFetch });
  await Promise.all([api.fetchJupToken('TOKEN', 'KEY'), api.fetchJupToken('TOKEN', 'KEY')]);
  await api.fetchJupToken('TOKEN', 'KEY');
  assert.equal(requests, 1);
  const completeSeed = {
    address: 'POOL', current_price: 1, tvl: 100000, dynamic_fee_pct: 0.2,
    token_x: { address: 'TOKEN' }, token_y: { address: 'So11111111111111111111111111111111111111112' },
    pool_config: { base_fee_pct: 0.1, bin_step: 20 },
    fee_tvl_ratio: { '1h': 1, '24h': 2 }, volume: { '30m': 3, '4h': 4 }
  };
  const seeded = await api.fetchPoolRaw('POOL', completeSeed);
  assert.equal(seeded.json, completeSeed);
  assert.equal(requests, 1);
});

test('candle evidence persists completed history across service-worker restarts', async () => {
  const createdAt = Date.now() - 48 * 3600e3;
  let requests = 0;
  const fakeFetch = async (url) => {
    requests++;
    const u = new URL(url);
    const start = Number(u.searchParams.get('start_time'));
    const end = Number(u.searchParams.get('end_time'));
    const data = [];
    for (let ts = start; ts <= end; ts += 300) data.push({
      timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1
    });
    return { ok: true, json: async () => ({ data }) };
  };
  const firstWorker = loadBackground({ fetch: fakeFetch });
  const first = await firstWorker.api.loadCandleEvidence('POOL', createdAt);
  assert.equal(first.state, 'READY');
  assert.equal(requests, 4);
  assert.ok(firstWorker.session['mqlc:candles:POOL']);

  requests = 0;
  const secondWorker = loadBackground({ fetch: fakeFetch, session: firstWorker.session });
  const restored = await secondWorker.api.loadCandleEvidence('POOL', createdAt);
  assert.equal(restored.state, 'READY');
  assert.equal(requests, 0);
});

test('a current six-hour seed for a mature pool backfills the missing 18 hours', async () => {
  const nowSec = Math.floor(Date.now() / 300000) * 300;
  const recent = [];
  for (let ts = nowSec - 6 * 3600; ts < nowSec; ts += 300) {
    recent.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  }
  let requests = 0;
  const worker = loadBackground({ fetch: async (url) => {
    requests++;
    const u = new URL(url);
    const start = Number(u.searchParams.get('start_time'));
    const end = Number(u.searchParams.get('end_time'));
    const data = [];
    for (let ts = start; ts <= end; ts += 300) {
      data.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    }
    return { ok: true, json: async () => ({ data }) };
  } });
  const analysis = await worker.api.loadCandleEvidence(
    'MATURE', Date.now() - 48 * 3600e3, recent);
  assert.equal(analysis.state, 'READY');
  assert.equal(requests, 3);
});

test('invalid candle history is not sanitized into a trusted restart cache', async () => {
  let requests = 0;
  const conflictingFetch = async (url) => {
    requests++;
    const u = new URL(url);
    const start = Number(u.searchParams.get('start_time'));
    const end = Number(u.searchParams.get('end_time'));
    const data = [];
    for (let ts = start; ts <= end; ts += 300) {
      data.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    }
    if (requests === 1 && data.length) {
      data.push({ timestamp: data[0].timestamp, open: 2, high: 2, low: 2, close: 2, volume: 1 });
    }
    return { ok: true, json: async () => ({ data }) };
  };
  const firstWorker = loadBackground({ fetch: conflictingFetch });
  const first = await firstWorker.api.loadCandleEvidence('BAD', Date.now() - 48 * 3600e3);
  assert.equal(first.state, 'WAIT');
  assert.equal(first.reason, 'invalid-candles');
  assert.equal(firstWorker.session['mqlc:candles:BAD'], undefined);

  requests = 0;
  const secondWorker = loadBackground({ fetch: conflictingFetch, session: firstWorker.session });
  await secondWorker.api.loadCandleEvidence('BAD', Date.now() - 48 * 3600e3);
  assert.ok(requests > 0);
});

// ---- pool-age-aware fee rates (NEARPAD-SOL, 2026-09-27) --------------------
// Live numbers: pool 1.68h old, fee_tvl_ratio 1h 6.1257 and 2h=4h=12h=24h 6.375
// (every window past the pool's age is the same since-creation total).

test('window rates are divided by the hours the window actually covered', () => {
  const { api } = loadBackground();
  // young pool: "24h" is really 1.68h of fees
  assert.ok(Math.abs(api.windowPerDay(6.375, 24, 1.68) - 6.375 * 24 / 1.68) < 1e-9);   // ~91%/day, not 6.4
  assert.ok(Math.abs(api.windowPerDay(6.1257, 1, 1.68) - 6.1257 * 24) < 1e-9);         // full 1h window: unchanged
  // mature pool and unknown age: unchanged from the old math
  assert.equal(api.windowPerDay(6.375, 24, 100), 6.375);
  assert.equal(api.windowPerDay(6.375, 24, null), 6.375);
  // 20-minute pool: its 1h window holds 20 minutes of fees
  assert.ok(Math.abs(api.windowPerDay(1, 1, 1 / 3) - 72) < 1e-9);
  // minutes-old pool is floored at 15 minutes of coverage, never divides by ~0
  assert.equal(api.windowPerDay(1, 1, 2 / 60), 96);
  assert.equal(api.poolAgeStage(0.5), 'LAUNCH');
  assert.equal(api.poolAgeStage(1.68), 'YOUNG');
  assert.equal(api.poolAgeStage(24), 'MATURE');
  assert.equal(api.poolAgeStage(null), 'UNKNOWN');
});

test('buildPoolData reports NEARPAD at its real since-launch rate and age-corrects accel', async () => {
  const now = Date.now();
  const createdAt = now - 1.68 * 3600e3;
  const seed = {
    address: 'NEARPAD', name: 'NEARPAD-SOL', current_price: 1, tvl: 215000, dynamic_fee_pct: 2,
    created_at: createdAt, _mqlBoardTs: now,
    token_x: { address: 'TOKEN' }, token_y: { address: 'So11111111111111111111111111111111111111112' },
    pool_config: { base_fee_pct: 2, bin_step: 100 },
    fee_tvl_ratio: { '30m': 4.97, '1h': 6.1257, '2h': 6.375, '4h': 6.375, '12h': 6.375, '24h': 6.375 },
    volume: { '30m': 100000, '1h': 300000, '4h': 465000, '24h': 465000 }
  };
  const { api } = loadBackground({ fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  const d = await api.buildPoolData('NEARPAD', { mqlWidthPct: 20 }, seed);
  assert.equal(d.ok, true);
  assert.equal(d.poolStage, 'YOUNG');
  assert.equal(d.feeBasis, 'pool-age-v1');
  assert.ok(Math.abs(d.feeRate24h - 6.375 * 24 / 1.68) < 0.5, 'since-launch %/day, not 6.4');
  assert.ok(Math.abs(d.feeRate1h - 6.1257 * 24) < 1e-6);
  // accel = hourly pace over 30m vs hourly pace over the 1.68h the "4h" window covered
  const expectedAccel = (100000 / 0.5) / (465000 / 1.68);
  assert.ok(Math.abs(d.accel - expectedAccel) < 0.01);
  assert.ok(d.accel < (100000 * 48) / (465000 * 6), 'old fixed-4h divisor inflated accel');
});

test('BID ASK fee persistence passes a young pool on its real rate and holds a sub-1h pool', () => {
  const { api } = loadBackground();
  const now = 5_000_000;
  const base = {
    ok: true, ts: now - 30_000, supportedSolPair: true,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
    topHoldersPct: 13, orgBuy1h: 100, path: 'GRIND-UP', ofi1h: 0.96, sigma: 459, ddHigh: 15,
    candleAnalysis: null
  };
  const feeGate = (s) => s.gates.find((g) => g.key === 'fees');
  // old math: 24h read as 6.4%/day -> failed the 8%/day floor
  assert.equal(feeGate(api.computeBidAskSignal({ ...base, feeRate1h: 147, feeRate24h: 6.375, poolAgeH: 1.68 }, now)).pass, false);
  // age-corrected: ~91%/day since launch, 1h 147 >= half of it -> passes
  assert.equal(feeGate(api.computeBidAskSignal({ ...base, feeRate1h: 147, feeRate24h: 91.07, poolAgeH: 1.68 }, now)).pass, true);
  // 30-minute-old pool: not enough fee history to judge persistence, says so plainly
  const launch = api.computeBidAskSignal({ ...base, feeRate1h: 300, feeRate24h: 300, poolAgeH: 0.5 }, now);
  assert.equal(feeGate(launch).pass, false);
  assert.match(feeGate(launch).label, /30m old; needs 1h of fees/);
});

test('no class issues an entry on under an hour of fee history, but the scalp override stays reachable', () => {
  const { api } = loadBackground();
  const m = {
    feeRate1h: 40, sigma: 30, supportedSolPair: true,
    surge: 1.3, accel: 1.3, organicScore: 80, path: 'CHOP', ageH: 100,
    ofi1h: 1, ofi6h: 0.8, tvl: 200000, floorPct: 10,
    currentPrice: 100, low6h: 90, dayLow: 80,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true
  };
  assert.equal(api.computeVerdict({ ...m, poolAgeH: 5 }).class, 'IGNITION');
  assert.equal(api.computeVerdict({ ...m, poolAgeH: null }).class, 'IGNITION');
  const held = api.computeVerdict({ ...m, poolAgeH: 0.5 });
  assert.equal(held.class, 'NONE');
  assert.ok(held.reasons.some((r) => r.includes('pool fee history>=1h')));
  const rec = api.buildRecommendation({ ...m, verdict: held, recipeEdges: { IGNITION: 3, BASING: 0, CARRY: 0 },
    poolStage: 'LAUNCH', poolAgeH: 0.5 });
  assert.equal(rec.action, 'WAIT');
  assert.equal(rec.override && rec.override.cls, 'SCALP');
  assert.match(rec.override.ignoredGates[0], /30m old/);
});

test('baselines stored under the old math are rescaled by pool age at record time', () => {
  const { api } = loadBackground();
  const created = 1_000_000_000_000;
  const at = created + 1.68 * 3600e3;
  // legacy "24h normal" 6.375 recorded when the pool was 1.68h old -> ~91%/day
  assert.ok(Math.abs(api.legacyWindowRate(6.375, 24, at, created, undefined) - 6.375 * 24 / 1.68) < 1e-9);
  // already on the new basis, a mature record, or unknown pool age: untouched
  assert.equal(api.legacyWindowRate(91, 24, at, created, 'pool-age-v1'), 91);
  assert.equal(api.legacyWindowRate(6.375, 24, created + 30 * 3600e3, created, undefined), 6.375);
  assert.equal(api.legacyWindowRate(6.375, 24, at, null, undefined), 6.375);
  // legacy 1h rate recorded at 30 minutes old held only 30 minutes of fees
  assert.equal(api.legacyWindowRate(50, 1, created + 0.5 * 3600e3, created, undefined), 100);
  assert.equal(api.legacyWindowRate(0, 24, at, created, undefined), null);
});

test('an open young-pool BID ASK position re-arms DECAY once its legacy baseline is rescaled', async () => {
  const pool = 'YOUNGPOOL';
  const position = 'YOUNGPOS';
  const now = Date.now();
  const created = now - 3 * 3600e3;
  const planTs = created + 1.68 * 3600e3;   // entered when the pool was 1.68h old
  const fakeFetch = async (url) => {
    if (url.includes('/portfolio/open?user=WALLET')) return { ok: true, json: async () => ({ pools: [{ address: pool }] }) };
    if (url.includes(`/positions/${pool}/pnl?user=WALLET&status=open`)) return { ok: true, json: async () => ({ positions: [{
      positionAddress: position, createdAt: Math.floor((planTs + 60_000) / 1000), minPrice: 25, maxPrice: 100,
      poolActivePrice: 90, pnlSolPctChange: -2,
      allTimeDeposits: { tokenX: { usd: 0 }, total: { usd: 100 } }
    }] }) };
    if (url === 'https://hook.example') return { ok: true, json: async () => ({}) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const { api, local } = loadBackground({
    sync: { webhookUrl: 'https://hook.example', walletAddress: 'WALLET' },
    // journaled by the old code: "24h normal" 6.375 was really 1.68h of fees
    local: { mqlEntryPlan: { [pool]: { pool, ts: planTs, cls: 'BID_ASK', profile: 'ACCUM', widthPct: 60,
      entryFeeRate: 225, entryFeeRate24h: 6.375 } } },
    fetch: fakeFetch
  });
  // fee rate has fallen to 60%/day: below half of entry (112.5) AND below the real
  // since-launch normal (~91). Under the old baseline (6.4) this could never count.
  api.poolCache.set(pool, { ts: Date.now(), data: { ok: true, pool: { name: 'YOUNG-SOL', createdAt: created },
    feeRate1h: 60, feeRate24h: 70, ofi1h: 1, pc1h: -1, surge: 1, path: 'CHOP', sigma: 300, ts: now - 20_000 } });
  await api.watchPositions();
  const snap = local.mqlLastPos[`${pool}:${position}`];
  assert.ok(Math.abs(snap.entryFeeRate24h - 6.375 * 24 / 1.68) < 1e-6);
  assert.equal(snap.feeBasis, 'pool-age-v1');
  assert.equal(snap.belowCount, 1);
});

// ---- fee/IL math and position fill (checked against docs.meteora.ag) ---------

test('edge uses LP-net fees and sigma^2/(4W) IL; breakeven is the IL itself', () => {
  const { api } = loadBackground();
  // hand-checkable: fee 20%/day, sigma 100%/day, W 25% -> IL = 100^2/(4*25) = 100%/day
  assert.equal(api.computeBreakeven(100, 25), 100);
  // edge = 20 / (1.3 * 100) = 0.1538...
  assert.ok(Math.abs(api.computeEdge(20, 100, 25) - 20 / 130) < 1e-12);
  // exactly 0.5556x the old (fee*0.9)/(1.3*sigma^2/(8W)) on any input
  const old = (f, s, w) => (f * 0.9 / s) / Math.max(1.3 * s / (8 * w), 0.001);
  for (const [f, s, w] of [[5.2, 30, 35], [147, 459, 12], [40, 60, 20]]) {
    assert.ok(Math.abs(api.computeEdge(f, s, w) / old(f, s, w) - 4 / (0.9 * 8)) < 1e-9);
  }
});

// datapi PositionPnL schema (docs.meteora.ag positions/pnl): amounts are strings
const accumPos = (over = {}) => ({
  positionAddress: 'POS', minPrice: '25', maxPrice: '100', poolActivePrice: '60', pnlSolPctChange: -3,
  allTimeDeposits: { tokenX: { amount: '0', usd: '0' }, tokenY: { amount: '10', usd: '2000' }, total: { usd: '2000', sol: '10' } },
  allTimeWithdrawals: { tokenX: { amount: '0', usd: '0' }, tokenY: { amount: '0', usd: '0' }, total: { usd: '0' } },
  unrealizedPnl: { balances: 1900, balancesSol: '9.7', balanceTokenX: { amount: '1234', usd: '...' }, balanceTokenY: { amount: '7.5', usd: '...' },
    unclaimedFeeTokenX: { amount: '0', usd: '0' }, unclaimedFeeTokenY: { amount: '0', usd: '0' },
    unclaimedRewardTokenX: { amount: '0', usd: '0' }, unclaimedRewardTokenY: { amount: '0', usd: '0' } },
  ...over
});

test('fill = share of deposited SOL already spent, from the real datapi fields', () => {
  const { api } = loadBackground();
  // 10 SOL in, 7.5 SOL still in the bins -> 25% of the SOL has bought the token
  const f = api.positionFill(accumPos(), 60);
  assert.equal(f.method, 'sol-spent');
  assert.equal(f.fill, 0.25);
  // withdrawals reduce the base: 10 in, 2 withdrawn, 6 left -> 2/8 spent
  const w = api.positionFill(accumPos({ allTimeWithdrawals: { tokenY: { amount: '2' }, tokenX: { amount: '0' }, total: { usd: '0' } },
    unrealizedPnl: { ...accumPos().unrealizedPnl, balanceTokenY: { amount: '6' } } }), 60);
  assert.equal(w.fill, 0.25);
  // a two-sided deposit is not a SOL ladder: no sol-spent fill, falls back (labeled)
  const two = api.positionFill(accumPos({ allTimeDeposits: { tokenX: { amount: '500' }, tokenY: { amount: '10' }, total: { usd: '1' } } }), 60);
  assert.equal(two.method, 'traversal');
  // the linear guess this replaces would have said 53% at this price
  assert.ok(Math.abs(api.positionFill({ minPrice: '25', maxPrice: '100' }, 60).fill - 40 / 75) < 1e-9);
});

test('position summary weights PnL by real SOL value and pools fill as total SOL spent', () => {
  const { api } = loadBackground();
  const a = accumPos({ positionAddress: 'A', pnlSolPctChange: -10,
    unrealizedPnl: { ...accumPos().unrealizedPnl, balancesSol: '9', balanceTokenY: { amount: '9' } } });           // 1 of 10 spent
  const b = accumPos({ positionAddress: 'B', pnlSolPctChange: 10,
    allTimeDeposits: { tokenX: { amount: '0', usd: '0' }, tokenY: { amount: '30' }, total: { usd: '1', sol: '30' } },
    unrealizedPnl: { ...accumPos().unrealizedPnl, balancesSol: '27', balanceTokenY: { amount: '15' } } });       // 15 of 30 spent
  const s = api.summarizePositions([a, b], null);
  assert.equal(s.fillMethod, 'sol-spent');
  assert.equal(s.fillPct, Math.round(100 * 16 / 40));          // 40%, not the leg mean (30%)
  assert.equal(s.pnlPct, Math.round(((-10 * 9 + 10 * 27) / 36) * 10) / 10);   // value-weighted: +5.0
});

test('one-sided IGNITION prices IL on the one-sided width (same capital, half the width)', () => {
  const { api } = loadBackground();
  const base = { feeRate1h: 40, sigma: 60, currentPrice: 100, low6h: 90, dayLow: 80 };
  const two = api.computeRecipeEdges({ ...base, ofi1h: 1 });
  const one = api.computeRecipeEdges({ ...base, ofi1h: 2.5 });
  assert.ok(Math.abs(one.IGNITION / two.IGNITION - 0.5) < 1e-9);
  assert.equal(one.CARRY, two.CARRY);          // CARRY and BASING are always two-sided
  assert.equal(one.BASING, two.BASING);
  // general form: sigma^2 / (2 * full width); +-W alias = full width 2W
  assert.equal(api.ilPerDayForRange(60, 75), 3600 / 150);
  assert.equal(api.computeBreakeven(60, 37.5), api.ilPerDayForRange(60, 75));
});
