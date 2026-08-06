# Meteora Quant Lens

A read-only Chrome extension (Manifest V3) that overlays quant signals onto
[meteora.ag](https://www.meteora.ag) DLMM pool pages, then babysits the positions
you open and keeps exchange-grade books on every round trip.

**It never signs transactions and never touches your keys.** It fills forms,
raises flags, and sends alerts — every transaction goes through your own wallet
prompt.

---

## The one-paragraph version

LPing a DLMM pool is selling insurance: fees are your premium, impermanent loss
is the claim you pay when price moves. Meteora's UI shows you the premium and
hides the risk. Quant Lens measures the risk — real realized volatility from
price candles — divides the premium by it, and tells you whether you're being
overpaid or farmed. If you are overpaid, it hands you a specific trade recipe
with brackets. Once you're in, a separate layer anchored to *your* entry decides
when the trade is over. Every close is reconciled against on-chain truth so the
journal can eventually tell you which of its own opinions were right.

---

## Install

1. Clone or download this repo (green **Code** button → *Download ZIP* → unzip).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Open any DLMM pool page, e.g. `https://www.meteora.ag/dlmm/<poolAddress>`.
   If a Meteora tab was already open, refresh it once.

After any extension update, open tabs show *"⚡ Lens was updated — refresh this
page to reconnect"* with a one-click refresh. That's expected: Chrome orphans
the old script, and only a page reload reconnects it.

## Configure

Options page (`chrome://extensions` → *Details* → *Extension options*):

| Setting | Required? | What it unlocks |
|---|---|---|
| **Jupiter API key** | Yes | Token safety, organic flow, volatility, and all verdicts. Free at **portal.jup.ag**. Without it you get fee/TVL and surge/accel only. |
| **Wallet address(es)** | For exits | Position Watch reads your open positions via Meteora's API, so trades opened on *any* device (including mobile) get managed. Comma-separate up to 3 wallets. Public addresses only — never a key. |
| **Discord webhook** | Recommended | Remote alerts that work with no Meteora tab open: TP/SL, out-of-range, fee-decay, flow-flip, fill milestones, position-closed, and (optional toggle) board-wide radar signals. |
| **Helius API key** | Optional | All-in SOL PnL per trade (slippage, priority fees, rent included) plus a nightly wallet-vs-ledger reconciliation. Free at **dashboard.helius.dev**. |
| **Default range width W (%)** | Default 20 | The yardstick width used to quote EDGE when a recipe width isn't available. |

Meteora's data API needs no auth. Keys live only in `chrome.storage` — never in
this repo, never transmitted anywhere except the respective API.

---

## How it reads a pool

### σ — realized volatility (the foundation)

Everything else divides by this number, so it's measured rather than guessed.
Three estimators in a quality ladder, chosen automatically:

1. **EWMA realized vol** — the last ~4h of 5-minute candles, exponentially
   weighted (λ=0.9, ~33min half-life). Used whenever ≥6 returns exist.
2. **Parkinson** — for pools younger than ~35 minutes. Estimates vol from each
   candle's high-low *range*, which carries ~5x more information per candle, so
   it works from just 3 candles.
3. **Legacy single-print estimator** — last resort for pools under ~15 minutes
   old. **Displayed with a trailing `~`** (e.g. `σ 11487%/d ~`) because it both
   flaps wildly and systematically under-reads vol on calm prints. Trust it least.

### EDGE — the core number

```
edge = fee income ÷ expected IL   (at a given band width)
```

`≥1` means fees beat expected impermanent loss with a safety margin. `<1` means
the pool is farming you. Colored green / yellow / red at 1.0 / 0.5.

Two things worth understanding:

- **Edge scales linearly with band width.** A wider band suffers less IL per unit
  of vol, so the same pool quotes differently at ±20% vs ±35%. The headline EDGE
  uses your default W as a common yardstick; when a recipe exists, a second
  quote appears at the recipe's actual width (`±35%: 2.00`). That second number
  is the decision-relevant one.
- **Edge is inversely proportional to σ².** A vol estimate that's 20% too low
  inflates edge by ~56% — which is exactly why the σ ladder above matters.

### The rest of the HUD

- **Fee rate** — 1h fee/TVL annualized to %/day vs the 24h figure, with
  `▲ HEATING` / `▼ COOLING`.
- **Surge** — dynamic fee ÷ base fee (`≥1.25` = the pool's fee mechanism is
  ramping, i.e. a live catalyst).
- **Accel** — 30m volume run-rate ÷ 4h run-rate (`≥1.2` = volume accelerating).
- **Flow (OFI)** — organic sell ÷ buy volume. `<0.5` accumulation (green),
  `>2` distribution (red — real wallets are exiting through you).
- **Path** — price structure: `FREEFALL`, `BASING`, `BLOWOFF`, `GRIND-UP`, `CHOP`.
- **Token** — organic score, age, mint/freeze authority (⚠️ if still live), top-10
  holder concentration.
- **Edge sparkline** — 60 minutes of edge history with a dashed line at the 1.0
  gate, so you can see whether the current reading is a trend or a blip.
- **Form guardian** — under the range picker: the fee/day a `±W%` band needs to
  break even vs what the pool actually pays, plus a warning if Meteora's
  Auto-Fill silently resets your Min/Max range.

---

## The four setups

When the gates for a class all pass, the HUD shows a concrete recipe — shape,
width, brackets — and a **⚡ Apply** button that fills Meteora's own form.

### IGNITION — momentum scalp
Fresh catalyst with fees clearing IL. Requires edge ≥1.0, surge ≥1.25,
accel ≥1.2, organic score ≥40, not FREEFALL.
Width is σ-scaled (σ/4, clamped 12–30%). Hold: hours.

### BASING — straddle a floor
A token crashed ≥40% from its high, the 5-minute has flattened, and fees are
still rich (≥15%/day) with balanced-to-buying flow.

**The band's bottom is placed *on* the consolidation floor** (the recent 5m low),
not at a fixed width — so leaving the band downward *is* the base breaking, and
the structural stop sits just beneath it. Requires that floor to be within 25%
of price: if the nearest floor is a third of the way down, there is no base to
straddle and the setup is rejected. The PnL stop is a far backstop, not the
primary rule — a mean-reversion straddle is structurally long the dip, so a tight
PnL stop would fight its own premise.

### CARRY — park and collect
Mature (≥72h), calm, organic-buying pool that overpays for its risk. Requires
edge ≥1.3, 6h OFI <1.0, TVL ≥$100k, mint+freeze burned. Wide ±35% band chosen
for durability. Hold: days.

### SQUEEZE — long volatility
σ has compressed to ≤60% of its own trailing median for two consecutive reads
(data-gated: needs ≥6 readings over ≥45min). Bid-Ask shape with liquidity loaded
at the band edges, width derived from the *trailing* σ — the vol it coils back
to, not the compressed reading. **This is the one class with no edge gate**: edge
measures fee-vs-IL at *current* vol, and low current vol is the entire premise.
A 24h time-stop closes coils that never spring.

### 🪣 ACCUM COMBO — the dip-catcher
A deep single-sided SOL band below price (0 → -60..-75%, σ-scaled), built as
**two layers in one position**: a Bid-Ask base (~70-80%, bottom-weighted so you
buy more the deeper it dips) plus a Spot layer (uniform, so shallow dips still
fill and earn). Structurally a ladder of limit-buy orders that pays you to get
filled.

Hard gates: mint+freeze burned, top10 ≤35%, organic buyers present, volume
persisting, and not a dying knife. **⚡ Apply Combo** runs a guided two-leg flow
(create → wait for your signature → Add Liquidity panel for the Spot layer), and
state survives page reloads.

Accumulation books get their own rulebook: no scalp TP/SL, and price falling into
the band is *the design*, not a failure. The only kill-rule is the token dying
while you accumulate — fee-decay **and** flow-flip together.

**Take the warning seriously: if the token dies you own it the whole way down.
Size for total loss.**

### Cap-aware take-profits

A two-sided band's maximum price-driven gain is exactly **W/4** — above the band
you're 100% quote and done. Everything beyond that must come from fees. TPs are
computed against that cap rather than set optimistically, so a TP you see is a
number the position can actually reach. Pump-outs are booked by the OOR-UP rule
rather than by TP.

---

## Entry signal vs exit signal — read this once

**The verdict is an entry filter for new capital only.** It re-evaluates live and
*will* flicker around thresholds. A pool showing a valid entry and then "no edge"
five minutes later is normal — **not** a signal to exit a position you hold.

**Open positions are governed by POSITION WATCH** (the HOLD / WATCH / TIGHTEN /
EXIT card plus Discord alerts), anchored to *your* entry:

- **Fee-decay** — the 1h rate falls below 50% of your entry baseline **and**
  below the pool's own 24h normal, two reads running. (Both conditions matter:
  the scanner ranks by fee rate, so entries land on spikes, and a spike merely
  reverting to normal is not the fee engine dying.)
