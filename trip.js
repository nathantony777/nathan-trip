// 旅游版的 state（v2）：一趟 = 几天 + 想去的地方 +（香港时）要买的东西。规格 14.3 / 14.9。
// 这里只有：新建 / 升级 state、改 state 的小函数、起终点怎么变成坐标、备份。
// 纯函数，不碰界面、不碰存储、不碰网络；node 能测（测试/trip.test.mjs）。
// ★ 钥匙不在 state 里（规格 14.8），所以这里的备份天然不含钥匙。

import { ptKey, wgs2gcj } from './geo.js';

export const REGIONS = {
  hk:     { name: '香港',     sys: 'wgs84', provider: null },       // 内置数据，不联网
  cn:     { name: '中国大陆', sys: 'gcj02', provider: 'amap' },
  abroad: { name: '国外',     sys: 'wgs84', provider: 'google' },
};
export const KINDS = { sight: '景点', food: '吃饭', shop: '买东西', other: '其他' };
export const DEFAULT_DUR = { sight: 120, food: 60, shop: 40, other: 30 };   // 加进来时「待多久」的默认值（分钟）
export const DEFAULT_CAPS = { google: 1500, amap: 2500 };                     // 每天联网上限（规格 14.8）

// 香港那一天的默认（跟 V1 一样）；别的地区默认 9:00 从酒店出发、21:00 回酒店
export const HK_DAY = { start: { kind: 'port' }, startTime: 7 * 60 + 15, end: { kind: 'port' }, deadline: 23 * 60 + 30 };
export const OTHER_DAY = { start: { kind: 'home' }, startTime: 9 * 60, end: { kind: 'home' }, deadline: 21 * 60 };
export const SETTINGS_DEFAULTS = { base: 8, bakeryQueue: 15, bakeryQueueDates: ['2026-09-25'] };

const PLACE_DEFAULTS = {
  addr: '', source: 'manual', placeId: null, citycode: null, kind: 'other',
  hours: null, hoursText: '', hoursVerified: false,
  dur: 30, walk: 0, must: true, day: null, at: null, from: null, to: null,
  status: 'todo', note: '', how: '',
};

// ---------------- 日期 ----------------

