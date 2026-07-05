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
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, request, send_from_directory

from screener import build_screener, LOOKBACK_YEARS, UNIVERSES, segment_label
import opinion
import backtest

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
    "3y":  dict(years=3,      interval="1d",  prepost=False),   # yfinance has no "3y" period -> start/end
    "5y":  dict(period="5y",  interval="1d",  prepost=False),
}

# seconds a cached response stays fresh
TTL = {"1d": 60, "1w": 300, "1mo": 3600, "3mo": 3600, "6mo": 3600,
       "1y": 3600, "3y": 3600, "5y": 3600}
STATS_TTL = 1800  # today's snapshot stats; refreshed at most every 30 min
STATS_EMPTY_TTL = 60  # but retry an incomplete stats payload quickly

REGULAR_OPEN = (9, 30)   # America/New_York
REGULAR_CLOSE = (16, 0)
NY = ZoneInfo("America/New_York")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_cache = {}        # (range, (sym, ...), metric) -> (fetched_at, payload)
_stats_cache = {}  # (sym, ...) -> (fetched_at, payload)
_info_cache = {}   # sym -> (fetched_at, info dict)
INFO_TTL = 1800
INFO_EMPTY_TTL = 60   # a bad/empty .info is cached only briefly, so reloads retry

SCREENER_TTL = 6 * 3600   # daily data; recompute at most every 6h
EARN_TTL = 12 * 3600      # earnings are quarterly-stable; refresh at most every 12h


def _f(x):
    """JSON-safe float (NaN/inf -> None)."""
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _info_complete(info):
    # yfinance often returns the name/quote fields but not the assetProfile
    # (longBusinessSummary). Treat "named but no description" as incomplete so
    # we keep retrying to fill it in rather than pinning a 30-min partial cache.
    return bool(info.get("longName") and info.get("longBusinessSummary"))


def get_info(sym):
    """Cached yfinance .info (shared by stats + the ratio anchor).
    yfinance hands back partial dicts; we merge so a field we've already seen
    (e.g. the description) is never lost, and a still-incomplete cache expires
    fast so the next request retries to complete it."""
    now = time.time()
    hit = _info_cache.get(sym)
    if hit:
        ttl = INFO_TTL if _info_complete(hit[1]) else INFO_EMPTY_TTL
        if now - hit[0] < ttl:
            return hit[1]
    try:
        info = yf.Ticker(sym).info
    except Exception:
        info = {}
    # merge new non-empty fields over the last-good cache (don't lose a summary
    # to a later partial fetch); a wholly empty/unnamed fetch keeps the old one.
    if hit and hit[1]:
        merged = dict(hit[1])
        for k, v in (info or {}).items():
            if v not in (None, ""):
                merged[k] = v
        info = merged
    if not info or not info.get("longName"):
        if hit:
            _info_cache[sym] = (now, hit[1])
            return hit[1]
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
    years = params.pop("years", None)
    if years:   # no fixed yfinance period for this; use an explicit start/end window
        end = pd.Timestamp.today()
        start = end - pd.DateOffset(years=years)
        df = yf.download(symbols, group_by="ticker", progress=False, threads=True,
                         start=start.strftime("%Y-%m-%d"), end=end.strftime("%Y-%m-%d"),
                         **params)
    else:
        df = yf.download(symbols, group_by="ticker", progress=False, threads=True, **params)
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
# our key -> macrotrends path. Ratios use a 4-col page (value = TTM per-share at
# col 2); financials use a 2-col quarterly page (value at col 1, in $millions).
MT_RATIOS = {"pe": "pe-ratio", "ps": "price-sales"}
MT_FINANCIALS = {"revenue": "revenue", "netIncome": "net-income"}
MT_PATH = {**MT_RATIOS, **MT_FINANCIALS}
MT_INTERVAL = 20      # gentle background cadence — leave macrotrends headroom for
                      #   the synchronous on-demand fetches that serve open pages
MT_BG_QUIET = 15      # pause the background sweep this long after an on-demand scrape
MT_COOLDOWN = 900     # don't retry a failed (sym,metric) for 15 min (background)
MT_PRIORITY_COOLDOWN = 25  # but retry a viewed symbol's failures quickly
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


