// 地图按钮 + 从链接 / 文字里读坐标（规格 14.2）。纯函数，node 能直接测（测试/maplinks.test.mjs）。
// 三个地区两套坐标：
//   hk 香港、abroad 国外 —— WGS-84；按钮给 苹果 + 谷歌；贴高德链接拒收（高德在这些地方的坐标对不上）
//   cn 中国大陆         —— GCJ-02；按钮给 高德 + 苹果（大陆的苹果地图本来就是 GCJ-02）；不给谷歌、贴谷歌链接拒收
// ★ 高德的链接一律「经度在前」（position=lng,lat），谷歌 / 苹果是「纬度在前」—— 最容易写反的地方。

import { haversineM, inChina, NEAR_M } from './geo.js';

// ★ 步行门槛只有一个数：geo.js 的 NEAR_M（600 米，路程那边同一条线）。0923 之前这里是 400，
//   400～600 米之间排程说「步行」、按钮却开公交 —— 两个数一定会岔开，所以按钮优先听排程的（opts.walk）。
const f6 = x => Number(x).toFixed(6);
const enc = s => encodeURIComponent(s || '');

// 按钮走步行还是公交：排程说了算（leg.mode）；排程没说（估的）→ null，按距离
export function walkFromLeg(leg) {
  const m = leg && leg.mode;
  return m === 'walk' ? true : m === 'transit' || m === 'mtr' || m === 'bus' ? false : null;
}

