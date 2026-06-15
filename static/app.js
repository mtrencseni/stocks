"use strict";

const DEFAULT_SYMBOLS =
  ["ADBE", "ASAN", "META", "SMCI", "PATH", "NVDA", "TSLA", "TEAM", "PYPL"];
const STORAGE_KEY = "symbols.v2";   // bumped so the new 9-symbol default applies

const UP = "#89c996";    // RGB(137,201,150), matches --up
const DOWN = "#ec8a82";  // RGB(236,138,130), matches --down
const GRAY = "#9aa0a6";
const TZ = "America/New_York";

// render all charts in US market time, regardless of the viewer's timezone
const tzDate = (ts) => uPlot.tzDate(new Date(ts * 1000), TZ);

// narrow screens (phones) get fewer date ticks so they don't overlap
function isMobile() { return window.matchMedia("(max-width: 760px)").matches; }

// the crosshair is drawn by us (not uPlot's cursor) so it can stay frozen on
// every chart after the mouse leaves. pinXval = the x-scale value it sits at.
let pinXval = null;

const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");

const state = {
  range: "1d",
  metric: "price",
  yaxis: "per",          // "per" = per-chart auto, "shared" = global min/max
  symbols: loadSymbols(),
  lastSeries: null,      // last fetched series, for re-render without refetch
  cards: {},
};

// ---------- helpers ----------

function sortSyms(list) { return list.slice().sort(); }

function loadSymbols() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(s) && s.length) return sortSyms(s);
  } catch (e) {}
  return sortSyms(DEFAULT_SYMBOLS);
}
function saveSymbols(list) { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fmtPrice(v) { return v == null ? "—" : v.toFixed(2); }

function fmtCap(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  return v.toFixed(0);
}

function etTime(d) {
  return d.toLocaleTimeString("en-GB",
    { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });   // 24h, e.g. 15:00
}
function etYMD(d) {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });   // en-CA -> YYYY-MM-DD
}

function fmtTime(epoch, range) {
  const d = new Date(epoch * 1000);
  if (range === "1d") return etTime(d);
  if (range === "1w") return etYMD(d) + " " + etTime(d);  // intraday week -> date + time
  return etYMD(d);
}

// 1D x-axis labels (real time scale): times in ET
function intradayValues(u, splits) {
  return splits.map((s) => etTime(new Date(s * 1000)));
}

// Multi-day ranges use an ORDINAL x (bar index) so nights/weekends don't leave
// gaps. Ticks are placed at the first bar of each day, thinned to ~maxTicks.
function dayTickSplits(times, maxTicks = 8) {
  const bounds = [];
  let prev = null;
  for (let i = 0; i < times.length; i++) {
    const d = etYMD(new Date(times[i] * 1000));
    if (d !== prev) { bounds.push(i); prev = d; }
  }
  let ticks = bounds;
  if (bounds.length > maxTicks) {
    const step = Math.ceil(bounds.length / maxTicks);
    ticks = bounds.filter((_, k) => k % step === 0);
  }
  // bounds[0] is index 0 (left edge), where the centered date label gets
  // clipped; drop it so the leftmost shown date is inset.
  return ticks.length > 1 ? ticks.slice(1) : ticks;
}

function ordinalValues(times) {
  return (u, splits) => splits.map((i) => {
    const idx = Math.round(i);
    return (idx >= 0 && idx < times.length) ? etYMD(new Date(times[idx] * 1000)) : "";
  });
}

function makeFill(color) {
  return (u) => {
    const ctx = u.ctx;
    const top = u.bbox.top;
    const g = ctx.createLinearGradient(0, top, 0, top + u.bbox.height);
    g.addColorStop(0, rgba(color, 0.28));
    g.addColorStop(1, rgba(color, 0.0));
    return g;
  };
}

