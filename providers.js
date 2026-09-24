// 两家地图的网络层（规格 14.4 / 14.8）：搜地方、取两两之间要多久、试钥匙。
// 大陆用高德（「Web 服务」钥匙，坐标 GCJ-02），国外用谷歌（Places API (New) + Routes API，坐标 WGS-84）。
// ★ 纯网络：不碰存储、不碰界面。fetch / spend / sleep / now 都由外面给 —— app 给真的，测试给假的（测试/providers.test.mjs）。
// ★ 花钱的闸：每次真发请求之前先 await spend(units)（谷歌 搜 = 1、路程 = 这一块的格数；高德 每个请求 = 1）。
//   spend 到上限会抛（kind 'cap'），这里原样往外抛、不吞；重试也是真发，所以重试前照样再报一次。
// ★ 出错一律抛 ProviderError { kind, text }：key / quota / cap 不重试；net 隔 1 秒重试一次；
//   高德说「请求太快」等 1 秒再试一次。text 是给人看的中文，不含钥匙。
// ★ 钥匙只进请求头 / 请求参数；报错文字里、日志里都不出现。

import { hoursFromGoogle, hoursFromAmap } from './hoursImport.js';

export class ProviderError extends Error {
  constructor(kind, text) {
    super(text);
    this.name = 'ProviderError';
    this.kind = kind;   // 'key' | 'quota' | 'net' | 'cap' | 'other'
    this.text = text;   // 给人看的中文
  }
}

const G_SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const G_MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
// 带 regularOpeningHours 就是 Enterprise 档（每月免费 1,000 次，0923 查的）
const G_SEARCH_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.nationalPhoneNumber,places.primaryType,places.types';
const G_MATRIX_FIELDS = 'originIndex,destinationIndex,duration,condition';
const G_BLOCK = 10;          // 公交（TRANSIT）一次最多 100 格 → 每块最多 10 个起点 × 10 个终点
const AMAP = 'https://restapi.amap.com';
const AMAP_GAP_MS = 350;     // 高德个人钥匙每秒 3 次 → 两次请求之间至少隔 350 毫秒
const RETRY_MS = 1000;
const MAX_HITS = 5;

export function makeProvider(name, opts = {}) {
  const env = {
    key: typeof opts.key === 'string' ? opts.key.trim() : '',
    fetch: opts.fetch || ((url, init) => globalThis.fetch(url, init)),
    spend: opts.spend || (() => {}),
    sleep: opts.sleep || (ms => new Promise(r => setTimeout(r, ms))),
    now: opts.now || (() => Date.now()),
  };
  if (name === 'google') return googleProvider(env);
  if (name === 'amap') return amapProvider(env);
  throw new ProviderError('other', `不认识的地图：${name}（只有 google / amap）`);
}

// ---------------- 两家共用：发一次请求（含报账、限速、重试） ----------------

function cancelled() { return new ProviderError('other', '取消了'); }
function errText(e) { return (e && (e.text || e.message)) || String(e); }
function cut(s, n = 160) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
// 取路程中途出错：已经取到（已经花了钱）的格子跟着错误一起交出去，调用方可以先存下来
function withPartial(e, cells) {
  if (e && typeof e === 'object') { try { e.partial = cells.slice(); } catch { /* 冻住的对象：交不出去就算了 */ } }
  return e;
}

// check(res, body) → { data } 成了；{ retry:'net'|'slow', text } 可以再试一次；认定出错就直接抛 ProviderError
function makeSender(env, { label, gapMs = 0 }) {
  let lastSent = -Infinity;
  return async function send({ url, init = {}, units, signal, check, acc }) {
    let netRetried = false, slowRetried = false;
    for (;;) {
      if (signal && signal.aborted) throw cancelled();
      if (gapMs) {
        const wait = gapMs - (env.now() - lastSent);
        if (wait > 0) await env.sleep(wait);
        if (signal && signal.aborted) throw cancelled();
      }
      await env.spend(units);            // ★ 真发之前先报账；超上限它会抛，原样往外抛
      if (acc) acc.units += units;
      lastSent = env.now();
      let res;
      try {
        res = await env.fetch(url, signal ? { ...init, signal } : init);
      } catch (e) {
        if ((signal && signal.aborted) || (e && e.name === 'AbortError')) throw cancelled();
        if (!(e instanceof TypeError)) throw new ProviderError('other', `${label}的请求没发出去：${cut(errText(e))}`);
        if (!netRetried) { netRetried = true; await env.sleep(RETRY_MS); continue; }
        throw new ProviderError('net', '网络不通，隔一秒重试过一次，还是不通');
      }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      const r = check(res, body);
      if (!r.retry) return r.data;
      if (r.retry === 'net' && !netRetried) { netRetried = true; await env.sleep(RETRY_MS); continue; }
      if (r.retry === 'slow' && !slowRetried) { slowRetried = true; await env.sleep(RETRY_MS); continue; }
      throw new ProviderError(r.retry === 'net' ? 'net' : 'quota', r.text);
    }
  };
}

