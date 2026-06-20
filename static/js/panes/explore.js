"use strict";

// Explore pane: a 2x2 of linked scatter panels driven by /api/screener.
// Global encodings across all four panels: color = drift, size = volatility.
// Hover cross-highlights the same stock everywhere; double-click opens its pane.

import { ScatterChart } from "../scatter.js";

// diverging drift color: red (downtrend) -> yellow (flat=good) -> green (uptrend)
const RED = [236, 138, 130], YEL = [230, 210, 120], GREEN = [137, 201, 150];
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

function pct(arr, q) {
  const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.floor((a.length - 1) * q)];
}

const PANELS = [
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
    good: { x: [0, null], y: [0, null] },                   // top-right = both growing
    clipX: [-100, 100], clipY: [-100, 100] },               // snap outliers to the rail
  { key: "value", title: "[R3-R] Valuation (log-log)", xKey: "ps", yKey: "pe",
    xLabel: "P/S (trailing, log)", yLabel: "P/E (trailing, log; profitable only)",
    good: { x: [null, 5], y: [null, 20] }, logX: true, logY: true },                // bottom-left = cheap
];

const LOOKBACKS = ["1y", "3y", "5y"];

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

export class ExplorePane {
  constructor(opts = {}) {
    this.id = "explore";
    this.type = "explore";
    this.title = "Explore";
    this.closable = false;
    this.onOpenStock = opts.onOpenStock || (() => {});
    this.viewState = { lookback: "3y" };   // in-memory, resets on reload
    this.filters = { exchanges: new Set(), industries: new Set(), profitable: false };
    this.charts = [];
    this.inited = false;
  }

