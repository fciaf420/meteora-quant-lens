# Meteora Quant Lens

A read-only Chrome extension (Manifest V3) that overlays quant signals on
[meteora.ag](https://www.meteora.ag) DLMM pool pages. It surfaces fee/vol/flow
math the stock UI hides and warns you about range-reset foot-guns.

**It never signs transactions and never touches your keys.** Pure lens + warnings.

## Install (Load Unpacked)

1. Clone/download this folder (`meteora-lens/`).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `meteora-lens/` folder.
5. Open any DLMM pool page, e.g. `https://www.meteora.ag/dlmm/<poolAddress>`.

## Configure

Open the extension **Options** page (via `chrome://extensions` → *Details* →
*Extension options*) and set:

- **Jupiter API key** — required for token, flow, volatility, and verdict signals.
  Grab a free key at **portal.jup.ag**. Without it, the HUD still shows fee/TVL
  and surge/accel from Meteora, but Jupiter-derived fields stay blank and the
  verdict reads `no Jupiter key (set in options)`.
- **Default range width W (%)** — used for the edge / breakeven math when the
  pool page's range width can't be read. Default `20`.

Meteora's data API needs no auth.

## What each element means

- **VERDICT** — the top-line call:
  - `IGNITION` (orange): fresh momentum with fees clearing IL and healthy organic flow.
  - `BASING` (cyan): deep pullback that's stabilized while fees stay rich.
  - `CARRY` (green): mature, safe pool paying enough fees to hold a wide range.
  - `NO ENTRY` (gray): no setup; hover for the closest gate and what failed.
- **EDGE** — fee income vs IL-breakeven. `≥1` green (fees beat IL), `0.5–1`
  yellow, `<0.5` red.
- **Fee rate** — annualized-to-daily 1h fee/TVL vs the 24h number, with a
  `▲ HEATING` / `▼ COOLING` trend arrow.
- **σ (sigma)** — age-aware realized volatility in %/day; new tokens are floored
  higher to avoid under-pricing launch risk.
- **Surge** — dynamic fee vs base fee multiple (`≥1.25` = fees ramping).
- **Accel** — 30m volume run-rate vs the 4h run-rate (`≥1.2` = accelerating).
- **Flow (OFI)** — organic sell/buy volume ratio per window. `<0.5` accumulation
  (green), `>2` distribution (red).
- **Path** — price structure: `FREEFALL`, `BASING`, `BLOWOFF`, `GRIND-UP`, `CHOP`.
- **Token** — organic score, age, mint/freeze authority status (⚠️ if still
  live), and top-10 holder concentration.
- **Form guardian** — under the range picker, tells you the fee/day a `±W%`
  range needs to breakeven vs what the pool pays, and flashes a warning if
  Auto-Fill silently resets your Min/Max range.

## Message contract (for developers)

The content script talks to the background service worker:

- `{ type: "getPoolData", pool }` → full metrics payload (see `background.js`).
- `{ type: "getBreakeven", pool, widthPct }` → `{ ok, breakevenFeePerDay, poolFeePerDay, clears }`.

Pool data is cached per address for 60 seconds. All fetches use ~8s timeouts and
degrade gracefully; failures return `{ ok: false, error }` and never throw.

## Disclaimer

This tool is for informational purposes only. It is **not** financial advice.
Signals are heuristics derived from public Meteora and Jupiter data and can be
wrong, stale, or incomplete. DLMM liquidity provision carries real risk including
impermanent loss and total loss of capital. Always do your own research and
verify every number on-chain before committing funds.

## v0.4.0 — ACCUM COMBO

The popular "dip-catcher" build: a deep single-sided SOL band below price (0 → -60..-75%), created as **two legs in the same range** — a Bid-Ask base (~70%, bottom-weighted so you buy more the deeper it dips) + a Spot layer (~30%, uniform so shallow dips still fill and earn).

- **HUD block** (🪣 ACCUM COMBO): appears only when the hard gates pass — mint+freeze burned, top10 ≤ 35%, organic buyers present, volume persisting (1h fee rate ≥ 50% of 24h, 24h ≥ 8%/day), and not a dying knife (FREEFALL with organic sellers ≥ 1.43:1 is blocked). Depth is σ-scaled (σ≥150 → -75%, σ≤80 → -60%, ATH/drawdown-nudged); the Bid-Ask share scales with σ and flow (clamped 60–80%). All thresholds are structured priors pending calibration.
- **⚡ Apply Combo**: guided two-leg flow with a step banner — fills Bid-Ask + range + SOL amount for leg 1, waits for your signature (auto-detects the new position via the saved-wallet API, or use the ✓ button), then re-fills the form for the Spot layer. State survives page reloads; ✕ aborts anytime. The extension never signs anything.
- **Position Watch**: multiple positions in one pool render as a single **COMBO ×N** card (aggregate PnL, combined band, per-leg lines). Accumulation books get their own rulebook — no scalp TP/SL; verdicts are HOLD (filling, volume alive) / WATCH (fee trend softening) / EXIT (fee-decay AND flow-flip — the token is dying while you accumulate). A fill bar tracks how much of the band has converted from SOL into the token.
- **Discord alerts** (accum-flavored): band 25/50/75% filled, FULLY FILLED (decide: hold or cut), popped above band (100% SOL + fees banked), and the dying-token alerts.
