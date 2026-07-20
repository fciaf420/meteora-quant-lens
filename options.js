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
    chrome.storage.sync.get({ jupApiKey: '', mqlWidthPct: 20, webhookUrl: '', walletAddress: '', radarAlerts: false }, (items) => {
      if (chrome.runtime.lastError) return;
      $('jupApiKey').value = (items && items.jupApiKey) ? items.jupApiKey : '';
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
  let mqlWidthPct = parseFloat($('mqlWidthPct').value);
  if (!isFinite(mqlWidthPct) || mqlWidthPct <= 0) mqlWidthPct = 20;
  try {
    chrome.storage.sync.set({ jupApiKey, mqlWidthPct, webhookUrl, walletAddress, radarAlerts }, () => {
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

document.addEventListener('DOMContentLoaded', () => {
  load();
  const form = $('mql-form');
  if (form) form.addEventListener('submit', save);
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