// dashed horizontal line at the previous close (1D only)
function prevCloseLine(value) {
  return {
    hooks: {
      draw: (u) => {
        if (value == null) return;
        const y = Math.round(u.valToPos(value, "y", true));
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = rgba("#9aa0a6", 0.55);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}

// Google-style 3x3 stat grid (row-major matches the screenshot's column order)
function statsHTML(s) {
  if (!s) return "";
  const items = [
    ["Open", fmtPrice(s.open)],
    ["Mkt cap", fmtCap(s.marketCap)],
    ["Dividend", s.divYield == null ? "—" : s.divYield.toFixed(2) + "%"],
    ["High", fmtPrice(s.high)],
    ["P/E ratio", s.pe == null ? "—" : s.pe.toFixed(2)],
    ["Qtrly Div", s.qtrlyDiv == null ? "—" : s.qtrlyDiv.toFixed(2)],
    ["Low", fmtPrice(s.low)],
    ["52-wk high", fmtPrice(s.weekHigh52)],
    ["52-wk low", fmtPrice(s.weekLow52)],
  ];
  return items.map(([k, v]) =>
    `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`
  ).join("");
}

// ---------- grid + cards ----------

function buildGrid() {
  grid.innerHTML = "";
  state.cards = {};
  const n = state.symbols.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // mobile ticker-jump row: one chip per symbol, taps scroll to its card
  const nav = document.getElementById("tickerNav");
  if (nav) {
    nav.innerHTML = "";
    for (const sym of state.symbols) {
      const b = document.createElement("button");
      b.textContent = sym;
      b.dataset.sym = sym;
      nav.appendChild(b);
    }
  }

  for (const sym of state.symbols) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="card-head">
        <span class="sym">${sym}</span>
        <span class="price">—</span>
        <span class="chg"></span>
      </div>
      <div class="chart"></div>
      <div class="stats"></div>`;
    grid.appendChild(el);

    state.cards[sym] = {
      sym, el,
      chartEl: el.querySelector(".chart"),
      priceEl: el.querySelector(".price"),
      chgEl: el.querySelector(".chg"),
      statsEl: el.querySelector(".stats"),
      chart: null,
      tip: null,
      priceIdx: 1,
    };
  }
}

function changeText(price, base) {
  if (price == null || base == null) return ["", ""];
  const diff = price - base;
  const pct = base ? (diff / base) * 100 : 0;
  const cls = diff >= 0 ? "up" : "down";
  const sign = diff >= 0 ? "+" : "";
  return [`${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`, cls];
}

// ---- custom frozen crosshair ----

function metricLabel() {
  return state.metric === "pe" ? "P/E" : state.metric === "ps" ? "P/S" : "Price";
}
function fmtVal(v) {
  return state.metric === "price" ? "$" + fmtPrice(v) : fmtPrice(v);
}

// nearest data index to an x-scale value (handles differing per-chart lengths)
function nearestIdx(xs, val) {
  const n = xs.length;
  if (n === 0) return null;
  if (val <= xs[0]) return 0;
  if (val >= xs[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m] < val) lo = m + 1; else hi = m - 1; }
  return (Math.abs(xs[lo] - val) < Math.abs(xs[lo - 1] - val)) ? lo : lo - 1;
}

function hidePin(card) {
  if (card.vline) card.vline.style.display = "none";
  if (card.dot) card.dot.style.display = "none";
  if (card.tip) card.tip.style.display = "none";
}

// draw the crosshair on one chart at the global pinXval
function renderPin(card) {
  const u = card.chart;
  if (!u || pinXval == null) { hidePin(card); return; }
  const idx = nearestIdx(u.data[0], pinXval);
  if (idx == null) { hidePin(card); return; }
  const left = u.valToPos(u.data[0][idx], "x");
  card.vline.style.left = left + "px";
  card.vline.style.display = "block";

  const val = u.data[card.priceIdx][idx];
  if (val == null) { card.dot.style.display = "none"; card.tip.style.display = "none"; return; }
  card.dot.style.left = left + "px";
  card.dot.style.top = u.valToPos(val, "y") + "px";
  card.dot.style.display = "block";
  card.tip.innerHTML =
    `<b>${metricLabel()} = ${fmtVal(val)}</b><span class="t">${fmtTime(card.times[idx], state.range)}</span>`;
  card.tip.style.left = left + "px";
  card.tip.style.display = "block";
}

function renderPinAll() {
  for (const sym of state.symbols) {
    const c = state.cards[sym];
    if (c) renderPin(c);
  }
}

function renderCard(card, range, s, yRange) {
  if (card.chart) {
    card.chart.destroy();
    card.chart = null;
    card.vline = card.dot = card.tip = null;   // removed with the old plot DOM
  }
  card.el.classList.remove("empty");
  card.chartEl.innerHTML = "";   // clear any prior "no data" text or stale DOM

  if (!s || !s.c || s.c.filter((v) => v != null).length === 0) {
    card.el.classList.add("empty");
    card.chartEl.innerHTML = "no data";
    card.priceEl.textContent = "—";
    card.chgEl.textContent = "";
    return;
  }

  const valid = s.c.filter((v) => v != null);
  const last = valid[valid.length - 1];
  const base = (range === "1d" && s.prevClose != null) ? s.prevClose : valid[0];
  const col = last >= base ? UP : DOWN;
  const [chgTxt, chgCls] = changeText(last, base);

  card.priceEl.textContent = fmtPrice(last);
  card.priceEl.className = "price " + chgCls;
  card.chgEl.textContent = chgTxt;
  card.chgEl.className = "chg " + chgCls;

  card.times = s.t;               // tooltip/axis look up real timestamps here
  card.priceIdx = 1;

  let data, series, xScale, xAxis;
  const axisFont = "11px -apple-system, sans-serif";
  const xAxisBase = { stroke: GRAY, grid: { show: false }, ticks: { show: false },
                      font: axisFont, size: 30 };

  if (range === "1d" && s.session) {
    // real time axis (single day, small gaps), regular colored over gray full line
    const reg = s.c.map((v, i) => (s.session[i] === 1 ? v : null));
    data = [s.t, s.c, reg];
    series = [
      {},
      { stroke: GRAY, width: 1, points: { show: false } },
      { stroke: col, width: 2, fill: makeFill(col), points: { show: false } },
    ];
    xScale = { time: true };
    xAxis = { ...xAxisBase, values: intradayValues };
  } else {
    // ordinal axis: x = bar index, so overnight/weekend gaps collapse
    const xs = s.t.map((_, i) => i);
    data = [xs, s.c];
    series = [{}, { stroke: col, width: 2, fill: makeFill(col), points: { show: false } }];
    xScale = { time: false };
    const ticks = dayTickSplits(s.t, isMobile() ? 4 : 8);
    xAxis = { ...xAxisBase, splits: () => ticks, values: ordinalValues(s.t) };
  }

  const opts = {
    width: card.chartEl.clientWidth,
    height: card.chartEl.clientHeight,
    tzDate,
    legend: { show: false },
    cursor: {   // uPlot's own cursor is off; we draw a frozen-capable one ourselves
      x: false, y: false,
      points: { show: false },
      drag: { x: false, y: false },
    },
    scales: { x: xScale, y: yRange ? { range: yRange } : {} },
    axes: [
      xAxis,
      { side: 1, stroke: GRAY, grid: { stroke: "rgba(255,255,255,.05)", width: 1 },
        ticks: { show: false }, font: axisFont, size: 48 },
    ],
    series,
    plugins: [prevCloseLine(range === "1d" ? s.prevClose : null)],
  };

  card.chart = new uPlot(opts, data, card.chartEl);

  // crosshair overlay lives in the plotting area so coords map directly
  const over = card.chart.over;
  const vline = document.createElement("div"); vline.className = "vline";
  const dot = document.createElement("div"); dot.className = "dot";
  const tip = document.createElement("div"); tip.className = "tip";
  over.append(vline, dot, tip);
  card.vline = vline; card.dot = dot; card.tip = tip;

  // moving over any chart updates the shared pin; leaving keeps it frozen
  over.addEventListener("mousemove", (e) => {
    const rect = over.getBoundingClientRect();
    pinXval = card.chart.posToVal(e.clientX - rect.left, "x");
    renderPinAll();
  });

  renderPin(card);   // restore the frozen crosshair on this freshly-built chart
}

// ---------- data ----------

async function fetchHistory(range) {
  state.range = range;
  document.querySelectorAll("#ranges button").forEach((b) =>
    b.classList.toggle("active", b.dataset.range === range));

  statusEl.textContent = "Loading…";
  pinXval = null;   // a frozen crosshair from a different range/metric doesn't map cleanly
  const url = `/api/history?range=${encodeURIComponent(range)}` +
    `&metric=${encodeURIComponent(state.metric)}` +
    `&symbols=${encodeURIComponent(state.symbols.join(","))}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    state.lastSeries = json.series;
    applyRender();
    state.updatedAt = Date.now();
    renderStatus();
  } catch (e) {
    state.updatedAt = null;
    statusEl.textContent = "Error: " + e.message;
  }
}

// render the last-fetched data; recomputes the shared y-range when needed.
// Called by fetchHistory and by the y-axis toggle (no refetch -> keeps the pin).
function applyRender() {
  const series = state.lastSeries;
  if (!series) return;

  let yRange = null;
  if (state.yaxis === "shared") {
    let mn = Infinity, mx = -Infinity;
    for (const sym of state.symbols) {
      const s = series[sym];
      if (!s || !s.c) continue;
      for (const v of s.c) {
        if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; }
      }
    }
    if (mn <= mx) {
      const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
      yRange = [mn - pad, mx + pad];
    }
  }

  for (const sym of state.symbols) {
    renderCard(state.cards[sym], state.range, series[sym], yRange);
  }
  renderPinAll();
}

function renderStatus() {
  if (!state.updatedAt) return;
  const d = new Date(state.updatedAt);
  const clock = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const mins = Math.floor((Date.now() - state.updatedAt) / 60000);
  const ago = mins < 1 ? "just now"
    : mins === 1 ? "1 minute ago"
    : `${mins} minutes ago`;
  statusEl.textContent = `Updated ${clock} (${ago})`;
  statusEl.classList.toggle("stale", mins >= 10);
}

async function fetchStats() {
  try {
    const res = await fetch(`/api/stats?symbols=${encodeURIComponent(state.symbols.join(","))}`);
    const json = await res.json();
    if (json.error) return;
    for (const sym of state.symbols) {
      const card = state.cards[sym];
      if (card) card.statsEl.innerHTML = statsHTML(json.stats[sym]);
    }
    resizeAllCharts();   // stats row now occupies its space -> re-fit charts
  } catch (e) { /* stats are best-effort */ }
}

// ---------- events ----------

document.getElementById("ranges").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) fetchHistory(b.dataset.range);
});

