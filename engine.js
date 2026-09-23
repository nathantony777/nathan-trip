// 排路线的算法核心（纯函数，不碰界面、不碰网络；电脑上 node 能直接跑测试）。
// 规格：../规格.md 第三节。
//
// 模型（一句话）：从起点出发，挑一串「去哪个点、进哪几家店」，每家店到的时候必须开着门、
// 买完之前不关门（到早了就等），最后在最晚时间前回到终点；
// 先让买到的分数最多，同分再让回到终点最早。
//
// ★ 所有时间都是「当天 00:00 起的分钟数」。
// ★ 这里的每个结果最后都会用 simulate() 从头重算一遍核对（见 checkAgainstSimulate）——
//   搜索和重算对不上就直接抛错，不许出一条看着正常的路线（规格 3.4）。

export const DEFAULTS = {
  perItem: 4,          // 每样东西多花几分钟
  intraSite: 2,        // 同一栋楼里换一家店走几分钟
  heavySlack: 30,      // 重物放最后，只要多花不超过这么多分钟。原是 10：9/25 奶粉最后买要多进一家店（约 15 分钟）被判不值，一早买了拎一天；旧计划原文写着「奶粉放最后」
  beamWidth: 1000,     // 每一层最多留多少个中间状态；从来没砍过 = 精确。9/25 那么大（20 样）Mac 上 0.9 秒，放宽到 3000 结果一样（测试/speed.test.mjs）
  maxBranchesPerGroup: 6,
};

const INF = Infinity;

// ---------- 营业时间 ----------

// open: [[开, 关], ...]（分钟，已按当天展开，午休 = 两段）。
// 返回最早能开始买的时刻（保证 开始+dur ≤ 关），没有就 INF。
export function earliestStart(open, t, dur) {
  for (const [o, c] of open) {
    const s = t > o ? t : o;
    if (s + dur <= c + 1e-9) return s;
  }
  return INF;
}

// ---------- 一次进店 ----------

// 按给定顺序进这几家店，每家买分给它的那几组。返回结束时刻和每家的起止；进不去返回 null。
// order: [{store, groups:[g...], items}]；store = 预处理后的店对象
export function visitTimes(order, arrive, P) {
  let t = arrive;
  const parts = [];
  for (let i = 0; i < order.length; i++) {
    const o = order[i];
    if (i > 0) t += P.intraSite;
    const dur = o.store.base + o.store.queue + P.perItem * o.items;
    const begin = earliestStart(o.store.open, t, dur);
    if (begin === INF) return null;
    parts.push({ store: o.store.id, groups: o.groups, arrive: t, begin, end: begin + dur });
    t = begin + dur;
  }
  return { end: t, parts };
}

function permutations(a) {
  if (a.length <= 1) return [a.slice()];
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const rest = a.slice(0, i).concat(a.slice(i + 1));
    for (const p of permutations(rest)) out.push([a[i]].concat(p));
  }
  return out;
}

// ---------- 预处理：店 → 点、组 → 候选 ----------

function haversineM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 把店按「同一栋楼」合成点：有 siteKey 的按 siteKey，没有的 40 米内并一起。
function buildSites(stores) {
  const sites = [];
  const byKey = new Map();
  for (const s of stores) {
    let site = null;
    if (s.siteKey && byKey.has(s.siteKey)) site = byKey.get(s.siteKey);
    if (!site && !s.siteKey) site = sites.find(x => !x.key && haversineM(x, s) < 40) || null;
    if (!site) {
      site = { idx: sites.length, key: s.siteKey || null, lat: s.lat, lng: s.lng, name: s.siteName || s.name, stores: [] };
      sites.push(site);
      if (s.siteKey) byKey.set(s.siteKey, site);
    }
    site.stores.push(s);
  }
  return sites;
}

