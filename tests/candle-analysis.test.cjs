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

test('a just-closed candle missing at the first fetch is retried after 20s, not held for the bucket', async () => {
  const { createCandleHistoryLoader } = require('../candle-analysis.js');
  const clock = { ms: (NOW_SEC + 2) * 1000 };              // 2s after the 5m boundary
  let published = false;                                    // indexer has not published LAST_CLOSED yet
  let fetches = 0;
  const loader = createCandleHistoryLoader({
    nowMs: () => clock.ms,
    fetchJson: async (url) => {
      fetches++;
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = Math.ceil(start / STEP) * STEP; ts <= end; ts += STEP) {
        if (ts === LAST_CLOSED && !published) continue;
        data.push(candle(ts));
      }
      return { ok: true, json: { data } };
    }
  });
  const created = (NOW_SEC - 48 * 3600) * 1000;
  const first = await loader.load('POOL', { poolCreatedAt: created });
  assert.equal(first.analysis.state, 'WAIT');
  assert.equal(first.analysis.reason, 'stale-history');
  const n1 = fetches;
  clock.ms += 10 * 1000;                                    // 12s after boundary: still inside the retry window
  const cached = await loader.load('POOL', { poolCreatedAt: created });
  assert.equal(cached.analysis.reason, 'stale-history');
  assert.equal(fetches, n1, 'within 20s the WAIT is served from cache');
  published = true;
  clock.ms += 15 * 1000;                                    // 27s after boundary: retry
  const retried = await loader.load('POOL', { poolCreatedAt: created });
  assert.ok(fetches > n1, 'after 20s it asks again instead of holding WAIT for the rest of the bucket');
  assert.equal(retried.analysis.state, 'READY');
  assert.equal(retried.analysis.latestCompletedTs, LAST_CLOSED);
});
