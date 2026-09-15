const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadContentExports(options = {}) {
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
  if (options.clock) {
    const RealDate = Date;
    function FakeDate(...args) { return new RealDate(...args); }
    FakeDate.now = () => options.clock.now;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    context.Date = FakeDate;
  }
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), context, { filename: 'content.js' });
  assert.equal(typeof exports.accumComboCheck, 'function');
  assert.equal(typeof exports.bidAskOverridePlan, 'function');
  assert.equal(typeof exports.validateComboTotal, 'function');
  assert.equal(typeof exports.createAccumOverrideConfirmation, 'function');
  return exports;
}

function loadContentGate() {
  return loadContentExports().accumComboCheck;
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

function makeDomHarness() {
  let nextTimer = 1;
  const timers = new Map();

  function makeNode(tagName, text = '') {
    const node = {
      nodeType: tagName === '#text' ? 3 : 1,
      tagName: String(tagName).toUpperCase(),
      className: '',
      id: '',
      children: [],
      parentElement: null,
      style: {},
      attributes: {},
      listeners: {},
      _text: String(text || ''),
      value: '',
      disabled: false,
      classList: {
        add(...names) {
          const current = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
          names.forEach((name) => current.add(name));
          node.className = [...current].join(' ');
        },
        remove(...names) {
          const remove = new Set(names);
          node.className = String(node.className || '').split(/\s+/).filter((name) => name && !remove.has(name)).join(' ');
        },
        contains(name) { return String(node.className || '').split(/\s+/).includes(name); }
      }
    };
    Object.defineProperty(node, 'textContent', {
      get() { return node._text + node.children.map((child) => child.textContent || '').join(''); },
      set(value) { node._text = String(value == null ? '' : value); node.children = []; }
    });
    Object.defineProperty(node, 'innerHTML', {
      get() { return node.textContent; },
      set(value) { node._text = String(value == null ? '' : value); node.children = []; }
    });
    node.appendChild = (child) => {
      if (child.parentElement) child.parentElement.removeChild(child);
      node.children.push(child);
      child.parentElement = node;
      return child;
    };
    node.removeChild = (child) => {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      child.parentElement = null;
      return child;
    };
    node.insertBefore = (child, before) => {
      if (child.parentElement) child.parentElement.removeChild(child);
      const index = node.children.indexOf(before);
      if (index < 0) node.children.push(child);
      else node.children.splice(index, 0, child);
      child.parentElement = node;
      return child;
    };
    node.remove = () => { if (node.parentElement) node.parentElement.removeChild(node); };
    node.setAttribute = (name, value) => {
      node.attributes[name] = String(value);
      if (name === 'id') node.id = String(value);
    };
    node.addEventListener = (type, handler) => {
      (node.listeners[type] || (node.listeners[type] = [])).push(handler);
    };
    node.dispatchEvent = (event) => {
      const handlers = node.listeners[event.type] || [];
      handlers.forEach((handler) => handler.call(node, Object.assign({ target: node }, event)));
    };
    node.click = () => node.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
    node.closest = () => null;
    node.querySelectorAll = (selector) => {
      const wanted = String(selector).split(',').map((part) => part.trim());
      const matches = (candidate, part) => {
        if (!candidate || candidate.nodeType !== 1) return false;
        if (part.startsWith('#')) return candidate.id === part.slice(1);
        if (part.startsWith('.')) return candidate.classList.contains(part.slice(1));
        return candidate.tagName.toLowerCase() === part.toLowerCase();
      };
      const found = [];
      const visit = (candidate) => {
        candidate.children.forEach((child) => {
          if (wanted.some((part) => matches(child, part))) found.push(child);
          visit(child);
        });
      };
      visit(node);
      return found;
    };
    node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
    return node;
  }

  const body = makeNode('body');
  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    body,
    documentElement: makeNode('html'),
    activeElement: null,
    listeners: {},
    createElement: (tagName) => makeNode(tagName),
    createElementNS: (_ns, tagName) => makeNode(tagName),
    createTextNode: (text) => makeNode('#text', text),
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById(id) {
      const visit = (node) => {
        if (node.id === id) return node;
        for (const child of node.children) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(body) || visit(this.documentElement);
    }
  };
  const getRequests = [];
  const setPayloads = [];
  const storage = {
    get(defaults, callback) { getRequests.push({ defaults, callback }); },
    set(payload, callback) { setPayloads.push(payload); if (callback) callback(); },
    remove() {}
  };
  const window = {
    __mqlLoaded: false,
    __mqlTestExports: {},
    addEventListener() {},
    postMessage() {}
  };
  const context = {
    console,
    window,
    document,
    chrome: { runtime: {}, storage: { local: storage } },
    location: { pathname: '/dlmm/11111111111111111111111111111111', href: 'https://meteora.ag/dlmm/11111111111111111111111111111111' },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    MutationObserver: function () { this.observe = function () {}; },
    Event: function (type) { this.type = type; },
    KeyboardEvent: function (type, init) { this.type = type; Object.assign(this, init); },
    history: {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), context, { filename: 'content.js' });
  return { context, document, storage, getRequests, setPayloads, timers, exports: window.__mqlTestExports, makeNode };
}

test('content enables the manual guide only for a current shared-qualified BID ASK signal', () => {
  const check = loadContentGate();
  const now = Date.now();
  const latest = Math.floor(now / 1000 / 300) * 300 - 300;
  const ready = check(baseData(now, latest, true));
  assert.equal(ready.show, 'full');
  assert.equal(ready.state, 'READY');

  const staleData = baseData(now, latest - 300, true);
  staleData.bidAsk.reasons = ['base and candle qualification gates pass; manual wallet approval required'];
  const stale = check(staleData);
  assert.equal(stale.show, 'wait');
  assert.equal(stale.state, 'WATCH');
  assert.match(String(stale.reasons[0]), /candle data stale/);
  assert.equal(stale.overridePlan.ok, true);
  assert.equal(stale.overridePlan.ignoredGates.some((reason) => /candle data stale/.test(reason)), true);
  assert.equal(stale.overridePlan.ignoredGates.some((reason) => /base and candle qualification gates pass/.test(reason)), false);

  const legacy = baseData(now, latest, true);
  delete legacy.bidAsk.candleQualification;
  const legacyResult = check(legacy);
  assert.equal(legacyResult.show, 'wait');
  assert.equal(legacyResult.state, 'WATCH');

  const watch = check(baseData(now, latest, false));
  assert.equal(watch.show, 'wait');
  assert.equal(watch.state, 'WATCH');
});

test('WATCH/WAIT exposes an intentional override only with a structural depth and split plan', () => {
  const exports = loadContentExports();
  const now = Date.now();
  const latest = Math.floor(now / 1000 / 300) * 300 - 300;
  const d = baseData(now, latest, false);
  d.bidAsk.gates = [
    { label: 'fee persistence', pass: false },
    { label: 'token X / SOL Y pair', pass: true },
  ];
  d.bidAsk.candleQualification.reasons = ['support', 'recentRecovery'];
  const checked = exports.accumComboCheck(d);
  assert.equal(checked.overridePlan.ok, true);
  assert.equal(checked.overridePlan.depth, 64);
  assert.equal(checked.overridePlan.share, 0.6);
  assert.ok(checked.overridePlan.ignoredGates.includes('fee persistence'));
  assert.ok(checked.overridePlan.ignoredGates.includes('support'));

  const unsupported = exports.bidAskOverridePlan({ ...d, supportedSolPair: false });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reasons.join(' '), /non-SOL token X/);
  const invalidDepth = exports.bidAskOverridePlan({ ...d,
    bidAsk: { ...d.bidAsk, depthPct: 100 } });
  assert.equal(invalidDepth.ok, false);
});

