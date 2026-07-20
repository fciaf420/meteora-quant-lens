# Meteora Quant Lens — MV3 Chrome Extension Spec (v0.1)

Overlay for meteora.ag DLMM pool pages that surfaces quant signals the UI hides. NO transaction signing, NO key custody — pure lens + warnings.

## Files & ownership
- AGENT A: manifest.json, background.js, lib shared INSIDE background.js (no module imports), options.html, options.js, options.css, README.md
- AGENT B: content.js, content.css (nothing else)
- Both plain vanilla JS (no build step, no external libs). Loadable via chrome://extensions "Load unpacked".

## Manifest (Agent A)
- MV3. content_scripts: matches ["https://www.meteora.ag/*", "https://meteora.ag/*"], js content.js, css content.css, run_at document_idle.
- background: service_worker background.js.
- permissions: ["storage"], host_permissions: ["https://dlmm.datapi.meteora.ag/*", "https://api.jup.ag/*"].
- options_page: options.html. Icons optional (omit to keep simple).

## Message contract (both agents MUST match exactly)
content -> background: chrome.runtime.sendMessage({ type: "getPoolData", pool: "<address>" })
background responds (sendResponse) with:
{
  ok: true,
  pool: { name, address, tvl, binStep, baseFeePct, currentPrice },
  feeRate1h,      // fee_tvl_ratio["1h"]*24, %/day  (fee_tvl_ratio values are ALREADY percent)
  feeRate24h,     // fee_tvl_ratio["24h"], %/day
  trend,          // "HEATING" | "COOLING" | "steady"  (feeRate1h vs feeRate24h, ±5%/40% rule: heating if 1h>=24h*1.05, cooling if 1h<=24h*0.6)
  surge,          // dynamic_fee_pct / pool_config.base_fee_pct
  accel,          // (volume["30m"]*48) / max(volume["4h"]*6, 1)
  sigma,          // age-aware realized vol %/day, see MATH
  edge,           // see MATH (computed with W = widthPct param or default 20)
  ofi1h, ofi6h,   // sellOrganicVolume/max(buyOrganicVolume,1) per window
  organicScore,   // 0-100
  tokenAgeHours,
  mintAuthorityDisabled, freezeAuthorityDisabled, topHoldersPct,
  path,           // "FREEFALL"|"BASING"|"BLOWOFF"|"GRIND-UP"|"CHOP"
  ddHigh, rangePos, dayLow,
  verdict,        // { class: "IGNITION"|"BASING"|"CARRY"|"NONE", reasons: [strings of passed/failed gates] }
  ts
}
On error: { ok:false, error }
Also: { type: "getBreakeven", pool, widthPct } -> { ok, breakevenFeePerDay, poolFeePerDay, clears: bool }
Background caches per pool 60s. Jupiter API key read from chrome.storage.sync key "jupApiKey" (set in options). If missing, Jupiter-derived fields null and verdict has reason "no Jupiter key (set in options)". Meteora datapi needs no auth.

## MATH (Agent A implements; keep EXACT)
- Data: GET https://dlmm.datapi.meteora.ag/pools/{address} ; GET .../pools/{address}/ohlcv (use latest candle) ; GET https://api.jup.ag/tokens/v2/search?query={token_x.address} header x-api-key.
- UNITS: fee_tvl_ratio values are already percent. feeRate1h = fee_tvl_ratio["1h"]*24.
- sigma: ageH = hours since token createdAt (Jupiter). pc5/pc1/pc24 = stats5m/1h/24h priceChange.
  ageH>=24: sigma = max(|pc5|*17, |pc1|*4.9, |pc24|). ageH<24: sigma = max(|pc5|*17, |pc1|*4.9, 60) (exclude pc24 = since-launch).
- edge = (feeRate1h*0.9/max(sigma,0.001)) / max(1.3*sigma/(8*W), 0.001)   with W in percent (default 20). NOTE 8*W: for W=20 the bar is 1.3*sigma/160.
- breakevenFeePerDay = sigma*sigma/(8*W) / 0.9 * 1.0   (gross fee/day needed so net fees = expected IL; report also with the 1.3 margin variant)
- path: ddHigh=(high-close)/high*100, rangePos=(close-low)/max(high-low,tiny) from latest OHLCV candle.
  FREEFALL: pc1<=-25 || (pc5<=-8 && pc1<0). BASING: ddHigh>=40 && |pc5|<5 && pc1>-15. BLOWOFF: rangePos>0.85 && pc1>40. GRIND-UP: pc1>0. else CHOP.
