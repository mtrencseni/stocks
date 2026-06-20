"use strict";

// The uPlot chart "card" + a frozen, *pane-scoped* synced crosshair.
//
// The crosshair is drawn by us (not uPlot's cursor) so it can stay frozen on
// every chart after the mouse leaves. Each pane owns one CrosshairGroup, so the
// sync is scoped to that pane's charts only (no leaking across panes).

import {
  UP, DOWN, GRAY, tzDate, fmtPrice, changeText, statsHTML,
  intradayValues, dayTickSplits, ordinalValues, makeFill, prevCloseLine,
  metricLabel, fmtVal, fmtTime, nearestIdx, rgba, etYMD, fmtMoneyM,
} from "./util.js";

export class CrosshairGroup {
  constructor() { this.pinXval = null; this.cards = []; }
  clear() { this.cards = []; this.pinXval = null; }
  reset() { this.pinXval = null; this.renderAll(); }   // e.g. on range/metric change
  renderAll() { for (const c of this.cards) renderPin(c, this); }
}

function hidePin(card) {
  if (card.vline) card.vline.style.display = "none";
  if (card.dot) card.dot.style.display = "none";
  if (card.tip) card.tip.style.display = "none";
}

// draw the crosshair on one chart at the group's pinXval
function renderPin(card, group) {
  const u = card.chart;
  if (!u || group.pinXval == null) { hidePin(card); return; }
  const idx = nearestIdx(u.data[0], group.pinXval);
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
    `<b>${metricLabel(card.metric)} = ${fmtVal(card.metric, val)}</b>` +
    `<span class="t">${fmtTime(card.times[idx], card.range)}</span>`;
  card.tip.style.left = left + "px";
  card.tip.style.display = "block";
}

// build the card DOM and return its handle object
export function buildCard(sym) {
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
  return {
    sym, el,
    chartEl: el.querySelector(".chart"),
    priceEl: el.querySelector(".price"),
    chgEl: el.querySelector(".chg"),
    statsEl: el.querySelector(".stats"),
    chart: null, vline: null, dot: null, tip: null,
    priceIdx: 1,
    range: null, metric: null, times: null,
  };
}

// (re)render a card's chart from a series object. opts: {range, metric, series, yRange, group}
export function renderCard(card, opts) {
  const { range, metric, series: s, yRange, group } = opts;

  if (card.chart) {
    card.chart.destroy();
    card.chart = null;
    card.vline = card.dot = card.tip = null;   // removed with the old plot DOM
  }
  card.el.classList.remove("empty");
  card.chartEl.innerHTML = "";   // clear any prior "no data" text or stale DOM
  card.range = range;
  card.metric = metric;

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

  let data, seriesOpt, xScale, xAxis;
  const axisFont = "11px -apple-system, sans-serif";
  const xAxisBase = { stroke: GRAY, grid: { show: false }, ticks: { show: false },
                      font: axisFont, size: 30 };

  if (range === "1d" && s.session) {
    // real time axis (single day, small gaps), regular colored over gray full line
    const reg = s.c.map((v, i) => (s.session[i] === 1 ? v : null));
    data = [s.t, s.c, reg];
    seriesOpt = [
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
    seriesOpt = [{}, { stroke: col, width: 2, fill: makeFill(col), points: { show: false } }];
    xScale = { time: false };
    const ticks = dayTickSplits(s.t, 4);
    xAxis = { ...xAxisBase, splits: () => ticks, values: ordinalValues(s.t) };
  }

  const uopts = {
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
    series: seriesOpt,
    plugins: [prevCloseLine(range === "1d" ? s.prevClose : null)],
  };

  card.chart = new uPlot(uopts, data, card.chartEl);

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
    group.pinXval = card.chart.posToVal(e.clientX - rect.left, "x");
    group.renderAll();
  });

  renderPin(card, group);   // restore the frozen crosshair on this freshly-built chart
}

// ---- zigzag (upswing) view ----