// a → b 的地图按钮。a / b = { lat, lng, name? }，坐标是这一趟那套（cn = GCJ-02，其余 = WGS-84）
// opts.walk：true 步行 / false 公交 / 不给 → 直线 < NEAR_M 算步行
// ★ 终点交给地图的是【店名 + 地址】，不是光秃秃的坐标（Nathan 0924：「要去英记茶庄旺角店，跳转谷歌地图就应该是跳到彌敦道719號D」）。
//   有地址 → daddr / destination 写「店名 地址」，地图自己认店、标名字；没地址（酒店 / 口岸 / 手动定位的点）→ 还是坐标。
//   起点永远是坐标（上一站在哪只有我们知道）。
//   ★ 两套链接都给（0924 15:5x 改）：Nathan 的规矩是「大陆网络环境用高德，出了大陆的网络环境用谷歌」——按的是【手机此刻的网络】，
//   不是这一趟去哪；哪个网络由 app.js 探一次谷歌通不通来定，这里只管把两套都算好。苹果地图的链接留着（复制/测试用），按钮不再显示。
//   高德的 dev：0 = 坐标已经是 GCJ-02（大陆那套）、1 = WGS-84 要它自己换算（香港 / 国外那套）。
export function mapLinks(region, a, b, opts = {}) {
  const near = opts.walk == null ? haversineM(a, b) < NEAR_M : !!opts.walk;
  const cn = region === 'cn';
  const s = `${f6(a.lat)},${f6(a.lng)}`, coordD = `${f6(b.lat)},${f6(b.lng)}`;
  // 店名里括号那截（「（旗艦零售館/唐餅文化館/烘焙工作坊）」这种）不交给地图：地图按文字找店，多余的字只会把它带偏；复制出来的仍是全名
  const shortName = String(b.name || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim();
  const destText = b.addr ? `${shortName} ${b.addr}`.trim() : '';
  const d = destText ? enc(destText) : coordD;
  const apple = `maps://?saddr=${s}&daddr=${d}&dirflg=${near ? 'w' : 'r'}`;
  const copyText = b.addr ? `${b.name || ''} ${b.addr}`.trim() : `${b.name || ''} ${coordD}`.trim();
  // 高德 app：t=1 公交、2 步行
  const amap = `iosamap://path?sourceApplication=nathan-trip&slat=${f6(a.lat)}&slon=${f6(a.lng)}&sname=${enc(a.name)}`
    + `&dlat=${f6(b.lat)}&dlon=${f6(b.lng)}&dname=${enc(destText || b.name)}&dev=${cn ? 0 : 1}&t=${near ? 2 : 1}`;
  // 没装高德 → 高德网页。大陆：按坐标导航（经度在前；名字可以不带）。大陆以外：网页版只认 GCJ-02 坐标，直接按「店名 地址」搜，没地址就搜坐标
  const from = `${f6(a.lng)},${f6(a.lat)}${a.name ? ',' + enc(a.name) : ''}`;
  const to = `${f6(b.lng)},${f6(b.lat)}${(destText || b.name) ? ',' + enc(destText || b.name) : ''}`;
  const amapWeb = cn
    ? `https://uri.amap.com/navigation?from=${from}&to=${to}&mode=${near ? 'walk' : 'bus'}&src=nathan-trip`
    : `https://uri.amap.com/search?keyword=${destText ? enc(destText) : coordD}&src=nathan-trip`;
  // Uber：打开就是填好终点的下单页（pickup=my_location 当前位置）。坐标要 WGS-84——大陆那趟是 GCJ-02，但 Uber 不在大陆运营，app.js 大陆不显示这个按钮
  const uberQ = `action=setPickup&pickup=my_location&dropoff[latitude]=${f6(b.lat)}&dropoff[longitude]=${f6(b.lng)}&dropoff[nickname]=${enc(shortName || b.name || '')}${b.addr ? `&dropoff[formatted_address]=${enc(b.addr)}` : ''}`;
  return {
    near, apple, amap, amapWeb, copyText,
    uber: `uber://?${uberQ}`, uberWeb: `https://m.uber.com/ul/?${uberQ}`,
    google: `comgooglemaps://?saddr=${s}&daddr=${d}&directionsmode=${near ? 'walking' : 'transit'}`,
    googleWeb: `https://www.google.com/maps/dir/?api=1&origin=${s}&destination=${d}&travelmode=${near ? 'walking' : 'transit'}`,
  };
}

// ---------------- 从一段文字里读坐标 ----------------
// 返回 { lat, lng, sys } | { error:'给人看的话' } | null（什么都没认出）

export const LINK_ERRORS = {
  googleInCn: '谷歌的坐标在大陆会偏几百米，用高德分享或者直接搜',
  amapOutside: '高德的坐标在香港和国外对不上，用苹果或谷歌地图分享',
  short: '这是短链接，里面没有坐标；在地图里打开后再分享一次，或者直接搜',
};

const NUM = '(-?\\d+(?:\\.\\d+)?)';
// ★ maps.apple/p/ 是不是苹果的短链接没核实过；写上只会多给一句提示，不会读错坐标
const SHORT = /(?:maps\.app\.goo\.gl|goo\.gl\/|surl\.amap\.com|maps\.apple\/p\/)/i;

function linkKind(s) {
  if (/(?:google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/|comgooglemaps:|ditu\.google\.cn)/i.test(s)) return 'google';
  if (/(?:amap\.com|amapuri:|iosamap:|androidamap:|gaode\.com)/i.test(s)) return 'amap';
  if (/(?:maps\.apple\.com|maps\.apple\/|(?:^|[^a-z])maps:)/i.test(s)) return 'apple';
  return null;
}

function valid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
// 两个数谁是纬度：按「纬度在前」读得通就按它；读不通、反过来读得通就反过来（116.39, 39.90 这种）
// ★ 大陆：先看哪种读法落在中国境内。新疆的经度不到 90（乌鲁木齐 87.6），「87.61,43.82」两种读法都「读得通」，
//   只按纬度在前会把它放到北极边上、不报错（高德的坐标拾取器给的就是经度在前）
function order(first, second, cn) {
  if (cn) {
    if (inChina(first, second)) return { lat: first, lng: second };
    if (inChina(second, first)) return { lat: second, lng: first };
  }
  if (valid(first, second)) return { lat: first, lng: second };
  if (valid(second, first)) return { lat: second, lng: first };
  return null;
}

// 谷歌 / 苹果：纬度在前。按准确程度排：谷歌地点页的 !3d!4d → 各种参数 → 谷歌视野中心 @
function fromGoogleApple(s, cn) {
  const places = [...s.matchAll(new RegExp(`!3d${NUM}!4d${NUM}`, 'g'))];
  if (places.length) {
    const m = places[places.length - 1];
    const r = order(Number(m[1]), Number(m[2]), cn);
    if (r) return r;
  }
  for (const p of ['coordinate', 'daddr', 'destination', 'q', 'query', 'll', 'sll', 'center']) {
    const m = s.match(new RegExp(`[?&]${p}=${NUM},\\s*\\+?${NUM}`));
    if (m) { const r = order(Number(m[1]), Number(m[2]), cn); if (r) return r; }
  }
  const m = s.match(new RegExp(`@${NUM},${NUM}`));
  return m ? order(Number(m[1]), Number(m[2]), cn) : null;
}

// 高德：经度在前（position=lng,lat、to=lng,lat,名字）；amapuri:// / iosamap:// 是分开的 lat= / lon=
function fromAmap(s, cn) {
  for (const p of ['position', 'lnglat', 'to', 'destination']) {
    const m = s.match(new RegExp(`[?&]${p}=${NUM},\\s*${NUM}`));
    if (m) { const r = order(Number(m[2]), Number(m[1]), cn); if (r) return r; }
  }
  for (const [la, lo] of [['lat', 'lon'], ['lat', 'lng'], ['dlat', 'dlon']]) {
    const a = s.match(new RegExp(`[?&]${la}=${NUM}`)), b = s.match(new RegExp(`[?&]${lo}=${NUM}`));
    if (a && b) { const r = order(Number(a[1]), Number(b[1]), cn); if (r) return r; }
  }
  return null;
}

// 直接写的坐标：「39.9075, 116.3914」「116.3914，39.9075」（至少两位小数，逗号隔开）
function fromPlain(s, cn) {
  const m = s.match(/(?:^|[^\d.])(-?\d{1,3}\.\d{2,})\s*[,，]\s*(-?\d{1,3}\.\d{2,})(?![\d.])/);
  return m ? order(Number(m[1]), Number(m[2]), cn) : null;
}

function decodeSafe(s) {
  let out = s;
  try { out = decodeURIComponent(s); } catch { /* 文字里有单独的 % 之类：按原文读 */ }
  return out.replace(/%2C/gi, ',');
}

export function coordsFromText(text, region) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const s = decodeSafe(raw).replace(/\s+/g, ' ');
  const kind = linkKind(s);
  const cn = region === 'cn';
  // 地区对不上的先说（短链接在地图里重新分享一次也还是这家的，先说这个才不白跑一趟）
  if (kind === 'google' && cn) return { error: LINK_ERRORS.googleInCn };
  if (kind === 'amap' && !cn) return { error: LINK_ERRORS.amapOutside };
  const hit = (kind === 'amap' ? fromAmap(s, cn) : kind ? fromGoogleApple(s, cn) : null) || fromPlain(s, cn);
  if (hit) return { lat: hit.lat, lng: hit.lng, sys: cn ? 'gcj02' : 'wgs84' };
  if (SHORT.test(s)) return { error: LINK_ERRORS.short };
  return null;
}
