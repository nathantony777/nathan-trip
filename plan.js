// 「清单 + 自己加的地方 + 设置」→ 算法的输入；排完再翻译成界面要显示的样子。
// 规格：../规格.md 第二节、「二之半、随时改」、第三节。
//
// ★ 不存路线：每次都拿【当时的清单 + 当时的位置 + 当时的时间】从头排（二之半）。
//   所以加 / 删 / 改东西和地方，都只是改 state，再调一次 makePlan()。
// ★ 纯函数（除了下面那几个改 state 的小函数），不碰界面、不碰存储；电脑上 node 能直接测。

import { openOn, dowOf, HK_PH_2026 } from './hours.js';
import { planRoute, hm } from './engine.js';
import { haversineM } from './transit.js';

export const DONE = new Set(['bought', 'skip', 'enough', 'notEnough']);   // 这几种状态不再排

export const END_OPTIONS = [
  { key: 'port', name: '深圳湾口岸' },
  { key: 'LOW', name: '罗湖口岸（港铁罗湖站）', station: 'LOW' },
  { key: 'LMC', name: '落马洲支线口岸（港铁落马洲站）', station: 'LMC' },
  { key: 'XRL', name: '高铁西九龙站（按旁边的柯士甸站算）', station: 'AUS' },
];

export const PLAN_DEFAULTS = {
  date: '2026-09-25',
  start: { kind: 'port' },     // port | station{code} | here{lat,lng} | place{id}
  startTime: 7 * 60 + 15,      // 深圳湾 06:30 开门 + 过关
  end: { kind: 'port' },       // port | station{code, name} | place{id}
  deadline: 23 * 60 + 30,      // Nathan 0923：「能回大陆就行，按最晚的算」→ 口岸 24:00 关，留半小时排队过关
  base: 8,                     // 每家店停留 8 分钟 + 每样 4 分钟（perItem 在 engine）
  bakeryQueue: 15,             // 中秋正日饼家另加的排队时间
  bakeryQueueDates: ['2026-09-25'],
};

export function newState() {
  return { items: [], places: [], excluded: [], settings: { ...PLAN_DEFAULTS } };
}

// ---------------- 改 state 的小函数（界面和测试共用） ----------------

export function addItems(state, items) { state.items.push(...items); return state; }
export function removeItem(state, id) { state.items = state.items.filter(i => i.id !== id); return state; }
export function updateItem(state, id, patch) {
  const it = state.items.find(i => i.id === id);
  if (!it) throw new Error(`找不到这一样：${id}`);
  Object.assign(it, patch);
  return state;
}
export function markItem(state, id, status) {
  if (!['todo', ...DONE].includes(status)) throw new Error(`认不出的状态：${status}`);
  return updateItem(state, id, { status });
}
// 没货 = 这一家划掉，换别的分店（二之半）
export function noStockAt(state, itemId, storeId) {
  const it = state.items.find(i => i.id === itemId);
  if (!it) throw new Error(`找不到这一样：${itemId}`);
  it.noStock = [...new Set([...(it.noStock || []), storeId])];
  if (it.forced === storeId) it.forced = null;
  return state;
}
// 这家不去了（所有东西都不在这家买）
export function excludeStore(state, storeId) {
  state.excluded = [...new Set([...(state.excluded || []), storeId])];
  for (const it of state.items) if (it.forced === storeId) it.forced = null;
  return state;
}
export function unexcludeStore(state, storeId) { state.excluded = (state.excluded || []).filter(x => x !== storeId); return state; }
// 一定去这家：这一样只剩这一家
export function forceStore(state, itemId, storeId) {
  unexcludeStore(state, storeId);
  const it = state.items.find(i => i.id === itemId);
  if (!it) throw new Error(`找不到这一样：${itemId}`);
  it.forced = storeId;
  it.noStock = (it.noStock || []).filter(x => x !== storeId);
  return state;
}

let seq = 0;
const newId = p => p + Date.now().toString(36) + (seq++).toString(36);

