/* ============================================================
   Real-Time Trading System — Branch Prediction & CPI Analysis
   script.js  |  IACSI203 COA Project

   Architecture:
     DataManager     – generates and validates price/volume data
     IndicatorEngine – computes SMA, price change, volume change
     SignalEngine    – produces BUY / SELL / HOLD with reason
     BranchPredictor – last-outcome (1-bit) branch predictor
     CPIAnalyser     – CPI formula and cycle calculations
     LatencyTracker  – performance.now() based timing
     DashboardUI     – Chart.js rendering and DOM updates
*/

'use strict';

/* ============================================================
   CONSTANTS – Model Assumptions (single source of truth)
   ============================================================ */
const MODEL = {
  BASE_CPI:          1.0,   // Ideal CPI without branch overhead
  BRANCH_FREQUENCY:  0.25,  // 25% of instructions are branches (model assumption)
  MISPRED_PENALTY:   3,     // Extra cycles per misprediction (model assumption)
  REF_ACCURACY:      0.90,  // Reference 90%-accurate predictor (NOT measured accuracy)
  INSTRUCTION_COUNT: 1000,  // Modeled instruction count for cycle calculations
  MAX_POINTS:        500,   // Hard cap to keep the UI responsive
  MIN_PRICES:        3,
  DEFAULT_SMA:       5,
  DEFAULT_TOLERANCE: 0.005, // 0.5% relative HOLD band
};

/* Rounding policy (documented and applied consistently):
   - Branch hit/miss counters are integers.
   - Modeled extra cycles = integer_mispredictions × MISPRED_PENALTY.
   - Measured CPI uses INSTRUCTION_COUNT as the denominator (the 1,000-instruction
     demonstration model), not the number of evaluated predictor steps.
   - Full precision is kept internally; values are rounded only for display.
   - SMA values are rounded to 4 decimal places for stable comparisons.
*/

/* ============================================================
   UTILITY HELPERS
   ============================================================ */
