const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../evil-panda.js');

const TF = 300;
const T0 = 1_800_000_000;
const mk = (closes, spread = 0.01) => closes.map((c, i) => ({ t: T0 + i * TF, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1 }));
// 20-bar dump 100 -> ~60, then a noisy flat base of `baseBars` bars
const dumpThenBase = (baseBars) => {
  const out = [];
  for (let i = 0; i < 20; i++) out.push(100 * Math.pow(0.975, i));
  const b = out.at(-1);
  for (let i = 0; i < baseBars; i++) out.push(b * (1 + 0.004 * Math.sin(i * 1.7)));
  return out;
};

test('normalizeCandles drops the forming bucket, dedupes, sorts, accepts GMGN ms strings', () => {
  const rows = [
    { time: String((T0 + TF) * 1000), open: '2', high: '2', low: '2', close: '2', volume: '1' },
    { time: String(T0 * 1000), open: '1', high: '1', low: '1', close: '1', volume: '1' },
    { time: String(T0 * 1000), open: '1', high: '1', low: '1', close: '1.5', volume: '1' },
    { time: String((T0 + 2 * TF) * 1000), open: '3', high: '3', low: '3', close: '3', volume: '1' },
  ];
  const out = P.normalizeCandles({ list: rows }, TF, (T0 + 2 * TF + 100) * 1000);
  assert.deepEqual(out.map((c) => c.t), [T0, T0 + TF]);
  assert.equal(out[0].c, 1.5);
});

test('RSI(2) of a straight rally is 100 and of a straight dump is 0', () => {
  assert.equal(P.rsi([1, 2, 3, 4, 5], 2).at(-1), 100);
  assert.equal(P.rsi([5, 4, 3, 2, 1], 2).at(-1), 0);
  assert.equal(P.rsi([1, 2], 2)[1], null);
});

test('EMA seeds with SMA like TradingView', () => {
  const e = P.ema([1, 2, 3, 4], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);
  assert.equal(e[3], 0.5 * 4 + 0.5 * 2);
});

test('Bollinger uses population stdev', () => {
  const b = P.bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2).at(-1);
  assert.equal(b.basis, 5);
  assert.equal(b.upper, 9);   // population sd = 2
});

test('warm-up requirements match the documented candle counts', () => {
  assert.deepEqual(P.warmupNeeded(), { supertrend: 11, rsi: 3, bb: 20, macd: 35 });
});

test('entry: dump then recovery flips Supertrend up -> ENTRY on 5m, CONFIRMING on 1m first bar', () => {
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100 * Math.pow(0.97, i));      // dump
  const bottom = closes.at(-1);
  let c5, flipAt = -1;
  for (let k = 1; k <= 20; k++) {
    closes.push(bottom * Math.pow(1.04, k));
    const ev = P.evaluateSignals(mk(closes), { timeframe: '5m' });
    if (ev.entry.state !== 'WAIT') { c5 = ev; flipAt = closes.length; break; }
  }
  assert.ok(c5, 'supertrend should flip on the rebound');
  assert.equal(c5.entry.state, 'ENTRY');
  assert.equal(c5.entry.barsSinceFlip, 0);
  const c1 = P.evaluateSignals(mk(closes.slice(0, flipAt)), { timeframe: '1m' });
  assert.equal(c1.entry.state, 'CONFIRMING');
  // keep rallying: goes LATE after the freshness window
  for (let k = 0; k < 6; k++) closes.push(closes.at(-1) * 1.03);
  assert.equal(P.evaluateSignals(mk(closes), { timeframe: '5m' }).entry.state, 'LATE');
});

test('entry: during the dump the state is WAIT with the line above price', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(0.97, i));
  const ev = P.evaluateSignals(mk(closes), { timeframe: '5m' });
  assert.equal(ev.entry.state, 'WAIT');
  assert.ok(ev.entry.distPct > 0);
});

test('exit: sharp bounce after a dump fires RSI2>90 + BB upper on the same candle', () => {
  const closes = dumpThenBase(40);
  closes.push(closes.at(-1) * 1.15);
  const ev = P.evaluateSignals(mk(closes), { timeframe: '5m' });
  assert.equal(ev.exit.state, 'EXIT');
  assert.ok(ev.exit.rsiHot && ev.exit.bbHit);
  assert.ok(ev.exit.legs.some((l) => /BB upper/.test(l)));
});

