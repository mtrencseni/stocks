"""
Count confirmed upswings (L→H ≥40%) for all Nasdaq-100 stocks.
Show the top-9 as a large zigzag chart.
"""

import numpy as np
import pandas as pd
import yfinance as yf
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import warnings
warnings.filterwarnings("ignore")

THRESHOLD    = 0.40
LOOKBACK_YEARS = 3

# ── Nasdaq-100 components (2024-2025 composition) ─────────────────────────────
NDX100 = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","AVGO","COST",
    "NFLX","AMD","QCOM","TMUS","PEP","CSCO","INTU","TXN","CMCSA","AMGN",
    "HON","AMAT","MU","BKNG","LRCX","ADI","PANW","SBUX","GILD","MDLZ",
    "REGN","ADP","VRTX","KLAC","SNPS","CDNS","CRWD","CSX","MAR","MRVL",
    "ABNB","ORLY","TEAM","KDP","PYPL","CTAS","NXPI","WDAY","PAYX","FAST",
    "FTNT","DXCM","CEG","PCAR","ROST","ODFL","MCHP","KHC","VRSK","IDXX",
    "CPRT","GEHC","EXC","CTSH","BIIB","ON","EA","TTD","DDOG","ZS",
    "ANSS","ILMN","TTWO","MDB","WBD","DASH","SMCI","DLTR","ZM","ALGN",
    "MELI","ASML","AZN","LIN","FANG","ROP","ADSK","MNST","SIRI","ENPH",
    "OKTA","NET","SNOW","ADBE","ASAN","PATH","SHOP","UBER","ORCL","NOW",
]

DARK_BG  = "#0e0e0f"
PANEL_BG = "#22242a"
TEXT_COL = "#c6c7ca"
GRID_COL = "#333640"
GREEN    = "#89c996"
RED      = "#ec8a82"
GOLD     = "#f0c040"
GRAY_LEG = "#666677"

# ── Download ──────────────────────────────────────────────────────────────────
print(f"Downloading {len(NDX100)} tickers …")
end   = pd.Timestamp.today()
start = end - pd.DateOffset(years=LOOKBACK_YEARS)
raw   = yf.download(NDX100, start=start.strftime("%Y-%m-%d"),
                    end=end.strftime("%Y-%m-%d"), auto_adjust=True, progress=True)
close = raw["Close"]
print(f"Got {close.shape[1]} ticker columns, {len(close)} bars.\n")

# ── Alternating zigzag → pivot list ──────────────────────────────────────────
def zigzag_alternating(series, threshold=0.40):
    s   = series.dropna()
    arr = s.values.astype(float)
    dates = s.index
    n = len(arr)
    if n < 40:
        return []

    pivots = []
    direction = 0
    cand_val = arr[0]
    cand_idx = 0
    init_done = False

    for i in range(1, n):
        p = float(arr[i])

        if not init_done:
            if p > cand_val:
                cand_val = p; cand_idx = i
            # first move UP → start is a low
            if cand_val / arr[0] - 1 >= threshold:
                sub = arr[:i+1]
                max_idx = int(np.argmax(sub))
                min_before = float(np.min(sub[:max_idx+1])) if max_idx > 0 else float(arr[0])
                min_before_idx = int(np.argmin(sub[:max_idx+1])) if max_idx > 0 else 0
                pivots.append({'date': dates[min_before_idx], 'price': min_before, 'kind': 'L'})
                pivots.append({'date': dates[max_idx], 'price': float(sub[max_idx]), 'kind': 'H'})
                direction = -1; cand_val = p; cand_idx = i; init_done = True
                continue
            # first move DOWN → start is a high
            sub = arr[:i+1]
            min_val = float(np.min(sub)); min_idx = int(np.argmin(sub))
            if arr[0] / min_val - 1 >= threshold:
                pivots.append({'date': dates[0], 'price': float(arr[0]), 'kind': 'H'})
                pivots.append({'date': dates[min_idx], 'price': min_val, 'kind': 'L'})
                direction = 1; cand_val = p; cand_idx = i; init_done = True
                continue
        else:
            if direction == 1:
                if p > cand_val:
                    cand_val = p; cand_idx = i
                elif cand_val / p - 1 >= threshold:
                    pivots.append({'date': dates[cand_idx], 'price': cand_val, 'kind': 'H'})
                    direction = -1; cand_val = p; cand_idx = i
            else:
                if p < cand_val:
                    cand_val = p; cand_idx = i
                elif p / cand_val - 1 >= threshold:
                    pivots.append({'date': dates[cand_idx], 'price': cand_val, 'kind': 'L'})
                    direction = 1; cand_val = p; cand_idx = i

    return pivots