document.getElementById("metrics").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.metric = b.dataset.metric;
  document.querySelectorAll("#metrics button").forEach((x) =>
    x.classList.toggle("active", x.dataset.metric === state.metric));
  fetchHistory(state.range);
});

document.getElementById("yaxis").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.yaxis = b.dataset.yaxis;
  document.querySelectorAll("#yaxis button").forEach((x) =>
    x.classList.toggle("active", x.dataset.yaxis === state.yaxis));
  applyRender();   // re-render from cached data; no refetch, keeps the frozen pin
});

// tap a ticker chip -> scroll its card to the top of the (scrolling) grid.
// the toolbar is outside the grid, so no manual offset is needed.
function jumpToCard(sym) {
  const c = state.cards[sym];
  if (!c) return;
  c.el.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("tickerNav").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) jumpToCard(b.dataset.sym);
});

document.getElementById("edit").addEventListener("click", () => {
  const input = prompt("Symbols (comma-separated):", state.symbols.join(", "));
  if (input == null) return;
  const list = input.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!list.length) return;
  state.symbols = sortSyms(list);
  saveSymbols(list);
  buildGrid();
  fetchHistory(state.range);
  fetchStats();
});

// re-measure every chart against its container's current height (fixes the
// race where charts render before the stats row has taken its space)
function resizeAllCharts() {
  for (const sym of state.symbols) {
    const c = state.cards[sym];
    if (c && c.chart) {
      c.chart.setSize({ width: c.chartEl.clientWidth, height: c.chartEl.clientHeight });
    }
  }
  renderPinAll();
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeAllCharts, 150);
});

// ---------- go ----------
buildGrid();
fetchHistory(state.range);
fetchStats();
setInterval(renderStatus, 60000);   // keep the "N minutes ago" fresh