function round(n, dp = 4) {
  if (n === null || n === undefined || !isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Safe division – returns 0 when denominator is zero or non-finite. */
function safeDivide(numerator, denominator) {
  if (denominator === 0 || !isFinite(denominator) || !isFinite(numerator)) return 0;
  return numerator / denominator;
}

function fmt(n, dp = 2) {
  if (n === null || n === undefined || !isFinite(n)) return 'N/A';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function escapeText(value) {
  return String(value);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = !!busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/* ============================================================
   DATA MANAGER
   ============================================================ */
const DataManager = (() => {
  /**
   * Built-in repeatable simulated dataset.
   * These are NOT real market prices; they are illustrative.
   */
  const BUILTIN_PRICES  = [142, 145, 143, 148, 150, 147, 152, 155, 153, 158,
                            161, 159, 163, 166, 164, 169, 171, 168, 174, 178];
  const BUILTIN_VOLUMES = [2400, 2600, 2300, 2800, 3100, 2750, 3200, 3400, 3100, 3600,
                           3900, 3700, 4000, 4300, 4100, 4500, 4700, 4400, 5000, 5300];

  function generateDataset(seed = 42, count = 20) {
    const n = Math.max(MODEL.MIN_PRICES, Math.min(MODEL.MAX_POINTS, count | 0));
    const prices  = [];
    const volumes = [];
    let price  = 100 + (seed % 50);
    let volume = 2000 + (seed % 1000);
    let s = seed;
    const lcg = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };

    for (let i = 0; i < n; i++) {
      const change  = (lcg() - 0.47) * 8;
      price  = Math.max(10, round(price + change, 2));
      const volChange = (lcg() - 0.45) * 400;
      volume = Math.max(500, Math.round(volume + volChange));
      prices.push(price);
      volumes.push(volume);
    }
    return { prices, volumes, seed };
  }

  /**
   * Parse a comma-separated string of numbers.
   * @returns {number[]}
   */
  function parseCSV(str, label = 'values', min = MODEL.MIN_PRICES) {
    if (str === null || str === undefined || String(str).trim() === '') {
      throw new Error(`${label}: input is empty. Enter comma-separated positive numbers.`);
    }
    const parts = String(str).split(',').map(s => s.trim()).filter(s => s !== '');
    if (parts.length < min) {
      throw new Error(`${label}: need at least ${min} values (got ${parts.length}).`);
    }
    if (parts.length > MODEL.MAX_POINTS) {
      throw new Error(`${label}: too many values (${parts.length}). Maximum is ${MODEL.MAX_POINTS} to keep the demo responsive.`);
    }
    const nums = parts.map((p, i) => {
      const n = Number(p);
      if (!isFinite(n)) throw new Error(`${label}: "${p}" at position ${i + 1} is not a valid finite number.`);
      if (n <= 0)        throw new Error(`${label}: value at position ${i + 1} must be positive (got ${n}).`);
      return n;
    });
    return nums;
  }

  return { BUILTIN_PRICES, BUILTIN_VOLUMES, generateDataset, parseCSV };
})();

/* ============================================================
   INDICATOR ENGINE
   ============================================================ */
const IndicatorEngine = (() => {
  function computeSMA(prices, window) {
    if (!Array.isArray(prices) || !isFinite(window) || window < 1) {
      return Array.isArray(prices) ? prices.map(() => null) : [];
    }
    const w = Math.floor(window);
    return prices.map((_, idx) => {
      if (idx < w - 1) return null;
      const slice = prices.slice(idx - w + 1, idx + 1);
      if (slice.some(v => !isFinite(v))) return null;
      return round(slice.reduce((a, b) => a + b, 0) / w, 4);
    });
  }

  function computePriceChange(prices) {
    if (!Array.isArray(prices)) return [];
    return prices.map((p, i) => {
      if (i === 0) return null;
      if (!isFinite(p) || !isFinite(prices[i - 1])) return null;
      return round(p - prices[i - 1], 4);
    });
  }

  function computePctChange(prices) {
    if (!Array.isArray(prices)) return [];
    return prices.map((p, i) => {
      if (i === 0) return null;
      const prev = prices[i - 1];
      if (!isFinite(p) || !isFinite(prev) || prev === 0) return null;
      return round(((p - prev) / prev) * 100, 4);
    });
  }

  function computeVolumeChange(volumes) {
    if (!volumes || volumes.length === 0) return [];
    return volumes.map((v, i) => {
      if (i === 0) return null;
      if (!isFinite(v) || !isFinite(volumes[i - 1])) return null;
      return v - volumes[i - 1];
    });
  }

  return { computeSMA, computePriceChange, computePctChange, computeVolumeChange };
})();

/* ============================================================
   SIGNAL ENGINE
   ============================================================ */
const SignalEngine = (() => {
  /**
   * Rule (educational, not financial advice):
   *   Tolerance is a relative percentage of SMA: |P − SMA| / SMA.
   *   BUY  – price is above SMA by more than the tolerance.
   *   SELL – price is below SMA by more than the tolerance.
   *   HOLD – relative distance ≤ tolerance, or SMA is unavailable.
   *   Equality at the exact threshold is HOLD (inclusive band).
   */
  function generateSignal(currentPrice, sma, tolerance = MODEL.DEFAULT_TOLERANCE) {
    if (sma === null || sma === undefined || !isFinite(sma) || sma === 0 || !isFinite(currentPrice)) {
      return {
        signal: 'HOLD',
        reason: 'Insufficient or invalid data: the moving average cannot be used. The system HOLDs until a valid SMA exists.'
      };
    }
    const tol = (isFinite(tolerance) && tolerance >= 0) ? tolerance : MODEL.DEFAULT_TOLERANCE;
    const diff    = currentPrice - sma;
    const relDiff = Math.abs(safeDivide(diff, sma));

    if (relDiff <= tol) {
      return {
        signal: 'HOLD',
        reason: `Current price $${fmt(currentPrice)} is within the ${(tol * 100).toFixed(2)}% HOLD band of SMA $${fmt(sma)}. ` +
                `Absolute difference $${fmt(Math.abs(diff))} (${fmt(relDiff * 100, 3)}% relative). HOLD.`
      };
    }

    if (diff > 0) {
      return {
        signal: 'BUY',
        reason: `Current price $${fmt(currentPrice)} is above SMA $${fmt(sma)} by $${fmt(diff)} ` +
                `(${fmt((diff / sma) * 100, 2)}%), which exceeds the ${(tol * 100).toFixed(2)}% HOLD band. Illustrative BUY.`
      };
    }

    return {
      signal: 'SELL',
      reason: `Current price $${fmt(currentPrice)} is below SMA $${fmt(sma)} by $${fmt(Math.abs(diff))} ` +
              `(${fmt((Math.abs(diff) / sma) * 100, 2)}%), which exceeds the ${(tol * 100).toFixed(2)}% HOLD band. Illustrative SELL.`
    };
  }

  function generateSequence(prices, smaValues, tolerance) {
    return prices.map((price, idx) => generateSignal(price, smaValues[idx], tolerance).signal);
  }

  return { generateSignal, generateSequence };
})();

/* ============================================================
   BRANCH PREDICTOR  (Last-Outcome / 1-bit predictor)
   ============================================================ */
const BranchPredictor = (() => {
  /*
   * Educational proxy mapping (NOT a claim that a stock signal is a CPU branch):
   *   BUY  → T (Taken)
   *   SELL → N (Not Taken)
   *   HOLD → N (Not Taken)
   *
   * Algorithm: one-bit last-outcome predictor.
   *   1. First actual outcome warms up the predictor. It is not a hit or miss.
   *   2. Each later outcome is predicted as the previous actual outcome.
   *   3. Every evaluated prediction increments exactly one of hit or miss.
   */
  const SIGNAL_TO_BRANCH = { BUY: 'T', SELL: 'N', HOLD: 'N' };

  let history = [];
  let lastActual = null;

  function predict(signal, step) {
    const actual    = SIGNAL_TO_BRANCH[signal] || 'N';
    const predicted = lastActual;

    if (predicted !== null) {
      history.push({ step, signal, predicted, actual, hit: predicted === actual });
    } else {
      history.push({ step, signal, predicted: '—', actual, hit: null });
    }
    lastActual = actual;
  }

  function getStats() {
    const counted  = history.filter(h => h.hit !== null);
    const total    = counted.length;
    const hits     = counted.filter(h => h.hit === true).length;
    const misses   = total - hits;
    const accuracy = total > 0 ? (hits / total) * 100 : null;
    return { total, hits, misses, accuracy, history: history.slice() };
  }

  function reset() {
    history    = [];
    lastActual = null;
  }

  function runSequence(signals) {
    reset();
    if (!Array.isArray(signals)) return getStats();
    signals.forEach((sig, idx) => predict(sig, idx + 1));
    return getStats();
  }

  return { predict, getStats, reset, runSequence, SIGNAL_TO_BRANCH };
})();

/* ============================================================
   CPI ANALYSER
   ============================================================ */
const CPIAnalyser = (() => {
  /**
   * Two distinct formulas are used:
   *
   * 1) Textbook / reference (rate-based):
   *      CPI = BaseCPI + BranchFrequency × MispredictionRate × Penalty
   *    Used for the no-prediction baseline (rate = 1.00) and the 90% reference
   *    predictor (rate = 0.10). This 90% figure is an assumed hardware target,
   *    not the simulated predictor's measured accuracy.
   *
   * 2) Measured simulation (instruction-count model):
   *      CPI = BaseCPI + (Mispredictions × Penalty) / InstructionCount
   *    Mispredictions are the integer miss count from the 1-bit predictor.
   *    InstructionCount is the modeled 1,000-instruction workload.
   *    This does NOT treat each evaluated prediction as a whole instruction,
   *    and it does NOT scale misses by branch frequency.
   *
   * Cycles = InstructionCount × CPI (same N for baseline, reference, measured).
   * Savings = baselineCycles − predictedCycles  (may be negative; never abs()'d).
   * Reduction % = savings / baselineCycles × 100.
   * Speedup = baselineCycles / predictedCycles  (not the percentage reduction).
   */
  function computeReference() {
    const { BASE_CPI, BRANCH_FREQUENCY, MISPRED_PENALTY, INSTRUCTION_COUNT, REF_ACCURACY } = MODEL;
    const noPredCPI    = BASE_CPI + BRANCH_FREQUENCY * 1.0 * MISPRED_PENALTY;
    const noPredCycles = noPredCPI * INSTRUCTION_COUNT;
    const refCPI       = BASE_CPI + BRANCH_FREQUENCY * (1 - REF_ACCURACY) * MISPRED_PENALTY;
    const refCycles    = refCPI * INSTRUCTION_COUNT;
    const refSaved     = noPredCycles - refCycles;
    const refReduction = noPredCycles !== 0 ? (refSaved / noPredCycles) * 100 : null;
    const refSpeedup   = refCycles !== 0 ? (noPredCycles / refCycles) : null;
    return { noPredCPI, noPredCycles, refCPI, refCycles, refSaved, refReduction, refSpeedup };
  }

  /**
   * @param {object} sim
   * @param {number|null} sim.evaluated  evaluated prediction count
   * @param {number|null} sim.misses     integer misprediction count
   */
  function computeCPI(sim = {}) {
    const refs = computeReference();
    const { BASE_CPI, MISPRED_PENALTY, INSTRUCTION_COUNT } = MODEL;

    let measuredCPI = null;
    let measuredCycles = null;
    let savedVsNoPred = null;
    let reductionPct = null;
    let speedup = null;
    let extraCycles = null;

    const evaluated = sim.evaluated;
    const missesRaw = sim.misses;
    const hasPredictions = evaluated !== null && evaluated !== undefined && evaluated > 0
      && missesRaw !== null && missesRaw !== undefined && isFinite(missesRaw);

    if (hasPredictions && INSTRUCTION_COUNT > 0) {
      const missCount = Math.max(0, Math.round(Number(missesRaw)));
      extraCycles = missCount * MISPRED_PENALTY;
      measuredCPI = BASE_CPI + extraCycles / INSTRUCTION_COUNT;
      measuredCycles = INSTRUCTION_COUNT * measuredCPI;
      savedVsNoPred = refs.noPredCycles - measuredCycles;
      reductionPct = refs.noPredCycles !== 0 ? (savedVsNoPred / refs.noPredCycles) * 100 : null;
      speedup = (measuredCycles !== 0 && isFinite(measuredCycles)) ? (refs.noPredCycles / measuredCycles) : null;
    }

    return {
      ...refs,
      measuredCPI,
      measuredCycles,
      savedVsNoPred,
      reductionPct,
      speedup,
      extraCycles,
      instructionCount: INSTRUCTION_COUNT,
    };
  }

  return { computeCPI, computeReference };
})();

/* ============================================================
   LATENCY TRACKER
   ============================================================ */
const LatencyTracker = (() => {
  let _start = 0;
  function start() { _start = nowMs(); }
  function end()   { return round(nowMs() - _start, 3); }
  return { start, end };
})();

/* ============================================================
   DASHBOARD UI
   ============================================================ */
const DashboardUI = (() => {
  let priceChart = null;
  let cpiChart   = null;
  const alerts = [];

  function el(id) { return document.getElementById(id); }

  function drawFallbackMessage(ctx, text) {
    const width = ctx.canvas.width || 300;
    const height = ctx.canvas.height || 150;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#8FA6C4';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2);
  }

  function renderPriceChart(labels, prices, smaValues, smaWindow) {
    const canvas = el('priceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (typeof Chart === 'undefined') {
      drawFallbackMessage(ctx, 'Chart.js unavailable offline: metrics still appear in the cards.');
      return;
    }

    if (priceChart) {
      priceChart.destroy();
      priceChart = null;
    }

    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Simulated price',
            data: prices,
            borderColor: '#3984F7',
            backgroundColor: 'rgba(57,132,247,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#3984F7',
            tension: 0.25,
            fill: true,
            order: 1,
          },
          {
            label: `SMA (${smaWindow}-period)`,
            data: smaValues,
            borderColor: '#F59E0B',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 2,
            pointBackgroundColor: '#F59E0B',
            borderDash: [6, 3],
            tension: 0.25,
            fill: false,
            spanGaps: true,
            order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8FA6C4', font: { size: 12 } } },
          tooltip: {
            backgroundColor: '#0B1729',
            borderColor: '#1C3555',
            borderWidth: 1,
            titleColor: '#EAF2FF',
            bodyColor: '#8FA6C4',
            callbacks: {
              label: c => {
                const val = c.parsed.y;
                return val !== null && val !== undefined ? ` ${c.dataset.label}: $${fmt(val)}` : ' N/A';
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8FA6C4', maxTicksLimit: 12 }, grid: { color: 'rgba(28,53,85,0.45)' } },
          y: {
            ticks: { color: '#8FA6C4', callback: v => `$${v}` },
            grid: { color: 'rgba(28,53,85,0.45)' },
          },
        },
      },
    });
  }

  function renderCPIChart(cpiData) {
    const canvas = el('cpiChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (typeof Chart === 'undefined') {
      drawFallbackMessage(ctx, 'Chart.js unavailable offline: CPI values still appear in the panel.');
      return;
    }

    if (cpiChart) {
      cpiChart.destroy();
      cpiChart = null;
    }

    const isMeasuredAvailable = cpiData.measuredCPI !== null && isFinite(cpiData.measuredCPI);
    const bars = [
      { label: 'No prediction',  value: cpiData.noPredCPI, color: '#E06B6B' },
      { label: '90% reference',  value: cpiData.refCPI,    color: '#D4A017' },
      { label: 'Measured sim.',  value: isMeasuredAvailable ? cpiData.measuredCPI : null, color: '#2FA36B' },
    ];

    cpiChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: bars.map(b => b.label),
        datasets: [{
          label: 'CPI',
          data:  bars.map(b => b.value),
          backgroundColor: bars.map(b => b.color + 'B3'),
          borderColor:     bars.map(b => b.color),
          borderWidth: 1.5,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0B1729',
            borderColor: '#1C3555',
            borderWidth: 1,
            titleColor: '#EAF2FF',
            bodyColor: '#8FA6C4',
            callbacks: {
              label: c => {
                if (c.parsed.y === null || c.parsed.y === undefined) {
                  return ' Measured CPI: N/A — awaiting predictions';
                }
                return ` CPI: ${Number(c.parsed.y).toFixed(4)}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8FA6C4' }, grid: { display: false } },
          y: {
            beginAtZero: true,
            ticks: { color: '#8FA6C4' },
            grid:  { color: 'rgba(28,53,85,0.45)' },
            title: { display: true, text: 'Cycles per instruction (CPI)', color: '#8FA6C4', font: { size: 11 } },
          },
        },
      },
    });
  }

  function renderBPTable(history) {
    const tbody = el('bpTableBody');
    if (!tbody) return;
    tbody.replaceChildren();

    if (!history || history.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-cell';
      td.textContent = 'No branch predictions evaluated yet. Click “Run Branch Simulation Over Dataset”.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    history.forEach(row => {
      const tr = document.createElement('tr');

      const tdStep = document.createElement('td');
      tdStep.textContent = String(row.step);

      const tdSig = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = row.signal || '—';
      tdSig.appendChild(strong);

      const tdAct = document.createElement('td');
      tdAct.className = row.actual === 'T' ? 'taken-cell' : 'nottaken-cell';
      tdAct.textContent = `${row.actual} (${row.actual === 'T' ? 'Taken' : 'Not Taken'})`;

      const tdPred = document.createElement('td');
      tdPred.className = row.predicted === 'T' ? 'taken-cell' : (row.predicted === '—' ? '' : 'nottaken-cell');
      tdPred.textContent = String(row.predicted);

      const tdHit = document.createElement('td');
      if (row.hit === null) {
        tdHit.className = 'warmup-cell';
        tdHit.textContent = 'Warm-up (not evaluated)';
      } else if (row.hit) {
        tdHit.className = 'hit-cell';
        tdHit.textContent = 'HIT';
      } else {
        tdHit.className = 'miss-cell';
        tdHit.textContent = 'MISS';
      }

      tr.append(tdStep, tdSig, tdAct, tdPred, tdHit);
      tbody.appendChild(tr);
    });
  }

  function renderSignal(signal, reason) {
    const badge  = el('signalBadge');
    const reasonEl = el('signalReason');
    if (badge) {
      badge.textContent = signal;
      badge.className   = `signal-badge ${signal}`;
    }
    if (reasonEl) reasonEl.textContent = reason;
  }

  function renderSummaryCards(data) {
    Object.entries(data).forEach(([id, val]) => {
      const node = el(id);
      if (node) node.textContent = val;
    });
  }

  function pushAlert(kind, msg) {
    alerts.unshift({ kind, msg, at: new Date().toISOString().slice(11, 19) });
    if (alerts.length > 8) alerts.length = 8;
    renderAlertList();
  }

  function renderAlertList() {
    const list = el('alertList');
    if (!list) return;
    list.replaceChildren();
    if (alerts.length === 0) {
      const li = document.createElement('li');
      li.className = 'alert-empty';
      li.textContent = 'No simulation alerts yet.';
      list.appendChild(li);
      return;
    }
    alerts.forEach(a => {
      const li = document.createElement('li');
      li.className = `alert-item ${a.kind}`;
      li.textContent = `${a.at}  ${a.msg}`;
      list.appendChild(li);
    });
  }

  function showError(msg) {
    const node = el('errorAlert');
    if (!node) return;
    if (msg) {
      node.textContent = msg;
      node.classList.remove('alert-info');
      node.classList.add('alert-error', 'visible');
      pushAlert('error', msg);
    } else {
      node.textContent = '';
      node.classList.remove('visible', 'alert-info', 'alert-error');
    }
  }

  function showWarning(msg) {
    const node = el('errorAlert');
    if (!node) return;
    if (msg) {
      node.textContent = msg;
      node.classList.remove('alert-error');
      node.classList.add('alert-info', 'visible');
      pushAlert('info', msg);
    }
  }

  function showInfo(msg) {
    const node = el('errorAlert');
    if (!node) return;
    node.textContent = msg;
    node.classList.remove('alert-error');
    node.classList.add('alert-info', 'visible');
    pushAlert('info', msg);
  }

  function setFieldError(inputId, message) {
    const input = el(inputId);
    const err = el(`${inputId}Error`);
    if (input) {
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
    if (err) {
      err.textContent = message || '';
    }
  }

  function clearFieldErrors() {
    ['customPrices', 'customVolumes', 'holdTolerance', 'smaWindow'].forEach(id => setFieldError(id, ''));
  }

  function renderMarketTable(prices, volumes, smaValues, signals) {
    const mktBody = el('marketDataTableBody');
    if (!mktBody) return;
    mktBody.replaceChildren();
    if (!prices.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-cell';
      td.textContent = 'Run analysis to populate the data feed.';
      tr.appendChild(td);
      mktBody.appendChild(tr);
      return;
    }
    prices.forEach((price, i) => {
      const tr = document.createElement('tr');
      const cells = [
        `P${i + 1}`,
        `$${fmt(price)}`,
        smaValues[i] !== null ? `$${fmt(smaValues[i])}` : 'N/A',
        (volumes.length > 0 && i < volumes.length) ? volumes[i].toLocaleString() : 'N/A',
        signals[i] || 'HOLD',
      ];
      cells.forEach((text, idx) => {
        const td = document.createElement('td');
        td.className = idx === 4 ? `signal-chip ${cells[4]}` : 'tabular-num';
        td.textContent = text;
        tr.appendChild(td);
      });
      mktBody.appendChild(tr);
    });
  }

  return {
    renderPriceChart, renderCPIChart, renderBPTable, renderSignal, renderSummaryCards,
    showError, showWarning, showInfo, setFieldError, clearFieldErrors,
    renderMarketTable, renderAlertList, pushAlert,
  };
})();

/* ============================================================
   MAIN APPLICATION CONTROLLER
   ============================================================ */
const App = (() => {
  let sessionSeed = 42;
  let currentPrices  = [];
  let currentVolumes = [];
  let currentTimeframe = 'all';
  let currentSignals = [];
  let simulationRan = false;
  let analysing = false;

  const BENCHMARKS = {
    'NIFTY 50': {
      name: 'NIFTY 50 Index (simulated series)',
      prices: [24850, 24890, 24820, 24910, 24960, 24930, 25010, 25050, 24980, 25090, 25140, 25110, 25180, 25220, 25190, 25260, 25310, 25280, 25350, 25410],
      volumes: [120000, 135000, 110000, 142000, 158000, 125000, 160000, 175000, 130000, 182000, 190000, 145000, 205000, 210000, 165000, 220000, 235000, 180000, 245000, 260000]
    },
    'SENSEX': {
      name: 'BSE SENSEX Index (simulated series)',
      prices: [81200, 81350, 81180, 81420, 81600, 81510, 81750, 81900, 81790, 82050, 82210, 82100, 82340, 82480, 82390, 82610, 82790, 82680, 82920, 83110],
      volumes: [95000, 102000, 88000, 110000, 124000, 98000, 128000, 139000, 105000, 145000, 152000, 118000, 163000, 168000, 131000, 175000, 188000, 144000, 196000, 208000]
    },
    'BANK NIFTY': {
      name: 'NIFTY Bank Index (simulated series)',
      prices: [51800, 51920, 51740, 52010, 52150, 52060, 52280, 52410, 52300, 52520, 52690, 52580, 52750, 52890, 52780, 52960, 53120, 53010, 53240, 53400],
      volumes: [78000, 84000, 71000, 89000, 99000, 80000, 102000, 111000, 83000, 116000, 122000, 94000, 131000, 135000, 105000, 140000, 151000, 115000, 157000, 166000]
    },
    'USD/INR': {
      name: 'USD / INR FX rate (simulated series)',
      prices: [83.72, 83.75, 83.71, 83.78, 83.82, 83.80, 83.85, 83.89, 83.86, 83.91, 83.94, 83.92, 83.97, 84.01, 83.99, 84.05, 84.08, 84.06, 84.11, 84.15],
      volumes: [50000, 52000, 48000, 54000, 58000, 51000, 60000, 63000, 53000, 65000, 68000, 57000, 72000, 75000, 62000, 78000, 82000, 69000, 86000, 91000]
    }
  };

  function runAnalysis(prices, volumes, warningMsg = '', { preserveSimulation = false } = {}) {
    if (analysing) return;
    analysing = true;
    ['btnAnalyse', 'btnRunBP', 'btnLoadBuiltin', 'btnGenNew'].forEach(id => {
      setBusy(document.getElementById(id), true);
    });

    try {
      DashboardUI.showError('');
      LatencyTracker.start();

      if (warningMsg) DashboardUI.showWarning(warningMsg);

      const smaWindow   = getSMAWindow();
      const smaValues   = IndicatorEngine.computeSMA(prices, smaWindow);
      const priceChange = IndicatorEngine.computePriceChange(prices);
      const pctChange   = IndicatorEngine.computePctChange(prices);
      const volChange   = IndicatorEngine.computeVolumeChange(volumes);
      const tolerance   = getHoldTolerance();

      currentSignals = SignalEngine.generateSequence(prices, smaValues, tolerance);

      const lastIdx = prices.length - 1;
      const lastPrice = prices[lastIdx];
      const lastSMA   = smaValues[lastIdx];
      const lastVol   = (volumes.length > 0 && lastIdx < volumes.length) ? volumes[lastIdx] : null;
      const lastVolCh = (volChange.length > 0 && lastIdx < volChange.length) ? volChange[lastIdx] : null;
      const lastPrCh  = priceChange[lastIdx];
      const lastPctCh = pctChange[lastIdx];
      const { signal, reason } = SignalEngine.generateSignal(lastPrice, lastSMA, tolerance);

      if (!preserveSimulation) {
        BranchPredictor.reset();
        simulationRan = false;
      } else if (simulationRan) {
        BranchPredictor.runSequence(currentSignals);
      }

      const bpStats = BranchPredictor.getStats();
      const cpiData = CPIAnalyser.computeCPI({
        evaluated: bpStats.total,
        misses: bpStats.misses,
      });
      const latencyMs = LatencyTracker.end();

      renderAll({
        prices, volumes, smaValues, smaWindow, signal, reason,
        lastPrice, lastSMA, lastPrCh, lastPctCh, lastVol, lastVolCh,
        bpStats, cpiData, latencyMs, signals: currentSignals,
      });
    } finally {
      analysing = false;
      ['btnAnalyse', 'btnRunBP', 'btnLoadBuiltin', 'btnGenNew'].forEach(id => {
        setBusy(document.getElementById(id), false);
      });
    }
  }

  function renderAll({ prices, volumes, smaValues, smaWindow, signal, reason,
                       lastPrice, lastSMA, lastPrCh, lastPctCh, lastVol, lastVolCh,
                       bpStats, cpiData, latencyMs, signals }) {
    const labels = prices.map((_, i) => `P${i + 1}`);
    let chartLabels = labels;
    let chartPrices = prices;
    let chartSMA    = smaValues;
    if (currentTimeframe !== 'all') {
      const count = parseInt(currentTimeframe, 10);
      if (!isNaN(count) && count > 0 && prices.length > count) {
        chartLabels = labels.slice(-count);
        chartPrices = prices.slice(-count);
        chartSMA    = smaValues.slice(-count);
      }
    }

    DashboardUI.renderPriceChart(chartLabels, chartPrices, chartSMA, smaWindow);
    DashboardUI.renderCPIChart(cpiData);
    DashboardUI.renderSignal(signal, reason);
    DashboardUI.renderBPTable(bpStats.history);
    DashboardUI.renderMarketTable(prices, volumes, smaValues, signals);

    DashboardUI.renderSummaryCards({
      cardCurrentPrice:  `$${fmt(lastPrice)}`,
      cardPriceChange:   lastPrCh !== null ? `$${lastPrCh >= 0 ? '+' : ''}${fmt(lastPrCh)}` : 'N/A',
      cardPctChange:     lastPctCh !== null ? `${lastPctCh >= 0 ? '+' : ''}${fmt(lastPctCh)}%` : 'N/A',
      cardSMA:           lastSMA !== null ? `$${fmt(lastSMA)}` : 'N/A',
      cardVolume:        lastVol !== null ? lastVol.toLocaleString() : 'N/A',
      cardVolChange:     lastVolCh !== null ? `${lastVolCh >= 0 ? '+' : ''}${lastVolCh.toLocaleString()}` : 'N/A',
    });

    renderPredictorMetrics(bpStats, cpiData);
    renderDerivedViews(signals, bpStats, cpiData, prices);

    setText('latencyMs',       `${latencyMs} ms`);
    setText('latencyTopBadge', `JS ${latencyMs} ms`);
    setText('dataPoints',      String(prices.length));
    setText('smaWindowDisp',   String(smaWindow));
    setText('toleranceDisp',   `${(getHoldTolerance() * 100).toFixed(2)}%`);
    setText('datasetLabel',    `${prices.length}-period simulated series`);
  }

  function renderPredictorMetrics(bpStats, cpiData) {
    setText('bpTotal',    String(bpStats.total));
    setText('bpHits',     String(bpStats.hits));
    setText('bpMisses',   String(bpStats.misses));

    const accEl = document.getElementById('bpAccuracy');
    if (bpStats.accuracy !== null && isFinite(bpStats.accuracy)) {
      setText('bpAccuracy', `${fmt(bpStats.accuracy, 2)}%`);
      if (accEl) {
        accEl.className = 'bp-stat-val';
        if (bpStats.accuracy >= 75) accEl.classList.add('good');
        else if (bpStats.accuracy >= 50) accEl.classList.add('warn');
        else accEl.classList.add('danger');
      }
    } else {
      setText('bpAccuracy', 'N/A — awaiting predictions');
      if (accEl) accEl.className = 'bp-stat-val';
    }

    setText('cpiNoPred',   cpiData.noPredCPI.toFixed(4));
    setText('cycNoPred',   fmt(cpiData.noPredCycles, 0));
    setText('cpiRef',      cpiData.refCPI.toFixed(4));
    setText('cycRef',      fmt(cpiData.refCycles, 0));
    setText('cycRefSaved', `${fmt(cpiData.refSaved, 0)} (${fmt(cpiData.refReduction, 2)}%)`);
    setText('refSpeedup',  cpiData.refSpeedup !== null ? `${fmt(cpiData.refSpeedup, 3)}×` : 'N/A');

    if (cpiData.measuredCPI !== null && isFinite(cpiData.measuredCPI)) {
      setText('cpiMeasured', cpiData.measuredCPI.toFixed(4));
      setText('cycMeasured', fmt(cpiData.measuredCycles, 0));
      const savedLabel = `${cpiData.savedVsNoPred >= 0 ? '' : '−'}${fmt(Math.abs(cpiData.savedVsNoPred), 0)}`;
      const redLabel = cpiData.reductionPct !== null ? ` (${fmt(cpiData.reductionPct, 2)}%)` : '';
      setText('cycSaved', `${savedLabel}${redLabel}`);
      setText('measSpeedup', cpiData.speedup !== null && isFinite(cpiData.speedup) ? `${fmt(cpiData.speedup, 3)}×` : 'N/A');
    } else {
      setText('cpiMeasured', 'N/A — awaiting predictions');
      setText('cycMeasured', 'N/A — awaiting predictions');
      setText('cycSaved',    'N/A — awaiting predictions');
      setText('measSpeedup', 'N/A — awaiting predictions');
    }
  }

  function renderDerivedViews(signals, bpStats, cpiData, prices) {
    const buy  = signals.filter(s => s === 'BUY').length;
    const sell = signals.filter(s => s === 'SELL').length;
    const hold = signals.filter(s => s === 'HOLD').length;

    setText('portPeriods', String(prices.length));
    setText('portBuy', String(buy));
    setText('portSell', String(sell));
    setText('portHold', String(hold));
    setText('portLast', signals[signals.length - 1] || '—');

    const body = document.getElementById('portfolioTableBody');
    if (body) {
      body.replaceChildren();
      if (!signals.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'empty-cell';
        td.textContent = 'Load a dataset to summarise simulated signals.';
        tr.appendChild(td);
        body.appendChild(tr);
      } else {
        [['BUY', buy], ['SELL', sell], ['HOLD', hold]].forEach(([name, count]) => {
          const tr = document.createElement('tr');
          const td1 = document.createElement('td');
          td1.textContent = name;
          td1.className = name === 'BUY' ? 'taken-cell' : name === 'SELL' ? 'nottaken-cell' : '';
          const td2 = document.createElement('td');
          td2.className = 'tabular-num';
          td2.textContent = String(count);
          const td3 = document.createElement('td');
          td3.className = 'tabular-num';
          td3.textContent = prices.length ? fmt((count / prices.length) * 100, 1) + '%' : 'N/A';
          tr.append(td1, td2, td3);
          body.appendChild(tr);
        });
      }
    }

    setText('btEvaluated', simulationRan ? String(bpStats.total) : 'N/A — awaiting predictions');
    setText('btHits', simulationRan ? String(bpStats.hits) : 'N/A');
    setText('btMisses', simulationRan ? String(bpStats.misses) : 'N/A');
    setText('btAccuracy', simulationRan && bpStats.accuracy !== null ? `${fmt(bpStats.accuracy, 2)}%` : 'N/A — awaiting predictions');
    setText('btCpi', simulationRan && cpiData.measuredCPI !== null ? cpiData.measuredCPI.toFixed(4) : 'N/A — awaiting predictions');
    setText('btReduction', simulationRan && cpiData.reductionPct !== null ? `${fmt(cpiData.reductionPct, 2)}%` : 'N/A — awaiting predictions');
    setText('btSpeedup', simulationRan && cpiData.speedup !== null ? `${fmt(cpiData.speedup, 3)}×` : 'N/A — awaiting predictions');
  }

  function setText(id, val) {
    const node = document.getElementById(id);
    if (node) node.textContent = val;
  }

  function getSMAWindow() {
    const node = document.getElementById('smaWindow');
    const v = node ? parseInt(node.value, 10) : MODEL.DEFAULT_SMA;
    return (isFinite(v) && v >= 2 && v <= 50) ? v : MODEL.DEFAULT_SMA;
  }

  function getHoldTolerance() {
    const node = document.getElementById('holdTolerance');
    const v = node ? parseFloat(node.value) : 0.5;
    if (!isFinite(v) || v < 0 || v > 10) return MODEL.DEFAULT_TOLERANCE;
    return v / 100;
  }

  function populateInputFields(prices, volumes) {
    const p = document.getElementById('customPrices');
    const v = document.getElementById('customVolumes');
    if (p) p.value = prices.join(', ');
    if (v) v.value = volumes.join(', ');
  }

  function loadBuiltIn() {
    currentPrices  = DataManager.BUILTIN_PRICES.slice();
    currentVolumes = DataManager.BUILTIN_VOLUMES.slice();
    populateInputFields(currentPrices, currentVolumes);
    DashboardUI.clearFieldErrors();
    runAnalysis(currentPrices, currentVolumes);
    DashboardUI.showInfo('Loaded the built-in 20-period simulated dataset. Branch predictor reset — run the simulation to refresh CPI.');
  }

  function generateNew() {
    sessionSeed = Math.floor(Math.random() * 999999);
    const { prices, volumes } = DataManager.generateDataset(sessionSeed, 20);
    currentPrices  = prices;
    currentVolumes = volumes;
    populateInputFields(currentPrices, currentVolumes);
    DashboardUI.clearFieldErrors();
    runAnalysis(currentPrices, currentVolumes);
    DashboardUI.showInfo(`Generated a new simulated dataset (seed ${sessionSeed}). Not live market data.`);
  }

  function analyseCustom() {
    DashboardUI.clearFieldErrors();
    try {
      const priceNode  = document.getElementById('customPrices');
      const volumeNode = document.getElementById('customVolumes');
      const priceStr  = priceNode ? priceNode.value.trim() : '';
      const volumeStr = volumeNode ? volumeNode.value.trim() : '';

      if (!priceStr) {
        DashboardUI.setFieldError('customPrices', 'Enter at least 3 positive prices.');
        throw new Error('Please enter price values before running analysis.');
      }

      const prices = DataManager.parseCSV(priceStr, 'Prices', MODEL.MIN_PRICES);
      let volumes = [];
      let warningMsg = '';

      if (volumeStr) {
        volumes = DataManager.parseCSV(volumeStr, 'Volumes', 1);
        if (volumes.length !== prices.length) {
          warningMsg =
            `Volume count (${volumes.length}) does not match price count (${prices.length}). ` +
            `Volume display uses available data; missing periods show N/A.`;
        }
      }

      const win = getSMAWindow();
      if (win >= prices.length) {
        DashboardUI.setFieldError('smaWindow', `Window ${win} needs more than ${prices.length} prices.`);
        throw new Error(
          `SMA window (${win}) must be smaller than the number of prices (${prices.length}). ` +
          `Reduce the SMA window or add more data points.`
        );
      }

      const tolNode = document.getElementById('holdTolerance');
      const tolRaw = tolNode ? parseFloat(tolNode.value) : 0.5;
      if (!isFinite(tolRaw) || tolRaw < 0) {
        DashboardUI.setFieldError('holdTolerance', 'Tolerance must be 0 or greater.');
        throw new Error('HOLD tolerance must be a non-negative number (percent of SMA).');
      }

      currentPrices  = prices;
      currentVolumes = volumes;
      runAnalysis(prices, volumes.length > 0 ? volumes : [], warningMsg);
      if (!warningMsg) DashboardUI.showInfo('Custom input analysed. Dataset is simulated / user-supplied, not a live feed.');
    } catch (err) {
      DashboardUI.showError(err.message);
    }
  }

  function runBranchSimulation() {
    if (!currentPrices || currentPrices.length < 2) {
      DashboardUI.showError('Need at least 2 price points to evaluate branch predictions.');
      return;
    }
    DashboardUI.showError('');
    LatencyTracker.start();

    const smaWindow = getSMAWindow();
    const smaValues = IndicatorEngine.computeSMA(currentPrices, smaWindow);
    const tolerance = getHoldTolerance();
    currentSignals = SignalEngine.generateSequence(currentPrices, smaValues, tolerance);

    const bpStats = BranchPredictor.runSequence(currentSignals);
    simulationRan = true;
    const cpiData = CPIAnalyser.computeCPI({ evaluated: bpStats.total, misses: bpStats.misses });
    const latencyMs = LatencyTracker.end();

    const lastIdx = currentPrices.length - 1;
    const { signal, reason } = SignalEngine.generateSignal(currentPrices[lastIdx], smaValues[lastIdx], tolerance);
    const priceChange = IndicatorEngine.computePriceChange(currentPrices);
    const pctChange = IndicatorEngine.computePctChange(currentPrices);
    const volChange = IndicatorEngine.computeVolumeChange(currentVolumes);

    renderAll({
      prices: currentPrices,
      volumes: currentVolumes,
      smaValues,
      smaWindow,
      signal,
      reason,
      lastPrice: currentPrices[lastIdx],
      lastSMA: smaValues[lastIdx],
      lastPrCh: priceChange[lastIdx],
      lastPctCh: pctChange[lastIdx],
      lastVol: (currentVolumes.length > lastIdx) ? currentVolumes[lastIdx] : null,
      lastVolCh: (volChange.length > lastIdx) ? volChange[lastIdx] : null,
      bpStats,
      cpiData,
      latencyMs,
      signals: currentSignals,
    });
    DashboardUI.showInfo(`Branch simulation complete: ${bpStats.total} evaluated predictions, ${bpStats.misses} mispredictions.`);
  }

  function resetPredictor() {
    BranchPredictor.reset();
    simulationRan = false;
    const bpStats = BranchPredictor.getStats();
    const cpiData = CPIAnalyser.computeCPI({ evaluated: 0, misses: 0 });
    DashboardUI.renderBPTable([]);
    DashboardUI.renderCPIChart(cpiData);
    renderPredictorMetrics(bpStats, cpiData);
    renderDerivedViews(currentSignals, bpStats, cpiData, currentPrices);
    DashboardUI.showInfo('Branch predictor reset. Measured CPI is unavailable until you run the simulation again.');
  }

  function loadBenchmark(key) {
    const bench = BENCHMARKS[key];
    if (!bench) return;
    currentPrices  = bench.prices.slice();
    currentVolumes = bench.volumes.slice();
    populateInputFields(currentPrices, currentVolumes);
    DashboardUI.clearFieldErrors();
    runAnalysis(currentPrices, currentVolumes);
    DashboardUI.showInfo(`Loaded simulated series: ${bench.name}.`);
  }

  function switchView(targetView) {
    const navItems = document.querySelectorAll('.nav-item[data-view]');
    const viewPanes = document.querySelectorAll('.view-pane');
    navItems.forEach(b => {
      const on = b.getAttribute('data-view') === targetView;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    viewPanes.forEach(pane => {
      pane.classList.toggle('active', pane.id === `view-${targetView}`);
    });
    document.getElementById('terminalLayout')?.classList.remove('nav-open');
    const toggle = document.getElementById('btnMobileNav');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function init() {
    const bind = (id, handler) => {
      const node = document.getElementById(id);
      if (node) node.addEventListener('click', handler);
    };
    bind('btnLoadBuiltin', loadBuiltIn);
    bind('btnGenNew', generateNew);
    bind('btnAnalyse', analyseCustom);
    bind('btnRunBP', runBranchSimulation);
    bind('btnResetBP', resetPredictor);
    bind('btnMobileNav', () => {
      const layout = document.getElementById('terminalLayout');
      const toggle = document.getElementById('btnMobileNav');
      if (!layout) return;
      const open = layout.classList.toggle('nav-open');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    bind('btnNavBackdrop', () => {
      document.getElementById('terminalLayout')?.classList.remove('nav-open');
    });

    const smaEl = document.getElementById('smaWindow');
    if (smaEl) {
      smaEl.addEventListener('change', () => {
        if (currentPrices.length > 0) {
          runAnalysis(currentPrices, currentVolumes);
          DashboardUI.showInfo('SMA window changed. Predictor was reset because signals may differ.');
        }
      });
    }

    const tolEl = document.getElementById('holdTolerance');
    if (tolEl) {
      tolEl.addEventListener('change', () => {
        const v = parseFloat(tolEl.value);
        if (!isFinite(v) || v < 0) {
          DashboardUI.setFieldError('holdTolerance', 'Enter a non-negative percent.');
          return;
        }
        DashboardUI.setFieldError('holdTolerance', '');
        if (currentPrices.length > 0) {
          runAnalysis(currentPrices, currentVolumes);
          DashboardUI.showInfo('HOLD tolerance changed. Predictor was reset because signals may differ.');
        }
      });
    }

    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
    });

    document.querySelectorAll('.ticker-card[data-symbol]').forEach(card => {
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'button');
      const activate = () => {
        const symbol = card.getAttribute('data-symbol');
        if (symbol && BENCHMARKS[symbol]) loadBenchmark(symbol);
      };
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    });

    document.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn[data-tf]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTimeframe = btn.getAttribute('data-tf') || 'all';
        if (currentPrices.length > 0) {
          runAnalysis(currentPrices, currentVolumes, '', { preserveSimulation: simulationRan });
        }
      });
    });

    const searchInput = document.getElementById('symbolSearch');
    const searchDropdown = document.getElementById('searchResultsDropdown');
    if (searchInput && searchDropdown) {
      const renderSearch = () => {
        const q = searchInput.value.trim().toUpperCase();
        if (!q) {
          searchDropdown.replaceChildren();
          searchDropdown.classList.remove('visible');
          return;
        }
        const matches = Object.keys(BENCHMARKS).filter(k =>
          k.toUpperCase().includes(q) || BENCHMARKS[k].name.toUpperCase().includes(q)
        );
        searchDropdown.replaceChildren();
        if (matches.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'search-result-item';
          empty.textContent = 'No matching simulated series. Try NIFTY 50, SENSEX, BANK NIFTY, or USD/INR.';
          searchDropdown.appendChild(empty);
        } else {
          matches.forEach(k => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.setAttribute('role', 'option');
            item.tabIndex = 0;
            item.dataset.symbol = k;
            const sym = document.createElement('span');
            sym.textContent = k;
            const desc = document.createElement('span');
            desc.className = 'search-item-desc';
            desc.textContent = BENCHMARKS[k].name;
            item.append(sym, desc);
            const pick = () => {
              loadBenchmark(k);
              searchInput.value = '';
              searchDropdown.replaceChildren();
              searchDropdown.classList.remove('visible');
            };
            item.addEventListener('click', pick);
            item.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') pick();
            });
            searchDropdown.appendChild(item);
          });
        }
        searchDropdown.classList.add('visible');
      };
      searchInput.addEventListener('input', renderSearch);
      searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim()) renderSearch();
      });
      document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
          searchDropdown.classList.remove('visible');
        }
      });
    }

    const alertsPanel = document.getElementById('alertsPanel');
    const btnAlertsToggle = document.getElementById('btnAlertsToggle');
    if (btnAlertsToggle && alertsPanel) {
      btnAlertsToggle.addEventListener('click', () => {
        const open = !alertsPanel.classList.contains('visible');
        alertsPanel.classList.toggle('visible', open);
        btnAlertsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('terminalLayout')?.classList.remove('nav-open');
        document.getElementById('alertsPanel')?.classList.remove('visible');
        document.getElementById('searchResultsDropdown')?.classList.remove('visible');
      }
    });

    DashboardUI.renderAlertList();
    DashboardUI.renderBPTable([]);
    loadBuiltIn();
  }

  return { init, loadBenchmark };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
