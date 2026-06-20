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
