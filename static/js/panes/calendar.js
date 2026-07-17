"use strict";

// Calendar pane: recent + upcoming earnings across the universe as a
// chronological, day-grouped list with a "Today" divider. Inherits the
// exchange/industry/MAG7/profitable group filters + search from filters.js.

import { getCalendar, getEarningsDetail } from "../api.js";
import {
  newFilters, matches, handleFilterClick, buildFilterChipsHTML, escapeHTML,
} from "../filters.js";
import { loadView, saveView } from "../viewstate.js";
import { wireRefresh } from "../refresh.js";

const WINDOWS = { "1w": 7, "2w": 14, "1m": 31, "3m": 92 };
const WIN_ORDER = ["1w", "2w", "1m", "3m"];
const WIN_LABEL = { "1w": "1W", "2w": "2W", "1m": "1M", "3m": "3M" };

function relText(days) {
  return days > 0 ? `in ${days}d` : days < 0 ? `${-days}d ago` : "today";
}
function dayLabel(date) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric" });
}
function pctText(s) {
  return s == null ? "" : ` ${s >= 0 ? "+" : ""}${s.toFixed(1)}%`;
}
// tiny price sparkline, colored green/red by net change over the span
function drawSpark(canvas, c) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 180, H = canvas.clientHeight || 36;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  let lo = Infinity, hi = -Infinity;
  for (const v of c) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = 3, n = c.length;
  const x = (i) => pad + (W - 2 * pad) * (i / (n - 1));
  const y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo || 1));
  const up = c[c.length - 1] >= c[0];
  const s = getComputedStyle(document.body);
  const col = (up ? s.getPropertyValue("--up") : s.getPropertyValue("--down")).trim() || "#89c996";
  ctx.strokeStyle = col; ctx.fillStyle = col;
  ctx.lineWidth = 1.5; ctx.lineJoin = "round";
  ctx.beginPath();
  c.forEach((v, i) => { const px = x(i), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
  c.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 2, 0, 2 * Math.PI); ctx.fill(); });   // a dot per day
}

// compact last-report reaction line for the collapsed row
function reactionHTML(r) {
  if (!r) return "";
  const f = (v) => v == null ? "—" : "$" + v.toFixed(2);
  const pc = (v) => v == null ? "" :
    ` <b class="${v >= 0 ? "up" : "dn"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</b>`;
  return `<span class="cal-rk-lbl">last report</span> ${f(r.pre)} ` +
    `<span class="cal-arrow">→</span> ${f(r.next)}${pc(r.nextPct)} ` +
    `<span class="cal-arrow">→</span> now ${f(r.now)}${pc(r.nowPct)} ` +
    `<span class="cal-dim">(${r.date})</span>`;
}

function fmtCap(v) {
  if (v == null || !(v > 0)) return "";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(0)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v}`;
}

// inline-SVG row sparkline (green/red by net change); cheap for ~hundreds of rows
function sparkSVG(c) {
  if (!c || c.length < 2) return "";
  const W = 252, H = 22, pad = 2;
  let lo = Infinity, hi = -Infinity;
  for (const v of c) { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!(hi > lo)) return "";
  const xs = (i) => pad + (W - 2 * pad) * (i / (c.length - 1));
  const ys = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo));
  const pts = c.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const up = c[c.length - 1] >= c[0];
  return `<svg class="cal-spark ${up ? "up" : "dn"}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `vector-effect="non-scaling-stroke" /></svg>`;
}

// last 4 beats (most-recent-first) -> 4 squares, oldest→newest left to right
function histSquares(hist) {
  const arr = (hist || []).slice(0, 4).reverse();
  while (arr.length < 4) arr.unshift(undefined);
  return arr.map((b) => {
    const cls = b === true ? "beat" : b === false ? "miss" : "none";
    return `<i class="cal-sq ${cls}"></i>`;
  }).join("");
}

export class CalendarPane {
  constructor(opts = {}) {
    this.id = "calendar";
    this.type = "calendar";
    this.title = "Earnings";
    this.closable = false;
    this.onOpenStock = opts.onOpenStock || (() => {});
    const v = loadView("earnings", { window: "1m", mode: "both" });   // remembered across reloads
    this.viewState = { window: v.window, mode: v.mode, search: "" };
    this.filters = newFilters();
    this.entries = [];
    this.inited = false;
  }