test('exit: RSI2>90 on the first green MACD bar after a dump fires the MACD leg', () => {
  const closes = [];
  for (let i = 0; i < 45; i++) closes.push(100 - 0.03 * i * i);   // accelerating dump keeps MACD hist red
  let hit = null;
  for (let k = 0; k < 10 && !hit; k++) {
    closes.push(closes.at(-1) * 1.12);
    const ev = P.evaluateSignals(mk(closes, 0.001), { timeframe: '5m' });
    if (ev.exit.macdFirstGreen) hit = ev;
  }
  assert.ok(hit, 'MACD histogram should turn green on the rebound');
  assert.ok(hit.exit.rsiHot);
  assert.equal(hit.exit.state, 'EXIT');
  assert.ok(hit.exit.legs.some((l) => /MACD/.test(l)));
});

test('exit: RSI hot alone is not enough (needs a confluence leg)', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);   // steady grind: RSI 100 but BB upper not breached
  const ev = P.evaluateSignals(mk(closes), { timeframe: '5m' });
  assert.ok(ev.exit.rsiHot);
  assert.equal(ev.exit.bbHit, false);
  assert.equal(ev.exit.macdFirstGreen, false);
  assert.equal(ev.exit.state, 'HOLD');
});

test('exit: before MACD warms, reports partial and still evaluates BB leg', () => {
  const closes = dumpThenBase(24).slice(-24);
  closes.push(closes.at(-1) * 1.15);
  const ev = P.evaluateSignals(mk(closes), { timeframe: '5m' });
  assert.equal(ev.warm.macd, false);
  assert.match(ev.exit.partial, /MACD warming/);
  assert.equal(ev.exit.state, 'EXIT');
});

test('exit: too few candles -> WARMING, never HOLD', () => {
  const ev = P.evaluateSignals(mk([1, 1.1]), { timeframe: '5m' });
  assert.equal(ev.exit.state, 'WARMING');
  assert.equal(ev.entry.state, 'WARMING');
});

test('screenCoin maps GMGN fields to the strategy filters', () => {
  const info = { logo: 'x', total_fee: '220', circulating_supply: '971034081', creation_timestamp: T0 - 3600,
    price: { price: '0.0055', volume_24h: '12167489' },
    stat: { top_entrapment_trader_percentage: 0.1127, top_bundler_trader_percentage: 0.2737, top_rat_trader_percentage: 0, top_10_holder_rate: 0.1921 } };
  const s = P.screenCoin({ info, security: { top_10_holder_rate: '0.1921' }, pool: { supportedSolPair: true, binStep: 100 } }, { nowMs: T0 * 1000 });
  assert.equal(s.state, 'PASS');
  assert.equal(s.facts.ageMin, 60);
  const bad = P.screenCoin({ info: Object.assign({}, info, { stat: Object.assign({}, info.stat, { top_rat_trader_percentage: 0.2 }) }), pool: { supportedSolPair: true, binStep: 20 } });
  assert.deepEqual(bad.failed, ['insiders']);            // bin step is a soft gate
  assert.equal(bad.gates.find((g) => g.key === 'binStep').pass, false);
  const missing = P.screenCoin({ info: { logo: 'x' }, pool: { supportedSolPair: true, binStep: 100 } });
  assert.equal(missing.state, 'INCOMPLETE');
});

test('range recipe: -86%..-94% bins per bin step', () => {
  assert.equal(P.binsForDepth(86, 100), 198);
  assert.equal(P.binsForDepth(94, 100), 283);
  assert.equal(P.binsForDepth(86, 125), 159);
  assert.equal(P.binsForDepth(94, 80), 354);
  const r = P.rangeRecipe(100, 1);
  assert.equal(r.deep.minPrice.toFixed(2), '0.06');
});

test('isPandaShaped: deep one-sided ranges only', () => {
  assert.equal(P.isPandaShaped(0.1, 1), true);
  assert.equal(P.isPandaShaped(0.8, 1), false);
});
