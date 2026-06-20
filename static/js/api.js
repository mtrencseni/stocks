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