// 自己加的地方：{ name, lat, lng, dur(分钟), from, to(分钟，可空), must, note, how }
// 挂在它上面的东西：item.where = {type:'place', place: id}；一样都没挂 = 去这个地方本身就是一件事（吃饭、取货）
export function addPlace(state, p) {
  if (!p.name) throw new Error('地方要有个名字');
  checkHK(p.lat, p.lng);
  const place = { id: newId('p'), status: 'todo', dur: 15, from: null, to: null, must: true, note: '', how: '', ...p };
  state.places.push(place);
  return place;
}
export function updatePlace(state, id, patch) {
  const p = state.places.find(x => x.id === id);
  if (!p) throw new Error(`找不到这个地方：${id}`);
  if ('lat' in patch || 'lng' in patch) checkHK(patch.lat ?? p.lat, patch.lng ?? p.lng);
  Object.assign(p, patch);
  return state;
}
export function removePlace(state, id) {
  state.places = state.places.filter(p => p.id !== id);
  // 挂在它上面的东西变成「不知道在哪买」，不跟着删（一样都不许丢）
  for (const it of state.items) if (it.where && it.where.type === 'place' && it.where.place === id) it.where = null;
  if (state.settings.start.kind === 'place' && state.settings.start.id === id) state.settings.start = { kind: 'port' };
  if (state.settings.end.kind === 'place' && state.settings.end.id === id) state.settings.end = { kind: 'port' };
  return state;
}

function checkHK(lat, lng) {
  if (!(lat > 22.1 && lat < 22.6 && lng > 113.8 && lng < 114.5)) throw new Error('这个位置不在香港（这一版只有香港的数据）');
}