// 取路程的输入：points[{lat,lng,citycode?}]，pairs[[i,j]]。坏的直接报错（不花钱）；重复的格只算一次
function checkPairs(points, pairs) {
  if (!Array.isArray(points) || !Array.isArray(pairs)) throw new ProviderError('other', '取路程的参数不对：points 和 pairs 都要是数组');
  const seen = new Set(), list = [];
  for (const p of pairs) {
    const i = p && p[0], j = p && p[1];
    if (!Number.isInteger(i) || !Number.isInteger(j) || !points[i] || !points[j]) {
      throw new ProviderError('other', `要取的格子指向不存在的点：${JSON.stringify(p)}`);
    }
    for (const k of [i, j]) {
      const { lat, lng } = points[k];
      if (lat == null || lng == null || !Number.isFinite(+lat) || !Number.isFinite(+lng) || Math.abs(+lat) > 90 || Math.abs(+lng) > 180) {
        throw new ProviderError('other', `第 ${k} 个点没有像样的坐标`);
      }
    }
    const key = i + ',' + j;
    if (!seen.has(key)) { seen.add(key); list.push([i, j]); }
  }
  return list;
}

// ======================= 谷歌 =======================

function googleCheck(api) {
  return (res, body) => {
    const code = res.status;
    if (res.ok) {
      if (body == null) throw new ProviderError('other', '谷歌回的内容认不出（不是 JSON）');
      return { data: body };
    }
    const err = (body && body.error) || {};
    const status = String(err.status || '');
    const reasons = Array.isArray(err.details) ? err.details.map(d => d && d.reason).filter(Boolean).join(',') : '';
    const said = err.message ? `（谷歌原话：${cut(err.message)}）` : '';
    if (code === 429 || /RESOURCE_EXHAUSTED/.test(status) || /RATE_LIMIT|QUOTA/.test(reasons)) {
      throw new ProviderError('quota', '谷歌这把钥匙的用量到上限了（谷歌那边限的）；过一会儿或明天再试');
    }
    // ★ 钥匙填错时谷歌回的是 400 INVALID_ARGUMENT + API_KEY_INVALID，不是 401/403，所以也看 reason 和原话
    if (code === 401 || code === 403 || /PERMISSION_DENIED|UNAUTHENTICATED/.test(status)
      || /API_KEY|SERVICE_DISABLED|BILLING/.test(reasons) || /API key/i.test(err.message || '')) {
      throw new ProviderError('key', `谷歌钥匙不对或没开通 ${api}${said}`);
    }
    if (code >= 500) return { retry: 'net', text: `谷歌那边暂时出错（HTTP ${code}），隔一秒重试过一次还是不行` };
    throw new ProviderError('other', `谷歌回了错误（HTTP ${code}${status ? ' ' + status : ''}）${said}`);
  };
}

// 待多久的默认值只看这个：吃的 / 买的 / 看的 / 其他
const G_FOOD = new Set(['restaurant', 'cafe', 'bakery', 'bar', 'food', 'meal_takeaway', 'meal_delivery', 'coffee_shop', 'tea_house',
  'ice_cream_shop', 'dessert_shop', 'donut_shop', 'bagel_shop', 'juice_shop', 'sandwich_shop', 'chocolate_shop', 'confectionery',
  'food_court', 'deli', 'diner', 'pub', 'bar_and_grill', 'beer_garden', 'cafeteria', 'steak_house', 'wine_bar']);
const G_SHOP = new Set(['store', 'shopping_mall', 'supermarket', 'market', 'department_store', 'convenience_store', 'grocery_store',
  'outlet_mall', 'wholesaler']);
