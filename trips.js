// 出行的集合（state v3）：好几趟出行装在一个 root 里，一次只看一趟。规格 15.2。
// root = { v:3, current: tripId|null, trips: { [id]: TripState }, settings: { caps:{google,amap,ai}, ai:{preset,base,model} } }
// TripState = 原来的 v2 state（trip / places / items / excluded / settings / matrix）+ id / created / updated
// 纯函数，不碰界面、不碰存储、不碰网络；node 能测（测试/trips.test.mjs）。
// ★ 钥匙不在 root 里（IndexedDB 的 keys = { google, amap, ai }），备份天然不含钥匙。
// ★ 每天联网上限（caps）从每趟的 settings 挪到 root.settings：上限是这台手机一天的事，不是某一趟的事。
//   老的 TripState.settings.caps 升级时搬上来，之后不再读它（一个数只存一处）。

import * as Trip from './trip.js';

export const ROOT_CAPS = { ...Trip.DEFAULT_CAPS, ai: 100 };   // ai：每天最多让 AI 听几次（规格 15.4，★待批）
// 默认 AI 预设：Nathan 0924 定「用我现在有的 api」→ DeepSeek。地址 / 模型名可以在设置里手改，改了 preset 变 'custom'。
export const AI_DEFAULT = { preset: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };

let seq = 0;
const newId = () => 't' + Date.now().toString(36) + (seq++).toString(36);
const clone = x => JSON.parse(JSON.stringify(x));

export function newRoot() {
  return { v: 3, current: null, trips: {}, settings: { caps: { ...ROOT_CAPS }, ai: { ...AI_DEFAULT } } };
}

// 一趟的壳：老的 v2 state + id / created / updated。caps 不留在趟里。
function wrapTrip(state, id, today) {
  const st = Trip.migrate(state, today);
  const { caps, ...settings } = st.settings || {};
  return { ...st, id: st.id || id, created: st.created || today, updated: st.updated || today, settings };
}

// v1 / v2（一趟）→ v3（集合）。跑两遍结果一样；v3 的也过一遍补默认值、把不存在的 current 修正。
export function migrateRoot(raw, today = Trip.localDateStr()) {
  if (!raw) return newRoot();
  if (raw.v === 3) {
    const root = { v: 3, current: raw.current ?? null, trips: {}, settings: {} };
    for (const [id, t] of Object.entries(raw.trips || {})) root.trips[id] = wrapTrip(t, id, today);
    const S = raw.settings || {};
    root.settings = { caps: { ...ROOT_CAPS, ...(S.caps || {}) }, ai: { ...AI_DEFAULT, ...(S.ai || {}) } };
    if (root.current != null && !root.trips[root.current]) root.current = null;
    if (root.current == null) { const ids = Object.keys(root.trips); if (ids.length) root.current = ids[0]; }
    return root;
  }
  // 一趟的老存档：整个装进 trips[id]，current 指它；它的 caps 搬到 root
  const oldCaps = (raw.settings && raw.settings.caps) || {};
  const id = newId();
  const root = newRoot();
  root.trips[id] = wrapTrip(raw, id, today);
  root.current = id;
  root.settings.caps = { ...ROOT_CAPS, ...oldCaps };
  return root;
}

export const currentTrip = root => (root.current != null && root.trips[root.current]) || null;

// 新建一趟：{ region, name?, city?, days?:['YYYY-MM-DD'...], home? }。建完就是当前这趟。
export function newTrip(root, opts = {}, today = Trip.localDateStr()) {
  const region = opts.region || 'hk';
  if (!Trip.REGIONS[region]) throw new Error(`认不出的地区：${region}`);
  const dates = [...new Set((opts.days || []).filter(Boolean))].sort();
  const st = Trip.newState(region, dates[0] || today);
  for (const d of dates.slice(1)) Trip.addDay(st, d);
  if (opts.name) st.trip.name = String(opts.name).trim() || st.trip.name;
  if (opts.city) st.trip.city = String(opts.city).trim();
  if (opts.home) Trip.setHome(st, opts.home);
  const id = newId();
  root.trips[id] = wrapTrip(st, id, today);
  root.current = id;
  return root.trips[id];
}

// 把当前这趟整个换掉（恢复备份 / 全部清空）：id、created 留着，updated = 今天
export function replaceTrip(root, id, state, today = Trip.localDateStr()) {
  const old = root.trips[id];
  if (!old) throw new Error('这趟不在了');
  root.trips[id] = wrapTrip({ ...state, id, created: old.created, updated: today }, id, today);
  return root.trips[id];
}

export function switchTrip(root, id) {
  if (!root.trips[id]) throw new Error('这趟不在了');
  root.current = id;
  return root.trips[id];
}

export function removeTrip(root, id) {
  if (!root.trips[id]) throw new Error('这趟不在了');
  delete root.trips[id];
  if (root.current === id) { const ids = Object.keys(root.trips); root.current = ids.length ? ids[0] : null; }
  return root;
}

// 首页卡片用：每趟一行，按「进行中 → 将来 → 过去」排，同组里日期近的在前
export function listTrips(root, today = Trip.localDateStr()) {
  const rows = Object.values(root.trips).map(t => {
    const ds = (t.trip.days || []).map(d => d.date).sort();
    const from = ds[0] || null, to = ds[ds.length - 1] || null;
    const phase = !from ? 'future' : to < today ? 'past' : from > today ? 'future' : 'now';
    return {
      id: t.id, name: t.trip.name || Trip.REGIONS[t.trip.region].name, region: t.trip.region, city: t.trip.city || '',
      from, to, nDays: ds.length,
      nPlaces: (t.places || []).filter(p => p.status === 'todo').length,
      nItems: (t.items || []).filter(i => i.status === 'todo').length,
      phase, current: t.id === root.current,
    };
  });
  const order = { now: 0, future: 1, past: 2 };
  rows.sort((a, b) => order[a.phase] - order[b.phase] || (a.phase === 'past' ? (b.from || '') < (a.from || '') ? -1 : 1 : (a.from || '') < (b.from || '') ? -1 : 1));
  return rows;
}

export function touch(t, today = Trip.localDateStr()) { t.updated = today; return t; }

// 一趟的备份还是老的「Nathan出行备份 v2」文字（恢复到当前这趟）；整个集合不做备份文字——一趟一趟来，贴备忘录不会太长
export const exportTrip = t => Trip.exportText(clone(t));