def _mt_fetch(url, tries=3, backoff=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": MT_UA})
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < tries - 1:
                time.sleep(backoff * (i + 1))
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


def _mt_parse_series(html):
    """Quarterly financial pages (revenue, net-income): a 2-col table whose
    date-rows are 'date | value' (value already in $millions). -> [[date, value]]
    ascending, deduped by date. Only quarter-end rows carry a YYYY-MM-DD date."""
    seen = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        c = [re.sub("<[^>]+>", "", x).replace("$", "").replace(",", "").strip()
             for x in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if len(c) >= 2 and re.match(r"^\d{4}-\d{2}-\d{2}$", c[0]):
            seen[c[0]] = _f(c[1])
    return sorted(([d, v] for d, v in seen.items()), key=lambda r: r[0])


def scrape_one(sym, metric, quick=False):
    """Scrape a single (sym, metric) page and persist it. Raises on failure.
    `quick` (on-demand path) fails fast instead of long 429 backoffs."""
    url = f"https://www.macrotrends.net/stocks/charts/{sym}/x/{MT_PATH[metric]}"
    html = _mt_fetch(url, tries=2, backoff=2) if quick else _mt_fetch(url)
    rows = _mt_parse(html) if metric in MT_RATIOS else _mt_parse_series(html)
    if not rows:
        raise RuntimeError("parsed 0 rows")
    _save_metric(sym, metric, rows)


# --- on-demand scraping: do it now, on the request thread ---------------------
# Opening a stock detail page is rare and user-initiated, so we'd rather scrape
# any missing metric synchronously (a second or two) and return complete data
# than queue it for the background sweep and make the page wait/poll. Only
# metrics with NO data yet are fetched here; present-but-stale data is served
# immediately and refreshed by the background scheduler.
_scrape_locks = {}
_scrape_locks_guard = threading.Lock()
_last_ondemand = 0.0           # epoch of the last on-demand scrape (background yields to it)


def _unit_lock(key):
    with _scrape_locks_guard:
        lk = _scrape_locks.get(key)
        if lk is None:
            lk = _scrape_locks[key] = threading.Lock()
        return lk


def _has_rows(sym, metric):
    return bool((load_fundamentals(sym).get(metric) or {}).get("rows"))


def ensure_scraped(sym, metrics):
    """Synchronously scrape any of `metrics` that have no data yet. Best-effort:
    a failure just leaves that metric empty (the page renders the rest)."""
    global _last_ondemand
    for metric in metrics:
        if _has_rows(sym, metric):
            continue
        _last_ondemand = time.time()     # tell the background sweep to back off
        with _unit_lock((sym, metric)):
            if _has_rows(sym, metric):   # another request just filled it
                continue
            try:
                scrape_one(sym, metric, quick=True)
            except Exception as exc:
                print(f"[macrotrends] on-demand {sym}/{metric} failed: {exc}", flush=True)
            finally:
                _last_attempt[(sym, metric)] = time.time()
                _last_ondemand = time.time()


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


# When the UI opens a stock, push it to the front of the scrape queue so the
# symbol you're looking at fills in within seconds instead of waiting behind the
# whole alphabetical background sweep.
_priority = []                       # symbols to scrape ASAP, most-recent first
_priority_lock = threading.Lock()


def prioritize(sym):
    with _priority_lock:
        if sym in _priority:
            _priority.remove(sym)
        _priority.insert(0, sym)
        del _priority[8:]            # cap the bump list


def _unit_stale(sym, data, now, today, cooldown):
    """First stale (sym, metric) for one symbol's loaded data, or None.
    `cooldown` is how long to wait before retrying a failed unit."""
    for metric in MT_PATH:
        m = data.get(metric)
        fresh = m and m.get("rows") and m.get("scraped_at", "")[:10] == today
        if fresh:
            continue
        if now - _last_attempt.get((sym, metric), 0) < cooldown:
            continue
        return sym, metric
    return None


def _next_unit():
    """The next stale (sym, metric) to scrape. Prioritized (recently-viewed)
    symbols come before the background sweep AND retry on a short cooldown, so
    a transient macrotrends failure on the page you're looking at doesn't park
    it for the full 15-minute background cooldown."""
    today = datetime.now(NY).date().isoformat()
    now = time.time()
    with _priority_lock:
        pri = list(_priority)
    for sym in pri:                     # actively-viewed: jump queue, retry fast
        unit = _unit_stale(sym, load_fundamentals(sym), now, today, MT_PRIORITY_COOLDOWN)
        if unit:
            return unit
    for sym in known_symbols():         # background sweep: gentle retry cadence
        unit = _unit_stale(sym, load_fundamentals(sym), now, today, MT_COOLDOWN)
        if unit:
            return unit
    return None


def _scheduler_loop():
    while True:
        try:
            # yield to user-triggered on-demand fetches so we don't compete for
            # macrotrends' rate budget and trigger 429s on the page being viewed
            if time.time() - _last_ondemand < MT_BG_QUIET:
                time.sleep(MT_BG_QUIET)
                continue
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
    if metric in ("pe", "ps") and len(symbols) == 1:
        prioritize(symbols[0])                    # bump in the background queue too
        ensure_scraped(symbols[0], [metric])      # fetch now if missing; no waiting
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
            # a ratio computed before the macrotrends scrape is anchor-only
            # (flat denominator); don't pin that in the 1h cache — recompute on
            # the next request so it self-heals once the scraper fills it in.
            incomplete = any(not (load_fundamentals(s).get(metric, {}).get("rows"))
                             for s in symbols)
            if incomplete:
                return jsonify(payload)
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


def _stats_complete(payload):
    """All symbols have at least a price/market-cap reading. An incomplete
    payload (e.g. .info came back empty for a symbol) is cached only briefly so
    a refresh retries instead of pinning the blank row for the full 30 min."""
    stats = (payload or {}).get("stats") or {}
    return bool(stats) and all(
        s and (s.get("open") is not None or s.get("marketCap") is not None)
        for s in stats.values())


@app.route("/api/stats")
def stats():
    symbols = [s.strip().upper() for s in request.args.get("symbols", "").split(",") if s.strip()]
    if not symbols:
        return jsonify(error="bad request: need symbols"), 400

    remember_symbols(symbols)
    key = tuple(symbols)
    now = time.time()
    hit = _stats_cache.get(key)
    if hit:
        ttl = STATS_TTL if _stats_complete(hit[1]) else STATS_EMPTY_TTL
        if now - hit[0] < ttl:
            return jsonify(hit[1])

    try:
        payload = {"stats": build_stats(symbols)}
    except Exception as exc:
        return jsonify(error=f"yfinance stats failed: {exc}"), 502

    _stats_cache[key] = (now, payload)
    return jsonify(payload)


# ----------------------------------------------------------------------------
# Per-stock profile + earnings (for the detail-view header)
# ----------------------------------------------------------------------------

def _save_earnings(sym, payload):
    """Persist earnings under the symbol's data file (keep-last-good source)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    data = load_fundamentals(sym)
    data["earnings"] = {"fetched_at": time.time(), **payload}
    tmp = _data_path(sym) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, _data_path(sym))   # atomic


def fetch_earnings(sym):
    """yfinance earnings dates -> {past:[...most recent first, 4], next:{date,estimated}}."""
    df = yf.Ticker(sym).get_earnings_dates(limit=16)
    past, nxt = [], None
    if df is not None and len(df):
        df = df.sort_index()   # ascending by date
        tz = df.index.tz
        now = pd.Timestamp.now(tz=tz) if tz is not None else pd.Timestamp.now()
        for idx, row in df.iterrows():
            est = _f(row.get("EPS Estimate"))
            rep = _f(row.get("Reported EPS"))
            date = idx.date().isoformat()
            if rep is not None:                         # reported -> a past quarter
                beat = (rep > est) if est is not None else None
                sur = ((rep - est) / abs(est) * 100) if est not in (None, 0) else None
                past.append({"date": date, "epsEst": est, "epsActual": rep,
                             "surprisePct": _f(sur), "beat": beat})
            elif idx >= now and nxt is None:            # earliest future -> next report
                nxt = {"date": date, "estimated": False, "epsEst": est}
        past = list(reversed(past))                     # most recent first (full window; header slices 4)
    if nxt is None:                                     # fall back to .info's single ts
        ts = get_info(sym).get("earningsTimestamp")
        if ts:
            nxt = {"date": datetime.fromtimestamp(ts, NY).date().isoformat(), "estimated": True}
    return {"past": past, "next": nxt}


def get_earnings(sym):
    """Cached earnings: serve the file if fresh; else refetch; keep-last-good on failure."""
    cached = load_fundamentals(sym).get("earnings")
    if cached and time.time() - cached.get("fetched_at", 0) < EARN_TTL:
        return {"past": cached.get("past", []), "next": cached.get("next")}
    try:
        e = fetch_earnings(sym)
        _save_earnings(sym, e)
        return e
    except Exception as exc:
        print(f"[earnings] {sym} failed: {exc}", flush=True)
        if cached:
            return {"past": cached.get("past", []), "next": cached.get("next")}
        return {"past": [], "next": None}


def _save_profile(sym, prof):
    os.makedirs(DATA_DIR, exist_ok=True)
    data = load_fundamentals(sym)
    data["profile"] = prof
    tmp = _data_path(sym) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, _data_path(sym))   # atomic


def build_profile(sym):
    info = get_info(sym)
    prof = {
        "name":        info.get("longName") or info.get("shortName") or sym,
        "exchange":    info.get("fullExchangeName") or info.get("exchange"),
        "currency":    info.get("currency"),
        "sector":      info.get("sector"),
        "industry":    info.get("industry"),
        "segment":     segment_label(sym),
        "description": info.get("longBusinessSummary"),
    }
    # persist + keep-last-good: only overwrite the saved copy with a complete one,
    # and fall back to the saved copy when a fresh fetch comes back incomplete.
    saved = load_fundamentals(sym).get("profile")
    if prof.get("name") and prof.get("description"):
        if prof != saved:
            _save_profile(sym, prof)
        return prof
    return saved or prof


@app.route("/api/profile")
def profile():
    sym = request.args.get("symbol", "").strip().upper()
    if not sym:
        return jsonify(error="bad request: need symbol"), 400
    remember_symbols([sym])
    prioritize(sym)
    try:
        payload = {"symbol": sym, "profile": build_profile(sym), "earnings": get_earnings(sym)}
    except Exception as exc:
        return jsonify(error=f"profile failed: {exc}"), 502
    return jsonify(payload)


# ----------------------------------------------------------------------------
# Quarterly financials: sales (revenue) + earnings (net income), with TTM
# ----------------------------------------------------------------------------

FIN_KEYS = ("revenue", "netIncome")
FIN_QUARTERS = 24       # how many recent quarters to display


def _quarter_epoch(date_str):
    """Quarter-end 'YYYY-MM-DD' -> epoch at 16:00 ET (consistent with price ts)."""
    dt = datetime.fromisoformat(date_str + "T16:00:00").replace(tzinfo=NY)
    return int(dt.timestamp())


def build_financials(sym, n=FIN_QUARTERS):
    """Per-metric quarterly values + a trailing-4-quarter (TTM) rolling sum.
    Returns aligned arrays (t, q, ttm); ttm is null until 4 quarters accrue.
    Keeps 3 extra leading quarters off-screen so TTM is defined at the window
    start. Values are in $millions; net income may be negative (loss quarters)."""
    data = load_fundamentals(sym)
    series = {}
    for key in FIN_KEYS:
        rows = [r for r in (data.get(key, {}).get("rows") or []) if r[1] is not None]
        rows = rows[-(n + 3):]
        vals = [r[1] for r in rows]
        ttm = [None] * len(rows)
        for i in range(3, len(rows)):
            ttm[i] = sum(vals[i - 3:i + 1])
        rows, vals, ttm = rows[-n:], vals[-n:], ttm[-n:]   # drop the leading padding
        series[key] = {"t": [_quarter_epoch(r[0]) for r in rows], "q": vals, "ttm": ttm}
    return {"symbol": sym, "currency": get_info(sym).get("currency") or "USD",
            "unit": "millions", "series": series}


@app.route("/api/financials")
def financials():
    sym = request.args.get("symbol", "").strip().upper()
    if not sym:
        return jsonify(error="bad request: need symbol"), 400
    remember_symbols([sym])
    prioritize(sym)
    ensure_scraped(sym, MT_FINANCIALS)   # fetch now if missing; don't make the page wait on the queue
    try:
        payload = build_financials(sym)
    except Exception as exc:
        return jsonify(error=f"financials failed: {exc}"), 502
    return jsonify(payload)


# ----------------------------------------------------------------------------
# Disk-backed, single-flight, stale-while-revalidate cache for the expensive
# whole-universe builds (screener, calendar). Two problems it solves:
#   * a restart/deploy wipes the in-memory cache, forcing a ~38s cold rebuild
#     of the ~354-ticker yfinance download — now we warm from disk instead;
#   * a warm-but-stale entry (past TTL) used to block one request on the full
#     rebuild — now the stale value is served instantly and refreshed in the
#     background. Only the very first build ever (no memory, no disk) blocks.
# ----------------------------------------------------------------------------
_swr_mem = {}            # name -> (built_at, payload)
_swr_locks = {}          # name -> Lock (single-flight per name)
_swr_guard = threading.Lock()


def _swr_lock(name):
    with _swr_guard:
        lk = _swr_locks.get(name)
        if lk is None:
            lk = _swr_locks[name] = threading.Lock()
        return lk


def _swr_path(name):
    return os.path.join(DATA_DIR, f"_cache_{name}.json")


def _swr_load_disk(name):
    try:
        with open(_swr_path(name)) as fh:
            d = json.load(fh)
        return d["built_at"], d["payload"]
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def _swr_save_disk(name, built_at, payload):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = _swr_path(name) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"built_at": built_at, "payload": payload}, fh)
    os.replace(tmp, _swr_path(name))           # atomic


def _swr_build(name, builder, ttl):
    """Run builder() under the single-flight lock; cache + persist the result.
    Re-checks freshness after acquiring so we don't rebuild what another thread
    just built while we waited for the lock."""
    with _swr_lock(name):
        hit = _swr_mem.get(name)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        payload = builder()
        built = time.time()
        _swr_mem[name] = (built, payload)
        _swr_save_disk(name, built, payload)
        return payload


def _swr_refresh_async(name, builder, ttl):
    if _swr_lock(name).locked():
        return                                  # a build is already in flight
    def work():
        try:
            _swr_build(name, builder, ttl)
        except Exception as exc:
            print(f"[swr] background refresh {name} failed: {exc}", flush=True)
    threading.Thread(target=work, daemon=True).start()


def swr_cached(name, builder, ttl):
    """Fresh -> return it. Stale -> return stale now, refresh in background.
    Cold process -> warm from disk first. Nothing anywhere -> build (blocks)."""
    now = time.time()
    hit = _swr_mem.get(name)
    if hit is None:
        disk = _swr_load_disk(name)
        if disk:
            _swr_mem[name] = hit = disk
    if hit:
        if now - hit[0] >= ttl:
            _swr_refresh_async(name, builder, ttl)
        return hit[1]
    return _swr_build(name, builder, ttl)


def cached_screener(universe="ndx100", lookback="3y"):
    """Screener payload — disk-backed, single-flight, stale-while-revalidate."""
    return swr_cached(f"screener_{universe}_{lookback}",
                      lambda: build_screener(lookback, universe), SCREENER_TTL)


@app.route("/api/screener")
def screener():
    universe = request.args.get("universe", "ndx100")
    lookback = request.args.get("lookback", "3y")
    if lookback not in LOOKBACK_YEARS or universe not in UNIVERSES:
        return jsonify(error="bad request: need valid universe, lookback"), 400
    try:
        return jsonify(cached_screener(universe, lookback))
    except Exception as exc:
        return jsonify(error=f"screener failed: {exc}"), 502


CALENDAR_TTL = 1800


def _reaction(ser, rd):
    """Last-report price reaction from a (t, c) series: close on the report day,
    next-day close (%), and now (%)."""
    if not ser or not ser.get("c") or not rd:
        return None
    pairs = [(t, c) for t, c in zip(ser["t"], ser["c"]) if c is not None]
    if len(pairs) < 2:
        return None
    ts = [p[0] for p in pairs]
    cs = [p[1] for p in pairs]
    try:
        target = datetime.strptime(rd, "%Y-%m-%d").timestamp()
    except (TypeError, ValueError):
        return None
    idx = min(range(len(ts)), key=lambda i: abs(ts[i] - target))
    pre = cs[idx]
    nxt = cs[idx + 1] if idx + 1 < len(cs) else None
    now = cs[-1]
    return {"date": rd, "pre": pre, "next": nxt,
            "nextPct": ((nxt / pre - 1) * 100) if (nxt and pre) else None,
            "now": now, "nowPct": ((now / pre - 1) * 100) if pre else None}


def _build_calendar():
    """Recent + upcoming earnings across the universe, each joined with its
    screener filter attributes (so the page reuses the same group filters +
    search) and its last-report price reaction. Window of +/-3M (the widest UI
    option); the frontend narrows by window/mode."""
    rows = {r["sym"]: r for r in cached_screener()["stocks"]}
    syms = list(rows.keys())
    today = datetime.now(NY).date()
    horizon = 95

    with ThreadPoolExecutor(max_workers=6) as ex:
        earns = dict(zip(syms, ex.map(get_earnings, syms)))
    try:
        prices = build("1y", syms)["series"]   # one batched download for reactions
    except Exception:
        prices = {}

    def days_out(ds):
        try:
            return (datetime.strptime(ds, "%Y-%m-%d").date() - today).days
        except (TypeError, ValueError):
            return None

    out = []
    for sym in syms:
        r = rows[sym]
        e = earns.get(sym) or {}
        past_all = e.get("past") or []
        hist = [p.get("beat") for p in past_all[:4]]   # last 4 reports, most-recent first
        reaction = _reaction(prices.get(sym), past_all[0].get("date")) if past_all else None
        attrs = {"sym": sym, "name": r.get("name", ""), "exchange": r.get("exchange", ""),
                 "ind": r.get("ind"), "profitable": bool(r.get("profitable")), "hist": hist,
                 "pe": r.get("pe"), "ps": r.get("ps"), "idio_z": r.get("idio_z"),
                 "mktcap": r.get("mktcap"), "off52": r.get("off52"), "spark": r.get("spark"),
                 "reaction": reaction}
        for p in (e.get("past") or []):
            d = days_out(p.get("date"))
            if d is None or d > 0 or d < -horizon:
                continue
            out.append({**attrs, "date": p["date"], "days": d, "past": True,
                        "beat": p.get("beat"), "surprisePct": p.get("surprisePct"),
                        "epsEst": p.get("epsEst"), "epsActual": p.get("epsActual")})
        nx = e.get("next")
        if nx and nx.get("date"):
            d = days_out(nx["date"])
            if d is not None and 0 <= d <= horizon:
                out.append({**attrs, "date": nx["date"], "days": d, "past": False,
                            "estimated": bool(nx.get("estimated")), "epsEst": nx.get("epsEst")})
    out.sort(key=lambda x: (x["date"], x["sym"]))
    return {"asof": today.isoformat(), "entries": out}


@app.route("/api/calendar")
def api_calendar():
    """Earnings calendar — disk-backed, single-flight, stale-while-revalidate
    (so a restart or TTL expiry never blocks on the whole-universe rebuild)."""
    try:
        return jsonify(swr_cached("calendar", _build_calendar, CALENDAR_TTL))
    except Exception as exc:
        return jsonify(error=f"calendar failed: {exc}"), 502


# ----------------------------------------------------------------------------
# AI valuation opinions
# ----------------------------------------------------------------------------

def gather_stock_data(sym):
    """Assemble the stock's important data for the LLM agents."""
    info = get_info(sym)
    return {
        "symbol": sym,
        "name": info.get("longName"),
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "currency": info.get("currency"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "segment": segment_label(sym),
        "description": info.get("longBusinessSummary"),
        "currentPrice": _f(info.get("currentPrice") or info.get("regularMarketPrice")),
        "marketCap": _f(info.get("marketCap")),
        "trailingPE": _f(info.get("trailingPE")),
        "forwardPE": _f(info.get("forwardPE")),
        "priceToSales": _f(info.get("priceToSalesTrailing12Months")),
        "priceToBook": _f(info.get("priceToBook")),
        "profitMargins": _f(info.get("profitMargins")),
        "grossMargins": _f(info.get("grossMargins")),
        "operatingMargins": _f(info.get("operatingMargins")),
        "revenueGrowth": _f(info.get("revenueGrowth")),
        "earningsGrowth": _f(info.get("earningsGrowth")),
        "returnOnEquity": _f(info.get("returnOnEquity")),
        "totalCash": _f(info.get("totalCash")),
        "totalDebt": _f(info.get("totalDebt")),
        "freeCashflow": _f(info.get("freeCashflow")),
        "trailingEps": _f(info.get("trailingEps")),
        "bookValue": _f(info.get("bookValue")),
        "fiftyTwoWeekHigh": _f(info.get("fiftyTwoWeekHigh")),
        "fiftyTwoWeekLow": _f(info.get("fiftyTwoWeekLow")),
        "stats": build_stats([sym]).get(sym),
        "earnings": get_earnings(sym),
        "financials": build_financials(sym),
    }


@app.route("/api/opinion/start")
def opinion_start():
    sym = request.args.get("symbol", "").strip().upper()
    if not sym:
        return jsonify(error="bad request: need symbol"), 400
    profile = request.args.get("profile")   # optional override; else opinion.ACTIVE_PROFILE
    try:
        data = gather_stock_data(sym)
        job = opinion.start_job(sym, data, profile)
    except Exception as exc:
        return jsonify(error=f"opinion start failed: {exc}"), 502
    return jsonify(job)


@app.route("/api/opinion/status")
def opinion_status():
    st = opinion.status(request.args.get("job", ""))
    if st is None:
        return jsonify(error="unknown job"), 404
    return jsonify(st)


@app.route("/api/opinion/list")
def opinion_list():
    sym = request.args.get("symbol", "").strip().upper()
    if not sym:
        return jsonify(error="bad request: need symbol"), 400
    return jsonify(opinions=opinion.list_opinions(sym))


@app.route("/api/opinion/get")
def opinion_get():
    sym = request.args.get("symbol", "").strip().upper()
    oid = request.args.get("id", "")
    o = opinion.get_opinion(sym, oid)
    if o is None:
        return jsonify(error="not found"), 404
    return jsonify(o)


@app.route("/api/opinion/delete", methods=["POST"])
def opinion_delete():
    sym = request.args.get("symbol", "").strip().upper()
    oid = request.args.get("id", "")
    if not sym or not oid:
        return jsonify(error="bad request: need symbol and id"), 400
    deleted = opinion.delete_opinion(sym, oid)
    return jsonify(deleted=deleted)


# ----------------------------------------------------------------------------
# Reference overlays: "same $ into X" comparison lines for the Stocks grid
# ----------------------------------------------------------------------------

REFERENCES = {
    "spy":   {"label": "S&P 500 (SPY)",             "tickers": ["SPY"]},
    "qqq":   {"label": "Nasdaq 100 (QQQ)",          "tickers": ["QQQ"]},
    "gld":   {"label": "Gold (GLD)",                "tickers": ["GLD"]},
    "btc":   {"label": "Bitcoin (BTC-USD)",         "tickers": ["BTC-USD"]},
    "googl": {"label": "Google (GOOGL)",            "tickers": ["GOOGL"]},
    "nvda":  {"label": "Nvidia (NVDA)",             "tickers": ["NVDA"]},
    "brkb":  {"label": "Berkshire (BRK-B)",         "tickers": ["BRK-B"]},
    "mag7":  {"label": "Magnificent 7 (equal-wt)",
              "tickers": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]},
    "vti":   {"label": "Vanguard Total US (VTI)",   "tickers": ["VTI"]},
    "vt":    {"label": "Vanguard Total World (VT)",  "tickers": ["VT"]},
}

_ref_cache = {}    # (range, key) -> (fetched_at, payload)
REF_TTL = 3600


def _reference_series(rng, tickers):
    """Equal-weight, start-normalized relative series (rel[0]=1) for one or more
    tickers, aligned by date with per-ticker forward-fill. Single ticker -> just
    its close/close[0]; basket -> mean of each member's normalized path."""
    s = build(rng, tickers)["series"]
    maps, all_dates = {}, set()
    for tk in tickers:
        ser = s.get(tk)
        if not ser:
            continue
        m = {t: c for t, c in zip(ser["t"], ser["c"]) if c is not None}
        if m:
            maps[tk] = m
            all_dates |= set(m.keys())
    if not maps:
        return [], []
    last = {tk: None for tk in maps}
    first = {tk: None for tk in maps}
    out_t, rel = [], []
    for d in sorted(all_dates):
        vals = []
        for tk, m in maps.items():
            if d in m:
                last[tk] = m[d]
            if last[tk] is None:
                continue
            if first[tk] is None:
                first[tk] = last[tk]
            vals.append(last[tk] / first[tk])
        if vals:
            out_t.append(d)
            rel.append(sum(vals) / len(vals))
    return out_t, rel


@app.route("/api/earnings_detail")
def api_earnings_detail():
    """On-demand per-stock detail for an expanded Earnings row: price sparkline
    since the last report, prev-report reaction (pre / next-day / now), 3y
    above/below current price, and a 3y backtest capped at the current price."""
    sym = request.args.get("symbol", "").strip().upper()
    if not sym:
        return jsonify(error="need symbol"), 400
    t, c = _bt_series(sym, "3y")
    if len(c) < 30:
        return jsonify(error="not enough history"), 502
    n = len(c)
    now = c[-1]
    above = sum(1 for v in c if v > now)
    below = sum(1 for v in c if v < now)
    bt = backtest.run_single(t, c, 0.4, 126, max_price=now).get("metrics") or {}

    prev, spark = None, None
    past = get_earnings(sym).get("past") or []
    if past:
        rd = past[0].get("date")
        try:
            target = datetime.strptime(rd, "%Y-%m-%d").timestamp()
            idx = min(range(n), key=lambda i: abs(t[i] - target))
        except (TypeError, ValueError):
            idx = None
        if idx is not None:
            pre = c[idx]
            nxt = c[idx + 1] if idx + 1 < n else None
            prev = {"date": rd, "pre": pre, "next": nxt,
                    "nextPct": ((nxt / pre - 1) * 100) if (nxt and pre) else None,
                    "now": now, "nowPct": ((now / pre - 1) * 100) if pre else None}
            spark = {"t": t[idx:], "c": c[idx:]}

    pe = ps = idio = None
    try:
        row = {r["sym"]: r for r in cached_screener()["stocks"]}.get(sym)
        if row:
            pe, ps, idio = row.get("pe"), row.get("ps"), row.get("idio_z")
    except Exception:
        pass

    return jsonify(symbol=sym, currentPrice=now,
                   abovePct=above / n * 100, belowPct=below / n * 100,
                   backtest={"win": bt.get("win"), "avg": bt.get("mean_ret"),
                             "tradeRatio": bt.get("trade_ratio")},
                   prev=prev, spark=spark, pe=pe, ps=ps, idio_z=idio)


@app.route("/api/universe")
def api_universe():
    u = request.args.get("universe", "ndx100")
    return jsonify(symbols=UNIVERSES.get(u, UNIVERSES["ndx100"]))


# ----------------------------------------------------------------------------
# Per-stock "buy below" threshold prices (user-set, persisted to disk)
# ----------------------------------------------------------------------------
_thresholds = None
_thresh_lock = threading.Lock()


def _thresh_path():
    return os.path.join(DATA_DIR, "thresholds.json")


def load_thresholds():
    global _thresholds
    if _thresholds is None:
        try:
            with open(_thresh_path()) as fh:
                _thresholds = json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            _thresholds = {}
    return _thresholds


def set_threshold(sym, price):
    """Set (price > 0) or clear (price <= 0) a symbol's buy-below threshold."""
    with _thresh_lock:
        t = load_thresholds()
        if price and price > 0:
            t[sym] = price
        else:
            t.pop(sym, None)
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = _thresh_path() + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(t, fh)
        os.replace(tmp, _thresh_path())   # atomic
    return t


@app.route("/api/thresholds")
def api_thresholds():
    return jsonify(load_thresholds())


@app.route("/api/threshold", methods=["POST"])
def api_set_threshold():
    sym = request.args.get("symbol", "").strip().upper()
    if not sym:
        return jsonify(error="bad request: need symbol"), 400
    try:
        price = float(request.args.get("price", "0") or 0)
    except ValueError:
        price = 0
    set_threshold(sym, price)
    return jsonify(ok=True, symbol=sym, price=(price if price > 0 else None))


# Market open/closed from Yahoo (authoritative: handles holidays + half-days).
# NYSE and NASDAQ share the same US session, so one status covers both.
_market_cache = {}      # "us" -> (fetched_at, payload)
MARKET_TTL = 60


def _market_status():
    """{open, status, message} from yfinance's Market; cached 60s.
    Falls back to a weekday/time estimate only if the live fetch fails."""
    now = time.time()
    hit = _market_cache.get("us")
    if hit and now - hit[0] < MARKET_TTL:
        return hit[1]
    payload = None
    try:
        s = yf.Market("US").status
        status = str(s.get("status", "")).lower()
        payload = {
            "open": status == "open",
            "status": status,
            "message": s.get("message"),
            "source": "yahoo",
        }
    except Exception as exc:
        # degrade gracefully: estimate from ET wall-clock (no holiday awareness)
        nowny = datetime.now(NY)
        mins = nowny.hour * 60 + nowny.minute
        est_open = nowny.weekday() < 5 and 9 * 60 + 30 <= mins < 16 * 60
        payload = {
            "open": est_open,
            "status": "open" if est_open else "closed",
            "message": None,
            "source": "estimate",
            "error": str(exc),
        }
    _market_cache["us"] = (now, payload)
    return payload


@app.route("/api/market")
def api_market():
    return jsonify(_market_status())


@app.route("/api/reference")
def api_reference():
    rng = request.args.get("range", "")
    key = request.args.get("ref", "")
    if rng not in RANGES or rng == "1d":
        return jsonify(error="bad range (1d unsupported)"), 400
    if key not in REFERENCES:
        return jsonify(error="unknown reference"), 400
    now = time.time()
    hit = _ref_cache.get((rng, key))
    if hit and now - hit[0] < REF_TTL:
        return jsonify(hit[1])
    t, rel = _reference_series(rng, REFERENCES[key]["tickers"])
    payload = {"ref": key, "label": REFERENCES[key]["label"], "range": rng, "t": t, "rel": rel}
    _ref_cache[(rng, key)] = (now, payload)
    return jsonify(payload)


# ----------------------------------------------------------------------------
# Backtest tab: per-stock strategy sweep + drill-down
# ----------------------------------------------------------------------------

BT_RANGES = ("1y", "3y", "5y")
_bt_series_cache = {}   # (sym, rng) -> (fetched_at, (t_list, c_list))
_bt_sweep_cache = {}    # (sym, rng, max_price) -> (fetched_at, payload)
BT_SERIES_TTL = 3600


def _bt_series(sym, rng):
    """Daily (t, close) arrays for one symbol over a backtest range, cached."""
    now = time.time()
    key = (sym, rng)
    hit = _bt_series_cache.get(key)
    if hit and now - hit[0] < BT_SERIES_TTL:
        return hit[1]
    s = build(rng, [sym])["series"].get(sym)
    t, c = [], []
    if s:
        for ts, cv in zip(s["t"], s["c"]):
            if cv is not None:
                t.append(ts); c.append(cv)
    _bt_series_cache[key] = (now, (t, c))
    return t, c


@app.route("/api/backtest")
def api_backtest():
    sym = request.args.get("symbol", "").strip().upper()
    rng = request.args.get("range", "3y")
    if not sym or rng not in BT_RANGES:
        return jsonify(error="bad request: need symbol and range in 1y/3y/5y"), 400
    try:
        delta = float(request.args.get("delta", "0.4"))
        hold = int(request.args.get("hold", "126"))
    except ValueError:
        return jsonify(error="bad delta/hold"), 400
    max_price = _f(request.args.get("max_price"))   # None if absent/blank
    t, c = _bt_series(sym, rng)
    if len(c) < 60:
        return jsonify(error="not enough price history"), 502
    res = backtest.run_single(t, c, delta, hold, max_price)
    res.update(symbol=sym, range=rng, last_price=c[-1])
    return jsonify(res)


@app.route("/api/backtest/sweep")
def api_backtest_sweep():
    sym = request.args.get("symbol", "").strip().upper()
    rng = request.args.get("range", "3y")
    if not sym or rng not in BT_RANGES:
        return jsonify(error="bad request: need symbol and range in 1y/3y/5y"), 400
    max_price = _f(request.args.get("max_price"))
    now = time.time()
    key = (sym, rng, max_price)
    hit = _bt_sweep_cache.get(key)
    if hit and now - hit[0] < BT_SERIES_TTL:
        return jsonify(hit[1])
    t, c = _bt_series(sym, rng)
    if len(c) < 60:
        return jsonify(error="not enough price history"), 502
    payload = {"symbol": sym, "range": rng, "max_price": max_price,
               "last_price": c[-1], "sweep": backtest.run_sweep(c, max_price),
               "df": backtest.dickey_fuller(c)}
    _bt_sweep_cache[key] = (now, payload)
    return jsonify(payload)


RESTART_CODE = 42   # run.sh restarts the server when it exits with this code


def _restart_exit(*_):
    """Flush and exit with the sentinel code so the run.sh supervisor relaunches
    us — same screen window, same command. A full process exit (rather than an
    in-place execv) guarantees the listening socket is released, which execv does
    not, since werkzeug keeps the socket inheritable. Triggered by SIGHUP
    (kill -HUP / ./restart.sh) or POST /api/restart."""
    try:
        sys.stdout.flush(); sys.stderr.flush()
    except Exception:
        pass
    os._exit(RESTART_CODE)


@app.route("/api/restart", methods=["POST"])
def api_restart():
    # local-only: this bounces the whole server, so don't expose it remotely
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify(error="forbidden"), 403
    # delay so this response flushes before the process exits
    threading.Timer(0.3, _restart_exit).start()
    return jsonify(restarting=True, pid=os.getpid())


@app.after_request
def no_store(resp):
    # never let the browser serve cached market data; also skip caching the app's
    # own assets so code edits show up on a normal reload (no hard-refresh needed)
    p = request.path
    if p.startswith("/api/") or p == "/" or p.endswith((".js", ".css", ".html")):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    # SIGHUP -> exit with RESTART_CODE so run.sh relaunches: `kill -HUP <pid>`,
    # `./restart.sh`, or POST /api/restart. (Run via ./run.sh for the restart to
    # take effect; under a plain `python app.py` SIGHUP just stops the server.)
    signal.signal(signal.SIGHUP, _restart_exit)
    try:
        with open(os.path.join(os.path.dirname(__file__), "server.pid"), "w") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass
    start_scraper()   # background macrotrends refresh (<=1 req/min)
    # threaded: a slow /api/screener build must not block the dashboard endpoints
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8050")),
            debug=False, threaded=True)
