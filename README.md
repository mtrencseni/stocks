# Stocks

A personal stock dashboard: a grid of Google-Finance-style price charts for
the tickers you care about. Flask is a dumb gateway to `yfinance`; all the UI
lives client-side (vanilla JS + [uPlot](https://github.com/leeoniya/uPlot)).

## Features

- Responsive grid of charts (default 9 stocks, 3×3), one per ticker.
- Ranges: **1D / 1W / 1M / 3M / 6M / 1Y / 5Y**. Switching reloads all charts at once.
- 1D shows **intraday** data with **pre/post-market in gray** and a dashed
  **previous-close** baseline — like Google Finance.
- Hover any chart → a **tracer line + price** appears on **every** chart at
  the same time (synced crosshair, stays frozen on mouse-leave).
- Toggle each chart's metric between **price / P/E / P/S** (P/E and P/S from
  scraped quarterly fundamentals, anchored to the latest yfinance trailing values).
- A per-chart snapshot row (open/high/low, market cap, P/E, 52-week range,
  dividend) under each chart, Google-style.
- Edit your ticker list in-page (stored in `localStorage`).
- Mobile-friendly: toolbar stays frozen, charts scroll, ticker-jump nav chips.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Listens on `127.0.0.1:8050` (override with the `PORT` env var).

### Running under a supervisor (restartable)

To restart the server in place — handy when it lives in a long-lived `screen`
session — launch it via the supervisor instead of calling `app.py` directly:

```bash
screen -S stocks ./run.sh
```

`run.sh` relaunches the server whenever it exits with code `42`; any other exit
(Ctrl-C, crash) stops the supervisor. Three ways to trigger a restart:

```bash
./restart.sh                                 # reads server.pid, sends SIGHUP
kill -HUP "$(cat server.pid)"                # same thing, by hand
curl -X POST localhost:8050/api/restart      # local-only HTTP endpoint
```

The server writes its PID to `server.pid` on startup. Restarts reuse the same
`screen` window and launch command, so deployed code changes go live without
re-attaching.

## How data is fetched

- Two JSON endpoints:
  - `GET /api/history?range=<r>&symbols=ADBE,META,...&metric=price|pe|ps`
    — chart series for each symbol over the range.
  - `GET /api/stats?symbols=ADBE,META,...` — per-symbol snapshot row
    (open/high/low, market cap, P/E, 52-week high/low, dividend).
- All symbols for a range are pulled in a **single** batched `yf.download` call.
- Small in-memory TTL caches avoid re-hitting Yahoo when you toggle back.
- A background thread scrapes macrotrends for quarterly P/E and P/S data at
  1 req/min; page views never hit macrotrends directly.

## explore_toy/

Standalone Python/matplotlib scripts for exploring a future **Explore tab**
(stock screener). Not part of the web app — run independently, output PNGs.

- `toy_plots.py` — scatter plots of ~30 stocks: character (vol vs drift) and
  timing (ripeness vs drawdown), colored by backtest return/win-rate.
- `zigzag_viz.py` — visualizes the zigzag swing-counting algorithm on SMCI,
  comparing a buggy non-alternating version vs the corrected alternating one.
- `zigzag_nine.py` — corrected alternating zigzag for the 9 default stocks.
- `zigzag_ndx_top9.py` — ranks all ~100 Nasdaq-100 stocks by confirmed
  upswings (L→H ≥40% reversals, 3-year daily) and plots the top 9.

## Notes

- Yahoo's endpoint is unofficial; if data stops loading, `pip install -U yfinance` usually fixes it.
- Intended for personal, low-volume use.