const G_SIGHT = new Set(['tourist_attraction', 'museum', 'park', 'temple', 'shrine', 'zoo', 'aquarium', 'landmark', 'art_gallery',
  'historical_landmark', 'historical_place', 'monument', 'church', 'mosque', 'synagogue', 'place_of_worship', 'castle', 'garden',
  'botanical_garden', 'observation_deck', 'plaza', 'cultural_landmark', 'amusement_park', 'national_park', 'beach', 'planetarium',
  'sculpture', 'visitor_center']);
function gKindOf(t) {
  if (typeof t !== 'string' || !t) return null;
  if (G_FOOD.has(t) || /_(restaurant|cafe|bakery|bar)$/.test(t)) return 'food';   // 先认吃的：coffee_shop 不能算成店
  if (G_SHOP.has(t) || /_(store|shop|mall|market)$/.test(t)) return 'shop';
  if (G_SIGHT.has(t) || /_(temple|shrine|park|museum|landmark|attraction|garden)$/.test(t)) return 'sight';
  return null;
}
function googleKind(primaryType, types) {
  for (const t of [primaryType, ...(Array.isArray(types) ? types : [])]) { const k = gKindOf(t); if (k) return k; }
  return 'other';
}

function googleHit(p) {
  const lat = p && p.location && p.location.latitude, lng = p && p.location && p.location.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;       // 没坐标的放不进行程
  const h = hoursFromGoogle(p.regularOpeningHours);
  return {
    name: (p.displayName && p.displayName.text) || '', addr: p.formattedAddress || '', lat, lng, sys: 'wgs84',
    placeId: p.id || '', kind: googleKind(p.primaryType, p.types),
    hours: h.hours, hoursText: h.text, hoursVerified: h.verified,
    phone: p.nationalPhoneNumber || '', source: 'google',
  };
}

const gWaypoint = p => ({ waypoint: { location: { latLng: { latitude: +p.lat, longitude: +p.lng } } } });
// '1234s' → 21 分钟（向上取整）；认不出 → null
function gMinutes(d) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d ?? ''));
  return m ? Math.ceil(Number(m[1]) / 60) : null;
}

// 要算的格 → 一块块：涉及的起点、终点各按 10 个一段切，每个「起点段 × 终点段」是一块；
// 一格都不要的块不发；块里只留真有要的格的行列（稀疏的时候少花钱）
function googleBlocks(list) {
  const rows = [...new Set(list.map(p => p[0]))].sort((a, b) => a - b);
  const cols = [...new Set(list.map(p => p[1]))].sort((a, b) => a - b);
  const want = new Set(list.map(([i, j]) => i + ',' + j));
  const blocks = [];
  for (let r = 0; r < rows.length; r += G_BLOCK) for (let c = 0; c < cols.length; c += G_BLOCK) {
    const rc = rows.slice(r, r + G_BLOCK), cc = cols.slice(c, c + G_BLOCK), ps = [];
    for (const i of rc) for (const j of cc) if (want.has(i + ',' + j)) ps.push([i, j]);
    if (!ps.length) continue;
    const R = rc.filter(i => ps.some(p => p[0] === i)), C = cc.filter(j => ps.some(p => p[1] === j));
    blocks.push({ R, C, ps });
  }
  return blocks;
}

