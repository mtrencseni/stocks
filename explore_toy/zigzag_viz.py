"""
Visualize the zigzag swing-count on SMCI.
Compares the original (non-alternating) vs a proper alternating zigzag.
"""

import numpy as np
import pandas as pd
import yfinance as yf
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import warnings
warnings.filterwarnings("ignore")

THRESHOLD = 0.40
LOOKBACK_YEARS = 3

# ── Download ──────────────────────────────────────────────────────────────────
print("Downloading SMCI …")
end = pd.Timestamp.today()
start = end - pd.DateOffset(years=LOOKBACK_YEARS)
raw = yf.download("SMCI", start=start.strftime("%Y-%m-%d"), end=end.strftime("%Y-%m-%d"),
                  auto_adjust=True, progress=False)
prices = raw["Close"].squeeze().dropna()
print(f"  {len(prices)} bars from {prices.index[0].date()} to {prices.index[-1].date()}")

# ── Original (non-alternating) zigzag from toy_plots.py ──────────────────────
def zigzag_original(prices, threshold=0.40):
    arr = prices.values
    n = len(arr)
    direction = None
    count = 0
    hi = lo = arr[0]
    for p in arr[1:]:
        if direction is None:
            if p > hi: hi = p
            elif p < lo: lo = p
            if hi / lo - 1 >= threshold:
                direction = -1 if hi == arr[0] else 1
        elif direction == 1:
            if p > hi: hi = p
            elif hi / p - 1 >= threshold:
                count += 1
                lo = p; hi = p; direction = 1
        else:
            if p < lo: lo = p
            elif p / lo - 1 >= threshold:
                count += 1
                hi = p; lo = p; direction = -1
    return count

# ── Proper alternating zigzag (records pivot points) ─────────────────────────
def zigzag_alternating(prices, threshold=0.40):
    """
    Returns list of confirmed pivot dicts:
      {idx, date, price, kind}  where kind in ('H','L')
    Alternates strictly H/L/H/L...
    Algorithm:
      - Keep a "candidate" extreme (running max or min in current direction).
      - When price reverses by >= threshold from the candidate, the candidate
        is confirmed as a pivot; flip direction and start a new candidate.
    """
    arr = prices.values
    dates = prices.index
    n = len(arr)
    pivots = []

    # ---- find initial direction ----
    direction = 0   # 0=unknown
    cand_val = arr[0]
    cand_idx = 0

    for i in range(1, n):
        p = arr[i]
        if direction == 0:
            if p > cand_val:
                cand_val = p; cand_idx = i
            # First check: did we drop threshold% from the running high?
            # That means initial move was UP (start was a low), now reversing.
            if cand_val / arr[0] - 1 >= threshold and cand_val == arr[cand_idx]:
                # The start was a local LOW, then we rallied to cand_val
                # (or we rose immediately — start is a low)
                # check actual: was there ever a lower point before the high?
                # Simpler: find if high came after any low
                sub = arr[:i+1]
                max_idx = int(np.argmax(sub))
                min_before_max = np.min(sub[:max_idx+1]) if max_idx > 0 else sub[0]
                if sub[max_idx] / min_before_max - 1 >= threshold:
                    # The min before max is the real start pivot (L)
                    min_before_max_idx = int(np.argmin(sub[:max_idx+1]))
                    pivots.append({'idx': min_before_max_idx, 'date': dates[min_before_max_idx],
                                   'price': float(min_before_max), 'kind': 'L'})
                    pivots.append({'idx': max_idx, 'date': dates[max_idx],
                                   'price': float(sub[max_idx]), 'kind': 'H'})
                    direction = -1
                    cand_val = arr[i]; cand_idx = i
                    break
            # Did we rise threshold% from running low?
            min_val = np.min(arr[:i+1])
            min_idx = int(np.argmin(arr[:i+1]))
            if arr[0] / min_val - 1 >= threshold:
                # initial move was DOWN; arr[0] is a local high, min_val is the first low
                pivots.append({'idx': 0, 'date': dates[0], 'price': float(arr[0]), 'kind': 'H'})
                pivots.append({'idx': min_idx, 'date': dates[min_idx],
                               'price': float(min_val), 'kind': 'L'})
                direction = 1
                cand_val = arr[i]; cand_idx = i
                break
    else:
        return pivots  # no swing found

    # ---- main loop: alternate H/L ----
    for i in range(cand_idx + 1, n):
        p = arr[i]
        if direction == 1:     # looking for new HIGH (up-move, cand = running max)
            if p > cand_val:
                cand_val = p; cand_idx = i
            elif cand_val / p - 1 >= threshold:
                # cand_val confirmed as a HIGH pivot
                pivots.append({'idx': cand_idx, 'date': dates[cand_idx],
                               'price': float(cand_val), 'kind': 'H'})
                direction = -1
                cand_val = p; cand_idx = i
        else:                  # looking for new LOW (down-move, cand = running min)
            if p < cand_val:
                cand_val = p; cand_idx = i
            elif p / cand_val - 1 >= threshold:
                # cand_val confirmed as a LOW pivot
                pivots.append({'idx': cand_idx, 'date': dates[cand_idx],
                               'price': float(cand_val), 'kind': 'L'})
                direction = 1
                cand_val = p; cand_idx = i

    return pivots

