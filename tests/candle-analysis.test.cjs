const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeCandleHistory } = require('../candle-analysis.js');

const STEP = 300;
const NOW_SEC = 1_800_000_000;
const LAST_CLOSED = NOW_SEC - STEP;

function candle(timestamp, close = 100, volume = 10) {
  return { timestamp, open: close, high: close, low: close, close, volume };
}

test('extension candle evidence discards the forming bucket and reports complete coverage', () => {
  const first = LAST_CLOSED - 287 * STEP;
  const rows = Array.from({ length: 288 }, (_, i) => candle(first + i * STEP));
  rows.push(candle(NOW_SEC, 10, 999));
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.state, 'READY');
  assert.equal(out.completedCandles, 288);
  assert.equal(out.latestCompletedTs, LAST_CLOSED);
  assert.match(out.note, /historical candle evidence/);
  assert.match(out.note, /descriptive/);
});
