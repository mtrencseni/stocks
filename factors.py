"""
Factor model over the screener universe.

For every universe stock, regress daily log returns on three factors:

    r_stock = a + b_mkt * r_SPY + b_ind * r_indETF_orth + b_mom * r_MTUM_orth + e

  - market   = SPY
  - industry = the stock's mapped sector/industry ETF (universe.json), with the
               market component regressed out (orthogonalized) so b_mkt/b_ind
               are not collinear
  - momentum = MTUM (global factor; the per-stock part is only the loading),
               also orthogonalized vs the market

Outputs, per stock: annualized alpha (%/yr), the three betas, R2 (%), and a
20-day idiosyncratic residual z-score. Plus the factor daily-return series
(for the per-stock reconstruction endpoint) and a "strip" of raw factor
performance (SPY / MTUM / each industry ETF) for the pane's header.

One batched yf.download per lookback; the caller caches the payload (SWR).
"""

import math
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf

from screener import IND, IND_LABEL, _f

MKT = "SPY"
MOM = "MTUM"
LOOKBACK_YEARS = {"1y": 1, "3y": 3, "5y": 5}
IDIO_WINDOW = 20      # days for the residual z-score
TRADING_DAYS = 252
MIN_OBS = 120         # skip stocks with fewer aligned return days
SPARK_POINTS = 120


def _spark(vals, n=SPARK_POINTS):
    """Downsample a list to ~n points (keeps the last point)."""
    if len(vals) <= n:
        return [_f(v) for v in vals]
    idxs = np.linspace(0, len(vals) - 1, n).astype(int)
    return [_f(vals[i]) for i in idxs]


def _series_payload(s):
    """pd.Series (date-indexed daily log returns) -> {dates, r} JSON payload."""
    return {"dates": [d.date().isoformat() for d in s.index],
            "r": [_f(v) for v in s.values]}


def build_factors(lookback="3y"):
    years = LOOKBACK_YEARS[lookback]
    etfs = sorted({e for e in IND.values() if e})
    tickers = sorted(set(IND.keys()) | set(etfs) | {MKT, MOM})
    px = yf.download(tickers, period=f"{years}y", interval="1d",
                     auto_adjust=True, progress=False, group_by="column")["Close"]
    px = px.dropna(how="all")
    rets = np.log(px / px.shift(1))

    mkt = rets[MKT].dropna()
    if not len(mkt):
        raise RuntimeError("no market (SPY) data")

    def _orth(series):
        """Residual of regressing a factor's returns on the market (same window)."""
        s = series.dropna()
        idx = s.index.intersection(mkt.index)
        if len(idx) < 60:
            return None
        y = s.loc[idx].values
        x = mkt.loc[idx].values
        vx = np.var(x)
        b = float(np.cov(x, y, bias=True)[0, 1] / vx) if vx > 0 else 0.0
        return pd.Series(y - b * x, index=idx)

    mom = _orth(rets[MOM]) if MOM in rets else None
    ind_orth = {e: _orth(rets[e]) for e in etfs if e in rets}

    rows = []
    for sym, etf in IND.items():
        if sym not in rets:
            continue
        ind = ind_orth.get(etf)
        if ind is None or mom is None:
            continue
        sr = rets[sym].dropna()
        idx = sr.index.intersection(mkt.index).intersection(ind.index).intersection(mom.index)
        if len(idx) < MIN_OBS:
            continue
        y = sr.loc[idx].values
        X = np.column_stack([np.ones(len(idx)), mkt.loc[idx].values,
                             ind.loc[idx].values, mom.loc[idx].values])
        coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
        resid = y - X @ coef
        ss_res = float((resid ** 2).sum())
        ss_tot = float(((y - y.mean()) ** 2).sum())
        r2 = (1 - ss_res / ss_tot) if ss_tot > 0 else None
        sd = resid.std()
        idio_z = (float(resid[-IDIO_WINDOW:].sum() / (sd * math.sqrt(IDIO_WINDOW)))
                  if sd > 0 and len(resid) >= IDIO_WINDOW else None)
        rows.append({
            "sym": sym, "ind": etf,
            "alpha": _f(coef[0] * TRADING_DAYS * 100),   # annualized, %/yr
            "b_mkt": _f(coef[1]), "b_ind": _f(coef[2]), "b_mom": _f(coef[3]),
            "r2": _f(r2 * 100) if r2 is not None else None,
            "idio_z": _f(idio_z),
        })

    # header strip: RAW cumulative performance of the factors-as-tickers
    strip = []
    def _strip_entry(tk, label, kind):
        r = rets[tk].dropna() if tk in rets else None
        if r is None or not len(r):
            return
        cum = (np.exp(r.cumsum()) - 1) * 100
        strip.append({"key": tk, "label": label, "kind": kind,
                      "ret": _f(float(cum.iloc[-1])), "spark": _spark(list(cum.values))})
    _strip_entry(MKT, "S&P 500", "mkt")
    _strip_entry(MOM, "Momentum", "mom")
    for e in etfs:
        _strip_entry(e, IND_LABEL.get(e, e), "ind")

    return {
        "asof": datetime.now().isoformat(timespec="seconds"),
        "lookback": lookback,
        "stocks": rows,
        # orthogonalized factor daily returns, for the reconstruction endpoint
        "factors": {
            "mkt": _series_payload(mkt),
            "mom": _series_payload(mom) if mom is not None else None,
            "ind": {e: _series_payload(s) for e, s in ind_orth.items() if s is not None},
        },
        "strip": strip,
    }
