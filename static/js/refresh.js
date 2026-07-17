"use strict";

// A refresh (circular-arrow) button injected into a pane's toolbar (.tb-right),
// far right. Clicking re-runs the pane's own data fetch (onRefresh); the icon
// spins until that settles. No browser reload.

const ICON =
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"` +
  ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><polyline points="20.5 4 20.5 9 15.5 9"/></svg>`;

export function wireRefresh(rootEl, onRefresh) {
  const tr = rootEl.querySelector(".tb-right");
  if (!tr) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "refresh-btn";
  btn.title = "Refresh data";
  btn.setAttribute("aria-label", "Refresh data");
  btn.innerHTML = ICON;
  btn.addEventListener("click", async () => {
    if (btn.classList.contains("spinning")) return;
    btn.classList.add("spinning");
    try { await onRefresh(); } catch (e) { /* pane handles its own errors */ }
    finally { setTimeout(() => btn.classList.remove("spinning"), 400); }
  });
  tr.appendChild(btn);
  return btn;
}
