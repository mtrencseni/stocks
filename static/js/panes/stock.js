"use strict";

// Per-stock detail pane (opened by double-clicking a card on the Stocks pane).
// A synced 1x3: Price / P/E / P/S for the one symbol, sharing the range toggle
// and a single crosshair group (the tooltip is synced across all three).

import {
  getHistory, getStats, getProfile, getFinancials,
  startOpinion, opinionStatus, listOpinions, getOpinion, deleteOpinion,
  backtestSweep, runBacktest, getReference, REF_OPTIONS, getThresholds, setThreshold,
  getFactorsDetail,
} from "../api.js";
import { buildCard, renderCard, refOverlay, syncCompareUI, startThresholdEdit, renderZigzag, renderQuarterly, CrosshairGroup } from "../chart.js";
import { renderDecomp } from "../decomp.js";
import { loadView, saveView } from "../viewstate.js";
import { wireRefresh } from "../refresh.js";
import { renderOutcomePrice, renderHistogram, renderSweepPanel, HOLD_COLORS } from "../backtestcharts.js";
import { statsHTML, fmtMoneyM, fmtPrice, fmtThresh } from "../util.js";

function escapeHTML(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function escapeAttr(s) { return escapeHTML(s).replace(/"/g, "&quot;"); }

// markdown -> sanitized HTML (libs loaded via CDN in index.html)
function mdHTML(md) {
  try { return window.DOMPurify.sanitize(window.marked.parse(md || "")); }
  catch (e) { return escapeHTML(md || ""); }
}
// "2026-06-20T15-37-46" -> "2026-06-20 15:37 (today)"
function fmtTabTime(ts) {
  const [d, t] = (ts || "").split("T");
  if (!d) return ts;
  const hm = (t || "").slice(0, 5).replace("-", ":");
  return `${d} ${hm} (${relDay(d)})`;
}
function relDay(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d + "T00:00:00"); that.setHours(0, 0, 0, 0);
  const days = Math.round((today - that) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// map yfinance's exchange name to Google Finance's suffix (needs SYM:EXCH)
function gfExchange(ex) {
  const s = (ex || "").toLowerCase();
  if (s.includes("nasdaq") || ["nms", "ngm", "ncm", "nim", "ngs"].includes(s)) return "NASDAQ";
  if (s.includes("arca") || s === "pcx") return "NYSEARCA";
  if (s.includes("american") || s === "ase") return "NYSEAMERICAN";
  if (s.includes("new york") || s === "nyse" || s === "nyq") return "NYSE";
  if (s.includes("cboe") || s === "bats" || s === "bts") return "BATS";
  return "";
}

// external research links for the header
function extLinksHTML(sym, exchange) {
  const s = encodeURIComponent(sym);
  const gx = gfExchange(exchange);
  const links = [
    ["Google Finance", gx ? `https://www.google.com/finance/quote/${s}:${gx}`
                          : `https://www.google.com/finance/quote/${s}`],
    ["Yahoo Finance", `https://finance.yahoo.com/quote/${s}`],
    ["Seeking Alpha", `https://seekingalpha.com/symbol/${s}`],
  ];
  return `<div class="si-links">` +
    links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`).join("") +
    `</div>`;
}

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
    // stock panes share one remembered range + sub-tab (Charts/Backtest)
    this._sv = loadView("stock", { range: "1y", tab: "charts" });
    this.viewState = { range: this._sv.range, compare: "" };
    this.refData = null;        // selected reference {t, rel}
    this.metricSeries = null;   // last fetched [price, pe, ps] series
    this.cross = new CrosshairGroup();  // synced crosshair across the 3 charts
    this.cards = [];
    this.profileData = null;
    this.statsData = null;
    this.earningsData = null;
    this.threshold = null;    // buy-below price for this symbol
    this.finData = null;
    this.finEls = {};
    this.tabs = [];           // opinion tabs: {key(ts), ts, jobId?, state, status?}
    this.activeTab = this._sv.tab === "backtest" ? "backtest" : "charts";   // only stable tabs restore
    this.pollTimers = {};     // jobId -> interval handle
    this.inited = false;
    // backtest tab state (map+drill-down: Δ & hold are sweep coordinates)
    this.bt = { range: "3y", delta: 0.4, holdDays: 126, maxPrice: null,
                mode: "outcomes", sweep: null, detail: null, built: false };
  }

  mount(container) {
    const root = document.createElement("div");
    root.className = "pane";
    root.innerHTML = `
      <section class="stock-info"></section>
      <nav class="subtabs"></nav>
      <div class="subwrap">
        <div class="subview charts-view">
          <header class="toolbar">
            <div class="ranges" data-group="ranges">
              ${RANGES.map((r) => `<button data-range="${r}">${RANGE_LABEL[r]}</button>`).join("")}
            </div>
            <div class="ranges" data-group="compare">
              <select class="compare-select" title="Overlay: same $ invested in a reference">
                <option value="">Compare…</option>
                ${REF_OPTIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
              </select>
            </div>
            <div class="tb-right"><span class="status"></span></div>
          </header>
          <main class="grid detail-grid"></main>
        </div>
        <div class="subview backtest-view" hidden></div>
        <div class="subview opinion-view" hidden></div>
      </div>`;
    container.appendChild(root);
    this.root = root;
    this.infoEl = root.querySelector(".stock-info");
    this.subtabsEl = root.querySelector(".subtabs");
    this.chartsView = root.querySelector(".charts-view");
    this.backtestView = root.querySelector(".backtest-view");
    this.opinionView = root.querySelector(".opinion-view");
    this.grid = root.querySelector(".grid");
    this.statusEl = root.querySelector(".status");

    root.querySelector('[data-group="ranges"]').addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) this.fetchAll(b.dataset.range);
    });
    const csel = root.querySelector(".compare-select");
    csel.addEventListener("change", async () => {
      this.viewState.compare = csel.value;
      syncCompareUI(csel, null, this.viewState.compare);
      await this._loadCompare();
      this._renderCharts();   // re-render from cached series; no history refetch
    });
    syncCompareUI(csel, null, this.viewState.compare);
    this.subtabsEl.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); this._deleteOpinion(del.dataset.del); return; }
      const add = e.target.closest('[data-act="new-opinion"]');
      if (add) { this._startOpinion(); return; }
      const tab = e.target.closest("[data-tab]");
      if (tab) this._selectTab(tab.dataset.tab);
    });
    wireRefresh(root, () => this.refresh());
  }

  async refresh() {
    this.fetchStats();
    this.fetchProfile();
    this.fetchThreshold();
    this.fetchFinancials();
    this.loadZigzag();
    this.loadDecomp();
    if (this.activeTab === "backtest") this._openBacktest();
    await this.fetchAll(this.viewState.range);   // spins until the charts land
  }

  _syncToolbar() {
    this.root.querySelectorAll('[data-group="ranges"] button').forEach((b) =>
      b.classList.toggle("active", b.dataset.range === this.viewState.range));
  }

  onActivate() {
    if (!this.inited) {
      this.inited = true;
      // 6-col grid: row 1 = 3 metric charts (span 2 = thirds); row 2 = quarterly
      // sales + net income (span 3 = halves); row 3 = zigzag + factor decomp (halves).
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
      zel.style.gridColumn = "span 3";
      zel.innerHTML =
        `<div class="card-head"><span class="sym">${this.symbol} · Upswings (3y, ≥40%)</span>` +
        `<button class="bt-open" data-act="backtest">Backtest ▸</button></div>` +
        `<div class="chart"></div>`;
      this.grid.appendChild(zel);
      this.zzEl = zel.querySelector(".chart");
      zel.querySelector('[data-act="backtest"]').addEventListener("click",
        () => this._selectTab("backtest"));

      // factor decomposition (shares row 3 with the zigzag)
      const del = document.createElement("div");
      del.className = "card";
      del.style.gridColumn = "span 3";
      del.innerHTML =
        `<div class="card-head"><span class="sym">${this.symbol} · Factor decomposition (3y)</span></div>` +
        `<div class="decomp-wrap"><div class="fd-loading">loading…</div></div>`;
      this.grid.appendChild(del);
      this.decompEl = del.querySelector(".decomp-wrap");

      this.fetchAll(this.viewState.range);
      this.fetchStats();
      this.fetchProfile();
      this.fetchThreshold();
      this.fetchFinancials();
      this.loadZigzag();
      this.loadDecomp();
      this._renderSubtabs();
      this._loadOpinionList();
      if (this.activeTab === "backtest") this._selectTab("backtest");   // restore sub-tab
    }
    if (this.activeTab === "charts") this.resizeAll();
  }
  onDeactivate() {}

  destroy() {
    for (const c of this.cards) if (c.chart) c.chart.destroy();
    for (const k in this.finEls) if (this.finEls[k].chart) this.finEls[k].chart.destroy();
    if (this.zzChart) this.zzChart.destroy();
    if (this.decompHandle) this.decompHandle.destroy();
    if (this._btRO) this._btRO.disconnect();
    clearTimeout(this._finTimer);
    clearTimeout(this._profTimer);
    clearTimeout(this._statTimer);
    clearTimeout(this._metTimer);
    cancelAnimationFrame(this._btRAF);
    for (const id in this.pollTimers) clearInterval(this.pollTimers[id]);
    if (this.root) this.root.remove();
  }

  // ---- AI opinion sub-tabs ----

  _renderSubtabs() {
    let html = `<button class="subtab${this.activeTab === "charts" ? " active" : ""}" data-tab="charts">Charts</button>` +
      `<button class="subtab${this.activeTab === "backtest" ? " active" : ""}" data-tab="backtest">Backtest</button>`;
    for (const t of this.tabs) {
      const mark = t.state === "running" ? " ⏳" : t.state === "error" ? " ✗" : "";
      const del = t.state === "running" ? "" :
        `<span class="subtab-del" data-del="${t.key}" title="Delete this opinion">×</span>`;
      html += `<button class="subtab${this.activeTab === t.key ? " active" : ""}" data-tab="${t.key}">` +
        `Opinion ${fmtTabTime(t.ts)}${mark}${del}</button>`;
    }
    html += `<button class="subtab-add" data-act="new-opinion">✨ Get AI Opinion</button>`;
    this.subtabsEl.innerHTML = html;
  }

  async _loadOpinionList() {
    try {
      const saved = await listOpinions(this.symbol);   // newest first
      for (const o of saved) {
        if (!this.tabs.some((t) => t.key === o.id)) {
          this.tabs.push({ key: o.id, ts: o.ts, state: "saved", status: null });
        }
      }
      this._renderSubtabs();
    } catch (e) { /* best-effort */ }
  }

  _selectTab(key) {
    this.activeTab = key;
    if (key === "charts" || key === "backtest") {   // remember only the stable tabs
      saveView("stock", { range: this.viewState.range, tab: key });
    }
    const charts = key === "charts";
    const bt = key === "backtest";
    this.chartsView.hidden = !charts;
    this.backtestView.hidden = !bt;
    this.opinionView.hidden = charts || bt;
    this._renderSubtabs();
    if (charts) { this.resizeAll(); return; }
    if (bt) { this._openBacktest(); return; }
    this._renderOpinion(this.tabs.find((t) => t.key === key));
  }

  async _startOpinion() {
    try {
      const job = await startOpinion(this.symbol);   // uses backend ACTIVE_PROFILE
      const tab = { key: job.ts, ts: job.ts, jobId: job.id, state: "running", status: null };
      this.tabs.unshift(tab);
      this._selectTab(tab.key);
      this._pollOpinion(tab);
    } catch (e) {
      alert("Failed to start opinion: " + e.message);
    }
  }

  async _deleteOpinion(key) {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab || tab.state === "running") return;
    if (!confirm(`Delete this opinion (${fmtTabTime(tab.ts)})?`)) return;
    try {
      await deleteOpinion(this.symbol, key);
    } catch (e) {
      alert("Failed to delete: " + e.message);
      return;
    }
    if (tab.jobId && this.pollTimers[tab.jobId]) {
      clearInterval(this.pollTimers[tab.jobId]);
      delete this.pollTimers[tab.jobId];
    }
    this.tabs = this.tabs.filter((t) => t.key !== key);
    if (this.activeTab === key) this._selectTab("charts");
    else this._renderSubtabs();
  }

  _pollOpinion(tab) {
    const tick = async () => {
      try {
        const st = await opinionStatus(tab.jobId);
        tab.status = st;
        tab.state = st.state;
        if (this.activeTab === tab.key) this._renderOpinion(tab);
        if (st.state === "done" || st.state === "error") {
          clearInterval(this.pollTimers[tab.jobId]);
          delete this.pollTimers[tab.jobId];
          this._renderSubtabs();
        }
      } catch (e) { /* transient; keep polling */ }
    };
    tick();
    this.pollTimers[tab.jobId] = setInterval(tick, 2500);
  }

  async _renderOpinion(tab) {
    if (!tab) return;
    let data = tab.status;
    if (!data) {
      if (tab.jobId) {                            // running tab — not on disk yet
        this.opinionView.innerHTML = `<div class="op-loading">Starting…</div>`;
        return;
      }
      this.opinionView.innerHTML = `<div class="op-loading">Loading…</div>`;
      try { data = await getOpinion(this.symbol, tab.key); tab.status = data; }
      catch (e) { this.opinionView.innerHTML = `<div class="op-loading">Error: ${escapeHTML(e.message)}</div>`; return; }
    }
    if (data.state !== "done") this._renderRunning(data);
    else this._renderDone(data);
  }

  _renderRunning(data) {
    const stTxt = (s) => s === "running" ? "running…" : (s || "pending");
    const row = (who, model, st, err) =>
      `<tr class="op-row op-${st || "pending"}">` +
      `<td class="op-r-who">${escapeHTML(who)}</td>` +
      `<td class="op-r-model">${escapeHTML(model)}</td>` +
      `<td class="op-r-status">${escapeHTML(stTxt(st))}` +
      `${err ? " (" + escapeHTML(err) + ")" : ""}</td></tr>`;
    const rows = (data.agents || []).map((a) =>
      row(`agent ${a.i + 1}`, a.model, a.status, a.error)).join("");
    const sum = data.summary
      ? row("summarizer", data.summary.model, data.summary.status, data.summary.error) : "";
    const log = (data.log || []).map(escapeHTML).join("\n");
    this.opinionView.innerHTML =
      `<div class="op-running"><h3>Working… <span class="op-prof">(${escapeHTML(data.profile)})</span></h3>` +
      `<table class="op-table">${rows}${sum}</table><pre class="op-log">${log}</pre></div>`;
  }

  _renderDone(data) {
    const runs = data.runs || [];
    const picks = [`<button class="op-pick active" data-pick="summary">Summary</button>`]
      .concat(runs.map((r) => `<button class="op-pick" data-pick="${r.i}">Agent ${r.i + 1}${r.error ? " ✗" : ""}</button>`))
      .join("");
    this.opinionView.innerHTML =
      `<div class="op-picker">${picks}<span class="op-pick-spacer"></span>` +
      `<button class="op-delete" data-act="delete">🗑 Delete</button></div>` +
      `<div class="op-content"></div>`;
    const content = this.opinionView.querySelector(".op-content");

    const showSummary = () => { content.innerHTML = mdHTML(data.summary_md || "_No summary._"); };
    const showRun = (i) => {
      const r = runs.find((x) => x.i === i);
      if (!r) return;
      if (r.error) { content.innerHTML = `<p class="op-err">Failed: ${escapeHTML(r.error)}</p>`; return; }
      const meta = `<div class="op-meta">${escapeHTML(r.provider)}:${escapeHTML(r.model)}` +
        `${r.latency != null ? " · " + r.latency + "s" : ""}</div>`;
      const js = r.structured
        ? `<pre class="op-json">${escapeHTML(JSON.stringify(r.structured, null, 2))}</pre>` : "";
      content.innerHTML = meta + js + mdHTML(r.freetext || "");
    };
    showSummary();
    this.opinionView.querySelector(".op-picker").addEventListener("click", (e) => {
      if (e.target.closest('[data-act="delete"]')) { this._deleteOpinion(data.ts); return; }
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      this.opinionView.querySelectorAll(".op-pick").forEach((x) => x.classList.toggle("active", x === b));
      if (b.dataset.pick === "summary") showSummary();
      else showRun(parseInt(b.dataset.pick, 10));
    });
  }

  // ---- Backtest tab ----

  _openBacktest() {
    if (!this.bt.built) { this._buildBacktestDOM(); this.bt.built = true; }
    this._loadSweep();    // landscape (and chips/legend/DF); detail loads after
  }

  _buildBacktestDOM() {
    const BT_RANGES = ["1y", "3y", "5y"];
    this.backtestView.innerHTML =
      `<div class="bt-controls">
         <div class="bt-group"><span class="bt-label">Timeframe</span>
           <span class="bt-chips" data-group="range">${BT_RANGES.map((r) =>
             `<button class="bt-chip" data-val="${r}">${r.toUpperCase()}</button>`).join("")}</span></div>
         <div class="bt-group"><span class="bt-label">Max entry $</span>
           <input class="bt-maxprice" type="number" min="0" step="1" placeholder="none"></div>
         <div class="bt-group"><span class="bt-label">TP/SL</span>
           <span class="bt-chips" data-group="delta"></span></div>
         <div class="bt-group"><span class="bt-label">Max hold</span>
           <span class="bt-chips" data-group="hold"></span></div>
       </div>
       <div class="bt-stats"></div>
       <div class="bt-block">
         <div class="bt-price-head"><span>Trade outcome by entry day</span>
           <span class="bt-toggle">
             <button data-mode="outcomes" class="active">Outcomes</button>
             <button data-mode="swings">Swings</button></span></div>
         <div class="bt-price chart"></div>
       </div>
       <div class="bt-block">
         <div class="bt-price-head"><span>Return distribution (per trade)</span></div>
         <div class="bt-hist chart"></div>
       </div>
       <div class="bt-block">
         <div class="bt-price-head"><span>Strategy landscape — line = max hold, × = current</span>
           <span class="bt-legend"></span></div>
         <div class="bt-sweep">
           <div class="bt-panel" data-panel="win"></div>
           <div class="bt-panel" data-panel="mean_ret"></div>
           <div class="bt-panel" data-panel="sharpe"></div>
         </div>
       </div>`;
    this.btEls = {
      stats: this.backtestView.querySelector(".bt-stats"),
      price: this.backtestView.querySelector(".bt-price"),
      hist: this.backtestView.querySelector(".bt-hist"),
      legend: this.backtestView.querySelector(".bt-legend"),
      maxprice: this.backtestView.querySelector(".bt-maxprice"),
      panels: {
        win: this.backtestView.querySelector('[data-panel="win"]'),
        mean_ret: this.backtestView.querySelector('[data-panel="mean_ret"]'),
        sharpe: this.backtestView.querySelector('[data-panel="sharpe"]'),
      },
    };

    this.backtestView.querySelector(".bt-controls").addEventListener("click", (e) => {
      const b = e.target.closest(".bt-chip"); if (!b) return;
      const group = b.closest(".bt-chips").dataset.group;
      const val = b.dataset.val;
      if (group === "range") { this.bt.range = val; this._loadSweep(); }
      else if (group === "delta") { this.bt.delta = parseFloat(val); this._afterSelect(); }
      else if (group === "hold") { this.bt.holdDays = parseInt(val, 10); this._afterSelect(); }
    });
    this.btEls.maxprice.addEventListener("change", () => {
      const v = parseFloat(this.btEls.maxprice.value);
      this.bt.maxPrice = isFinite(v) && v > 0 ? v : null;
      this._loadSweep();   // max price reshapes the whole landscape
    });
    this.backtestView.querySelector(".bt-toggle").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]"); if (!b) return;
      this.bt.mode = b.dataset.mode;
      this.backtestView.querySelectorAll(".bt-toggle button").forEach((x) =>
        x.classList.toggle("active", x === b));
      this._drawPrice();
    });

    // redraw whenever a chart container actually changes size (the stats row and
    // legend grow/shrink the rows after async loads, which would otherwise clip).
    this._btRO = new ResizeObserver(() => {
      if (this.activeTab !== "backtest") return;
      cancelAnimationFrame(this._btRAF);
      this._btRAF = requestAnimationFrame(() => this._drawBacktest());
    });
    for (const el of [this.btEls.price, this.btEls.hist,
                      this.backtestView.querySelector(".bt-sweep")]) {
      this._btRO.observe(el);
    }

    // hover tooltip on the sweep panels: all hold values at the hovered Δ
    this.btTip = document.createElement("div");
    this.btTip.className = "bt-tip"; this.btTip.hidden = true;
    this.backtestView.appendChild(this.btTip);
    const onMove = (e) => {
      const s = e.currentTarget.__sweep;
      if (!s || !s.lines.length) { this.btTip.hidden = true; return; }
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - rect.left - s.padL) / (rect.width - s.padL - s.padR);
      if (frac < -0.05 || frac > 1.05) { this.btTip.hidden = true; return; }
      const dlo = s.deltas[0], dhi = s.deltas[s.deltas.length - 1];
      const dv = dlo + frac * (dhi - dlo);
      let idx = 0, best = Infinity;
      s.deltas.forEach((d, i) => { const dd = Math.abs(d - dv); if (dd < best) { best = dd; idx = i; } });
      const rows = s.lines.map((ln) => ({ label: ln.label, color: ln.color, v: ln.values[idx] }))
        .filter((r) => r.v != null).sort((a, b) => b.v - a.v);
      this.btTip.innerHTML = `<div class="bt-tip-h">Δ ±${Math.round(s.deltas[idx] * 100)}% · ${escapeHTML(s.title)}</div>` +
        rows.map((r) => `<div class="bt-tip-r"><i style="background:${r.color}"></i>${r.label}: ${escapeHTML(s.yfmt(r.v))}</div>`).join("");
      this.btTip.hidden = false;
      const vr = this.backtestView.getBoundingClientRect();
      let tx = e.clientX - vr.left + 14, ty = e.clientY - vr.top + 12;
      if (tx + this.btTip.offsetWidth > vr.width) tx = e.clientX - vr.left - this.btTip.offsetWidth - 14;
      this.btTip.style.left = tx + "px"; this.btTip.style.top = ty + "px";
    };
    for (const key of ["win", "mean_ret", "sharpe"]) {
      const p = this.btEls.panels[key];
      p.addEventListener("mousemove", onMove);
      p.addEventListener("mouseleave", () => { this.btTip.hidden = true; });
    }

    // crosshair + tooltip on the outcome price chart (like the Stocks tab)
    this.btCross = document.createElement("div");
    this.btCross.className = "bt-cross"; this.btCross.hidden = true;
    this.btEls.price.addEventListener("mousemove", (e) => {
      const p = this.btEls.price.__price;        // null in Swings mode (uPlot has its own)
      if (!p) { this.btTip.hidden = true; this.btCross.hidden = true; return; }
      const rect = this.btEls.price.getBoundingClientRect();
      const W = rect.width, H = rect.height, n = p.c.length;
      const frac = (e.clientX - rect.left - p.padL) / (W - p.padL - p.padR);
      if (frac < -0.02 || frac > 1.02) { this.btTip.hidden = true; this.btCross.hidden = true; return; }
      const i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
      const lx = p.padL + (W - p.padL - p.padR) * (n <= 1 ? 0 : i / (n - 1));
      this.btCross.style.left = lx + "px";
      this.btCross.style.top = p.padT + "px";
      this.btCross.style.height = (H - p.padT - p.padB) + "px";
      this.btCross.hidden = false;
      const ret = p.out[i], res = p.resolved[i];
      const oc = ret == null ? "no trade" : !res ? "censored"
        : (ret >= 0 ? `win +${ret.toFixed(1)}%` : `loss ${ret.toFixed(1)}%`);
      const date = new Date(p.t[i] * 1000).toLocaleDateString("en-US",
        { year: "numeric", month: "short", day: "numeric" });
      this.btTip.innerHTML = `<div class="bt-tip-h">${date}</div>` +
        `<div class="bt-tip-r">$${p.c[i] >= 100 ? p.c[i].toFixed(0) : p.c[i].toFixed(2)}</div>` +
        `<div class="bt-tip-r">${oc}</div>`;
      this.btTip.hidden = false;
      const vr = this.backtestView.getBoundingClientRect();
      let tx = e.clientX - vr.left + 14, ty = e.clientY - vr.top + 12;
      if (tx + this.btTip.offsetWidth > vr.width) tx = e.clientX - vr.left - this.btTip.offsetWidth - 14;
      this.btTip.style.left = tx + "px"; this.btTip.style.top = ty + "px";
    });
    this.btEls.price.addEventListener("mouseleave", () => {
      this.btTip.hidden = true; this.btCross.hidden = true;
    });
  }

  // Δ or hold changed within the same landscape: re-mark sweep, reload detail.
  _afterSelect() {
    this._renderChips();
    this._drawSweep();
    this._loadDetail();
  }

  async _loadSweep() {
    if (!this.btEls) return;
    this.btEls.stats.innerHTML = `<div class="bt-stat bt-stat-load">Computing landscape…</div>`;
    try {
      const sw = await backtestSweep(this.symbol, this.bt.range, this.bt.maxPrice);
      this.bt.sweep = sw;
      // clamp the selected hold to one available at this range
      const days = sw.sweep.holds.map((h) => h.days);
      if (days.length && !days.includes(this.bt.holdDays))
        this.bt.holdDays = days.reduce((a, b) =>
          Math.abs(b - this.bt.holdDays) < Math.abs(a - this.bt.holdDays) ? b : a);
      this._renderChips();
      this._drawSweep();
      this._loadDetail();
    } catch (e) {
      this.btEls.stats.innerHTML = `<div class="bt-stat bt-stat-load">Error: ${escapeHTML(e.message)}</div>`;
    }
  }

  async _loadDetail() {
    if (!this.btEls) return;
    try {
      const d = await runBacktest(this.symbol, this.bt.range, this.bt.delta,
                                  this.bt.holdDays, this.bt.maxPrice);
      this.bt.detail = d;
      this._renderStats();
      this._drawPrice();
      renderHistogram(this.btEls.hist, d.hist, this.bt.delta * 100);
    } catch (e) {
      this.btEls.stats.innerHTML = `<div class="bt-stat bt-stat-load">Error: ${escapeHTML(e.message)}</div>`;
    }
  }

  _renderChips() {
    const sw = this.bt.sweep; if (!sw) return;
    const dchips = this.backtestView.querySelector('[data-group="delta"]');
    dchips.innerHTML = sw.sweep.deltas.map((d) =>
      `<button class="bt-chip${d === this.bt.delta ? " active" : ""}" data-val="${d}">±${Math.round(d * 100)}%</button>`).join("");
    const hchips = this.backtestView.querySelector('[data-group="hold"]');
    hchips.innerHTML = sw.sweep.holds.map((h) =>
      `<button class="bt-chip${h.days === this.bt.holdDays ? " active" : ""}" data-val="${h.days}">${h.label}</button>`).join("");
    this.backtestView.querySelectorAll('[data-group="range"] .bt-chip').forEach((b) =>
      b.classList.toggle("active", b.dataset.val === this.bt.range));
  }

  _renderStats() {
    const d = this.bt.detail, m = d && d.metrics, df = this.bt.sweep && this.bt.sweep.df;
    if (!m) { this.btEls.stats.innerHTML = `<div class="bt-stat bt-stat-load">No trades for these params.</div>`; return; }
    const pct = (v, dp = 1) => v == null ? "—" : v.toFixed(dp) + "%";
    const cell = (label, val) => `<div class="bt-stat"><span class="k">${label}</span><span class="v">${val}</span></div>`;
    let html =
      cell("Win rate", pct(m.win * 100, 0)) +
      cell("Mean return", pct(m.mean_ret)) +
      cell("Annualized", pct(m.ann_ret)) +
      cell("Sharpe", m.sharpe == null ? "—" : m.sharpe.toFixed(2)) +
      cell("# trades", m.n_trades) +
      cell("Trade ratio", pct(m.trade_ratio * 100, 0)) +
      cell("Avg hold", m.avg_hold_days == null ? "—" : Math.round(m.avg_hold_days) + "d") +
      cell("Win return", pct(m.cond_win_ret));
    if (df && df.t_stat != null) {
      const mr = df.verdict === "mean-reverting";
      html += `<div class="bt-stat bt-df ${mr ? "mr" : "rw"}"><span class="k">Dickey-Fuller</span>` +
        `<span class="v">${df.t_stat.toFixed(2)} → ${df.verdict}</span></div>`;
    }
    this.btEls.stats.innerHTML = html;
  }

  _drawPrice() {
    const d = this.bt.detail; if (!d || !this.btEls) return;
    if (this.bt.mode === "swings") {
      this.btEls.price.__price = null;              // uPlot provides its own crosshair
      if (this.btCross) this.btCross.hidden = true;
      renderZigzag(this.btEls.price, d.t, d.c, this.earningsData);
    } else {
      renderOutcomePrice(this.btEls.price, d.t, d.c, d.out, d.resolved, this.bt.delta * 100);
      if (this.btCross) this.btEls.price.appendChild(this.btCross);   // re-add (canvas redraw cleared it)
    }
  }

  _drawSweep() {
    const sw = this.bt.sweep; if (!sw || !this.btEls) return;
    const { deltas, holds } = sw.sweep;
    // set the legend FIRST: it can grow the header and shrink the panels, so the
    // canvases must measure their height after layout is final, or labels clip.
    this.btEls.legend.innerHTML = holds.map((h, i) =>
      `<span class="bt-leg"><i style="background:${HOLD_COLORS[i % HOLD_COLORS.length]}"></i>${h.label}</span>`).join("");
    const mkLines = (key) => holds.map((h, i) => ({
      label: h.label, days: h.days, color: HOLD_COLORS[i % HOLD_COLORS.length], values: sw.sweep[key][i],
    }));
    const sel = { delta: this.bt.delta, days: this.bt.holdDays };
    const pctInt = (v) => Math.round(v) + "%";
    const trim = (v) => v.toFixed(2).replace(/\.?0+$/, "");   // 1.00->"1", 0.50->"0.5"
    renderSweepPanel(this.btEls.panels.win, "win ratio", deltas, mkLines("win"), sel, (v) => Math.round(v * 100) + "%");
    renderSweepPanel(this.btEls.panels.mean_ret, "mean return (%)", deltas, mkLines("mean_ret"), sel, pctInt);
    renderSweepPanel(this.btEls.panels.sharpe, "sharpe", deltas, mkLines("sharpe"), sel, trim);
  }

  _drawBacktest() {
    this._drawPrice();
    this._drawSweep();
    if (this.bt.detail) renderHistogram(this.btEls.hist, this.bt.detail.hist, this.bt.delta * 100);
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

  // factor decomposition card (right of the zigzag; same 3y lookback).
  // Not all tickers are in the factor universe — show the reason instead.
  async loadDecomp() {
    try {
      const d = await getFactorsDetail(this.symbol, ZZ_RANGE);
      if (this.decompHandle) this.decompHandle.destroy();
      this.decompHandle = renderDecomp(this.decompEl, d, { compact: true });
      this.resizeAll();
    } catch (e) {
      if (this.decompEl) {
        this.decompEl.innerHTML = `<div class="fd-loading">${escapeHTML(e.message)}</div>`;
      }
    }
  }

  // reference overlay applies to the price chart only; skipped on 1d (intraday)
  async _loadCompare() {
    this.refData = null;
    const v = this.viewState;
    if (!v.compare || v.range === "1d") return;
    try { this.refData = await getReference(v.range, v.compare); } catch (e) { this.refData = null; }
  }

  _renderCharts() {
    if (!this.metricSeries) return;
    this.cross.cards = [];
    METRICS.forEach((m, i) => {
      const overlay = (m.key === "price" && this.refData)
        ? refOverlay(this.refData, this.metricSeries[i]) : null;
      renderCard(this.cards[i], {
        range: this.viewState.range, metric: m.key, series: this.metricSeries[i],
        yRange: null, group: this.cross, overlay,
        threshold: m.key === "price" ? (this.threshold ?? null) : null,
      });
      this.cross.cards.push(this.cards[i]);
    });
    this.cross.renderAll();
  }

  async fetchAll(range) {
    this.viewState.range = range;
    saveView("stock", { range, tab: this.activeTab === "backtest" ? "backtest" : "charts" });
    this._syncToolbar();
    this.statusEl.textContent = "Loading…";
    this.cross.reset();
    this._metTries = 0;               // restart ratio self-heal for the new range
    clearTimeout(this._metTimer);
    try {
      // one history call per metric (the endpoint takes a single metric)
      const results = await Promise.all(METRICS.map((m) =>
        getHistory(range, m.key, [this.symbol])
          .then((s) => s[this.symbol]).catch(() => null)));
      this.metricSeries = results;
      await this._loadCompare();      // reference overlay for the price chart
      this._renderCharts();
      // latest price = last non-null close of the price series (for the header)
      const ps = results[0];
      if (ps && ps.c) {
        const v = ps.c.filter((x) => x != null);
        this.lastPrice = v.length ? v[v.length - 1] : null;
        this.renderInfo();
      }
      this.statusEl.textContent = "";
      this._maybePollMetrics();       // P/E·P/S depend on the background scrape
    } catch (e) {
      this.statusEl.textContent = "Error: " + e.message;
    }
  }

  // P/E and P/S are computed from the macrotrends scrape; if a ratio series came
  // back empty (no scraped rows yet), re-fetch until the scraper fills it in.
  _maybePollMetrics() {
    if (!this.metricSeries) return;
    const empty = METRICS.some((m, i) => {
      if (m.key === "price") return false;
      const s = this.metricSeries[i];
      return !s || !s.c || !s.c.some((x) => x != null);
    });
    if (!empty) return;
    this._metTries = this._metTries || 0;
    if (this._metTries >= 15) return;   // ~5 min, then give up
    clearTimeout(this._metTimer);
    this._metTimer = setTimeout(async () => {
      this._metTries++;
      const range = this.viewState.range;
      try {
        const results = await Promise.all(METRICS.map((m) =>
          getHistory(range, m.key, [this.symbol])
            .then((s) => s[this.symbol]).catch(() => null)));
        if (range === this.viewState.range) {   // ignore if the user switched
          this.metricSeries = results;
          await this._loadCompare();
          this._renderCharts();
        }
      } catch (e) { /* keep trying */ }
      this._maybePollMetrics();
    }, 20000);
  }

  async fetchStats() {
    try {
      const stats = await getStats([this.symbol]);
      this.statsData = stats[this.symbol];
      this.renderInfo();
      this._maybePollStats();
    } catch (e) { /* best-effort */ }
  }

  // the header stats come from yfinance's .info, which is occasionally empty on
  // first fetch; if the row is blank, re-fetch until it fills in.
  _maybePollStats() {
    const s = this.statsData;
    if (s && (s.open != null || s.marketCap != null)) return;
    this._statTries = this._statTries || 0;
    if (this._statTries >= 15) return;   // ~5 min, then give up
    clearTimeout(this._statTimer);
    this._statTimer = setTimeout(async () => {
      this._statTries++;
      try {
        const stats = await getStats([this.symbol]);
        if (stats[this.symbol]) this.statsData = stats[this.symbol];
        this.renderInfo();
      } catch (e) { /* keep trying */ }
      this._maybePollStats();
    }, 20000);
  }

  async fetchProfile() {
    try {
      const res = await getProfile(this.symbol);
      this.profileData = res.profile;
      this.earningsData = res.earnings;
      this.renderInfo();
      this._drawZigzag();   // now that earnings are in, redraw with the markers
      this._maybePollProfile();
    } catch (e) { /* best-effort; charts still work */ }
  }

  // the description comes from yfinance's .info, which often arrives a fetch or
  // two late; if it's missing, re-fetch the profile until it shows up.
  _maybePollProfile() {
    if (this.profileData && this.profileData.description) return;
    this._profTries = this._profTries || 0;
    if (this._profTries >= 15) return;   // ~5 min, then give up
    clearTimeout(this._profTimer);
    this._profTimer = setTimeout(async () => {
      this._profTries++;
      try {
        const res = await getProfile(this.symbol);
        if (res.profile) this.profileData = res.profile;
        if (res.earnings) this.earningsData = res.earnings;
        this.renderInfo();
      } catch (e) { /* keep trying */ }
      this._maybePollProfile();
    }, 20000);
  }

  async fetchFinancials() {
    try {
      this.finData = await getFinancials(this.symbol);
      this._drawFinancials();
      this._maybePollFinancials();
    } catch (e) { /* best-effort; the rest of the page still works */ }
  }

  // financials are macrotrends-scraped in the background; if a series isn't in
  // yet, show "loading…" and re-fetch until it appears (or we give up).
  _maybePollFinancials() {
    const anyEmpty = FINANCIALS.some((f) => {
      const s = this.finData && this.finData.series && this.finData.series[f.key];
      return !s || !s.t || !s.t.length;
    });
    if (!anyEmpty) { this._finPolling = false; this._drawFinancials(); return; }  // all in -> draw
    this._finTries = this._finTries || 0;
    if (this._finTries >= 30) { this._finPolling = false; this._drawFinancials(); return; }  // ~10 min
    this._finPolling = true;
    this._drawFinancials();   // re-render so empty slots read "loading…"
    clearTimeout(this._finTimer);
    this._finTimer = setTimeout(async () => {
      this._finTries++;
      try { this.finData = await getFinancials(this.symbol); } catch (e) { /* keep trying */ }
      this._maybePollFinancials();
    }, 20000);
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
        slot.chartEl.innerHTML = this._finPolling ? "loading…" : "no data yet";
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
    const th = this.threshold ?? null;
    const below = th != null && this.lastPrice != null && this.lastPrice < th;
    const threshTxt = fmtThresh(th);
    const thresh = `<span class="si-thresh${th != null ? " set" : ""}" title="Buy-below price (double-click to set)">${threshTxt}</span>`;
    const price = this.lastPrice != null
      ? ` ${thresh}<span class="si-price${below ? " below-thresh" : ""}">$${fmtPrice(this.lastPrice)}</span>`
      : ` ${thresh}`;
    const descHTML = desc
      ? `<div class="si-desc" title="${escapeAttr(desc)}">${escapeHTML(desc)}</div>`
      : `<div class="si-desc si-desc-empty">No description available.</div>`;
    this.infoEl.innerHTML =
      `<div class="si-top">` +
        `<div class="si-head">` +
          `<div class="si-nameline">` +
            `<div class="si-name">${escapeHTML(name)} <span class="si-sym">${this.symbol}</span>${price}</div>` +
            extLinksHTML(this.symbol, p && p.exchange) +
          `</div>` +
          `<div class="si-meta">${escapeHTML(meta)}</div>` +
          descHTML +
        `</div>` + stats + earn +
      `</div>`;
    const threshEl = this.infoEl.querySelector(".si-thresh");
    if (threshEl) {
      threshEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startThresholdEdit(threshEl, this.threshold ?? null, (price) => this._saveThreshold(price));
      });
    }
    this.resizeAll();   // header height changed -> re-fit the charts below
  }

  _saveThreshold(price) {
    this.threshold = price > 0 ? price : null;
    setThreshold(this.symbol, price).catch(() => {});
    this.renderInfo();      // header label + price color + re-wire dblclick
    this._renderCharts();   // repaint the price chart with the buy-below line
  }

  fetchThreshold() {
    getThresholds().then((t) => {
      this.threshold = (t && t[this.symbol]) ?? null;
      this.renderInfo();
      if (this.metricSeries) this._renderCharts();
    }).catch(() => {});
  }

  resizeAll() {
    if (this.activeTab === "backtest") { if (this.bt.detail || this.bt.sweep) this._drawBacktest(); return; }
    for (const c of this.cards) {
      if (c.chart) {
        c.chart.setSize({ width: c.chartEl.clientWidth, height: c.chartEl.clientHeight });
      }
    }
    if (this.zzChart && this.zzEl) {
      this.zzChart.setSize({ width: this.zzEl.clientWidth, height: this.zzEl.clientHeight });
    }
    if (this.decompHandle) this.decompHandle.resize();
    for (const k in this.finEls) {
      const slot = this.finEls[k];
      if (slot.chart) slot.chart.setSize({ width: slot.chartEl.clientWidth, height: slot.chartEl.clientHeight });
    }
    this.cross.renderAll();
  }
}
