"""
Corrected alternating zigzag on the 9 default stocks. 3x3 grid, large output.
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
SYMBOLS = ["ADBE", "ASAN", "META", "NVDA", "PATH", "PYPL", "SMCI", "TEAM", "TSLA"]

DARK_BG  = "#0e0e0f"
PANEL_BG = "#22242a"
TEXT_COL = "#c6c7ca"
GRID_COL = "#333640"
GREEN    = "#89c996"
RED      = "#ec8a82"
GOLD     = "#f0c040"
GRAY_LEG = "#666677"

# ── Download all at once ──────────────────────────────────────────────────────
print("Downloading …")
end   = pd.Timestamp.today()
start = end - pd.DateOffset(years=LOOKBACK_YEARS)
raw   = yf.download(SYMBOLS, start=start.strftime("%Y-%m-%d"),
                    end=end.strftime("%Y-%m-%d"), auto_adjust=True, progress=True)
close = raw["Close"]

# ── Alternating zigzag ────────────────────────────────────────────────────────
def zigzag_alternating(series, threshold=0.40):
    s = series.dropna()
    arr = s.values.astype(float)
    dates = s.index
    n = len(arr)
    if n < 20:
        return []

    pivots = []
    direction = 0
    cand_val = arr[0]
    cand_idx = 0
    init_done = False

    for i in range(1, n):
        p = float(arr[i])

        if not init_done:
            # track running max from start
            if p > cand_val:
                cand_val = p; cand_idx = i
            # check upward threshold: start was a low
            if cand_val / arr[0] - 1 >= threshold:
                sub = arr[:i+1]
                max_idx = int(np.argmax(sub))
                min_before = float(np.min(sub[:max_idx+1])) if max_idx > 0 else float(arr[0])
                min_before_idx = int(np.argmin(sub[:max_idx+1])) if max_idx > 0 else 0
                pivots.append({'date': dates[min_before_idx], 'price': min_before, 'kind': 'L'})
                pivots.append({'date': dates[max_idx], 'price': float(sub[max_idx]), 'kind': 'H'})
                direction = -1
                cand_val = p; cand_idx = i
                init_done = True
                continue
            # check downward threshold: start was a high
            sub = arr[:i+1]
            min_val = float(np.min(sub))
            min_idx = int(np.argmin(sub))
            if arr[0] / min_val - 1 >= threshold:
                pivots.append({'date': dates[0], 'price': float(arr[0]), 'kind': 'H'})
                pivots.append({'date': dates[min_idx], 'price': min_val, 'kind': 'L'})
                direction = 1
                cand_val = p; cand_idx = i
                init_done = True
                continue
        else:
            if direction == 1:        # up — track high, wait for 40% drop
                if p > cand_val:
                    cand_val = p; cand_idx = i
                elif cand_val / p - 1 >= threshold:
                    pivots.append({'date': dates[cand_idx], 'price': cand_val, 'kind': 'H'})
                    direction = -1
                    cand_val = p; cand_idx = i
            else:                     # down — track low, wait for 40% rise
                if p < cand_val:
                    cand_val = p; cand_idx = i
                elif p / cand_val - 1 >= threshold:
                    pivots.append({'date': dates[cand_idx], 'price': cand_val, 'kind': 'L'})
                    direction = 1
                    cand_val = p; cand_idx = i

    return pivots


# ── Plot ──────────────────────────────────────────────────────────────────────
fig, axes = plt.subplots(3, 3, figsize=(22, 18), facecolor=DARK_BG)
fig.suptitle(
    f"Alternating zigzag (≥{int(THRESHOLD*100)}% swings)  —  3-year daily  —  9 stocks",
    color=TEXT_COL, fontsize=15, y=0.995
)

for ax, sym in zip(axes.flat, SYMBOLS):
    ax.set_facecolor(PANEL_BG)
    ax.tick_params(colors=TEXT_COL, labelsize=7)
    for spine in ax.spines.values():
        spine.set_edgecolor(GRID_COL)
    ax.grid(True, color=GRID_COL, linewidth=0.4, linestyle="--")

    col = close[sym] if sym in close.columns else None
    if col is None:
        ax.set_title(f"{sym}  —  no data", color="red")
        continue

    series = col.squeeze().dropna()
    arr  = series.values.astype(float)
    dates = series.index

    # thin background price line
    ax.plot(dates, arr, color="#555a66", linewidth=0.7, zorder=1)

    pivots = zigzag_alternating(series, THRESHOLD)
    n_swings = max(0, len(pivots) - 1)

    def shade(d0, d1, color):
        mask = (dates >= d0) & (dates <= d1)
        if mask.sum() < 2:
            return
        ax.fill_between(dates[mask], arr[mask], alpha=0.22, color=color, zorder=2)
        ax.plot(dates[mask], arr[mask], color=color, linewidth=1.6, zorder=3)

    if len(pivots) >= 2:
        for i in range(len(pivots) - 1):
            p0, p1 = pivots[i], pivots[i+1]
            going_up = p1['kind'] == 'H'
            shade(p0['date'], p1['date'], GREEN if going_up else RED)
        # gray unconfirmed tail
        shade(pivots[-1]['date'], dates[-1], GRAY_LEG)

        # pivot markers + pct labels
        for i, pv in enumerate(pivots):
            is_high = pv['kind'] == 'H'
            ax.scatter(pv['date'], pv['price'],
                       color=GOLD, s=55, zorder=5,
                       marker='^' if is_high else 'v', linewidths=0)
            offset_y = 10 if is_high else -14
            ax.annotate(f"{'H' if is_high else 'L'}{i}",
                        xy=(pv['date'], pv['price']),
                        xytext=(0, offset_y), textcoords='offset points',
                        fontsize=5.5, color=GOLD, ha='center', zorder=6)

        for i in range(len(pivots) - 1):
            p0, p1 = pivots[i], pivots[i+1]
            pct = (p1['price'] / p0['price'] - 1) * 100
            mid_date = p0['date'] + (p1['date'] - p0['date']) / 2
            mid_price = (p0['price'] + p1['price']) / 2
            ax.annotate(f"{pct:+.0f}%",
                        xy=(mid_date, mid_price),
                        fontsize=6, color=TEXT_COL, ha='center', va='center',
                        bbox=dict(boxstyle='round,pad=0.15', fc=PANEL_BG, ec='none', alpha=0.75),
                        zorder=7)

    ax.set_title(f"{sym}  —  {n_swings} confirmed swings", color=TEXT_COL, fontsize=10, pad=5)
    ax.set_ylabel("$", color=TEXT_COL, fontsize=8)
    ax.tick_params(axis='x', rotation=20)
    print(f"  {sym}: {n_swings} swings, {len(pivots)} pivots")

plt.tight_layout(rect=[0, 0, 1, 0.995], pad=1.2, h_pad=2.0, w_pad=1.0)
out = "/home/mtrencseni/stocks/explore_toy/zigzag_nine.png"
fig.savefig(out, dpi=140, bbox_inches="tight", facecolor=DARK_BG)
plt.close(fig)
print(f"\nSaved {out}")
