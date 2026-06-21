"use strict";

// The original dashboard: a responsive grid of charts, now a Pane.

import { getHistory, getStats, getReference, REF_OPTIONS } from "../api.js";
import { buildCard, renderCard, refOverlay, syncCompareUI, CrosshairGroup } from "../chart.js";
import { statsHTML, isMobile } from "../util.js";

const DEFAULT_SYMBOLS =
  ["ADBE", "ASAN", "META", "NOW", "NVDA", "PATH", "PYPL", "SMCI", "SNOW", "TEAM", "TSLA", "ZS"];
const STORAGE_KEY = "symbols.v3";   // bumped for the new 12-symbol default

function sortSyms(list) { return list.slice().sort(); }
function loadSymbols() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(s) && s.length) return sortSyms(s);
  } catch (e) {}
  return sortSyms(DEFAULT_SYMBOLS);
}
function saveSymbols(list) { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }

export class StocksPane {
  constructor(opts = {}) {
    this.id = "stocks";
    this.type = "stocks";
    this.title = "Stocks";
    this.closable = false;
    this.onOpenStock = opts.onOpenStock || (() => {});
    this.symbols = loadSymbols();
    this.viewState = { range: "1d", metric: "price", yaxis: "per", compare: "", stats: "full" };  // in-memory
    this.cards = {};
    this.cross = new CrosshairGroup();
    this.lastSeries = null;
    this.refData = null;     // {t, rel} for the selected reference
    this.overlays = {};      // sym -> per-bar "same $" overlay array
    this.updatedAt = null;
    this.inited = false;
    this.statusTimer = null;
  }

  mount(container) {
    const root = document.createElement("div");
    root.className = "pane";
    root.innerHTML = `
      <header class="toolbar">
        <div class="ranges" data-group="ranges">
          <button data-range="1d">1D</button>
          <button data-range="1w">1W</button>
          <button data-range="1mo">1M</button>
          <button data-range="3mo">3M</button>
          <button data-range="6mo">6M</button>
          <button data-range="1y">1Y</button>
          <button data-range="3y">3Y</button>
          <button data-range="5y">5Y</button>
        </div>
        <div class="ranges" data-group="metrics">
          <button data-metric="price">Price</button>
          <button data-metric="pe">P/E</button>
          <button data-metric="ps">P/S</button>
        </div>
        <div class="ranges" data-group="yaxis">
          <button data-yaxis="per">Local</button>
          <button data-yaxis="shared">Global</button>
        </div>
        <div class="ranges" data-group="stats">
          <button data-stats="full">Full</button>
          <button data-stats="min">Min</button>
        </div>
        <div class="ranges" data-group="compare">
          <select class="compare-select" title="Overlay: same $ invested in a reference">
            <option value="">Compare…</option>
            ${REF_OPTIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>
        </div>
        <div class="tb-right">
          <span class="status"></span>
          <button class="ghost" data-act="edit">Edit symbols</button>
        </div>
        <nav class="ticker-nav"></nav>
      </header>
      <main class="grid"></main>`;
    container.appendChild(root);
    this.root = root;
    this.grid = root.querySelector(".grid");
    this.statusEl = root.querySelector(".status");
    this.nav = root.querySelector(".ticker-nav");
    this._wire();
    this._syncToolbar();
  }