  mount(container) {
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
        <div class="explore-cell" data-cell="tl"></div>
        <div class="explore-cell" data-cell="tr"></div>
        <div class="explore-cell" data-cell="bl"></div>
        <div class="explore-cell" data-cell="br"></div>
        <div class="explore-cell" data-cell="growth"></div>
        <div class="explore-cell" data-cell="value"></div>
      </main>
      <footer class="explore-legend">
        <div class="legend-grid">
          <p><b>Volatility</b> <i>(dot size)</i> — annualized stdev of daily returns: how big the swings are.</p>
          <p><b>Drift</b> <i>(dot color)</i> — trend fit: green = flat (ideal), red = steep (falling-knife or at-ATH).</p>
          <p><b>Upswings</b> <i>(TL&nbsp;x)</i> — count of confirmed ≥40% low→high reversals: how often it round-trips.</p>
          <p><b>R²</b> <i>(TL&nbsp;y)</i> — line-fit of log-price: low = choppy (good to swing), high = clean trend.</p>
          <p><b>Win rate</b> <i>(TR&nbsp;x)</i> — fraction of backtested trades closing positive (+40% TP / −40% SL / 6mo).</p>
          <p><b>Avg return</b> <i>(TR&nbsp;y)</i> — mean return per backtested trade under that rule.</p>
          <p><b>% below 52-week high</b> <i>(BR&nbsp;y)</i> — distance under the 1-year peak: the ripeness signal.</p>
          <p><b>% above historic low</b> <i>(BL&nbsp;x)</i> — distance above the multi-year low; with below-high it sums to the full range.</p>
          <p><b>% below historic high</b> <i>(BL&nbsp;y)</i> — drawdown from the multi-year peak; stands in for valuation until backfill.</p>
          <p><b>Idiosyncratic z</b> <i>(BR&nbsp;x)</i> — return minus its industry-ETF move, in σ: negative = fell on its own.</p>
          <p><b>Industry</b> <i>(tooltip)</i> — the sector ETF each stock is benchmarked against (e.g. SOXX, IGV).</p>
          <p><b>Revenue growth</b> <i>(R3-L&nbsp;x)</i> — trailing YoY sales growth.</p>
          <p><b>Earnings growth</b> <i>(R3-L&nbsp;y)</i> — trailing YoY earnings growth (profitable names only).</p>
          <p><b>P/S</b> <i>(R3-R&nbsp;x)</i> — price/sales; lower = cheaper (defined for all).</p>
          <p><b>P/E</b> <i>(R3-R&nbsp;y)</i> — price/earnings; lower = cheaper (profitable only — negative dropped).</p>
        </div>
      </footer>
      <button class="legend-toggle" aria-label="What do these mean?">?</button>`;
    container.appendChild(root);
    this.root = root;
    this.statusEl = root.querySelector(".status");
    this.searchInput = root.querySelector(".explore-search-input");
    this.searchResults = root.querySelector(".explore-search-results");
    this.filtersEl = root.querySelector(".explore-filters");
    this.stocks = [];
    this.cells = {};
    for (const p of PANELS) this.cells[p.key] = root.querySelector(`[data-cell="${p.key}"]`);

    this.searchInput.addEventListener("input", () => this._renderSearch());
    this.searchInput.addEventListener("focus", () => this._renderSearch());
    this.searchInput.addEventListener("keydown", (e) => {
      const open = !this.searchResults.hidden && this._hits && this._hits.length;
      if (e.key === "ArrowDown") {
        if (open) { e.preventDefault(); this._setActive(this._activeIdx + 1); }
      } else if (e.key === "ArrowUp") {
        if (open) { e.preventDefault(); this._setActive(this._activeIdx - 1); }
      } else if (e.key === " " || e.key === "Spacebar") {
        // space = highlight the dots across all panels, then close
        const sym = this._activeSym();
        if (open && sym) { e.preventDefault(); this._pickSearch(sym); }
      } else if (e.key === "Enter") {
        // enter = open the stock detail page
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
    // click outside the search box dismisses the dropdown
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
      } else if (b.dataset.prof) {
        this.filters.profitable = !this.filters.profitable;
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
    // mobile: the "?" toggles the legend as a bottom sheet; tapping it dismisses
    root.querySelector(".legend-toggle").addEventListener("click", () =>
      root.classList.toggle("legend-open"));
    root.querySelector(".explore-legend").addEventListener("click", () =>
      root.classList.remove("legend-open"));
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
    this._setActive(0);   // first result selected by default for keyboard nav
  }

  _activeSym() {
    return (this._hits && this._activeIdx >= 0) ? this._hits[this._activeIdx] : null;
  }

  _setActive(idx) {
    const n = this._hits ? this._hits.length : 0;
    if (!n) { this._activeIdx = -1; return; }
    this._activeIdx = ((idx % n) + n) % n;   // wrap around top/bottom
    const items = this.searchResults.querySelectorAll(".esr-item");
    items.forEach((el, i) => el.classList.toggle("active", i === this._activeIdx));
    const cur = items[this._activeIdx];
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  _hideSearch() { this.searchResults.hidden = true; this._activeIdx = -1; }

  // selecting a result highlights its dot across every panel (like a hover)
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
      this._build(json.stocks);   // builds charts, chips, and applies current filters
    } catch (e) {
      this.statusEl.textContent = "Error: " + e.message;
    }
  }

  _build(stocks) {
    this.stocks = stocks;   // keep for the search box
    // global encodings: drift color + volatility size, shared across all panels.
    // color = how IDEAL the drift is: green = flat (sweet spot), red = steep
    // (falling-knife OR at-ATH). So green = good everywhere.
    const dlo = Math.min(pct(stocks.map((s) => s.drift), 0.05), -0.1);
    const dhi = Math.max(pct(stocks.map((s) => s.drift), 0.95), 0.1);
    const dscale = Math.max(Math.abs(dlo), Math.abs(dhi), 0.1);
    const vlo = pct(stocks.map((s) => s.vol), 0.05);
    const vhi = pct(stocks.map((s) => s.vol), 0.95);

    const colorOf = (p) => {
      if (p.drift == null) return "rgba(154,160,166,0.7)";
      const g = clamp01(1 - Math.abs(p.drift) / dscale);   // 1 = flat = green, 0 = steep = red
      const c = g < 0.5 ? mix(RED, YEL, g * 2) : mix(YEL, GREEN, (g - 0.5) * 2);
      return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},0.85)`;
    };
    const radiusOf = (p) => {
      const v = p.vol == null ? vlo : p.vol;
      return 4 + 12 * clamp01(vhi > vlo ? (v - vlo) / (vhi - vlo) : 0.5);
    };

    const onHover = (sym) => { for (const c of this.charts) c.setHighlight(sym); };
    const onPick = (sym) => this.onOpenStock(sym);

    for (const panel of PANELS) {
      const tooltipHTML = (p) =>
        `<b>${p.sym}</b> <span class="muted">${indLabel(p.ind)}</span><br>` +
        `${panel.xLabel.split(" (")[0]}: ${fmt(p[panel.xKey])}<br>` +
        `${panel.yLabel.split(" —")[0].split(" (")[0]}: ${fmt(p[panel.yKey])}<br>` +
        `vol ${fmt(p.vol)}% · drift ${fmt(p.drift)}%/yr`;
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
      `<button class="ef-chip ef-prof${f.profitable ? " active" : ""}" data-prof="1" ` +
      `title="Only stocks with positive trailing earnings">Profitable</button></span>`;
    const any = f.exchanges.size || f.industries.size || f.profitable;
    if (any) html += `<button class="ef-clear" data-clear="1">Clear ✕</button>`;
    this.filtersEl.innerHTML = html;
  }

  _matches(s) {
    const f = this.filters;
    if (f.exchanges.size && !f.exchanges.has(s.exchange)) return false;
    if (f.industries.size && !f.industries.has(s.ind)) return false;
    if (f.profitable && !s.profitable) return false;
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

function fmt(v) { return v == null ? "—" : (Math.round(v * 100) / 100).toString(); }

function escapeHTML(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
