"""
Gateway to yfinance (prices) + a tiny file-backed store for valuation ratios.

- GET /api/history?range=<r>&symbols=ADBE,META,...&metric=price|pe|ps
    Prices come live from a batched yf.download. For pe/ps the price series
    is divided by trailing EPS / Sales-per-share: historical fundamentals are
    scraped from macrotrends (once a day, paced, cached to data/<sym>.json),
    and the current segment is anchored to yfinance's trailing values so the
    live reading matches Yahoo/Google.
- GET /api/stats?symbols=...   today's snapshot stat row.

A background thread refreshes the macrotrends data ~once a day at <=1 request
per minute, so page views never hit macrotrends.
"""

import bisect
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
import warnings
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, request, send_from_directory

warnings.filterwarnings("ignore")

app = Flask(__name__, static_folder="static", static_url_path="")

# range -> yfinance params. 1d/1w are intraday; the rest are daily bars.
RANGES = {
    "1d":  dict(period="5d",  interval="5m",  prepost=True),   # 5d covers weekends + prev close
    "1w":  dict(period="5d",  interval="30m", prepost=False),
    "1mo": dict(period="1mo", interval="1d",  prepost=False),
    "3mo": dict(period="3mo", interval="1d",  prepost=False),
    "6mo": dict(period="6mo", interval="1d",  prepost=False),
    "1y":  dict(period="1y",  interval="1d",  prepost=False),
    "5y":  dict(period="5y",  interval="1d",  prepost=False),
}

# seconds a cached response stays fresh
TTL = {"1d": 60, "1w": 300, "1mo": 3600, "3mo": 3600, "6mo": 3600, "1y": 3600, "5y": 3600}
STATS_TTL = 1800  # today's snapshot stats; refreshed at most every 30 min

REGULAR_OPEN = (9, 30)   # America/New_York
REGULAR_CLOSE = (16, 0)
NY = ZoneInfo("America/New_York")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_cache = {}        # (range, (sym, ...), metric) -> (fetched_at, payload)
_stats_cache = {}  # (sym, ...) -> (fetched_at, payload)
_info_cache = {}   # sym -> (fetched_at, info dict)
INFO_TTL = 1800


def _f(x):
    """JSON-safe float (NaN/inf -> None)."""
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def get_info(sym):
    """Cached yfinance .info (shared by stats + the ratio anchor)."""
    now = time.time()
    hit = _info_cache.get(sym)
    if hit and now - hit[0] < INFO_TTL:
        return hit[1]
    try:
        info = yf.Ticker(sym).info
    except Exception:
        info = {}
    _info_cache[sym] = (now, info)
    return info


EMPTY = {"t": [], "c": [], "session": None, "prevClose": None}


def _series_1d(close):
    """Build the 1D intraday series, all times ET:
      - market open  < 1h : pre-market from midnight (gray) + regular so far (colored)
      - market open >= 1h : regular session only (colored)
      - market closed      : last full regular session (colored) + every
                             after-hours print since that close, up to now (gray)
    """
    ny = close.tz_convert(NY)
    now = datetime.now(NY)
    open_t, close_t = dtime(*REGULAR_OPEN), dtime(*REGULAR_CLOSE)

    def is_reg(ts):
        return open_t <= ts.time() < close_t

    # anchor = most recent date that actually has a regular session in the data
    # (data-driven, so market holidays are skipped automatically)
    reg_dates = sorted({ts.date() for ts in ny.index if is_reg(ts)})
    if not reg_dates:
        return dict(EMPTY)
    anchor = reg_dates[-1]

    is_open = now.weekday() < 5 and open_t <= now.time() < close_t
    anchor_open = datetime.combine(anchor, open_t, tzinfo=NY)
    early = is_open and anchor == now.date() and (now - anchor_open).total_seconds() < 3600

    # how far left the window starts: midnight (incl. pre-market) only in the
    # first hour after the open; otherwise the regular open.
    window_start = (datetime.combine(anchor, dtime(0, 0), tzinfo=NY)
                    if early else anchor_open)

    sel = [(ts, v) for ts, v in ny.items() if window_start <= ts <= now]
    if not sel:
        return dict(EMPTY)

    # previous close = last regular bar strictly before the anchor day
    prev_close = None
    for ts, v in ny.items():
        if ts.date() < anchor and is_reg(ts):
            prev_close = _f(v)

    return {
        "t": [int(ts.timestamp()) for ts, _ in sel],
        "c": [_f(v) for _, v in sel],
        "session": [1 if (ts.date() == anchor and is_reg(ts)) else 0 for ts, _ in sel],
        "prevClose": prev_close,
    }


