# Architecture

Reference for the whole app: the data pipeline, the Python backend, the
JavaScript front end, the CSS, the prompts, and the on-disk data formats.

- [1. Big picture](#1-big-picture)
- [2. The data pipeline — where data comes from, when, and what it means](#2-the-data-pipeline)
- [3. Backend (Python)](#3-backend-python)
- [4. HTTP API](#4-http-api)
- [5. Caching](#5-caching)
- [6. Front end (JavaScript)](#6-front-end-javascript)
- [7. CSS / theming](#7-css--theming)
- [8. Prompts](#8-prompts)
- [9. Data on disk](#9-data-on-disk)
- [10. Process / ops](#10-process--ops)

---

## 1. Big picture

```
browser (ES modules, uPlot, canvas)
        |  fetch /api/*
        v
Flask app.py  ──→ yfinance        (live: prices + .info)
        │     ──→ data/<sym>.json (macrotrends scrape + earnings cache)
        │     ──→ screener.py / backtest.py / opinion.py
        └──→ static/  (served at /, no-store so edits show on reload)
```

Flask does no templating — it serves the static front end and a set of JSON
`/api/*` endpoints. All view logic, charting and state live in the browser.
Python is stateless except for in-memory caches and the `data/` cache directory.

`app.run(host="127.0.0.1", port=PORT|8050, threaded=True)` — `threaded` matters:
a slow screener/scrape must not block dashboard requests.

---

## 2. The data pipeline

There are **three** data sources, with very different freshness and cost.

### 2a. yfinance — live, per request (the default path)

Everything price- or `.info`-based is fetched live from Yahoo via `yfinance`
and held only in short-lived in-memory caches:

- **Price series** — `build(range, symbols)` does **one batched `yf.download`**
  for all requested symbols. `RANGES` maps each UI range to yfinance params:
  - `1d` → `period=5d, interval=5m, prepost=True` (covers weekend + prev close)
  - `1w` → `5d / 30m`; `1mo/3mo/6mo/1y/5y` → daily; `3y` has no yfinance period,
    so it's fetched with an explicit `start/end` window.
  - `1d` is split into a regular-hours series + a gray pre/post series with a
    dashed previous-close baseline (`_series_1d`); other ranges are a single
    line on an **ordinal x-axis** (bar index, so nights/weekends don't gap).
- **Snapshot stats** (`build_stats`) and **fundamentals** — `Ticker.info`, one
  call per symbol, via `get_info` (keep-last-good: a transient empty `.info`
  never overwrites a good cache — this fixed descriptions vanishing).
- **Screener metrics** (`screener.build_screener`) — one batched `yf.download`
  of the universe + sector ETFs, then per-stock metrics; fundamentals
  (`pe, ps, rev_g, earn_g, roe, margins, fcf, mktcap, …`) come from threaded
  `.info` calls.
- **Backtest** and **reference overlays** and **earnings reactions** all read
  daily closes via `build(...)`.

Meaning downstream: the Stocks grid, stats rows, Trade/Invest, Backtest and the
reference overlays are **live and appear immediately** (subject to TTL caches and
the ~30s first screener build).

### 2b. macrotrends — background scrape, persisted to disk (valuation history)

Two things need long history Yahoo doesn't cheaply give: **P/E and P/S history**
and **quarterly revenue / net income**. These are scraped from macrotrends by a
background thread and cached on disk.

- A daemon thread (`start_scraper` → `_scheduler_loop`) wakes every
  `MT_INTERVAL = 5s`, asks `_next_unit()` for the next stale `(sym, metric)` and
  scrapes one page (`scrape_one`). `metric ∈ {pe, ps, revenue, netIncome}`
  (`MT_PATH`). A `(sym, metric)` is "fresh" if scraped today; failures back off
  for `MT_COOLDOWN = 900s`.
- **The worklist is `known_symbols()`** = `data/_symbols.json`, which is appended
  to (`remember_symbols`) every time the UI hits `/api/history` for a ticker. So
  a stock is only scraped **after you've opened it at least once**.
- Pages are parsed with regex (`_mt_parse` for the 4-col ratio pages → TTM
  per-share at column 2; `_mt_parse_series` for the 2-col quarterly pages) and
  written atomically into `data/<sym>.json` (`_save_metric`).

**P/E and P/S are computed at serve time**, not stored as ratios
(`apply_metric`): the chart's price series is divided by a stepped
trailing-per-share denominator (the scraped quarterly TTM history), and the
**current segment is anchored to yfinance's `trailingEps` / `revenuePerShare`**
so today's reading matches Yahoo/Google. Negative EPS → no P/E point.

Meaning downstream: **a freshly-opened stock has no P/E/P/S or quarterly
financials until the scraper reaches it** (paced ~1 request / 5s through the
worklist, refreshed daily). The detail page renders "loading…" for those charts
and **polls `/api/financials` every 20s (up to ~10 min)** until they fill in.

### 2c. local LLM CLIs — on demand (AI opinions)

`opinion.py` shells out to vendor CLIs already installed and logged in on the
host (`claude`, `codex` for ChatGPT, `gemini` via the Antigravity `agy` CLI).
**No API keys / no API billing** — it runs on your own subscriptions. See
[§3 opinion.py](#opinionpy) and [§8 Prompts](#8-prompts).

---

## 3. Backend (Python)

### app.py

The Flask app. Responsibilities:

- **Static host** — `Flask(static_folder="static", static_url_path="")`; `/`
  serves `index.html`. An `after_request` sets `Cache-Control: no-store` for
  `/api/*`, `/`, `.js`, `.css`, `.html` so code edits show up on a normal reload.
- **Price fetch** — `build()`, `_series_1d()`, `_series_plain()`, `RANGES`.
- **Stats / info** — `build_stats()`, `get_info()` (keep-last-good, `INFO_TTL`).
- **macrotrends scraper** — `MT_*` constants, `_mt_fetch/_mt_parse/_mt_parse_series`,
  `scrape_one`, `_next_unit`, `_scheduler_loop`, `start_scraper`,
  `known_symbols/remember_symbols`, `load_fundamentals/_save_metric`.
- **Ratio transform** — `apply_metric()` (price → P/E or P/S at serve time).
- **Profile + earnings** — `build_profile()` (name/exchange/segment/description
  from `.info`, persisted), `fetch_earnings()/get_earnings()` (`get_earnings_dates`,
  cached 12h to disk, keep-last-good).
- **Financials** — quarterly revenue/net income series + a TTM line.
- **Screener / calendar / backtest / reference / universe / opinion** endpoints
  (see [§4](#4-http-api)). `cached_screener()` is the shared screener-cache
  accessor reused by the screener, calendar and earnings-detail endpoints.
- **Restart** — `_restart_exit()` (flush + `os._exit(42)`), `SIGHUP` handler,
  `/api/restart`, `server.pid`. See [§10](#10-process--ops).

`_f(x)` is the JSON-safe float (NaN/inf → None) used everywhere.

### screener.py & build_universe.py

Pure, price-based screener over the configured universe.

- **Universe** — `build_universe.py` makes one bulk request to the Nasdaq screener
  API (whole market with sector/industry/marketCap, no per-ticker throttling) and
  writes the committed **`universe.json`** = ticker→ETF map for
  *Nasdaq-100 ∪ software/SaaS(>$500M) ∪ games ∪ quantum* (~354 names). Rerun it
  weekly. `screener._load_universe()` reads it at runtime into `IND`, falling back
  to the hand-curated `NDX100_ETF` (Nasdaq-100) if the file is missing.
- `IND` — runtime ticker → ETF benchmark map; `UNIVERSES = {"ndx100": list(IND)}`.
- Constants: `THRESHOLD=0.40` (zigzag), `BT_TP/BT_SL/BT_HOLD = 1.40/0.60/126`,
  `IDIO_WINDOW=60`, `LOOKBACK_YEARS`.
- `build_screener(lookback, universe)` — one batched `yf.download` of universe +
  ETFs, then per-stock `_metrics()`:
  `vol, drift, r2, up` (alternating zigzag upswings ≥40%), `off52, dd, above_lo`,
  `bt_avg/bt_win` (`_backtest`), `idio_z` (residual z vs industry ETF),
  plus a downsampled `spark` (last ~6mo).
- `_attach_fundamentals(rows)` — threaded `.info` adds `name, exchange,
  profitable, pe, ps, rev_g, earn_g` and the Invest-tab fields (`roe, gross_m,
  op_m, fcf_m, fcf_y, nd_ebitda, curr, mktcap, earn_y`).
- `exchange_label`, `segment_label` helpers.

### backtest.py

Vectorized ensemble backtest (numpy inner, ~0.3–0.5s for a full single-stock
sweep — no parallelism needed). **Bit-identical to `screener._backtest`** for the
default cell, so the Backtest tab and Trade screener agree.

- `_simulate(arr, tp, sl, hold, max_price)` — one entry per day, exit on first
  TP/SL touch within `hold` else force-exit; returns per-entry return / days /
  resolved arrays.
- `run_single(t, arr, delta, hold, max_price)` — metrics (win, mean/annualized
  return, Sharpe, trade ratio, avg hold, conditional-win), per-day outcomes (for
  the coloured price chart) and a returns histogram.
- `run_sweep(arr, max_price)` — Δ (`SWEEP_DELTAS`) × max-hold (`SWEEP_HOLDS`)
  grid of win / mean-return / Sharpe.
- `dickey_fuller(arr)` — unit-root t-stat (mean-reverting vs random walk).

### opinion.py

Provider-agnostic AI-opinion orchestration.

- **Providers** — `MockProvider` (canned), `CLIProvider` base, and
  `ClaudeCLIProvider` / `CodexCLIProvider` / `GeminiCLIProvider`. Each `complete()`
  is plain text-in/out; the JSON+freetext contract is enforced purely by the
  prompt. Codex captures the clean final message via `-o <file>`; Gemini runs the
  `agy` CLI. Only providers whose binary is on `PATH` register.
- **Profiles** — `mock` (2 mock agents), `fast` (2× claude-haiku), `full`
  (3× claude-opus-4-8 + 3× gpt-5.5 + 3× gemini-3.1-pro + opus summarizer, with
  web research + thinking). `ACTIVE_PROFILE` is the default.
- **Jobs** — `start_job()` spawns a background thread; agents run in a
  `ThreadPoolExecutor` (fire-all-at-once, partial failure → summarize survivors);
  prompts are read fresh from `prompts/` each run; result saved to
  `data/opinions/<SYM>/<ts>.json`. `status()`, `list_opinions()`, `get_opinion()`,
  `delete_opinion()`.

---

## 4. HTTP API

All return JSON; `{error}` + non-200 on failure. `no-store` on everything.

| Endpoint | Purpose |
|---|---|
| `GET /api/history?range=&metric=price\|pe\|ps&symbols=A,B` | per-symbol chart series; `pe/ps` apply the serve-time ratio transform |
| `GET /api/stats?symbols=A,B` | snapshot stat rows (open/high/low, mkt cap, P/E, 52-wk, dividend) |
| `GET /api/profile?symbol=` | name/exchange/segment/description + earnings (detail header) |
| `GET /api/financials?symbol=` | quarterly revenue + net income series (+ TTM) |
| `GET /api/screener?lookback=1y\|3y\|5y&universe=ndx100` | full screener rows (Trade/Invest) |
| `GET /api/calendar` | ±3M earnings across the universe + attrs + reactions (cached) |
| `GET /api/earnings_detail?symbol=` | on-demand drawer detail (spark, above/below, backtest, valuation, idio) |
| `GET /api/backtest?symbol=&range=&delta=&hold=&max_price=` | single-config backtest detail |
| `GET /api/backtest/sweep?symbol=&range=&max_price=` | Δ×hold grid + Dickey-Fuller |
| `GET /api/reference?range=&ref=` | start-normalized reference series for "same $" overlays |
| `GET /api/universe?universe=` | universe ticker list (the 🍀 lucky button) |
| `POST /api/opinion/start?symbol=&profile=` | launch an AI-opinion job |
| `GET /api/opinion/status?job=` | poll job progress |
| `GET /api/opinion/list?symbol=` · `GET /api/opinion/get?symbol=&id=` | saved opinions |
| `POST /api/opinion/delete?symbol=&id=` | delete a saved opinion |
| `POST /api/restart` | local-only: exit 42 → supervisor relaunch |

---

## 5. Caching

In-memory dicts in `app.py` (cleared on restart); plus the on-disk `data/` cache.

| Cache | Key | TTL |
|---|---|---|
| `_cache` (history) | `(range, symbols, metric)` | `TTL[range]` (60s for 1d, else 3600s) |
| `_stats_cache` | symbols | `STATS_TTL` 1800s |
| `_info_cache` (`.info`) | sym | `INFO_TTL` 1800s, keep-last-good |
| `_screener_cache` | `(universe, lookback)` | `SCREENER_TTL` 6h |
| `_calendar_cache` | `"calendar"` | `CALENDAR_TTL` 1800s |
| `_ref_cache` | `(range, ref)` | `REF_TTL` 3600s |
| `_bt_series_cache` | `(sym, range)` | `BT_SERIES_TTL` 3600s |
| `_bt_sweep_cache` | `(sym, range, max_price)` | 3600s |
| earnings (disk) | per `data/<sym>.json` | `EARN_TTL` 12h |
| macrotrends (disk) | per `(sym, metric)` | daily (re-scrape if not scraped today) |

---

## 6. Front end (JavaScript)

No bundler. `index.html` loads uPlot, `marked` and `dompurify` (classic scripts)
then `js/main.js` as a module. Modules import each other directly.

### Core

- **main.js** — bootstrap: applies the saved theme, wires the pane factories
  (`stocks, explore, invest, calendar, stock`) to the `PaneManager`, boots it,
  and wires window-resize, theme-change redraw, and the drag-resize / collapse
  of the sidebar.
- **paneManager.js** — `PaneManager`: pane registry + lifecycle
  (`mount/onActivate/onDeactivate/destroy`), the hash router (`#/stocks`,
  `#/explore`, `#/invest`, `#/earnings`, `#/stock/<SYM>`), structural persistence
  (`localStorage "session.v1"`: which panes are open + active), and the sidebar
  (singletons ordered first, then stock panes; the 🍀 lucky button + theme toggle
  in the footer).
- **api.js** — thin `fetch` wrappers for every endpoint (no DOM).
- **util.js** — colors/`tzDate`, formatters (`fmtPrice/fmtCap/fmtMoneyM/fmtTime`),
  axis tick helpers (`dayTickSplits`, `intradayValues`, `ordinalValues`),
  `statsHTML(s, minimal)`, `nearestIdx`, uPlot fill/prev-close plugins.
- **filters.js** — shared group-filter machinery (Exchange/Industry/MAG7/
  Profitable): `newFilters`, `matches`, `handleFilterClick`, `buildFilterChipsHTML`,
  `IND_LABEL`, `MAG7`, `escapeHTML`. Used by Trade/Invest **and** Earnings.
- **theme.js** — light/dark (`body.light` class, persisted `theme.v1`),
  `initTheme`, the sun/moon `makeThemeToggle`, dispatches a `themechange` event.

### Charts

- **chart.js** — the uPlot "card" + the pane-scoped frozen crosshair
  (`CrosshairGroup`, `buildCard`, `renderCard`). Draws our own crosshair (vline,
  dot, tip) so it can freeze on mouse-leave, plus the **horizontal price line +
  above/below time-share** percentages (price charts only). Also the static
  **zigzag/upswing** renderer (`renderZigzag`: pivots, %-labels, earnings vlines,
  tail leg, own live crosshair) and **quarterly financials** renderer
  (`renderQuarterly`). `refOverlay()` builds the "same $" overlay; `syncCompareUI()`
  keeps the Compare dropdown/Hide in sync.
- **scatter.js** — `ScatterChart`: dependency-free canvas scatter with per-point
  size/color, nice/log axes, magic-quadrant boxes, clip-with-arrow, hover
  hit-testing and cross-panel highlight. Reads theme colors from CSS vars each draw.
- **backtestcharts.js** — canvas renderers for the Backtest tab:
  `renderOutcomePrice` (price line colored by per-day trade outcome),
  `renderHistogram`, `renderSweepPanel` (Δ-sweep with per-hold lines).

### Panes (`js/panes/`)

- **stocks.js** — `StocksPane`: the watchlist grid; ranges/metric/yaxis toggles,
  Compare overlay, Full/Min stats, editable symbols (`localStorage "symbols.v3"`).
- **explore.js** — `ScreenerPane` (config-driven) + `TRADE_CONFIG` / `INVEST_CONFIG`
  (`SCREENER_CONFIGS`). One pane class, two configs (panels, color/size encoding,
  legend, tooltip). Owns the search box and (via filters.js) the group chips.
- **stock.js** — `StockPane`: the per-stock detail page — 1×3 synced metric
  charts, zigzag, quarterly financials, header (stats/earnings/external links),
  and the **Backtest** and **AI Opinion** sub-tabs (+ financials loading poll).
- **calendar.js** — `CalendarPane` (titled "Earnings"): the day-grouped earnings
  list, window/mode toggles, shared filters + search, row sparkline + reaction,
  and the expandable detail drawer.

### Client-side state

- `localStorage` — `session.v1` (open panes), `symbols.v3` (watchlist),
  `theme.v1`, `sidebarW`, `sidebarCollapsed`.
- In-memory only (resets on reload) — each pane's `viewState` (range, metric,
  filters, window, etc.).

---

## 7. CSS / theming

A single `static/style.css`. Theming is a CSS-variable swap: `:root` defines the
dark palette (`--bg, --panel, --border, --text, --muted, --up, --down, --accent,
--accent-fg, --sidebar-bg, --code-bg`); `body.light` overrides them; `theme.js`
toggles the `light` class. Canvas charts (scatter, backtest, sparklines) read
these variables via `getComputedStyle` on each draw and redraw on `themechange`.
Roughly grouped: app shell / sidebar (incl. theme toggle, 🍀, resizer), explore
grid + scatter + filter chips + search, toolbar, backtest tab, calendar/earnings,
stock-detail header + cards + crosshair, opinion sub-tabs, responsive `@media`.

---

## 8. Prompts

LLM prompt templates in `prompts/`, read fresh from disk on every opinion run
(so edits need no restart):

- **opinion_agent.md** — the per-agent system prompt: a Buffett/Munger value
  investor that applies a quality gate, estimates intrinsic value (DCF / EPV /
  reverse-DCF / relative), demands a margin of safety, optionally checks recent
  news, and outputs a strict fenced ```json block (verdict, quality_gate_pass,
  primary_method, intrinsic_value, buy_below, fair_value, confidence,
  key_assumptions, key_risks, recent_news_flags) followed by a prose rationale.
- **opinion_summary.md** — the summarizer system prompt: synthesize the N agent
  analyses into one decision-ready briefing (verdict + vote split, valuation
  range, bull/bear, dispersion & confidence).

---

## 9. Data on disk

`data/` is gitignored runtime cache.

**`data/<sym>.json`** — per-stock scrape/earnings cache:

```jsonc
{
  "pe":       {"scraped_at": "ISO-NY", "rows": [["YYYY-MM-DD", price, ttmEps, ratio], ...]},
  "ps":       {"scraped_at": "...",    "rows": [["YYYY-MM-DD", price, ttmSalesPerShare, ratio], ...]},
  "revenue":  {"scraped_at": "...",    "rows": [["YYYY-MM-DD", millions], ...]},
  "netIncome":{"scraped_at": "...",    "rows": [["YYYY-MM-DD", millions], ...]},
  "earnings": {"fetched_at": epoch,
               "past": [{"date","epsEst","epsActual","surprisePct","beat"}, ...],
               "next": {"date","estimated","epsEst"}},
  "profile":  {"name","exchange","currency","segment","industry","description"}  // if fetched
}
```

**`data/_symbols.json`** — `["AAPL", "ADBE", ...]`, the scraper worklist (every
ticker the UI has requested).

**`data/opinions/<SYM>/<ts>.json`** — a saved opinion job (the `_public(job)`
shape): `{id, symbol, ts, profile, state, agents[], summary, log[], runs[], summary_md}`.

**`server.pid`** — current server PID.

---

## 10. Process / ops

- Launch via **`./run.sh`** (the supervisor) inside `screen`. It loops the server
  and relaunches it on exit code **42**; any other exit stops it.
- **Restart in place:** `./restart.sh` (SIGHUP via `server.pid`), `kill -HUP`, or
  `POST /api/restart`. The server flushes and `os._exit(42)`; the supervisor
  relaunches it — same window, same command. (A full exit, rather than re-exec,
  is required because werkzeug keeps the listening socket inheritable.)
- **Port** via `PORT` env (default 8050). Prompt-file edits need no restart;
  Python changes do; static JS/CSS edits just need a browser reload (no-store).
- The macrotrends scraper runs as a daemon thread inside the server process — no
  separate cron.
