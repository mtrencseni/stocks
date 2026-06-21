"""
Screener metrics for the Explore view.

Pure price-based metrics over a daily lookback window, computed server-side for
a fixed universe (Nasdaq-100) plus sector/industry ETFs (for the factor metric).
One batched yf.download per call; the route caches the result hard.

Metrics per stock:
  vol     annualized volatility (%)
  drift   OLS slope of log-price vs time, %/yr   (global color)
  r2      R^2 of that fit (trend cleanliness)
  up      confirmed upswings (>=40% low->high) via alternating zigzag
  off52   % below 52-week high (bounded 0-100)        (ripeness)
  dd      drawdown from lookback high (%)   (STUB for valuation vs own history)
  bt_avg  backtest avg return/trade (%)     TP +40% / SL -40% / max 6mo hold
  bt_win  backtest win rate (fraction > 0)
  idio_z  idiosyncratic residual z-score vs the stock's industry ETF
          (negative = off-to-downside vs its group)
"""

import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf

THRESHOLD = 0.40
BT_TP, BT_SL, BT_HOLD = 1.40, 0.60, 126
IDIO_WINDOW = 60

LOOKBACK_YEARS = {"1y": 1, "3y": 3, "5y": 5}

# ticker -> industry/sector ETF (auto-seedable from yfinance .info later)
IND = {
    "NVDA":"SOXX","AVGO":"SOXX","AMD":"SOXX","QCOM":"SOXX","TXN":"SOXX","AMAT":"SOXX",
    "MU":"SOXX","LRCX":"SOXX","ADI":"SOXX","KLAC":"SOXX","MRVL":"SOXX","NXPI":"SOXX",
    "MCHP":"SOXX","ON":"SOXX","ASML":"SOXX","SMCI":"SOXX",
    "MSFT":"IGV","INTU":"IGV","PANW":"IGV","SNPS":"IGV","CDNS":"IGV","CRWD":"IGV",
    "TEAM":"IGV","WDAY":"IGV","FTNT":"IGV","DDOG":"IGV","ZS":"IGV","ANSS":"IGV",
    "MDB":"IGV","OKTA":"IGV","NET":"IGV","SNOW":"IGV","ADBE":"IGV","ASAN":"IGV",
    "PATH":"IGV","SHOP":"IGV","NOW":"IGV","ORCL":"IGV","ADSK":"IGV","CTSH":"IGV","ZM":"IGV",
    "GOOGL":"XLC","GOOG":"XLC","META":"XLC","NFLX":"XLC","CMCSA":"XLC","WBD":"XLC",
    "EA":"XLC","TTWO":"XLC","TTD":"XLC","SIRI":"XLC","TMUS":"XLC",
    "AMZN":"XLY","TSLA":"XLY","BKNG":"XLY","SBUX":"XLY","MAR":"XLY","ABNB":"XLY",
    "ORLY":"XLY","ROST":"XLY","DLTR":"XLY","MELI":"XLY","DASH":"XLY","UBER":"XLY",
    "COST":"XLP","PEP":"XLP","MDLZ":"XLP","KDP":"XLP","KHC":"XLP","MNST":"XLP",
    "AMGN":"XBI","GILD":"XBI","REGN":"XBI","VRTX":"XBI","DXCM":"XBI","IDXX":"XBI",
    "BIIB":"XBI","ILMN":"XBI","ALGN":"XBI","GEHC":"XBI","AZN":"XBI",
    "HON":"XLI","CSX":"XLI","PCAR":"XLI","ODFL":"XLI","FAST":"XLI","CPRT":"XLI",
    "VRSK":"XLI","PAYX":"XLI","ADP":"XLI","CTAS":"XLI","ROP":"XLI",
    "FANG":"XLE","CEG":"XLU","EXC":"XLU","LIN":"XLB","PYPL":"IPAY","ENPH":"TAN",
    "AAPL":"XLK","CSCO":"XLK",
}

UNIVERSES = {"ndx100": list(IND.keys())}

# industry/sector ETF -> human label (kept in sync with the frontend's copy)
IND_LABEL = {
    "SOXX": "Semiconductors", "IGV": "Software/SaaS", "XLC": "Internet/Media",
    "XLY": "Consumer/Retail", "XLP": "Staples", "XBI": "Biotech/Health",
    "XLI": "Industrials", "XLK": "Tech/Hardware", "IPAY": "Payments",
    "TAN": "Solar", "XLE": "Energy", "XLU": "Utilities", "XLB": "Materials",
}


# yfinance .info "exchange" codes -> friendly exchange label
EXCH_LABEL = {
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NIM": "NASDAQ", "NGS": "NASDAQ",
    "NYQ": "NYSE", "PCX": "NYSE Arca", "ASE": "NYSE American",
    "BATS": "Cboe", "BTS": "Cboe",
}


