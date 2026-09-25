// 纯几何（规格 14.2 / 14.3 / 14.5）：直线距离、路程矩阵的格子键、没查到路程时怎么估、
// 手机 GPS 的坐标（WGS-84）换成高德那套（GCJ-02）、把存好的矩阵变成引擎要的 travel。
// 纯函数，不碰网络、不碰存储；node 能直接测（测试/geo.test.mjs）。

export function haversineM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 走路：城市里走不了直线 ×1.35，每分钟 70 米（跟 transit.js 的 TRANSIT_DEFAULTS 同一套数）
export const WALK = { mPerMin: 70, detour: 1.35 };
export function walkMin(meters) { return meters * WALK.detour / WALK.mPerMin; }

// 直线不到这么多米的两点不去联网查，按走路估（市区里这么近公交也是走的）
export const NEAR_M = 600;

// 没查到路程时的估法：走路 和 「10 分钟等车换乘 + 公交约 20 公里/小时」取快的那个。
// 两条线在约 650 米处交叉，所以近的按走、远的按公交，中间没有跳变。
// 打车估算（0926 加，给「最优 + 备选」列的打车那条）：等车 5 分钟 + 路上按 24 公里/小时（市区含红灯）、绕路 1.4。只是估的，界面要标「估」。
export const TAXI = { wait: 5, mPerMin: 400, detour: 1.4 };
export function taxiMin(meters) { return TAXI.wait + meters * TAXI.detour / TAXI.mPerMin; }

export function estimateMin(meters) {
  return Math.min(walkMin(meters), 10 + meters * 1.4 / 350);
}

// 矩阵格子的键：两点各取 5 位小数（约 1 米），字典序小的在前 → a→b 和 b→a 是同一格（规格 14.3）
export function ptKey(p) { return Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5); }
export function pairKey(a, b) {
  const x = ptKey(a), y = ptKey(b);
  return x < y ? x + '|' + y : y + '|' + x;
}
export function samePoint(a, b) { return ptKey(a) === ptKey(b); }

// 这些点里还有哪些格子要去查：i<j、不是同一点、直线 ≥ NEAR_M、矩阵里还没有（有但 min=null 的也不再查：查过没路）
export function missingPairs(points, matrix = {}) {
  const out = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j];
    if (samePoint(a, b)) continue;
    if (haversineM(a, b) < NEAR_M) continue;
    if (matrix[pairKey(a, b)]) continue;
    out.push([i, j]);
  }
  return out;
}

// 把存好的格子变成引擎要的 travel（规格 14.5）。
// cellOf(a,b) → { min, mode:'transit'|'walk'|'est', src:'google'|'amap'|'est'|'same' }
// 没有的格、查过没路的格 → 按直线估，mode 'est'（界面上标「估的」）。
export function makeMatrixTravel(matrix = {}) {
  function cellOf(a, b) {
    if (a === b || samePoint(a, b)) return { min: 0, mode: 'walk', src: 'same' };
    const m = haversineM(a, b);
    if (m < NEAR_M) return { min: walkMin(m), mode: 'walk', src: 'est' };
    const c = matrix[pairKey(a, b)];
    if (c && c.min != null && isFinite(c.min)) return { min: c.min, mode: c.mode || 'transit', src: c.src || 'api' };
    return { min: estimateMin(m), mode: 'est', src: 'est' };
  }
  function describe(a, b) {
    const c = cellOf(a, b);
    const n = Math.max(1, Math.round(c.min));
    const text = c.mode === 'walk' ? `步行约 ${n} 分钟` : c.mode === 'transit' ? `公交约 ${n} 分钟` : `估的：约 ${n} 分钟（还没联网取路程）`;
    return { ...c, text };
  }
  return {
    cellOf, describe,
    between: (a, b) => cellOf(a, b).min,
    forTrip(start, end) {
      return { between: (a, b) => cellOf(a, b).min, fromStart: b => cellOf(start, b).min, toEnd: a => cellOf(a, end).min };
    },
  };
}

// ---------- WGS-84 → GCJ-02（手机 GPS → 高德 / 大陆苹果地图用的坐标）----------
// 通行的那套公式；只做这一个方向（规格 14.2）。中国范围外原样返回。
const A = 6378245.0, EE = 0.00669342162296594323;
export function inChina(lat, lng) { return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271; }
function tLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}
function tLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}
export function wgs2gcj({ lat, lng }) {
  lat = Number(lat); lng = Number(lng);
  if (!inChina(lat, lng)) return { lat, lng };
  let dLat = tLat(lng - 105.0, lat - 35.0);
  let dLng = tLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sq) * Math.PI);
  dLng = (dLng * 180.0) / (A / sq * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
