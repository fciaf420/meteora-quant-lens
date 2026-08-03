'use strict';

const $ = (id) => document.getElementById(id);

function showToast(text, isError) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2000);
}

function load() {
  try {
    chrome.storage.sync.get({ jupApiKey: '', mqlWidthPct: 20, webhookUrl: '', walletAddress: '', radarAlerts: false, heliusApiKey: '' }, (items) => {
      if (chrome.runtime.lastError) return;
      $('jupApiKey').value = (items && items.jupApiKey) ? items.jupApiKey : '';
      if ($('heliusApiKey')) $('heliusApiKey').value = items.heliusApiKey || '';
      const w = (items && items.mqlWidthPct != null) ? items.mqlWidthPct : 20;
      $('mqlWidthPct').value = w;
      if ($('webhookUrl')) $('webhookUrl').value = items.webhookUrl || '';
      if ($('walletAddress')) $('walletAddress').value = items.walletAddress || '';
      if ($('radarAlerts')) $('radarAlerts').checked = !!items.radarAlerts;
    });
  } catch (e) {
    showToast('Could not read settings', true);
  }
}

function save(e) {
  if (e) e.preventDefault();
  const jupApiKey = $('jupApiKey').value.trim();
  const webhookUrl = $('webhookUrl') ? $('webhookUrl').value.trim() : '';
  const walletAddress = $('walletAddress') ? $('walletAddress').value.trim() : '';
  const radarAlerts = $('radarAlerts') ? $('radarAlerts').checked : false;
  const heliusApiKey = $('heliusApiKey') ? $('heliusApiKey').value.trim() : '';
  let mqlWidthPct = parseFloat($('mqlWidthPct').value);
  if (!isFinite(mqlWidthPct) || mqlWidthPct <= 0) mqlWidthPct = 20;
  try {
    chrome.storage.sync.set({ jupApiKey, mqlWidthPct, webhookUrl, walletAddress, radarAlerts, heliusApiKey }, () => {
      if (chrome.runtime.lastError) {
        showToast('Save failed: ' + chrome.runtime.lastError.message, true);
      } else {
        showToast('Saved \u2713', false);
      }
    });
  } catch (err) {
    showToast('Save failed', true);
  }
}

