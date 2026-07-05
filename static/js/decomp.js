"use strict";

// Shared factor-decomposition chart: the stock's actual cumulative % vs the
// factor-fitted sum (α + Σβ·factor), each contribution as a line, and the
// actual↔fitted gap shaded purple (the residual ε). Used by the Factors pane
// drawer and the stock detail page.
//
// Hover: vertical line + a dot on every visible line + a tooltip listing the
// component values. The legend chips toggle individual lines.

import { GRAY, dayTickSplits, ordinalValues, etYMD } from "./util.js";
import { indLabel, escapeHTML } from "./filters.js";

export const DECOMP_COLORS = {
  mkt: "#6ea8fe", ind: "#f0c040", mom: "#e08fbe",
  alpha: "#89c996", fitted: "#9aa0a6", resid: "rgba(160,108,213,0.20)",
};

const fmt = (v) => v == null ? "—" : (Math.round(v * 100) / 100).toString();
const spp = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);   // signed percentage points

// beta fingerprint: the three loadings as horizontal bars on one shared
// symmetric scale, so exposure *shape* is comparable across stocks
function fingerprintHTML(d) {
  const C = DECOMP_COLORS;
  const rows = [
    ["β·SPY", d.b_mkt, C.mkt],
    [`β·${escapeHTML(d.etf || "IND")}`, d.b_ind, C.ind],
    ["β·MTUM", d.b_mom, C.mom],
  ];
  const S = Math.max(1, ...rows.map(([, v]) => Math.abs(v || 0)));   // scale = max |β|
  return rows.map(([label, v, color]) => {
    const b = v || 0;
    const w = Math.abs(b) / S * 50;                    // % of half-track
    const left = b >= 0 ? 50 : 50 - w;
    return `<div class="fp-row"><span class="fp-l">${label}</span>` +
      `<div class="fp-track"><i class="fp-zero"></i>` +
      `<i class="fp-bar" style="left:${left}%;width:${w}%;background:${color}"></i></div>` +
      `<span class="fp-v">${fmt(v)}</span></div>`;
  }).join("");
}

// contribution bar: the lookback's total return split into factor / alpha /
// residual percentage points — negatives left of the divider, positives right
function contributionHTML(d) {
  const p = d.paths || {};
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const actual = last(p.actual), fitted = last(p.fitted);
  if (actual == null || fitted == null) return "";
  const C = DECOMP_COLORS;
  const parts = [
    ["mkt", last(p.mkt), C.mkt],
    [escapeHTML(d.etf || "ind"), last(p.ind), C.ind],
    ["mom", last(p.mom), C.mom],
    ["α", last(p.alpha), C.alpha],
    ["ε", actual - fitted, "rgba(160,108,213,0.8)"],
  ].filter(([, v]) => v != null && Math.abs(v) > 0.05);
  const total = parts.reduce((a, [, v]) => a + Math.abs(v), 0) || 1;
  const seg = ([label, v, color]) =>
    `<i class="cb-seg" style="width:${(Math.abs(v) / total * 100).toFixed(2)}%;background:${color}"` +
    ` title="${label} ${spp(v)}pp"></i>`;
  const negs = parts.filter(([, v]) => v < 0);
  const poss = parts.filter(([, v]) => v >= 0);
  const cap = parts.map(([label, v, color]) =>
    `<span class="cb-item"><i style="background:${color}"></i>${label} ${spp(v)}</span>`).join("");
  return `<div class="cb-title">${escapeHTML(d.lookback || "")} return ` +
      `<b class="${actual >= 0 ? "up" : "down"}">${spp(actual)}%</b> =</div>` +
    `<div class="cb-bar">${negs.map(seg).join("")}<i class="cb-zero"></i>${poss.map(seg).join("")}</div>` +
    `<div class="cb-cap">${cap}</div>`;
}

