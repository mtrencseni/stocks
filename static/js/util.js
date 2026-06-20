"use strict";

// shared constants, formatters and small helpers (no pane/DOM-state logic)

export const UP = "#89c996";    // RGB(137,201,150), matches --up
export const DOWN = "#ec8a82";  // RGB(236,138,130), matches --down
export const GRAY = "#9aa0a6";
export const TZ = "America/New_York";

// render all charts in US market time, regardless of the viewer's timezone
export const tzDate = (ts) => uPlot.tzDate(new Date(ts * 1000), TZ);

// narrow screens (phones) get fewer date ticks so they don't overlap
export function isMobile() { return window.matchMedia("(max-width: 760px)").matches; }

export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function fmtPrice(v) { return v == null ? "—" : v.toFixed(2); }

export function fmtCap(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  return v.toFixed(0);
}

// format a value already expressed in $millions (e.g. macrotrends revenue):
// 81615 -> "$81.62B", -1200 -> "-$1.20B". Sign goes before the $.
export function fmtMoneyM(m) {
  if (m == null) return "—";
  return (m < 0 ? "-$" : "$") + fmtCap(Math.abs(m) * 1e6);
}

export function etTime(d) {
  return d.toLocaleTimeString("en-GB",
    { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });   // 24h, e.g. 15:00
}
export function etYMD(d) {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });   // en-CA -> YYYY-MM-DD
}

export function fmtTime(epoch, range) {
  const d = new Date(epoch * 1000);
  if (range === "1d") return etTime(d);
  if (range === "1w") return etYMD(d) + " " + etTime(d);  // intraday week -> date + time
  return etYMD(d);
}

// 1D x-axis labels (real time scale): times in ET
export function intradayValues(u, splits) {
  return splits.map((s) => etTime(new Date(s * 1000)));
}

// Multi-day ranges use an ORDINAL x (bar index) so nights/weekends don't leave
// gaps. Ticks are placed at the first bar of each day, thinned to ~maxTicks.
export function dayTickSplits(times, maxTicks = 4) {
  const n = times.length;
  if (n === 0) return [];
  const k = Math.min(maxTicks, n);
  // place ticks at the centers of k equal segments: evenly spaced with equal
  // left/right insets (first at ~0.5/k of the range, not at the clipped edge).
  const ticks = [];
  for (let i = 0; i < k; i++) {
    ticks.push(Math.round((i + 0.5) / k * (n - 1)));
  }
  return [...new Set(ticks)];   // dedupe for very short series
}

export function ordinalValues(times) {
  return (u, splits) => splits.map((i) => {
    const idx = Math.round(i);
    return (idx >= 0 && idx < times.length) ? etYMD(new Date(times[idx] * 1000)) : "";
  });
}

export function makeFill(color) {
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
export function prevCloseLine(value) {
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
export function statsHTML(s) {
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

export function changeText(price, base) {
  if (price == null || base == null) return ["", ""];
  const diff = price - base;
  const pct = base ? (diff / base) * 100 : 0;
  const cls = diff >= 0 ? "up" : "down";
  const sign = diff >= 0 ? "+" : "";
  return [`${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`, cls];
}

export function metricLabel(metric) {
  return metric === "pe" ? "P/E" : metric === "ps" ? "P/S" : "Price";
}
export function fmtVal(metric, v) {
  return metric === "price" ? "$" + fmtPrice(v) : fmtPrice(v);
}

// nearest data index to an x-scale value (handles differing per-chart lengths)
export function nearestIdx(xs, val) {
  const n = xs.length;
  if (n === 0) return null;
  if (val <= xs[0]) return 0;
  if (val >= xs[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m] < val) lo = m + 1; else hi = m - 1; }
  return (Math.abs(xs[lo] - val) < Math.abs(xs[lo - 1] - val)) ? lo : lo - 1;
}
