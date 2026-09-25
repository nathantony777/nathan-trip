// 回顾用的地图：不用地图瓦片、不联网，把这趟走过的点按经纬度投到一张 SVG 上，画成轨迹。
// 输入 trail = { days: [{ date, start:{name,lat,lng,time}, end:{name,lat,lng,arrive}, stops:[{name,lat,lng,begin,end,items:[{name,status}]}] }] }
// 香港的可以带 ctx.mtr（data.mtr：st / seg）当底图，画成淡淡的线，有个「这是香港」的感觉。
// ★ 纯函数：不碰 DOM、不碰存储，测试/map.test.mjs 钉它。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = m => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;

// 所有点（起点、终点、每站）；坐标缺的跳过
export function trailPoints(trail) {
  const pts = [];
  for (const d of (trail && trail.days) || []) {
    if (d.start && d.start.lat != null) pts.push({ kind: 'start', name: d.start.name, lat: d.start.lat, lng: d.start.lng, t: d.start.time, date: d.date });
    for (const s of d.stops || []) if (s.lat != null) pts.push({ kind: 'stop', name: s.name, lat: s.lat, lng: s.lng, t: s.begin, date: d.date, items: s.items || [] });
    if (d.end && d.end.lat != null) pts.push({ kind: 'end', name: d.end.name, lat: d.end.lat, lng: d.end.lng, t: d.end.arrive, date: d.date });
  }
  return pts;
}

// 经纬度 → 画布坐标：等比（纬度按 cos 修正），四边留白，点少于 2 个时给一个不为 0 的范围免得除零
export function projector(pts, w, h, pad = 24) {
  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  if (!(maxLat - minLat > 1e-6)) { minLat -= 0.005; maxLat += 0.005; }
  if (!(maxLng - minLng > 1e-6)) { minLng -= 0.005; maxLng += 0.005; }
  const cos = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = (maxLng - minLng) * cos, spanY = maxLat - minLat;
  const k = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const ox = (w - spanX * k) / 2, oy = (h - spanY * k) / 2;
  const f = (lat, lng) => [ox + (lng - minLng) * cos * k, oy + (maxLat - lat) * k];
  f.bbox = { minLat, maxLat, minLng, maxLng };
  return f;
}

const round = n => Math.round(n * 10) / 10;

// 整张图。opts: { w, h, mini（首页小图：不标号、不画站名）, mtr（香港底图）, animate }
export function trailSVG(trail, opts = {}) {
  const w = opts.w || 343, h = opts.h || 260, mini = !!opts.mini, animate = opts.animate !== false;
  const pts = trailPoints(trail);
  if (pts.length < 2) return '';
  const P = projector(pts, w, h, mini ? 6 : 26);
  const out = [`<svg class="trail${mini ? ' mini' : ''}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="这趟走过的路">`];
  // 底图：港铁线段（只画落在图里附近的），淡淡的
  if (opts.mtr && opts.mtr.st && opts.mtr.seg) {
    const st = new Map(opts.mtr.st.map(s => [s[0], { lat: s[2], lng: s[3] }]));
    const B = P.bbox, mLat = (B.maxLat - B.minLat) * 0.6 + 0.01, mLng = (B.maxLng - B.minLng) * 0.6 + 0.01;
    const inside = p => p && p.lat > B.minLat - mLat && p.lat < B.maxLat + mLat && p.lng > B.minLng - mLng && p.lng < B.maxLng + mLng;
    const segs = [];
    for (const [, a, b] of opts.mtr.seg) {
      const A = st.get(a), Bp = st.get(b);
      if (inside(A) && inside(Bp)) { const [x1, y1] = P(A.lat, A.lng), [x2, y2] = P(Bp.lat, Bp.lng); segs.push(`M${round(x1)} ${round(y1)}L${round(x2)} ${round(y2)}`); }
    }
    if (segs.length) out.push(`<path class="base" d="${segs.join('')}" fill="none" stroke="currentColor" stroke-width="${mini ? 1 : 1.5}" stroke-linecap="round" opacity=".18"/>`);
  }
  // 轨迹：一天一条线（按顺序连起点 → 各站 → 终点）
  let di = 0;
  for (const d of trail.days || []) {
    const seq = pts.filter(p => p.date === d.date);
    if (seq.length < 2) continue;
    const dd = seq.map((p, i) => { const [x, y] = P(p.lat, p.lng); return `${i ? 'L' : 'M'}${round(x)} ${round(y)}`; }).join('');
    out.push(`<path class="route d${di % 4}" d="${dd}" fill="none" stroke-width="${mini ? 2 : 2.5}" stroke-linecap="round" stroke-linejoin="round"${animate ? ` pathLength="1" style="animation-delay:${di * 0.9}s"` : ''}/>`);
    di++;
  }
  // 点：起终点画方块，站画圆；大图标号。同一个位置连着几站（同一栋楼里几家店）合成一个圆，标「1–3」
  const marks = [];
  let n = 0;
  pts.forEach(p => {
    const [x, y] = P(p.lat, p.lng);
    if (p.kind === 'start' || p.kind === 'end') { marks.push({ kind: 'port', x, y, name: p.name }); return; }
    n++;
    const last = marks[marks.length - 1];
    if (last && last.kind === 'stop' && Math.abs(last.x - x) < 6 && Math.abs(last.y - y) < 6) { last.to = n; last.items.push(...p.items); last.name += '、' + p.name; return; }
    marks.push({ kind: 'stop', x, y, from: n, to: n, name: p.name, t: p.t, items: [...p.items] });
  });
  marks.forEach((m, i) => {
    const delay = animate ? ` style="animation-delay:${round(0.25 + i * 0.14)}s"` : '';
    if (m.kind === 'port') {
      out.push(`<rect class="pt port" x="${round(m.x - (mini ? 3 : 5))}" y="${round(m.y - (mini ? 3 : 5))}" width="${mini ? 6 : 10}" height="${mini ? 6 : 10}" rx="2" transform="rotate(45 ${round(m.x)} ${round(m.y)})"${delay}><title>${esc(m.name)}</title></rect>`);
      return;
    }
    const done = m.items.length && m.items.every(it => it.status && it.status !== 'todo');
    const some = m.items.some(it => ['bought', 'enough'].includes(it.status));
    const label = m.from === m.to ? String(m.from) : `${m.from}–${m.to}`;
    const r = mini ? 3 : (label.length > 2 ? 12 : 9);
    out.push(`<circle class="pt stop${some ? ' got' : ''}${done ? ' done' : ''}" cx="${round(m.x)}" cy="${round(m.y)}" r="${r}"${delay}><title>${esc(m.name)} ${hm(m.t)}</title></circle>`);
    if (!mini) out.push(`<text class="idx" x="${round(m.x)}" y="${round(m.y + 3.5)}" text-anchor="middle"${delay}>${label}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}
