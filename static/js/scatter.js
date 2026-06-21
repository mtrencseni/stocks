"use strict";

// A small canvas scatter plot with per-point size + color, nice axes, hover
// hit-testing and an external highlight (for cross-panel linking). Kept
// independent of uPlot: per-point bubble styling is far simpler on a raw canvas.

// theme colors, refreshed from CSS variables on every draw (so the toggle works)
let BG = "#22242a";
let GRID = "#333640";
let MUTED = "#8a8a8c";
let TEXT = "#c6c7ca";
function readTheme() {
  const s = getComputedStyle(document.body);
  BG = s.getPropertyValue("--panel").trim() || BG;
  GRID = s.getPropertyValue("--border").trim() || GRID;
  MUTED = s.getPropertyValue("--muted").trim() || MUTED;
  TEXT = s.getPropertyValue("--text").trim() || TEXT;
}

const PAD = { top: 30, right: 14, bottom: 40, left: 56 };

function niceTicks(min, max, n = 5) {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  let step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-6; v += step) ticks.push(v);
  return ticks;
}

function fmtTick(v) {
  const a = Math.abs(v);
  if (a !== 0 && a < 1) return v.toFixed(2);
  if (a < 10) return v.toFixed(1);
  return v.toFixed(0);
}

// ticks for a log axis: 1-2-5 per decade, given bounds already in log10 space
function logTicks(loLog, hiLog) {
  const ticks = [];
  for (let k = Math.floor(loLog); k <= Math.ceil(hiLog); k++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, k);
      const lg = Math.log10(v);
      if (lg >= loLog - 1e-9 && lg <= hiLog + 1e-9) ticks.push(v);
    }
  }
  return ticks;
}