// 从一段文字里找坐标：谷歌 / 苹果地图的分享链接、或者直接写的「22.3, 114.17」。
// 短链接（maps.app.goo.gl 这种）里没有坐标，离线打不开 → 返回 null，界面提示换一种。
export function coordsFromText(text) {
  const s = decodeURIComponent(String(text || '')).replace(/\s+/g, ' ');
  const pats = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,                                            // 谷歌地图地点页（最准）
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,                                                // 谷歌地图视野中心
    /[?&](?:q|ll|sll|daddr|destination|query|center|coordinate)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,   // 苹果 / 谷歌参数
    /(?:^|[^\d.])(2[12]\.\d{3,})\s*[,，]\s*(11[34]\.\d{3,})/,                     // 直接写的坐标
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (isFinite(lat) && isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

// ---------------- 起点 / 终点 ----------------

function stationPt(T, code) {
  const s = T.stations.find(x => x.code === code);
  if (!s) throw new Error(`港铁站 ${code} 不在数据里`);
  return { lat: s.lat, lng: s.lng, name: `港铁${s.name}站` };
}

export function resolvePoint(state, T, pt, which) {
  if (!pt || pt.kind === 'port') return { ...T.port, name: '深圳湾口岸', kind: 'port' };
  if (pt.kind === 'station') {
    const s = stationPt(T, pt.code);
    const opt = END_OPTIONS.find(o => o.station === pt.code);
    return { ...s, name: which === 'end' && opt ? opt.name : `${s.name}附近` };
  }
  if (pt.kind === 'here') { checkHK(pt.lat, pt.lng); return { lat: pt.lat, lng: pt.lng, name: pt.name || '我现在的位置' }; }
  if (pt.kind === 'place') {
    const p = state.places.find(x => x.id === pt.id);
    if (!p) throw new Error(`${which === 'end' ? '终点' : '起点'}那个地方被删了`);
    return { lat: p.lat, lng: p.lng, name: p.name };
  }
  throw new Error(`认不出的${which === 'end' ? '终点' : '起点'}：${JSON.stringify(pt)}`);
}

// ---------------- 每样东西能在哪几家买 ----------------

function brandStores(data, brands) {
  return data.stores.filter(s => brands.includes(s.brand)).map(s => s.id);
}

// 返回 {ids, why}；ids 空的时候 why 说清楚为什么
export function candidatesOf(item, state, data) {
  const w = item.where;
  if (!w) return { ids: [], why: 'noWhere', text: '不知道在哪买（在清单页点它，选一家店或加一个地方）' };
  let ids;
  if (w.type === 'place') {
    const p = state.places.find(x => x.id === w.place);
    if (!p) return { ids: [], why: 'noWhere', text: '它挂的那个地方被删了' };
    if (p.status !== 'todo') return { ids: [], why: 'placeDone', text: '那个地方已经去过 / 不去了' };
    ids = ['place:' + p.id];
  } else if (w.type === 'branch') ids = [...(w.stores || [])];
  else if (w.type === 'brand' || w.type === 'preferred') ids = brandStores(data, [w.brand]);
  else if (w.type === 'category' || w.type === 'oneOf') ids = brandStores(data, w.brands || []);
  else if (w.type === 'stores') ids = [...(w.stores || [])];
  else throw new Error(`认不出的「在哪买」：${w.type}`);
  if (!ids.length) {
    const b = w.brand || (w.brands || []).join(' / ');
    return { ids: [], why: 'noLocation', text: `数据里没有「${b}」的店的位置` };
  }
  if (item.forced) return { ids: [item.forced], why: null };
  const ex = new Set([...(state.excluded || []), ...(item.noStock || [])]);
  const left = ids.filter(id => !ex.has(id));
  if (!left.length) return { ids: [], why: 'allCrossed', text: '能买的店都标了「没货」或「不去了」' };
  return { ids: left, why: null };
}

// 条件备选（奇华顶替恒香）：返回 'on' | 'off' | 'ifDropped'
// ★ 只有「买到了 / 够了」才让它不去；恒香「没买够」、被删、被跳过 → 它进路线；恒香还没买 → 看恒香排不排得进去
function backupMode(item, state) {
  const B = item.backupFor;
  const prim = state.items.filter(i => i !== item && !i.backupFor && i.where &&
    (i.where.brand === B || (i.where.brands || []).includes(B)));
  if (prim.some(i => i.status === 'notEnough')) return 'on';
  if (prim.some(i => i.status === 'bought' || i.status === 'enough')) return 'off';
  if (!prim.some(i => i.status === 'todo')) return 'on';
  return 'ifDropped';
}

// ---------------- 拼成算法的输入 ----------------

export function buildProblem(state, data, T, { backupsOn = new Set() } = {}) {
  const S = state.settings;
  const dow = dowOf(S.date), isPH = HK_PH_2026.has(S.date);
  const queueDay = (S.bakeryQueueDates || []).includes(S.date);
  const brandKind = new Map(data.brands.map(b => [b.brand, b.kind || '']));
  const storeData = new Map(data.stores.map(s => [s.id, s]));

  const problemStores = new Map();
  const storeObj = id => {
    if (problemStores.has(id)) return problemStores.get(id);
    let o;
    if (id.startsWith('place:')) {
      const p = state.places.find(x => 'place:' + x.id === id);
      const open = [[p.from ?? 0, p.to ?? 26 * 60]];
      o = { id, name: p.name, lat: p.lat, lng: p.lng, open, base: (Number(p.dur) || 0) + (Number(p.walk) || 0), queue: 0 };   // walk = 从站走过去再走回来
    } else {
      const s = storeData.get(id);
      if (!s) throw new Error(`店 ${id} 不在数据里（数据更新过？）`);
      const q = queueDay && /饼/.test(brandKind.get(s.brand)) ? S.bakeryQueue : 0;
      o = { id, name: `${s.brand} ${s.name}`, lat: s.lat, lng: s.lng, open: openOn(s.hours, dow, isPH).open, base: S.base, queue: q };
    }
    problemStores.set(id, o);
    return o;
  };

  const todo = state.items.filter(i => i.status === 'todo' || !i.status);
  const skipped = [];        // 这一趟不排的：{items, why, text}
  const pendingBackups = []; // 等主店排完再看要不要的
  const buckets = new Map();
  for (const it of todo) {
    if (it.backupFor) {
      const mode = backupMode(it, state);
      if (mode === 'off') continue;
      if (mode === 'ifDropped' && !backupsOn.has(it.backupFor)) { pendingBackups.push(it); continue; }
    }
    const c = candidatesOf(it, state, data);
    if (!c.ids.length) { skipped.push({ items: [it], why: c.why, text: c.text }); continue; }
    const pref = it.forced ? [] : (it.where.type === 'preferred' ? (it.where.preferred || []).filter(id => c.ids.includes(id)) : []);
    const must = it.must !== false;
    const key = JSON.stringify([[...c.ids].sort(), must, !!it.heavy, [...pref].sort()]);
    if (!buckets.has(key)) buckets.set(key, { ids: c.ids, must, heavy: !!it.heavy, pref, items: [] });
    buckets.get(key).items.push(it);
  }
  // 地方本身就是一件事（没挂东西、还没去）
  for (const p of state.places) {
    if (p.status !== 'todo') continue;
    if (todo.some(i => i.where && i.where.type === 'place' && i.where.place === p.id)) continue;
    const pseudo = { id: 'place:' + p.id, name: p.name, qty: 1, who: [], note: p.note || '', must: p.must !== false, isPlace: true };
    const key = 'place:' + p.id;
    buckets.set(key, { ids: [key], must: pseudo.must, heavy: false, pref: [], items: [pseudo], zeroItems: true });
  }

  const groups = [];
  const groupItems = new Map();
  let n = 0;
  for (const b of buckets.values()) {
    const id = 'g' + (n++);
    for (const sid of b.ids) storeObj(sid);
    groups.push({
      id, label: b.items.map(i => i.name).join('、'), stores: b.ids,
      preferred: b.pref.length ? b.pref : undefined,
      items: b.zeroItems ? 0 : b.items.length,
      value: b.items.length * (b.must ? 100 : 1),
      heavy: b.heavy || undefined,
    });
    groupItems.set(id, b.items);
  }

  const start = resolvePoint(state, T, S.start, 'start');
  const end = resolvePoint(state, T, S.end, 'end');
  const problem = { t0: S.startTime, deadline: S.deadline, start, end, stores: [...problemStores.values()], groups };
  return { problem, groupItems, skipped, pendingBackups, start, end };
}

// ---------------- 排 + 翻译成界面要的样子 ----------------

export function makePlan(state, data, T, opts = {}) {
  const S = state.settings;
  if (!(S.deadline > S.startTime)) return { ok: false, error: `最晚回到终点（${hm(S.deadline)}）早于出发时间（${hm(S.startTime)}）` };
  let built, result;
  try {
    built = buildProblem(state, data, T);
    const tr = T.forTrip(built.start, built.end);
    result = planRoute(built.problem, tr, opts.engine);
    // 条件备选：它顶替的那家一样都没排进去 → 把它加进来再排一次（规格 3.3）
    const covered = new Set(result.covered || []);
    const droppedBrands = new Set();
    for (const it of built.pendingBackups) {
      const B = it.backupFor;
      const primGroups = [...built.groupItems.entries()].filter(([, its]) =>
        its.some(i => i.where && (i.where.brand === B || (i.where.brands || []).includes(B))));
      const primSkipped = built.skipped.some(s => s.items.some(i => i.where && i.where.brand === B));
      if (primSkipped || (primGroups.length && primGroups.every(([gid]) => !covered.has(gid)))) droppedBrands.add(B);
    }
    if (droppedBrands.size) {
      built = buildProblem(state, data, T, { backupsOn: droppedBrands });
      result = planRoute(built.problem, T.forTrip(built.start, built.end), opts.engine);
      built.backupsActivated = [...droppedBrands];
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return present(state, data, T, built, result);
}

function present(state, data, T, built, r) {
  const S = state.settings;
  const storeData = new Map(data.stores.map(s => [s.id, s]));
  const prodBy = new Map(data.products.map(p => [p.product, p]));
  const dow = dowOf(S.date), isPH = HK_PH_2026.has(S.date);
  const pStore = new Map(built.problem.stores.map(s => [s.id, s]));
  const itemView = it => ({ id: it.id, name: it.name, qty: it.qty || 1, who: it.who || [], note: it.note || '', isPlace: !!it.isPlace,
    stockNote: stockNote(it, prodBy) });

  const warnings = [];
  if ((S.bakeryQueueDates || []).includes(S.date)) warnings.push('今天是中秋正日：营业时间可能提早收，重要的店先打电话；饼家每家多算了 15 分钟排队。');
  if (built.backupsActivated) for (const B of built.backupsActivated) warnings.push(`「${B}」排不进去，条件备选那家已经加进来了。`);

  if (r.status === 'cannotReturn') {
    return { ok: true, cannotReturn: true, start: built.start, end: built.end, stops: [], warnings,
      text: `从${built.start.name} ${hm(S.startTime)} 出发，${hm(S.deadline)} 前回不到${built.end.name}（最后一班车赶不上，或者时间太紧）`,
      dropped: [], skipped: built.skipped.map(s => ({ items: s.items.map(itemView), text: s.text })) };
  }

  const stops = [];
  let prev = built.start, prevT = S.startTime;
  for (const v of r.visits) {
    const leg = T.describe(prev, v.site, prevT);
    const parts = v.parts.map(p => {
      const ps = pStore.get(p.store);
      const sd = storeData.get(p.store);
      const place = p.store.startsWith('place:') ? state.places.find(x => 'place:' + x.id === p.store) : null;
      const flags = [];
      if (sd && !sd.coordOk) flags.push('位置没核准（地址换坐标时匹配分数低）');
      if (sd && !openOn(sd.hours, dow, isPH).verified) flags.push('营业时间未核实，按 10:00–20:00 算的');
      if (ps.queue) flags.push(`算了 ${ps.queue} 分钟排队`);
      const its = p.groups.flatMap(gid => built.groupItems.get(gid) || []);
      return {
        storeId: p.store, name: ps.name, brand: sd ? sd.brand : null, addr: sd ? sd.addr : (place && place.note) || '',
        // 显示的是【算法用的】当天营业时间（跟排出来的时刻对得上）；原始资料文字留在 hoursRaw，有的带出处，太乱不直接显示
        phone: sd ? sd.phone : '', hoursToday: sd || place.from != null || place.to != null ? hoursText(ps.open) : '', hoursRaw: sd ? sd.hoursRaw : '',
        arrive: p.arrive, begin: p.begin, end: p.end, wait: Math.max(0, Math.round(p.begin - p.arrive)),
        flags, items: its.map(itemView), isPlace: !!place, placeId: place ? place.id : null,
      };
    });
    const leave = parts[parts.length - 1].end;
    stops.push({ arrive: v.arrive, leave, lat: v.site.lat, lng: v.site.lng,
      title: [...new Set(parts.map(p => p.name))].join(' + '),
      leg: { text: leg.text, min: leg.min, links: mapLinks(prev, v.site) }, parts });
    prev = v.site; prevT = leave;
  }
  const back = T.describe(prev, built.end, prevT);

  const dropped = (r.dropped || []).map(d => ({ items: (built.groupItems.get(d.group) || []).map(itemView), reason: d.reason, text: d.text }));
  let preferredCost = null;
  if (r.preferredCost && r.preferredCost.minutes > 0) {
    const alt = r.preferredCost.alt;
    const altNames = alt ? alt.visits.flatMap(v => v.parts.map(p => pStore.get(p.store).name)) : [];
    preferredCost = { minutes: r.preferredCost.minutes, text: `照你指定的分店去；不管指定、换最近的分店能早 ${r.preferredCost.minutes} 分钟回到终点`, altNames };
  }
  return {
    ok: true, exact: r.exact, elapsedMs: r.elapsedMs,
    start: { ...built.start, time: S.startTime },
    end: { ...built.end, arrive: r.finish, deadline: S.deadline },
    back: { text: back.text, min: back.min, links: mapLinks(prev, built.end) },
    stops, dropped, preferredCost, warnings,
    skipped: built.skipped.map(s => ({ items: s.items.map(itemView), why: s.why, text: s.text })),
    heavyLast: r.heavyLast,
  };
}

function stockNote(it, prodBy) {
  const w = it.where;
  if (w && w.product) {
    const p = prodBy.get(w.product);
    if (p && !p.guaranteed) return '网上有货，门市不一定有';
  }
  return '';
}

function hoursText(open) {
  return open.map(([o, c]) => `${hm(o)}–${hm(c)}`).join('、');
}

// ---------------- 地图按钮（规格第八节） ----------------

export function mapLinks(a, b) {
  const s = `${a.lat.toFixed(6)},${a.lng.toFixed(6)}`, d = `${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
  // 离得很近（< 400 米）就给步行
  const near = haversineM(a, b) < 400;
  return {
    apple: `maps://?saddr=${s}&daddr=${d}&dirflg=${near ? 'w' : 'r'}`,
    google: `comgooglemaps://?saddr=${s}&daddr=${d}&directionsmode=${near ? 'walking' : 'transit'}`,
    googleWeb: `https://www.google.com/maps/dir/?api=1&origin=${s}&destination=${d}&travelmode=${near ? 'walking' : 'transit'}`,
  };
}

// ---------------- 备份 / 恢复 ----------------

const BACKUP_HEAD = 'Nathan出行备份 v1';
export function exportText(state) {
  return BACKUP_HEAD + '\n' + JSON.stringify(state);
}
export function importBackup(text) {
  const s = String(text).trim();
  if (!s.startsWith(BACKUP_HEAD)) return null;
  const st = JSON.parse(s.slice(BACKUP_HEAD.length).trim());
  if (!Array.isArray(st.items) || !Array.isArray(st.places) || !st.settings) throw new Error('备份文字不完整');
  st.settings = { ...PLAN_DEFAULTS, ...st.settings };
  st.excluded = st.excluded || [];
  return st;
}
