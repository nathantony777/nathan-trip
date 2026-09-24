// 交通时间怎么估（规格第四节）。纯函数，数据来自 数据/hk.json。
// 走路 / 港铁 / 深圳湾口岸往返的巴士和直通巴。都偏保守；出租车默认关。

export const TRANSIT_DEFAULTS = {
  walkMPerMin: 70,     // 每分钟走 70 米
  detour: 1.35,        // 城市里走不了直线
  enter: 3,            // 进站到站台
  exit: 3,             // 站台到出站
  xferDefault: 4,      // 换乘（数据里没写的）
  rideExtra: 2,        // 每趟加 2 分钟：分段时间加起来比港铁官方行程指南平均少 1.6 分钟
  nearK: 3,            // 两头各试最近几个站
  maxWalkToStation: 25, // 走到站超过这么多分钟就不考虑这个站
  taxi: false,
  taxiMPerMin: 300,
  taxiWait: 5,
  coachMinutes: 60,    // 直通巴全程时间官方没写；旧计划记的是 45–60 分钟，取慢的
};

// 直线距离的正本在 geo.js（旅游版加的，一个公式只存一处）；这里转出去，老的引用不用改
import { haversineM } from './geo.js';
export { haversineM };

export function parseHM(s) {
  if (s == null) return null;
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function makeTransit(data, opts = {}) {
  const P = { ...TRANSIT_DEFAULTS, ...opts };
  const walk = (a, b) => haversineM(a, b) * P.detour / P.walkMPerMin;

  // ---------- 港铁：站到站的车内时间（含等第一班车、换乘） ----------
  const st = data.mtr.st.map(([code, name, lat, lng, lines]) => ({ code, name, lat, lng, lines }));
  const stIdx = new Map(st.map((s, i) => [s.code, i]));
  const lineName = data.mtr.lineNames || {};
  const hw = data.mtr.hw || {};
  const waitOf = L => (hw[L] || 5) / 2;
  // 节点 = (站, 线)
  const nodes = [], nodeIdx = new Map();
  st.forEach((s, i) => s.lines.forEach(L => { nodeIdx.set(i + '|' + L, nodes.length); nodes.push({ s: i, L }); }));
  const adj = nodes.map(() => []);
  const addEdge = (a, b, w, kind) => { if (a != null && b != null) adj[a].push([b, w, kind]); };
  const segSeen = new Set();
  for (const [L, f, t, m] of data.mtr.seg) segSeen.add(L + f + '>' + t);
  for (const [L, f, t, m] of data.mtr.seg) {
    const a = nodeIdx.get(stIdx.get(f) + '|' + L), b = nodeIdx.get(stIdx.get(t) + '|' + L);
    addEdge(a, b, m, 'ride');
    if (!segSeen.has(L + t + '>' + f)) addEdge(b, a, m, 'ride'); // 只有单向的就当来回一样
  }
  const xfSeen = new Set();
  for (const [s, L1, L2, m] of data.mtr.xf) {
    const i = stIdx.get(s);
    addEdge(nodeIdx.get(i + '|' + L1), nodeIdx.get(i + '|' + L2), m + waitOf(L2), 'xfer');
    xfSeen.add(s + L1 + L2);
  }
  st.forEach((s, i) => { // 数据里没写的换乘按默认
    for (const L1 of s.lines) for (const L2 of s.lines) if (L1 !== L2 && !xfSeen.has(s.code + L1 + L2))
      addEdge(nodeIdx.get(i + '|' + L1), nodeIdx.get(i + '|' + L2), P.xferDefault + waitOf(L2), 'xfer');
  });

  // 每个站出发做一次最短路（97 个站，几毫秒）
  const R = [], Rprev = [];
  for (let i = 0; i < st.length; i++) {
    const dist = new Float64Array(nodes.length).fill(Infinity);
    const prev = new Int32Array(nodes.length).fill(-1);
    const done = new Uint8Array(nodes.length);
    for (const L of st[i].lines) dist[nodeIdx.get(i + '|' + L)] = waitOf(L) + P.rideExtra;
    for (;;) {
      let u = -1, best = Infinity;
      for (let k = 0; k < nodes.length; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    const row = new Float64Array(st.length).fill(Infinity), rowEnd = new Int32Array(st.length).fill(-1);
    nodes.forEach((n, k) => { if (dist[k] < row[n.s]) { row[n.s] = dist[k]; rowEnd[n.s] = k; } });
    R.push(row); Rprev.push({ prev, rowEnd });
  }

  const nearCache = new Map();
  function nearStations(p) {
    const key = p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
    if (nearCache.has(key)) return nearCache.get(key);
    const arr = st.map((s, i) => [i, walk(p, s)]).sort((a, b) => a[1] - b[1]).slice(0, P.nearK).filter(x => x[1] <= P.maxWalkToStation);
    nearCache.set(key, arr);
    return arr;
  }

  function mtrBest(a, b) {
    let best = { min: Infinity };
    for (const [i, wa] of nearStations(a)) for (const [j, wb] of nearStations(b)) {
      if (i === j) continue;
      const m = wa + P.enter + R[i][j] + P.exit + wb;
      if (m < best.min) best = { min: m, i, j, wa, wb };
    }
    return best;
  }

  const keyOf = p => p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
  const betweenCache = new Map();
  function between(a, b) {
    const k = keyOf(a) + '|' + keyOf(b);
    let m = betweenCache.get(k);
    if (m !== undefined) return m;
    m = walk(a, b);
    const t = mtrBest(a, b).min;
    if (t < m) m = t;
    if (P.taxi) m = Math.min(m, P.taxiWait + haversineM(a, b) * 1.4 / P.taxiMPerMin);
    betweenCache.set(k, m);
    return m;
  }

  // ---------- 深圳湾口岸 ----------
  const B = data.border || null;
  const port = B ? { lat: B.port.lat, lng: B.port.lng, name: B.port.name, kind: 'port' } : null;
  const isPort = p => !!(port && (p.kind === 'port' || haversineM(p, port) < 300));

  // 在 [first,last] 之间平均等半个班距；早于头班就等到头班；过了末班就没有
  function waitFor(windows, first, last, t) {
    if (first == null || last == null) return Infinity;
    if (t > last) return Infinity;
    if (t < first) return first - t;
    for (const [f, to, every] of windows) if (t >= f && t <= to) return (every || 20) / 2;
    return 10;
  }
  // 按分钟先算好一张表（0:00 到次日 2:00），查的时候取整分钟。
  // ★ 不做表的话 B3X 有上百个时段，每次都从头找一遍，实测占排路线总时间的 60%。
  // 早于头班那段按「到头班还差几分钟」精确算，不查表。
  const TBL_LEN = 26 * 60;
  function waitTable(windows, first, last) {
    const a = new Float64Array(TBL_LEN);
    for (let m = 0; m < TBL_LEN; m++) a[m] = waitFor(windows, first, last, m);
    return { a, first, last };
  }
  function waitAt(tb, t) {
    if (t > tb.last) return Infinity;
    if (t < tb.first) return tb.first - t;
    const m = Math.floor(t);
    return m < TBL_LEN ? tb.a[m] : Infinity;
  }
  const busTbl = B ? B.buses.map(r => ({ toHK: waitTable(r.toHK, r.firstToHK, r.lastToHK), toPort: waitTable(r.toPort, r.firstToPort, r.lastToPort) })) : [];
  const coachTbl = B ? (B.coaches || []).map(c => ({ toHK: waitTable([[c.toHK.first, c.toHK.last, c.toHK.every]], c.toHK.first, c.toHK.last),
    toPort: c.toPort ? waitTable([[c.toPort.first, c.toPort.last, c.toPort.every]], c.toPort.first, c.toPort.last) : null })) : [];

  // 每个点「从口岸来 / 回口岸去」的几种坐法，按点缓存；跟时刻有关的只有等车那一项
  // ★ 这一步不缓存的话，排一次路线要把每个中间状态都重新算几十遍港铁（实测两分钟排不完）
  const fromPortCache = new Map(), toPortCache = new Map();
  function fromPortList(b) {
    const k = keyOf(b);
    if (fromPortCache.has(k)) return fromPortCache.get(k);
    const out = [];
    B.buses.forEach((r, ri) => { for (const [name, lat, lng, off] of r.stops) {
      if (off <= 0) continue;
      const x = { lat, lng };
      out.push({ tb: busTbl[ri].toHK, shift: 0, ride: off, rest: between(x, b), x,
        how: w => `坐 ${r.route} 到「${name}」（约 ${Math.round(off)} 分钟，等车约 ${Math.round(w)} 分钟）` });
    } });
    (B.coaches || []).forEach((c, ci) => {
      const x = { lat: c.hkStop.lat, lng: c.hkStop.lng };
      out.push({ tb: coachTbl[ci].toHK, shift: 0,
        ride: P.coachMinutes, rest: between(x, b), x,
        how: () => `坐${c.name}到「${c.hkStop.name}」（约 ${P.coachMinutes} 分钟，时长官方没写）` });
    });
    fromPortCache.set(k, out);
    return out;
  }
  function toPortList(a) {
    const k = keyOf(a);
    if (toPortCache.has(k)) return toPortCache.get(k);
    const out = [];
    B.buses.forEach((r, ri) => { for (const [name, lat, lng, off] of r.stops) {
      if (off <= 0) continue;
      const x = { lat, lng };
      // 车从市区起点站开到这一站要 offCity 分钟：这一站的班次 = 起点站班次往后挪 offCity
      const offCity = r.journey - off;
      out.push({ go: between(a, x), tb: busTbl[ri].toPort, shift: offCity, ride: off, x,
        how: w => `到「${name}」坐 ${r.route} 回口岸（约 ${Math.round(off)} 分钟，等车约 ${Math.round(w)} 分钟）` });
    } });
    (B.coaches || []).forEach((c, ci) => {
      if (!c.toPort) return;
      const x = { lat: c.hkStop.lat, lng: c.hkStop.lng };
      out.push({ go: between(a, x), tb: coachTbl[ci].toPort, shift: 0,
        ride: P.coachMinutes, x, how: () => `到「${c.hkStop.name}」坐${c.name}回口岸（约 ${P.coachMinutes} 分钟）` });
    });
    toPortCache.set(k, out);
    return out;
  }
  function bestFromPort(b, t) {
    let best = { min: Infinity };
    for (const o of fromPortList(b)) {
      const w = waitAt(o.tb, t);
      const m = w + o.ride + o.rest;
      if (m < best.min) best = { min: m, o, w };
    }
    return best;
  }
  function bestToPort(a, t) {
    let best = { min: Infinity };
    for (const o of toPortList(a)) {
      const w = waitAt(o.tb, t + o.go - o.shift);
      const m = o.go + w + o.ride;
      if (m < best.min) best = { min: m, o, w };
    }
    return best;
  }

  function leg(a, b, t) {
    if (port && isPort(a) && !isPort(b)) return bestFromPort(b, t).min;
    if (port && isPort(b) && !isPort(a)) return bestToPort(a, t).min;
    return between(a, b);
  }

  // 一段路怎么走（给界面看的一句话）
  function describe(a, b, t) {
    if (port && isPort(a) && !isPort(b)) {
      const r = bestFromPort(b, t);
      return isFinite(r.min) ? { min: r.min, text: r.o.how(r.w) + '，再' + describeLocal(r.o.x, b).text } : { min: Infinity, text: '这个时间没有车' };
    }
    if (port && isPort(b) && !isPort(a)) {
      const r = bestToPort(a, t);
      return isFinite(r.min) ? { min: r.min, text: describeLocal(a, r.o.x).text + '，' + r.o.how(r.w) } : { min: Infinity, text: '这个时间已经没有回口岸的车' };
    }
    return describeLocal(a, b);
  }

  function describeLocal(a, b) {
    const w = walk(a, b), m = mtrBest(a, b);
    if (w <= m.min) return { min: w, text: `步行约 ${Math.max(1, Math.round(w))} 分钟`, mode: 'walk' };
    return { min: m.min, text: mtrText(m), mode: 'mtr', from: st[m.i], to: st[m.j] };
  }

  function mtrText(m) {
    const { prev, rowEnd } = Rprev[m.i];
    const path = [];
    for (let k = rowEnd[m.j]; k >= 0; k = prev[k]) path.push(nodes[k]);
    path.reverse();
    const legs = [];
    for (const n of path) {
      if (!legs.length || legs[legs.length - 1].L !== n.L) legs.push({ L: n.L, from: n.s, to: n.s });
      else legs[legs.length - 1].to = n.s;
    }
    const parts = [`走 ${Math.max(1, Math.round(m.wa))} 分钟到${st[m.i].name}站`];
    legs.forEach((l, idx) => parts.push(`${idx ? '换' : '坐'}${lineName[l.L] || l.L}到${st[l.to].name}`));
    parts.push(`出站走 ${Math.max(1, Math.round(m.wb))} 分钟`);
    return parts.join(' → ') + `（共约 ${Math.round(m.min)} 分钟）`;
  }

  return {
    params: P,
    port,
    isPort,
    stations: st,
    between: (a, b) => leg(a, b, 12 * 60),
    fromStart: null, toEnd: null,     // 由 forTrip() 绑定起终点
    forTrip(start, end) {
      return {
        between: (a, b) => between(a, b),
        fromStart: (b, t) => leg(start, b, t),
        toEnd: (a, t) => leg(a, end, t),
      };
    },
    describe,
    walk,
  };
}
