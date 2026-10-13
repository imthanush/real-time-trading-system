# Real-Time Trading System: Branch Prediction, CPI Analysis and Low-Latency Decision Making

**Course:** Computer Organisation and Architecture (IACSI203)  
**Platform:** macOS, modern browsers, vanilla HTML/CSS/JavaScript  
**Dependencies:** none to install; local Chart.js (`chart.umd.min.js`)

This is an **educational simulation**, not a brokerage and not investment advice. Prices, volumes, and benchmark names are synthetic.

---

## 1. Purpose

The dashboard lets a student watch three layers together:

1. A rule-based SMA trading signal (BUY / SELL / HOLD).
2. A **1-bit last-outcome branch predictor** driven by those signals as a *proxy* branch stream.
3. Textbook **CPI and cycle counts** for a 1,000-instruction model, plus browser JavaScript timing.

It does **not** measure a physical CPU, accelerate hardware, or place real orders.

---

## 2. Project structure

```
COA/
├── index.html          # Terminal layout and views
├── styles.css          # Deep-navy design system
├── script.js           # Data, indicators, predictor, CPI, UI
├── chart.umd.min.js    # Local Chart.js (offline charts)
├── tests.py            # Automated formula and regression suite
└── README.md
```

Modules in `script.js`: `DataManager`, `IndicatorEngine`, `SignalEngine`, `BranchPredictor`, `CPIAnalyser`, `LatencyTracker`, `DashboardUI`, `App`.

---

## 3. Requirements

- A current browser (Safari, Chrome, or Firefox).
- Python 3 only if you want to run `tests.py` or a local HTTP server.
- No npm, no accounts, no API keys.

---

## 4. Run on macOS

```bash
cd /Users/thanush/Documents/COA
open index.html
```

Or double-click `index.html` in Finder.

## 5. Optional local server

```bash
cd /Users/thanush/Documents/COA
python3 -m http.server 8080
```

Open `http://localhost:8080`.

The app is meant to work **offline**. Charts load from `chart.umd.min.js` in this folder. If Chart.js is missing, cards and tables still work; canvases show a fallback message.

## 6. Automated tests

```bash
cd /Users/thanush/Documents/COA
python3 tests.py
```

---

## 7. Dashboard features

| Control | What it does |
|---|---|
| **Analyse Custom Input** | Parses CSV prices (required) and volumes (optional), then updates indicators, chart, and latest signal. Resets the predictor. |
| **Run Branch Simulation Over Dataset** | Maps each period’s signal to T/N, runs the 1-bit predictor from a clean warm-up, then fills history, accuracy, and measured CPI. |
| **Load Built-in Dataset** | Restores the 20-period lab series. |
| **Generate New Dataset** | Seeded random-walk simulation (not live market data). |
| **Reset Branch Predictor** | Clears hits/misses/history. Baseline and 90% reference CPI stay visible; measured CPI returns to N/A. |
| **SMA window / HOLD tolerance** | Recalculate signals. The predictor is reset because the T/N stream may change. |
| **Chart 5P / 10P / 15P / ALL** | Slices the line chart. If a simulation already ran, predictor stats are preserved. |
| **Search / ticker cards** | Load labeled *simulated* series (NIFTY 50, SENSEX, BANK NIFTY, USD/INR). |
| **Sidebar** | Overview, data table, signal rules, predictor notes, CPI derivations, signal counts, simulation review, lab notes, assumptions. |

Changing the dataset always refreshes dependent cards. Re-running the simulation is idempotent (it resets first, so counts do not double).

---

## 8. Trading-signal rule

Tolerance is a **percentage of SMA**, not a dollar amount:

- **HOLD** if SMA is unavailable, or `|Price − SMA| / SMA ≤ tolerance`.
- **BUY** if price is above SMA by more than the tolerance.
- **SELL** if price is below SMA by more than the tolerance.
- Equality at the band edge is HOLD.

A W-period SMA uses exactly the last W prices. It never includes future observations. The last point’s signal is the badge on the overview; every period’s signal is listed under Market Data.

---

## 9. Branch predictor algorithm

Implemented algorithm: **one-bit last-outcome**.

1. The first actual outcome warms up the predictor. It is **not** a hit or miss.
2. Each later outcome is predicted as the previous actual outcome.
3. The prediction is compared with the current actual outcome.
4. Every evaluated prediction increments exactly one of hit or miss.

