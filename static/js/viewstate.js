"use strict";

// Tiny per-pane view-state persistence: remembers which sub-tab / toggle you
// were on (Charts vs Table, lookback, range, etc.) across reloads. Keyed by a
// short name so each pane keeps its own choices. Structural session (which
// panes are open + active) lives in paneManager; this is just the view config.

export function loadView(key, defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem("view." + key) || "{}");
    return { ...defaults, ...saved };
  } catch (e) {
    return { ...defaults };
  }
}

export function saveView(key, state) {
  try { localStorage.setItem("view." + key, JSON.stringify(state)); } catch (e) {}
}