// Alternating zigzag pivots over a price array: [{idx, price, kind:'H'|'L'}],
// strictly alternating, each leg a confirmed >=threshold reversal. (JS port of
// screener.py's _zigzag, tracking indices.)
function zigzagPivots(arr, threshold = 0.40) {
  const n = arr.length;
  if (n < 40) return [];
  const pivots = [];
  let direction = 0, candVal = arr[0], candIdx = 0, init = false;
  for (let i = 1; i < n; i++) {
    const p = arr[i];
    if (!init) {
      if (p > candVal) { candVal = p; candIdx = i; }
      if (candVal / arr[0] - 1 >= threshold) {        // first move up -> start was a low
        let mx = 0; for (let k = 0; k <= i; k++) if (arr[k] > arr[mx]) mx = k;
        let mb = 0; for (let k = 0; k <= mx; k++) if (arr[k] < arr[mb]) mb = k;
        pivots.push({ idx: mb, price: arr[mb], kind: "L" });
        pivots.push({ idx: mx, price: arr[mx], kind: "H" });
        direction = -1; candVal = p; candIdx = i; init = true; continue;
      }
      let mn = 0; for (let k = 0; k <= i; k++) if (arr[k] < arr[mn]) mn = k;
      if (arr[0] / arr[mn] - 1 >= threshold) {         // first move down -> start was a high
        pivots.push({ idx: 0, price: arr[0], kind: "H" });
        pivots.push({ idx: mn, price: arr[mn], kind: "L" });
        direction = 1; candVal = p; candIdx = i; init = true; continue;
      }
    } else if (direction === 1) {
      if (p > candVal) { candVal = p; candIdx = i; }
      else if (candVal / p - 1 >= threshold) {
        pivots.push({ idx: candIdx, price: candVal, kind: "H" });
        direction = -1; candVal = p; candIdx = i;
      }
    } else {
      if (p < candVal) { candVal = p; candIdx = i; }
      else if (p / candVal - 1 >= threshold) {
        pivots.push({ idx: candIdx, price: candVal, kind: "L" });
        direction = 1; candVal = p; candIdx = i;
      }
    }
  }
  return pivots;
}

function zzPrice(v) {
  return "$" + (v < 10 ? v.toFixed(2) : v.toFixed(0));
}

