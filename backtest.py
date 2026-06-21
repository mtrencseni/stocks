"""
Backtest engine for the per-stock Backtest tab. Same ensemble model as
screener._backtest (one entry per day, exit on first TP/SL touch within the
holding window, else force-exit at the window/data end), so the default cell
(Δ=0.4 -> TP +40% / SL -40%, hold 126d) matches the Trade screener's numbers.

Two products:
  run_single() -> metrics + per-day trade outcomes (for the coloured price
                  chart) + per-trade return histogram for one strategy.
  run_sweep()  -> a Δ x max-hold grid of win/return/Sharpe (the blog's 3-panel
                  landscape), plus the Dickey-Fuller mean-reversion stat.

The inner first-touch is vectorised (numpy argmax over the window), keeping a
full 9x7 sweep at ~0.3-0.5s for a single stock — no parallelism needed.
"""

import math
import numpy as np

MONTH = 21   # trading days per month

# sweep axes — Δ (symmetric TP/SL) x max holding length
SWEEP_DELTAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
SWEEP_HOLDS = [("1mo", 21), ("3mo", 63), ("6mo", 126),
               ("12mo", 252), ("24mo", 504), ("36mo", 756)]

DF_CRIT_5 = -2.86   # Dickey-Fuller 5% critical value (constant, no trend)


def _fin(x):
    """JSON-safe float (NaN/inf -> None)."""
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _simulate(arr, tp, sl, hold, max_price=None):
    """Ensemble sim. Returns (ret, days, resolved) arrays of length n, aligned to
    the entry day; NaN where no trade was entered.
      ret      — trade return %, exit on first TP/SL touch else force-exit.
      days     — holding days until exit.
      resolved — True if a barrier was hit, or it timed out with a full window
                 inside the data; False if the window was truncated by data end
                 (outcome unknown -> shown grey, but still counted, as screener does).
    """
    n = len(arr)
    ret = np.full(n, np.nan)
    days = np.full(n, np.nan)
    resolved = np.zeros(n, dtype=bool)
    for i in range(n - 1):
        e = arr[i]
        if max_price is not None and e > max_price:
            continue
        end = min(i + hold + 1, n)
        w = arr[i + 1:end]
        if w.size == 0:
            continue
        up = np.flatnonzero(w >= tp * e)
        dn = np.flatnonzero(w <= sl * e)
        ui = up[0] if up.size else None
        di = dn[0] if dn.size else None
        if ui is None and di is None:
            k = w.size - 1                       # no touch -> force exit at window end
            resolved[i] = (i + hold < n)         # full window fit? then a real timeout
        else:
            k = min(x for x in (ui, di) if x is not None)
            resolved[i] = True
        ret[i] = (w[k] / e - 1.0) * 100.0
        days[i] = k + 1
    return ret, days, resolved


def _agg(ret):
    """Summary metrics over the entered trades (NaNs dropped)."""
    r = ret[~np.isnan(ret)]
    if r.size == 0:
        return None
    std = float(r.std())
    return {
        "n_trades": int(r.size),
        "win": float((r > 0).mean()),
        "mean_ret": float(r.mean()),
        "std": std,
        "sharpe": float(r.mean() / std) if std > 0 else None,
        "cond_win_ret": float(r[r > 0].mean()) if (r > 0).any() else 0.0,
    }


def run_single(t, arr, delta, hold, max_price=None, bins=25):
    """Full detail for one strategy: metrics, per-day outcomes, histogram."""
    arr = np.asarray(arr, dtype=float)
    n = len(arr)
    tp, sl = 1.0 + delta, 1.0 - delta
    ret, days, resolved = _simulate(arr, tp, sl, hold, max_price)
    m = _agg(ret)

    entered = ~np.isnan(ret)
    avg_days = float(days[entered].mean()) if entered.any() else None
    ann = None
    if m and avg_days and avg_days > 0:
        ann = ((1.0 + m["mean_ret"] / 100.0) ** (252.0 / avg_days) - 1.0) * 100.0

    metrics = None
    if m:
        metrics = {
            "win": _fin(m["win"]), "mean_ret": _fin(m["mean_ret"]),
            "ann_ret": _fin(ann), "sharpe": _fin(m["sharpe"]),
            "n_trades": m["n_trades"], "trade_ratio": _fin(m["n_trades"] / (n - 1)) if n > 1 else None,
            "avg_hold_days": _fin(avg_days), "cond_win_ret": _fin(m["cond_win_ret"]),
        }

    # per-day outcomes for the coloured price chart
    out = [None if math.isnan(v) else _fin(v) for v in ret]
    res = [bool(resolved[i]) and not math.isnan(ret[i]) for i in range(n)]

    hist = None
    r = ret[entered]
    if r.size:
        counts, edges = np.histogram(r, bins=bins)
        hist = {"edges": [_fin(x) for x in edges], "counts": [int(c) for c in counts]}

    return {
        "delta": delta, "hold": hold, "tp": tp, "sl": sl, "max_price": max_price,
        "metrics": metrics,
        "t": t, "c": [_fin(x) for x in arr],
        "out": out, "resolved": res,
        "hist": hist,
    }


def run_sweep(arr, max_price=None, deltas=SWEEP_DELTAS, holds=SWEEP_HOLDS):
    """Δ x max-hold grid of win / mean-return / Sharpe (per-trade)."""
    arr = np.asarray(arr, dtype=float)
    n = len(arr)
    use_holds, win, mean_ret, sharpe = [], [], [], []
    for label, days in holds:
        if days >= n - 1:           # not enough history for this hold at this range
            continue
        use_holds.append({"label": label, "days": days})
        wl, ml, sh = [], [], []
        for d in deltas:
            ret, _, _ = _simulate(arr, 1.0 + d, 1.0 - d, days, max_price)
            m = _agg(ret)
            wl.append(_fin(m["win"]) if m else None)
            ml.append(_fin(m["mean_ret"]) if m else None)
            sh.append(_fin(m["sharpe"]) if m else None)
        win.append(wl); mean_ret.append(ml); sharpe.append(sh)
    return {"deltas": deltas, "holds": use_holds,
            "win": win, "mean_ret": mean_ret, "sharpe": sharpe}


def dickey_fuller(arr):
    """DF unit-root t-stat on the price level: Δy = α + γ·y_{t-1} + ε.
    More negative t = more mean-reverting; t < ~-2.86 rejects random walk at 5%."""
    y = np.asarray(arr, dtype=float)
    if len(y) < 30:
        return None
    dy = np.diff(y)
    ylag = y[:-1]
    X = np.column_stack([np.ones_like(ylag), ylag])
    beta, *_ = np.linalg.lstsq(X, dy, rcond=None)
    resid = dy - X @ beta
    dof = len(dy) - 2
    if dof <= 0:
        return None
    s2 = float(resid @ resid) / dof
    try:
        cov = s2 * np.linalg.inv(X.T @ X)
    except np.linalg.LinAlgError:
        return None
    se = math.sqrt(cov[1, 1]) if cov[1, 1] > 0 else None
    if not se:
        return None
    t = beta[1] / se
    return {"t_stat": _fin(t), "crit5": DF_CRIT_5,
            "verdict": "mean-reverting" if t < DF_CRIT_5 else "random walk"}
