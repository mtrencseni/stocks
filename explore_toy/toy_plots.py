"""
Toy scatter plots for the Explore tab design.
Standalone script — does NOT touch app.py, static/, or data/.
Saves scatter_a_character.png and scatter_b_timing.png.
"""

import sys
import warnings
import numpy as np
import pandas as pd
import yfinance as yf
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
from scipy import stats

warnings.filterwarnings("ignore")

# ── Universe ──────────────────────────────────────────────────────────────────
STOCKS = [
    # original 9
    "ADBE", "ASAN", "META", "NVDA", "PATH", "PYPL", "SMCI", "TEAM", "TSLA",
    # bigtech
    "AAPL", "MSFT", "GOOGL", "AMZN", "NFLX",
    # semis
    "AMD", "INTC", "AVGO", "QCOM", "MU",
    # SaaS / cloud
    "CRM", "ORCL", "NOW", "SNOW", "SHOP",
    # volatile tech / cybersec
    "UBER", "PANW", "CRWD", "DDOG", "NET", "ZM",
]
SECTOR_ETF = "QQQ"
ALL_TICKERS = STOCKS + [SECTOR_ETF]

LOOKBACK_YEARS = 3
MIN_BARS = 252  # ~1 year minimum

# Backtest params (from the "resilience" post sweet-spot)
BT_TP = 1.40   # take-profit at +40%
BT_SL = 0.60   # stop-loss  at -40%
BT_HOLD = 126  # max hold ~6 months

# ── Data download ─────────────────────────────────────────────────────────────
print(f"Downloading {len(ALL_TICKERS)} tickers, {LOOKBACK_YEARS}y daily …")
end = pd.Timestamp.today()
start = end - pd.DateOffset(years=LOOKBACK_YEARS)

raw = yf.download(
    ALL_TICKERS, start=start.strftime("%Y-%m-%d"), end=end.strftime("%Y-%m-%d"),
    auto_adjust=True, progress=True
)

# Extract Close panel
if isinstance(raw.columns, pd.MultiIndex):
    close = raw["Close"]
else:
    close = raw[["Close"]].rename(columns={"Close": ALL_TICKERS[0]})

close = close.dropna(how="all")
print(f"Downloaded {len(close)} trading days.")

# ── Metric computation ────────────────────────────────────────────────────────

def zigzag_count(prices, threshold=0.40):
    """Count confirmed peak-to-trough reversals >= threshold."""
    arr = prices.values
    n = len(arr)
    if n < 2:
        return 0
    pivots = [arr[0]]
    direction = None  # +1 = looking for high, -1 = looking for low
    count = 0
    hi = lo = arr[0]
    for p in arr[1:]:
        if direction is None:
            if p > hi:
                hi = p
            elif p < lo:
                lo = p
            # decide direction once first move materialises
            if hi / lo - 1 >= threshold:
                if hi == arr[0]:
                    direction = -1  # started high, looking for low
                else:
                    direction = 1
        elif direction == 1:   # looking for new high
            if p > hi:
                hi = p
            elif hi / p - 1 >= threshold:
                # confirmed trough
                count += 1
                lo = p
                hi = p
                direction = 1
        else:  # direction == -1, looking for new low
            if p < lo:
                lo = p
            elif p / lo - 1 >= threshold:
                # confirmed peak
                count += 1
                hi = p
                lo = p
                direction = -1
    return count


def run_backtest(prices, tp=BT_TP, sl=BT_SL, hold=BT_HOLD):
    """Ensemble backtest: one entry per day, exit on TP/SL/max-hold."""
    arr = prices.values
    n = len(arr)
    returns = []
    for i in range(n - 1):
        entry = arr[i]
        ret = None
        for j in range(i + 1, min(i + hold + 1, n)):
            r = arr[j] / entry
            if r >= tp:
                ret = (r - 1) * 100
                break
            if r <= sl:
                ret = (r - 1) * 100
                break
        if ret is None:
            # max-hold exit
            ret = (arr[min(i + hold, n - 1)] / entry - 1) * 100
        returns.append(ret)
    if not returns:
        return np.nan, np.nan
    arr_r = np.array(returns)
    return float(np.mean(arr_r)), float(np.mean(arr_r > 0))