function googleProvider(env) {
  const send = makeSender(env, { label: '谷歌' });
  const needKey = () => { if (!env.key) throw new ProviderError('key', '还没填谷歌钥匙'); };
  const headers = mask => ({ 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.key, 'X-Goog-FieldMask': mask });
  const post = (url, mask, body, extra) => send({ url, init: { method: 'POST', headers: headers(mask), body: JSON.stringify(body) }, ...extra });

  async function search(query, { near } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];                                     // 空的不发（不花钱）
    needKey();
    const body = { textQuery: q, languageCode: 'zh-CN', pageSize: MAX_HITS };
    if (near && Number.isFinite(+near.lat) && Number.isFinite(+near.lng) && near.lat != null && near.lng != null) {
      body.locationBias = { circle: { center: { latitude: +near.lat, longitude: +near.lng }, radius: 20000 } };
    }
    const data = await post(G_SEARCH, G_SEARCH_FIELDS, body, { units: 1, check: googleCheck('Places API (New)') });
    const places = Array.isArray(data.places) ? data.places : [];
    return places.map(googleHit).filter(Boolean).slice(0, MAX_HITS);
  }

  // 只返回 pairs 里要的格；块里顺带算出来的别的格丢掉（钱照样按整块报：谷歌按整块收）。
  // ★ 谷歌回的里面少了哪一格，那格就不在 cells 里（还算没取，下次再取），不当成「没路」。
  async function matrix(points, pairs, { departure, onProgress, signal } = {}) {
    const list = checkPairs(points, pairs);
    const cells = [], acc = { units: 0 };
    if (!list.length) return { cells, units: 0 };
    needKey();
    // 出发时刻：那天当地 10 点（调用方给）；已经过去的不带 —— 谷歌不收过去的时刻
    const dep = departure instanceof Date && departure.getTime() > env.now() ? departure.toISOString() : null;
    let done = 0;
    try {
      for (const b of googleBlocks(list)) {
        const body = { origins: b.R.map(i => gWaypoint(points[i])), destinations: b.C.map(j => gWaypoint(points[j])), travelMode: 'TRANSIT' };
        if (dep) body.departureTime = dep;
        const data = await post(G_MATRIX, G_MATRIX_FIELDS, body, { units: b.R.length * b.C.length, signal, acc, check: googleCheck('Routes API') });
        if (!Array.isArray(data)) throw new ProviderError('other', '谷歌回的路程认不出（不是一串格子）');
        const want = new Set(b.ps.map(([i, j]) => i + ',' + j)), got = new Set();
        for (const el of data) {
          if (!el || typeof el !== 'object') continue;
          const i = b.R[el.originIndex ?? 0], j = b.C[el.destinationIndex ?? 0];   // 值是 0 的下标谷歌可能不写
          const k = i + ',' + j;
          if (i === undefined || j === undefined || !want.has(k) || got.has(k)) continue;
          got.add(k);
          cells.push({ i, j, min: el.condition === 'ROUTE_EXISTS' ? gMinutes(el.duration) : null, mode: 'transit' });
        }
        done += b.ps.length;
        if (onProgress) onProgress({ done, total: list.length });
      }
    } catch (e) { throw withPartial(e, cells); }
    return { cells, units: acc.units };
  }

  async function testKey() {
    try {
      needKey();
      // 只要 places.id 的搜索是最便宜的一档
      await post(G_SEARCH, 'places.id', { textQuery: 'Tokyo Station', pageSize: 1 }, { units: 1, check: googleCheck('Places API (New)') });
      // ★ 取路程走的是另一个 API（Routes），要单独开通；只试一格（东京站 → 东京塔），最便宜
      const body = { origins: [gWaypoint({ lat: 35.681236, lng: 139.767125 })], destinations: [gWaypoint({ lat: 35.658581, lng: 139.745433 })], travelMode: 'TRANSIT' };
      const data = await post(G_MATRIX, G_MATRIX_FIELDS, body, { units: 1, check: googleCheck('Routes API') });
      if (!Array.isArray(data)) throw new ProviderError('other', '谷歌回的路程认不出（不是一串格子）');
      return { ok: true, text: '谷歌钥匙能用（搜地方、取路程两个都开通了）' };
    } catch (e) { return { ok: false, text: errText(e) }; }
  }

  return { name: 'google', search, matrix, testKey };
}

// ======================= 高德 =======================

// 出发时刻 → 高德要的 { date:'YYYY-MM-DD', time:'H-MM' }（当地时间）；没给或不是日期 → null（按现在）
export function amapWhen(departure) {
  if (!(departure instanceof Date) || isNaN(departure.getTime())) return null;
  const p2 = n => String(n).padStart(2, '0');
  return { date: `${departure.getFullYear()}-${p2(departure.getMonth() + 1)}-${p2(departure.getDate())}`, time: `${departure.getHours()}-${p2(departure.getMinutes())}` };
}

const AMAP_KEY_INFOS = {
  INVALID_USER_KEY: '高德钥匙不对',
  USERKEY_PLAT_NOMATCH: '这把高德钥匙不是「Web 服务」类型的，要在高德开放平台另建一把「Web 服务」的',
  INVALID_USER_SIGNATURE: '这把高德钥匙开了数字签名，这个 app 不带签名；在高德开放平台把签名关掉',
  INVALID_USER_SCODE: '这把高德钥匙的安全码对不上',
  INVALID_USER_IP: '这把高德钥匙设了 IP 白名单，手机现在的网络不在里面',
  INVALID_USER_DOMAIN: '这把高德钥匙绑了域名，这个网页不在里面',
  USER_KEY_RECYCLED: '这把高德钥匙已经被删了',
  SERVICE_NOT_AVAILABLE: '这把高德钥匙没开通这项服务',
  INSUFFICIENT_PRIVILEGES: '这把高德钥匙没有这项服务的权限',
  NO_EFFECTIVE_INTERFACE: '这把高德钥匙的接口权限过期了',
};
// 这几种说的是「这两点之间没路 / 超出范围」：只算这一格没查到路，不算整次出错（不然一格卡住整趟都取不下去）
const AMAP_NO_ROUTE = /^(OUT_OF_SERVICE|NO_ROADS_NEARBY|ROUTE_FAIL|OVER_DIRECTION_RANGE|INSUFFICIENT_ABROAD_PRIVILEGES)$/;

