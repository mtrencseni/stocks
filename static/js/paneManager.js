"use strict";

// Registry + lifecycle + persistence + sidebar + hash router for panes.
//
// Persistence is two-tier:
//   - STRUCTURAL (here, localStorage "session.v1"): which panes are open + active.
//   - VIEW CONFIG (inside each pane's in-memory viewState): NOT persisted, so it
//     survives pane switches but resets to defaults on reload.

import { makeThemeToggle } from "./theme.js";
import { getUniverse, getMarketStatus } from "./api.js";

const SESSION_KEY = "session.v1";

function idToHash(id) {
  if (id === "stocks") return "#/stocks";
  if (id === "explore") return "#/explore";
  if (id === "invest") return "#/invest";
  if (id === "factors") return "#/factors";
  if (id === "calendar") return "#/earnings";
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
  if (parts[0] === "factors") return "factors";
  if (parts[0] === "earnings" || parts[0] === "calendar") return "calendar";
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

    const spacer = document.createElement("div");
    spacer.className = "side-spacer";
    this.sidebar.appendChild(spacer);
    this.sidebar.appendChild(this._clockEl());   // ET clock + market status
    const footer = document.createElement("div");   // shamrock (left) + theme toggle (right)
    footer.className = "side-footer";
    footer.appendChild(this._makeLucky());
    footer.appendChild(makeThemeToggle());
    this.sidebar.appendChild(footer);
  }

  // ET clock + NYSE/NASDAQ open status. Created once; tickers keep the stored
  // element live so re-appending it on each renderSidebar() is cheap.
  // The time is rendered client-side every second; the open/closed status is
  // authoritative from /api/market (Yahoo: holiday- and half-day-aware),
  // polled every 60s. NYSE and NASDAQ share the US session, so one status
  // drives both pills.
  _clockEl() {
    if (this._clock) return this._clock;
    const box = document.createElement("div");
    box.className = "side-clock";
    const time = document.createElement("div");
    time.className = "sc-time";
    const pills = document.createElement("div");
    pills.className = "sc-pills";
    const nyse = document.createElement("span");
    nyse.className = "sc-pill";
    const ndaq = document.createElement("span");
    ndaq.className = "sc-pill";
    pills.append(nyse, ndaq);
    box.append(time, pills);

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      hour: "2-digit", minute: "2-digit",
    });
    const tick = () => {
      const parts = {};
      for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
      const hh = parts.hour === "24" ? "00" : parts.hour;   // midnight quirk
      time.textContent = `${hh}:${parts.minute} ET`;
    };
    tick();
    setInterval(tick, 1000);

    const applyStatus = (open) => {
      for (const [el, name] of [[nyse, "NYSE"], [ndaq, "NASDAQ"]]) {
        el.textContent = `${name} ${open ? "OPEN" : "CLOSED"}`;
        el.classList.toggle("open", open);
      }
    };
    applyStatus(false);   // placeholder until the first fetch resolves
    const refresh = async () => {
      try {
        const s = await getMarketStatus();
        applyStatus(!!s.open);
        if (s.message) box.title = s.message;
      } catch (e) { /* keep last-known pills on a transient failure */ }
    };
    refresh();
    setInterval(refresh, 60000);

    this._clock = box;
    return box;
  }

  _makeLucky() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lucky-btn";
    b.title = "I'm feeling lucky — open a random stock";
    b.textContent = "🍀";
    b.addEventListener("click", () => this._openLucky());
    return b;
  }

  // open a random universe stock that isn't already open
  async _openLucky() {
    if (!this._universe) {
      try { this._universe = await getUniverse(); } catch (e) { this._universe = []; }
    }
    const open = new Set(this.panes.filter((p) => p.type === "stock").map((p) => p.symbol));
    const pool = this._universe.filter((s) => !open.has(s));
    const list = pool.length ? pool : this._universe;   // all open? then any
    if (!list.length) return;
    const sym = list[Math.floor(Math.random() * list.length)];
    this.open(this._create("stock", sym));
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
    if (!this.find("factors")) this.register(this._create("factors"));
    if (!this.find("calendar")) this.register(this._create("calendar"));

    // keep the fixed views in order at the top, stock panes (any order) below —
    // a newly-added singleton would otherwise land after restored stock panes
    const rank = { stocks: 0, explore: 1, invest: 2, factors: 3, calendar: 4 };
    this.panes.sort((a, b) => (rank[a.id] ?? 9) - (rank[b.id] ?? 9));

    const fromHash = hashToId(location.hash);
    const wanted = (fromHash && this.find(fromHash) && fromHash) ||
                   (saved && this.find(saved.activePaneId) && saved.activePaneId) ||
                   "stocks";
    this.activate(wanted);
  }
}
