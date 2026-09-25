// 收藏箱：把从小红书 / 大众点评 / 抖音「分享 → 复制」出来的文字、或从电脑上整理出来的收藏文件，认成一条条「收来的店」。
// 只认文字，不联网、不碰账号（Nathan 0924：「信息只保存在本地」）。
// 一条 = { source, url, title, name, addr, text }：name 是猜的店名（帖子 / 视频的标题不一定是店，界面上让他改）。
// ★ 纯函数，测试/collect.test.mjs 钉它。

// 链接归一：同一家店分享两次，小红书 / 抖音的链接会带不同的 ?xsec_token / 口令参数，不剥掉就当成两条。
// 剥：协议统一 https、域名小写、问号后面全去掉、末尾斜杠去掉。★ 只用来去重和存，不用来打开（打开原帖用原文也行，参数没了小红书网页版照样开）。
export function normUrl(u = '') {
  let s = String(u).trim(); if (!s) return '';
  s = s.replace(/^http:\/\//i, 'https://').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return s.replace(/^(https:\/\/)([^/]+)/i, (m, a, h) => a + h.toLowerCase());
}
const URL_RE = /https?:\/\/[^\s"'<>【】（）()，,。！!]+/g;

export function sourceOf(url = '', text = '') {
  const s = (url + ' ' + text);
  if (/xhslink\.com|xiaohongshu\.com|小红书/.test(s)) return '小红书';
  if (/dianping\.com|dpurl\.cn|大众点评/.test(s)) return '大众点评';
  if (/douyin\.com|iesdouyin\.com|抖音/.test(s)) return '抖音';
  if (/amap\.com|高德/.test(s)) return '高德';
  if (/maps\.apple\.com|苹果地图/.test(s)) return '苹果地图';
  if (/google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/.test(s)) return '谷歌地图';
  if (/meituan\.com|美团/.test(s)) return '美团';
  return '';
}

// 各家分享文字里的套话，去掉
const NOISE = [
  /复制本条信息[，,]?打开【?小红书】?App查看精彩内容[！!]?/g, /复制打开抖音[，,]?看看/g, /复制此链接/g, /长按复制此条消息[^\n]*/g, /【[^】]*的作品】/g, /分享自大众点评/g, /快来看看吧[！!]?/g,
  /我在大众点评发现了/g, /我在小红书发现了/g, /打开抖音搜索/g, /^\s*\d+(\.\d+)?\s+(?=[^\d])/gm,   // 抖音开头那串「8.93 」口令数字
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,
];
const clean = s => NOISE.reduce((x, re) => x.replace(re, ' '), s).replace(/[ \t]+/g, ' ').replace(/^[\s，,。！!:：、·—-]+|[\s，,。！!:：、·—-]+$/g, '').trim();

// 店名：【】里的优先；再去掉「-大众点评」「| 小红书」这类尾巴、分店括号留着
export function nameFromTitle(title = '') {
  let t = title.trim();
  const m = t.match(/【([^】]{1,40})】/); if (m) t = m[1];
  t = t.replace(/\s*[-–—|｜]\s*(大众点评|小红书|抖音|美团)\s*$/, '').replace(/^「|」$/g, '').replace(/^"|"$/g, '').trim();
  return t.slice(0, 40);
}

// 一段文字 → 若干条。按链接切块：一条分享 = 一段文字 + 一个链接。没有链接的整段算一条（比如手抄的店名）。
export function parseShare(text) {
  const src = String(text || '').replace(/\r/g, '');
  if (!src.trim()) return [];
  const blocks = [];
  // 先按「——」「\n\n」分大段（收藏文件里一条一段），每段再按链接切
  for (const seg of src.split(/\n[-—－]{2,}\n|\n{2,}/)) {
    if (!seg.trim()) continue;
    const urls = seg.match(URL_RE) || [];
    if (urls.length <= 1) { blocks.push({ body: seg, url: urls[0] || '' }); continue; }
    let rest = seg;
    for (const u of urls) { const i = rest.indexOf(u); blocks.push({ body: rest.slice(0, i + u.length), url: u }); rest = rest.slice(i + u.length); }
    if (rest.trim()) blocks[blocks.length - 1].body += rest;
  }
  const out = [];
  for (const b of blocks) {
    const body = clean(b.body.replace(URL_RE, ' '));
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length && !b.url) continue;
    const addrM = body.match(/地址[:：]?\s*([^\n]{3,80})/);
    const addr = addrM ? addrM[1].replace(/\s*(电话|人均|营业|评分).*$/, '').trim() : '';
    const title = lines.find(l => /【/.test(l)) || lines.find(l => !/^地址/.test(l)) || '';
    const name = nameFromTitle(title) || (b.url ? '' : '');
    const source = sourceOf(b.url, b.body);
    if (!name && !b.url) continue;
    out.push({ source, url: normUrl(b.url), title: title.trim(), name, addr, text: lines.join(' ').slice(0, 300) });
  }
  return out;
}

// 去重：同一个链接、或同名同来源只留一条
export function dedupe(entries, existing = []) {
  const seen = new Set(existing.map(e => e.url || (e.source + '|' + e.name)));
  const out = [];
  for (const e of entries) { const k = e.url || (e.source + '|' + e.name); if (seen.has(k)) continue; seen.add(k); out.push(e); }
  return out;
}
