"use strict";

// Factors pane: the 3-factor model (market / industry / momentum) over the
// universe, as a screener-style view (same toolbar: 1Y/3Y/5Y + search + filter
// chips). Layout:
//   - factor strip: raw performance of the factors-as-tickers
//     (SPY, MTUM, and a dropdown-selected industry ETF)
//   - 2x2 coefficient scatters, alpha on the y-axis everywhere:
//     alpha vs b_mkt | alpha vs b_ind | alpha vs b_mom | alpha vs R^2
//   - click a dot -> reconstruction drawer: the stock's cumulative return vs
//     the factor-fitted sum (alpha + b*factors), with each contribution as a
//     line and the actual-vs-fitted gap shaded purple (the residual).

import { ScreenerPane, clamp01, rgbaFor, GREY, fmt } from "./explore.js";
import { escapeHTML, indLabel } from "../filters.js";
import { getFactorsDetail } from "../api.js";
import { renderDecomp } from "../decomp.js";
import { fmtCap } from "../util.js";

const PANELS = [
  { key: "amkt", title: "[TL] α vs market β", xKey: "b_mkt", yKey: "alpha",
    xLabel: "β market (SPY, clipped −1…3)", yLabel: "α (%/yr, clipped ±80)",
    good: { x: [null, null], y: [0, null] }, clipX: [-1, 3], clipY: [-80, 80] },
  { key: "aind", title: "[TR] α vs industry β", xKey: "b_ind", yKey: "alpha",
    xLabel: "β industry ETF (orthogonalized, clipped −2…4)", yLabel: "α (%/yr, clipped ±80)",
    good: { x: [null, null], y: [0, null] }, clipX: [-2, 4], clipY: [-80, 80] },
  { key: "amom", title: "[BL] α vs momentum β", xKey: "b_mom", yKey: "alpha",
    xLabel: "β momentum (MTUM, orthogonalized, clipped ±3)", yLabel: "α (%/yr, clipped ±80)",
    good: { x: [null, null], y: [0, null] }, clipX: [-3, 3], clipY: [-80, 80] },
  { key: "ar2", title: "[BR] α vs R² ★ own-thing winners", xKey: "r2", yKey: "alpha",
    xLabel: "R² (%): how much the factors explain", yLabel: "α (%/yr, clipped ±80)",
    good: { x: [null, 40], y: [0, null] }, clipY: [-80, 80] },
];

function factorsEncode(stocks) {
  // color = idio z (red = off-to-downside vs factors, green = upside)
  // size = market cap (log), like Invest
  const caps = stocks.map((s) => s.mktcap).filter((x) => x > 0).map(Math.log);
  const cLo = caps.length ? Math.min(...caps) : 0;
  const cHi = caps.length ? Math.max(...caps) : 1;
  return {
    colorOf: (p) => p.idio_z == null ? GREY : rgbaFor(clamp01((p.idio_z + 2.5) / 5)),
    radiusOf: (p) =>
      (!(p.mktcap > 0) || cHi <= cLo) ? 1.5 : 1 + 3 * clamp01((Math.log(p.mktcap) - cLo) / (cHi - cLo)),
  };
}

const LEGEND = [
  ["α (alpha)", "all&nbsp;y", "annualized return the factors can't explain — descriptive, not predictive."],
  ["β market", "TL&nbsp;x", "sensitivity to SPY: 1 = moves with the market, 2 = twice as hard."],
  ["β industry", "TR&nbsp;x", "loading on its industry ETF after the market is stripped out."],
  ["β momentum", "BL&nbsp;x", "loading on the momentum factor (MTUM, market-stripped) — global factor, per-stock loading."],
  ["R²", "BR&nbsp;x", "% of daily variance explained by the 3 factors: right = index-like, left = its own thing."],
  ["Idio z", "dot color", "20-day residual z-score: red = fell on its own, green = rose on its own."],
  ["Market cap", "dot size", "company size (log scale)."],
  ["Reconstruction", "click a dot", "actual return vs α + Σβ·factor; the purple gap is the unexplained residual."],
];