def _series_plain(close):
    """Daily / multi-day intraday: single line, no session split."""
    return {
        "t": [int(ts.timestamp()) for ts in close.index],
        "c": [_f(v) for v in close.values],
        "session": None,
        "prevClose": None,
    }


def build(rng, symbols):
    params = dict(RANGES[rng])
    df = yf.download(symbols, group_by="ticker", progress=False,
                     threads=True, **params)
    multi = isinstance(df.columns, pd.MultiIndex)

    series = {}
    for sym in symbols:
        try:
            sub = df[sym] if multi else df
            close = sub["Close"].dropna()
        except Exception:
            series[sym] = None
            continue
        if len(close) == 0:
            series[sym] = None
            continue
        series[sym] = _series_1d(close) if rng == "1d" else _series_plain(close)

    return {"range": rng, "series": series}


# ----------------------------------------------------------------------------
# Valuation ratios: macrotrends scrape -> data/<sym>.json -> serve-time divide
# ----------------------------------------------------------------------------

MT_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/120 Safari/537.36")
MT_METRICS = {"pe": "pe-ratio", "ps": "price-sales"}   # our key -> macrotrends path
MT_INTERVAL = 60      # seconds between scrape requests (<=1/min)
MT_COOLDOWN = 900     # don't retry a failed (sym,metric) for 15 min
# which yfinance .info field is the *current* trailing per-share denominator
ANCHOR_FIELD = {"pe": "trailingEps", "ps": "revenuePerShare"}

_last_attempt = {}    # (sym, metric) -> epoch of last scrape attempt


def _data_path(sym):
    return os.path.join(DATA_DIR, f"{sym.lower()}.json")