def compute_metrics(sym, price_series, qqq_series):
    """Return dict of metrics for one stock."""
    s = price_series.dropna()
    if len(s) < MIN_BARS:
        print(f"  SKIP {sym}: only {len(s)} bars")
        return None

    log_ret = np.log(s / s.shift(1)).dropna()

    # annualised volatility
    ann_vol = float(log_ret.std() * np.sqrt(252) * 100)

    # drift: OLS slope of log(price) on time-in-years
    t = np.arange(len(s)) / 252.0
    slope, intercept, r_val, _, _ = stats.linregress(t, np.log(s.values))
    drift = float(slope * 100)   # %/yr
    r2 = float(r_val ** 2)

    # swing count (zigzag)
    swing_count = zigzag_count(s, threshold=0.40)

    # ripeness: % below 3y mean (positive = cheaper)
    mean_price = float(s.mean())
    last_price = float(s.iloc[-1])
    ripeness = (mean_price - last_price) / mean_price * 100

    # drawdown from 3y high
    max_price = float(s.max())
    dd_from_high = (max_price - last_price) / max_price * 100

    # backtest
    bt_avgret, bt_winrate = run_backtest(s)

    # factor: beta vs QQQ, then idiosyncratic 60d return
    qqq = qqq_series.dropna()
    common = s.index.intersection(qqq.index)
    if len(common) < 60:
        factor_idio = np.nan
    else:
        s_c = s.loc[common]
        q_c = qqq.loc[common]
        s_ret = np.log(s_c / s_c.shift(1)).dropna()
        q_ret = np.log(q_c / q_c.shift(1)).dropna()
        idx = s_ret.index.intersection(q_ret.index)
        beta_slope, _, _, _, _ = stats.linregress(q_ret.loc[idx].values, s_ret.loc[idx].values)
        # 60-day return (last 60 bars)
        s60 = float(s_c.iloc[-1] / s_c.iloc[-61] - 1) if len(s_c) > 61 else np.nan
        q60 = float(q_c.iloc[-1] / q_c.iloc[-61] - 1) if len(q_c) > 61 else np.nan
        factor_idio = (s60 - beta_slope * q60) * 100 if (s60 is not None and q60 is not None) else np.nan

    return {
        "sym": sym,
        "ann_vol": ann_vol,
        "drift": drift,
        "r2": r2,
        "swing_count": swing_count,
        "ripeness": ripeness,
        "dd_from_high": dd_from_high,
        "bt_avgret": bt_avgret,
        "bt_winrate": bt_winrate,
        "factor_idio": factor_idio,
    }


print("Computing metrics …")
qqq_series = close[SECTOR_ETF] if SECTOR_ETF in close.columns else pd.Series(dtype=float)

rows = []
for sym in STOCKS:
    if sym not in close.columns:
        print(f"  MISSING {sym}")
        continue
    print(f"  {sym} …", end=" ", flush=True)
    m = compute_metrics(sym, close[sym], qqq_series)
    if m:
        rows.append(m)
        print(f"vol={m['ann_vol']:.0f}% drift={m['drift']:.0f}%/yr bt={m['bt_avgret']:.1f}%")
    else:
        print("skipped")

df = pd.DataFrame(rows).set_index("sym")
print(f"\n{len(df)} stocks with metrics.\n")
print(df[["ann_vol","drift","r2","swing_count","ripeness","dd_from_high","bt_avgret","bt_winrate","factor_idio"]].to_string())

