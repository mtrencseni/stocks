"use strict";

// Canvas renderers for the Backtest tab: an outcome-coloured price line, a
// returns histogram, and the Δ-sweep panels. DPR-aware, dependency-free.

const GRAY = "rgba(124,128,134,0.5)";
const AXIS = "rgba(154,160,166,0.9)";
const GRID = "rgba(255,255,255,0.06)";
const FONT = "11px -apple-system, system-ui, sans-serif";

// hold-length palette (used by sweep lines + the shared legend in the pane)
export const HOLD_COLORS = ["#5b9bd5", "#e8a13a", "#5f9e6e", "#d65b5b",
                            "#9b7fd4", "#8a6f5a", "#d98cc4"];

function mkCanvas(el) {
  el.innerHTML = "";
  const dpr = window.devicePixelRatio || 1;
  const W = el.clientWidth || 600, H = el.clientHeight || 220;
  const cv = document.createElement("canvas");
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = W + "px"; cv.style.height = H + "px"; cv.style.display = "block";
  el.appendChild(cv);
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, W, H };
}

// diverging colour: green wins / red losses, intensity ~ |return| / scale
function retColor(r, scale) {
  if (r == null) return GRAY;
  const a = 0.28 + 0.7 * Math.min(1, Math.abs(r) / (scale || 1));
  return r >= 0 ? `rgba(120,190,130,${a})` : `rgba(220,110,100,${a})`;
}

function niceTicks(lo, hi, n) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// ---- outcome-coloured price line --------------------------------------------

export function renderOutcomePrice(el, t, c, out, resolved, scale) {
  const { ctx, W, H } = mkCanvas(el);
  const padL = 46, padR = 8, padT = 10, padB = 22;
  const n = c.length;
  let lo = Infinity, hi = -Infinity;
  for (const v of c) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
  const x = (i) => padL + (W - padL - padR) * (n <= 1 ? 0 : i / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  // stash geometry/data so the pane can draw a hover crosshair + tooltip
  el.__price = { t, c, out, resolved, padL, padR, padT, padB };

  ctx.font = FONT; ctx.fillStyle = AXIS; ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const v of niceTicks(lo, hi, 4)) {
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText("$" + (v >= 100 ? v.toFixed(0) : v.toFixed(1)), padL - 5, yy);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let k = 0; k < 4; k++) {
    const i = Math.round((n - 1) * k / 3);
    ctx.fillText(fmtDate(t[i]), x(i), H - padB + 5);
  }

  ctx.lineWidth = 2; ctx.lineCap = "round";
  for (let i = 0; i < n - 1; i++) {
    const col = (out[i] != null && resolved[i]) ? retColor(out[i], scale) : GRAY;
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(x(i), y(c[i])); ctx.lineTo(x(i + 1), y(c[i + 1])); ctx.stroke();
  }
}

// ---- returns histogram ------------------------------------------------------

export function renderHistogram(el, hist, scale) {
  const { ctx, W, H } = mkCanvas(el);
  const padL = 34, padR = 8, padT = 10, padB = 28;
  if (!hist || !hist.counts.length) return;
  const edges = hist.edges, counts = hist.counts, nb = counts.length;
  const xlo = edges[0], xhi = edges[nb];
  const ymax = Math.max(...counts, 1);
  const x = (v) => padL + (W - padL - padR) * (v - xlo) / (xhi - xlo || 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / ymax);

  ctx.font = FONT; ctx.fillStyle = AXIS; ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const v of niceTicks(0, ymax, 3)) {
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(String(Math.round(v)), padL - 4, yy);
  }
  for (let b = 0; b < nb; b++) {
    const x0 = x(edges[b]), x1 = x(edges[b + 1]);
    const mid = (edges[b] + edges[b + 1]) / 2;
    ctx.fillStyle = retColor(mid, scale);
    const yy = y(counts[b]);
    ctx.fillRect(x0 + 0.5, yy, Math.max(1, x1 - x0 - 1), y(0) - yy);
  }
  // zero line + x labels
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
  if (xlo < 0 && xhi > 0) { ctx.beginPath(); ctx.moveTo(x(0), padT); ctx.lineTo(x(0), H - padB); ctx.stroke(); }
  ctx.fillStyle = AXIS; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const v of niceTicks(xlo, xhi, 5)) ctx.fillText(v.toFixed(0) + "%", x(v), H - padB + 6);
  ctx.fillText("return per trade", (padL + W - padR) / 2, H - 12);
}

// ---- one Δ-sweep panel ------------------------------------------------------
// lines: [{days, values:[per delta], color}]; sel: {delta, days}; yfmt(v)->label
export function renderSweepPanel(el, title, deltas, lines, sel, yfmt) {
  const { ctx, W, H } = mkCanvas(el);
  const padL = 42, padR = 10, padT = 16, padB = 26;
  // stash geometry/data so the pane can hit-test for hover tooltips
  el.__sweep = { deltas, lines, padL, padR, yfmt, title };
  let lo = Infinity, hi = -Infinity;
  for (const ln of lines) for (const v of ln.values) {
    if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  if (!(hi > lo)) { lo = 0; hi = 1; }
  const padv = (hi - lo) * 0.08 || 0.1; lo -= padv; hi += padv;
  const dlo = deltas[0], dhi = deltas[deltas.length - 1];
  const x = (d) => padL + (W - padL - padR) * (d - dlo) / (dhi - dlo || 1);
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));

  ctx.font = FONT; ctx.fillStyle = AXIS;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(title, padL, 4);
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const v of niceTicks(lo, hi, 4)) {
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillStyle = AXIS; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(yfmt(v), padL - 4, yy);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  for (const d of deltas) ctx.fillText(d.toFixed(1), x(d), H - 7);

  // vertical marker at the selected Δ
  if (sel && sel.delta != null) {
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(sel.delta), padT); ctx.lineTo(x(sel.delta), H - padB); ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const ln of lines) {
    const isSel = sel && ln.days === sel.days;
    ctx.strokeStyle = ln.color; ctx.lineWidth = isSel ? 3 : 1.25;
    ctx.globalAlpha = isSel ? 1 : 0.7;
    ctx.beginPath();
    let started = false;
    deltas.forEach((d, i) => {
      const v = ln.values[i]; if (v == null) return;
      const px = x(d), py = y(v);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true;
    });
    ctx.stroke();
    deltas.forEach((d, i) => {
      const v = ln.values[i]; if (v == null) return;
      ctx.fillStyle = ln.color;
      ctx.beginPath(); ctx.arc(x(d), y(v), isSel ? 3 : 2, 0, 2 * Math.PI); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
}