// 连锁店不全拿来算：每组只留「离每个锚点最近的那家」，最多 maxBranchesPerGroup 家。
// 锚点 = 起点、终点、只有 ≤2 家候选的组的那些店。首选分店永远留。
// ★ 所以「最优」只在候选范围内成立（规格 3.2）。
function pruneCandidates(problem, P, between) {
  const { groups, stores, start, end } = problem;
  const byId = new Map(stores.map(s => [s.id, s]));
  const anchors = [start, end];
  for (const g of groups) {
    const cs = g.stores.map(id => byId.get(id)).filter(Boolean);
    if (cs.length <= 2) anchors.push(...cs);
  }
  const keep = new Set();
  const perGroup = new Map();
  for (const g of groups) {
    const cs = g.stores.map(id => byId.get(id)).filter(Boolean);
    let chosen;
    if (cs.length <= P.maxBranchesPerGroup) chosen = cs;
    else {
      const score = new Map();
      for (const a of anchors) {
        let best = null, bestT = INF;
        for (const c of cs) {
          const t = between(a, c);
          if (t < bestT) { bestT = t; best = c; }
        }
        if (best && (!score.has(best.id) || score.get(best.id) > bestT)) score.set(best.id, bestT);
      }
      chosen = [...score.entries()].sort((x, y) => x[1] - y[1]).slice(0, P.maxBranchesPerGroup).map(([id]) => byId.get(id));
      for (const id of (g.preferred || [])) if (byId.has(id) && !chosen.includes(byId.get(id))) chosen.push(byId.get(id));
    }
    perGroup.set(g.id, chosen.map(c => c.id));
    for (const c of chosen) keep.add(c.id);
  }
  // 同一栋楼里的其他候选店也留（去一次顺手买）：同 siteKey，或离某家留下的店 40 米内
  const keptList = [...keep].map(id => byId.get(id));
  const allCand = new Set(groups.flatMap(g => g.stores));
  for (const id of allCand) {
    if (keep.has(id)) continue;
    const s = byId.get(id);
    if (!s) continue;
    if (keptList.some(k => (s.siteKey && k.siteKey === s.siteKey) || (!s.siteKey && !k.siteKey && haversineM(k, s) < 40))) keep.add(id);
  }
  return { keep, perGroup };
}

// ---------- 主入口 ----------

// problem = {
//   t0, deadline, start:{lat,lng}, end:{lat,lng},
//   stores:[{id,name,lat,lng,siteKey?,siteName?,open:[[o,c]],base,queue}],
//   groups:[{id,label,stores:[id],preferred?:[id],items,value,heavy?}],
// }
// travel = { between(a,b), fromStart(b,t0), toEnd(a,t) }   （分钟；到不了给 Infinity）
export function planRoute(problem, travel, opts = {}) {
  const P = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  if (!(problem.deadline > problem.t0)) throw new Error('最晚回到终点的时间早于出发时间');

  const hasPreferred = problem.groups.some(g => g.preferred && g.preferred.length);
  const hasHeavy = problem.groups.some(g => g.heavy);

  const strictGroups = problem.groups.map(g =>
    g.preferred && g.preferred.length ? { ...g, stores: g.stores.filter(id => g.preferred.includes(id)) } : g);

  const runs = [];
  const A = solve({ ...problem, groups: strictGroups }, travel, P, hasHeavy);
  runs.push(A);
  let chosen = A;
  if (hasHeavy) {
    const B = solve({ ...problem, groups: strictGroups }, travel, P, false);
    runs.push(B);
    // 重物放最后：同分、且只多花 ≤ heavySlack 分钟，就用放最后那版
    if (!(A.value >= B.value && A.finish <= B.finish + P.heavySlack)) chosen = B;
  }
  let preferredCost = null;
  if (hasPreferred) {
    const C = solve(problem, travel, P, chosen.heavyLast);
    runs.push(C);
    if (C.value >= chosen.value && C.finish < chosen.finish - 0.5) {
      preferredCost = { minutes: Math.round(chosen.finish - C.finish), alt: C };
    } else preferredCost = { minutes: 0, alt: null };
  }
  if (chosen.status === 'cannotReturn') {
    chosen.dropped = [];
    chosen.elapsedMs = Date.now() - t0;
    return chosen;
  }
  chosen.dropped = explainDropped(problem, chosen, travel, P);
  chosen.preferredCost = preferredCost;
  chosen.elapsedMs = Date.now() - t0;
  chosen.exact = runs.every(r => r.exact);
  return chosen;
}