# ── Plotting helpers ──────────────────────────────────────────────────────────
DARK_BG  = "#0e0e0f"
PANEL_BG = "#22242a"
TEXT_COL = "#c6c7ca"
GRID_COL = "#333640"

def setup_dark_ax(ax, title, xlabel, ylabel):
    ax.set_facecolor(PANEL_BG)
    ax.figure.set_facecolor(DARK_BG)
    ax.title.set_color(TEXT_COL)
    ax.xaxis.label.set_color(TEXT_COL)
    ax.yaxis.label.set_color(TEXT_COL)
    ax.tick_params(colors=TEXT_COL)
    for spine in ax.spines.values():
        spine.set_edgecolor(GRID_COL)
    ax.grid(True, color=GRID_COL, linewidth=0.5, linestyle="--")
    ax.set_title(title, color=TEXT_COL, fontsize=11, pad=8)
    ax.set_xlabel(xlabel, color=TEXT_COL, fontsize=9)
    ax.set_ylabel(ylabel, color=TEXT_COL, fontsize=9)


def annotate_points(ax, df_sub, x_col, y_col):
    for sym, row in df_sub.iterrows():
        ax.annotate(
            sym,
            xy=(row[x_col], row[y_col]),
            xytext=(4, 4),
            textcoords="offset points",
            fontsize=7,
            color=TEXT_COL,
            alpha=0.9,
        )

# ── Scatter A — Character ─────────────────────────────────────────────────────
df_a = df.dropna(subset=["ann_vol", "drift", "swing_count", "bt_avgret"])

fig, ax = plt.subplots(figsize=(11, 8))
fig.patch.set_facecolor(DARK_BG)

size_a = np.clip(df_a["swing_count"] * 30 + 60, 60, 600)
vmin_a = df_a["bt_avgret"].quantile(0.05)
vmax_a = df_a["bt_avgret"].quantile(0.95)
norm_a = mcolors.TwoSlopeNorm(vmin=vmin_a, vcenter=0, vmax=max(vmax_a, 0.1))

sc_a = ax.scatter(
    df_a["drift"], df_a["ann_vol"],
    s=size_a,
    c=df_a["bt_avgret"],
    cmap="RdYlGn",
    norm=norm_a,
    alpha=0.85,
    edgecolors=TEXT_COL,
    linewidths=0.4,
    zorder=3,
)
annotate_points(ax, df_a, "drift", "ann_vol")

# reference lines
ax.axvline(0, color="#88889a", linewidth=0.8, linestyle="--", alpha=0.6)

cb_a = fig.colorbar(sc_a, ax=ax, pad=0.02)
cb_a.set_label("Backtest avg return / trade (%)\n(TP+40% / SL-40% / max 6mo hold)", color=TEXT_COL, fontsize=8)
cb_a.ax.yaxis.set_tick_params(color=TEXT_COL)
plt.setp(cb_a.ax.yaxis.get_ticklabels(), color=TEXT_COL, fontsize=7)

setup_dark_ax(
    ax,
    "Scatter A — Character: 'Is this my kind of stock?'",
    "Annualized drift / sidewaysness (%/yr)\n← downtrend / perma-decliner | FLAT = GOOD | uptrend / at ATH →",
    "Annualized volatility (%)\n(higher = bigger swings = more opportunity)",
)

# size legend
for sc_val, label in [(2, "2 swings"), (5, "5 swings"), (10, "10 swings")]:
    ax.scatter([], [], s=sc_val*30+60, c="gray", alpha=0.5, label=label, edgecolors=TEXT_COL, linewidths=0.3)
leg = ax.legend(title="Dot size = swing count\n(≥40% reversals in 3y)", title_fontsize=7, fontsize=7,
                loc="upper left", facecolor=PANEL_BG, edgecolor=GRID_COL, labelcolor=TEXT_COL)
leg.get_title().set_color(TEXT_COL)