test('override total validation rejects junk and rounded zero legs without falling back', () => {
  const validate = loadContentExports().validateComboTotal;
  assert.equal(validate('1junk', 0.6).ok, false);
  assert.equal(validate('', 0.6).ok, false);
  assert.equal(validate('0.001', 0.6).ok, false);
  const valid = validate('0.002', 0.6);
  assert.equal(valid.ok, true);
  assert.equal(valid.totalSol, 0.002);
  assert.equal(valid.bidAskSol, 0.001);
  assert.equal(valid.spotSol, 0.001);
  assert.equal(validate('1e309', 0.6).ok, false);
});

test('override confirmation requires two matching clicks before its wall-clock deadline', () => {
  const clock = { now: 1000 };
  const create = loadContentExports({ clock }).createAccumOverrideConfirmation;
  const snapshot = { pool: 'POOL_A', dataTs: 100, depth: 64, share: 0.6, totalSol: 1 };
  const flow = create(8000);
  assert.equal(flow.click(snapshot).armed, true);
  assert.equal(flow.isArmed(), true);
  assert.equal(flow.click(snapshot).confirmed, true);
  assert.equal(flow.isArmed(), false);

  const changed = create(8000);
  changed.click(snapshot);
  const result = changed.click({ ...snapshot, pool: 'POOL_B' });
  assert.equal(result.rejected, true);
  assert.equal(changed.isArmed(), false);
  assert.equal(changed.click(snapshot).armed, true);

  const expired = create(8000);
  expired.click(snapshot);
  clock.now = 9001;
  assert.equal(expired.click(snapshot).expired, true);
  assert.equal(expired.isArmed(), false);
});