def load_fundamentals(sym):
    try:
        with open(_data_path(sym)) as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_metric(sym, metric, rows):
    """Merge one metric's rows into the symbol file (preserves the other)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    data = load_fundamentals(sym)
    data[metric] = {"scraped_at": datetime.now(NY).isoformat(), "rows": rows}
    tmp = _data_path(sym) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, _data_path(sym))   # atomic


def _mt_fetch(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": MT_UA})
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < tries - 1:
                time.sleep(5 * (i + 1))
                continue
            raise


def _mt_parse(html):
    """Rows of the historical table -> [[date, price, value, ratio], ...] asc.
    value = TTM EPS (pe page) or TTM Sales/share (ps page); both at column 2."""
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        c = [re.sub("<[^>]+>", "", x).replace("$", "").replace(",", "").strip()
             for x in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if len(c) == 4 and re.match(r"^\d{4}-\d{2}-\d{2}$", c[0]):
            rows.append([c[0], _f(c[1]), _f(c[2]), _f(c[3])])
    rows.sort(key=lambda r: r[0])
    return rows


def scrape_one(sym, metric):
    """Scrape a single (sym, metric) page and persist it. Raises on failure."""
    url = f"https://www.macrotrends.net/stocks/charts/{sym}/x/{MT_METRICS[metric]}"
    rows = _mt_parse(_mt_fetch(url))
    if not rows:
        raise RuntimeError("parsed 0 rows")
    _save_metric(sym, metric, rows)


# --- background scheduler: refresh stale (sym, metric) units, <=1 req/min -----

def _symbols_path():
    return os.path.join(DATA_DIR, "_symbols.json")


def known_symbols():
    try:
        with open(_symbols_path()) as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def remember_symbols(symbols):
    """Track which tickers the UI asks about, so the scraper knows its work."""
    current = set(known_symbols())
    if set(symbols) - current:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_symbols_path(), "w") as fh:
            json.dump(sorted(current | set(symbols)), fh)


def _next_unit():
    """The next stale (sym, metric) to scrape, respecting per-unit cooldown."""
    today = datetime.now(NY).date().isoformat()
    now = time.time()
    for sym in known_symbols():
        data = load_fundamentals(sym)
        for metric in MT_METRICS:
            m = data.get(metric)
            fresh = m and m.get("rows") and m.get("scraped_at", "")[:10] == today
            if fresh:
                continue
            if now - _last_attempt.get((sym, metric), 0) < MT_COOLDOWN:
                continue
            return sym, metric
    return None


def _scheduler_loop():
    while True:
        try:
            unit = _next_unit()
            if unit:
                sym, metric = unit
                _last_attempt[unit] = time.time()
                try:
                    scrape_one(sym, metric)
                except Exception as exc:   # keep last-good file; retry after cooldown
                    print(f"[macrotrends] {sym}/{metric} failed: {exc}", flush=True)
        except Exception as exc:
            print(f"[macrotrends] scheduler error: {exc}", flush=True)
        time.sleep(MT_INTERVAL)


def start_scraper():
    threading.Thread(target=_scheduler_loop, daemon=True).start()


# --- serve-time transform: price series -> ratio series ----------------------

def _stepper(rows):
    """Return (dates, values) for bisect step-lookup; value = column 2."""
    dates = [r[0] for r in rows]
    values = [r[2] for r in rows]
    return dates, values


def apply_metric(payload, metric, symbols):
    """Replace each price series with price / (trailing per-share denominator).
    History from macrotrends (stepped quarterly); current segment anchored to
    yfinance's trailing value so today's reading matches Yahoo/Google."""
    for sym in symbols:
        s = payload["series"].get(sym)
        if not s or not s.get("c"):
            continue

        rows = load_fundamentals(sym).get(metric, {}).get("rows") or []
        dates, values = _stepper(rows)
        last_fund_date = dates[-1] if dates else None
        anchor = _f(get_info(sym).get(ANCHOR_FIELD[metric]))

        def denom(epoch):
            d = datetime.fromtimestamp(epoch, NY).date().isoformat()
            # current segment (on/after the latest scraped quarter) -> yfinance
            if last_fund_date is None or d >= last_fund_date:
                return anchor if anchor is not None else (values[-1] if values else None)
            i = bisect.bisect_right(dates, d) - 1
            return values[i] if i >= 0 else None

        def ratio(price, epoch):
            v = denom(epoch)
            if price is None or v is None or v <= 0:   # negative EPS -> no P/E
                return None
            return price / v

        s["c"] = [ratio(p, t) for p, t in zip(s["c"], s["t"])]
        if s.get("prevClose") is not None and s["t"]:
            s["prevClose"] = ratio(s["prevClose"], s["t"][-1])
    return payload


@app.route("/api/history")
def history():
    rng = request.args.get("range", "1d")
    metric = request.args.get("metric", "price")
    symbols = [s.strip().upper() for s in request.args.get("symbols", "").split(",") if s.strip()]
    if rng not in RANGES or not symbols or metric not in ("price", "pe", "ps"):
        return jsonify(error="bad request: need valid range, symbols, metric"), 400

    remember_symbols(symbols)
    key = (rng, tuple(symbols), metric)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < TTL[rng]:
        return jsonify(hit[1])

    try:
        payload = build(rng, symbols)
        if metric in ("pe", "ps"):
            payload = apply_metric(payload, metric, symbols)
            payload["metric"] = metric
    except Exception as exc:
        return jsonify(error=f"fetch failed: {exc}"), 502

    _cache[key] = (now, payload)
    return jsonify(payload)


def build_stats(symbols):
    """Today's snapshot stats per symbol (the static row Google shows under
    its chart). One .info call per symbol; cached, so low volume."""
    out = {}
    for sym in symbols:
        try:
            info = get_info(sym)
            out[sym] = {
                "open":       _f(info.get("regularMarketOpen") or info.get("open")),
                "high":       _f(info.get("dayHigh")),
                "low":        _f(info.get("dayLow")),
                "marketCap":  _f(info.get("marketCap")),
                "pe":         _f(info.get("trailingPE")),
                "weekHigh52": _f(info.get("fiftyTwoWeekHigh")),
                "weekLow52":  _f(info.get("fiftyTwoWeekLow")),
                "divYield":   _f(info.get("dividendYield")),
                "qtrlyDiv":   _f(info.get("lastDividendValue")),
                "currency":   info.get("currency"),
            }
        except Exception:
            out[sym] = None
    return out


@app.route("/api/stats")
def stats():
    symbols = [s.strip().upper() for s in request.args.get("symbols", "").split(",") if s.strip()]
    if not symbols:
        return jsonify(error="bad request: need symbols"), 400

    remember_symbols(symbols)
    key = tuple(symbols)
    now = time.time()
    hit = _stats_cache.get(key)
    if hit and now - hit[0] < STATS_TTL:
        return jsonify(hit[1])

    try:
        payload = {"stats": build_stats(symbols)}
    except Exception as exc:
        return jsonify(error=f"yfinance stats failed: {exc}"), 502

    _stats_cache[key] = (now, payload)
    return jsonify(payload)


@app.after_request
def no_store(resp):
    # never let the browser serve cached market data
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    start_scraper()   # background macrotrends refresh (<=1 req/min)
    app.run(host="127.0.0.1", port=8050, debug=False)
