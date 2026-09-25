// 营业时间：数据里的 [{days:'Mo-Fr', open:'10:00', close:'21:00'}] → 某一天的 [[开,关],...]（分钟）。
// days 写法：Mo Tu We Th Fr Sa Su，区间用 -，并列用逗号，PH = 公众假期。跟 工具/build_data.py 的 check_days 同一套。
// ★ 公众假期那天：写了 PH 的那几行优先；一行 PH 都没有，就按星期几算（多数店假期照常开）。
// ★ 关门早于开门 = 开过午夜（惠康有开到 01:00 的）。

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export const DEFAULT_HOURS = [[600, 1200]]; // 没查到营业时间的，按 10:00–20:00 算，界面标「未核实」

function toMin(s) {
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) throw new Error(`认不出时间写法：${s}（要写成 10:00 这种）`);   // ★ 原来是 TypeError「reading '1'」，谁也看不懂
  return Number(m[1]) * 60 + Number(m[2]);
}

function covers(daysStr, dow, isPH) {
  let ph = false, day = false;
  for (const tok of daysStr.split(',').map(x => x.trim())) {
    if (tok === 'PH') { ph = true; continue; }
    const [a, b] = tok.split('-');
    const i = DAYS.indexOf(a), j = b ? DAYS.indexOf(b) : i;
    if (i < 0 || j < 0) throw new Error(`认不出星期写法：${daysStr}`);
    if (i <= j ? (dow >= i && dow <= j) : (dow >= i || dow <= j)) day = true;
  }
  return { ph, day };
}

// dow：0=周一 … 6=周日
export function openOn(hours, dow, isPH = false) {
  if (!hours || !hours.length) return { open: DEFAULT_HOURS, verified: false };
  let rows = hours;
  if (isPH && hours.some(h => covers(h.days, dow, true).ph)) rows = hours.filter(h => covers(h.days, dow, true).ph);
  else rows = hours.filter(h => covers(h.days, dow, false).day);
  const open = rows.map(h => {
    const o = toMin(h.open);
    let c = toMin(h.close);
    if (c <= o) c += 24 * 60;
    return [o, c];
  }).sort((a, b) => a[0] - b[0]);
  // 合并重叠的
  const merged = [];
  for (const iv of open) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  }
  return { open: merged, verified: true };
}

// JS Date → 0=周一
export function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// 香港公众假期（只列 V1 用得到的；9/25 中秋正日不是假期，9/26 中秋翌日才是）
export const HK_PH_2026 = new Set(['2026-09-26', '2026-10-01', '2026-10-19', '2026-12-25', '2026-12-26']);