test('expanded WATCH BID ASK override runs the real two-click flow and journals its captured pool', () => {
  const harness = makeDomHarness();
  const { document, exports, getRequests, setPayloads } = harness;
  assert.equal(typeof exports.renderAccumBlock, 'function');
  assert.equal(typeof exports.startCombo, 'function');
  assert.equal(typeof exports.setState, 'function');

  const poolA = 'POOL_A';
  const poolB = 'POOL_B';
  const now = Date.now();
  const d = baseData(now, Math.floor(now / 1000 / 300) * 300 - 300, false);
  d.bidAsk.reasons = ['base and candle qualification gates pass; manual wallet approval required'];
  d.bidAsk.gates = [{ label: 'fee persistence', pass: false }];
  d.bidAsk.candleQualification.reasons = ['support'];
  d.bidAsk.candleAnalysis = { state: 'WAIT', reason: 'support evidence pending', latestCompletedTs: d.bidAsk.candleAnalysis.latestCompletedTs };
  exports.setState({ pool: poolA, data: d });
  exports.setComboOpen(true);

  const hud = document.createElement('div');
  exports.renderAccumBlock(hud, d);
  const buttons = hud.querySelectorAll('button');
  const overrideButton = buttons.find((button) => /Override BID ASK anyway/.test(button.textContent));
  const totalInput = hud.querySelector('input');
  assert.ok(overrideButton, 'WATCH card should expose the explicit override action');
  assert.ok(totalInput, 'WATCH card should expose a TOTAL SOL input');
  assert.equal(buttons.some((button) => /Guide Bid-Ask \+ Spot/.test(button.textContent)), false,
    'WATCH must not expose the normal READY guide');

  // Direct normal invocation remains fail-closed while the same WATCH payload
  // can use the explicit override path.
  exports.startCombo(64, 0.6, 1);
  assert.equal(exports.getComboState(), null);
  assert.equal(setPayloads.some((payload) => payload.mqlComboState), false);

  totalInput.value = '';
  overrideButton.click();
  assert.equal(exports.getComboState(), null, 'blank TOTAL SOL must not arm a position flow');
  assert.equal(setPayloads.some((payload) => payload.mqlComboState), false);

  totalInput.value = '1.000';
  overrideButton.click();
  assert.equal(exports.getComboState(), null, 'first click only arms the override');
  overrideButton.click();
  const comboPayload = setPayloads.find((payload) => payload.mqlComboState);
  assert.ok(comboPayload, 'second matching click should save the combo state');
  assert.equal(comboPayload.mqlComboState.override, true);
  assert.equal(comboPayload.mqlComboState.poolAddr, poolA);
  assert.equal(comboPayload.mqlComboState.totalSol, 1);

  // The journal read is intentionally completed after SPA navigation. The
  // callback must retain the original pool identity and avoid assigning the
  // resulting plan to the newly displayed pool.
  assert.equal(getRequests.length, 1);
  exports.setState({ pool: poolB });
  getRequests[0].callback({ mqlEntryPlan: {}, mqlOverrideJournal: [] });
  const journalPayload = setPayloads.find((payload) => payload.mqlOverrideJournal);
  assert.ok(journalPayload, 'override journal should be written');
  const entryPlan = journalPayload.mqlEntryPlan[poolA];
  const journal = journalPayload.mqlOverrideJournal[0];
  assert.ok(entryPlan);
  assert.equal(entryPlan.override, true);
  assert.ok(entryPlan.ignoredGates.includes('fee persistence'));
  assert.equal(entryPlan.totalSol, 1);
  assert.equal(journal.pool, poolA);
  assert.equal(journal.override, true);
  assert.equal(journal.totalSol, 1);
  assert.equal(journal.ts, entryPlan.ts, 'entry plan and override journal share the captured timestamp');
  assert.equal(Object.prototype.hasOwnProperty.call(journalPayload.mqlEntryPlan, poolB), false);
});