- **Flow-flip** — organic sellers >3:1 while price drops >15%/hour.
- **Brackets** — the TP/SL you actually entered on.
- **Structural stop** — the price level that invalidates the thesis.
- **Out of range** — no fee income; up books the gain, down cuts dead exposure.

When you enter via ⚡ Apply, the recipe's brackets and stop are **journaled per
pool**, and Position Watch enforces those exact numbers. A plan only binds to a
position created shortly after it, with a matching band width — so an Apply click
you never signed can't govern a later, differently-shaped trade.

---

## Alerts (Discord)

Work with **no Meteora tab open** — the background worker polls every minute
while Chrome is running.

**Position alerts:** approaching/hit TP, approaching/hit SL, out-of-range (both
directions), plan-stop broken, fee engine dying, distribution, TIGHTEN (claim
fees, consider trimming), FREEFALL, accumulation fill milestones (25/50/75%,
fully filled, popped above band), and position-closed with realized PnL.

**Radar pings** (optional toggle): board-wide scan every ~3 minutes; pings when a
pool passes every gate of a class. 2h cooldown per pool.

**Health alerts:** the extension monitors its own data quality and warns once per
6h if it's degraded (OHLCV failures, or legacy σ appearing on mature pools).
A tool that silently runs on bad data is worse than one that admits it.