# ── Compute ───────────────────────────────────────────────────────────────────
orig_count = zigzag_original(prices, THRESHOLD)
pivots = zigzag_alternating(prices, THRESHOLD)
alt_count = max(0, len(pivots) - 1)   # #swings = #intervals between pivots

print(f"\nOriginal (non-alternating) count : {orig_count}")
print(f"Alternating zigzag pivot count   : {len(pivots)} pivots → {alt_count} swings")
for pv in pivots:
    print(f"  {pv['kind']}  {pv['date'].date()}  ${pv['price']:.2f}")

# ── Plot ──────────────────────────────────────────────────────────────────────
DARK_BG  = "#0e0e0f"
PANEL_BG = "#22242a"
TEXT_COL = "#c6c7ca"
GRID_COL = "#333640"
GREEN    = "#89c996"
RED      = "#ec8a82"
GOLD     = "#f0c040"

fig, axes = plt.subplots(2, 1, figsize=(14, 10), facecolor=DARK_BG)

for ax, (count, label, note) in zip(axes, [
    (orig_count, "Original (non-alternating) zigzag",
     f"Counts only troughs OR only peaks (never switches direction). Count = {orig_count}"),
    (alt_count,  "Alternating zigzag (corrected)",
     f"Strictly alternates H/L/H/L … each leg is a confirmed ≥40% swing. Swings = {alt_count}"),
]):
    ax.set_facecolor(PANEL_BG)
    ax.tick_params(colors=TEXT_COL)
    for spine in ax.spines.values():
        spine.set_edgecolor(GRID_COL)
    ax.grid(True, color=GRID_COL, linewidth=0.4, linestyle="--")

    # ---- thin price line ----
    ax.plot(prices.index, prices.values, color="#555a66", linewidth=0.8, zorder=1)

    ax.set_title(f"SMCI  —  {label}\n{note}", color=TEXT_COL, fontsize=10, pad=6)
    ax.set_ylabel("Price ($)", color=TEXT_COL, fontsize=9)
    ax.xaxis.label.set_color(TEXT_COL)

# ── Top panel: original — shade regions between consecutive confirmed events ──
ax = axes[0]
# Reconstruct event list for original algo (re-run, record events)
def zigzag_original_events(prices, threshold=0.40):
    arr = prices.values
    dates = prices.index
    n = len(arr)
    direction = None
    hi = lo = arr[0]
    hi_idx = lo_idx = 0
    events = []   # (date, price, kind)  kind='T'=trough 'P'=peak

    for i, p in enumerate(arr[1:], start=1):
        if direction is None:
            if p > hi: hi = p; hi_idx = i
            elif p < lo: lo = p; lo_idx = i
            if hi / lo - 1 >= threshold:
                if hi == arr[0]:
                    direction = -1
                else:
                    direction = 1
        elif direction == 1:
            if p > hi: hi = p; hi_idx = i
            elif hi / p - 1 >= threshold:
                events.append({'idx': hi_idx, 'date': dates[hi_idx], 'price': float(hi), 'kind': 'H'})
                events.append({'idx': i, 'date': dates[i], 'price': float(p), 'kind': 'T'})
                lo = p; hi = p; lo_idx = i; hi_idx = i
        else:
            if p < lo: lo = p; lo_idx = i
            elif p / lo - 1 >= threshold:
                events.append({'idx': lo_idx, 'date': dates[lo_idx], 'price': float(lo), 'kind': 'L'})
                events.append({'idx': i, 'date': dates[i], 'price': float(p), 'kind': 'P'})
                hi = p; lo = p; hi_idx = i; lo_idx = i
    return events

