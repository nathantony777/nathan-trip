// 营业时间导入（规格 14.4）：谷歌给的 periods、高德给的一句中文 → hours.js 认的格式
//   [{ days:'Mo-Fr', open:'09:00', close:'18:00' }]   days 用 Mo Tu We Th Fr Sa Su，区间 -，并列逗号，PH = 公众假期；
//   关门 ≤ 开门 = 开过午夜（hours.js 就是这么认的）。
// 两个函数都返回 { hours, text, verified }：
//   hours    认出来的营业时间；没有 / 认不出 → null（排的时候按 DEFAULT_HOURS 10–20 点算）
//   text     给人看的原文（谷歌的 weekdayDescriptions、高德的原话）
//   verified true = 整段话都认出来了；false = 界面标「未核实」
// ★ 错往哪边落：认不全就标「未核实」；宁可少说开门，也不许把「休息」认成「开门」。
// 纯函数，不碰网络；测试在 测试/hoursImport.test.mjs，每个结果都拿 hours.js 的 openOn 真验过。

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];            // 跟 hours.js 同一套：0 = 周一
const CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_MIN = 24 * 60;

function hhmm(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function str(x) { return typeof x === 'string' ? x.trim() : ''; }  // 高德的空字段有时给 []，一律当没有

// [0,1,2,3,4] → 'Mo-Fr'；[5,6] → 'Sa,Su'；[0,2,3,4] → 'Mo,We-Fr'
function daysStr(ds) {
  const xs = [...new Set(ds)].sort((a, b) => a - b), out = [];
  for (let k = 0; k < xs.length;) {
    let e = k;
    while (e + 1 < xs.length && xs[e + 1] === xs[e] + 1) e++;
    if (e - k >= 2) out.push(DAYS[xs[k]] + '-' + DAYS[xs[e]]);
    else for (let q = k; q <= e; q++) out.push(DAYS[xs[q]]);
    k = e + 1;
  }
  return out.join(',');
}

function sortUnique(rs) {
  const seen = new Set(), out = [];
  for (const r of [...rs].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const k = r[0] + '-' + r[1];
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

// 每天的时段（分钟）→ hours 行；时段完全一样的几天并成一行
function rowsFrom(perDay, ph) {
  const same = new Map();
  perDay.forEach((rs, d) => {
    if (!rs || !rs.length) return;
    const sorted = sortUnique(rs), k = JSON.stringify(sorted);
    if (!same.has(k)) same.set(k, { rs: sorted, days: [] });
    same.get(k).days.push(d);
  });
  const rows = [];
  for (const g of same.values()) for (const [o, c] of g.rs) rows.push({ days: daysStr(g.days), open: hhmm(o), close: hhmm(c) });
  if (ph && ph.length) for (const [o, c] of sortUnique(ph)) rows.push({ days: 'PH', open: hhmm(o), close: hhmm(c) });
  return rows;
}

// hours 行 → 一句中文（谷歌没给 weekdayDescriptions 时用）
function cnDays(days) {
  if (days === 'Mo-Su') return '每天';
  return days.split(',').map(t => {
    if (t === 'PH') return '公众假期';
    const [a, b] = t.split('-');
    return b ? `${CN[DAYS.indexOf(a)]}至${CN[DAYS.indexOf(b)]}` : CN[DAYS.indexOf(a)];
  }).join('、');
}
function describe(rows) { return rows.map(r => `${cnDays(r.days)} ${r.open}–${r.close}`).join('；'); }

// ======================= 谷歌 =======================
// regularOpeningHours.periods[{ open:{day,hour,minute}, close:{day,hour,minute} }]，day 0 = 周日。
// ★ 值是 0 的字段谷歌可能不写（proto 的习惯），缺了一律按 0。

function gDay(d) {
  const n = Number(d ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? (n + 6) % 7 : -1;   // 谷歌 0=周日 → 这里 0=周一
}
function gMin(pt) { return Number(pt.hour ?? 0) * 60 + Number(pt.minute ?? 0); }

export function hoursFromGoogle(roh) {
  const desc = Array.isArray(roh && roh.weekdayDescriptions)
    ? roh.weekdayDescriptions.filter(x => typeof x === 'string' && x.trim()) : [];
  const periods = Array.isArray(roh && roh.periods) ? roh.periods : [];
  const perDay = DAYS.map(() => []);

  if (periods.length === 1 && periods[0] && periods[0].open && !periods[0].close) {
    // 谷歌写「24 小时营业」的办法：只有一个 open（周日 00:00），没有 close —— 说的是每一天
    perDay.forEach(rs => rs.push([0, DAY_MIN]));
  } else {
    for (const p of periods) {
      if (!p || !p.open) continue;
      const od = gDay(p.open.day), om = gMin(p.open);
      if (od < 0 || !(om >= 0 && om < DAY_MIN)) continue;
      if (!p.close) { perDay[od].push([0, DAY_MIN]); continue; }       // 只有开没有关：这天 24 小时
      const cd = gDay(p.close.day), cm = gMin(p.close);
      if (cd < 0 || !(cm >= 0 && cm <= DAY_MIN)) continue;
      // 放到一周的时间轴上量有多长；关 ≤ 开 = 跨过了「周日 → 周一」那条边
      const start = od * DAY_MIN + om;
      let end = cd * DAY_MIN + cm;
      if (end <= start) end += 7 * DAY_MIN;
      if (end - start <= DAY_MIN) {
        // 一天以内（含跨夜）：照写关门时刻，跨夜的 hours.js 自己认；关在半夜 12 点写成 24:00
        perDay[od].push([om, cm === 0 ? DAY_MIN : cm]);
        continue;
      }
      // 连着开好几天（例：周一 08:00 开到周三 20:00）：拆成每天一段
      for (let t = start; t < end;) {
        const d0 = Math.floor(t / DAY_MIN) * DAY_MIN, stop = Math.min(end, d0 + DAY_MIN);
        perDay[(d0 / DAY_MIN) % 7].push([t - d0, stop - d0]);
        t = stop;
      }
    }
  }
  const rows = rowsFrom(perDay, null);
  const hours = rows.length ? rows : null;
  const text = desc.length ? desc.join('\n') : hours ? describe(hours) : '谷歌上没写营业时间';
  return { hours, text, verified: !!hours };
}

// ======================= 高德 =======================
// business.opentime_week 是一句中文，写法很多：
//   「周一至周日 09:00-17:00」「周一至周五 08:30-17:30;周六周日 09:00-16:00」「00:00-24:00」「全天」「24小时营业」
//   「周一 休息;周二至周日 09:00-18:00」「10:00-22:00」「周一至周日 09:00-12:00,14:00-18:00」「周末 10:00-20:00」
//   「09:00-17:00(周一闭馆)」「周一至周日 09:00-17:00(16:30停止入场)」
// 办法：先切成一个个词（哪几天 / 几点到几点 / 休息 / 分隔），再按顺序拼成「哪几天 → 几点到几点」的组。
//   没说哪天的时段 = 每天；说了哪几天的，那几天以它为准（后说的算）；说了「休息」的那几天，最后清空。
// ★ 没提到的日子 = 不开（照字面）；整段话里有认不出的字 → 照样给 hours，但标「未核实」、界面给原文。

const CN_DAY = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, 七: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };

function normCn(s) {
  return s
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全角数字
    .replace(/：/g, ':').replace(/；/g, ';').replace(/[，、]/g, ',')
    .replace(/[（【［[]/g, '(').replace(/[）】］\]]/g, ')')
    .replace(/[—–－―‐‑−~～〜]/g, '-')                                                   // 各种横线、波浪线
    .replace(/\r\n?/g, '\n').replace(/[ \t 　]+/g, ' ')
    .trim();
}

// 顺序有讲究：先认「几点到几点」，再认「16:30 停止入场」这种注释，「无休」要在「休」前面认
const TOKENS = [
  ['time', /(\d{1,2}):(\d{2}) ?(?:-|至|到) ?(?:次日|翌日|第二天|凌晨)? ?(\d{1,2}):(\d{2})/y],
  ['note', /\d{1,2}:\d{2} ?(?:停止|截止)?(?:入场|入园|入馆|售票|检票|闭馆|闭园|关门|打烊|清场)/y],   // 最晚几点进 / 几点关，不是哪天关
  ['allday', /全天|24 ?小时|二十四小时|24h/iy],
  ['range', /(?:周|星期|礼拜)([一二三四五六日天七1-7]) ?(?:至|到|-) ?(?:周|星期|礼拜)?([一二三四五六日天七1-7])/y],
  ['day', /(?:周|星期|礼拜)([一二三四五六日天七]+|[1-7])/y],    // 「周六日」「周一三五」也认
  ['every', /每天|每日|天天|全周/y],
  ['weekday', /工作日|平日/y],
  ['weekend', /周末|双休日/y],
  ['ph', /法定节假日|法定假日|节假日|公众假期|节日|假日/y],
  ['note', /全年无休|无休|不休|营业时间|开放时间|营业|开放|时间|全年|照常|正常|均|每/y],
  ['closed', /休息|休业|休馆|闭馆|闭店|闭园|不营业|不开放|停业|关门|店休|公休|休/y],
  ['sep', /[;\n|。()]/y],
  ['list', /[,/&: 和及与·.]/y],
];

function daysOf(type, m) {
  if (type === 'every') return [0, 1, 2, 3, 4, 5, 6];
  if (type === 'weekday') return [0, 1, 2, 3, 4];
  if (type === 'weekend') return [5, 6];
  if (type === 'ph') return [];
  if (type === 'day') return [...m[1]].map(c => CN_DAY[c]);
  const a = CN_DAY[m[1]], b = CN_DAY[m[2]], out = [];                 // 区间；「周五至周一」会绕回来
  for (let d = a; ; d = (d + 1) % 7) { out.push(d); if (d === b) break; }
  return out;
}

function rangeOf(m) {
  const h1 = +m[1], m1 = +m[2], h2 = +m[3], m2 = +m[4];
  if (m1 > 59 || m2 > 59 || h1 > 24 || h2 > 48) return null;
  let o = h1 * 60 + m1, c = h2 * 60 + m2;
  if (o >= DAY_MIN) { if (o === DAY_MIN) o = 0; else return null; }   // 「24:00 开」= 0 点
  if (c > DAY_MIN) c -= DAY_MIN;          // 「26:00」= 次日 02:00
  if (c === 0) c = DAY_MIN;               // 「到 00:00」= 开到半夜 12 点
  return [o, c];
}

const DAY_TOKENS = new Set(['range', 'day', 'every', 'weekday', 'weekend', 'ph']);

// 认得出至少一个正常日子的时段 → { hours, clean }；一个都认不出 → null
function parseCn(raw) {
  const s = normCn(raw);
  const toks = [];
  let leftover = false;
  scan: for (let pos = 0; pos < s.length;) {
    for (const [type, re] of TOKENS) {
      re.lastIndex = pos;
      const m = re.exec(s);
      if (m) { toks.push({ type, m }); pos = re.lastIndex; continue scan; }
    }
    leftover = true;          // 认不出的字：跳过，整段标「未核实」
    pos++;
  }

  // 组 = { days: Set(0..6) | null（没说哪天 = 每天）, ph, ranges:[[开,关]], closed, done }
  const groups = [];
  let cur = null;
  const begin = days => { cur = { days, ph: false, ranges: [], closed: false, done: false }; groups.push(cur); };
  for (const { type, m } of toks) {
    if (DAY_TOKENS.has(type)) {
      // 前一组已经有时段 / 已经说完 → 这是新的一组；「周六周日」「周末及节假日」这种连着说的并进同一组
      if (!cur || cur.done || cur.days === null || cur.ranges.length) begin(new Set());
      if (type === 'ph') cur.ph = true;
      for (const d of daysOf(type, m)) cur.days.add(d);
    } else if (type === 'time' || type === 'allday') {
      const r = type === 'allday' ? [0, DAY_MIN] : rangeOf(m);
      if (!r) { leftover = true; continue; }
      if (!cur || cur.done) {
        // 没说哪天 = 其余每天。前面已经有「某几天几点」、又冒出一个没说哪天的：说法有歧义 → 标未核实
        if (groups.some(g => g.days && g.ranges.length)) leftover = true;
        begin(null);
      }
      cur.ranges.push(r);
    } else if (type === 'closed') {
      // 「休息」只认紧跟在「哪几天」后面的；「17:00 关门」那种不是说哪天休
      if (cur && !cur.done && cur.days && !cur.ranges.length) { cur.closed = true; cur.done = true; }
      else leftover = true;
    } else if (type === 'sep') {
      if (cur && (cur.ranges.length || cur.closed)) cur.done = true;
    }
    // list / note：不影响
  }

  const perDay = DAYS.map(() => null);
  let ph = null;
  for (const g of groups) if (g.days === null) for (let d = 0; d < 7; d++) perDay[d] = (perDay[d] || []).concat(g.ranges);
  for (const g of groups) if (g.days && g.ranges.length) {
    for (const d of g.days) perDay[d] = g.ranges.slice();                // 后说的算
    if (g.ph) ph = g.ranges.slice();
  }
  for (const g of groups) if (g.closed) for (const d of g.days) perDay[d] = [];
  // 「节假日休息」hours.js 写不出来（它只会「假日按 PH 那几行开」，没有「假日不开」）→ 照样给 hours，但标「未核实」，
  // 不然排行程时会把休息的假日当成照常开
  if (groups.some(g => g.closed && g.ph)) leftover = true;
  if (groups.some(g => g.days && !g.ranges.length && !g.closed)) leftover = true; // 说了哪几天、没说几点
  if (!perDay.some(rs => rs && rs.length)) return null;
  return { hours: rowsFrom(perDay, ph), clean: !leftover };
}

export function hoursFromAmap(opentimeWeek, opentimeToday) {
  const week = str(opentimeWeek), today = str(opentimeToday);
  if (week) {
    // 规格 14.4：一周的那句认不出 → hours = null、原文照给、标「未核实」（不拿当天那句去顶）
    const r = parseCn(week);
    return r ? { hours: r.hours, text: week, verified: r.clean } : { hours: null, text: week, verified: false };
  }
  if (today) {
    // 高德只给了查询当天的：按每天都这样算，但标「未核实」—— 别的天可能休息。
    // 当天那句是「休息」→ 认不出时段 → hours = null（不把「今天休息」推成每天休息，也不推成每天开）
    const r = parseCn(today);
    const text = `高德只给了查询当天的营业时间：${today}（别的天没核实）`;
    return { hours: r ? r.hours : null, text, verified: false };
  }
  return { hours: null, text: '高德上没写营业时间', verified: false };
}