// a tooltip-style framed chip centered at (x, y); sizes already in device px
function drawChip(ctx, x, y, text, fg, dpr) {
  const w = ctx.measureText(text).width;
  const bw = w + 10 * dpr, bh = 18 * dpr;
  const bx = x - bw / 2, by = y - bh / 2, r = 4 * dpr;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
  else ctx.rect(bx, by, bw, bh);
  ctx.fillStyle = "#0b0b0c"; ctx.fill();
  ctx.lineWidth = 1 * dpr; ctx.strokeStyle = "#2f3138"; ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

// gold pivot dots + a framed $ price at each pivot + a framed % move on each leg
// (green up-leg = buy-the-low/sell-the-high gain; red down-leg = peak-to-trough loss).
// tail = the provisional in-progress swing after the last confirmed pivot (or null).
function zigzagLabels(pivots, tail) {
  return { hooks: { draw: (u) => {
    const dpr = window.devicePixelRatio || 1;   // uPlot's canvas is in device px
    const ctx = u.ctx;
    const bold = `bold ${Math.round(12 * dpr)}px -apple-system, sans-serif`;
    const norm = `${Math.round(12 * dpr)}px -apple-system, sans-serif`;
    ctx.save();

    // pivot dots
    ctx.fillStyle = "#f0c040";
    for (const pv of pivots) {
      const x = u.valToPos(pv.idx, "x", true);
      const y = u.valToPos(pv.price, "y", true);
      ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.fill();
    }

    // per-leg % change, framed, at the leg's midpoint
    ctx.font = bold;
    for (let i = 0; i < pivots.length - 1; i++) {
      const a = pivots[i], b = pivots[i + 1];
      const pct = (b.price / a.price - 1) * 100;
      const mx = u.valToPos((a.idx + b.idx) / 2, "x", true);
      const my = u.valToPos((a.price + b.price) / 2, "y", true);
      const txt = (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%";
      drawChip(ctx, mx, my, txt, b.kind === "H" ? UP : DOWN, dpr);
    }

    // provisional tail: "% so far" at its midpoint + current-price dot/chip
    if (tail) {
      const pct = (tail.lastPrice / tail.from.price - 1) * 100;
      ctx.font = bold;
      const mx = u.valToPos((tail.from.idx + tail.lastIdx) / 2, "x", true);
      const my = u.valToPos((tail.from.price + tail.lastPrice) / 2, "y", true);
      drawChip(ctx, mx, my, (pct >= 0 ? "+" : "") + pct.toFixed(0) + "% so far", tail.color, dpr);
      const ex = u.valToPos(tail.lastIdx, "x", true);
      const ey = u.valToPos(tail.lastPrice, "y", true);
      ctx.fillStyle = tail.color;
      ctx.beginPath(); ctx.arc(ex, ey, 3 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.font = norm;
      drawChip(ctx, ex, tail.up ? ey - 14 * dpr : ey + 14 * dpr, zzPrice(tail.lastPrice), "#c6c7ca", dpr);
    }

    // framed $ price at each pivot (highs above the dot, lows below)
    ctx.font = norm;
    for (const pv of pivots) {
      const x = u.valToPos(pv.idx, "x", true);
      const y = u.valToPos(pv.price, "y", true);
      const isH = pv.kind === "H";
      drawChip(ctx, x, isH ? y - 14 * dpr : y + 14 * dpr, zzPrice(pv.price), "#c6c7ca", dpr);
    }
    ctx.restore();
  } } };
}

// dashed vertical lines at quarterly earnings, colored by hit/miss + surprise %
function earningsLines(marks) {
  return { hooks: { draw: (u) => {
    if (!marks.length) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = u.ctx;
    const top = u.bbox.top, bot = u.bbox.top + u.bbox.height;
    ctx.save();
    ctx.font = `${Math.round(11 * dpr)}px -apple-system, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const m of marks) {
      const x = u.valToPos(m.idx, "x", true);
      const col = m.beat == null ? GRAY : m.beat ? UP : DOWN;
      ctx.strokeStyle = col; ctx.globalAlpha = m.projected ? 0.3 : 0.55; ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (m.pct != null) {
        ctx.fillStyle = col;
        ctx.fillText((m.pct >= 0 ? "+" : "") + m.pct.toFixed(0) + "%", x, top + 2 * dpr);
      }
    }
    ctx.restore();
  } } };
}

// Static colored zigzag: gray full line, green up-legs, red down-legs, gold
// pivots, plus dashed earnings markers. Ordinal x (collapses gaps). No crosshair.
export function renderZigzag(chartEl, t, c, earnings) {
  chartEl.innerHTML = "";
  const pivots = zigzagPivots(c);
  const up = new Array(c.length).fill(null);
  const down = new Array(c.length).fill(null);
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i], b = pivots[i + 1];
    const tgt = b.kind === "H" ? up : down;
    for (let k = a.idx; k <= b.idx; k++) tgt[k] = c[k];   // inclusive ends so legs meet
  }

  // provisional in-progress leg after the last confirmed pivot, drawn dashed:
  // after a Low we're rising (green), after a High we're falling (red).
  const last = c.length - 1;
  const tailArr = new Array(c.length).fill(null);
  let tail = null;
  if (pivots.length) {
    const lp = pivots[pivots.length - 1];
    if (lp.idx < last) {
      const isUp = lp.kind === "L";
      for (let k = lp.idx; k <= last; k++) tailArr[k] = c[k];
      tail = { color: isUp ? UP : DOWN, up: isUp, from: lp, lastIdx: last, lastPrice: c[last] };
    }
  } else if (c.length >= 2) {                  // never a confirmed reversal -> one provisional leg
    const isUp = c[last] >= c[0];
    for (let k = 0; k <= last; k++) tailArr[k] = c[k];
    tail = { color: isUp ? UP : DOWN, up: isUp, from: { idx: 0, price: c[0] }, lastIdx: last, lastPrice: c[last] };
  }

  // map each in-window earnings date to a bar index for the vertical markers.
  // real reports are colored by hit/miss; if real data doesn't reach the start
  // of the window, project the ~quarterly cadence backward (neutral, no %) to
  // fill earlier years — approximate timing, per "just shift it back".
  const marks = [];
  if (earnings && earnings.past && t.length) {
    const t0 = t[0], t1 = t[t.length - 1];
    const targets = [];
    for (const r of earnings.past) {
      const target = new Date(r.date + "T16:00:00Z").getTime() / 1000;
      targets.push(target);
      if (target < t0 - 5 * 86400 || target > t1 + 5 * 86400) continue;
      const idx = nearestIdx(t, target);
      if (idx != null) marks.push({ idx, beat: r.beat, pct: r.surprisePct });
    }
    const earliest = targets.length ? Math.min(...targets) : null;
    if (earliest != null && earliest > t0) {
      const Q = 91 * 86400;   // ~one quarter
      for (let d = earliest - Q; d >= t0; d -= Q) {
        const idx = nearestIdx(t, d);
        if (idx != null) marks.push({ idx, beat: null, pct: null, projected: true });
      }
    }
  }

  const xs = t.map((_, i) => i);
  const ticks = dayTickSplits(t, 4);
  const axisFont = "11px -apple-system, sans-serif";
  const opts = {
    width: chartEl.clientWidth,
    height: chartEl.clientHeight,
    tzDate,
    legend: { show: false },
    cursor: { x: false, y: false, points: { show: false }, drag: { x: false, y: false } },
    scales: { x: { time: false }, y: {} },
    axes: [
      { stroke: GRAY, grid: { show: false }, ticks: { show: false }, font: axisFont,
        size: 30, splits: () => ticks, values: ordinalValues(t) },
      { side: 1, stroke: GRAY, grid: { stroke: "rgba(255,255,255,.05)", width: 1 },
        ticks: { show: false }, font: axisFont, size: 48 },
    ],
    series: [
      {},
      { stroke: GRAY, width: 1, points: { show: false } },
      { stroke: UP, width: 2, points: { show: false } },
      { stroke: DOWN, width: 2, points: { show: false } },
      { stroke: tail ? tail.color : GRAY, width: 2, dash: [6, 4], points: { show: false } },
    ],
    plugins: [earningsLines(marks), zigzagLabels(pivots, tail)],
  };
  const u = new uPlot(opts, [xs, c, up, down, tailArr], chartEl);

  // own live crosshair + tooltip: follows the mouse, hides on leave, and is NOT
  // wired to any CrosshairGroup, so it stays independent of the metric charts.
  const over = u.over;
  const vline = document.createElement("div"); vline.className = "vline";
  const dot = document.createElement("div"); dot.className = "dot";
  const tip = document.createElement("div"); tip.className = "tip";
  over.append(vline, dot, tip);
  over.addEventListener("mousemove", (e) => {
    const rect = over.getBoundingClientRect();
    const idx = Math.max(0, Math.min(c.length - 1,
      Math.round(u.posToVal(e.clientX - rect.left, "x"))));
    const left = u.valToPos(idx, "x");
    vline.style.left = left + "px"; vline.style.display = "block";
    const val = c[idx];
    if (val == null) { dot.style.display = "none"; tip.style.display = "none"; return; }
    dot.style.left = left + "px";
    dot.style.top = u.valToPos(val, "y") + "px";
    dot.style.display = "block";
    tip.innerHTML = `<b>Price = $${fmtPrice(val)}</b>` +
      `<span class="t">${fmtTime(t[idx], "3y")}</span>`;
    tip.style.left = left + "px"; tip.style.display = "block";
  });
  over.addEventListener("mouseleave", () => {
    vline.style.display = "none"; dot.style.display = "none"; tip.style.display = "none";
  });
  return u;
}

// ---- quarterly financials (bars = point-quarterly, line = trailing-4Q TTM) ----

// Standalone chart: quarterly bars (green positive / red negative loss quarters)
// with a trailing-4-quarter (TTM) rolling-sum line on top, sharing one y-axis
// (so the TTM line naturally sits ~4x above the quarterly bars). Ordinal x: one
// slot per quarter. Own live hover tooltip; not wired to any CrosshairGroup.
// series obj: { t:[epoch...], q:[quarterly...], ttm:[trailing-4Q...] }, $millions.
// year-over-year % vs the same quarter (4 slots) back; null if not comparable
function yoyPct(arr, idx) {
  if (idx < 4) return null;
  const cur = arr[idx], prev = arr[idx - 4];
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev) * 100;
}
function fmtPct(v) { return v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(0) + "%"; }

export function renderQuarterly(chartEl, { t, q, ttm }) {
  chartEl.innerHTML = "";
  const n = t.length;
  if (!n) return null;
  const xs = t.map((_, i) => i);
  const pos = q.map((v) => (v != null && v >= 0 ? v : null));   // green bars
  const neg = q.map((v) => (v != null && v < 0 ? v : null));    // red bars (losses)
  const ticks = dayTickSplits(t, 5);
  const axisFont = "11px -apple-system, sans-serif";
  const bars = uPlot.paths.bars({ size: [0.66, 60], align: 0 });
  const ttmBars = uPlot.paths.bars({ size: [0.30, 30], align: 0 });   // narrower, sits behind

  const opts = {
    width: chartEl.clientWidth,
    height: chartEl.clientHeight,
    tzDate,
    legend: { show: false },
    cursor: { x: false, y: false, points: { show: false }, drag: { x: false, y: false } },
    scales: {
      x: { time: false, range: () => [-0.7, n - 0.3] },   // half-bar padding both ends
      // force 0 into the range so bars draw from the zero baseline (and losses go below)
      y: { range: (u, dmin, dmax) => uPlot.rangeNum(Math.min(0, dmin), Math.max(0, dmax), 0.1, true) },
    },
    axes: [
      { stroke: GRAY, grid: { show: false }, ticks: { show: false }, font: axisFont,
        size: 30, splits: () => ticks, values: ordinalValues(t) },
      { side: 1, stroke: GRAY, grid: { stroke: "rgba(255,255,255,.05)", width: 1 },
        ticks: { show: false }, font: axisFont, size: 56,
        values: (u, sp) => sp.map((v) => fmtMoneyM(v)) },
    ],
    series: [
      {},
      // TTM (trailing-4Q) first so it renders BEHIND: narrow bars + dots
      { paths: ttmBars, fill: rgba("#c6c7ca", 0.16), stroke: rgba("#c6c7ca", 0.45), width: 1,
        points: { show: true, size: 5, fill: "#c6c7ca", stroke: "#c6c7ca" } },
      { paths: bars, fill: rgba(UP, 0.5), stroke: rgba(UP, 0.9), width: 1, points: { show: false } },
      { paths: bars, fill: rgba(DOWN, 0.5), stroke: rgba(DOWN, 0.9), width: 1, points: { show: false } },
    ],
  };
  const u = new uPlot(opts, [xs, ttm, pos, neg], chartEl);

  // own live crosshair + tooltip (quarter date, quarterly value, TTM)
  const over = u.over;
  const vline = document.createElement("div"); vline.className = "vline";
  const dot = document.createElement("div"); dot.className = "dot";
  const tip = document.createElement("div"); tip.className = "tip";
  over.append(vline, dot, tip);
  over.addEventListener("mousemove", (e) => {
    const rect = over.getBoundingClientRect();
    const idx = Math.max(0, Math.min(n - 1, Math.round(u.posToVal(e.clientX - rect.left, "x"))));
    const left = u.valToPos(idx, "x");
    vline.style.left = left + "px"; vline.style.display = "block";
    const qv = q[idx], tv = ttm[idx];
    if (qv != null) {
      dot.style.left = left + "px";
      dot.style.top = u.valToPos(qv, "y") + "px";
      dot.style.display = "block";
    } else { dot.style.display = "none"; }
    const qy = yoyPct(q, idx), ty = yoyPct(ttm, idx);
    tip.innerHTML =
      `<b>${fmtMoneyM(qv)}</b><span class="t">${etYMD(new Date(t[idx] * 1000))}</span>` +
      (qy != null ? `<div class="tip-sub">Qtr YoY ${fmtPct(qy)}</div>` : "") +
      (tv != null ? `<div class="tip-sub">TTM ${fmtMoneyM(tv)}${ty != null ? ` · YoY ${fmtPct(ty)}` : ""}</div>` : "");
    tip.style.left = left + "px"; tip.style.display = "block";
  });
  over.addEventListener("mouseleave", () => {
    vline.style.display = "none"; dot.style.display = "none"; tip.style.display = "none";
  });
  return u;
}
