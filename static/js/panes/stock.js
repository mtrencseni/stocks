"use strict";

// Per-stock detail pane (opened by double-clicking a card on the Stocks pane).
// A synced 1x3: Price / P/E / P/S for the one symbol, sharing the range toggle
// and a single crosshair group (the tooltip is synced across all three).

import { getHistory, getStats, getProfile, getFinancials } from "../api.js";
import { buildCard, renderCard, renderZigzag, renderQuarterly, CrosshairGroup } from "../chart.js";
import { statsHTML, fmtMoneyM, fmtPrice } from "../util.js";

function escapeHTML(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function escapeAttr(s) { return escapeHTML(s).replace(/"/g, "&quot;"); }

function earningsHTML(e) {
  if (!e) return "";
  const rows = [];
  if (e.next && e.next.date) {
    const days = Math.ceil((new Date(e.next.date + "T00:00:00") - Date.now()) / 86400000);
    const when = days >= 0 ? `in ${days}d` : `${Math.abs(days)}d ago`;
    const est = e.next.estimated ? " (est.)" : "";
    rows.push(`<div class="si-earn-row"><span class="k">Next report</span>` +
      `<span class="v">${e.next.date} · ${when}${est}</span></div>`);
  } else {
    rows.push(`<div class="si-earn-row"><span class="k">Next report</span><span class="v">—</span></div>`);
  }
  for (const r of (e.past || []).slice(0, 4)) {
    const cls = r.beat == null ? "" : r.beat ? "up" : "down";
    const tag = r.beat == null ? "·" : r.beat ? "beat" : "miss";
    const sur = r.surprisePct == null ? "" : ` ${r.surprisePct >= 0 ? "+" : ""}${r.surprisePct.toFixed(1)}%`;
    rows.push(`<div class="si-earn-row"><span class="k">${r.date}</span>` +
      `<span class="v ${cls}">${tag}${sur}</span></div>`);
  }
  return rows.join("");
}

const ZZ_RANGE = "3y";   // the zigzag row is static at this lookback

const METRICS = [
  { key: "price", label: "Price" },
  { key: "pe", label: "P/E" },
  { key: "ps", label: "P/S" },
];
const FINANCIALS = [
  { key: "revenue", label: "Quarterly Sales (Revenue)" },
  { key: "netIncome", label: "Quarterly Net Income" },
];
const RANGES = ["1d", "1w", "1mo", "3mo", "6mo", "1y", "3y", "5y"];
const RANGE_LABEL = {
  "1d": "1D", "1w": "1W", "1mo": "1M", "3mo": "3M",
  "6mo": "6M", "1y": "1Y", "3y": "3Y", "5y": "5Y",
};

export class StockPane {
  constructor({ symbol }) {
    this.symbol = symbol;
    this.id = "stock:" + symbol;
    this.type = "stock";
    this.title = symbol;
    this.closable = true;
    this.viewState = { range: "1y" };   // in-memory, resets on reload
    this.cross = new CrosshairGroup();  // synced crosshair across the 3 charts
    this.cards = [];
    this.profileData = null;
    this.statsData = null;
    this.earningsData = null;
    this.finData = null;
    this.finEls = {};
    this.inited = false;
  }

  mount(container) {
    const root = document.createElement("div");
    root.className = "pane";
    root.innerHTML = `
      <section class="stock-info"></section>
      <header class="toolbar">
        <div class="ranges" data-group="ranges">
          ${RANGES.map((r) => `<button data-range="${r}">${RANGE_LABEL[r]}</button>`).join("")}
        </div>
        <div class="tb-right"><span class="status"></span></div>
      </header>
      <main class="grid detail-grid"></main>`;
    container.appendChild(root);
    this.root = root;
    this.infoEl = root.querySelector(".stock-info");
    this.grid = root.querySelector(".grid");
    this.statusEl = root.querySelector(".status");

    root.querySelector('[data-group="ranges"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) this.fetchAll(b.dataset.range);
    });
  }

  _syncToolbar() {
    this.root.querySelectorAll('[data-group="ranges"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.range === this.viewState.range));
  }

  onActivate() {
    if (!this.inited) {
      this.inited = true;
      // 6-col grid: row 1 = 3 metric charts (span 2 = thirds); row 2 = quarterly
      // sales + net income (span 3 = halves); row 3 = the static zigzag (full).
      this.grid.style.gridTemplateColumns = "repeat(6, 1fr)";
      this.grid.style.gridTemplateRows = "1fr 1fr 1fr";
      for (const m of METRICS) {
        const card = buildCard(`${this.symbol} · ${m.label}`);
        card.el.style.gridColumn = "span 2";
        const sd = card.el.querySelector(".stats");   // stats live in the header now
        if (sd) sd.remove();
        this.grid.appendChild(card.el);
        this.cards.push(card);
      }
      // quarterly financials: each chart shows point-quarterly bars + a TTM line
      for (const f of FINANCIALS) {
        const el = document.createElement("div");
        el.className = "card";
        el.style.gridColumn = "span 3";
        el.innerHTML =
          `<div class="card-head"><span class="sym">${this.symbol} · ${f.label}</span>` +
          `<span class="fin-sub"></span></div><div class="chart"></div>`;
        this.grid.appendChild(el);
        this.finEls[f.key] = { card: el, chartEl: el.querySelector(".chart"),
                               sub: el.querySelector(".fin-sub"), chart: null };
      }
      const zel = document.createElement("div");
      zel.className = "card";
      zel.style.gridColumn = "1 / -1";
      zel.innerHTML =
        `<div class="card-head"><span class="sym">${this.symbol} · Upswings (3y, ≥40%)</span></div>` +
        `<div class="chart"></div>`;
      this.grid.appendChild(zel);
      this.zzEl = zel.querySelector(".chart");

      this.fetchAll(this.viewState.range);
      this.fetchStats();
      this.fetchProfile();
      this.fetchFinancials();
      this.loadZigzag();
    }
    this.resizeAll();
  }
  onDeactivate() {}

  destroy() {
    for (const c of this.cards) if (c.chart) c.chart.destroy();
    for (const k in this.finEls) if (this.finEls[k].chart) this.finEls[k].chart.destroy();
    if (this.zzChart) this.zzChart.destroy();
    if (this.root) this.root.remove();
  }

  async loadZigzag() {
    try {
      const s = await getHistory(ZZ_RANGE, "price", [this.symbol]);
      const series = s[this.symbol];
      if (!series || !series.c) return;
      this.zzSeries = series;
      this._drawZigzag();
    } catch (e) { /* best-effort; the metric charts still work */ }
  }

  // (re)draw the zigzag with whatever we have; earnings markers appear once the
  // profile fetch fills earningsData (re-render triggered from fetchProfile).
  _drawZigzag() {
    if (!this.zzSeries || !this.zzEl) return;
    if (this.zzChart) this.zzChart.destroy();
    this.zzChart = renderZigzag(this.zzEl, this.zzSeries.t, this.zzSeries.c, this.earningsData);
  }

  async fetchAll(range) {
    this.viewState.range = range;
    this._syncToolbar();
    this.statusEl.textContent = "Loading…";
    this.cross.reset();
    try {
      // one history call per metric (the endpoint takes a single metric)
      const results = await Promise.all(METRICS.map((m) =>
        getHistory(range, m.key, [this.symbol])
          .then((s) => s[this.symbol]).catch(() => null)));
      this.cross.cards = [];
      METRICS.forEach((m, i) => {
        renderCard(this.cards[i], {
          range, metric: m.key, series: results[i], yRange: null, group: this.cross,
        });
        this.cross.cards.push(this.cards[i]);
      });
      this.cross.renderAll();
      // latest price = last non-null close of the price series (for the header)
      const ps = results[0];
      if (ps && ps.c) {
        const v = ps.c.filter((x) => x != null);
        this.lastPrice = v.length ? v[v.length - 1] : null;
        this.renderInfo();
      }
      this.statusEl.textContent = "";
    } catch (e) {
      this.statusEl.textContent = "Error: " + e.message;
    }
  }

  async fetchStats() {
    try {
      const stats = await getStats([this.symbol]);
      this.statsData = stats[this.symbol];
      this.renderInfo();
    } catch (e) { /* best-effort */ }
  }

  async fetchProfile() {
    try {
      const res = await getProfile(this.symbol);
      this.profileData = res.profile;
      this.earningsData = res.earnings;
      this.renderInfo();
      this._drawZigzag();   // now that earnings are in, redraw with the markers
    } catch (e) { /* best-effort; charts still work */ }
  }

  async fetchFinancials() {
    try {
      this.finData = await getFinancials(this.symbol);
      this._drawFinancials();
    } catch (e) { /* best-effort; the rest of the page still works */ }
  }

  _drawFinancials() {
    if (!this.finData) return;
    for (const f of FINANCIALS) {
      const slot = this.finEls[f.key];
      if (!slot) continue;
      if (slot.chart) { slot.chart.destroy(); slot.chart = null; }
      const s = this.finData.series[f.key];
      if (!s || !s.t || !s.t.length) {                 // scraper hasn't filled this yet
        slot.card.classList.add("empty");
        slot.chartEl.innerHTML = "no data yet";
        if (slot.sub) slot.sub.textContent = "";
        continue;
      }
      slot.card.classList.remove("empty");
      const lastTtm = [...s.ttm].reverse().find((v) => v != null);   // latest TTM
      if (slot.sub) slot.sub.textContent = lastTtm != null ? `TTM ${fmtMoneyM(lastTtm)}` : "";
      slot.chart = renderQuarterly(slot.chartEl, s);
    }
  }

  renderInfo() {
    const p = this.profileData, st = this.statsData, e = this.earningsData;
    const name = p ? p.name : this.symbol;
    const meta = p ? [p.exchange, p.currency, p.segment, p.industry].filter(Boolean).join(" · ") : "";
    const desc = p && p.description ? p.description : "";
    const stats = st ? `<div class="si-stats stats">${statsHTML(st)}</div>` : "";
    const earn = e ? `<div class="si-earn">${earningsHTML(e)}</div>` : "";
    const price = this.lastPrice != null
      ? ` <span class="si-price">$${fmtPrice(this.lastPrice)}</span>` : "";
    const descHTML = desc
      ? `<div class="si-desc" title="${escapeAttr(desc)}">${escapeHTML(desc)}</div>`
      : `<div class="si-desc si-desc-empty">No description available.</div>`;
    this.infoEl.innerHTML =
      `<div class="si-top">` +
        `<div class="si-head">` +
          `<div class="si-name">${escapeHTML(name)} <span class="si-sym">${this.symbol}</span>${price}</div>` +
          `<div class="si-meta">${escapeHTML(meta)}</div>` +
          descHTML +
        `</div>` + stats + earn +
      `</div>`;
    this.resizeAll();   // header height changed -> re-fit the charts below
  }

  resizeAll() {
    for (const c of this.cards) {
      if (c.chart) {
        c.chart.setSize({ width: c.chartEl.clientWidth, height: c.chartEl.clientHeight });
      }
    }
    if (this.zzChart && this.zzEl) {
      this.zzChart.setSize({ width: this.zzEl.clientWidth, height: this.zzEl.clientHeight });
    }
    for (const k in this.finEls) {
      const slot = this.finEls[k];
      if (slot.chart) slot.chart.setSize({ width: slot.chartEl.clientWidth, height: slot.chartEl.clientHeight });
    }
    this.cross.renderAll();
  }
}