ax.text(0.5, -0.15,
    "Sweet spot: upper-middle (high vol, flat drift, green color). Avoid: left column (falling knife) & extreme right (ATH).",
    transform=ax.transAxes, ha="center", fontsize=8, color="#aaaaaa", style="italic")

plt.tight_layout()
out_a = "/home/mtrencseni/stocks/explore_toy/scatter_a_character.png"
fig.savefig(out_a, dpi=130, bbox_inches="tight", facecolor=DARK_BG)
plt.close(fig)
print(f"\nSaved {out_a}")

# ── Scatter B — Timing ────────────────────────────────────────────────────────
df_b = df.dropna(subset=["ripeness", "dd_from_high", "drift", "bt_winrate"])

fig, ax = plt.subplots(figsize=(11, 8))
fig.patch.set_facecolor(DARK_BG)

size_b = np.clip(df_b["bt_winrate"] * 400, 40, 400)

# Color by drift: diverging, center=0 (flat=good)
vmin_b = df_b["drift"].quantile(0.05)
vmax_b = df_b["drift"].quantile(0.95)
norm_b = mcolors.TwoSlopeNorm(vmin=min(vmin_b, -0.1), vcenter=0, vmax=max(vmax_b, 0.1))

sc_b = ax.scatter(
    df_b["ripeness"], df_b["dd_from_high"],
    s=size_b,
    c=df_b["drift"],
    cmap="RdYlGn",
    norm=norm_b,
    alpha=0.85,
    edgecolors=TEXT_COL,
    linewidths=0.4,
    zorder=3,
)
annotate_points(ax, df_b, "ripeness", "dd_from_high")

ax.axvline(0, color="#88889a", linewidth=0.8, linestyle="--", alpha=0.6, label="at 3y mean")
ax.axhline(0, color="#88889a", linewidth=0.8, linestyle="--", alpha=0.6)

cb_b = fig.colorbar(sc_b, ax=ax, pad=0.02)
cb_b.set_label("Drift / sidewaysness (%/yr)\n← falling knife (RED) | flat=GOOD (yellow) | uptrend (GREEN) →",
               color=TEXT_COL, fontsize=8)
cb_b.ax.yaxis.set_tick_params(color=TEXT_COL)
plt.setp(cb_b.ax.yaxis.get_ticklabels(), color=TEXT_COL, fontsize=7)

setup_dark_ax(
    ax,
    "Scatter B — Timing: 'Is it ripe right now?'",
    "Ripeness: % below 3-year mean price (%)\n(right = more depressed / cheaper vs own history)",
    "Drawdown from 3-year high (%)\n[STUB for valuation — real axis = P/E or P/S vs own history, pending scrape]",
)

# size legend
for wrate, label in [(0.5, "50% win"), (0.7, "70% win"), (0.9, "90% win")]:
    ax.scatter([], [], s=wrate*400, c="gray", alpha=0.5, label=label, edgecolors=TEXT_COL, linewidths=0.3)
leg = ax.legend(title="Dot size = backtest win rate", title_fontsize=7, fontsize=7,
                loc="upper left", facecolor=PANEL_BG, edgecolor=GRID_COL, labelcolor=TEXT_COL)
leg.get_title().set_color(TEXT_COL)

ax.text(0.5, -0.17,
    "Sweet spot: upper-right, yellow color (cheap vs own history, flat trend). Red = falling knife: "
    "looks ripe but trend is down.\n"
    "Y-axis is a STUB (dd_from_high). Real axis = P/E or P/S vs own 3y history — joins after macrotrends backfill.",
    transform=ax.transAxes, ha="center", fontsize=8, color="#aaaaaa", style="italic")

plt.tight_layout()
out_b = "/home/mtrencseni/stocks/explore_toy/scatter_b_timing.png"
fig.savefig(out_b, dpi=130, bbox_inches="tight", facecolor=DARK_BG)
plt.close(fig)
print(f"Saved {out_b}")

print("\nDone.")