// 一次搜索（固定：首选是否严格、重物是否放最后）
//
// ★ 模型的一个约定（规格 3.1）：进一家店，要么把这家有的、单上还没买的【全买】，
//   要么【只买必买的】（跳过可买可不买的，省几分钟）。不会在一家店只买一部分必买的。
// ★ 每一步 = 去一家店（同一栋楼里的下一家只算 intraSite 分钟）。同楼几家连着逛，
//   就是连着几步都在同一个点，界面上合成一站显示。
export function solve(problem, travel, P, heavyLast) {
  const { t0, deadline } = problem;
  const between = (a, b) => travel.between(a, b);
  const { keep } = pruneCandidates(problem, P, between);

  // 组：有候选店的才参与；没有的留给 explainDropped
  const groups = problem.groups.filter(g => g.stores.some(id => keep.has(id)));
  const G = groups.length;
  if (G > 30) throw new Error(`一次最多算 30 组，现在 ${G} 组`);
  const heavyMask = groups.reduce((m, g, i) => (g.heavy ? m | (1 << i) : m), 0) >>> 0;
  const mustMask = groups.reduce((m, g, i) => (g.value >= 100 ? m | (1 << i) : m), 0) >>> 0;

  // 店：候选里留下的，外加跟它们同楼的其他候选（buildSites 之后按楼合并）
  // ★ 一家店能买哪几组，按组的【完整】候选名单算，不按裁剪后的：
  //   万宁留下来是因为「护肤品」要它，它也卖「任何药房」那组，就得算上（裁剪只决定去不去考虑这家店）
  const storeObjs = problem.stores.filter(s => keep.has(s.id)).map(s => ({ ...s, gmask: 0 }));
  const storeById = new Map(storeObjs.map(s => [s.id, s]));
  groups.forEach((g, i) => {
    for (const id of g.stores) { const s = storeById.get(id); if (s) s.gmask = (s.gmask | (1 << i)) >>> 0; }
  });
  const sites = buildSites(storeObjs);
  const S = sites.length;
  for (const site of sites) for (const s of site.stores) s.site = site.idx;
  const shops = storeObjs.filter(s => s.gmask);
  const N = shops.length;

  // 行程矩阵（点与点之间，跟时刻无关）；同一个点 = 同楼换一家店
  const T = [];
  for (let a = 0; a < S; a++) {
    T.push(new Float64Array(S));
    for (let b = 0; b < S; b++) T[a][b] = a === b ? P.intraSite : between(sites[a], sites[b]);
  }
  const fromStart = sites.map(s => travel.fromStart(s, t0));
  const endStatic = sites.map(s => travel.toEnd(s, Math.min(deadline, 12 * 60)));

  const itemsOf = groups.map(g => g.items);
  const valueOf = groups.map(g => g.value);
  const maskValue = m => { let v = 0; for (let i = 0; i < G; i++) if (m & (1 << i)) v += valueOf[i]; return v; };
  const maskItems = m => { let v = 0; for (let i = 0; i < G; i++) if (m & (1 << i)) v += itemsOf[i]; return v; };

  // 在店 j、还缺 avail 的情况下，能买的几种方式（全买 / 只买必买）
  function choices(avail) {
    const out = [avail];
    const m = (avail & mustMask) >>> 0;
    if (m && m !== avail) out.push(m);
    return out;
  }
  function tryShop(s, buy, arrive) {
    const dur = s.base + s.queue + P.perItem * maskItems(buy);
    const b = earliestStart(s.open, arrive, dur);
    return b === INF ? INF : b + dur;
  }

  // 分层搜索：第 k 层 = 已买 k 组。key = mask * (S+1) + 点；同 key 只留最早到的（晚到不会更好：可以等）
  const allow = heavyLast ? (~heavyMask >>> 0) : 0xffffffff;
  const labels = [{ mask: 0, site: S, t: t0, prev: -1 }];
  const layers = Array.from({ length: G + 1 }, () => new Map());
  layers[0].set(S, 0);
  let exact = true;

  // 剩下必去的组里最远那一组：去一趟 + 回终点，用来给中间状态排队（只影响砍掉谁，不影响精确解）
  const minToGroup = groups.map((g, i) => sites.map((_, u) => {
    let best = INF;
    for (let v = 0; v < S; v++) if (sites[v].stores.some(s => s.gmask & (1 << i))) best = Math.min(best, T[u][v] + endStatic[v]);
    return best;
  }));
  function rank(L) {
    let h = L.site === S ? 0 : endStatic[L.site];
    if (L.site !== S) for (let i = 0; i < G; i++) if (!(L.mask & (1 << i)) && (allow & (1 << i)) && (mustMask & (1 << i))) h = Math.max(h, minToGroup[i][L.site]);
    return L.t + h;
  }

  function relax(L, id, s, buy, arrive, end) {
    const nm = (L.mask | buy) >>> 0;
    const layer = layers[popcount(nm)];
    const key = nm * (S + 1) + s.site;
    const ex = layer.get(key);
    if (ex !== undefined && labels[ex].t <= end) return;
    const rec = { mask: nm, site: s.site, t: end, prev: id, shop: s, buy, arrive };
    if (ex !== undefined) labels[ex] = rec; else { layer.set(key, labels.length); labels.push(rec); }
  }

  for (let k = 0; k <= G; k++) {
    let ids = [...layers[k].values()];
    if (ids.length > P.beamWidth) {
      exact = false;
      ids = ids.map(id => [id, rank(labels[id])]).sort((a, b) => a[1] - b[1]).slice(0, P.beamWidth).map(x => x[0]);
    }
    for (const id of ids) {
      const L = labels[id];
      for (let j = 0; j < N; j++) {
        const s = shops[j];
        const avail = (s.gmask & ~L.mask & allow) >>> 0;
        if (!avail) continue;
        const arrive = L.site === S ? t0 + fromStart[s.site] : L.t + T[L.site][s.site];
        if (!(arrive < deadline)) continue;
        for (const buy of choices(avail)) {
          const end = tryShop(s, buy, arrive);
          if (end > deadline) continue;
          relax(L, id, s, buy, arrive, end);
        }
      }
    }
  }

  // 收尾：每个状态直接回终点；重物放最后时，还可以先去一家买重物再回
  // 什么都不买、直接回终点也是一个方案；连这个都赶不上，下面会报出来
  const direct = directFinish(problem, travel);
  let best = direct <= deadline ? { value: 0, finish: direct, id: 0, extra: null } : { value: -1, finish: INF, id: -1, extra: null };
  // 按「最多能拿几分」从高到低看：拿不到当前最好分数的直接跳过，不用算回终点要多久
  // （回终点这一步要查巴士班次，是收尾最慢的地方）
  const heavyVal = heavyLast ? groups.map((g, i) => (heavyMask & (1 << i) ? g.value : 0)) : null;
  const order = [];
  for (let id = 1; id < labels.length; id++) {
    const L = labels[id];
    const val = maskValue(L.mask);
    let cap = val;
    if (heavyLast) for (let i = 0; i < G; i++) if (heavyMask & ~L.mask & (1 << i)) cap += heavyVal[i];
    order.push([id, val, cap]);
  }
  order.sort((a, b) => b[2] - a[2]);
  for (const [id, val, cap] of order) {
    if (cap < best.value) break;
    const L = labels[id];
    if (val > best.value || (val === best.value && L.t < best.finish)) {
      const fin = L.t + travel.toEnd(sites[L.site], L.t);
      if (fin <= deadline && better(val, fin, best)) best = { value: val, finish: fin, id, extra: null };
    }
    if (heavyLast && cap > val && cap >= best.value) {
      for (const s of shops) {
        const avail = (s.gmask & ~L.mask) >>> 0;
        if (!(avail & heavyMask)) continue;
        const arrive = L.t + T[L.site][s.site];
        for (const buy of choices(avail)) {
          if (!(buy & heavyMask)) continue;
          const val2 = maskValue((L.mask | buy) >>> 0);
          if (val2 < best.value) continue;
          const end = tryShop(s, buy, arrive);
          if (end > deadline) continue;
          if (val2 === best.value && end >= best.finish) continue;
          const f2 = end + travel.toEnd(sites[s.site], end);
          if (f2 > deadline) continue;
          if (better(val2, f2, best)) best = { value: val2, finish: f2, id, extra: { shop: s, buy, arrive } };
        }
      }
    }
  }

  if (best.id < 0) {
    return { heavyLast, exact, status: 'cannotReturn', value: 0, finish: INF, states: labels.length, visits: [], covered: [] };
  }
  // 还原：一步一家店；连着在同一个点的几步合成一站
  const steps = [];
  for (let id = best.id; id > 0; id = labels[id].prev) steps.push(labels[id]);
  steps.reverse();
  if (best.extra) steps.push({ site: best.extra.shop.site, shop: best.extra.shop, buy: best.extra.buy });
  const visits = [];
  const coveredIds = [];
  for (const st of steps) {
    const gids = [];
    for (let i = 0; i < G; i++) if (st.buy & (1 << i)) { gids.push(groups[i].id); coveredIds.push(groups[i].id); }
    const last = visits[visits.length - 1];
    const part = { store: st.shop.id, groups: gids };
    if (last && last.siteIdx === st.site) last.parts.push(part);
    else visits.push({ siteIdx: st.site, site: { lat: sites[st.site].lat, lng: sites[st.site].lng, name: sites[st.site].name }, parts: [part] });
  }

  const result = {
    status: 'ok',
    heavyLast,
    exact,
    value: best.value,
    finish: best.finish,
    states: labels.length,
    visits: visits.map(v => ({ site: v.site, parts: v.parts })),
    covered: coveredIds,
  };
  checkAgainstSimulate(problem, travel, P, result);
  return result;
}

