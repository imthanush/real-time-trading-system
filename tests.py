#!/usr/bin/env python3
"""
tests.py — Automated test suite for the IACSI203 trading / CPI lab.

Independent expected values are calculated here from the documented formulas.
The suite also audits script.js / index.html so the UI cannot drift from
the mathematics without failing.

Run: python3 tests.py
"""
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PASS = 0
FAIL = 0
ERRORS = []


def ok(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        msg = f"  FAIL  {label}" + (f"  ← {detail}" if detail else '')
        print(msg)
        ERRORS.append(msg)


def section(title):
    print(f"\n{'=' * 68}")
    print(f"  {title}")
    print(f"{'=' * 68}")


def safe_divide(num, den):
    if den == 0 or not math.isfinite(den):
        return 0
    return num / den


BASE_CPI = 1.0
BRANCH_FREQUENCY = 0.25
MISPRED_PENALTY = 3
REF_ACCURACY = 0.90
INSTRUCTION_COUNT = 1000
MAX_POINTS = 500
MIN_PRICES = 3

BUILTIN_PRICES = [142, 145, 143, 148, 150, 147, 152, 155, 153, 158,
                  161, 159, 163, 166, 164, 169, 171, 168, 174, 178]
BUILTIN_VOLUMES = [2400, 2600, 2300, 2800, 3100, 2750, 3200, 3400, 3100, 3600,
                   3900, 3700, 4000, 4300, 4100, 4500, 4700, 4400, 5000, 5300]
SIGNAL_TO_BRANCH = {'BUY': 'T', 'SELL': 'N', 'HOLD': 'N'}


def compute_sma(prices, window):
    out = []
    for i in range(len(prices)):
        if i < window - 1:
            out.append(None)
        else:
            out.append(round(sum(prices[i - window + 1:i + 1]) / window, 4))
    return out


def compute_price_change(prices):
    return [None] + [round(prices[i] - prices[i - 1], 4) for i in range(1, len(prices))]


def compute_pct_change(prices):
    out = [None]
    for i in range(1, len(prices)):
        prev = prices[i - 1]
        if prev == 0:
            out.append(None)
        else:
            out.append(round(((prices[i] - prev) / prev) * 100, 4))
    return out


def compute_vol_change(volumes):
    if not volumes:
        return []
    return [None] + [volumes[i] - volumes[i - 1] for i in range(1, len(volumes))]


def generate_signal(price, sma, tolerance=0.005):
    if sma is None or sma == 0:
        return 'HOLD'
    diff = price - sma
    rel = abs(safe_divide(diff, sma))
    if rel <= tolerance:
        return 'HOLD'
    return 'BUY' if diff > 0 else 'SELL'


def reference_cpi():
    no_pred_cpi = BASE_CPI + BRANCH_FREQUENCY * 1.0 * MISPRED_PENALTY
    no_pred_cycles = no_pred_cpi * INSTRUCTION_COUNT
    ref_cpi = BASE_CPI + BRANCH_FREQUENCY * (1 - REF_ACCURACY) * MISPRED_PENALTY
    ref_cycles = ref_cpi * INSTRUCTION_COUNT
    saved = no_pred_cycles - ref_cycles
    reduction = (saved / no_pred_cycles) * 100 if no_pred_cycles else None
    speedup = (no_pred_cycles / ref_cycles) if ref_cycles else None
    return {
        'no_pred_cpi': no_pred_cpi,
        'no_pred_cycles': no_pred_cycles,
        'ref_cpi': ref_cpi,
        'ref_cycles': ref_cycles,
        'ref_saved': saved,
        'ref_reduction': reduction,
        'ref_speedup': speedup,
    }


def measured_cpi(evaluated, misses, instruction_count=INSTRUCTION_COUNT):
    """Instruction-count model: CPI = 1 + (misses × penalty) / N."""
    refs = reference_cpi()
    if evaluated is None or evaluated <= 0 or misses is None or instruction_count <= 0:
        return {
            **refs,
            'meas_cpi': None,
            'meas_cycles': None,
            'saved': None,
            'reduction': None,
            'speedup': None,
        }
    miss_count = max(0, int(round(misses)))
    extra = miss_count * MISPRED_PENALTY
    meas_cpi = BASE_CPI + extra / instruction_count
    meas_cycles = instruction_count * meas_cpi
    saved = refs['no_pred_cycles'] - meas_cycles
    reduction = (saved / refs['no_pred_cycles']) * 100 if refs['no_pred_cycles'] else None
    speedup = (refs['no_pred_cycles'] / meas_cycles) if meas_cycles else None
    return {
        **refs,
        'meas_cpi': meas_cpi,
        'meas_cycles': meas_cycles,
        'saved': saved,
        'reduction': reduction,
        'speedup': speedup,
        'extra': extra,
    }


def parse_csv(s, label, min_count, max_count=MAX_POINTS):
    if s is None or str(s).strip() == '':
        return None, f"{label}: input is empty"
    parts = [x.strip() for x in s.split(',') if x.strip() != '']
    if len(parts) < min_count:
        return None, f"{label}: need at least {min_count} values (got {len(parts)})"
    if len(parts) > max_count:
        return None, f"{label}: too many values ({len(parts)}). Maximum is {max_count}"
    nums = []
    for i, p in enumerate(parts):
        try:
            n = float(p)
        except ValueError:
            return None, f'{label}: "{p}" at position {i + 1} is not a valid finite number.'
        if not math.isfinite(n):
            return None, f'{label}: "{p}" at position {i + 1} is not a valid finite number.'
        if n <= 0:
            return None, f'{label}: value at position {i + 1} must be positive (got {n}).'
        nums.append(n)
    return nums, None


class BranchPredictorSim:
    def __init__(self):
        self.reset()

    def predict(self, signal, step):
        actual = SIGNAL_TO_BRANCH.get(signal, 'N')
        predicted = self.last_actual
        if predicted is not None:
            self.history.append({
                'step': step, 'signal': signal, 'predicted': predicted,
                'actual': actual, 'hit': (predicted == actual)
            })
        else:
            self.history.append({
                'step': step, 'signal': signal, 'predicted': '—',
                'actual': actual, 'hit': None
            })
        self.last_actual = actual

    def get_stats(self):
        counted = [h for h in self.history if h['hit'] is not None]
        total = len(counted)
        hits = sum(1 for h in counted if h['hit'])
        accuracy = (hits / total) * 100 if total > 0 else None
        return {
            'total': total, 'hits': hits, 'misses': total - hits,
            'accuracy': accuracy, 'history': self.history
        }

    def reset(self):
        self.history = []
        self.last_actual = None

    def run_sequence(self, signals):
        self.reset()
        for idx, sig in enumerate(signals):
            self.predict(sig, idx + 1)
        return self.get_stats()


def lcg_dataset(seed, count=20):
    prices, volumes = [], []
    price = 100 + (seed % 50)
    volume = 2000 + (seed % 1000)
    s = seed

    def lcg():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xffffffff
        return (s & 0xffffffff) / 0xffffffff

    for _ in range(count):
        price = max(10, round(price + (lcg() - 0.47) * 8, 2))
        volume = max(500, round(volume + (lcg() - 0.45) * 400))
        prices.append(price)
        volumes.append(volume)
    return prices, volumes


def read(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        return f.read()


# ============================================================================
section("TEST 1: Initial State (0 Predictions Evaluated -> N/A Awaiting)")
# ============================================================================
bp_fresh = BranchPredictorSim()
fresh_stats = bp_fresh.get_stats()
ok("Fresh predictor total predictions = 0", fresh_stats['total'] == 0)
ok("Fresh predictor hits = 0", fresh_stats['hits'] == 0)
ok("Fresh predictor misses = 0", fresh_stats['misses'] == 0)
ok("Fresh predictor accuracy is None (NOT 0%!)", fresh_stats['accuracy'] is None)

cpi_fresh = measured_cpi(fresh_stats['total'], fresh_stats['misses'])
ok("Fresh state: measured CPI is None", cpi_fresh['meas_cpi'] is None)
ok("Fresh state: measured cycles is None", cpi_fresh['meas_cycles'] is None)
ok("Fresh state: cycle savings is None", cpi_fresh['saved'] is None)
ok("Fresh state: No-pred baseline CPI = 1.750 visible", abs(cpi_fresh['no_pred_cpi'] - 1.75) < 1e-9)
ok("Fresh state: 90% Ref CPI = 1.075 visible", abs(cpi_fresh['ref_cpi'] - 1.075) < 1e-9)
ok("Fresh state: No-pred cycles = 1750 visible", abs(cpi_fresh['no_pred_cycles'] - 1750) < 1e-9)
ok("Fresh state: 90% Ref cycles = 1075 visible", abs(cpi_fresh['ref_cycles'] - 1075) < 1e-9)

bp_fresh.predict('BUY', 1)
warmup_only_stats = bp_fresh.get_stats()
ok("After warm-up step alone: evaluated total = 0", warmup_only_stats['total'] == 0)
ok("After warm-up step alone: accuracy remains None", warmup_only_stats['accuracy'] is None)
cpi_wu = measured_cpi(warmup_only_stats['total'], warmup_only_stats['misses'])
ok("Warm-up alone does not fabricate measured CPI=1.0", cpi_wu['meas_cpi'] is None)

# ============================================================================
section("TEST 2: Canonical CPI Formulae & 1,000-Instruction Cycles")
# ============================================================================
refs = reference_cpi()
ok("Case 1 – No-prediction CPI = 1.75", abs(refs['no_pred_cpi'] - 1.75) < 1e-12)
ok("Case 2 – 90%-ref predictor CPI = 1.075", abs(refs['ref_cpi'] - 1.075) < 1e-12)
ok("Case 3 – No-prediction 1000 instr = 1750 cycles", abs(refs['no_pred_cycles'] - 1750) < 1e-12)
ok("Case 4 – 90%-ref 1000 instr = 1075 cycles", abs(refs['ref_cycles'] - 1075) < 1e-12)
ok("Reference cycle savings = 675", abs(refs['ref_saved'] - 675) < 1e-12)
ok("Reference reduction ≈ 38.57%", abs(refs['ref_reduction'] - (675 / 1750 * 100)) < 1e-9)
ok("Reference speedup = 1750/1075 (not the %)", abs(refs['ref_speedup'] - (1750 / 1075)) < 1e-12)
ok("Speedup is not equal to percentage reduction", abs(refs['ref_speedup'] - refs['ref_reduction']) > 1)

rate_based_wrong = 1.0 + 0.25 * (1.0 - 14 / 19) * 3
miss_based = 1.0 + (5 * 3) / 1000
ok("Measured (5 misses) CPI = 1.015", abs(miss_based - 1.015) < 1e-12)
ok("Measured formula is distinct from rate-based 1.197…", abs(miss_based - rate_based_wrong) > 0.01)

zero_n = measured_cpi(19, 5, instruction_count=0)
ok("Zero instruction count: measured CPI is None", zero_n['meas_cpi'] is None)

none_pred = measured_cpi(0, 0)
ok("Zero evaluated predictions: measured CPI is None", none_pred['meas_cpi'] is None)

# Perfect predictor in miss-count model
perfect = measured_cpi(19, 0)
ok("0 misses → measured CPI = 1.0", abs(perfect['meas_cpi'] - 1.0) < 1e-12)
ok("0 misses → cycles = 1000", abs(perfect['meas_cycles'] - 1000) < 1e-12)
ok("0 misses → savings = 750", abs(perfect['saved'] - 750) < 1e-12)

worse = measured_cpi(10, 400)
ok("Negative savings are not abs()'d", worse['saved'] < 0)
ok("Worse-than-baseline reduction is negative", worse['reduction'] < 0)

# ============================================================================
section("TEST 3: Dataset Sequence Simulation & Branch-Outcome Proxy")
# ============================================================================
SMA_WINDOW = 5
TOLERANCE = 0.005
smas = compute_sma(BUILTIN_PRICES, SMA_WINDOW)
signals = [generate_signal(p, smas[i], TOLERANCE) for i, p in enumerate(BUILTIN_PRICES)]

bp_seq = BranchPredictorSim()
stats_seq = bp_seq.run_sequence(signals)

ok("Total signals evaluated in sequence = 20", len(signals) == 20)
ok("Total evaluated predictions = 19 (Step 1 warm-up excluded)", stats_seq['total'] == 19)
ok("Step 1 is marked as warm-up with hit = None", stats_seq['history'][0]['hit'] is None)
ok("Step 1 predicted is '—'", stats_seq['history'][0]['predicted'] == '—')
ok("Sequence evaluated hits = 14", stats_seq['hits'] == 14)
ok("Sequence evaluated misses = 5", stats_seq['misses'] == 5)
ok("hits + misses = evaluated", stats_seq['hits'] + stats_seq['misses'] == stats_seq['total'])

expected_accuracy = (14 / 19) * 100
ok("Measured accuracy formula: Hits / Total * 100", abs(stats_seq['accuracy'] - expected_accuracy) < 1e-9)
ok("Measured accuracy is NOT hardcoded to 90%", abs(stats_seq['accuracy'] - 90.0) > 0.01)

cpi_sim = measured_cpi(stats_seq['total'], stats_seq['misses'])
ok("Measured CPI uses miss count / 1000 = 1.015", abs(cpi_sim['meas_cpi'] - 1.015) < 1e-12)
ok("Measured cycles = 1015", abs(cpi_sim['meas_cycles'] - 1015) < 1e-12)
ok("Cycle savings vs baseline = 735", abs(cpi_sim['saved'] - 735) < 1e-12)
ok("Measured reduction = 735/1750*100", abs(cpi_sim['reduction'] - (735 / 1750 * 100)) < 1e-9)
ok("Measured speedup = 1750/1015", abs(cpi_sim['speedup'] - (1750 / 1015)) < 1e-12)
ok("Reference CPI still 1.075 after simulation", abs(cpi_sim['ref_cpi'] - 1.075) < 1e-12)

# ============================================================================
section("TEST 4: Repeated Simulation Runs")
# ============================================================================
stats_seq_2 = bp_seq.run_sequence(signals)
ok("Repeated run: total remains 19 (not 38)", stats_seq_2['total'] == 19)
ok("Repeated run: hits remains 14", stats_seq_2['hits'] == 14)
ok("Repeated run: misses remains 5", stats_seq_2['misses'] == 5)
ok("Repeated run: accuracy matches exactly", stats_seq_2['accuracy'] == stats_seq['accuracy'])

# ============================================================================
section("TEST 5: Reset Behavior")
# ============================================================================
bp_seq.reset()
reset_stats = bp_seq.get_stats()
ok("After reset: total = 0", reset_stats['total'] == 0)
ok("After reset: hits = 0", reset_stats['hits'] == 0)
ok("After reset: misses = 0", reset_stats['misses'] == 0)
ok("After reset: accuracy is None (awaiting state)", reset_stats['accuracy'] is None)
ok("After reset: history is empty", len(reset_stats['history']) == 0)
reset_cpi = measured_cpi(reset_stats['total'], reset_stats['misses'])
ok("After reset: measured CPI is None", reset_cpi['meas_cpi'] is None)
ok("After reset: baseline No-pred CPI = 1.750 remains visible", abs(reset_cpi['no_pred_cpi'] - 1.75) < 1e-9)
ok("After reset: 90% Ref CPI = 1.075 remains visible", abs(reset_cpi['ref_cpi'] - 1.075) < 1e-9)
bp_seq.predict('BUY', 1)
ok("Post-reset: step 1 is warm-up again",
   bp_seq.history[0]['predicted'] == '—' and bp_seq.history[0]['hit'] is None)

# ============================================================================
section("TEST 6: Predictor sequences (T/N patterns)")
# ============================================================================
bp = BranchPredictorSim()

st = bp.run_sequence(['BUY'] * 5)  # all T after warmup
ok("All-T: evaluated = 4", st['total'] == 4)
ok("All-T: misses = 0", st['misses'] == 0)
ok("All-T: accuracy = 100", abs(st['accuracy'] - 100) < 1e-9)

sn = bp.run_sequence(['HOLD'] * 5)  # all N
ok("All-N: evaluated = 4", sn['total'] == 4)
ok("All-N: misses = 0", sn['misses'] == 0)

alt = bp.run_sequence(['BUY', 'HOLD', 'BUY', 'HOLD', 'BUY'])  # T N T N T
ok("Alternating T/N: evaluated = 4", alt['total'] == 4)
ok("Alternating T/N: all misses", alt['misses'] == 4 and alt['hits'] == 0)

one = bp.run_sequence(['SELL'])
ok("One-element: evaluated = 0", one['total'] == 0)
ok("One-element: accuracy None", one['accuracy'] is None)

empty = bp.run_sequence([])
ok("Empty sequence: evaluated = 0", empty['total'] == 0)
ok("Empty sequence: history empty", empty['history'] == [])

ok("BUY maps to T", SIGNAL_TO_BRANCH['BUY'] == 'T')
ok("SELL maps to N", SIGNAL_TO_BRANCH['SELL'] == 'N')
ok("HOLD maps to N", SIGNAL_TO_BRANCH['HOLD'] == 'N')

# ============================================================================
section("TEST 7: Indicator Calculations")
# ============================================================================
pc = compute_price_change(BUILTIN_PRICES)
ok("Price change[0] = None", pc[0] is None)
ok("Price change[1] = 145 - 142 = +3", abs(pc[1] - 3) < 1e-9)
ok("Price change[2] = 143 - 145 = -2", abs(pc[2] - (-2)) < 1e-9)

pct = compute_pct_change(BUILTIN_PRICES)
ok("Pct change[0] = None", pct[0] is None)
ok("Pct change[1] = +2.1127%", abs(pct[1] - ((145 - 142) / 142) * 100) < 1e-4)
ok("Pct change: prev=0 -> None (zero-division guard)", compute_pct_change([0, 100])[1] is None)

sma5 = compute_sma(BUILTIN_PRICES, 5)
ok("SMA[0..3] all None (window=5)", all(v is None for v in sma5[:4]))
ok("SMA[4] matches 5-period mean", abs(sma5[4] - sum(BUILTIN_PRICES[:5]) / 5) < 1e-6)
ok("SMA[-1] matches last 5 mean", abs(sma5[-1] - sum(BUILTIN_PRICES[-5:]) / 5) < 1e-6)
sma3 = compute_sma([10, 20, 30, 40], 3)
ok("SMA window=3 at index 2 uses exactly 3 prices", abs(sma3[2] - 20) < 1e-9)
ok("SMA does not use future values", sma3[2] != sum([10, 20, 30, 40]) / 4)

ok("BUY: price > SMA outside tolerance", generate_signal(110, 100, 0.005) == 'BUY')
ok("SELL: price < SMA outside tolerance", generate_signal(90, 100, 0.005) == 'SELL')
ok("HOLD: price within tolerance of SMA", generate_signal(100.1, 100, 0.005) == 'HOLD')
ok("HOLD: SMA is None", generate_signal(100, None, 0.005) == 'HOLD')
ok("HOLD: price == SMA", generate_signal(100, 100, 0.005) == 'HOLD')
# Boundary: exactly 0.5%
ok("HOLD: exactly on tolerance band", generate_signal(100.5, 100, 0.005) == 'HOLD')
ok("BUY: just outside upper band", generate_signal(100.51, 100, 0.005) == 'BUY')
ok("SELL: just outside lower band", generate_signal(99.49, 100, 0.005) == 'SELL')

vc = compute_vol_change(BUILTIN_VOLUMES)
ok("Vol change[0] = None", vc[0] is None)
ok("Vol change[1] = 2600 - 2400 = 200", vc[1] == 200)
ok("Empty volumes -> empty vol change", compute_vol_change([]) == [])

# ============================================================================
section("TEST 8: Validation & Edge Cases")
# ============================================================================
cases = [
    ('', 'P', 3, False, 'empty'),
    ('   ', 'P', 3, False, 'empty'),
    ('abc, 1, 2', 'P', 3, False, 'not a valid'),
    ('0, 1, 2', 'P', 3, False, 'must be positive'),
    ('-5, 1, 2', 'P', 3, False, 'must be positive'),
    ('1, 2', 'P', 3, False, 'need at least 3'),
    ('1, 2, 3', 'P', 3, True, None),
    ('1e999, 1, 1', 'P', 3, False, 'not a valid'),
    ('NaN, 1, 2', 'P', 3, False, 'not a valid'),
    ('1.5, 2.5, 3.5', 'P', 3, True, None),
    ('  10,  20 , 30 ', 'P', 3, True, None),
]
for s, label, mn, expect_ok, expect_msg in cases:
    res, err = parse_csv(s, label, mn)
    passed = (res is not None) == expect_ok
    if expect_msg and err:
        passed = passed and (expect_msg.lower() in err.lower())
    ok(f"parse_csv({repr(s[:18])}) -> {'ok' if expect_ok else 'err'}", passed)

huge = ','.join(['1'] * 501)
res, err = parse_csv(huge, 'P', 3)
ok("501 values rejected as too large", res is None and err is not None and 'too many' in err.lower())

ok("safeDivide(5, 0) = 0", safe_divide(5, 0) == 0)
ok("safeDivide(0, 0) = 0", safe_divide(0, 0) == 0)
ok("safeDivide(10, 2) = 5", safe_divide(10, 2) == 5)

p1, _ = lcg_dataset(42)
p2, _ = lcg_dataset(42)
p3, _ = lcg_dataset(99)
ok("LCG same seed gives identical data", p1 == p2)
ok("LCG different seed gives different data", p1 != p3)
ok("LCG all prices positive", all(p > 0 for p in p1))

# ============================================================================
section("TEST 9: Source audit (script.js / index.html stay consistent)")
# ============================================================================
js = read('script.js')
html = read('index.html')
css = read('styles.css')

ok("MODEL.BASE_CPI is 1.0", re.search(r'BASE_CPI:\s*1\.0', js) is not None)
ok("MODEL.BRANCH_FREQUENCY is 0.25", re.search(r'BRANCH_FREQUENCY:\s*0\.25', js) is not None)
ok("MODEL.MISPRED_PENALTY is 3", re.search(r'MISPRED_PENALTY:\s*3', js) is not None)
ok("MODEL.REF_ACCURACY is 0.90", re.search(r'REF_ACCURACY:\s*0\.90', js) is not None)
ok("MODEL.INSTRUCTION_COUNT is 1000", re.search(r'INSTRUCTION_COUNT:\s*1000', js) is not None)
ok("Measured CPI uses misses × penalty / N",
   'BASE_CPI + extraCycles / INSTRUCTION_COUNT' in js or 'extraCycles / INSTRUCTION_COUNT' in js)
ok("No CDN Chart.js runtime dependency", 'cdn.jsdelivr.net' not in html and 'cdn.jsdelivr.net' not in js)
ok("Local chart.umd.min.js is referenced", 'chart.umd.min.js' in html)
ok("Core action buttons exist", all(b in html for b in (
    'btnAnalyse', 'btnRunBP', 'btnLoadBuiltin', 'btnGenNew', 'btnResetBP')))
ok("Awaiting-predictions copy exists", 'awaiting predictions' in html.lower())
ok("Educational disclaimer present", 'not investment advice' in html.lower() or 'not financial advice' in html.lower())
ok("No hardcoded fake NAV $124,580", '$124,580' not in html)
ok("No hardcoded fake win rate 68.4%", '68.4%' not in html)
ok("Focus-visible styles exist", ':focus-visible' in css)
ok("Reduced-motion styles exist", 'prefers-reduced-motion' in css)
ok("Chart.js file present", os.path.isfile(os.path.join(ROOT, 'chart.umd.min.js')))

# Rounding: display vs internal — 1.0750 displayed from 1.075 exactly
ok("1.075 display rounding does not change value", round(1.075, 4) == 1.075)
ok("1.015 display rounding does not change value", round(1.015, 4) == 1.015)

# ============================================================================
print(f"\n{'=' * 68}")
print(f"  AUDIT COMPLETE:  {PASS} PASSED  |  {FAIL} FAILED")
print(f"{'=' * 68}")
if FAIL > 0:
    print("\n  FAILED TESTS:")
    for e in ERRORS:
        print(f"  {e}")
    sys.exit(1)
print("\n  All tests passed successfully.")
sys.exit(0)
