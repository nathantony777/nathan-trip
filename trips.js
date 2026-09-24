// 出行的集合（state v3）：好几趟出行装在一个 root 里，一次只看一趟。规格 15.2。
// root = { v:3, current: tripId|null, trips: { [id]: TripState }, settings: { caps:{google,amap,ai}, ai:{preset,base,model} }, inbox: [收藏条] }
// TripState = 原来的 v2 state（trip / places / items / excluded / settings / matrix）+ id / created / updated
// 纯函数，不碰界面、不碰存储、不碰网络；node 能测（测试/trips.test.mjs）。
// ★ 钥匙不在 root 里（IndexedDB 的 keys = { google, amap, ai }），备份天然不含钥匙。
// ★ 每天联网上限（caps）从每趟的 settings 挪到 root.settings：上限是这台手机一天的事，不是某一趟的事。
//   老的 TripState.settings.caps 升级时搬上来，之后不再读它（一个数只存一处）。

import * as Trip from './trip.js';
import { normUrl } from './collect.js';   // 收藏箱去重键要把分享链接里的参数剥掉（同一家店分享两次参数不同）

export const ROOT_CAPS = { ...Trip.DEFAULT_CAPS, ai: 100 };   // ai：每天最多让 AI 听几次（规格 15.4，★待批）
// 默认 AI 预设：Nathan 0924 定「用我现在有的 api」→ DeepSeek。地址 / 模型名可以在设置里手改，改了 preset 变 'custom'。
export const AI_DEFAULT = { preset: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };

let seq = 0;
const newId = () => 't' + Date.now().toString(36) + (seq++).toString(36);
const clone = x => JSON.parse(JSON.stringify(x));

export function newRoot() {
  return { v: 3, current: null, trips: {}, settings: { caps: { ...ROOT_CAPS }, ai: { ...AI_DEFAULT } }, inbox: [] };
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
    const root = { v: 3, current: raw.current ?? null, trips: {}, settings: {}, inbox: normInbox(raw.inbox) };
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

// ---------------- 存档与复用（Nathan 0924：「不止这一次旅游，可以存档、以后复用」） ----------------

// 照一趟再来一次：地方、要买的东西、酒店、每天几点出发几点回、取过的路程都带过来；
// 日期整体平移到 firstDate；进度（买到 / 去过了 / 没货 / 不去了）全部归零——那是上一趟的事，留在上一趟的回顾里。
export function dupTrip(root, id, opts = {}, today = Trip.localDateStr()) {
  const src = root.trips[id];
  if (!src) throw new Error('这趟不在了');
  const firstDate = opts.firstDate || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate)) throw new Error('日期不对');
  const t = clone(src);
  const ds = (t.trip.days || []).map(d => d.date).sort();
  const shift = ds.length ? daysBetween(ds[0], firstDate) : 0;
  const move = d => (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? Trip.addDays(d, shift) : d;
  for (const d of t.trip.days || []) d.date = move(d.date);
  for (const p of t.places || []) { p.status = 'todo'; p.day = p.day ? move(p.day) : null; }
  for (const it of t.items || []) { it.status = 'todo'; it.noStock = []; delete it.markedAt; }
  t.excluded = [];
  t.speech = [];
  delete t.trail;
  t.trip.name = (opts.name && String(opts.name).trim()) || t.trip.name;
  t.from = { id: src.id, name: src.trip.name || Trip.REGIONS[src.trip.region].name, date: ds[0] || null };   // 来自哪趟，回顾页能说「上次」
  const nid = newId();
  root.trips[nid] = wrapTrip({ ...t, id: nid, created: today, updated: today }, nid, today);
  root.current = nid;
  return root.trips[nid];
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5); }