// ---- Trade Journal (read-only view of mqlTradeLog + mqlOverrideJournal) ----
function fmtTs(t) { const d = new Date(t); return d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function poolLink(pool, name) {
  const a = document.createElement('a');
  a.href = 'https://www.meteora.ag/dlmm/' + pool; a.target = '_blank'; a.rel = 'noopener';
  a.textContent = name || (pool ? pool.slice(0, 8) + '…' : '?');
  return a;
}
function row(tbl, cells) {
  const tr = document.createElement('tr');
  for (const c of cells) { const td = document.createElement('td'); if (c instanceof Node) td.appendChild(c); else td.textContent = c == null ? '—' : String(c); tr.appendChild(td); }
  tbl.querySelector('tbody').appendChild(tr);
  return tr;
}
let jrRaw = { log: [], ovr: [] };
function loadJournal() {
  try {
    chrome.storage.local.get({ mqlTradeLog: [], mqlOverrideJournal: [] }, (st) => {
      if (chrome.runtime.lastError) return;
      const log = st.mqlTradeLog || [], ovr = st.mqlOverrideJournal || [];
      jrRaw = { log, ovr };
      const closes = log.filter((x) => x.closedDetected != null).slice().reverse();
      const recons = log.filter((x) => x.kind === 'daily_recon').slice().reverse();
      for (const x of recons.slice(0, 14)) {
        const drift = Math.round((x.deltaSol - x.settledTradeSol) * 1e6) / 1e6;
        const tr2 = row($('jrRecon'), [x.date, x.wallet.slice(0, 6) + '…', Number(x.startSol).toFixed(3) + ' → ' + Number(x.endSol).toFixed(3),
          (x.deltaSol >= 0 ? '+' : '') + Number(x.deltaSol).toFixed(4), (x.settledTradeSol >= 0 ? '+' : '') + Number(x.settledTradeSol).toFixed(4),
          (drift >= 0 ? '+' : '') + drift.toFixed(4) + (Math.abs(drift) > 0.01 ? ' ⚠' : ' ✓')]);
        if (Math.abs(drift) > 0.01) tr2.children[5].className = 'jr-neg';
      }
      const opens = log.filter((x) => x.type === 'COMBO_OPEN').slice().reverse();
      // grade order: official settled (SOL-denominated, Meteora's own rollup) >
      // event-derived provisional (USD) > watcher's last-seen guess
      const bestPnl = (x) => Number(x.officialPnlSolPct != null ? x.officialPnlSolPct : (x.realizedPnlPct != null ? x.realizedPnlPct : x.lastSeenPnlPct));
      const pnls = closes.map(bestPnl).filter(isFinite);
      const wins = pnls.filter((p) => p > 0).length;
      const sum = pnls.reduce((a, b) => a + b, 0);
      $('jrStats').textContent = pnls.length
        ? (pnls.length + ' round trips · ' + wins + 'W/' + (pnls.length - wins) + 'L (' + Math.round(wins / pnls.length * 100) + '%) · avg ' + (sum / pnls.length).toFixed(1) + '% · sum ' + sum.toFixed(1) + '% · realized (on-chain events) where available, else last-seen')
        : 'No round trips journaled yet. Closes are detected by Position Watch (wallet address required).';
      for (const x of closes.slice(0, 50)) {
        const pnl = bestPnl(x);
        let pnlTxt = isFinite(pnl) ? (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%' : '—';
        if (x.officialPnlSolPct != null) {
          pnlTxt += ' SOL (' + (x.officialPnlSol >= 0 ? '+' : '') + Number(x.officialPnlSol).toFixed(4) + ' ◎) ✓settled' + (x.reconMismatch ? ' ⚠' : '');
          if (x.walletPnlSol != null) pnlTxt += ' · ' + (String(x.walletTruth).indexOf('cluster') === 0 ? x.walletTruth + ' all-in ' : 'all-in ') + (x.walletPnlSol >= 0 ? '+' : '') + Number(x.walletPnlSol).toFixed(4) + ' ◎ (friction ' + (x.frictionSol >= 0 ? '+' : '') + Number(x.frictionSol || 0).toFixed(4) + ')';
          else if (x.walletTruth === 'unattributable') pnlTxt += ' · wallet-truth: n/a (other wallet activity in window)';
        }
        else if (x.realizedPnlUsd != null) pnlTxt += ' ($' + (x.realizedPnlUsd >= 0 ? '+' : '') + Number(x.realizedPnlUsd).toFixed(2) + ') · provisional';
        else if (isFinite(pnl)) pnlTxt += ' (last seen)';
        var entryTxt = '—';
        if (x.entryOrigin === 'override') entryTxt = (x.entryCls || '?') + ' OVERRIDE' + (x.entryEdge != null ? ' @ ' + Number(x.entryEdge).toFixed(2) : '');
        else if (x.entryOrigin === 'signal') entryTxt = (x.entryCls || '?') + (x.entryEdge != null ? ' @ ' + Number(x.entryEdge).toFixed(2) : '') + (x.entrySigma != null ? ' σ' + Math.round(x.entrySigma) : '');
        const tr = row($('jrCloses'), [fmtTs(x.closedDetected), poolLink(x.pool, x.name), pnlTxt, (x.holdMinutes != null ? (x.holdMinutes >= 90 ? (x.holdMinutes / 60).toFixed(1) + 'h' : x.holdMinutes + 'm') : '—'), entryTxt]);
        if (isFinite(pnl)) tr.children[2].className = pnl >= 0 ? 'jr-pos' : 'jr-neg';
      }
      for (const x of opens.slice(0, 30)) {
        row($('jrOpens'), [fmtTs(x.finishedAt || x.startedAt), poolLink(x.pool, null), (x.totalSol != null ? x.totalSol : '—'), (x.depth != null ? '-' + x.depth + '%' : '—'), (x.share != null ? Math.round(x.share * 100) + '%' : '—')]);
      }
      for (const x of (ovr || []).slice().reverse().slice(0, 30)) {
        row($('jrOverrides'), [fmtTs(x.ts), poolLink(x.pool, null), x.cls || '—', (x.edge != null ? Number(x.edge).toFixed(2) : '—'), (x.sigma != null ? Math.round(x.sigma) : '—'), (x.feeRate1h != null ? Number(x.feeRate1h).toFixed(1) : '—'), (x.ignoredGates || []).join(', ') || '—']);
      }
    });
  } catch (e) {}
}
function exportCsv() {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = ['kind,ts,pool,name,pnlPct,realizedPnlPct,realizedPnlUsd,feesUsd,officialPnlSolPct,officialPnlSol,officialPnlUsd,settled,holdMinutes,entryOrigin,entryCls,entryEdge,entrySigma,entrySigmaSource,entryFeeRateAtOpen,totalSol,depth,share,cls,edge,sigma,feeRate1h,ignoredGates'];
  for (const x of jrRaw.log) {
    if (x.closedDetected != null) lines.push(['close', new Date(x.closedDetected).toISOString(), x.pool, x.name, x.lastSeenPnlPct, x.realizedPnlPct, x.realizedPnlUsd, x.feesUsd, x.officialPnlSolPct, x.officialPnlSol, x.officialPnlUsd, x.settled, x.holdMinutes, x.entryOrigin, x.entryCls, x.entryEdge, x.entrySigma, x.entrySigmaSource, x.entryFeeRateAtOpen, '', '', '', '', '', '', '', ''].map(esc).join(','));
    else if (x.type === 'COMBO_OPEN') lines.push(['combo_open', new Date(x.finishedAt || x.startedAt).toISOString(), x.pool, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', x.totalSol, x.depth, x.share, '', '', '', '', ''].map(esc).join(','));
  }
  for (const x of jrRaw.ovr) lines.push(['override', new Date(x.ts).toISOString(), x.pool, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', x.cls, x.edge, x.sigma, x.feeRate1h, (x.ignoredGates || []).join('|')].map(esc).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meteora-lens-journal-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportShadow() {
  chrome.storage.local.get({ mqlShadow: [] }, (st) => {
    const rows = st.mqlShadow || [];
    if (!rows.length) { showToast('Shadow log is empty — it fills as the radar runs', true); return; }
    const blob = new Blob([rows.map((r) => JSON.stringify(r)).join('\n') + '\n'], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shadow-lens-' + new Date().toISOString().slice(0, 10) + '.jsonl';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  loadJournal();
  const form = $('mql-form');
  if (form) form.addEventListener('submit', save);
  if ($('jrExport')) $('jrExport').addEventListener('click', exportCsv);
  if ($('shExport')) $('shExport').addEventListener('click', exportShadow);
  try { chrome.storage.local.get({ mqlShadow: [] }, (st) => { if ($('shCount')) $('shCount').textContent = (st.mqlShadow || []).length + ' observations collected'; }); } catch (e) {}
});

document.addEventListener('DOMContentLoaded', () => {
  const t = $('testWebhook');
  if (t) t.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'testWebhook' }, (r) => {
      t.textContent = (r && r.ok) ? '\u2713 sent — check Discord' : ('\u2717 ' + ((r && r.error) || 'failed — save the URL first'));
      setTimeout(() => { t.textContent = 'Send test alert'; }, 4000);
    });
  });
});