  _wire() {
    this.root.querySelector('[data-group="ranges"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) this.fetchHistory(b.dataset.range);
    });
    this.root.querySelector('[data-group="metrics"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.viewState.metric = b.dataset.metric;
      this._syncToolbar();
      this.fetchHistory(this.viewState.range);
    });
    this.root.querySelector('[data-group="yaxis"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.viewState.yaxis = b.dataset.yaxis;
      this._syncToolbar();
      this.applyRender();   // re-render from cached data; no refetch, keeps the frozen pin
    });
    this.root.querySelector('[data-group="stats"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.viewState.stats = b.dataset.stats;
      this._syncToolbar();
      this._renderStats();   // re-render from cached stats; no refetch
      this.resizeAll();      // stats row height changed -> re-fit charts
    });
    const sel = this.root.querySelector(".compare-select");
    sel.addEventListener("change", async () => {
      this.viewState.compare = sel.value;
      syncCompareUI(sel, null, this.viewState.compare);
      await this._loadCompare();
      this.applyRender();
    });
    syncCompareUI(sel, null, this.viewState.compare);
    this.root.querySelector('[data-act="edit"]').addEventListener("click", () => this._editSymbols());
    this.nav.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) this._jumpTo(b.dataset.sym);
    });
    // double-click a card -> open its detail pane
    this.grid.addEventListener("dblclick", (e) => {
      const card = e.target.closest(".card");
      if (card && card.dataset.sym) this.onOpenStock(card.dataset.sym);
    });
  }

  _syncToolbar() {
    const v = this.viewState;
    this.root.querySelectorAll('[data-group="ranges"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.range === v.range));
    this.root.querySelectorAll('[data-group="metrics"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.metric === v.metric));
    this.root.querySelectorAll('[data-group="yaxis"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.yaxis === v.yaxis));
    this.root.querySelectorAll('[data-group="stats"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.stats === v.stats));
    if (this.grid) this.grid.classList.toggle("stats-min", v.stats === "min");
  }

  onActivate() {
    if (!this.inited) {
      this.inited = true;
      this.buildGrid();
      this.fetchHistory(this.viewState.range);
      this.fetchStats();
      this.statusTimer = setInterval(() => this.renderStatus(), 60000);
    }
    this.resizeAll();
  }
  onDeactivate() {}

  destroy() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    for (const sym of this.symbols) {
      const c = this.cards[sym];
      if (c && c.chart) c.chart.destroy();
    }
    if (this.root) this.root.remove();
  }

  buildGrid() {
    this.grid.innerHTML = "";
    this.cards = {};
    const n = this.symbols.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    this.grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this.grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    this.nav.innerHTML = "";
    for (const sym of this.symbols) {
      const b = document.createElement("button");
      b.textContent = sym;
      b.dataset.sym = sym;
      this.nav.appendChild(b);
    }

    for (const sym of this.symbols) {
      const card = buildCard(sym);
      card.el.dataset.sym = sym;
      this.grid.appendChild(card.el);
      this.cards[sym] = card;
    }
  }

  async fetchHistory(range) {
    this.viewState.range = range;
    this._syncToolbar();
    this.statusEl.textContent = "Loading…";
    this.cross.reset();   // a frozen crosshair from a different range/metric doesn't map cleanly
    try {
      this.lastSeries = await getHistory(range, this.viewState.metric, this.symbols);
      await this._loadCompare();   // reference depends on range/metric
      this.applyRender();
      this.updatedAt = Date.now();
      this.renderStatus();
    } catch (e) {
      this.updatedAt = null;
      this.statusEl.textContent = "Error: " + e.message;
    }
  }

  applyRender() {
    const series = this.lastSeries;
    if (!series) return;

    let yRange = null;
    if (this.viewState.yaxis === "shared") {
      let mn = Infinity, mx = -Infinity;
      const eat = (v) => { if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; } };
      for (const sym of this.symbols) {
        const s = series[sym];
        if (s && s.c) for (const v of s.c) eat(v);
        const ov = this.overlays[sym];               // include the overlay so it isn't clipped
        if (ov) for (const v of ov) eat(v);
      }
      if (mn <= mx) {
        const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
        yRange = [mn - pad, mx + pad];
      }
    }

    this.cross.cards = [];
    for (const sym of this.symbols) {
      const card = this.cards[sym];
      renderCard(card, {
        range: this.viewState.range, metric: this.viewState.metric,
        series: series[sym], yRange, group: this.cross, overlay: this.overlays[sym] || null,
      });
      this.cross.cards.push(card);
    }
    this.cross.renderAll();
  }

  // fetch the selected reference and turn it into a per-stock "same $" overlay
  async _loadCompare() {
    const v = this.viewState;
    this.overlays = {};
    this.refData = null;
    if (!v.compare || v.metric !== "price" || v.range === "1d") return;
    try {
      this.refData = await getReference(v.range, v.compare);
    } catch (e) { this.refData = null; return; }
    this._computeOverlays();
  }

  _computeOverlays() {
    this.overlays = {};
    if (!this.refData) return;
    for (const sym of this.symbols) {
      const ov = refOverlay(this.refData, this.lastSeries && this.lastSeries[sym]);
      if (ov) this.overlays[sym] = ov;
    }
  }

  async fetchStats() {
    try {
      this.statsRaw = await getStats(this.symbols);
      this._renderStats();
      this.resizeAll();   // stats row now occupies its space -> re-fit charts
    } catch (e) { /* stats are best-effort */ }
  }

  _renderStats() {
    if (!this.statsRaw) return;
    const min = this.viewState.stats === "min";
    for (const sym of this.symbols) {
      const card = this.cards[sym];
      if (card) card.statsEl.innerHTML = statsHTML(this.statsRaw[sym], min);
    }
  }

  renderStatus() {
    if (!this.updatedAt) return;
    const d = new Date(this.updatedAt);
    const clock = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    const mins = Math.floor((Date.now() - this.updatedAt) / 60000);
    const ago = mins < 1 ? "just now" : mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
    this.statusEl.textContent = `Updated ${clock} (${ago})`;
    this.statusEl.classList.toggle("stale", mins >= 10);
  }

  resizeAll() {
    for (const sym of this.symbols) {
      const c = this.cards[sym];
      if (c && c.chart) {
        c.chart.setSize({ width: c.chartEl.clientWidth, height: c.chartEl.clientHeight });
      }
    }
    this.cross.renderAll();
  }

  _jumpTo(sym) {
    const c = this.cards[sym];
    if (c) c.el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  _editSymbols() {
    const input = prompt("Symbols (comma-separated):", this.symbols.join(", "));
    if (input == null) return;
    const list = input.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!list.length) return;
    this.symbols = sortSyms(list);
    saveSymbols(this.symbols);
    this.buildGrid();
    this.fetchHistory(this.viewState.range);
    this.fetchStats();
  }
}