const pad = n => String(n).padStart(2, '0');
export function localDateStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export function dateLabel(dateStr, withWeek = true) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${m}月${d}日${withWeek ? ' ' + WEEK[dow] : ''}`;
}

// ---------------- 新建 / 升级 ----------------

export const regionOf = state => (state && state.trip ? state.trip.region : 'hk');
const dayDefaults = region => JSON.parse(JSON.stringify(region === 'hk' ? HK_DAY : OTHER_DAY));

export function newState(region = 'hk', today = localDateStr()) {
  if (!REGIONS[region]) throw new Error(`认不出的地区：${region}`);
  return {
    v: 2,
    trip: { name: REGIONS[region].name, region, city: '', days: [{ date: today, ...dayDefaults(region) }], home: null },   // city：联网搜的时候当范围
    places: [], items: [], excluded: [],
    settings: { ...SETTINGS_DEFAULTS, caps: { ...DEFAULT_CAPS } },
    matrix: {},
  };
}

// v1（香港版：settings 里一天）→ v2。跑两遍结果一样；v2 的也过一遍补默认值。
export function migrate(state, today = localDateStr()) {
  if (!state) return newState('hk', today);
  if (state.v >= 2) {
    state.trip = state.trip || { name: '香港', region: 'hk', city: '', days: [], home: null };
    if (!REGIONS[state.trip.region]) state.trip.region = 'hk';
    state.trip.city = state.trip.city || '';
    state.trip.home = state.trip.home || null;
    if (!state.trip.days || !state.trip.days.length) state.trip.days = [{ date: today, ...dayDefaults(state.trip.region) }];
    state.places = (state.places || []).map(p => ({ ...PLACE_DEFAULTS, ...p }));
    state.items = state.items || []; state.excluded = state.excluded || [];
    state.settings = { ...SETTINGS_DEFAULTS, ...(state.settings || {}) };
    state.settings.caps = { ...DEFAULT_CAPS, ...(state.settings.caps || {}) };
    state.matrix = state.matrix || {};
    return state;
  }
  const S = state.settings || {};
  const day = {
    date: S.date || today,
    startTime: S.startTime ?? HK_DAY.startTime, deadline: S.deadline ?? HK_DAY.deadline,
    start: S.start || { kind: 'port' }, end: S.end || { kind: 'port' },
  };
  const sourceOf = how => /定位/.test(how || '') ? 'gps' : /链接/.test(how || '') ? 'link' : /站/.test(how || '') ? 'station' : 'manual';
  const places = (state.places || []).map(p => ({ ...PLACE_DEFAULTS, ...p, sys: 'wgs84', source: sourceOf(p.how), day: null, at: null }));
  const { date, start, startTime, end, deadline, ...rest } = S;   // 这几个搬进了 day
  return {
    v: 2,
    trip: { name: '香港', region: 'hk', city: '香港', days: [day], home: null },
    places, items: state.items || [], excluded: state.excluded || [],
    settings: { ...SETTINGS_DEFAULTS, ...rest, caps: { ...DEFAULT_CAPS, ...(rest.caps || {}) } },
    matrix: {},
  };
}

// ---------------- 天 ----------------

export function findDay(state, date) { return state.trip.days.find(d => d.date === date) || null; }

export function addDay(state, date) {
  const days = state.trip.days;
  if (!date) date = days.length ? addDays(days[days.length - 1].date, 1) : localDateStr();
  if (findDay(state, date)) throw new Error(`${dateLabel(date)} 已经在行程里了`);
  const day = { date, ...dayDefaults(state.trip.region) };
  days.push(day);
  days.sort((a, b) => a.date < b.date ? -1 : 1);
  return day;
}
export function removeDay(state, date) {
  if (state.trip.days.length <= 1) throw new Error('至少要留一天');
  if (!findDay(state, date)) throw new Error(`${dateLabel(date)} 不在行程里`);
  state.trip.days = state.trip.days.filter(d => d.date !== date);
  for (const p of state.places) if (p.day === date) { p.day = null; p.at = null; }   // 指定在这天的改成「算法分」
  return state;
}
export function updateDay(state, date, patch) {
  const d = findDay(state, date);
  if (!d) throw new Error(`${dateLabel(date)} 不在行程里`);
  if ('date' in patch && patch.date !== date) {
    if (findDay(state, patch.date)) throw new Error(`${dateLabel(patch.date)} 已经在行程里了`);
    for (const p of state.places) if (p.day === date) p.day = patch.date;
  }
  // ★ 先查再写：查放在赋值后面，坏值已经进了 state（测试/trip.test.mjs 第一次跑就抓到）
  const next = { ...d, ...patch };
  if (!(next.deadline > next.startTime)) throw new Error(`${dateLabel(next.date)}：最晚回到终点（${hm(next.deadline)}）早于出发时间（${hm(next.startTime)}）`);
  Object.assign(d, patch);
  state.trip.days.sort((a, b) => a.date < b.date ? -1 : 1);
  return state;
}
const hm = t => `${pad(Math.floor(t / 60) % 24)}:${pad(Math.round(t) % 60)}`;

// 酒店（每天默认从这出发、回这）：{lat,lng,name,citycode?} 或 null
export function setHome(state, pt) {
  if (pt) { checkCoords(state, pt.lat, pt.lng); state.trip.home = { kind: 'geo', lat: Number(pt.lat), lng: Number(pt.lng), name: pt.name || '酒店', citycode: pt.citycode || null, addr: pt.addr || '' }; }
  else state.trip.home = null;
  return state;
}

// 换地区：另一套坐标的地方全部清掉（界面先让他确认）；矩阵、酒店、每天的起终点一起重来
export function setRegion(state, region) {
  if (!REGIONS[region]) throw new Error(`认不出的地区：${region}`);
  const old = state.trip.region;
  if (old === region) return { cleared: 0 };
  const sys = REGIONS[region].sys;
  const gone = state.places.filter(p => p.sys !== sys);
  for (const p of gone) unlinkPlace(state, p.id);
  state.places = state.places.filter(p => p.sys === sys);
  state.trip.region = region;
  state.trip.name = REGIONS[region].name;
  state.trip.city = region === 'hk' ? '香港' : '';
  state.trip.home = null;
  state.matrix = {};
  for (const d of state.trip.days) Object.assign(d, dayDefaults(region));
  return { cleared: gone.length };
}

// ---------------- 地方 ----------------

let seq = 0;
const newId = p => p + Date.now().toString(36) + (seq++).toString(36);

function checkCoords(state, lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!(isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new Error('位置不对（坐标不是数）');
  if (regionOf(state) === 'hk' && !(lat > 22.1 && lat < 22.6 && lng > 113.8 && lng < 114.5)) throw new Error('这个位置不在香港（香港的行程只有香港的数据；去别的地方先在设置里换地区）');
}

// 手机 GPS 给的是 WGS-84；大陆的行程要换成高德那套（规格 14.2）
export function toRegionCoords(state, ll) {
  const sys = REGIONS[regionOf(state)].sys;
  const p = sys === 'gcj02' ? wgs2gcj(ll) : { lat: Number(ll.lat), lng: Number(ll.lng) };
  return { ...p, sys };
}

export function addPlace(state, p) {
  if (!p.name) throw new Error('地方要有个名字');
  checkCoords(state, p.lat, p.lng);
  const sys = REGIONS[regionOf(state)].sys;
  if (p.sys && p.sys !== sys) throw new Error(`这个位置是${p.sys === 'gcj02' ? '高德' : '国际'}那套坐标，现在的行程在${REGIONS[regionOf(state)].name}，用的是另一套`);
  if (p.at != null && !p.day) throw new Error('定了几点开始的地方，要先定是哪一天');
  const place = { id: newId('p'), ...PLACE_DEFAULTS, ...p, lat: Number(p.lat), lng: Number(p.lng), sys };
  place.dur = p.dur != null && Number(p.dur) >= 0 ? Number(p.dur) : (DEFAULT_DUR[place.kind] ?? 30);   // 没写待多久 → 按类别默认
  state.places.push(place);
  return place;
}
export function updatePlace(state, id, patch) {
  const p = state.places.find(x => x.id === id);
  if (!p) throw new Error(`找不到这个地方：${id}`);
  if ('lat' in patch || 'lng' in patch) checkCoords(state, patch.lat ?? p.lat, patch.lng ?? p.lng);
  const next = { ...p, ...patch };
  if (next.at != null && !next.day) throw new Error('定了几点开始的地方，要先定是哪一天');
  Object.assign(p, patch);
  return state;
}
function unlinkPlace(state, id) {
  // 挂在它上面的东西变成「不知道在哪买」，不跟着删（一样都不许丢）
  for (const it of state.items || []) if (it.where && it.where.type === 'place' && it.where.place === id) it.where = null;
  const isIt = pt => pt && pt.kind === 'place' && pt.id === id;
  if (state.trip) {
    for (const d of state.trip.days) { if (isIt(d.start)) d.start = dayDefaults(state.trip.region).start; if (isIt(d.end)) d.end = dayDefaults(state.trip.region).end; }
  } else {
    if (isIt(state.settings.start)) state.settings.start = { kind: 'port' };
    if (isIt(state.settings.end)) state.settings.end = { kind: 'port' };
  }
}
export function removePlace(state, id) {
  state.places = state.places.filter(p => p.id !== id);
  unlinkPlace(state, id);
  return state;
}

// ---------------- 起点 / 终点 → 坐标 ----------------

export const END_OPTIONS = [
  { key: 'port', name: '深圳湾口岸' },
  { key: 'LOW', name: '罗湖口岸（港铁罗湖站）', station: 'LOW' },
  { key: 'LMC', name: '落马洲支线口岸（港铁落马洲站）', station: 'LMC' },
  { key: 'XRL', name: '高铁西九龙站（按旁边的柯士甸站算）', station: 'AUS' },
];

function stationPt(T, code) {
  const s = T && T.stations ? T.stations.find(x => x.code === code) : null;
  if (!s) throw new Error(`港铁站 ${code} 不在数据里`);
  return { lat: s.lat, lng: s.lng, name: `港铁${s.name}站` };
}

// pt: {kind:'port'} | {kind:'station',code} | {kind:'here',lat,lng,name?} | {kind:'place',id} | {kind:'geo',lat,lng,name} | {kind:'home'}
export function resolvePoint(state, T, pt, which) {
  const region = regionOf(state);
  const what = which === 'end' ? '终点' : '起点';
  if (!pt) pt = region === 'hk' ? { kind: 'port' } : { kind: 'home' };
  if (pt.kind === 'port') {
    if (!T || !T.port) throw new Error(`深圳湾口岸只在香港的行程里有；${what}换成酒店或别的地方`);
    return { ...T.port, name: '深圳湾口岸', kind: 'port' };
  }
  if (pt.kind === 'station') {
    const s = stationPt(T, pt.code);
    const opt = END_OPTIONS.find(o => o.station === pt.code);
    return { ...s, name: which === 'end' && opt ? opt.name : `${s.name}附近` };
  }
  if (pt.kind === 'here') { checkCoords(state, pt.lat, pt.lng); return { lat: Number(pt.lat), lng: Number(pt.lng), name: pt.name || '我现在的位置', citycode: pt.citycode || null }; }
  if (pt.kind === 'place') {
    const p = state.places.find(x => x.id === pt.id);
    if (!p) throw new Error(`${what}那个地方被删了`);
    return { lat: p.lat, lng: p.lng, name: p.name, citycode: p.citycode || null };
  }
  if (pt.kind === 'geo') { checkCoords(state, pt.lat, pt.lng); return { lat: Number(pt.lat), lng: Number(pt.lng), name: pt.name || what, citycode: pt.citycode || null }; }
  if (pt.kind === 'home') {
    const h = state.trip && state.trip.home;
    if (!h) throw new Error(`还没定酒店：每天${which === 'end' ? '回哪' : '从哪出发'}要有个位置（设置 → 行程 → 酒店），或者给这一天单独选一个${what}`);
    return { lat: h.lat, lng: h.lng, name: h.name || '酒店', kind: 'home', citycode: h.citycode || null };
  }
  throw new Error(`认不出的${what}：${JSON.stringify(pt)}`);
}

// 要取路程的点：还没去的地方 + 每天的起终点 + 酒店，按坐标去重（规格 14.5）
export function pointsForMatrix(state, T) {
  const seen = new Map();
  const put = p => { if (!p) return; const k = ptKey(p); if (!seen.has(k)) seen.set(k, { lat: p.lat, lng: p.lng, name: p.name, citycode: p.citycode || null }); };
  for (const p of state.places) if (p.status === 'todo') put(p);
  for (const d of state.trip.days) {
    try { put(resolvePoint(state, T, d.start, 'start')); put(resolvePoint(state, T, d.end, 'end')); } catch { /* 没定酒店那种，界面另说 */ }
  }
  if (state.trip.home) put(state.trip.home);
  return [...seen.values()];
}

// ---------------- 备份 / 恢复（不含钥匙） ----------------

const HEAD_V2 = 'Nathan出行备份 v2', HEAD_V1 = 'Nathan出行备份 v1';
export function exportText(state) {
  // 先升级成 v2 再写（v1 的 state 直接写会没有 trip，恢复时被自己拒收——测试/plan.test.mjs 抓到的）
  const { matrix, ...rest } = migrate(JSON.parse(JSON.stringify(state)));   // 矩阵可以重新取，不进备份（备份文字要能贴进备忘录）
  return HEAD_V2 + '\n' + JSON.stringify({ ...rest, matrix: {} });
}
export function importBackup(text, today = localDateStr()) {
  const s = String(text || '').trim();
  const head = s.startsWith(HEAD_V2) ? HEAD_V2 : s.startsWith(HEAD_V1) ? HEAD_V1 : null;
  if (!head) return null;
  const st = JSON.parse(s.slice(head.length).trim());
  if (!Array.isArray(st.items) || !Array.isArray(st.places) || !st.settings) throw new Error('备份文字不完整');
  if (head === HEAD_V2 && !(st.trip && Array.isArray(st.trip.days))) throw new Error('备份文字不完整（没有行程）');
  return migrate(st, today);
}
