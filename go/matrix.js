// 取路程（规格 14.5 / 14.8）：算出还缺哪些格、每次请求前过「花钱的闸」、取到的格子存回 state.matrix。
// 只管编排，不碰界面；供应商（providers.js）和存储由 app.js 注进来，所以 node 能拿假的测（测试/matrix.test.mjs）。

import { missingPairs, pairKey, ptKey, haversineM, NEAR_M } from './geo.js';
import { pointsForMatrix, localDateStr } from './trip.js';

// 花钱的闸：usage = { [provider]: { date:'YYYY-MM-DD', units } }，按手机日期记，到上限就抛（kind 'cap'）。
// 每次请求之前调；抛出去的错 providers.js 原样往外传，请求不会发。
export function makeSpender({ provider, cap, usage, save, today = localDateStr }) {
  return async function spend(units) {
    const d = today();
    const u = usage[provider] && usage[provider].date === d ? usage[provider] : { date: d, units: 0 };
    if (cap > 0 && u.units + units > cap) {
      const e = new Error(`今天${{ amap: '高德', google: '谷歌', ai: 'AI' }[provider] || provider}已经用了 ${u.units} 次，再加 ${units} 就超过每天上限 ${cap} 了；明天再取，或者在设置里调高上限`);
      e.kind = 'cap';
      throw e;
    }
    usage[provider] = { date: d, units: u.units + units };
    if (save) await save(usage);
  };
}

// 出发时刻：还没过的第一天的当地 10:00（谷歌、高德都用）；天都过了就不带（规格 14.4）
// ★ 0923 改：原来只看第一天 —— 旅途中夜里在酒店取明天的路程，第一天早过了 → 按「现在」查 → 夜里没车 → 整段存成步行。
export function departureFor(state, now = new Date()) {
  const dates = [...new Set(state.trip.days.map(d => d.date))].sort();
  for (const date of dates) {
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(y, m - 1, d, 10, 0, 0);
    if (t > now) return t;
  }
  return null;
}

// 高德查到的城市码记回 state（点是副本，不记回下次取数每个点又要多查一次逆地理）
function rememberCitycodes(state, points) {
  const codes = new Map(points.filter(p => p.citycode).map(p => [ptKey(p), p.citycode]));
  if (!codes.size) return;
  for (const p of state.places || []) { if (!p.citycode && codes.has(ptKey(p))) p.citycode = codes.get(ptKey(p)); }
  const h = state.trip.home;
  if (h && !h.citycode && codes.has(ptKey(h))) h.citycode = codes.get(ptKey(h));
}

// 现在这份 state 的路程矩阵是什么状态（设置页显示用）
export function matrixStats(state, T) {
  const points = pointsForMatrix(state, T);
  const M = state.matrix || {};
  let pairs = 0, have = 0, noRoute = 0, near = 0;
  let lastAt = null;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (ptKey(points[i]) === ptKey(points[j])) continue;
    if (haversineM(points[i], points[j]) < NEAR_M) { near++; continue; }
    pairs++;
    const c = M[pairKey(points[i], points[j])];
    if (!c) continue;
    if (c.min == null) noRoute++; else have++;
    if (c.at && (!lastAt || c.at > lastAt)) lastAt = c.at;
  }
  return { points: points.length, pairs, have, noRoute, missing: pairs - have - noRoute, near, lastAt };
}

// 把缺的格子取回来。provider = providers.js 的 makeProvider(...)；save() 每存一批调一次（断了下次接着）。
// 返回 { fetched, noRoute, units, total, note? }（note = 供应商想说的一句话，比如高德没收出发时刻）；中途出错先把已取到的存进 state 再抛。
export async function fetchMissing({ state, T, provider, onProgress, signal, save, chunk }) {
  const points = pointsForMatrix(state, T);
  const pairs = missingPairs(points, state.matrix || {});
  state.matrix = state.matrix || {};
  if (!pairs.length) return { fetched: 0, noRoute: 0, units: 0, total: 0 };
  // 高德一对一次、每秒 3 次：20 格存一次盘；谷歌一趟就几个请求，整批一起
  chunk = chunk || (provider.name === 'amap' ? 20 : pairs.length);
  const departure = departureFor(state);
  const at = new Date().toISOString();
  let done = 0, fetched = 0, noRoute = 0, units = 0, note = null;
  const store = cells => {
    rememberCitycodes(state, points);
    for (const c of cells) {
      state.matrix[pairKey(points[c.i], points[c.j])] = { min: c.min == null ? null : Math.round(c.min), mode: c.mode || 'transit', src: provider.name, at };
      if (c.min == null) noRoute++; else fetched++;
    }
  };
  for (let k = 0; k < pairs.length; k += chunk) {
    const part = pairs.slice(k, k + chunk);
    let res;
    try {
      res = await provider.matrix(points, part, { departure, signal, onProgress: p => onProgress && onProgress({ done: done + (p.done || 0), total: pairs.length }) });
    } catch (e) {
      if (e && Array.isArray(e.partial) && e.partial.length) { store(e.partial); if (save) await save(); }
      throw e;
    }
    store(res.cells);
    if (res.note && !note) note = res.note;
    units += res.units || 0;
    done += part.length;
    if (onProgress) onProgress({ done, total: pairs.length });
    if (save) await save();
  }
  return note ? { fetched, noRoute, units, total: pairs.length, note } : { fetched, noRoute, units, total: pairs.length };
}