---

## The journal — three grades of truth

Open the Options page and scroll to **Trade Journal**.

Every closed position is recorded with the context it was *entered* on (class,
edge, σ and which estimator produced it, fee baseline) and tagged by origin —
`signal`, `override`, or `untracked`. PnL is then resolved in three escalating
grades:

1. **Provisional** (instant) — computed from the position's on-chain events
   (`removes + fee claims − adds`) the moment the close is detected.
2. **Settled** (~30min+) — reconciled against Meteora's official closed-position
   rollup, SOL-denominated. This becomes the headline number and is marked
   `✓settled`. A mismatch >0.5% against the provisional figure gets flagged.
3. **Wallet-truth** (optional, needs Helius) — the *all-in* SOL round trip:
   swap slippage, priority fees, and the rent cycle included. Because rapid
   back-to-back trades can't be separated on-chain, this is computed per
   **session** (trades chained within 10 minutes) and labeled as such. If the
   numbers can't be attributed cleanly, the row says `unattributable` rather than
   printing something wrong.

Plus a **daily wallet reconciliation** (Helius): wallet SOL at UTC midnight vs
midnight, compared against the sum of that day's settled trades. Drift means
something the tracker missed — dust, a failed swap, an untracked mobile trade.
Trial balance against ledger.

**Also on that page:** the discretionary-override log (every time you entered on
a WAIT verdict, with the gates you ignored — your override track record), CSV
export of everything, and a **shadow log export**.

### Shadow log

Every radar evaluation — signal *or* rejection — is recorded with all its inputs.
This is the cure for survivorship bias: without the rejections you can never
learn whether rejecting them was right.

Export as JSONL and feed it to the companion CLI's `replay.cjs`
([dlmm-quant](https://github.com/fciaf420/dlmm-quant)), which simulates each
observation forward against real price paths and real fee series to produce
edge→outcome calibration curves. Hundreds of labeled observations per day versus
a handful of real trades per week.

---

## Design principles

Worth knowing, because they explain the behavior:

- **Never print a number you can't prove.** Where attribution is impossible the
  tool says `unattributable` instead of guessing.
- **Fail loudly, not silently.** Degraded data raises an alert. A broken DOM
  selector pings Discord. Orphaned tabs say so instead of showing stale numbers.
- **Trust what you ordered over what an indexer reports.** Position ranges are
  verified rather than assumed.
- **Persistence on noisy signals.** Fee-decay, out-of-range, and squeeze
  detection all require two consecutive reads — except when a position is
  already deep in loss and out of range, where waiting is the expensive choice.
- **Priors are labeled as priors.** Numbers that haven't been calibrated against
  real outcomes say so in the UI. The journal exists to eventually replace them
  with evidence.

---

## Developer notes

Content script ↔ background service worker message contract:

- `{ type: "getPoolData", pool }` → full metrics payload (see `background.js`)
- `{ type: "getBreakeven", pool, widthPct }` → `{ ok, breakevenFeePerDay, poolFeePerDay, clears }`
- `{ type: "getRadar" }` → board-wide scan results
- `{ type: "getMyPosition", pool }` → aggregated open positions across configured wallets

Pool data is cached 60s in memory **and** in `chrome.storage.session`, because
MV3 service workers unload after ~30s idle and would otherwise cold-refetch the
entire board on every alarm. All fetches use ~8s timeouts, degrade gracefully,
and never throw — failures return `{ ok: false, error }`.

Companion project: **[dlmm-quant](https://github.com/fciaf420/dlmm-quant)** — a
CLI trading daemon sharing the same signal engine (identical σ estimator, edge
math, class gates, and exit rules), but which executes autonomously rather than
alerting. This extension is the read-only surface of the same brain.

---

## Disclaimer

For informational purposes only. **Not financial advice.** Signals are heuristics
derived from public Meteora, Jupiter, and Helius data and can be wrong, stale, or
incomplete. Several thresholds are explicitly structured priors pending
calibration. DLMM liquidity provision carries real risk including impermanent
loss and total loss of capital — particularly ACCUM setups, which are designed to
end up holding the token. Do your own research and verify every number on-chain
before committing funds.
