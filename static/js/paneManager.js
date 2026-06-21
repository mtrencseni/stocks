"use strict";

// Registry + lifecycle + persistence + sidebar + hash router for panes.
//
// Persistence is two-tier:
//   - STRUCTURAL (here, localStorage "session.v1"): which panes are open + active.
//   - VIEW CONFIG (inside each pane's in-memory viewState): NOT persisted, so it
//     survives pane switches but resets to defaults on reload.

const SESSION_KEY = "session.v1";

function idToHash(id) {
  if (id === "stocks") return "#/stocks";
  if (id === "explore") return "#/explore";
  if (id === "invest") return "#/invest";
  if (id.startsWith("stock:")) return "#/stock/" + id.slice("stock:".length);
  return "#/" + id;
}
function hashToId(hash) {
  const h = (hash || "").replace(/^#\/?/, "");
  if (!h) return null;
  const parts = h.split("/");
  if (parts[0] === "stock" && parts[1]) return "stock:" + parts[1];
  if (parts[0] === "stocks") return "stocks";
  if (parts[0] === "explore") return "explore";
  if (parts[0] === "invest") return "invest";
  return null;
}

export class PaneManager {
  constructor({ content, sidebar, factories }) {
    this.content = content;
    this.sidebar = sidebar;
    this.factories = factories;     // { stocks, explore, stock } -> create a pane
    this.panes = [];                // pane instances, in sidebar order
    this.activeId = null;
    this._routing = false;          // guard so we don't loop on our own hash writes

    this.sidebar.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) { e.stopPropagation(); this.close(close.dataset.close); return; }
      const item = e.target.closest("[data-id]");
      if (item) this.activate(item.dataset.id);
    });
    window.addEventListener("hashchange", () => {
      if (this._routing) return;
      const id = hashToId(location.hash);
      if (id && this.find(id)) this.activate(id);
    });
  }

  find(id) { return this.panes.find((p) => p.id === id); }

  // create-if-missing; returns the (existing or new) pane
  register(pane) {
    const existing = this.find(pane.id);
    if (existing) return existing;
    pane.mount(this.content);
    if (pane.root) pane.root.hidden = true;
    this.panes.push(pane);
    this.renderSidebar();
    return pane;
  }

  open(pane) {
    const p = this.register(pane);
    this.activate(p.id);
    return p;
  }

  activate(id) {
    const pane = this.find(id);
    if (!pane) return;
    if (this.activeId && this.activeId !== id) {
      const cur = this.find(this.activeId);
      if (cur) { if (cur.root) cur.root.hidden = true; if (cur.onDeactivate) cur.onDeactivate(); }
    }
    if (pane.root) pane.root.hidden = false;
    this.activeId = id;
    if (pane.onActivate) pane.onActivate();
    this.renderSidebar();

    this._routing = true;
    if (location.hash !== idToHash(id)) location.hash = idToHash(id);
    this._routing = false;

    this.persist();
  }

  close(id) {
    const pane = this.find(id);
    if (!pane || pane.closable === false) return;
    const idx = this.panes.indexOf(pane);
    if (pane.destroy) pane.destroy();
    this.panes.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.panes[idx] || this.panes[idx - 1] || this.panes[0];
      this.activeId = null;
      if (next) this.activate(next.id);
    }
    this.renderSidebar();
    this.persist();
  }

  renderSidebar() {
    this.sidebar.innerHTML = "";
    const title = document.createElement("div");
    title.className = "side-title";
    title.textContent = "Views";
    this.sidebar.appendChild(title);

    let stockHeaderAdded = false;
    for (const p of this.panes) {
      if (p.type === "stock" && !stockHeaderAdded) {
        const t = document.createElement("div");
        t.className = "side-title";
        t.textContent = "Stocks";
        this.sidebar.appendChild(t);
        stockHeaderAdded = true;
      }
      const item = document.createElement("div");
      item.className = "side-item" + (p.id === this.activeId ? " active" : "");
      item.dataset.id = p.id;
      const label = document.createElement("span");
      label.textContent = p.title;
      item.appendChild(label);
      if (p.closable) {
        const x = document.createElement("button");
        x.className = "close";
        x.dataset.close = p.id;
        x.textContent = "×";
        x.title = "Close";
        item.appendChild(x);
      }
      this.sidebar.appendChild(item);
    }
  }

  persist() {
    const data = {
      activePaneId: this.activeId,
      openPanes: this.panes.map((p) => ({ id: p.id, type: p.type, symbol: p.symbol })),
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (e) {}
  }

  _create(type, symbol) {
    const f = this.factories[type];
    if (!f) return null;
    return f({ symbol });
  }

  // restore the open set (not view config) from storage, then pick the active pane
  boot() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) {}

    const opened = [];   // ids we actually created
    if (saved && Array.isArray(saved.openPanes)) {
      for (const sp of saved.openPanes) {
        const pane = this._create(sp.type, sp.symbol);
        if (pane) { this.register(pane); opened.push(pane.id); }
      }
    }
    // singletons always present
    if (!this.find("stocks")) this.register(this._create("stocks"));
    if (!this.find("explore")) this.register(this._create("explore"));
    if (!this.find("invest")) this.register(this._create("invest"));

    // keep the fixed views in order at the top, stock panes (any order) below —
    // a newly-added singleton would otherwise land after restored stock panes
    const rank = { stocks: 0, explore: 1, invest: 2 };
    this.panes.sort((a, b) => (rank[a.id] ?? 9) - (rank[b.id] ?? 9));

    const fromHash = hashToId(location.hash);
    const wanted = (fromHash && this.find(fromHash) && fromHash) ||
                   (saved && this.find(saved.activePaneId) && saved.activePaneId) ||
                   "stocks";
    this.activate(wanted);
  }
}