// 整个集合的备份（所有趟 + 上限 + AI 设置 + 收藏箱，不含钥匙、不含取过的路程）；一趟的备份仍是 Trip.exportText
export const HEAD_V3 = 'Nathan出行全部备份 v3';
export function exportRoot(root) {
  const r = clone(root);
  for (const t of Object.values(r.trips)) t.matrix = {};
  return HEAD_V3 + '\n' + JSON.stringify(r);
}
// 认三种：全部（v3）→ 整个集合；一趟（v2 / v1）→ 只返回那一趟的 state，由调用方决定放哪
export function importAny(text, today = Trip.localDateStr()) {
  const s = String(text || '').trim();
  if (s.startsWith(HEAD_V3)) {
    const raw = JSON.parse(s.slice(HEAD_V3.length).trim());
    if (raw.v !== 3 || !raw.trips || typeof raw.trips !== 'object') throw new Error('全部备份的文字不完整');
    const root = migrateRoot(raw, today);
    return { kind: 'root', root, n: Object.keys(root.trips).length };
  }
  const st = Trip.importBackup(s, today);
  return st ? { kind: 'trip', state: st } : null;
}

// ---------------- 收藏箱（规格 15.13：从小红书 / 大众点评 / 抖音收来的店，整个 app 一份、不跟趟走） ----------------
// 一条 = { id, source, url, title, name, addr, text, got, used, dropped }
//   source  从哪儿收的（'xhs' / 'dianping' / 'douyin' / …，随喂进来的字）
//   url     那条内容的链接；title 那条内容的标题；name 店名（没有就用 title）；addr 地址；text 他备注 / 摘下来的正文
//   got     收进来的时间（ISO 字符串）
//   used    加进了哪一趟：那趟的 id；null = 还没用
//   dropped 他点了「不要了」：true 之后不再算「新的」，但条还留着——留着是为了去重，删了他再喂一次又会冒出来
// ★ 只进不重复：键 = url，没 url 就 source|name。所以「更新」= 再喂一次，只进新的，喂几遍都不会重。
// ★ migrateRoot 每次打开 app 都会重建 root，这段不保 inbox 的话收藏箱每次打开都清空（测试里钉了「跑两遍还在」）。
const INBOX_DEFAULT = { source: '', url: '', title: '', name: '', addr: '', text: '', got: '', used: null, dropped: false };
function normInbox(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(e => e && e.id).map(e => ({ ...INBOX_DEFAULT, ...e, id: String(e.id) }));
}
const inboxKey = e => normUrl(e.url) || ((e.source || '') + '|' + (e.name || ''));

// 喂一批进来 → { added, skipped }。没 name 也没 url 的跳过；跟箱里重的、这批里自己重的都跳过。
export function addToInbox(root, entries, now = new Date().toISOString()) {
  if (!Array.isArray(root.inbox)) root.inbox = [];
  const seen = new Set(root.inbox.map(inboxKey));
  let added = 0, skipped = 0;
  for (const raw of entries || []) {
    const e = raw || {};
    const name = String(e.name || '').trim() || String(e.title || '').trim();
    const url = String(e.url || '').trim();
    if (!name && !url) { skipped++; continue; }
    const entry = {
      ...INBOX_DEFAULT,
      id: 'c' + Date.now().toString(36) + (seq++).toString(36),
      source: String(e.source || '').trim(), url, title: String(e.title || '').trim(), name,
      addr: String(e.addr || '').trim(), text: String(e.text || ''),
      got: now, used: null, dropped: false,
    };
    const k = inboxKey(entry);
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    root.inbox.push(entry);
    added++;
  }
  return { added, skipped };
}

// 首页角标用：total 全部、fresh 既没用过也没「不要了」的、last 最近一次收进来的时间（没有就 ''）
export function inboxStats(root) {
  const list = Array.isArray(root.inbox) ? root.inbox : [];
  let fresh = 0, last = '';
  for (const e of list) {
    if (!e.used && !e.dropped) fresh++;
    if (e.got && e.got > last) last = e.got;
  }
  return { total: list.length, fresh, last };
}

export function markInbox(root, id, patch) {
  const e = (root.inbox || []).find(x => x.id === id);
  if (!e) throw new Error('收藏箱里没有这一条');
  return Object.assign(e, patch || {});
}

export function removeInbox(root, id) {
  const list = root.inbox || [];
  const i = list.findIndex(x => x.id === id);
  if (i < 0) throw new Error('收藏箱里没有这一条');
  list.splice(i, 1);
  return root;
}
