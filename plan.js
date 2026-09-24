// 「清单 + 自己加的地方 + 设置」→ 算法的输入；排完再翻译成界面要显示的样子。
// 规格：../规格.md 第二节、「二之半、随时改」、第三节。
//
// ★ 不存路线：每次都拿【当时的清单 + 当时的位置 + 当时的时间】从头排（二之半）。
//   所以加 / 删 / 改东西和地方，都只是改 state，再调一次 makePlan()。
// ★ 纯函数（除了下面那几个改 state 的小函数），不碰界面、不碰存储；电脑上 node 能直接测。

import { openOn, dowOf, HK_PH_2026 } from './hours.js';
import { planRoute, hm } from './engine.js';
import * as Trip from './trip.js';
import { placeWindow } from './days.js';
import { mapLinks as makeMapLinks, coordsFromText as mapCoords, walkFromLeg } from './maplinks.js';

// 地方、起终点、备份的正本挪到了 trip.js（旅游版）；这里转出去，老的引用不用改
export { addPlace, updatePlace, removePlace, resolvePoint, END_OPTIONS, exportText, importBackup } from './trip.js';

export const DONE = new Set(['bought', 'skip', 'enough', 'notEnough']);   // 这几种状态不再排

// v1 的一天（香港版）：日期 + 起终点 + 时间 + 通用设置。数值的正本在 trip.js（HK_DAY / SETTINGS_DEFAULTS）。
// start / end：port | station{code} | here{lat,lng} | place{id}
export const PLAN_DEFAULTS = { date: '2026-09-25', ...Trip.HK_DAY, ...Trip.SETTINGS_DEFAULTS };

// v1 形状的 state（香港版的测试还在用）；app 用的是 trip.js 的 newState / migrate（v2）
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

