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
    chrome.storage.sync.get({ jupApiKey: '', mqlWidthPct: 20 }, (items) => {
      if (chrome.runtime.lastError) return;
      $('jupApiKey').value = (items && items.jupApiKey) ? items.jupApiKey : '';
      const w = (items && items.mqlWidthPct != null) ? items.mqlWidthPct : 20;
      $('mqlWidthPct').value = w;
    });
  } catch (e) {
    showToast('Could not read settings', true);
  }
}

function save(e) {
  if (e) e.preventDefault();
  const jupApiKey = $('jupApiKey').value.trim();
  let mqlWidthPct = parseFloat($('mqlWidthPct').value);
  if (!isFinite(mqlWidthPct) || mqlWidthPct <= 0) mqlWidthPct = 20;
  try {
    chrome.storage.sync.set({ jupApiKey, mqlWidthPct }, () => {
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