function amapCheck({ noRoute = false } = {}) {
  return (res, body) => {
    const code = res.status;
    if (!res.ok) {
      if (code === 401 || code === 403) throw new ProviderError('key', `高德钥匙用不了（HTTP ${code}）`);
      if (code >= 500) return { retry: 'net', text: `高德那边暂时出错（HTTP ${code}），隔一秒重试过一次还是不行` };
      throw new ProviderError('other', `高德回了错误（HTTP ${code}）`);
    }
    if (!body || typeof body !== 'object') throw new ProviderError('other', '高德回的内容认不出（不是 JSON）');
    if (String(body.status) === '1') return { data: body };
    const info = String(body.info || body.infocode || '没说原因');
    if (AMAP_KEY_INFOS[info]) throw new ProviderError('key', `${AMAP_KEY_INFOS[info]}（${info}）`);
    if (/DAILY_QUERY_OVER_LIMIT|IP_QUERY_OVER_LIMIT/.test(info)) throw new ProviderError('quota', `高德今天的免费次数用完了（${info}）`);
    if (/QPS|ACCESS_TOO_FREQUENT|GATEWAY_TIMEOUT/.test(info)) return { retry: 'slow', text: `高德说请求太快，等了 1 秒再试还是不行；过一会儿再取（${info}）` };
    if (/SERVER_IS_BUSY/.test(info)) return { retry: 'net', text: `高德那边忙，隔一秒重试过一次还是不行（${info}）` };
    if (noRoute && AMAP_NO_ROUTE.test(info)) return { data: null };
    throw new ProviderError('other', `高德回了错误（${info}）`);
  };
}

