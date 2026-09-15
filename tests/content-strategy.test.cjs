const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadContentGate() {
  const exports = {};
  const context = {
    console,
    window: { __mqlLoaded: false, __mqlTestExports: exports, addEventListener() {} },
    document: { readyState: 'loading', addEventListener() {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    chrome: { runtime: {}, storage: {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), context, { filename: 'content.js' });
  assert.equal(typeof exports.accumComboCheck, 'function');
  return exports.accumComboCheck;
}

function baseData(now, candleTs, qualification) {
  return {
    ok: true, ts: now, supportedSolPair: true,
    bidAsk: {
      ready: qualification,
      state: qualification ? 'READY' : 'WATCH',
      depthPct: 64,
      allocation: { bidAskPct: 60, spotPct: 40 },
      reasons: qualification ? [] : ['support'],
      candleQualification: { ready: qualification },
      candleAnalysis: { latestCompletedTs: candleTs }
    }
  };
}

test('content enables the manual guide only for a current shared-qualified BID ASK signal', () => {
  const check = loadContentGate();
  const now = Date.now();
  const latest = Math.floor(now / 1000 / 300) * 300 - 300;
  const ready = check(baseData(now, latest, true));
  assert.equal(ready.show, 'full');
  assert.equal(ready.state, 'READY');

  const stale = check(baseData(now, latest - 300, true));
  assert.equal(stale.show, 'wait');
  assert.equal(stale.state, 'WATCH');
  assert.match(String(stale.reasons[0]), /candle data stale/);

  const legacy = baseData(now, latest, true);
  delete legacy.bidAsk.candleQualification;
  const legacyResult = check(legacy);
  assert.equal(legacyResult.show, 'wait');
  assert.equal(legacyResult.state, 'WATCH');

  const watch = check(baseData(now, latest, false));
  assert.equal(watch.show, 'wait');
  assert.equal(watch.state, 'WATCH');
});