// small filled arrowhead at (x,y) pointing along `angle` (canvas already in CSS px)
function drawArrow(ctx, x, y, angle, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.6, size * 0.7);
  ctx.lineTo(-size * 0.6, -size * 0.7);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export class ScatterChart {
  constructor(container, opts) {
    this.opts = opts;            // {title,xLabel,yLabel,xKey,yKey,colorOf,radiusOf,tooltipHTML,onHover,onPick}
    this.points = [];
    this._pts = [];              // {sym, px, py, r, p} laid-out points for hit-testing
    this._hl = null;             // highlighted symbol

    this.wrap = document.createElement("div");
    this.wrap.className = "scatter";
    this.canvas = document.createElement("canvas");
    this.tip = document.createElement("div");
    this.tip.className = "scatter-tip";
    this.wrap.append(this.canvas, this.tip);
    container.appendChild(this.wrap);
    this.ctx = this.canvas.getContext("2d");

    this.canvas.addEventListener("mousemove", (e) => this._onMove(e));
    this.canvas.addEventListener("mouseleave", () => this._onLeave());
    this.canvas.addEventListener("dblclick", (e) => {
      const hit = this._hitTest(e);
      if (hit && this.opts.onPick) this.opts.onPick(hit.sym);
    });
  }

  setData(points) {
    this.points = points.filter((p) =>
      p[this.opts.xKey] != null && p[this.opts.yKey] != null);
    this.draw();
  }

  setHighlight(sym) {
    if (this._hl === sym) return;
    this._hl = sym;
    this.draw();
  }

  resize() { this.draw(); }

  destroy() { this.wrap.remove(); }

  _layout() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.wrap.clientWidth;
    const ch = this.wrap.clientHeight;
    this.cw = cw; this.ch = ch;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.canvas.style.width = cw + "px";
    this.canvas.style.height = ch + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.plot = {
      x: PAD.left, y: PAD.top,
      w: Math.max(10, cw - PAD.left - PAD.right),
      h: Math.max(10, ch - PAD.top - PAD.bottom),
    };

    this.logX = !!this.opts.logX;
    this.logY = !!this.opts.logY;
    this.clipX = this.opts.clipX || null;   // [min,max] — outliers snap to the rail
    this.clipY = this.opts.clipY || null;
    // xr/yr are stored in TRANSFORMED space (log10 when the axis is log)
    this.xr = this._range(this.points.map((p) => p[this.opts.xKey]), this.logX, this.clipX);
    this.yr = this._range(this.points.map((p) => p[this.opts.yKey]), this.logY, this.clipY);
  }

  _range(vals, isLog, clip) {
    const v = [];
    for (const x of vals) {
      if (x == null) continue;
      const xc = clip ? Math.min(clip[1], Math.max(clip[0], x)) : x;
      if (isLog) { if (xc > 0) v.push(Math.log10(xc)); }   // log undefined for <=0
      else v.push(xc);
    }
    let mn = Infinity, mx = -Infinity;
    for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; }
    if (!isFinite(mn) || !isFinite(mx)) return [0, 1];
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.06;
    return [mn - pad, mx + pad];
  }

  _xpx(v) {
    if (this.clipX) v = Math.min(this.clipX[1], Math.max(this.clipX[0], v));
    const t = this.logX ? Math.log10(v) : v;
    return this.plot.x + (t - this.xr[0]) / (this.xr[1] - this.xr[0]) * this.plot.w;
  }
  _ypx(v) {
    if (this.clipY) v = Math.min(this.clipY[1], Math.max(this.clipY[0], v));
    const t = this.logY ? Math.log10(v) : v;
    return this.plot.y + (1 - (t - this.yr[0]) / (this.yr[1] - this.yr[0])) * this.plot.h;
  }
  _toPx(vx, vy) { return [this._xpx(vx), this._ypx(vy)]; }

  draw() {
    if (!this.wrap.clientWidth) return;
    readTheme();
    this._layout();
    const ctx = this.ctx, pl = this.plot;
    const { xKey, yKey, title, xLabel, yLabel, colorOf, radiusOf } = this.opts;

    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.cw, this.ch);

    // "magic quadrant": the region that fits what we're looking for
    if (this.opts.goodZone) this._drawGoodZone();

    // grid + ticks
    ctx.font = "10px -apple-system, sans-serif";
    ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.fillStyle = MUTED;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const xticks = this.logX ? logTicks(this.xr[0], this.xr[1]) : niceTicks(this.xr[0], this.xr[1]);
    for (const tx of xticks) {
      const px = this._xpx(tx);
      if (px < pl.x - 1 || px > pl.x + pl.w + 1) continue;
      ctx.beginPath(); ctx.moveTo(px, pl.y); ctx.lineTo(px, pl.y + pl.h); ctx.stroke();
      ctx.fillText(fmtTick(tx), px, pl.y + pl.h + 5);
    }
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const yticks = this.logY ? logTicks(this.yr[0], this.yr[1]) : niceTicks(this.yr[0], this.yr[1]);
    for (const ty of yticks) {
      const py = this._ypx(ty);
      if (py < pl.y - 1 || py > pl.y + pl.h + 1) continue;
      ctx.beginPath(); ctx.moveTo(pl.x, py); ctx.lineTo(pl.x + pl.w, py); ctx.stroke();
      ctx.fillText(fmtTick(ty), pl.x - 6, py);
    }

    // points
    this._pts = [];
    for (const p of this.points) {
      if (this.logX && !(p[xKey] > 0)) continue;   // can't place <=0 on a log axis
      if (this.logY && !(p[yKey] > 0)) continue;
      const [px, py] = this._toPx(p[xKey], p[yKey]);
      const r = radiusOf(p);
      this._pts.push({ sym: p.sym, px, py, r, p });
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(p);
      ctx.fill();
      ctx.lineWidth = 0.5; ctx.strokeStyle = "rgba(198,199,202,.5)"; ctx.stroke();

      // if this point was clamped to a rail, point an arrow toward its true value
      let adx = 0, ady = 0;
      if (this.clipX && p[xKey] != null) {
        if (p[xKey] > this.clipX[1]) adx = 1;
        else if (p[xKey] < this.clipX[0]) adx = -1;
      }
      if (this.clipY && p[yKey] != null) {
        if (p[yKey] > this.clipY[1]) ady = -1;       // higher value = up = -y in pixels
        else if (p[yKey] < this.clipY[0]) ady = 1;
      }
      if (adx || ady) {
        const len = Math.hypot(adx, ady);
        const ux = adx / len, uy = ady / len;
        drawArrow(ctx, px + ux * (r + 5), py + uy * (r + 5), Math.atan2(uy, ux), 5, colorOf(p));
      }
    }

    // highlight ring (this chart's copy of the linked symbol)
    if (this._hl) {
      const hit = this._pts.find((q) => q.sym === this._hl);
      if (hit) {
        ctx.beginPath();
        ctx.arc(hit.px, hit.py, hit.r + 4, 0, Math.PI * 2);
        ctx.lineWidth = 2; ctx.strokeStyle = TEXT; ctx.stroke();
        ctx.fillStyle = TEXT; ctx.font = "bold 11px -apple-system, sans-serif";
        ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(hit.sym, hit.px + hit.r + 5, hit.py - 2);
      }
    }

    // title + axis labels
    ctx.fillStyle = TEXT; ctx.font = "bold 12px -apple-system, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(title, pl.x, 8);
    ctx.fillStyle = MUTED; ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(xLabel, pl.x + pl.w / 2, this.ch - 4);
    ctx.save();
    ctx.translate(11, pl.y + pl.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "top"; ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  _drawGoodZone() {
    const gz = this.opts.goodZone;          // {x:[min,max], y:[min,max]}, null = open to edge
    // axis edges in DATA space (invert the log transform when needed)
    const x0 = this.logX ? 10 ** this.xr[0] : this.xr[0];
    const x1 = this.logX ? 10 ** this.xr[1] : this.xr[1];
    const y0 = this.logY ? 10 ** this.yr[0] : this.yr[0];
    const y1 = this.logY ? 10 ** this.yr[1] : this.yr[1];
    const gx0 = gz.x[0] == null ? x0 : Math.max(x0, gz.x[0]);
    const gx1 = gz.x[1] == null ? x1 : Math.min(x1, gz.x[1]);
    const gy0 = gz.y[0] == null ? y0 : Math.max(y0, gz.y[0]);
    const gy1 = gz.y[1] == null ? y1 : Math.min(y1, gz.y[1]);
    if (gx1 <= gx0 || gy1 <= gy0) return;
    const [px0, py0] = this._toPx(gx0, gy0);
    const [px1, py1] = this._toPx(gx1, gy1);
    const rx = Math.min(px0, px1), ry = Math.min(py0, py1);
    const rw = Math.abs(px1 - px0), rh = Math.abs(py1 - py0);
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(137,201,150,0.10)";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = "rgba(137,201,150,0.45)";
    ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(137,201,150,0.85)";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("good fit", rx + 4, ry + 3);
  }

  _hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = null, bestD = 196;   // 14px radius squared
    for (const q of this._pts) {
      const d = (q.px - mx) ** 2 + (q.py - my) ** 2;
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }

  _onMove(e) {
    const hit = this._hitTest(e);
    if (hit) {
      this.tip.innerHTML = this.opts.tooltipHTML(hit.p);
      this.tip.style.left = Math.min(hit.px + 12, this.cw - 140) + "px";
      this.tip.style.top = Math.max(hit.py - 8, 2) + "px";
      this.tip.style.display = "block";
      if (this.opts.onHover) this.opts.onHover(hit.sym);
    } else {
      this.tip.style.display = "none";
      if (this.opts.onHover) this.opts.onHover(null);
    }
  }

  _onLeave() {
    this.tip.style.display = "none";
    if (this.opts.onHover) this.opts.onHover(null);
  }
}
