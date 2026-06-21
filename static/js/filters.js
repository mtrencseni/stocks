"use strict";

// Shared group-filter machinery for the screener panes (Trade/Invest) and the
// Calendar page: exchange + industry + MAG7 + profitable chips, and matching.

export const IND_LABEL = {
  SOXX: "Semiconductors", IGV: "Software/SaaS", XLC: "Internet/Media",
  XLY: "Consumer/Retail", XLP: "Staples", XBI: "Biotech/Health",
  XLI: "Industrials", XLK: "Tech/Hardware", IPAY: "Payments",
  TAN: "Solar", XLE: "Energy", XLU: "Utilities", XLB: "Materials",
};
export function indLabel(etf) {
  if (!etf) return "";
  return IND_LABEL[etf] ? `${IND_LABEL[etf]} (${etf})` : etf;
}

// the Magnificent Seven — Alphabet counted once (GOOGL, the voting class)
export const MAG7 = new Set(["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]);

export function escapeHTML(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function newFilters() {
  return { exchanges: new Set(), industries: new Set(), profitable: false, mag7: false };
}

export function filterActive(f) {
  return f.exchanges.size || f.industries.size || f.profitable || f.mag7;
}

export function matches(s, f) {
  if (f.exchanges.size && !f.exchanges.has(s.exchange)) return false;
  if (f.industries.size && !f.industries.has(s.ind)) return false;
  if (f.profitable && !s.profitable) return false;
  if (f.mag7 && !MAG7.has(s.sym)) return false;
  return true;
}

function toggle(set, val) { set.has(val) ? set.delete(val) : set.add(val); }

// apply a clicked chip button to the filter state; returns true if it was one
export function handleFilterClick(f, btn) {
  if (btn.dataset.clear) {
    f.exchanges.clear(); f.industries.clear(); f.profitable = false; f.mag7 = false;
  } else if (btn.dataset.prof) {
    f.profitable = !f.profitable;
  } else if (btn.dataset.mag7) {
    f.mag7 = !f.mag7;
  } else if (btn.dataset.group === "exchange") {
    toggle(f.exchanges, btn.dataset.val);
  } else if (btn.dataset.group === "industry") {
    toggle(f.industries, btn.dataset.val);
  } else {
    return false;
  }
  return true;
}

export function buildFilterChipsHTML(stocks, f) {
  const exch = [...new Set(stocks.map((s) => s.exchange).filter(Boolean))].sort();
  const inds = [...new Set(stocks.map((s) => s.ind).filter(Boolean))].sort();
  const chip = (group, val, label, title, active) =>
    `<button class="ef-chip${active ? " active" : ""}" data-group="${group}" ` +
    `data-val="${escapeHTML(val)}"${title ? ` title="${escapeHTML(title)}"` : ""}>${escapeHTML(label)}</button>`;
  const grp = (label, chips) =>
    `<span class="ef-group"><span class="ef-label">${label}</span>${chips.join("")}</span>`;

  let html = "";
  if (exch.length)
    html += grp("Exchange", exch.map((e) => chip("exchange", e, e, "", f.exchanges.has(e))));
  if (inds.length)
    html += grp("Industry", inds.map((i) => chip("industry", i, i, IND_LABEL[i] || i, f.industries.has(i))));
  html += `<span class="ef-group">` +
    `<button class="ef-chip ef-mag7${f.mag7 ? " active" : ""}" data-mag7="1" ` +
    `title="Magnificent 7: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA">MAG7</button>` +
    `<button class="ef-chip ef-prof${f.profitable ? " active" : ""}" data-prof="1" ` +
    `title="Only stocks with positive trailing earnings">Profitable</button></span>`;
  if (filterActive(f)) html += `<button class="ef-clear" data-clear="1">Clear ✕</button>`;
  return html;
}