const FACTORS_CONFIG = {
  id: "factors", type: "factors", title: "Factors",
  panels: PANELS, encode: factorsEncode, legend: LEGEND,
  tooltipFoot: (p) => `α ${fmt(p.alpha)}%/yr · R² ${fmt(p.r2)}% · idio-z ${fmt(p.idio_z)}`,
  endpoint: (lb) => `/api/factors/table?lookback=${lb}`,
  onPick: (pane, sym) => pane.showDetail(sym),
  afterLoad: (pane, json) => { pane._renderStrip(json.strip || []); pane._restoreDetail(); },
};

const DETAIL_KEY = "factors.detail";   // remember the open reconstruction across reloads

// Table-view explainer drawer: per-column meaning + how the metrics relate.
const TABLE_HELP =
  `<p class="lg-wide"><b>The model.</b> Each day, a stock's return is split into a part the ` +
  `factors explain and a leftover: <i>return = α + β·SPY + β·(industry ETF) + β·MTUM + ε</i>. ` +
  `Every column below reads a different piece of that fit (daily log returns over the chosen lookback).</p>` +
  `<p><b>α (alpha) %/yr</b> <i>column</i> — the <b>level</b> of the leftover: average return the ` +
  `factors can't explain, annualized. + = beat its own factor exposure, − = lagged it. Descriptive, not predictive.</p>` +
  `<p><b>R²</b> <i>column</i> — % of the stock's daily <b>variance</b> the 3 factors explain. ` +
  `High = index-like (little of its own); low = "its own thing".</p>` +
  `<p><b>β market</b> <i>column</i> — sensitivity to SPY. 1 = moves with the market, 2 = twice as hard, &lt;0 = inverse.</p>` +
  `<p><b>idio z</b> <i>column</i> — the <b>recent direction</b> of the leftover: last ~20 days of residual, ` +
  `in standard deviations. green + = rising on its own, red − = falling on its own.</p>` +
  `<p><b>β industry</b> <i>column</i> — loading on its sector ETF <i>after the market is removed</i> ` +
  `(orthogonalized, so it isn't double-counting market beta).</p>` +
  `<p><b>β momentum</b> <i>column</i> — loading on the momentum factor (MTUM, market removed). ` +
  `The factor is global; only the loading is per-stock.</p>` +
  `<p><b>β mkt / ind / mom</b> <i>note</i> — all three are the same fit's slopes; together with α they rebuild ` +
  `the "fitted" line in the reconstruction chart. <b>Mkt cap</b> is just company size.</p>` +
  `<p class="lg-wide"><b>How they relate.</b> α, R² and idio z all come from the <i>same</i> regression but read ` +
  `different aspects. <b>R² sets the stage</b>: high R² → the leftover ε is a thin sliver, so α and idio z ` +
  `describe only a small part of the move (take with salt); low R² → big leftover, where α and idio z carry the ` +
  `real company-specific signal. <b>α vs idio z</b> differ in horizon: α is the <i>average</i> leftover over the ` +
  `whole window, idio z is how it has moved <i>lately</i> — so they can disagree (α +, idio z − = "won over the ` +
  `year, but its edge is reversing now"). <b>α (a level) and R² (a variance share) are independent</b> — strong ` +
  `α can pair with either high or low R².</p>` +
  `<p class="lg-wide"><b>Reading the row (R² → α → idio z).</b> ` +
  `high R², α≈0, z≈0 = pure factor play (a leveraged market/sector bet) · ` +
  `low R², α+, z+ = its own thing, winning, still winning · ` +
  `low R², α+, z− = won on its own but reversing · ` +
  `low R², α−, z− = bleeding idiosyncratically · ` +
  `high R², big z = factors explain the bulk, small recent blip stands out. ` +
  `The α-vs-R² scatter encodes all three: x = R², y = α, dot color = idio z.</p>`;