// 从一段文字里找坐标（香港版的入口；算法只有 maplinks.js 一份）。认不出 / 地区对不上 → null，界面提示换一种。
export function coordsFromText(text) {
  const c = mapCoords(text, 'hk');
  return c && c.lat != null ? { lat: c.lat, lng: c.lng } : null;
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

// v1 的 settings 里就是一天；v2 从 trip.days 里挑一天传进来
export function dayOf(state, date) {
  if (state.trip) {
    const d = date ? state.trip.days.find(x => x.date === date) : state.trip.days[0];
    if (!d) throw new Error(`${date} 不在行程里`);
    return d;
  }
  const S = state.settings;
  return { date: S.date, startTime: S.startTime, deadline: S.deadline, start: S.start, end: S.end };
}


// day：{date, startTime, deadline, start, end}（缺省 = v1 的 settings）；includePlaces=false 时自己加的地方不进来（旅游版由 days.js 分天）
export function buildProblem(state, data, T, { backupsOn = new Set(), day = null, includePlaces = true } = {}) {
  const S = state.settings;
  const D = day || dayOf(state);
  const dow = dowOf(D.date), isPH = HK_PH_2026.has(D.date);
  const queueDay = (S.bakeryQueueDates || []).includes(D.date);
  const brandKind = new Map(data.brands.map(b => [b.brand, b.kind || '']));
  const storeData = new Map(data.stores.map(s => [s.id, s]));

  const problemStores = new Map();
  const storeObj = id => {
    if (problemStores.has(id)) return problemStores.get(id);
    let o;
    if (id.startsWith('place:')) {
      const p = state.places.find(x => 'place:' + x.id === id);
      o = { id, name: p.name, addr: p.addr || '', lat: p.lat, lng: p.lng, open: placeWindow(p, D.date, isPH).open, base: (Number(p.dur) || 0) + (Number(p.walk) || 0), queue: 0 };   // walk = 从站走过去再走回来；窗口的算法只有 days.js 一份
    } else {
      const s = storeData.get(id);
      if (!s) throw new Error(`店 ${id} 不在数据里（数据更新过？）`);
      const q = queueDay && /饼/.test(brandKind.get(s.brand)) ? S.bakeryQueue : 0;
      o = { id, name: `${s.brand} ${s.name}`, addr: s.addr || '', lat: s.lat, lng: s.lng, open: openOn(s.hours, dow, isPH).open, base: S.base, queue: q };
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
  for (const p of includePlaces ? state.places : []) {
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

  const start = Trip.resolvePoint(state, T, D.start, 'start');
  const end = Trip.resolvePoint(state, T, D.end, 'end');
  const problem = { t0: D.startTime, deadline: D.deadline, start, end, stores: [...problemStores.values()], groups };
  return { problem, groupItems, skipped, pendingBackups, start, end, day: D };
}

// ---------------- 排 + 翻译成界面要的样子 ----------------

export function makePlan(state, data, T, opts = {}) {
  let built, result, D;
  try { D = dayOf(state, opts.date); } catch (e) { return { ok: false, error: e.message }; }
  if (!(D.deadline > D.startTime)) return { ok: false, error: `最晚回到终点（${hm(D.deadline)}）早于出发时间（${hm(D.startTime)}）` };
  try {
    built = buildProblem(state, data, T, { day: D });
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
      built = buildProblem(state, data, T, { backupsOn: droppedBrands, day: D });
      result = planRoute(built.problem, T.forTrip(built.start, built.end), opts.engine);
      built.backupsActivated = [...droppedBrands];
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return present(state, data, T, built, result);
}

// 排好的一天 → 界面要的样子。旅游版（tripPlan.js）也用它：路程怎么描述、地图按钮怎么给，由 opts 注进来
//   opts.describe(a, b, t) → { min, text, mode }；opts.links(a, b, leg) → 地图按钮（leg.mode 决定步行还是公交）
export function present(state, data, T, built, r, opts = {}) {
  const S = state.settings;
  const D = built.day || dayOf(state);
  const describe = opts.describe || ((a, b, t) => T.describe(a, b, t));
  const links = opts.links || mapLinks;
  const storeData = new Map(data.stores.map(s => [s.id, s]));
  const prodBy = new Map(data.products.map(p => [p.product, p]));
  const dow = dowOf(D.date), isPH = HK_PH_2026.has(D.date);
  const pStore = new Map(built.problem.stores.map(s => [s.id, s]));
  const itemView = it => ({ id: it.id, name: it.name, qty: it.qty || 1, who: it.who || [], note: it.note || '', isPlace: !!it.isPlace,
    stockNote: stockNote(it, prodBy) });

  const warnings = [];
  if ((S.bakeryQueueDates || []).includes(D.date)) warnings.push('今天是中秋正日：营业时间可能提早收，重要的店先打电话；饼家每家多算了 15 分钟排队。');
  if (built.backupsActivated) for (const B of built.backupsActivated) warnings.push(`「${B}」排不进去，条件备选那家已经加进来了。`);

  if (r.status === 'cannotReturn') {
    return { ok: true, cannotReturn: true, start: { ...built.start, time: D.startTime }, end: { ...built.end, deadline: D.deadline }, stops: [], warnings, estimated: 0,
      text: `从${built.start.name} ${hm(D.startTime)} 出发，${hm(D.deadline)} 前回不到${built.end.name}（最后一班车赶不上，或者时间太紧）`,
      dropped: [], skipped: built.skipped.map(s => ({ items: s.items.map(itemView), text: s.text })) };
  }

  const stops = [];
  let prev = built.start, prevT = D.startTime, estimated = 0;
  for (const v of r.visits) {
    const leg = describe(prev, v.site, prevT);
    if (leg.mode === 'est') estimated++;
    const parts = v.parts.map(p => {
      const ps = pStore.get(p.store);
      const sd = storeData.get(p.store);
      const place = p.store.startsWith('place:') ? state.places.find(x => 'place:' + x.id === p.store) : null;
      const flags = [];
      if (sd && !sd.coordOk) flags.push('位置没核准（地址换坐标时匹配分数低）');
      if (sd && !openOn(sd.hours, dow, isPH).verified) flags.push('营业时间未核实，按 10:00–20:00 算的');
      if (place && place.at == null && !placeWindow(place, D.date, isPH).verified && place.from == null && place.to == null) flags.push('营业时间未核实，按 10:00–20:00 算的');
      if (ps.queue) flags.push(`算了 ${ps.queue} 分钟排队`);
      const its = p.groups.flatMap(gid => built.groupItems.get(gid) || []);
      return {
        storeId: p.store, name: ps.name, brand: sd ? sd.brand : null, addr: sd ? sd.addr : (place && place.note) || '',
        // 显示的是【算法用的】当天营业时间（跟排出来的时刻对得上）；原始资料文字留在 hoursRaw，有的带出处，太乱不直接显示
        phone: sd ? sd.phone : (place && place.phone) || '', hoursToday: sd || (place && (place.from != null || place.to != null || place.at != null || place.hours)) ? hoursText(ps.open) : '', hoursRaw: sd ? sd.hoursRaw : (place ? place.hoursText || '' : ''),
        arrive: p.arrive, begin: p.begin, end: p.end, wait: Math.max(0, Math.round(p.begin - p.arrive)),
        flags, items: its.map(itemView), isPlace: !!place, placeId: place ? place.id : null,
      };
    });
    const leave = parts[parts.length - 1].end;
    stops.push({ arrive: v.arrive, leave, lat: v.site.lat, lng: v.site.lng,
      title: [...new Set(parts.map(p => p.name))].join(' + '),
      leg: { text: leg.text, min: leg.min, mode: leg.mode || null, links: links(prev, v.site, leg) }, parts });
    prev = v.site; prevT = leave;
  }
  const back = describe(prev, built.end, prevT);
  if (back.mode === 'est') estimated++;

  const dropped = (r.dropped || []).map(d => ({ items: (built.groupItems.get(d.group) || []).map(itemView), reason: d.reason, text: d.text }));
  let preferredCost = null;
  if (r.preferredCost && r.preferredCost.minutes > 0) {
    const alt = r.preferredCost.alt;
    const altNames = alt ? alt.visits.flatMap(v => v.parts.map(p => pStore.get(p.store).name)) : [];
    preferredCost = { minutes: r.preferredCost.minutes, text: `照你指定的分店去；不管指定、换最近的分店能早 ${r.preferredCost.minutes} 分钟回到终点`, altNames };
  }
  return {
    ok: true, exact: r.exact, elapsedMs: r.elapsedMs, date: D.date, estimated,
    start: { ...built.start, time: D.startTime },
    end: { ...built.end, arrive: r.finish, deadline: D.deadline },
    back: { text: back.text, min: back.min, mode: back.mode || null, links: links(prev, built.end, back) },
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

// ---------------- 地图按钮（规格第八节）：算法只有 maplinks.js 一份，这里是香港版的入口 ----------------

export const mapLinks = (a, b, leg) => makeMapLinks('hk', a, b, { walk: walkFromLeg(leg) });