function directFinish(problem, travel) {
  return problem.t0 + travel.toEnd(problem.start, problem.t0);
}

function better(val, fin, best) {
  return val > best.value || (val === best.value && fin < best.finish - 1e-9);
}

function popcount(m) {
  m = m - ((m >>> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// ---------- 从头重算一遍（界面显示的时刻就是这个函数算出来的） ----------

// visits: [{site:{lat,lng}, parts:[{store:id, groups:[groupId]}]}]
// 返回 {finish, value, visits:[{arrive, parts:[{store,groups,arrive,begin,end}]}]}；不可行抛错。
export function simulate(problem, travel, P, visits) {
  P = { ...DEFAULTS, ...P };
  const storeById = new Map(problem.stores.map(s => [s.id, s]));
  const groupById = new Map(problem.groups.map(g => [g.id, g]));
  const bought = new Set();
  let t = problem.t0, pos = null, value = 0;
  const out = [];
  for (const v of visits) {
    const same = pos !== null && pos.lat === v.site.lat && pos.lng === v.site.lng;
    const arrive = pos === null ? t + travel.fromStart(v.site, t) : t + (same ? P.intraSite : travel.between(pos, v.site));
    const plan = v.parts.map(p => {
      const st = storeById.get(p.store);
      if (!st) throw new Error(`路线里有一家不存在的店：${p.store}`);
      let items = 0;
      for (const gid of p.groups) {
        const g = groupById.get(gid);
        if (!g) throw new Error(`路线里有一组不存在：${gid}`);
        if (!g.stores.includes(p.store)) throw new Error(`「${g.label || gid}」不在「${st.name}」卖`);
        if (bought.has(gid)) throw new Error(`「${g.label || gid}」买了两次`);
        bought.add(gid); items += g.items; value += g.value;
      }
      return { store: st, groups: p.groups, items };
    });
    const r = visitTimes(plan, arrive, P);
    if (!r) throw new Error(`到「${v.site.name || '某个点'}」时店不开门`);
    out.push({ arrive, parts: r.parts });
    t = r.end; pos = v.site;
  }
  const finish = pos === null ? t + travel.toEnd(problem.start, t) : t + travel.toEnd(pos, t);
  return { finish, value, visits: out };
}

function checkAgainstSimulate(problem, travel, P, result) {
  const sim = simulate(problem, travel, P, result.visits);
  if (Math.abs(sim.finish - result.finish) > 0.01 || sim.value !== result.value) {
    throw new Error(`算法内部核对不上：搜索说 ${result.finish.toFixed(2)} 回到、${result.value} 分；重算是 ${sim.finish.toFixed(2)}、${sim.value} 分`);
  }
  if (sim.finish > problem.deadline + 1e-9) throw new Error('算法内部核对不上：路线超过最晚回程时间');
  result.visits.forEach((v, i) => { v.arrive = sim.visits[i].arrive; v.parts = sim.visits[i].parts; });
}

// ---------- 去不了的，逐样说原因（规格 3.4） ----------

function explainDropped(problem, result, travel, P) {
  const covered = new Set(result.covered);
  const storeById = new Map(problem.stores.map(s => [s.id, s]));
  const out = [];
  for (const g of problem.groups) {
    if (covered.has(g.id)) continue;
    const cands = g.stores.map(id => storeById.get(id)).filter(Boolean);
    if (!cands.length) { out.push({ group: g.id, reason: 'noLocation', text: '没有这家店的位置数据' }); continue; }
    // 单独去一趟行不行
    // ★ 分三种说：关门前到不了 / 到了但关门前办不完 / 办得完但赶不上回终点。
    //   原先只分了第一种和第三种：12–14 点能去的午饭 13:24 才到、要待 51 分钟，被说成「赶不上 21:30 回终点」（0923 界面上看到的）
    let anyAlone = false, anyStart = false, closedAll = true, bestArr = INF, bestStore = null, bestDur = 0;
    for (const s of cands) {
      if (s.open.length) closedAll = false;
      const arr = problem.t0 + travel.fromStart(s, problem.t0);
      const dur = s.base + s.queue + P.perItem * g.items;
      if (arr < bestArr) { bestArr = arr; bestStore = s; bestDur = dur; }
      const b = earliestStart(s.open, arr, dur);
      if (b === INF) continue;
      anyStart = true;
      const fin = b + dur + travel.toEnd(s, b + dur);
      if (fin <= problem.deadline) { anyAlone = true; break; }
    }
    if (closedAll) out.push({ group: g.id, reason: 'closed', text: '这一天不开门' });
    else if (!anyAlone) {
      const s = bestStore;
      const close = s.open.length ? s.open[s.open.length - 1][1] : null;
      if (!anyStart && close !== null && bestArr >= close) out.push({ group: g.id, reason: 'tooLate', text: `关门前到不了（最早 ${hm(bestArr)} 到，${hm(close)} 关）` });
      else if (!anyStart) out.push({ group: g.id, reason: 'tooLate', text: `到了也来不及在关门前办完（最早 ${hm(bestArr)} 到，要待 ${Math.round(bestDur)} 分钟，${close !== null ? hm(close) + ' 关' : '时间不够'}）` });
      else out.push({ group: g.id, reason: 'deadline', text: `单独去一趟也赶不上 ${hm(problem.deadline)} 回终点` });
    } else out.push({ group: g.id, reason: 'squeezed', text: `时间不够：排进去会挤掉更多别的东西，或赶不上 ${hm(problem.deadline)} 回终点` });
  }
  return out;
}

export function hm(t) {
  if (!isFinite(t)) return '—';
  const m = Math.round(t);
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}:${String(mm).padStart(2, '0')}`;
}