def count_upswings(pivots):
    return sum(
        1 for i in range(len(pivots) - 1)
        if pivots[i]['kind'] == 'L' and pivots[i+1]['kind'] == 'H'
    )


# ── Score every ticker ────────────────────────────────────────────────────────
scores = {}
pivot_cache = {}
for sym in NDX100:
    col = close.get(sym)
    if col is None:
        continue
    s = col.squeeze().dropna()
    if len(s) < 100:
        continue
    pvs = zigzag_alternating(s, THRESHOLD)
    up  = count_upswings(pvs)
    scores[sym]      = up
    pivot_cache[sym] = pvs
    print(f"  {sym:6s}  {up} upswings")

ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
print("\nTop 15:")
for sym, cnt in ranked[:15]:
    print(f"  {sym:6s}  {cnt}")

top9 = [sym for sym, _ in ranked[:9]]
print(f"\nTop 9: {top9}")

# ── Plot top 9 ────────────────────────────────────────────────────────────────
fig, axes = plt.subplots(3, 3, figsize=(24, 20), facecolor=DARK_BG)
fig.suptitle(
    f"Top-9 Nasdaq-100 stocks by confirmed upswings (L→H ≥{int(THRESHOLD*100)}%)  —  3-year daily",
    color=TEXT_COL, fontsize=15, y=0.998,
)

for ax, sym in zip(axes.flat, top9):
    ax.set_facecolor(PANEL_BG)
    ax.tick_params(colors=TEXT_COL, labelsize=7)
    for spine in ax.spines.values():
        spine.set_edgecolor(GRID_COL)
    ax.grid(True, color=GRID_COL, linewidth=0.4, linestyle="--")

    series = close[sym].squeeze().dropna()
    arr    = series.values.astype(float)
    dates  = series.index
    pivots = pivot_cache[sym]
    n_up   = count_upswings(pivots)

    ax.plot(dates, arr, color="#555a66", linewidth=0.7, zorder=1)

    def shade(d0, d1, color):
        mask = (dates >= d0) & (dates <= d1)
        if mask.sum() < 2:
            return
        ax.fill_between(dates[mask], arr[mask], alpha=0.22, color=color, zorder=2)
        ax.plot(dates[mask], arr[mask], color=color, linewidth=1.6, zorder=3)

    if len(pivots) >= 2:
        for i in range(len(pivots) - 1):
            p0, p1 = pivots[i], pivots[i+1]
            shade(p0['date'], p1['date'], GREEN if p1['kind'] == 'H' else RED)
        shade(pivots[-1]['date'], dates[-1], GRAY_LEG)

        for pv in pivots:
            is_high = pv['kind'] == 'H'
            ax.scatter(pv['date'], pv['price'],
                       color=GOLD, s=50, zorder=5,
                       marker='^' if is_high else 'v', linewidths=0)

        for i in range(len(pivots) - 1):
            p0, p1 = pivots[i], pivots[i+1]
            if p0['kind'] == 'L' and p1['kind'] == 'H':   # upswing only: annotate %
                pct = (p1['price'] / p0['price'] - 1) * 100
                mid_date  = p0['date'] + (p1['date'] - p0['date']) / 2
                mid_price = (p0['price'] + p1['price']) / 2
                ax.annotate(f"+{pct:.0f}%",
                            xy=(mid_date, mid_price),
                            fontsize=6.5, color=GREEN, ha='center', va='center', fontweight='bold',
                            bbox=dict(boxstyle='round,pad=0.15', fc=PANEL_BG, ec='none', alpha=0.8),
                            zorder=7)

    ax.set_title(f"{sym}  —  {n_up} upswings  (rank #{top9.index(sym)+1})",
                 color=TEXT_COL, fontsize=11, pad=5)
    ax.set_ylabel("$", color=TEXT_COL, fontsize=8)
    ax.tick_params(axis='x', rotation=20)

plt.tight_layout(rect=[0, 0, 1, 0.996], pad=1.2, h_pad=2.2, w_pad=1.0)
out = "/home/mtrencseni/stocks/explore_toy/zigzag_ndx_top9.png"
fig.savefig(out, dpi=140, bbox_inches="tight", facecolor=DARK_BG)
plt.close(fig)
print(f"\nSaved {out}")
