# Stocks — a personal market dashboard

A single-user web dashboard for watching, screening, backtesting and reading up
on stocks. **Flask is a thin gateway**; all the UI is plain ES-module JavaScript
with [uPlot](https://github.com/leeoniya/uPlot) and hand-rolled canvas charts —
**no build step**. Live prices come from `yfinance`; valuation history is scraped
from macrotrends in the background; AI opinions run through local LLM CLIs.

Deployed (for the author) at `stocks.bytepawn.com`; listens on `127.0.0.1:8050`.

> Deep reference — Python/JS/CSS modules, the data pipeline, caching, file
> formats — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Views

The left sidebar is a list of **panes** (each a `#/route`):

- **Stocks** (`#/stocks`) — responsive grid of price charts for your watchlist.
  Ranges 1D–5Y; metric toggle **price / P/E / P/S**; per-chart / shared y-axis
  (Local/Global); a synced, freeze-on-leave crosshair with a horizontal price
  line and above/below time-share; **Compare** dropdown to overlay "same $ into
  SPY/QQQ/Gold/BTC/Mag-7/…"; **Full/Min** stats toggle; editable ticker list.
- **Trade** (`#/explore`) — a 3×2 of linked scatter panels (macro-quadrant
  boxes, log axes, clip arrows) to find **swingy, mean-reverting** names.
- **Invest** (`#/invest`) — same machinery, **quality/value** axes (ROE, margins,
  FCF, balance sheet, growth, P/E-vs-ROE) for WB/CM-style compounders.
- **Earnings** (`#/earnings`) — recent + upcoming earnings across the universe
  as a day-grouped list (EPS, market cap, last-4 beat/miss, sparkline, last-
  report price reaction), with an expandable per-stock detail drawer.
- **Stock detail** (`#/stock/<SYM>`) — 1×3 synced metric charts, an upswing
  (zigzag) chart, quarterly financials, a header with stats/earnings/links, a
  **Backtest** sub-tab, and an **AI Opinion** sub-tab.

Trade, Invest and Earnings share one screener build and the same
exchange / industry / MAG7 / profitable group filters + ticker search.

A 🍀 "I'm feeling lucky" button opens a random universe stock; a sun/moon toggle
switches light/dark. The sidebar is drag-resizable and collapsible.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py            # http://127.0.0.1:8050   (override with PORT=)
```

### Under a supervisor (restartable in place)

For a long-lived deployment in `screen`, launch via the supervisor so the server
can restart itself (handy when picking up new code):

```bash
screen -S stocks ./run.sh
```

`run.sh` relaunches the server whenever it exits with code **42**; any other exit
(Ctrl-C, crash) stops the supervisor. Three ways to trigger a restart:

```bash
./restart.sh                              # reads server.pid, sends SIGHUP
kill -HUP "$(cat server.pid)"             # same, by hand
curl -X POST localhost:8050/api/restart   # local-only HTTP endpoint
```

## Where data comes from (the short version)

| Data | Source | When | Downstream |
|---|---|---|---|
| Price series, intraday | `yfinance` `yf.download` (live) | per request, cached by TTL | charts, screener, backtest, reference overlays, earnings reactions |
| Snapshot stats, fundamentals, `.info` | `yfinance` `Ticker.info` (live) | per request, cached | stats rows, screener fundamentals, P/E·P/S anchors, profile |
| Earnings dates / EPS | `yfinance` `get_earnings_dates` | cached 12h to `data/<sym>.json` | detail header, Earnings page |
| P/E & P/S **history** | macrotrends scrape (TTM per-share) | background, ~1 page / 5s, daily | metric charts (price ÷ denominator at serve time) |
| Quarterly revenue / net income | macrotrends scrape | background, daily | detail financials charts |
| AI opinions | local `claude` / `codex` / `gemini`(`agy`) CLIs | on demand | AI Opinion sub-tab |

**Key consequence:** the macrotrends scraper only works through tickers the UI
has asked about (`data/_symbols.json`), paced ~1 request / 5s. A freshly-opened
stock therefore has **no P/E/P/S or quarterly financials until the scraper
reaches it** — the detail page shows "loading…" and polls until it fills in.
Everything price/`.info`-based (the grid, stats, screeners, backtest) is live and
appears immediately. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
full pipeline.

## Repo layout

```
app.py              Flask app: routes, caching, yfinance access, macrotrends scraper
screener.py         loads the universe (universe.json), price-based screener metrics
build_universe.py   (re)builds universe.json from one Nasdaq snapshot + theme lists
universe.json       committed universe: ~354 ticker→ETF map (read at runtime)
backtest.py         vectorized TP/SL/hold backtest engine + Δ×hold sweep + Dickey-Fuller
opinion.py          AI-opinion orchestration over local LLM CLIs (provider-agnostic)
prompts/            opinion_agent.md, opinion_summary.md  (LLM prompt templates)
requirements.txt    Flask, yfinance, pandas, numpy, lxml
run.sh / restart.sh supervisor + in-place restart
static/             the whole front end (served at /)
  index.html        shell: sidebar, content, CDN scripts (uPlot, marked, dompurify)
  style.css         all styles + light/dark theme variables
  js/               main.js, paneManager.js, api.js, util.js, filters.js, theme.js,
                    chart.js, scatter.js, backtestcharts.js, panes/*.js
explore_toy/        throwaway matplotlib scripts that prototyped the screener (not used by the app)
data/               runtime cache (gitignored) — see below
```

## `data/` (runtime, gitignored)

- `data/<sym>.json` — per-stock scraped/derived cache: `pe`, `ps`, `revenue`,
  `netIncome` (each `{scraped_at, rows}`) and `earnings` (`{fetched_at, past[], next}`).
- `data/_symbols.json` — every ticker the UI has requested (the scraper's worklist).
- `data/opinions/<SYM>/<ts>.json` — saved AI-opinion runs.
- `server.pid` — current PID (for `restart.sh`).

`data/`, `server.pid` and `secrets.json` are gitignored. No API keys are used —
AI runs entirely through local CLIs on your own subscriptions.

## Notes

- Yahoo's endpoint is unofficial; if data stops loading, `pip install -U yfinance` usually fixes it.
- The universe is **~354 names** — Nasdaq-100 ∪ software/SaaS (>$500M) ∪ game ∪
  quantum stocks — built by `build_universe.py` into the committed `universe.json`
  (one Nasdaq snapshot, no per-ticker throttling; rerun weekly to refresh).
  Names outside it (e.g. most NYSE industrials) won't appear in Trade/Invest/
  Earnings, but any ticker's detail page still works.
- Intended for personal, low-volume use; no auth, bind to localhost / front with a proxy.