Accuracy = hits / evaluated predictions × 100. If there are no evaluated predictions, accuracy is **N/A**, not 0% or 100%.

---

## 10. Signal-to-branch mapping (educational proxy)

| Signal | Branch proxy |
|---|---|
| BUY | T (taken) |
| SELL | N (not taken) |
| HOLD | N (not taken) |

This is **not** a claim that a stock signal is a processor branch in a real trading engine.

---

## 11. CPI formulas and fixed assumptions

| Parameter | Value | Role |
|---|---|---|
| Base CPI | 1.0 | Ideal CPI with no branch stalls |
| Branch frequency | 0.25 | Used in the *reference* (rate-based) formula |
| Misprediction penalty | 3 cycles | Extra cycles per miss |
| Reference accuracy | 90% | Assumed hardware target — **not** measured accuracy |
| Instruction count N | 1,000 | Workload used for cycle cards |

**Reference / baseline (rate-based):**

```
CPI = Base CPI + Branch frequency × Misprediction rate × Penalty
```

- No prediction (rate = 1.00): `1 + 0.25 × 1.00 × 3 = 1.750` → **1,750 cycles**
- 90% reference (rate = 0.10): `1 + 0.25 × 0.10 × 3 = 1.075` → **1,075 cycles**
- Savings = 1,750 − 1,075 = **675 cycles**
- Reduction = 675 / 1,750 × 100 ≈ **38.57%**
- Speedup = 1,750 / 1,075 ≈ **1.628×** (this is not the percentage reduction)

**Rounding policy:** hit/miss counters are integers. Extra modeled cycles = `misses × 3`. Internal math uses full floating precision; the UI rounds only for display.

---

## 12. Measured CPI vs reference CPI

**Measured CPI does not use the 90% assumption.** It uses the instruction-count model:

```
Measured CPI = Base CPI + (Mispredictions × Penalty) / N
```

Mispredictions are the integer miss count from the simulator. N is 1,000 modeled instructions — **not** the number of evaluated predictor steps, and **not** “each prediction is one instruction.”

Example: 19 evaluated predictions and 5 misses:

```
CPI = 1 + (5 × 3) / 1000 = 1.015
Cycles = 1,015
Savings vs baseline = 735
```

If no predictions have been evaluated, measured CPI, cycles, savings, and speedup are **N/A**.

---

## 13. Modeled cycles vs browser runtime

| Quantity | What it is |
|---|---|
| Cycle cards | Textbook model: `cycles = N × CPI` |
| Accuracy / hits / misses | Counts from the JS predictor simulation |
| Latency chip (`performance.now()`) | Time to run analysis in **this browser** |

Do not read the millisecond chip as hardware CPI or as exchange latency.

---

## 14. Synthetic-data limitations

- Built-in, generated, and named “index” series are simulated.
- SMA crossover is the only trading rule.
- The predictor is a 1-bit last-outcome model, not Gshare or a tournament predictor.
- Branch frequency and penalty are textbook constants, not `perf` counters.

---

## 15. Other known limitations

- Maximum 500 CSV values so the page stays responsive.
- Chart.js is required for plots; without it, numeric panels still work.
- Search only finds the four bundled simulated series.
- Signal Summary / Simulation Review show counts from *this* dataset, not a cash P&L book.

---

## 16. Short demonstration workflow

1. Open `index.html` (built-in 20-period series loads automatically).
2. Point at Current Price, SMA, and the BUY/SELL/HOLD badge. Accuracy should still say **N/A — awaiting predictions**.
3. Click **Run Branch Simulation Over Dataset**. Expect 19 evaluated predictions, 14 hits, 5 misses on the default 5-period SMA and 0.5% tolerance; measured CPI **1.0150**.
4. Show baseline **1.7500 / 1,750** and 90% reference **1.0750 / 1,075 / 675 / 38.57%**. Stress that 90% is the reference, not this run’s 73.68% accuracy.
5. Click **Reset Branch Predictor** and confirm measured metrics return to N/A while 1.750 and 1.075 remain.
6. Optionally paste custom prices, or generate a new simulated series, then run the simulation again.
7. Open **Assumptions** if a marker asks about constants.

---

## How the pieces connect

```
CSV / built-in / generated series
        → SMA, ΔP, %Δ, volume Δ
        → BUY / SELL / HOLD
        → T / N proxy stream
        → 1-bit predictor (warm-up, then last outcome)
        → measured CPI from miss count
        → charts, tables, latency chip
```
