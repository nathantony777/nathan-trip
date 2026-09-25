// 一整份计划（标题 + 打勾清单 + 「购物：」+ 一行一样「东西-给谁」）→ { 哪天 / 主要任务 / 备注行 / 购物行 }。
// ★ 0924 Nathan 把这样一份计划贴进「说话」框按「听懂」，被按「一句话一件事」拆成 19 个假地方（标题当地方、称呼当景点）。
//   这种文档不该走 parseSpeech；这里只做分拣，购物行交给 parse.js 的 parseList，其余原样当那天的备注。纯函数、离线。
const LEAD = /^[\s○●◯•·\-–—☐☑✓✔□■▪*]+|^\d+[.、)）]\s*/;
const CHECK = /^\s*[-*]?\s*\[[ xX]\]/;                       // 「- [ ] 」「[x]」这种打勾标记
const SECTION = /^([^：:]{1,8})[：:]\s*$/;                     // 「购物：」这种只有标题的行
const SHOP_SECTION = /购物|采买|要买|买的|清单/;
const DEPART = /出发|开车|启程|动身/;
const clean = l => l.replace(CHECK, '').replace(LEAD, '').replace(LEAD, '').trim();

// 「9/25」「9月25日」「2026-09-25」→ YYYY-MM-DD；年份没写就按 today 的年，且已经过去很久（>200 天）就算明年
export function dateInTitle(title, today) {
  const t = String(title || '');
  let y = null, m = null, d = null;
  let x = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = t.match(/(?:^|[^\d])(\d{1,2})\s*[\/月]\s*(\d{1,2})(?:日|号)?(?!\d)/))) { m = +x[1]; d = +x[2]; }
  if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (!y) {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? new Date(today + 'T00:00:00') : new Date();
    y = base.getFullYear();
    const cand = new Date(y, m - 1, d);
    if ((base - cand) / 864e5 > 200) y += 1;
  }
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

// 是不是一份文档（不是一句话）：≥4 行，且有打勾标记 / 分节标题行 / ≥3 行「东西-给谁」
export function isPlanDoc(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const checks = lines.filter(l => CHECK.test(l)).length;
  const sections = lines.filter(l => SECTION.test(clean(l))).length;
  const dashWho = lines.filter(l => /\S\s*[-－—–]\s*[^\d\s-－—–]{1,8}$/.test(clean(l))).length;
  return checks >= 2 || sections >= 1 || dashWho >= 3;
}

// → { date, task, title, notes: [行…], shopLines: [行…], skipped: [行…] }
export function parsePlanDoc(text, ctx = {}) {
  const raw = String(text || '').split(/\r?\n/);
  const lines = raw.map(l => l.trim()).filter(Boolean);
  const out = { date: null, task: '', title: '', notes: [], shopLines: [], skipped: [] };
  if (!lines.length) return out;
  let i = 0;
  // 第一行：标题（有日期就是「哪天」；括号里是主要任务）
  const first = clean(lines[0]);
  const dt = dateInTitle(first, ctx.today);
  if (dt || /主要任务|计划|安排/.test(first)) {
    out.title = first; out.date = dt;
    const m = first.match(/[（(]\s*(?:主要任务\s*[：:])?\s*([^）)]+)[）)]/);
    out.task = m ? m[1].trim() : first.replace(/^[^（(]*[（(]|[）)]\s*$/g, '').trim() === first ? '' : '';
    if (!m && !dt) out.task = first;
    i = 1;
  }
  let inShop = false;
  for (; i < lines.length; i++) {
    const l = clean(lines[i]);
    if (!l) continue;
    const sec = l.match(SECTION);
    if (sec) { inShop = SHOP_SECTION.test(sec[1]); if (!inShop) out.notes.push(sec[1]); continue; }
    if (inShop) { out.shopLines.push(l); continue; }
    if (/\S\s*[-－—–]\s*[^\d\s-－—–]{1,8}$/.test(l) && !DEPART.test(l)) { out.shopLines.push(l); continue; }   // 没写「购物：」也认「东西-给谁」
    out.notes.push(l);
  }
  return out;
}
export const isDepartLine = l => DEPART.test(String(l || ''));
