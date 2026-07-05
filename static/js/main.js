"use strict";

// Bootstrap: wire the pane factories to the manager and boot the shell.

import { PaneManager } from "./paneManager.js";
import { initTheme } from "./theme.js";
import { StocksPane } from "./panes/stocks.js";
import { ScreenerPane, SCREENER_CONFIGS } from "./panes/explore.js";
import { FactorsPane } from "./panes/factors.js";
import { CalendarPane } from "./panes/calendar.js";
import { StockPane } from "./panes/stock.js";

const content = document.getElementById("content");
const sidebar = document.getElementById("sidebar");

let manager;
const openStock = (sym) => manager.open(new StockPane({ symbol: sym }));
const factories = {
  stocks:  () => new StocksPane({ onOpenStock: openStock }),
  explore: () => new ScreenerPane({ config: SCREENER_CONFIGS.explore, onOpenStock: openStock }),
  invest:  () => new ScreenerPane({ config: SCREENER_CONFIGS.invest, onOpenStock: openStock }),
  factors: () => new FactorsPane({ onOpenStock: openStock }),
  calendar: () => new CalendarPane({ onOpenStock: openStock }),
  stock:   ({ symbol }) => new StockPane({ symbol }),
};

initTheme();   // apply saved light/dark before first render
manager = new PaneManager({ content, sidebar, factories });
manager.boot();

// redraw the active pane's canvas charts when the theme flips
window.addEventListener("themechange", () => {
  const p = manager && manager.find(manager.activeId);
  if (p && p.resizeAll) p.resizeAll();
});

// ---- sidebar: drag-to-resize + show/hide (macOS-style) ----
const refit = () => {
  const p = manager && manager.find(manager.activeId);
  if (p && p.resizeAll) requestAnimationFrame(() => p.resizeAll());
};
const sidebarEl = document.getElementById("sidebar");
const resizerEl = document.getElementById("sidebar-resizer");
const sbToggleEl = document.getElementById("sidebarToggle");

const savedW = parseInt(localStorage.getItem("sidebarW") || "", 10);
if (savedW >= 150 && savedW <= 420) sidebarEl.style.flex = `0 0 ${savedW}px`;
if (localStorage.getItem("sidebarCollapsed") === "1") document.body.classList.add("sidebar-collapsed");

sbToggleEl.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
  refit();
});

let dragging = false;
resizerEl.addEventListener("mousedown", (e) => {
  dragging = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const w = Math.max(150, Math.min(420, e.clientX));
  sidebarEl.style.flex = `0 0 ${w}px`;
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  localStorage.setItem("sidebarW", String(sidebarEl.offsetWidth));
  refit();
});

// re-fit the active pane's charts on window resize
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const p = manager.find(manager.activeId);
    if (p && p.resizeAll) p.resizeAll();
  }, 150);
});

// mobile: hamburger toggles the sidebar drawer; tapping a view closes it
const menuBtn = document.getElementById("menuBtn");
if (menuBtn) {
  menuBtn.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  sidebar.addEventListener("click", (e) => {
    if (e.target.closest("[data-id]")) document.body.classList.remove("sidebar-open");
  });
}