orig_events = zigzag_original_events(prices, THRESHOLD)
print(f"\nOriginal events ({len(orig_events)}):")
for e in orig_events:
    print(f"  {e['kind']}  {e['date'].date()}  ${e['price']:.2f}")

# shade from start to first event, then between events
all_dates = prices.index
price_arr = prices.values

def shade_band(ax, d0, d1, color):
    mask = (all_dates >= d0) & (all_dates <= d1)
    ax.fill_between(all_dates[mask], price_arr[mask], alpha=0.25, color=color, zorder=2)
    ax.plot(all_dates[mask], price_arr[mask], color=color, linewidth=1.8, zorder=3)

if orig_events:
    prev_date = all_dates[0]
    prev_kind = None
    for e in orig_events:
        # color: if next event is a trough/down → red segment, peak/up → green
        kind = e['kind']
        col = RED if kind in ('T', 'L') else GREEN
        shade_band(ax, prev_date, e['date'], col)
        ax.scatter(e['date'], e['price'], color=GOLD, s=80, zorder=5, marker='^' if kind in ('P','H') else 'v')
        ax.annotate(f"{kind}\n${e['price']:.0f}", xy=(e['date'], e['price']),
                    xytext=(0, 12 if kind in ('P','H') else -18), textcoords='offset points',
                    fontsize=6.5, color=GOLD, ha='center', zorder=6)
        prev_date = e['date']
        prev_kind = kind
    # tail
    shade_band(ax, prev_date, all_dates[-1], "#888888")

ax.text(0.01, 0.97, f"Yellow ▲/▼ = confirmed pivot    Green = up-leg    Red = down-leg",
        transform=ax.transAxes, fontsize=8, color=TEXT_COL, va='top')

# ── Bottom panel: alternating zigzag ──────────────────────────────────────────
ax = axes[1]

if len(pivots) >= 2:
    for i in range(len(pivots) - 1):
        p0, p1 = pivots[i], pivots[i+1]
        going_up = p1['kind'] == 'H'
        col = GREEN if going_up else RED
        shade_band(ax, p0['date'], p1['date'], col)

    # shade tail after last pivot
    shade_band(ax, pivots[-1]['date'], all_dates[-1], "#888888")

    # pivot markers
    for i, pv in enumerate(pivots):
        marker = '^' if pv['kind'] == 'H' else 'v'
        offset = 14 if pv['kind'] == 'H' else -18
        ax.scatter(pv['date'], pv['price'], color=GOLD, s=90, zorder=5, marker=marker)
        label_txt = f"{'H' if pv['kind']=='H' else 'L'}{i}\n${pv['price']:.0f}"
        ax.annotate(label_txt, xy=(pv['date'], pv['price']),
                    xytext=(0, offset), textcoords='offset points',
                    fontsize=6.5, color=GOLD, ha='center', zorder=6)

    # annotate pct change on each leg
    for i in range(len(pivots) - 1):
        p0, p1 = pivots[i], pivots[i+1]
        pct = (p1['price'] / p0['price'] - 1) * 100
        mid_date = p0['date'] + (p1['date'] - p0['date']) / 2
        mid_price = (p0['price'] + p1['price']) / 2
        ax.annotate(f"{pct:+.0f}%", xy=(mid_date, mid_price),
                    fontsize=7, color=TEXT_COL, ha='center',
                    bbox=dict(boxstyle='round,pad=0.2', fc=PANEL_BG, ec='none', alpha=0.7))

ax.text(0.01, 0.97,
        f"Yellow ▲/▼ = confirmed pivot    Green = up-leg (+≥40%)    Red = down-leg (-≥40%)    Gray = unconfirmed tail",
        transform=ax.transAxes, fontsize=8, color=TEXT_COL, va='top')

ax.set_xlabel("Date", color=TEXT_COL, fontsize=9)

plt.tight_layout(pad=1.5)
out = "/home/mtrencseni/stocks/explore_toy/zigzag_smci.png"
fig.savefig(out, dpi=130, bbox_inches="tight", facecolor=DARK_BG)
plt.close(fig)
print(f"\nSaved {out}")