  mount(container) {
    const root = document.createElement("div");
    root.className = "pane calendar-pane";
    root.innerHTML = `
      <header class="toolbar">
        <div class="ranges" data-group="window">
          ${WIN_ORDER.map((w) => `<button data-window="${w}">${WIN_LABEL[w]}</button>`).join("")}
        </div>
        <div class="ranges" data-group="mode">
          <button data-mode="both">Past + Future</button>
          <button data-mode="upcoming">Future only</button>
        </div>
        <div class="cal-search-wrap">
          <input class="explore-search-input cal-search" type="text" autocomplete="off"
                 spellcheck="false" placeholder="Search ticker or name…" />
        </div>
        <div class="tb-right"><span class="status"></span></div>
      </header>
      <div class="explore-filters"></div>
      <main class="cal-list"></main>`;
    container.appendChild(root);
    this.root = root;
    this.statusEl = root.querySelector(".status");
    this.filtersEl = root.querySelector(".explore-filters");
    this.listEl = root.querySelector(".cal-list");
    this._saveView = () =>
      saveView("earnings", { window: this.viewState.window, mode: this.viewState.mode });

    root.querySelector('[data-group="window"]').addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this.viewState.window = b.dataset.window; this._saveView(); this._syncToolbar(); this._render();
    });
    root.querySelector('[data-group="mode"]').addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this.viewState.mode = b.dataset.mode; this._saveView(); this._syncToolbar(); this._render();
    });
    root.querySelector(".cal-search").addEventListener("input", (e) => {
      this.viewState.search = e.target.value; this._render();
    });
    this.filtersEl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !handleFilterClick(this.filters, b)) return;
      this._buildFilterChips(); this._render();
    });
    this.listEl.addEventListener("click", (e) => {
      const row = e.target.closest(".cal-row");
      if (!row) return;
      if (e.target.closest(".cal-tk")) { this.onOpenStock(row.dataset.sym); return; }  // ticker -> page
      this._toggleDetail(row);                                                          // row -> drawer
    });
    wireRefresh(root, () => this.load());
    this._syncToolbar();
  }

  _syncToolbar() {
    const v = this.viewState;
    this.root.querySelectorAll('[data-group="window"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.window === v.window));
    this.root.querySelectorAll('[data-group="mode"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === v.mode));
  }

  onActivate() { if (!this.inited) { this.inited = true; this.load(); } }
  onDeactivate() {}
  destroy() { if (this.root) this.root.remove(); }

  async load() {
    this.statusEl.textContent = "Loading… (first build can take ~30s)";
    try {
      const data = await getCalendar();
      this.entries = data.entries || [];
      this.statusEl.textContent = `${this.entries.length} reports · as of ${data.asof}`;
      this._buildFilterChips();
      this._render();
    } catch (e) {
      this.statusEl.textContent = "Error: " + e.message;
    }
  }

  _buildFilterChips() {
    // chips are built from the stocks present in the calendar entries
    this.filtersEl.innerHTML = buildFilterChipsHTML(this.entries, this.filters);
  }

  _render() {
    const v = this.viewState;
    const win = WINDOWS[v.window];
    const lo = v.mode === "both" ? -win : 0;
    const q = v.search.trim().toLowerCase();
    const list = this.entries.filter((e) =>
      e.days >= lo && e.days <= win && matches(e, this.filters) &&
      (!q || e.sym.toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q)));

    if (!list.length) {
      this.listEl.innerHTML = `<div class="cal-empty">No earnings in this window.</div>`;
      return;
    }

    let html = "", curDate = null, hadPast = false, dividerDone = false;
    for (const e of list) {
      if (e.days < 0) hadPast = true;
      if (!dividerDone && e.days >= 0 && hadPast) {
        html += `<div class="cal-today">● Today</div>`;
        dividerDone = true; curDate = null;
      }
      if (e.date !== curDate) {
        curDate = e.date;
        html += `<div class="cal-day">${dayLabel(e.date)}<span class="cal-rel"> · ${relText(e.days)}</span></div>`;
      }
      html += this._row(e);
    }
    this.listEl.innerHTML = html;
  }

  _row(e) {
    // EPS label (next to ticker): "reported $X EPS" (green/red by beat) for past,
    // "estimated $X EPS" (gray) for upcoming
    let eps;
    if (e.past) {
      const cls = e.beat === true ? "up" : e.beat === false ? "dn" : "";
      eps = e.epsActual != null
        ? `<span class="cal-eps ${cls}">reported $${e.epsActual.toFixed(2)} EPS</span>`
        : `<span class="cal-eps">reported</span>`;
    } else {
      eps = e.epsEst != null
        ? `<span class="cal-eps cal-est">estimated $${e.epsEst.toFixed(2)} EPS</span>`
        : `<span class="cal-eps cal-est">estimate n/a</span>`;
    }
    let right;
    if (e.past) {
      if (e.beat === true) right = `<span class="cal-res beat">✓ beat${pctText(e.surprisePct)}</span>`;
      else if (e.beat === false) right = `<span class="cal-res miss">✗ miss${pctText(e.surprisePct)}</span>`;
      else right = `<span class="cal-res">reported</span>`;
    } else {
      right = `<span class="cal-res cal-up">upcoming</span>`;
    }
    return `<div class="cal-row" data-sym="${e.sym}" data-key="${e.sym}|${e.date}" tabindex="0">` +
      `<button class="cal-tk" title="Open ${e.sym} detail">${e.sym}</button>` +
      eps +
      `<span class="cal-nm">${escapeHTML(e.name || "")}</span>` +
      `<span class="cal-react">${reactionHTML(e.reaction)}</span>` +
      `<span class="cal-cap" title="market cap">${fmtCap(e.mktcap)}</span>` +
      `<span class="cal-spark-wrap" title="price, last ~6mo">${sparkSVG(e.spark)}</span>` +
      `<span class="cal-hist" title="last 4 reports (beat/miss)">${histSquares(e.hist)}</span>` +
      right + `<span class="cal-caret">▸</span></div>`;
  }

  _toggleDetail(row) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains("cal-detail")) {   // already open -> close
      next.remove();
      row.classList.remove("expanded");
      return;
    }
    row.classList.add("expanded");
    const det = document.createElement("div");
    det.className = "cal-detail";
    det.innerHTML = `<div class="cal-det-load">Loading…</div>`;
    row.after(det);
    this._loadDetail(row.dataset.sym, det);
  }

  async _loadDetail(sym, det) {
    this.detailCache = this.detailCache || {};
    try {
      let d = this.detailCache[sym];
      if (!d) { d = await getEarningsDetail(sym); this.detailCache[sym] = d; }
      if (!det.isConnected) return;
      this._renderDetail(det, d);
    } catch (e) {
      det.innerHTML = `<div class="cal-det-load">Error: ${escapeHTML(e.message)}</div>`;
    }
  }

  _renderDetail(det, d) {
    const fmt = (v, dp = 2) => v == null ? "—" : v.toFixed(dp);
    const pct = (v, dp = 1) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
    const bt = d.backtest || {};
    det.innerHTML =
      `<div class="cd-grid">` +
        // sparkline full-width on top
        `<div class="cd-cell cd-wide cd-spark"><div class="cd-lbl">Price since last earnings</div>` +
          `<canvas class="cd-canvas"></canvas></div>` +
        // 3y analyses side by side
        `<div class="cd-cell"><div class="cd-lbl">3y vs current price ($${fmt(d.currentPrice)})</div>` +
          `<div class="cd-v"><b class="up">▲ ${fmt(d.abovePct, 0)}%</b> above · ` +
          `<b class="dn">▼ ${fmt(d.belowPct, 0)}%</b> below</div></div>` +
        `<div class="cd-cell"><div class="cd-lbl">Backtest 3y · enter ≤ $${fmt(d.currentPrice)} · TP+40/SL−40 · 6mo</div>` +
          `<div class="cd-v">win ${bt.win == null ? "—" : Math.round(bt.win * 100) + "%"} · ` +
          `avg ${pct(bt.avg)} · entered ${bt.tradeRatio == null ? "—" : Math.round(bt.tradeRatio * 100) + "%"} of days</div></div>` +
        // relative metrics side by side
        `<div class="cd-cell"><div class="cd-lbl">Valuation</div>` +
          `<div class="cd-v">P/E ${fmt(d.pe, 1)} · P/S ${fmt(d.ps, 1)}</div></div>` +
        `<div class="cd-cell"><div class="cd-lbl">Industry (idiosyncratic z)</div>` +
          `<div class="cd-v">${d.idio_z == null ? "—" : d.idio_z.toFixed(2) + " σ " + (d.idio_z < 0 ? "(off to downside)" : "(ahead of industry)")}</div></div>` +
      `</div>`;
    if (d.spark && d.spark.c && d.spark.c.length > 1) {
      drawSpark(det.querySelector(".cd-canvas"), d.spark.c);
    }
  }

  resizeAll() {}
}