def exchange_label(code):
    return EXCH_LABEL.get(code, code or "")


def segment_label(sym):
    """Our curated segment for a ticker, e.g. 'Software/SaaS (IGV)'. None if unmapped."""
    etf = IND.get(sym)
    if not etf:
        return None
    name = IND_LABEL.get(etf)
    return f"{name} ({etf})" if name else etf


def _f(x):
    """JSON-safe float (NaN/inf -> None)."""
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _linregress(x, y):
    """(slope, intercept, r) — numpy stand-in for scipy.stats.linregress."""
    x = np.asarray(x, dtype=float); y = np.asarray(y, dtype=float)
    slope, intercept = np.polyfit(x, y, 1)
    r = np.corrcoef(x, y)[0, 1]
    return slope, intercept, r


def _zigzag(arr, threshold=THRESHOLD):
    """Alternating zigzag -> list of pivots [{price, kind 'H'|'L'}]."""
    n = len(arr)
    if n < 40:
        return []
    pivots = []
    direction = 0
    cand_val = arr[0]; cand_idx = 0; init = False
    for i in range(1, n):
        p = float(arr[i])
        if not init:
            if p > cand_val:
                cand_val = p; cand_idx = i
            if cand_val / arr[0] - 1 >= threshold:
                sub = arr[:i + 1]; mx = int(np.argmax(sub))
                mb = float(np.min(sub[:mx + 1])) if mx > 0 else float(arr[0])
                pivots += [{"price": mb, "kind": "L"},
                           {"price": float(sub[mx]), "kind": "H"}]
                direction = -1; cand_val = p; cand_idx = i; init = True
                continue
            sub = arr[:i + 1]; mn = float(np.min(sub))
            if arr[0] / mn - 1 >= threshold:
                pivots += [{"price": float(arr[0]), "kind": "H"},
                           {"price": mn, "kind": "L"}]
                direction = 1; cand_val = p; cand_idx = i; init = True
                continue
        else:
            if direction == 1:
                if p > cand_val:
                    cand_val = p; cand_idx = i
                elif cand_val / p - 1 >= threshold:
                    pivots.append({"price": cand_val, "kind": "H"})
                    direction = -1; cand_val = p; cand_idx = i
            else:
                if p < cand_val:
                    cand_val = p; cand_idx = i
                elif p / cand_val - 1 >= threshold:
                    pivots.append({"price": cand_val, "kind": "L"})
                    direction = 1; cand_val = p; cand_idx = i
    return pivots


def _count_upswings(pivots):
    return sum(1 for i in range(len(pivots) - 1)
               if pivots[i]["kind"] == "L" and pivots[i + 1]["kind"] == "H")


def _backtest(arr, tp=BT_TP, sl=BT_SL, hold=BT_HOLD):
    """Ensemble: one entry per day, exit on TP/SL/max-hold. (avg_ret%, win_rate)."""
    n = len(arr); rets = []
    for i in range(n - 1):
        entry = arr[i]; r = None
        for j in range(i + 1, min(i + hold + 1, n)):
            rr = arr[j] / entry
            if rr >= tp:
                r = (rr - 1) * 100; break
            if rr <= sl:
                r = (rr - 1) * 100; break
        if r is None:
            r = (arr[min(i + hold, n - 1)] / entry - 1) * 100
        rets.append(r)
    if not rets:
        return None, None
    a = np.array(rets)
    return float(a.mean()), float((a > 0).mean())


def _metrics(sym, s, etf_series):
    """Compute one stock's metrics from a price Series. None if too short."""
    s = s.dropna()
    if len(s) < 150:
        return None
    arr = s.values.astype(float)
    last = float(arr[-1])

    logret = np.log(s / s.shift(1)).dropna()
    vol = float(logret.std() * np.sqrt(252) * 100)

    t = np.arange(len(s)) / 252.0
    slope, _, r = _linregress(t, np.log(arr))
    drift = float(slope * 100)
    r2 = float(r ** 2)

    up = _count_upswings(_zigzag(arr))

    win = min(252, len(arr))
    high52 = float(arr[-win:].max())
    off52 = (high52 - last) / high52 * 100 if high52 > 0 else None

    mx = float(arr.max())
    lo = float(arr.min())
    dd = (mx - last) / mx * 100 if mx > 0 else None
    # % above the window low, normalized by the high (so dd + above_lo = range/high)
    above_lo = (last - lo) / mx * 100 if mx > 0 else None

    bt_avg, bt_win = _backtest(arr)

    idio_z = None
    if etf_series is not None:
        e = etf_series.dropna()
        common = s.index.intersection(e.index)
        if len(common) > IDIO_WINDOW + 20:
            sr = np.log(s.loc[common] / s.loc[common].shift(1)).dropna()
            er = np.log(e.loc[common] / e.loc[common].shift(1)).dropna()
            idx = sr.index.intersection(er.index)
            if len(idx) > IDIO_WINDOW + 20:
                beta, _, _ = _linregress(er.loc[idx].values, sr.loc[idx].values)
                resid = sr.loc[idx].values - beta * er.loc[idx].values
                sd = resid.std()
                if sd > 0:
                    idio_z = float(resid[-IDIO_WINDOW:].sum() / (sd * np.sqrt(IDIO_WINDOW)))

    return {
        "sym": sym, "ind": IND.get(sym),
        "vol": _f(vol), "drift": _f(drift), "r2": _f(r2), "up": up,
        "off52": _f(off52), "dd": _f(dd), "above_lo": _f(above_lo),
        "bt_avg": _f(bt_avg), "bt_win": _f(bt_win), "idio_z": _f(idio_z),
    }


