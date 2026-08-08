// tv-bridge.js — MAIN-world bridge to Meteora's TradingView chart.
//
// Runs at document_start in the page's own JS world (not the isolated content-
// script world), because the TradingView widget instance is a page variable the
// content script cannot see. A property hook on window.TradingView wraps the
// widget constructor and captures every instance Meteora creates.
//
// Protocol (window.postMessage, same tab):
//   { mql: 'tv-draw', marks: [{ t, pSol, side, text }], lastSol }  -> draw marks
//   { mql: 'tv-clear' }                                            -> remove all
//   { mql: 'tv-status' } <- bridge replies { mql:'tv-status', ready, drawn, err }
//
// Price-unit auto-calibration: the chart may plot SOL or USD. The bridge reads
// the chart's own last bar close and computes scale = chartClose / lastSol, then
// plots every mark at pSol * scale — correct in ANY display unit, no FX needed.
(function () {
  'use strict';
  if (window.__mqlTvBridge) return;
  window.__mqlTvBridge = true;

  var widgets = [];
  var shapes = [];
  var lastErr = null;

  function wrapCtor(O) {
    if (!O || O.__mqlWrapped) return O;
    // Proxy handles ES6 classes AND plain functions, and transparently forwards
    // prototype, statics, and instanceof - a hand-rolled wrapper does not.
    var P = new Proxy(O, {
      construct: function (t, a, nt) {
        var inst = Reflect.construct(t, a, nt === P ? t : nt);
        try { widgets.push(inst); } catch (e) {}
        return inst;
      },
      apply: function (t, th, a) {
        var r = Reflect.apply(t, th, a);
        try { if (r && r.onChartReady) widgets.push(r); } catch (e) {}
        return r;
      }
    });
    try { P.__mqlWrapped = true; } catch (e) {}
    return P;
  }

  function hook(TV) {
    try {
      if (!TV || TV.__mqlHooked) return;
      TV.__mqlHooked = true;
      // .widget may not exist yet when the TradingView object is first assigned -
      // a window setter can't see property writes on the object, so hook the
      // property itself to catch late assignment.
      var cur = wrapCtor(TV.widget);
      Object.defineProperty(TV, 'widget', {
        configurable: true,
        get: function () { return cur; },
        set: function (v) { cur = wrapCtor(v); }
      });
    } catch (e) { lastErr = 'hook: ' + e.message; }
  }

  // TradingView global usually loads after us — intercept the assignment.
  var _tv = window.TradingView;
  try {
    Object.defineProperty(window, 'TradingView', {
      configurable: true,
      get: function () { return _tv; },
      set: function (v) { _tv = v; hook(v); }
    });
  } catch (e) { lastErr = 'defineProperty: ' + e.message; }
  if (_tv) hook(_tv);

  function activeWidget() {
    for (var i = widgets.length - 1; i >= 0; i--) {
      try { if (widgets[i] && widgets[i].activeChart) return widgets[i]; } catch (e) {}
    }
    return null;
  }

  function clearShapes(chart) {
    for (var i = 0; i < shapes.length; i++) {
      try { if (chart && shapes[i].id) chart.removeEntity(shapes[i].id); } catch (e) {
        try { shapes[i].remove(); } catch (e2) {}
      }
    }
    shapes = [];
  }

  function draw(msg) {
    var w = activeWidget();
    if (!w) {
      // marks often arrive before Meteora creates the widget - reply so the
      // content script's retry loop knows to try again in a few seconds
      lastErr = 'no widget yet';
      window.postMessage({ mql: 'tv-status', ready: false, drawn: 0, err: lastErr }, '*');
      return;
    }
    try {
      w.onChartReady(function () {
        var chart;
        try { chart = w.activeChart(); } catch (e) {
          lastErr = 'activeChart: ' + e.message;
          window.postMessage({ mql: 'tv-status', ready: false, drawn: 0, err: lastErr }, '*');
          return;
        }
        clearShapes(chart);
        // unit calibration from the chart's own data
        var scale = 1;
        try {
          var done = false;
          chart.exportData({ includeTime: true, includedStudies: [] }).then(function (d) {
            try {
              var rows = d && d.data ? d.data : [];
              var last = rows[rows.length - 1];
              // schema: [time, open, high, low, close, ...]
              var chartClose = last ? Number(last[4]) : NaN;
              if (isFinite(chartClose) && chartClose > 0 && msg.lastSol > 0) scale = chartClose / msg.lastSol;
            } catch (e) {}
            place(chart, msg.marks || [], scale);
            done = true;
          }).catch(function () { place(chart, msg.marks || [], 1); });
          setTimeout(function () { if (!done && shapes.length === 0) place(chart, msg.marks || [], 1); }, 2500);
        } catch (e) {
          place(chart, msg.marks || [], 1);
        }
      });
    } catch (e) { lastErr = 'onChartReady: ' + e.message; }
  }

  // createExecutionShape is Trading-Platform-only (Meteora ships the Charting
  // Library tier - confirmed live: "only available on Trading Platform"). The
  // drawings API is available in this tier: shapes anchored to (time, price)
  // that the chart itself repositions on zoom/pan.
  //
  // fomo.family-style bubbles floating just above the candle. Premium look is
  // faked with concentric layers (the icon API is flat): soft outer glow, mid
  // glow, crisp dark rim, then a bright solid core - neon badge on dark chart.
  var STYLE9 = {
    buy:   { color: '#22c55e', glow: '34,197,94' },
    sell:  { color: '#ef4444', glow: '239,68,68' },
    entry: { color: '#38bdf8', glow: '56,189,248' },
    exit:  { color: '#fbbf24', glow: '251,191,36' }
  };
  var RIM = '#0d1117';   // matches Meteora's dark chart background
  function bubbleSize(usd) {
    if (!usd || usd <= 0) return 15;
    return Math.max(13, Math.min(30, Math.round(9 + 4.5 * Math.log10(usd))));
  }
  function circle(chart, pt, color, size) {
    var id = chart.createShape(pt, {
      shape: 'icon', icon: 0xf111, lock: true,
      disableSelection: true, disableSave: true, disableUndo: true,
      zOrder: 'top', overrides: { color: color, size: size }
    });
    if (id) shapes.push({ id: id });
    return id;
  }
  function place(chart, marks, scale) {
    var drawn = 0;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var st = STYLE9[m.side] || STYLE9.buy;
      var sz = bubbleSize(m.usd);
      // float just above the candle top
      var base = (m.pHigh || m.pSol) * scale;
      var pt = { time: Math.floor(m.t), price: base * 1.008 };
      try {
        circle(chart, pt, 'rgba(' + st.glow + ',0.16)', sz + 14);  // soft outer glow
        circle(chart, pt, 'rgba(' + st.glow + ',0.35)', sz + 7);   // mid glow
        circle(chart, pt, RIM, sz + 3);                             // crisp dark rim
        if (circle(chart, pt, st.color, sz)) drawn++;               // solid core
      } catch (e) { lastErr = 'shape: ' + e.message; }
    }
    window.postMessage({ mql: 'tv-status', ready: true, drawn: drawn, err: lastErr }, '*');
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || !ev.data.mql) return;
    if (ev.data.mql === 'tv-draw') draw(ev.data);
    else if (ev.data.mql === 'tv-clear') { try { clearShapes(activeWidget() && activeWidget().activeChart()); } catch (e) {} }
    else if (ev.data.mql === 'tv-status') {
      if (ev.data.ready === undefined) {
        window.postMessage({ mql: 'tv-status', ready: !!activeWidget(), drawn: shapes.length, err: lastErr }, '*');
      }
    }
  });
})();