function sparkSVG(vals, w = 220, h = 52) {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return "";
  const mn = Math.min(...v), mx = Math.max(...v);
  const span = mx - mn || 1;
  const pts = vals.map((x, i) =>
    x == null ? null : `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 2 - (x - mn) / span * (h - 4)).toFixed(1)}`)
    .filter(Boolean).join(" ");
  const up = v[v.length - 1] >= v[0];
  // stretches with the card so the strip fills the full pane width
  return `<svg class="fs-spark" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="${up ? "#89c996" : "#ec8a82"}" stroke-width="1.5"` +
    ` vector-effect="non-scaling-stroke"/></svg>`;
}

export class FactorsPane extends ScreenerPane {
  constructor(opts = {}) {
    super({ ...opts, config: FACTORS_CONFIG });
  }

  mount(container) {
    super.mount(container);
    this.root.classList.add("factors-pane");   // 2x2 grid (base is 3x2)
    // Charts | Table view toggle, next to the lookback buttons
    const tb = this.root.querySelector(".toolbar");
    const vg = document.createElement("div");
    vg.className = "ranges";
    vg.dataset.group = "fview";
    vg.innerHTML = `<button data-view="charts">Charts</button><button data-view="table">Table</button>`;
    tb.insertBefore(vg, tb.querySelector(".explore-search"));
    vg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.viewState.view = b.dataset.view;
      this._syncView();
    });
    // factor strip between the filter chips and the scatter grid
    this.stripEl = document.createElement("div");
    this.stripEl.className = "factor-strip";
    this.root.insertBefore(this.stripEl, this.root.querySelector(".explore-grid"));
    // sortable table (the "Table" view; Earnings-style rows)
    this.tableEl = document.createElement("div");
    this.tableEl.className = "factors-table";
    this.tableEl.hidden = true;
    this.root.insertBefore(this.tableEl, this.root.querySelector(".explore-legend"));
    this._sort = { key: "alpha", dir: -1 };
    this.tableEl.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (th) {
        const k = th.dataset.sort;
        const str = k === "sym" || k === "name" || k === "ind";
        if (this._sort.key === k) this._sort.dir *= -1;
        else this._sort = { key: k, dir: str ? 1 : -1 };
        this._renderTable();
        return;
      }
      const row = e.target.closest(".ft-row[data-sym]");
      if (row) this.showDetail(row.dataset.sym);
    });
    // reconstruction drawer between the table and the legend footer
    this.drawerEl = document.createElement("div");
    this.drawerEl.className = "factors-drawer";
    this.drawerEl.hidden = true;
    this.root.insertBefore(this.drawerEl, this.root.querySelector(".explore-legend"));
    // Table-view explainer drawer (collapsible, like the charts "Metrics" bar)
    this.tableLegendEl = document.createElement("footer");
    this.tableLegendEl.className = "explore-legend table-legend";
    this.tableLegendEl.hidden = true;
    this.tableLegendEl.innerHTML =
      `<button class="legend-bar" type="button">What the columns mean <span class="legend-caret">▴</span></button>` +
      `<div class="legend-grid">${TABLE_HELP}</div>`;
    this.tableLegendEl.querySelector(".legend-bar").addEventListener("click", () => {
      this.root.classList.toggle("legend-open");
    });
    this.root.appendChild(this.tableLegendEl);
    this._stripInd = null;      // selected industry ETF in the strip
    this._detailSym = null;
    this._decomp = null;        // renderDecomp handle for the drawer
    this.viewState.view = "charts";
    this._syncView();
  }

  _syncView() {
    const table = this.viewState.view === "table";
    this.root.querySelectorAll('[data-group="fview"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.view === (table ? "table" : "charts")));
    this.root.querySelector(".explore-grid").style.display = table ? "none" : "";
    // each view shows its own explainer footer; the other is hidden
    this.root.querySelector(".explore-legend:not(.table-legend)").style.display = table ? "none" : "";
    this.tableLegendEl.hidden = !table;
    this.tableEl.hidden = !table;
    if (table) {
      this._renderTable();
      // if a reconstruction is open below, jump to (and highlight) its row
      if (this._detailSym) {
        const row = this.tableEl.querySelector(`.ft-row[data-sym="${this._detailSym}"]`);
        if (row) row.scrollIntoView({ block: "center" });
      }
    } else {
      requestAnimationFrame(() => this.resizeAll());
    }
  }

  // ---- table view (Earnings look & feel: bordered rows, hover, sticky head) ----

  _renderTable() {
    if (!this.tableEl || this.tableEl.hidden || !this.stocks) return;
    const cols = [
      ["sym", "Ticker"], ["name", "Name"], ["ind", "Industry"],
      ["alpha", "α %/yr"], ["b_mkt", "β mkt"], ["b_ind", "β ind"], ["b_mom", "β mom"],
      ["r2", "R²"], ["idio_z", "idio z"], ["mktcap", "Mkt cap"],
    ];
    const { key, dir } = this._sort;
    const str = key === "sym" || key === "name" || key === "ind";
    const rows = this.stocks.filter((s) => this._matches(s)).sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;                       // nulls last, either direction
      if (vb == null) return -1;
      return dir * (str ? String(va).localeCompare(String(vb)) : va - vb);
    });
    const arrow = (k) => k === key ? (dir > 0 ? " ▲" : " ▼") : "";
    const num = (v, digits, cls = "") =>
      `<span class="ft-num ${cls}">${v == null ? "—" : v.toFixed(digits)}</span>`;
    const head = `<div class="ft-head">` + cols.map(([k, label]) =>
      `<span data-sort="${k}"${k === key ? ' class="on"' : ""}>${label}${arrow(k)}</span>`).join("") + `</div>`;
    const body = rows.map((s) => {
      const active = s.sym === this._detailSym ? " active" : "";
      return `<div class="ft-row${active}" data-sym="${s.sym}">` +
        `<span class="ft-sym">${s.sym}</span>` +
        `<span class="ft-name">${escapeHTML(s.name || "")}</span>` +
        `<span class="ft-ind" title="${escapeHTML(indLabel(s.ind))}">${escapeHTML(s.ind || "")}</span>` +
        num(s.alpha, 1, s.alpha != null ? (s.alpha >= 0 ? "up" : "down") : "") +
        num(s.b_mkt, 2) + num(s.b_ind, 2) + num(s.b_mom, 2) +
        num(s.r2, 0) +
        num(s.idio_z, 2, s.idio_z != null ? (s.idio_z >= 0 ? "up" : "down") : "") +
        `<span class="ft-num">${s.mktcap != null ? "$" + fmtCap(s.mktcap) : "—"}</span>` +
      `</div>`;
    }).join("");
    this.tableEl.innerHTML = head + body +
      (rows.length ? "" : `<div class="fd-loading">No stocks match the filters.</div>`);
  }

  // ---- factor strip ----

  _renderStrip(strip) {
    this._stripData = strip;
    const byKey = {};
    for (const s of strip) byKey[s.key] = s;
    const inds = strip.filter((s) => s.kind === "ind");
    if (!this._stripInd || !byKey[this._stripInd]) {
      this._stripInd = inds.length ? inds[0].key : null;
    }
    const card = (s) => s ? (
      `<div class="fs-card">` +
        `<span class="fs-label">${escapeHTML(s.label)} <b>${s.key}</b></span>` +
        sparkSVG(s.spark || []) +
        `<span class="fs-ret ${s.ret >= 0 ? "up" : "down"}">${s.ret >= 0 ? "+" : ""}${fmt(s.ret)}%</span>` +
      `</div>`) : "";
    this.stripEl.innerHTML =
      `<div class="fs-cards">` +
        card(byKey["SPY"]) + card(byKey["MTUM"]) + card(byKey[this._stripInd] || null) +
      `</div>`;
    this._syncIndSelect();
  }

  // the industry-factor selector lives in the filter-chips row (right-aligned);
  // that row is re-rendered on every filter click, so (re)inject it here
  _syncIndSelect() {
    const inds = (this._stripData || []).filter((s) => s.kind === "ind");
    if (!inds.length || !this.filtersEl) return;
    let wrap = this.filtersEl.querySelector(".fs-selwrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "fs-selwrap";
      this.filtersEl.appendChild(wrap);
    }
    wrap.innerHTML =
      `<span class="ef-label">Factor</span>` +
      `<select class="fs-ind-select" title="Industry factor to display">` +
      inds.map((s) => `<option value="${s.key}"${s.key === this._stripInd ? " selected" : ""}>` +
        `${escapeHTML(s.label)} (${s.key})</option>`).join("") +
      `</select>`;
    wrap.querySelector("select").addEventListener("change", (e) => {
      this._stripInd = e.target.value;
      this._renderStrip(this._stripData);
    });
  }

  _buildFilterChips() {
    super._buildFilterChips();   // wipes the row -> re-add the selector
    this._syncIndSelect();
  }

  _applyFilters() {
    super._applyFilters();
    this._renderTable();         // the table view follows the same filters
  }

  _pickSearch(sym) {
    super._pickSearch(sym);      // highlight on the scatters
    if (this.viewState.view === "table") {
      const row = this.tableEl.querySelector(`.ft-row[data-sym="${sym}"]`);
      if (row) row.scrollIntoView({ block: "center" });
    }
  }

  // reopen the reconstruction that was open before the reload / lookback switch
  _restoreDetail() {
    const sym = this._detailSym || localStorage.getItem(DETAIL_KEY);
    if (sym && this.stocks.some((s) => s.sym === sym)) this.showDetail(sym);
  }

  // ---- reconstruction drawer ----

  async showDetail(sym) {
    this._detailSym = sym;
    localStorage.setItem(DETAIL_KEY, sym);
    this.drawerEl.hidden = false;
    this.drawerEl.innerHTML = `<div class="fd-loading">Loading ${escapeHTML(sym)}…</div>`;
    this.resizeAll();
    let d;
    try {
      d = await getFactorsDetail(sym, this.viewState.lookback);
    } catch (e) {
      this.drawerEl.innerHTML = `<div class="fd-loading">${escapeHTML(e.message)}</div>`;
      return;
    }
    if (this._detailSym !== sym) return;   // user clicked another dot meanwhile
    for (const c of this.charts) c.setHighlight(sym);   // ring it on the scatters
    // the strip's industry card follows the stock being inspected
    if (d.etf && d.etf !== this._stripInd && this._stripData) {
      this._stripInd = d.etf;
      this._renderStrip(this._stripData);
    }
    if (this._decomp) { this._decomp.destroy(); this._decomp = null; }
    this._decomp = renderDecomp(this.drawerEl, d, { onClose: () => this._closeDetail() });
    // mark the open stock's row in the table view
    this.tableEl.querySelectorAll(".ft-row.active").forEach((r) => r.classList.remove("active"));
    const row = this.tableEl.querySelector(`.ft-row[data-sym="${sym}"]`);
    if (row) row.classList.add("active");
    this.resizeAll();
  }

  _closeDetail() {
    this._detailSym = null;
    localStorage.removeItem(DETAIL_KEY);
    if (this._decomp) { this._decomp.destroy(); this._decomp = null; }
    this.drawerEl.hidden = true;
    this.drawerEl.innerHTML = "";
    this.resizeAll();
  }

  resizeAll() {
    super.resizeAll();
    if (this._decomp) this._decomp.resize();
  }

  destroy() {
    if (this._decomp) this._decomp.destroy();
    super.destroy();
  }
}
