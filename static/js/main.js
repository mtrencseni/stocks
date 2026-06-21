"use strict";

// Bootstrap: wire the pane factories to the manager and boot the shell.

import { PaneManager } from "./paneManager.js";
import { StocksPane } from "./panes/stocks.js";
import { ScreenerPane, SCREENER_CONFIGS } from "./panes/explore.js";
import { StockPane } from "./panes/stock.js";

const content = document.getElementById("content");
const sidebar = document.getElementById("sidebar");

let manager;
const openStock = (sym) => manager.open(new StockPane({ symbol: sym }));
const factories = {
  stocks:  () => new StocksPane({ onOpenStock: openStock }),
  explore: () => new ScreenerPane({ config: SCREENER_CONFIGS.explore, onOpenStock: openStock }),
  invest:  () => new ScreenerPane({ config: SCREENER_CONFIGS.invest, onOpenStock: openStock }),
  stock:   ({ symbol }) => new StockPane({ symbol }),
};

manager = new PaneManager({ content, sidebar, factories });
manager.boot();

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
