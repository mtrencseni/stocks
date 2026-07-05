"use strict";

// thin wrappers over the Flask gateway. They return data (or throw); no DOM.

export async function getHistory(range, metric, symbols) {
  const url = `/api/history?range=${encodeURIComponent(range)}` +
    `&metric=${encodeURIComponent(metric)}` +
    `&symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.series;
}

// reference overlay options (keys match app.py REFERENCES)
export const REF_OPTIONS = [
  ["spy", "S&P 500 (SPY)"], ["qqq", "Nasdaq 100 (QQQ)"], ["gld", "Gold (GLD)"],
  ["btc", "Bitcoin (BTC-USD)"], ["googl", "Google (GOOGL)"], ["nvda", "Nvidia (NVDA)"],
  ["brkb", "Berkshire (BRK-B)"], ["mag7", "Magnificent 7"],
  ["vti", "Vanguard Total US (VTI)"], ["vt", "Vanguard Total World (VT)"],
];

export async function getEarningsDetail(symbol) {
  const res = await fetch(`/api/earnings_detail?symbol=${encodeURIComponent(symbol)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

export async function getCalendar() {
  const res = await fetch("/api/calendar");
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;   // {asof, entries:[...]}
}

export async function getUniverse(universe) {
  const q = universe ? `?universe=${encodeURIComponent(universe)}` : "";
  const res = await fetch(`/api/universe${q}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.symbols;
}

export async function getMarketStatus() {
  const res = await fetch("/api/market");
  return res.json();   // { open, status, message, source }
}

export async function getFactorsDetail(symbol, lookback) {
  const q = `symbol=${encodeURIComponent(symbol)}&lookback=${encodeURIComponent(lookback)}`;
  const res = await fetch(`/api/factors/detail?${q}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

export async function getThresholds() {
  const res = await fetch("/api/thresholds");
  return res.json();   // { SYM: price, ... }
}

export async function setThreshold(sym, price) {
  const q = `symbol=${encodeURIComponent(sym)}&price=${encodeURIComponent(price || 0)}`;
  const res = await fetch(`/api/threshold?${q}`, { method: "POST" });
  return res.json();
}

export async function getReference(range, ref) {
  const res = await fetch(`/api/reference?range=${encodeURIComponent(range)}&ref=${encodeURIComponent(ref)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;   // {ref, label, range, t, rel}
}

export async function getStats(symbols) {
  const res = await fetch(`/api/stats?symbols=${encodeURIComponent(symbols.join(","))}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.stats;
}

export async function getProfile(symbol) {
  const res = await fetch(`/api/profile?symbol=${encodeURIComponent(symbol)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;   // { symbol, profile, earnings }
}

export async function getFinancials(symbol) {
  const res = await fetch(`/api/financials?symbol=${encodeURIComponent(symbol)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;   // { symbol, currency, unit, series: { revenue:{t,q,ttm}, netIncome:{t,q,ttm} } }
}

// ---- AI opinion ----
export async function startOpinion(symbol, profile) {
  const q = `symbol=${encodeURIComponent(symbol)}` + (profile ? `&profile=${encodeURIComponent(profile)}` : "");
  const res = await fetch(`/api/opinion/start?${q}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;   // { id, ts, symbol, profile, state }
}

export async function opinionStatus(jobId) {
  const res = await fetch(`/api/opinion/status?job=${encodeURIComponent(jobId)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;   // full job: { state, agents, log, runs, summary_md, ... }
}

export async function listOpinions(symbol) {
  const res = await fetch(`/api/opinion/list?symbol=${encodeURIComponent(symbol)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.opinions;   // [{id, ts}]
}

export async function getOpinion(symbol, id) {
  const res = await fetch(`/api/opinion/get?symbol=${encodeURIComponent(symbol)}&id=${encodeURIComponent(id)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

export async function deleteOpinion(symbol, id) {
  const q = `symbol=${encodeURIComponent(symbol)}&id=${encodeURIComponent(id)}`;
  const res = await fetch(`/api/opinion/delete?${q}`, { method: "POST" });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.deleted;
}

// ---- backtest ----
export async function backtestSweep(symbol, range, maxPrice) {
  let q = `symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`;
  if (maxPrice != null) q += `&max_price=${encodeURIComponent(maxPrice)}`;
  const res = await fetch(`/api/backtest/sweep?${q}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

export async function runBacktest(symbol, range, delta, hold, maxPrice) {
  let q = `symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}` +
    `&delta=${encodeURIComponent(delta)}&hold=${encodeURIComponent(hold)}`;
  if (maxPrice != null) q += `&max_price=${encodeURIComponent(maxPrice)}`;
  const res = await fetch(`/api/backtest?${q}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}
