"use strict";

// Config-driven screener pane: a 3x2 of linked scatter panels driven by
// /api/screener. Two instances share one screener build/cache:
//   - TRADE_CONFIG  ("Trade")  — swingy mean-reversion targets.
//   - INVEST_CONFIG ("Invest") — WB/CM-style long-term quality compounders.
// Each config supplies its panels, global color/size encoding, tooltip footer
// and legend. Hover cross-highlights the same stock on every panel; the search
// box and exchange/industry/profitable filters are shared machinery.

import { ScatterChart } from "../scatter.js";

// diverging "goodness" color: red (bad) -> yellow -> green (good)
const RED = [236, 138, 130], YEL = [230, 210, 120], GREEN = [137, 201, 150];
const GREY = "rgba(154,160,166,0.7)";
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
// map goodness g in [0,1] -> rgba string (0 = red, 0.5 = yellow, 1 = green)
function rgbaFor(g) {
  const c = g < 0.5 ? mix(RED, YEL, g * 2) : mix(YEL, GREEN, (g - 0.5) * 2);
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},0.85)`;
}

function pct(arr, q) {
  const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.floor((a.length - 1) * q)];
}

const LOOKBACKS = ["1y", "3y", "5y"];

// curated set for the MAG7 filter chip (GOOG/GOOGL both, whichever the universe has)
const MAG7 = new Set(["AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "NVDA", "META", "TSLA"]);

// industry/sector ETF -> human label for the tooltip
const IND_LABEL = {
  SOXX: "Semiconductors", IGV: "Software/SaaS", XLC: "Internet/Media",
  XLY: "Consumer/Retail", XLP: "Staples", XBI: "Biotech/Health",
  XLI: "Industrials", XLK: "Tech/Hardware", IPAY: "Payments",
  TAN: "Solar", XLE: "Energy", XLU: "Utilities", XLB: "Materials",
};
function indLabel(etf) {
  if (!etf) return "";
  return IND_LABEL[etf] ? `${IND_LABEL[etf]} (${etf})` : etf;
}

// ---------------------------------------------------------------------------
// TRADE config — find swingy, mean-reverting speculation targets.
// ---------------------------------------------------------------------------

const PANELS_TRADE = [
  { key: "tl", title: "[TL] Character", xKey: "up", yKey: "r2",
    xLabel: "Confirmed upswings (≥40%)", yLabel: "R² of log-price (low = choppy = good)",
    good: { x: [3, null], y: [null, 0.4] } },
  { key: "tr", title: "[TR] Payoff", xKey: "bt_win", yKey: "bt_avg",
    xLabel: "Backtest win rate", yLabel: "Avg return / trade (%)",
    good: { x: [0.6, null], y: [10, null] } },
  { key: "bl", title: "[BL] Value", xKey: "above_lo", yKey: "dd",
    xLabel: "% above historic low (0 = at its low)", yLabel: "% below historic high (x+y = full range)",
    good: { x: [null, 33], y: [30, null] } },
  { key: "br", title: "[BR] Factor / 'off'", xKey: "idio_z", yKey: "off52",
    xLabel: "Idiosyncratic z vs industry (left = off-to-downside)", yLabel: "% below 52-week high",
    good: { x: [null, -1], y: [30, null] } },
  { key: "growth", title: "[R3-L] Growth (YoY)", xKey: "rev_g", yKey: "earn_g",
    xLabel: "Revenue growth YoY (%, clipped ±100)", yLabel: "Earnings growth YoY (%, clipped ±100)",
    good: { x: [0, null], y: [0, null] }, clipX: [-100, 100], clipY: [-100, 100] },
  { key: "value", title: "[R3-R] Valuation (log-log)", xKey: "ps", yKey: "pe",
    xLabel: "P/S (trailing, log)", yLabel: "P/E (trailing, log; profitable only)",
    good: { x: [null, 5], y: [null, 20] }, logX: true, logY: true },
];

function tradeEncode(stocks) {
  // color = how IDEAL the drift is: green = flat (sweet spot), red = steep.
  const dlo = Math.min(pct(stocks.map((s) => s.drift), 0.05), -0.1);
  const dhi = Math.max(pct(stocks.map((s) => s.drift), 0.95), 0.1);
  const dscale = Math.max(Math.abs(dlo), Math.abs(dhi), 0.1);
  const vlo = pct(stocks.map((s) => s.vol), 0.05);
  const vhi = pct(stocks.map((s) => s.vol), 0.95);
  return {
    colorOf: (p) => p.drift == null ? GREY : rgbaFor(clamp01(1 - Math.abs(p.drift) / dscale)),
    radiusOf: (p) => {
      const v = p.vol == null ? vlo : p.vol;
      return 4 + 12 * clamp01(vhi > vlo ? (v - vlo) / (vhi - vlo) : 0.5);
    },
  };
}

const TRADE_LEGEND = [
  ["Volatility", "dot size", "annualized stdev of daily returns: how big the swings are."],
  ["Drift", "dot color", "trend fit: green = flat (ideal), red = steep (falling-knife or at-ATH)."],
  ["Upswings", "TL&nbsp;x", "count of confirmed ≥40% low→high reversals: how often it round-trips."],
  ["R²", "TL&nbsp;y", "line-fit of log-price: low = choppy (good to swing), high = clean trend."],
  ["Win rate", "TR&nbsp;x", "fraction of backtested trades closing positive (+40% TP / −40% SL / 6mo)."],
  ["Avg return", "TR&nbsp;y", "mean return per backtested trade under that rule."],
  ["% below 52-week high", "BR&nbsp;y", "distance under the 1-year peak: the ripeness signal."],
  ["% above historic low", "BL&nbsp;x", "distance above the multi-year low; with below-high it sums to the full range."],
  ["% below historic high", "BL&nbsp;y", "drawdown from the multi-year peak."],
  ["Idiosyncratic z", "BR&nbsp;x", "return minus its industry-ETF move, in σ: negative = fell on its own."],
  ["Industry", "tooltip", "the sector ETF each stock is benchmarked against (e.g. SOXX, IGV)."],
  ["Revenue growth", "R3-L&nbsp;x", "trailing YoY sales growth."],
  ["Earnings growth", "R3-L&nbsp;y", "trailing YoY earnings growth (profitable names only)."],
  ["P/S", "R3-R&nbsp;x", "price/sales; lower = cheaper (defined for all)."],
  ["P/E", "R3-R&nbsp;y", "price/earnings; lower = cheaper (profitable only — negative dropped)."],
];

const TRADE_CONFIG = {
  id: "explore", type: "explore", title: "Trade",
  panels: PANELS_TRADE, encode: tradeEncode, legend: TRADE_LEGEND,
  tooltipFoot: (p) => `vol ${fmt(p.vol)}% · drift ${fmt(p.drift)}%/yr`,
};

// ---------------------------------------------------------------------------
// INVEST config — wonderful businesses (high returns on capital, durable
// margins, fortress balance sheet, steady growth) at a fair price.
// ---------------------------------------------------------------------------

const PANELS_INVEST = [
  { key: "moat", title: "[TL] Moat / returns on capital", xKey: "roe", yKey: "gross_m",
    xLabel: "ROE (%)", yLabel: "Gross margin (%)",
    good: { x: [15, null], y: [40, null] } },                       // top-right = moat
  { key: "cash", title: "[TR] Profit → cash", xKey: "op_m", yKey: "fcf_m",
    xLabel: "Operating margin (%)", yLabel: "FCF margin (%)",
    good: { x: [15, null], y: [10, null] } },                       // top-right = real cash
  { key: "balance", title: "[ML] Balance sheet", xKey: "nd_ebitda", yKey: "curr",
    xLabel: "Net debt / EBITDA (×, lower = better)", yLabel: "Current ratio",
    good: { x: [null, 2], y: [1.5, null] }, clipX: [-5, 8] },       // top-LEFT = fortress
  { key: "growthq", title: "[MR] Durable growth", xKey: "rev_g", yKey: "earn_g",
    xLabel: "Revenue growth YoY (%, clipped ±100)", yLabel: "Earnings growth YoY (%, clipped ±100)",
    good: { x: [8, null], y: [8, null] }, clipX: [-100, 100], clipY: [-100, 100] },
  { key: "owneryield", title: "[BL] Owner yield / value", xKey: "fcf_y", yKey: "earn_y",
    xLabel: "FCF yield (%)", yLabel: "Earnings yield (%, = 1/PE)",
    good: { x: [5, null], y: [5, null] } },                         // top-right = cheap cash
  { key: "qualpx", title: "[BR] Quality vs price ★", xKey: "pe", yKey: "roe",
    xLabel: "P/E (trailing, log)", yLabel: "ROE (%)",
    good: { x: [null, 20], y: [20, null] }, logX: true },           // top-LEFT = great & cheap
];

function investEncode(stocks) {
  // color = quality composite: blend of ROE, gross margin and low leverage.
  const bounds = (key) => [pct(stocks.map((s) => s[key]), 0.1), pct(stocks.map((s) => s[key]), 0.9)];
  const [roeLo, roeHi] = bounds("roe");
  const [gmLo, gmHi] = bounds("gross_m");
  const [ndLo, ndHi] = bounds("nd_ebitda");
  const norm = (v, lo, hi) => (v == null || hi <= lo) ? null : clamp01((v - lo) / (hi - lo));
  // size = market cap on a log scale
  const caps = stocks.map((s) => s.mktcap).filter((x) => x > 0).map(Math.log);
  const cLo = caps.length ? Math.min(...caps) : 0;
  const cHi = caps.length ? Math.max(...caps) : 1;
  return {
    colorOf: (p) => {
      const parts = [
        norm(p.roe, roeLo, roeHi),
        norm(p.gross_m, gmLo, gmHi),
        p.nd_ebitda == null ? null : 1 - norm(p.nd_ebitda, ndLo, ndHi),  // less debt = better
      ].filter((x) => x != null);
      if (!parts.length) return GREY;
      return rgbaFor(parts.reduce((a, b) => a + b, 0) / parts.length);
    },
    radiusOf: (p) =>
      (!(p.mktcap > 0) || cHi <= cLo) ? 6 : 4 + 12 * clamp01((Math.log(p.mktcap) - cLo) / (cHi - cLo)),
  };
}

const INVEST_LEGEND = [
  ["Quality", "dot color", "blend of ROE, gross margin & low leverage — green = wonderful business."],
  ["Market cap", "dot size", "company size (log scale)."],
  ["ROE", "TL&nbsp;x · BR&nbsp;y", "return on equity — profit per $ of equity; the core moat signal."],
  ["Gross margin", "TL&nbsp;y", "pricing power — revenue left after cost of goods."],
  ["Operating margin", "TR&nbsp;x", "profit after operating costs."],
  ["FCF margin", "TR&nbsp;y", "free cash flow as % of revenue — cash-conversion quality."],
  ["Net debt / EBITDA", "ML&nbsp;x", "leverage — net borrowings vs cash earnings; lower = safer (left)."],
  ["Current ratio", "ML&nbsp;y", "short-term liquidity — current assets / current liabilities."],
  ["Revenue growth", "MR&nbsp;x", "trailing YoY sales growth."],
  ["Earnings growth", "MR&nbsp;y", "trailing YoY earnings growth."],
  ["FCF yield", "BL&nbsp;x", "free cash flow / market cap — the owner's cash return."],
  ["Earnings yield", "BL&nbsp;y", "1 / P-E — the earnings return at today's price."],
  ["P/E", "BR&nbsp;x", "price / earnings — cheaper to the left (profitable only)."],
  ["Industry", "tooltip", "the sector ETF each stock is benchmarked against (e.g. SOXX, IGV)."],
];

const INVEST_CONFIG = {
  id: "invest", type: "invest", title: "Invest",
  panels: PANELS_INVEST, encode: investEncode, legend: INVEST_LEGEND,
  tooltipFoot: (p) => `ROE ${fmt(p.roe)}% · ${fmtCap(p.mktcap)}`,
};

export const SCREENER_CONFIGS = { explore: TRADE_CONFIG, invest: INVEST_CONFIG };

// ---------------------------------------------------------------------------

export class ScreenerPane {
  constructor(opts = {}) {
    this.config = opts.config || TRADE_CONFIG;
    this.id = this.config.id;
    this.type = this.config.type;
    this.title = this.config.title;
    this.closable = false;
    this.onOpenStock = opts.onOpenStock || (() => {});
    this.viewState = { lookback: "3y" };   // in-memory, resets on reload
    this.filters = { exchanges: new Set(), industries: new Set(), profitable: false, mag7: false };
    this.charts = [];
    this.inited = false;
  }

  mount(container) {
    const cfg = this.config;
    const root = document.createElement("div");
    root.className = "pane explore-pane";
    root.innerHTML = `
      <header class="toolbar">
        <div class="ranges" data-group="lookback">
          ${LOOKBACKS.map((l) => `<button data-lb="${l}">${l.toUpperCase()}</button>`).join("")}
        </div>
        <div class="explore-search">
          <input class="explore-search-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Search ticker or name…" />
          <div class="explore-search-results" hidden></div>
        </div>
        <div class="tb-right"><span class="status"></span></div>
      </header>
      <div class="explore-filters"></div>
      <main class="explore-grid">
        ${cfg.panels.map((p) => `<div class="explore-cell" data-cell="${p.key}"></div>`).join("")}
      </main>
      <footer class="explore-legend">
        <button class="legend-bar" type="button">Metrics <span class="legend-caret">▴</span></button>
        <div class="legend-grid">
          ${cfg.legend.map(([term, tag, desc]) =>
            `<p><b>${term}</b> <i>(${tag})</i> — ${desc}</p>`).join("")}
        </div>
      </footer>`;
    container.appendChild(root);
    this.root = root;
    this.statusEl = root.querySelector(".status");
    this.searchInput = root.querySelector(".explore-search-input");
    this.searchResults = root.querySelector(".explore-search-results");
    this.filtersEl = root.querySelector(".explore-filters");
    this.stocks = [];
    this.cells = {};
    for (const p of cfg.panels) this.cells[p.key] = root.querySelector(`[data-cell="${p.key}"]`);

    this.searchInput.addEventListener("input", () => this._renderSearch());
    this.searchInput.addEventListener("focus", () => this._renderSearch());
    this.searchInput.addEventListener("keydown", (e) => {
      const open = !this.searchResults.hidden && this._hits && this._hits.length;
      if (e.key === "ArrowDown") {
        if (open) { e.preventDefault(); this._setActive(this._activeIdx + 1); }
      } else if (e.key === "ArrowUp") {
        if (open) { e.preventDefault(); this._setActive(this._activeIdx - 1); }
      } else if (e.key === " " || e.key === "Spacebar") {
        const sym = this._activeSym();
        if (open && sym) { e.preventDefault(); this._pickSearch(sym); }
      } else if (e.key === "Enter") {
        const sym = this._activeSym();
        if (open && sym) { e.preventDefault(); this._openDetails(sym); }
      } else if (e.key === "Escape") {
        this._hideSearch();
        this.searchInput.blur();
      }
    });
    this.searchResults.addEventListener("click", (e) => {
      const det = e.target.closest(".esr-details");
      if (det) { e.stopPropagation(); this._openDetails(det.dataset.sym); return; }
      const item = e.target.closest("[data-sym]");
      if (item) this._pickSearch(item.dataset.sym);
    });
    this.searchResults.addEventListener("mousemove", (e) => {
      const item = e.target.closest("[data-sym]");
      if (item && this._hits) this._setActive(this._hits.indexOf(item.dataset.sym));
    });
    this._onDocClick = (e) => {
      if (!root.querySelector(".explore-search").contains(e.target)) this._hideSearch();
    };
    document.addEventListener("click", this._onDocClick);

    this.filtersEl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.clear) {
        this.filters.exchanges.clear();
        this.filters.industries.clear();
        this.filters.profitable = false;
        this.filters.mag7 = false;
      } else if (b.dataset.prof) {
        this.filters.profitable = !this.filters.profitable;
      } else if (b.dataset.mag7) {
        this.filters.mag7 = !this.filters.mag7;
      } else if (b.dataset.group === "exchange") {
        this._toggle(this.filters.exchanges, b.dataset.val);
      } else if (b.dataset.group === "industry") {
        this._toggle(this.filters.industries, b.dataset.val);
      } else return;
      this._buildFilterChips();
      this._applyFilters();
    });

    root.querySelector('[data-group="lookback"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.viewState.lookback = b.dataset.lb;
      this._syncToolbar();
      this.load();
    });
    // legend is a collapsible drawer: the "Metrics" bar expands/hides it.
    // toggling resizes the grid, so re-fit the charts to the new height.
    root.querySelector(".legend-bar").addEventListener("click", () => {
      root.classList.toggle("legend-open");
      requestAnimationFrame(() => this.resizeAll());
    });
    this._syncToolbar();
  }

  _syncToolbar() {
    this.root.querySelectorAll('[data-group="lookback"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.lb === this.viewState.lookback));
  }

  onActivate() {
    if (!this.inited) { this.inited = true; this.load(); }
    else this.resizeAll();
  }
  onDeactivate() {}

  destroy() {
    for (const c of this.charts) c.destroy();
    if (this._onDocClick) document.removeEventListener("click", this._onDocClick);
    if (this.root) this.root.remove();
  }

  // ---- search ----

  _renderSearch() {
    const q = this.searchInput.value.trim().toLowerCase();
    if (!q) { this._hideSearch(); return; }
    const hits = this.stocks.filter((s) =>
      s.sym.toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q))
      .slice(0, 12);
    this._hits = hits.map((s) => s.sym);
    if (!hits.length) {
      this.searchResults.innerHTML = `<div class="esr-empty">No matches</div>`;
      this.searchResults.hidden = false;
      return;
    }
    this.searchResults.innerHTML = hits.map((s) =>
      `<div class="esr-item" data-sym="${s.sym}">` +
        `<span class="esr-sym">${s.sym}</span>` +
        `<span class="esr-name">${escapeHTML(s.name || "")}</span>` +
        `<button class="esr-details" data-sym="${s.sym}">Details</button>` +
      `</div>`).join("");
    this.searchResults.hidden = false;
    this._setActive(0);
  }

  _activeSym() {
    return (this._hits && this._activeIdx >= 0) ? this._hits[this._activeIdx] : null;
  }

  _setActive(idx) {
    const n = this._hits ? this._hits.length : 0;
    if (!n) { this._activeIdx = -1; return; }
    this._activeIdx = ((idx % n) + n) % n;
    const items = this.searchResults.querySelectorAll(".esr-item");
    items.forEach((el, i) => el.classList.toggle("active", i === this._activeIdx));
    const cur = items[this._activeIdx];
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  _hideSearch() { this.searchResults.hidden = true; this._activeIdx = -1; }

  _pickSearch(sym) {
    this.searchInput.value = sym;
    this._hideSearch();
    for (const c of this.charts) c.setHighlight(sym);
  }

  _openDetails(sym) {
    this._hideSearch();
    this.onOpenStock(sym);
  }

  async load() {
    this.statusEl.textContent = "Loading… (first build can take ~30s)";
    for (const c of this.charts) c.destroy();
    this.charts = [];
    try {
      const res = await fetch(`/api/screener?lookback=${encodeURIComponent(this.viewState.lookback)}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      this._baseStatus =
        `${json.stocks.length} stocks · ${json.lookback} · as of ${(json.asof || "").slice(0, 16).replace("T", " ")}`;
      this.statusEl.textContent = this._baseStatus;
      this._build(json.stocks);
    } catch (e) {
      this.statusEl.textContent = "Error: " + e.message;
    }
  }

  _build(stocks) {
    this.stocks = stocks;
    const { colorOf, radiusOf } = this.config.encode(stocks);
    const onHover = (sym) => { for (const c of this.charts) c.setHighlight(sym); };
    const onPick = (sym) => this.onOpenStock(sym);
    const foot = this.config.tooltipFoot;

    for (const panel of this.config.panels) {
      const tooltipHTML = (p) =>
        `<b>${p.sym}</b> <span class="muted">${indLabel(p.ind)}</span><br>` +
        `${panel.xLabel.split(" (")[0]}: ${fmt(p[panel.xKey])}<br>` +
        `${panel.yLabel.split(" —")[0].split(" (")[0]}: ${fmt(p[panel.yKey])}<br>` +
        foot(p);
      const chart = new ScatterChart(this.cells[panel.key], {
        title: panel.title, xLabel: panel.xLabel, yLabel: panel.yLabel,
        xKey: panel.xKey, yKey: panel.yKey, goodZone: panel.good,
        logX: panel.logX, logY: panel.logY, clipX: panel.clipX, clipY: panel.clipY,
        colorOf, radiusOf, tooltipHTML, onHover, onPick,
      });
      this.charts.push(chart);
    }
    this._buildFilterChips();
    this._applyFilters();
    this.resizeAll();
  }

  // ---- filters ----

  _toggle(set, val) { set.has(val) ? set.delete(val) : set.add(val); }

  _buildFilterChips() {
    const f = this.filters;
    const exch = [...new Set(this.stocks.map((s) => s.exchange).filter(Boolean))].sort();
    const inds = [...new Set(this.stocks.map((s) => s.ind).filter(Boolean))].sort();
    const chip = (group, val, label, title, active) =>
      `<button class="ef-chip${active ? " active" : ""}" data-group="${group}" ` +
      `data-val="${escapeHTML(val)}"${title ? ` title="${escapeHTML(title)}"` : ""}>${escapeHTML(label)}</button>`;
    const grp = (label, chips) =>
      `<span class="ef-group"><span class="ef-label">${label}</span>${chips.join("")}</span>`;

    let html = "";
    if (exch.length)
      html += grp("Exchange", exch.map((e) => chip("exchange", e, e, "", f.exchanges.has(e))));
    if (inds.length)
      html += grp("Industry", inds.map((i) =>
        chip("industry", i, i, IND_LABEL[i] || i, f.industries.has(i))));
    html += `<span class="ef-group">` +
      `<button class="ef-chip ef-mag7${f.mag7 ? " active" : ""}" data-mag7="1" ` +
      `title="Magnificent 7: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA">MAG7</button>` +
      `<button class="ef-chip ef-prof${f.profitable ? " active" : ""}" data-prof="1" ` +
      `title="Only stocks with positive trailing earnings">Profitable</button></span>`;
    const any = f.exchanges.size || f.industries.size || f.profitable || f.mag7;
    if (any) html += `<button class="ef-clear" data-clear="1">Clear ✕</button>`;
    this.filtersEl.innerHTML = html;
  }

  _matches(s) {
    const f = this.filters;
    if (f.exchanges.size && !f.exchanges.has(s.exchange)) return false;
    if (f.industries.size && !f.industries.has(s.ind)) return false;
    if (f.profitable && !s.profitable) return false;
    if (f.mag7 && !MAG7.has(s.sym)) return false;
    return true;
  }

  _applyFilters() {
    const shown = this.stocks.filter((s) => this._matches(s));
    for (const c of this.charts) c.setData(shown);
    if (this._baseStatus) {
      this.statusEl.textContent = shown.length === this.stocks.length
        ? this._baseStatus
        : `${shown.length} of ${this._baseStatus}`;
    }
  }

  resizeAll() { for (const c of this.charts) c.resize(); }
}

// back-compat alias (main.js used to import ExplorePane)
export const ExplorePane = ScreenerPane;

function fmt(v) { return v == null ? "—" : (Math.round(v * 100) / 100).toString(); }

function fmtCap(v) {
  if (v == null || !(v > 0)) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v}`;
}

function escapeHTML(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