function aStr(x) { return typeof x === 'string' ? x.trim() : (typeof x === 'number' ? String(x) : ''); }   // 空字段有时给 []
// 参数按给的顺序拼；逗号不转义（高德文档里的写法就是 lng,lat）
function qs(obj) {
  return Object.entries(obj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)).replace(/%2C/gi, ',')).join('&');
}
const aLL = p => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`;     // ★ 高德：经度在前
// 路线的秒数（'1234'）→ 分钟（向上取整）；没有 → null
function aMinutes(list) {
  if (!Array.isArray(list) || !list.length || !list[0]) return null;
  const x = list[0], sec = x.cost && x.cost.duration != null ? x.cost.duration : x.duration;
  const n = Number(sec);
  return sec !== '' && sec != null && Number.isFinite(n) && n >= 0 ? Math.ceil(n / 60) : null;
}

function amapKind(type) {
  for (const part of String(type || '').split('|')) {
    const [a, b = ''] = part.split(';');
    if (a === '餐饮服务') return 'food';
    if (a === '购物服务') return 'shop';
    if (a === '风景名胜') return 'sight';
    if (a === '科教文化服务' && /博物馆|美术馆|展览馆|科技馆|纪念馆/.test(b)) return 'sight';
  }
  return 'other';
}

function amapHit(p) {
  if (!p || typeof p !== 'object') return null;
  const [lng, lat] = aStr(p.location).split(',').map(s => (s.trim() === '' ? NaN : Number(s)));   // ★ 经度在前
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const b = p.business || {};
  const h = hoursFromAmap(aStr(b.opentime_week), aStr(b.opentime_today));
  const address = aStr(p.address), city = aStr(p.cityname), district = aStr(p.adname);
  const cc = aStr(p.citycode);
  return {
    name: aStr(p.name), addr: [city, district].filter(x => x && !address.includes(x)).join('') + address,
    lat, lng, sys: 'gcj02', placeId: aStr(p.id), ...(cc ? { citycode: cc } : {}), kind: amapKind(aStr(p.type)),
    hours: h.hours, hoursText: h.text, hoursVerified: h.verified, phone: aStr(b.tel), source: 'amap',
  };
}

function amapProvider(env) {
  const send = makeSender(env, { label: '高德', gapMs: AMAP_GAP_MS });
  const needKey = () => { if (!env.key) throw new ProviderError('key', '还没填高德钥匙'); };
  const get = (path, params, { noRoute = false, signal, acc } = {}) =>
    send({ url: `${AMAP}${path}?${qs({ key: env.key, ...params })}`, units: 1, signal, acc, check: amapCheck({ noRoute }) });

  async function search(query, { city } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];                                     // 空的不发（不花钱）
    needKey();
    const params = { keywords: q };
    if (aStr(city)) { params.region = aStr(city); params.city_limit = 'true'; }
    params.show_fields = 'business';
    params.page_size = String(MAX_HITS);
    const data = await get('/v5/place/text', params);
    const pois = Array.isArray(data.pois) ? data.pois : [];
    return pois.map(amapHit).filter(Boolean).slice(0, MAX_HITS);
  }

  // 一对一次公交；没有公交方案 → 再查步行；都没有 → min:null（查过没路）。
  // ★ 高德公交要起终点的城市码（citycode）；点上没有的先查一次逆地理补上，补到的记回点上（唯一改输入的地方）。
  // ★ 出发时刻（departure）：夜里在酒店取路程，按「现在」查会查不到公交、整段存成步行 —— 所以带上 date / time。
  //   高德 v5 文档原文（0923 curl 下来 grep 到的）：`date 请求日期 例如:2013-10-28`、`time 请求时间 例如:9-54`。
  //   万一高德不收这两个参数（回 INVALID_PARAMS），退回按现在查，并在结果的 note 里说一声，不让整次取数停下。
  async function matrix(points, pairs, { departure, onProgress, signal } = {}) {
    const list = checkPairs(points, pairs);
    const cells = [], acc = { units: 0 };
    if (!list.length) return { cells, units: 0 };
    needKey();
    let when = amapWhen(departure), note = null;
    async function transit(o, d, c1, c2) {
      const base = { origin: o, destination: d, city1: c1, city2: c2, show_fields: 'cost' };
      try {
        return await get('/v5/direction/transit/integrated', when ? { ...base, ...when } : base, { noRoute: true, signal, acc });
      } catch (e) {
        if (!when || !(e instanceof ProviderError) || !/INVALID_PARAMS/.test(e.text || '')) throw e;
        when = null; note = '高德没收「出发时刻」这个参数，这次的公交按现在的时刻查的（夜里查可能查不到车）';
        return await get('/v5/direction/transit/integrated', base, { noRoute: true, signal, acc });
      }
    }
    const looked = new Map();                              // 这次查过的城市码（查过没有的记 ''，不再查）
    async function cityOf(k) {
      const have = aStr(points[k].citycode);
      if (have) return have;
      if (looked.has(k)) return looked.get(k);
      const r = await get('/v3/geocode/regeo', { location: aLL(points[k]) }, { signal, acc });
      const ac = r && r.regeocode && r.regeocode.addressComponent;
      const code = aStr(ac && ac.citycode);
      looked.set(k, code);
      if (code) points[k].citycode = code;
      return code;
    }
    try {
      for (const [i, j] of list) {
        if (signal && signal.aborted) throw cancelled();
        const o = aLL(points[i]), d = aLL(points[j]);
        const c1 = await cityOf(i), c2 = await cityOf(j);
        let min = null, mode = 'transit';
        if (c1 && c2) {       // 查不到城市码的点（多半不在大陆）：公交查不了，直接看步行
          const t = await transit(o, d, c1, c2);
          min = aMinutes(t && t.route && t.route.transits);
        }
        if (min == null) {
          const w = await get('/v5/direction/walking', { origin: o, destination: d, show_fields: 'cost' }, { noRoute: true, signal, acc });
          const wm = aMinutes(w && w.route && w.route.paths);
          if (wm != null) { min = wm; mode = 'walk'; }
        }
        cells.push({ i, j, min, mode });
        if (onProgress) onProgress({ done: cells.length, total: list.length });
      }
    } catch (e) { throw withPartial(e, cells); }
    return note ? { cells, units: acc.units, note } : { cells, units: acc.units };
  }

  async function testKey() {
    try {
      needKey();
      await get('/v5/place/text', { keywords: '天安门', page_size: '1' });
      return { ok: true, text: '高德钥匙能用' };
    } catch (e) { return { ok: false, text: errText(e) }; }
  }

  return { name: 'amap', search, matrix, testKey };
}
