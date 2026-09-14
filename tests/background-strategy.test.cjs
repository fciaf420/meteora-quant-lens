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

function loadBackground({ sync = {}, local = {}, fetch } = {}) {
  const syncArea = storageArea(sync);
  const localArea = storageArea(local);
  const sessionArea = storageArea();
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
  };`;
  vm.runInContext(source + exports, context, { filename: 'background.js' });
  return { api: context.__mql, sync: syncArea.data, local: localArea.data };
}

test('verdict gates IGNITION on the recommended 12% band, not the 35% settings band', () => {
  const { api } = loadBackground();
  const feeRate1h = 5.2;
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
    path: 'CHOP', ofi1h: 1.2, sigma: 100, ddHigh: 30
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
  api.poolCache.set(pool, { ts: Date.now(), data: data(now) });
  await api.watchPositions();
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].belowCount, 1);
  assert.equal(webhookBodies.some((body) => body.content.includes('BID ASK WAIT')), false);
  api.poolCache.set(pool, { ts: Date.now(), data: data(now + 60_000) });
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].belowCount, 2);
  assert.equal(webhookBodies.some((body) => body.content.includes('BID ASK WAIT')), true);
  api.poolCache.set(pool, { ts: Date.now(), data: { ...data(now + 120_000), ofi1h: null } });
  await api.watchPositions();
  assert.equal(local.mqlLastPos[`${pool}:${position}`].belowCount, 2);
  assert.equal(webhookBodies.some((body) => body.content.includes('current fee/organic-flow data is unavailable')), true);
});

test('radar keeps BID ASK visible and preserves every actionable item for alerts', () => {
  const { api } = loadBackground();
  assert.equal(typeof api.selectRadarPayload, 'function');
  const full = Array.from({ length: 6 }, (_, i) => ({ kind: 'FULL', address: `F${i}`, dataTs: 1_000 }));
  const bidAsk = { kind: 'BID_ASK', address: 'BA', dataTs: 1_000 };
  const selected = api.selectRadarPayload(full.concat([bidAsk]), 1_000);
  assert.equal(selected.items.length, 6);
  assert.equal(selected.items.some((item) => item.kind === 'BID_ASK'), true);
  assert.equal(selected.alertItems.length, 7);
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