def build_screener(lookback="3y", universe="ndx100"):
    """Download the universe + its ETFs and compute metrics. Returns a dict."""
    years = LOOKBACK_YEARS.get(lookback, 3)
    stocks = UNIVERSES.get(universe, UNIVERSES["ndx100"])
    etfs = sorted({IND[s] for s in stocks if s in IND})
    tickers = stocks + etfs

    end = pd.Timestamp.today()
    start = end - pd.DateOffset(years=years)
    raw = yf.download(tickers, start=start.strftime("%Y-%m-%d"),
                      end=end.strftime("%Y-%m-%d"),
                      auto_adjust=True, progress=False, threads=True)
    close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw

    out = []
    for sym in stocks:
        if sym not in close.columns:
            continue
        etf = IND.get(sym)
        etf_series = close[etf] if (etf and etf in close.columns) else None
        m = _metrics(sym, close[sym], etf_series)
        if m:
            out.append(m)

    _attach_fundamentals(out)

    return {
        "lookback": lookback,
        "universe": universe,
        "asof": datetime.now().isoformat(timespec="seconds"),
        "stocks": out,
    }


def _fundamentals(sym):
    """One stock's .info (current P/E, P/S, growth). {} on failure."""
    try:
        return yf.Ticker(sym).info or {}
    except Exception:
        return {}


def _attach_fundamentals(rows):
    """Add current P/E, P/S, revenue & earnings growth to each row (threaded
    .info; tolerant of failures). Cached hard by the route, so the cost is rare.
    P/E nulled when unprofitable (negative) — half the universe legitimately."""
    syms = [r["sym"] for r in rows]
    try:
        with ThreadPoolExecutor(max_workers=6) as ex:
            infos = dict(zip(syms, ex.map(_fundamentals, syms)))
    except Exception:
        infos = {}
    for r in rows:
        info = infos.get(r["sym"]) or {}
        r["name"] = info.get("shortName") or info.get("longName") or ""
        r["exchange"] = exchange_label(info.get("exchange"))
        eps = _f(info.get("trailingEps"))
        ni = _f(info.get("netIncomeToCommon"))
        r["profitable"] = bool((eps is not None and eps > 0) or (ni is not None and ni > 0))
        pe = _f(info.get("trailingPE"))
        ps = _f(info.get("priceToSalesTrailing12Months"))
        rg = _f(info.get("revenueGrowth"))
        eg = _f(info.get("earningsGrowth"))
        r["pe"]     = pe if (pe is not None and pe > 0) else None
        r["ps"]     = ps if (ps is not None and ps > 0) else None
        r["rev_g"]  = rg * 100 if rg is not None else None
        r["earn_g"] = eg * 100 if eg is not None else None

        # --- Invest-tab quality/value metrics (same .info, no extra requests) ---
        roe = _f(info.get("returnOnEquity"))
        gm  = _f(info.get("grossMargins"))
        om  = _f(info.get("operatingMargins"))
        fcf = _f(info.get("freeCashflow"))
        rev = _f(info.get("totalRevenue"))
        mcap = _f(info.get("marketCap"))
        debt = _f(info.get("totalDebt"))
        cash = _f(info.get("totalCash"))
        ebitda = _f(info.get("ebitda"))
        r["roe"]       = roe * 100 if roe is not None else None     # %
        r["gross_m"]   = gm * 100 if gm is not None else None       # %
        r["op_m"]      = om * 100 if om is not None else None       # %
        r["fcf_m"]     = (fcf / rev * 100) if (fcf is not None and rev) else None
        r["fcf_y"]     = (fcf / mcap * 100) if (fcf is not None and mcap) else None
        r["nd_ebitda"] = ((debt - cash) / ebitda) if (
            debt is not None and cash is not None and ebitda) else None
        r["curr"]      = _f(info.get("currentRatio"))
        r["mktcap"]    = mcap
        r["earn_y"]    = (100.0 / pe) if (pe is not None and pe > 0) else None  # 1/PE, %