// d = /api/factors/detail payload. opts: {onClose?, compact?} — compact drops
// the "SYM = factors + α − ε" prefix (the host card already has a title).
// Returns { resize, destroy }.
export function renderDecomp(rootEl, d, opts = {}) {
  const C = DECOMP_COLORS;
  const chip = (color, label, si) =>
    `<span class="fd-chip${si ? " fd-tog" : ""}"${si ? ` data-si="${si}" title="Click to show/hide"` : ""}>` +
    `<i style="background:${color}"></i>${label}</span>`;
  rootEl.innerHTML =
    `<div class="fd-head">` +
      (opts.compact ? "" :
        `<b>${escapeHTML(d.symbol)}</b>` +
        `<span class="fd-sub">= factors + α − ε · ${escapeHTML(indLabel(d.etf))}</span>`) +
      chip("var(--text)", "actual", 1) +
      chip(C.fitted, "fitted (Σ)", 2) +
      chip(C.mkt, `β·SPY ${fmt(d.b_mkt)}`, 3) +
      chip(C.ind, `β·${escapeHTML(d.etf)} ${fmt(d.b_ind)}`, 4) +
      chip(C.mom, `β·MTUM ${fmt(d.b_mom)}`, 5) +
      chip(C.alpha, `α ${fmt(d.alpha)}%/yr`, 6) +
      chip("rgba(160,108,213,0.8)", `residual (area) · R² ${fmt(d.r2)}%`) +
      (opts.onClose ? `<button class="fd-close" title="Close">×</button>` : "") +
    `</div>` +
    `<div class="fd-extras">` +
      `<div class="fd-fp">${fingerprintHTML(d)}</div>` +
      `<div class="fd-cb">${contributionHTML(d)}</div>` +
    `</div>` +
    `<div class="fd-chart"></div>`;
  if (opts.onClose) {
    rootEl.querySelector(".fd-close").addEventListener("click", opts.onClose);
  }

  const el = rootEl.querySelector(".fd-chart");
  if (!d.t || d.t.length < 2) {
    el.innerHTML = `<div class="fd-loading">no data</div>`;
    return { resize() {}, destroy() {} };
  }

  const xs = d.t.map((_, i) => i);
  const p = d.paths;
  const data = [xs, p.actual, p.fitted, p.mkt, p.ind, p.mom, p.alpha];
  const text = getComputedStyle(document.body).getPropertyValue("--text").trim() || "#e6e6e6";
  const axisFont = "11px -apple-system, sans-serif";
  const ticks = dayTickSplits(d.t, 6);
  const lineOpt = (color, width, dash) =>
    ({ stroke: color, width, points: { show: false }, ...(dash ? { dash } : {}) });
  const uopts = {
    width: el.clientWidth, height: el.clientHeight,
    legend: { show: false },
    cursor: { x: false, y: false, points: { show: false }, drag: { x: false, y: false } },
    scales: { x: { time: false } },
    axes: [
      { stroke: GRAY, grid: { show: false }, ticks: { show: false }, font: axisFont,
        size: 30, splits: () => ticks, values: ordinalValues(d.t) },
      { side: 1, stroke: GRAY, grid: { stroke: "rgba(128,128,128,.12)", width: 1 },
        ticks: { show: false }, font: axisFont, size: 52,
        values: (u, vs) => vs.map((v) => v + "%") },
    ],
    series: [
      {},
      lineOpt(text, 2),                      // 1: actual
      lineOpt(C.fitted, 1.5, [6, 4]),        // 2: fitted = sum of factors + alpha
      lineOpt(C.mkt, 1),                     // 3: market contribution
      lineOpt(C.ind, 1),                     // 4: industry contribution
      lineOpt(C.mom, 1),                     // 5: momentum contribution
      lineOpt(C.alpha, 1, [2, 3]),           // 6: alpha drift
    ],
    // purple shading between actual and fitted = the residual (both signs)
    bands: [
      { series: [1, 2], fill: C.resid },
      { series: [2, 1], fill: C.resid },
    ],
  };
  const u = new uPlot(uopts, data, el);

  // legend chips toggle their line
  const meta = [
    [1, "actual", text], [2, "fitted Σ", C.fitted], [3, "β·SPY", C.mkt],
    [4, `β·${d.etf}`, C.ind], [5, "β·MTUM", C.mom], [6, "α", C.alpha],
  ];
  const dots = {};
  rootEl.querySelectorAll(".fd-tog").forEach((elc) => {
    elc.addEventListener("click", () => {
      const si = +elc.dataset.si;
      const show = !u.series[si].show;
      u.setSeries(si, { show });
      elc.classList.toggle("off", !show);
      if (!show && dots[si]) dots[si].style.display = "none";
    });
  });

  // hover: vline + per-line dots + component tooltip
  const over = u.over;
  const vline = document.createElement("div"); vline.className = "vline";
  const tip = document.createElement("div"); tip.className = "tip fd-tip";
  over.append(vline, tip);
  for (const [si, , color] of meta) {
    const dot = document.createElement("div");
    dot.className = "fd-dot";
    dot.style.background = color;
    over.appendChild(dot);
    dots[si] = dot;
  }
  over.addEventListener("mousemove", (e) => {
    const rect = over.getBoundingClientRect();
    let idx = Math.round(u.posToVal(e.clientX - rect.left, "x"));
    idx = Math.max(0, Math.min(xs.length - 1, idx));
    const left = u.valToPos(idx, "x");
    vline.style.left = left + "px";
    vline.style.display = "block";
    const rows = [];
    for (const [si, label, color] of meta) {
      const dot = dots[si];
      const v = data[si][idx];
      if (!u.series[si].show || v == null) {
        dot.style.display = "none";
        continue;
      }
      dot.style.left = left + "px";
      dot.style.top = u.valToPos(v, "y") + "px";
      dot.style.display = "block";
      rows.push(`<span class="fdt-row"><i style="background:${color}"></i>${label}` +
                `<b>${(v >= 0 ? "+" : "") + v.toFixed(1)}%</b></span>`);
    }
    const resid = (data[1][idx] != null && data[2][idx] != null)
      ? data[1][idx] - data[2][idx] : null;
    tip.innerHTML =
      `<span class="t">${etYMD(new Date(d.t[idx] * 1000))}</span>${rows.join("")}` +
      (resid == null ? "" :
        `<span class="fdt-row"><i style="background:rgba(160,108,213,0.8)"></i>residual` +
        `<b>${(resid >= 0 ? "+" : "") + resid.toFixed(1)}%</b></span>`);
    tip.style.left = "";
    tip.style.right = "";
    if (left < over.clientWidth / 2) tip.style.left = (left + 10) + "px";
    else tip.style.right = (over.clientWidth - left + 10) + "px";
    tip.style.display = "flex";
  });
  over.addEventListener("mouseleave", () => {
    vline.style.display = "none";
    tip.style.display = "none";
    for (const si in dots) dots[si].style.display = "none";
  });

  return {
    resize() { u.setSize({ width: el.clientWidth, height: el.clientHeight }); },
    destroy() { u.destroy(); },
  };
}