- verdict gates (report pass/fail per gate in reasons):
  IGNITION: edge>=1.0 && surge>=1.25 && accel>=1.2 && organicScore>=40 && path!="FREEFALL" && (ageH>=6 || (organicScore>=60 && ofi1h<2))
  BASING: path=="BASING" && ofi1h<=1.0 && organicScore>=60 && feeRate1h>=15 && edge>=0.5
  CARRY: edge>=1.3 && ofi6h<1.0 && organicScore>=60 && tvl>=100000 && ageH>=72 && mint+freeze disabled && (feeRate1h>=2 || (feeRate1h>=1.2 && edge>=2) || (feeRate1h>=0.6 && edge>=3 && sigma<10)) && path in (CHOP,BASING,GRIND-UP)
  Priority IGNITION > BASING > CARRY; else NONE with the top failed-gate summary.

## Content script (Agent B)
Pool address: parse location.pathname /dlmm/<address>. React SPA: watch URL changes (pushState hook + popstate) and DOM with MutationObserver; re-mount UI if removed. NEVER break the page: all code in try/catch, idempotent mounts (check for existing #mql-* ids).

### 1. HUD panel (id mql-hud)
Mount: insert near the top of the LEFT sidebar — anchor: the element [data-sentry-component="PoolDetails"] or the container holding [data-sentry-component="StatItem"]; insert the HUD before/above it. Compact dark card matching Meteora theme (bg #16161f, border #2a2a3a, radius 8px, font-size 12px, purple accent #7c6cf0).
Rows:
- VERDICT badge: big colored pill — IGNITION (orange), BASING (cyan), CARRY (green), NONE (gray "NO ENTRY"). Tooltip (title attr): reasons list.
- EDGE: number + bar; color green>=1, yellow 0.5-1, red <0.5. Subtext: "fees vs IL-breakeven"
- Fee rate: "1h rate X%/day vs 24h Y%" + arrow ▲HEATING/▼COOLING (green/red)
- σ: X%/day. Surge: X.XXx (green if >=1.25). Accel: X.XXx (green if >=1.2)
- Flow: "organic 1h OFI a / 6h b" — red if 1h>2 "distribution", green if <0.5 "accumulation"
- Path label + ddHigh% from high
- Token: org score, age, mint/freeze status (⚠️ red if authority live), top10 %
- Footer: "refreshed Xs ago" + refresh button. Poll every 60s while tab visible.

### 2. Fees/TVL truth badge
Find the leaf element whose text starts "24h Fees/TVL" in left sidebar; append small badge next to its value: "1h: X%/d ▲/▼" colored by trend. Id mql-feebadge, idempotent.

### 3. Form guardian (id mql-guard)
Anchor: right panel [data-sentry-component="RangePicker"] / its parent form area (also contains [data-sentry-component="Toggle"] (Auto-Fill), StrategySelection, BinPriceInput x2, "Total Bins:").
- Read current Min%/Max% from the two BinPriceInput textboxes (they contain percent strings like "-25.07%" in an input) — parse to get widthPct = (|min|+|max|)/2 approx; fallback 20.
- Render a status strip under the range inputs: "±W% needs ≥X%/day fees to breakeven — this pool pays Y%/day ✓/✗" (call getBreakeven with widthPct; re-query on input changes, debounced 500ms).
- AUTO-FILL RESET WARNING: observe the range inputs' values; if the Auto-Fill Toggle is clicked and within 2s the min/max % values jump to the ~default (-28.7/+40.26 style or Total Bins becomes 69/70), flash a warning banner: "⚠️ Auto-Fill reset your range — re-enter your Min/Max". Also generic: if Total Bins jumps to 69/70 after having been custom, warn.
- SINGLE-SIDED NOTICE: if one token amount input is 0/empty and range is entirely below current price (max<=0%), show info line: "Single-sided (DCA-IN): converts to base token as price falls — intended?"

### 4. Styling
content.css: all selectors prefixed #mql- or .mql-. Dark theme as above. No global resets. z-index sane (no overlay of modals).

## Options page (Agent A)
Simple dark page: Jupiter API key (password input, chrome.storage.sync "jupApiKey"), default width W (number, "mqlWidthPct", default 20), Save button + saved toast. Note: "Free key at portal.jup.ag".

## README (Agent A)
Install (load unpacked), configure key, what each element means, disclaimer.
