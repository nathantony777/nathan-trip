// 离线缓存（规格第九节）：第一次联网打开后，程序和香港数据都存在手机里，断网照样能用。
// ★ 改了任何文件就把 VERSION 改一下，手机下次联网打开时换新版（旧缓存删掉）。
const VERSION = 'v-20260924-1558';
const FILES = [
  './', 'index.html', 'app.js', 'worker.js', 'engine.js', 'transit.js', 'hours.js', 'parse.js', 'plan.js',
  'geo.js', 'trip.js', 'tripPlan.js', 'days.js', 'providers.js', 'hoursImport.js', 'maplinks.js', 'matrix.js',   // 旅游版（规格第十四节）
  'trips.js', 'speech.js', 'ai.js', 'map.js', 'collect.js', 'fx.js',                                                                              // 说话 + 出行的集合（规格第十五节）
  '数据/hk.json', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
];

// cache: 'reload'：GitHub 网页会让浏览器把文件留 10 分钟，不加这个，刚发的新版可能被装成旧文件。
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 先用缓存（断网也快），同时后台去取新的（联网时顺手更新，下次打开生效）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || new Response('断网了，而且这个文件没缓存过', { status: 503 });
  }));
});
