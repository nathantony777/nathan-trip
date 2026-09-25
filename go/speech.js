// 说话输入的规则层：一段口语 → 草稿 Draft（规格 15.3 / 15.4 / 15.9）。
// 纯函数：不碰界面、不联网、不看系统时间（今天由 ctx 给）；node 能测（测试/speech.test.mjs）。
//
// 目标不是「什么都听懂」，是「常见说法全对、不常见的进 unknown 而不是乱猜」。
// 硬规矩（15.3 句子守恒）：原文拆成小句后，每一小句要么在某条 entry.text 里、要么是 trip 的来源、
// 要么在 unknown 里、要么是香港清单那一行（hkList）。checkConservation 数这个，少一句就红。
//
// ★ 规格没写清、我自己定的（改之前先读 15.11，跟 Nathan 拍板的那几条对齐）：
//   1. 一句没日期 → 沿用上一句的；整段一个日期都没有 → date:null（15.11 第 4 条，待批）。
//   2. 「去 X」后面没有玩/吃/买这类动词、名字也看不出类型 → kind 记 sight，不记 other。
//      规格 15.4 写「其余 other」，但 15.9 第 2 条要求「去故宫」= sight；验收用例优先，这里跟用例。
//   3. 「逛 X」：X 像商圈（步行街/商场/免税店…或下面那张小商圈表里的名字）→ shop，否则 sight。
//      15.9 第 2 条「逛王府井」要 shop，王府井三个字看不出是商圈，所以有一张小表；那是知识不是规则，认不全没关系。
//   4. 「去酒店」「回酒店」这种只说了「酒店」没说哪家：同一句里有「住 XX 酒店」就并进那条 stay 的原话；
//      没有 → unknown「没说是哪家酒店」。不拿「酒店」两个字当地方名去搜。
//   5. 建趟（15.9 第 11 条「10月8日去深圳」→ trip）只在这趟还没有天（ctx.days 为空，也就是首页新建）时认：
//      整个小句只是「[日期][我][想/要]去 + 名字 [N天]」、后面没有任何玩/吃/买的动词，名字 ≤ 6 个字。
//      「国庆去香港三天」→ 香港 / hk，days 从 10-01 起连着 3 天；没说几天 = 1 天；没说日期 → days 空（不猜起点）。
//      已有天的趟里同样一句「10月9日去珠海」当一日游：珠海 sight。城市认不出也不报错，照样建趟，只是 region 不填。
//   6. 「三点」没说上下午：1～7 点当下午/晚上（+12），8 点起照字面。说了「下午/晚上」的按字面加 12。
//   7. 「早上」按「上午」那一档算（规格表里没有早上）。
//   8. 「下周X」= 下一个自然周（周一起算）里的 X；「周X / 星期X / 本周X / 这周X」= 今天之后最近的那个（今天是周四说「周四」= 下周四）。
//      规格 15.4 把下周X 也写成「今天之后最近的那个」，我按「下一个自然周」做——今天周四说「下周六」他多半不是指后天。★待批。
//   9. 「8号」没说月：本月；已过 → 下个月。
//  10. 「附近的 X」在第一条时 near 仍记 'prev'（原话就是这么说的），界面自己决定拿什么当参照。
//  11. 只说了时间/日期、没说去哪的小句：先挂着等下一条地方；同一句里在地方后面出现的「玩两个小时」并进上一条；
//      到最后都没等到地方 → unknown「只说了日期/时间，没说去哪」。
//  12. 含「～」（或半角 ~）的整行是香港清单（15.5），原样放进 draft.hkList，不再处理。
//  13. 「吃/喝/买/看 + 东西」没有店名时，东西本身当搜索关键词（「吃烤鸭」→ 烤鸭 food；「买水果」→ 水果 shop）；
//      「吃饭」「吃点好的」「逛街」这类泛词不算地方 → unknown「没听出要去哪」。
//  14. 节日年表只有 2026～2028；不在表里的年份 → unknown「年表里没有 XXXX 年的中秋」。
//  15. 「一整天」= 那天窗口全长：hk 7:15～23:30 = 975 分钟，其余 9:00～21:00 = 720 分钟（trip.js 的默认天）。
//  ── 0924 他说「把现在认不出的说法直接修」，加的这几条 ──
//  16. 日期段「10月8日到10日」「8号到10号」「8到10号」「10.8-10.10」：dates 是那几天的全集；建趟时就是那几天；
//      趟里说「8号到10号住万丽酒店」→ 那条挂在第一天，其余几天以空天的形状进 draft.days（界面上会显示「会加这一天」）。超过 60 天 → unknown。
//  17. 「去珠海玩两天」「住两晚」：entry.days = N，没说待多久就按一整天，后面 N-1 天同样以空天进 draft.days；
//      首页新建时「去香港玩三天」是建趟（有 N 天就是趟，不管名字认不认得）；「去香港玩」没说几天只在名字是认得的城市时建趟。
//  18. 「回酒店」「去酒店」没说哪家：这趟已经定了酒店（ctx.home = 酒店名）→ 一条 stay、name = 酒店名、ref:'home'（界面按这趟的酒店算，不另搜）；
//      没定酒店也没「住 XX 酒店」→ unknown，why 里写去哪定。「回家」一律 ref:'home'（行程本来就回口岸 / 酒店）。
//  19. 「吃完饭之后去海边」「到了之后先去酒店」：「…完 / 了 / 好…之后」不拆句、剥掉当引子；「吃完饭之后」单独一句 → unknown。
//  20. 时段加了傍晚 17～19、夜里 21～24、凌晨 5～7、早晨 = 上午（★待批，跟 15.11 第 3 条一起）。
//  21. 日期加了「下个月 8 号」「月底」「10 月底」「后天的后天」「周末」（= 最近的周六 ★待批）、圣诞 / 除夕 / 元宵；
//      「下个月」没说几号、农历「初一」「正月」 → unknown（写清为什么），不猜。
//  22. 名字里带动词字的地名（吃货街 / 看守所 / 玩具城）：动词在最前、后面那截像地名结尾又短（< 3 字）→ 整个当名字；
//      「去故宫和王府井」按「和 / 跟 / 还有」拆成两条（两边都 ≥ 2 字才拆，「和平饭店」不拆）；「去玩水上乐园」「坐缆车」东西本身当关键词。
//
// Draft 形状（15.3）+ 两个附加字段：hkList（香港清单原行）、tripText（建趟那句的原话，句子守恒要数它）。
// Entry 多两个可选字段：ref:'home'（第 18 条）、days:N（第 17 条）。

import { addDays, HK_DAY, OTHER_DAY } from './trip.js';

// ★待批（15.11 第 3 条）：时段 → 分钟
export const PERIODS = {
  上午: [9 * 60, 12 * 60],
  早上: [9 * 60, 12 * 60],     // 我定的：按上午算
  早晨: [9 * 60, 12 * 60],     // 同上
  中午: [11 * 60, 14 * 60],
  下午: [13 * 60, 18 * 60],
  傍晚: [17 * 60, 19 * 60],    // 我定的 ★待批
  晚上: [18 * 60, 22 * 60],
  夜里: [21 * 60, 24 * 60],    // 我定的 ★待批
  凌晨: [5 * 60, 7 * 60],      // 我定的：看日出那种 ★待批
};
const PERIOD_RE = '上午|早上|早晨|中午|下午|傍晚|晚上|夜里|凌晨';

// 节日年表（★年份多了要补；不在表里 → unknown，不猜）
export const HOLIDAYS = {
  国庆: { 2026: '10-01', 2027: '10-01', 2028: '10-01' },
  元旦: { 2026: '01-01', 2027: '01-01', 2028: '01-01' },
  劳动节: { 2026: '05-01', 2027: '05-01', 2028: '05-01' },
  五一: { 2026: '05-01', 2027: '05-01', 2028: '05-01' },
  春节: { 2026: '02-17', 2027: '02-06', 2028: '01-26' },
  清明: { 2026: '04-05', 2027: '04-05', 2028: '04-04' },
  端午: { 2026: '06-19', 2027: '06-09', 2028: '05-26' },
  中秋: { 2026: '09-25', 2027: '09-15', 2028: '10-03' },
  除夕: { 2026: '02-16', 2027: '02-05', 2028: '01-25' },   // = 春节前一天
  元宵: { 2026: '03-03', 2027: '02-20', 2028: '02-09' },   // = 春节 + 14
  圣诞: { 2026: '12-25', 2027: '12-25', 2028: '12-25' },
  平安夜: { 2026: '12-24', 2027: '12-24', 2028: '12-24' },
};
const HOLIDAY_RE = '国庆|中秋|元旦|春节|端午|清明|劳动节|五一|除夕|元宵|圣诞|平安夜';

// ---------------- 词表 ----------------

const NUM = '(\\d{1,2}|[一二两三四五六七八九十]{1,3})';
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function num(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return +s;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  if (s.length === 1 && s in CN) return CN[s];
  return null;
}

// 地方名后面碰到这些就截断（活动动词 / 口头填充）
const TERM = /(玩|逛|看|吃|喝|买|打卡|拍照|散步|休息|住|放|购物|转转|走走|溜达|坐|排队|听|待|呆|停留|一下|一趟|一次|一会)/;
// 活动动词 → kind
const ACT_KIND = { 吃: 'food', 喝: 'food', 买: 'shop', 购物: 'shop', 住: 'stay', 玩: 'sight', 看: 'sight', 打卡: 'sight', 拍照: 'sight', 散步: 'sight', 坐: 'sight', 听: 'sight', 逛: null };
// 像地名结尾的字（第 22 条只在这些结尾时把带动词字的整段当名字）
const NAME_END = /(街|所|站|场|馆|园|城|楼|店|寺|庙|路|巷|村|镇|湾|岛|山|湖|桥|塔|坊|中心|广场|市场|公园|乐园|码头|大厦|夜市)$/;
// 名字词尾 → kind（顺序要紧：酒店含「店」、饭店含「店」）
const SUFFIX = [
  ['stay', /(酒店|宾馆|民宿|旅馆|客栈|公寓)$/],
  ['food', /(餐厅|饭店|火锅|茶楼|茶餐厅|酒楼|咖啡|早茶|烧烤|大排档|小吃|面馆|粥|烤鸭|牛肉|海鲜|餐|菜)$/],
  ['shop', /(免税店|商场|超市|奥莱|步行街|购物中心|百货|市场|专卖店|商业街|广场|店|城)$/],
  ['sight', /(公园|景区|博物馆|海边|塔|山|湖|寺|庙|古镇|海滩|沙滩|港湾|乐园|动物园|植物园|美术馆|中心|故宫|大道|岛|桥|湾)$/],
];
// 小商圈表（知识，不是规则；只用来定 kind，认不全没关系）
const SHOP_NAMES = ['王府井', '南京路', '春熙路', '华强北', '东门', '铜锣湾', '海港城', '北京路', '上下九', '太古里', '万象城'];
// 大陆城市小表（只用来给建趟填 region:'cn'；认不出就不填）
const CN_CITIES = ['深圳', '广州', '珠海', '东莞', '佛山', '中山', '惠州', '汕头', '潮州', '湛江', '厦门', '福州', '泉州', '北京', '上海', '杭州', '南京', '苏州', '无锡', '宁波', '成都', '重庆', '西安', '长沙', '武汉', '桂林', '南宁', '三亚', '海口', '青岛', '济南', '天津', '昆明', '大理', '丽江', '贵阳', '太原', '郑州', '合肥', '南昌', '沈阳', '大连', '哈尔滨', '长春', '石家庄', '兰州', '西宁', '银川', '乌鲁木齐', '拉萨', '张家界', '黄山', '洛阳', '开封', '扬州', '威海', '烟台', '秦皇岛', '北海', '澳门'];
// 不算地方名的泛词
const GENERIC = /^(东西|饭|早饭|午饭|晚饭|早餐|午餐|晚餐|宵夜|夜宵|好|好的|好吃的|好玩的|好玩|街|一下|一圈|一会|会儿|行李|水|什么|电影票|门票|票)$/;
const GENERIC_STAY = /^(酒店|宾馆|民宿|旅馆|家)$/;

const PREFIX = /^(那|然后|接着|之后|最后|先|再|还想|还要|顺便|就|也|我们|咱们|我|想|要|打算|准备|得|可以|一起|到了|了|的|，|,|、|\s)+/;
const MUST_NOT = /(顺便|有空的话|有时间的话|如果有空|如果有时间|可去可不去|不一定去?|看情况|要是有空|有空就|有时间就|可能)/;

// ---------------- 拆句 ----------------

// 拆成小句，带在原文里的位置。先按 。！？；换行 拆句，再按 ，, 和 然后/再/接着/之后/最后/顺便/还想/还要 拆小句。
export function splitClauses(text) {
  const out = [];
  const sentRe = /[^。！？；!?;\n\r]+/g;
  let m, si = 0;
  while ((m = sentRe.exec(text))) {
    const s = m[0], base = m.index;
    const cutRe = /[，,]|(?=然后|接着|最后|顺便|还想|还要|再(?=去|到|逛|吃|喝|买|看|玩|住|在|坐|走|回))|(?<![完了好][^，,]{0,3})(?=之后|以后)/g;   // 「吃完饭之后」「到了之后」不在这儿拆（第 19 条）
    let cur = 0, c;
    const push = (a, b) => {
      const raw = s.slice(a, b);
      const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
      const t = raw.trim();
      if (t) out.push({ text: t, start: base + a + lead, end: base + b - trail, si });
    };
    while ((c = cutRe.exec(s))) {
      if (c.index > cur) push(cur, c.index);
      cur = c.index + c[0].length;
      if (c[0].length === 0) cutRe.lastIndex++;
    }
    push(cur, s.length);
    si++;
  }
  return out;
}
export const splitSentences = text => splitClauses(text).map(c => c.text);

// ---------------- 日期 ----------------

const ymd = s => s.split('-').map(Number);
const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = s => { const [y, m, d] = ymd(s); return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1; };   // 1=周一 … 7=周日
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

// 在一小句里找日期。返回 { token, date } / { token, why } / null。st = { today, days, prevDate }
function findDate(str, st) {
  const [ty, tm, td] = ymd(st.today);
  let m;
  // 一段日期 a～b → { token, date:a, dates:[…] }；第 16 条
  const range = (token, mo, d1, mo2, d2) => {
    if (mo == null || d1 == null || mo2 == null || d2 == null || !valid(ty, mo, d1) || !valid(ty, mo2, d2)) return { token, why: '日期看不懂' };
    let y = ty, a = fmt(y, mo, d1);
    if (a < st.today) { y++; a = fmt(y, mo, d1); }
    let b = fmt(y, mo2, d2);
    if (b < a) b = fmt(y + 1, mo2, d2);   // 12月30日到1月2日
    const n = Math.round((Date.UTC(...ymd(b).map((v, i) => i === 1 ? v - 1 : v)) - Date.UTC(...ymd(a).map((v, i) => i === 1 ? v - 1 : v))) / 86400000) + 1;
    if (n > 60) return { token, why: '这段日期超过 60 天，看不懂' };
    const dates = []; for (let i = 0; i < n; i++) dates.push(addDays(a, i));
    return { token, date: a, dates };
  };
  const SEP = '(?:到|至|-|—|~)';
  // 农历口语认不了 → 不猜
  if ((m = str.match(/(正月|腊月|冬月|农历|初[一二三四五六七八九十])(?![分点])/))) return { token: m[0], why: '农历日期认不了，说公历几号' };
  // 节日（+ 第N天 / 当天 / 那天）
  if ((m = str.match(new RegExp(`(${HOLIDAY_RE})节?(第${NUM}天|当天|那天)?`)))) {
    const table = HOLIDAYS[m[1]];
    let y = ty, md = table[y];
    if (md && fmt(y, ...md.split('-').map(Number)) < st.today) { y++; md = table[y]; }
    if (!md) return { token: m[0], why: `年表里没有 ${y} 年的${m[1]}` };
    const base = `${y}-${md}`;
    const off = m[3] ? num(m[3]) - 1 : 0;
    return { token: m[0], date: addDays(base, off) };
  }
  // 第N天 = 这趟的 days[N-1]
  if ((m = str.match(new RegExp(`第${NUM}天`)))) {
    const n = num(m[1]);
    if (!n || !st.days[n - 1]) return { token: m[0], why: `这趟没有第 ${n ?? m[1]} 天` };
    return { token: m[0], date: st.days[n - 1] };
  }
  // 10月8日到10日 / 10月8号到10月10号 / 10.8-10.10 / 8号到10号 / 8到10号
  if ((m = str.match(new RegExp(`${NUM}月${NUM}(?:日|号)?${SEP}(?:${NUM}月)?${NUM}(?:日|号)?`)))) return range(m[0], num(m[1]), num(m[2]), m[3] ? num(m[3]) : num(m[1]), num(m[4]));
  if ((m = str.match(/(?<![\d.])(\d{1,2})[./](\d{1,2})(?:到|至|-|—|~)(\d{1,2})[./](\d{1,2})(?![\d.:])/))) return range(m[0], +m[1], +m[2], +m[3], +m[4]);
  if ((m = str.match(new RegExp(`(?<![月\\d点])${NUM}(?:日|号)?${SEP}${NUM}(?:日|号)(?![\\d月线])`)))) {
    const d1 = num(m[1]);
    let mo = tm, y = ty;
    if (d1 != null && d1 < td) { mo++; if (mo > 12) { mo = 1; y++; } }
    if (d1 == null || !valid(y, mo, d1)) return { token: m[0], why: '日期看不懂' };
    const r = range(m[0], mo, d1, mo, num(m[2]));
    if (r.dates && y !== ty) r.dates = r.dates.map(d => d.replace(/^\d{4}/, String(y)));   // range 按今年算，跨年那种（12 月说「30 到 2 号」）少见，先不管
    return r;
  }
  // 10月8日 / 十月八号 / 10.8 / 10/8
  if ((m = str.match(new RegExp(`${NUM}月${NUM}(日|号)?`))) || (m = str.match(/(?<![\d.])(\d{1,2})[./](\d{1,2})(?![\d.:])/))) {
    const mo = num(m[1]), d = num(m[2]);
    if (mo == null || d == null || !valid(ty, mo, d)) return { token: m[0], why: '日期看不懂' };
    let date = fmt(ty, mo, d);
    if (date < st.today) date = fmt(ty + 1, mo, d);   // 已经过去 = 明年
    return { token: m[0], date };
  }
  // 下个月8号 / 下下个月8号 / 这个月8号
  if ((m = str.match(new RegExp(`(下下个?月|下个?月|这个?月|本月)${NUM}(日|号)`)))) {
    const d = num(m[2]);
    let mo = tm + (m[1].startsWith('下下') ? 2 : m[1].startsWith('下') ? 1 : 0), y = ty;
    while (mo > 12) { mo -= 12; y++; }
    if (!d || !valid(y, mo, d)) return { token: m[0], why: '日期看不懂' };
    return { token: m[0], date: fmt(y, mo, d) };
  }
  // 月底 / 10月底 / 下个月底
  if ((m = str.match(new RegExp(`(?:${NUM}月|下个?月|这个?月|本月|月)底`)))) {
    let mo = tm, y = ty;
    if (m[1]) mo = num(m[1]); else if (m[0].startsWith('下')) mo++;
    if (mo == null || mo > 12) { mo = mo == null ? null : mo - 12; y++; }
    if (mo == null || mo < 1) return { token: m[0], why: '日期看不懂' };
    let date = fmt(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate());
    if (date < st.today) { y++; date = fmt(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()); }
    return { token: m[0], date };
  }
  if ((m = str.match(/下下个?月|下个?月/))) return { token: m[0], why: '「下个月」没说几号' };
  // 8号 / 8日（没说月：本月，过了就下个月）；「3号线」不算
  if ((m = str.match(new RegExp(`(?<![月\\d])${NUM}(日|号)(?![\\d月线馆楼店房门口])`)))) {
    const d = num(m[1]);
    if (!d) return { token: m[0], why: '日期看不懂' };
    let y = ty, mo = tm;
    if (d < td) { mo++; if (mo > 12) { mo = 1; y++; } }
    if (!valid(y, mo, d)) return { token: m[0], why: '日期看不懂' };
    return { token: m[0], date: fmt(y, mo, d) };
  }
  // 今天 / 明天 / 后天 / 大后天
  if ((m = str.match(/后天的后天|大大后天|大后天|后天|明天|今天|今日/))) {
    const off = { 今天: 0, 今日: 0, 明天: 1, 后天: 2, 大后天: 3, 大大后天: 4, 后天的后天: 4 }[m[0]];
    return { token: m[0], date: addDays(st.today, off) };
  }
  // 周X / 星期X / 下周X
  if ((m = str.match(/(下下|下个?|本|这)?(周|星期|礼拜)([一二三四五六日天末])/))) {
    const t = m[3] === '末' ? 6 : WD[m[3]], cur = dow(st.today);   // 周末 = 那个周六（★待批）
    let date;
    if (m[1] && m[1].startsWith('下')) {
      const nextMon = addDays(st.today, 8 - cur);
      date = addDays(nextMon, t - 1 + (m[1] === '下下' ? 7 : 0));
    } else {
      const diff = (t - cur + 7) % 7 || 7;
      date = addDays(st.today, diff);
    }
    return { token: m[0], date };
  }
  // 那天 / 当天 = 上一句的日期
  if ((m = str.match(/那天|当天/))) {
    if (!st.prevDate) return { token: m[0], why: '「那天」前面没说过是哪天' };
    return { token: m[0], date: st.prevDate };
  }
  return null;
}

// ---------------- 时间 / 时长 ----------------

function clock(h, half, min, period) {
  let H = h;
  if (period && /下午|晚上|傍晚|夜里/.test(period) && H < 12) H += 12;
  else if (period && /上午|早上|早晨|凌晨/.test(period)) { /* 照字面 */ }
  else if (period === '中午' && H < 6) H += 12;
  else if (!period && H >= 1 && H <= 7) H += 12;   // 我定的：没说上下午，1～7 点当下午
  return H * 60 + (half ? 30 : (min || 0));
}

// 返回 { at, from, to, tokens:[] }
function findTime(str) {
  const r = { at: null, from: null, to: null, tokens: [] };
  const P = `(${PERIOD_RE})?`;
  let m;
  // X点到Y点
  if ((m = str.match(new RegExp(`${P}${NUM}点(半)?(?:到|至|—|-|~)${P}${NUM}点(半)?`)))) {
    r.from = clock(num(m[2]), m[3], 0, m[1]); r.to = clock(num(m[5]), m[6], 0, m[4] || m[1]);
    if (r.to < r.from) r.to += 12 * 60;
    r.tokens.push(m[0]); return r;
  }
  // 15:00
  if ((m = str.match(new RegExp(`(${PERIOD_RE})?(?<!\\d)(\\d{1,2}):(\\d{2})(?!\\d)`)))) {
    r.at = clock(+m[2], false, +m[3], m[1]); r.tokens.push(m[0]); return r;
  }
  // 三点 / 三点半 / 三点二十 / 三点的场；「一点东西」「早点」不算
  if ((m = str.match(new RegExp(`${P}${NUM}点(半|${NUM}分?)?钟?(的场|的票|场)?(?!东西|儿|小|多|心)`)))) {
    const extra = m[3] && m[3] !== '半' ? num(m[3].replace('分', '')) : 0;
    r.at = clock(num(m[2]), m[3] === '半', extra, m[1]); r.tokens.push(m[0]); return r;
  }
  // 上午 / 下午 …
  if ((m = str.match(new RegExp(PERIOD_RE)))) {
    [r.from, r.to] = PERIODS[m[0]]; r.tokens.push(m[0]); return r;
  }
  return r;
}

// 返回 { dur, token } 或 null
function findDur(str, region) {
  let m;
  if ((m = str.match(/一整天|整天|一天/))) return { dur: region === 'hk' ? HK_DAY.deadline - HK_DAY.startTime : OTHER_DAY.deadline - OTHER_DAY.startTime, token: m[0] };
  if ((m = str.match(/半天/))) return { dur: 240, token: m[0] };
  if ((m = str.match(/一(上午|下午|晚上)/))) return { dur: 180, token: m[0] };
  if ((m = str.match(/一个半小时|一个半钟头/))) return { dur: 90, token: m[0] };
  if ((m = str.match(/半个?小时|半个?钟头/))) return { dur: 30, token: m[0] };
  if ((m = str.match(new RegExp(`${NUM}个?半?(小时|钟头)`)))) { const n = num(m[1]); if (n) return { dur: n * 60 + (/半/.test(m[0]) ? 30 : 0), token: m[0] }; }
  if ((m = str.match(new RegExp(`${NUM}分钟`)))) { const n = num(m[1]); if (n) return { dur: n, token: m[0] }; }
  return null;
}

// ---------------- 地方 ----------------

const cleanName = s => s
  .replace(/^(的|了|一下|一家|家|一个|个|一顿|顿|一点|点|一些|些|完)+/, '')
  .replace(/(的|了|一下|一趟|儿|那边|那里|附近|去|吧|呢|啊)+$/, '')
  .trim();
const isName = s => s && !GENERIC.test(s) && !/^[\d日号一二两三四五六七八九十]+$/.test(s);

function kindOf(name, go, act) {
  if (act && ACT_KIND[act]) return ACT_KIND[act];
  for (const [k, re] of SUFFIX) if (re.test(name)) return k;
  if (SHOP_NAMES.some(n => name.includes(n))) return 'shop';
  if (go === '住') return 'stay';
  if (go || act === '逛') return 'sight';   // 我定的第 2 条：「去 X」默认 sight
  return 'other';
}

// 「去老街站附近喝早茶」→ near
function splitNear(rest) {
  const m = rest.match(/^(.*?)(附近|旁边|周边|周围)的?(.*)$/);
  if (!m) return { near: null, rest };
  const left = cleanName(m[1]);
  return { near: left ? left : 'prev', rest: m[3] };
}

// 从去掉了日期 / 时间 / 时长的残句里抠地方。返回 { name, kind, near, buy, generic } 或 null（没地方）
function extractPlace(residue) {
  let r = residue.replace(/^[^，,]{0,8}?[完了好][^，,]{0,3}(之后|以后)/, '').replace(PREFIX, '');   // 「吃完饭之后」「到了之后」是引子（第 19 条）
  let go = null, near = null, rest = r;
  const gm = r.match(/(?<![现正实所])(去|到|在|逛|住|回)(?!去|来|头|底)(.*)$/);
  if (gm) { go = gm[1]; rest = gm[2]; }
  ({ near, rest } = splitNear(rest));
  rest = rest.replace(PREFIX, '').replace(/^(一下|一趟|一次|一会儿?|下)+/, '');
  // 先看「去 X」的 X
  let name = '', act = null, obj = '';
  const t = rest.match(TERM);
  if (t) {
    const before = rest.slice(0, t.index), after = rest.slice(t.index + t[1].length);
    // 第 22 条：吃货街 / 看守所 / 玩具城 —— 动词字在最前、后面那截像地名结尾、又短得不像能独立成立的地名
    if (!before && /^[吃看玩喝]$/.test(t[1]) && after.length >= 2 && NAME_END.test(rest) && !(after.length >= 3 && SUFFIX.some(([, re]) => re.test(after)))) name = rest;
    else { name = before; act = t[1]; obj = after; }
  } else name = rest;
  if (GENERIC_STAY.test(name.trim())) return { generic: name.trim() };   // 「回家」的「家」会被 cleanName 剥掉，先判
  name = cleanName(name);
  if (GENERIC_STAY.test(name)) return { generic: name };
  if (!isName(name)) {
    // 「吃烤鸭」「买衣服」这种：东西本身当关键词
    if (!act) return null;
    const o = cleanName(obj);
    if (!isName(o) || !/^(吃|喝|买|看|玩|逛|坐|听)$/.test(act)) return null;
    return { name: o, kind: ACT_KIND[act] || 'sight', near, buy: act === '买' ? o.split(/[、和跟及]|以及/).map(cleanName).filter(isName) : [] };
  }
  const buy = act === '买' ? cleanName(obj).split(/[、和跟及]|以及/).map(cleanName).filter(isName) : [];
  if (!ACT_KIND.hasOwnProperty(act)) act = null;   // 「放」「休息」这类不定 kind
  return { name, kind: kindOf(name, go, act), near, buy };
}

// ---------------- 主函数 ----------------

// ctx = { today:'YYYY-MM-DD', days:['YYYY-MM-DD',…], region:'hk'|'cn'|'abroad' }
export function parseSpeech(text, ctx) {
  if (!ctx || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.today || '')) throw new Error('parseSpeech 要 ctx.today（YYYY-MM-DD）');
  const days = Array.isArray(ctx.days) ? ctx.days : [];
  const region = ctx.region || 'cn';
  const homeName = typeof ctx.home === 'string' && ctx.home.trim() ? ctx.home.trim() : null;   // 这趟已定的酒店名（第 18 条）
  const fullDay = region === 'hk' ? HK_DAY.deadline - HK_DAY.startTime : OTHER_DAY.deadline - OTHER_DAY.startTime;
  const src = String(text || '');
  const draft = { trip: {}, days: [], unknown: [], hkList: [], tripText: null };

  // 香港清单行（含「～」）原样放进 hkList，不再处理
  const hkRanges = [];
  const lineRe = /[^\n\r]+/g;
  let lm;
  while ((lm = lineRe.exec(src))) if (/[～~]/.test(lm[0])) { draft.hkList.push(lm[0].trim()); hkRanges.push([lm.index, lm.index + lm[0].length]); }

  const clauses = splitClauses(src).filter(c => !hkRanges.some(([a, b]) => c.start >= a && c.end <= b));
  const entries = [];           // { date, start, end, name, kind, near, dur, at, from, to, must, buy, si }
  let curDate = null;           // 当前沿用的日期（★待批第 4 条）
  let prevSentDate = null;      // 「那天」用
  let pending = null;           // 只说了时间 / 日期、还没等到地方的小句们
  let lastSi = -1;

  const applyMods = (e, mods) => {
    if (mods.at != null && e.at == null && e.from == null) e.at = mods.at;
    if (mods.from != null && e.at == null && e.from == null) { e.from = mods.from; e.to = mods.to; }
    if (mods.dur != null && e.dur == null) e.dur = mods.dur;
    if (mods.must === false) e.must = false;
  };
  const ensureDay = date => { if (typeof date === 'string' && !draft.days.some(d => d.date === date)) draft.days.push({ date, entries: [] }); };
  const flushPending = () => {   // 没等到地方 → unknown；「回酒店」而这趟定了酒店 → 一条 ref:'home'
    if (!pending) return;
    const homeRef = pending.genericStay && (pending.generic === '家' || homeName);
    if (homeRef) {
      const last = pending.clauses[pending.clauses.length - 1];
      const e = { date: pending.date, si: last.si, start: pending.start, end: last.end, name: pending.generic === '家' ? '家' : homeName, kind: 'stay', ref: 'home', near: null, dur: null, at: null, from: null, to: null, must: true, buy: [] };
      applyMods(e, pending.mods);
      entries.push(e);
    } else for (const c of pending.clauses) draft.unknown.push({ text: c.text, why: pending.genericStay ? '没说是哪家酒店，这趟也还没定酒店（「行程」页定了酒店，再说「回酒店」就认）' : '只说了日期/时间，没说去哪' });
    pending = null;
  };

  for (const c of clauses) {
    const newSentence = c.si !== lastSi;
    if (newSentence) { prevSentDate = curDate; }
    lastSi = c.si;
    let s = c.text;

    // 日期
    const dt = findDate(s, { today: ctx.today, days, prevDate: prevSentDate });
    if (dt) {
      s = s.replace(dt.token, '');
      if (dt.why) { flushPending(); draft.unknown.push({ text: c.text, why: dt.why }); curDate = { bad: dt.why }; continue; }
      curDate = dt.date;
    } else if (curDate && curDate.bad && newSentence) curDate = null;   // 「第三天」那句坏掉的日期只坏那一句
    if (curDate && curDate.bad) { draft.unknown.push({ text: c.text, why: curDate.bad }); continue; }

    // 建趟（我定的第 5 条）：首页新建（还没有天）+ 整句只是「去 + 名字 [N天]」。要在剥时长之前判，「一天」不是待多久
    if (!days.length && !entries.length && !draft.tripText) {
      const bare = s.trim().replace(PREFIX, '').match(new RegExp(`^(去|到)(.{1,6}?)(玩|待|呆|住|旅游|旅行|度假)?(?:个?${NUM}(?:天|晚))?$`));
      const name = bare ? cleanName(bare[2]) : '';
      const known = name === '香港' || CN_CITIES.includes(name);
      // 「去X」「去X三天」「去X玩三天」都是建趟；「去X玩」没说几天只认认得的城市（不然「去深圳人才公园玩」也成了趟）
      if (bare && name && !/[玩逛看吃喝买住]/.test(name) && !/[\d一二两三四五六七八九十]+[天晚]$/.test(name) && (!bare[3] || bare[4] || known)) {
        draft.trip = { name, city: name };
        if (name === '香港') draft.trip.region = 'hk';
        else if (CN_CITIES.includes(name) && name !== '澳门') draft.trip.region = 'cn';
        draft.tripText = c.text;
        if (dt && dt.dates) for (const d of dt.dates) ensureDay(d);
        else { const n = bare[4] ? num(bare[4]) : 1; if (curDate && n) for (let i = 0; i < n; i++) ensureDay(addDays(curDate, i)); }
        pending = null;
        continue;
      }
    }
    if (dt && dt.dates) for (const d of dt.dates) ensureDay(d);   // 趟里说了一段日期：那几天都要有

    // 「去珠海玩两天」「住两晚」（第 17 条）：先把 N 天摘出来，别让「一天」被当成待多久
    let nDays = null;
    const nd = s.match(new RegExp(`(玩|待|呆|住|逛|停留|旅游)个?${NUM}(天|晚)`));
    if (nd && num(nd[2])) { nDays = num(nd[2]); s = s.replace(nd[0], nd[1]); }
    // 时间 / 时长 / 顺便
    const tm = findTime(s); for (const t of tm.tokens) s = s.replace(t, '');
    const du = findDur(s, region); if (du) s = s.replace(du.token, '');
    let must = true; const mm = s.match(MUST_NOT); if (mm) { must = false; s = s.replace(mm[0], ''); }
    const mods = { at: tm.at, from: tm.from, to: tm.to, dur: du ? du.dur : null, must };

    const place = extractPlace(s);
    const residue = s.replace(PREFIX, '').replace(/(去|到|玩|逛|看看|一下|了|的|吧|呢|再|就|也|走|出发|回来|回去|好|啊|嗯|然后)/g, '').trim();

    if (place && place.name) {
      // 「去故宫和王府井」→ 两条（第 22 条）；两边都 ≥ 2 字才拆，「和平饭店」不拆
      const parts = place.name.split(/和|跟|还有|以及/).map(cleanName);
      const names = parts.length > 1 && parts.every(p => p.length >= 2 && isName(p)) ? parts : [place.name];
      names.forEach((nm, idx) => {
        const e = { date: curDate, si: c.si, start: c.start, end: c.end, name: nm, kind: names.length > 1 ? kindOf(nm, '去', null) : place.kind, near: place.near, dur: null, at: null, from: null, to: null, must: true, buy: idx === 0 ? place.buy : [] };
        applyMods(e, mods);
        if (pending && idx === 0) {
          if (pending.genericStay && e.kind !== 'stay') flushPending();
          else { applyMods(e, pending.mods); e.start = pending.start; pending = null; }
        }
        if (nDays && idx === 0) {
          e.days = nDays;
          if (e.dur == null) e.dur = fullDay;
          if (typeof curDate === 'string') for (let i = 0; i < nDays; i++) ensureDay(addDays(curDate, i));
        }
        entries.push(e);
      });
      continue;
    }

    const prev = entries.length ? entries[entries.length - 1] : null;
    const hasMod = mods.at != null || mods.from != null || mods.dur != null || !must || !!dt;
    const generic = place && place.generic;

    if (generic) {
      // 「去酒店放行李」「回酒店」：同一句里前面有 stay 就并进去，否则挂着等后面的「住 XX 酒店」
      if (prev && prev.si === c.si && prev.kind === 'stay') { applyMods(prev, mods); prev.end = c.end; continue; }
      const P = pending || { start: c.start, clauses: [], mods: {}, genericStay: false, date: curDate };
      P.clauses.push(c); P.genericStay = true; P.generic = generic;
      for (const k of ['at', 'from', 'to', 'dur']) if (mods[k] != null) P.mods[k] = mods[k];
      if (!must) P.mods.must = false;
      pending = P;
      continue;
    }
    if (hasMod && !residue) {
      // 只说了时间 / 时长 / 顺便：时长和「顺便」并进上一条（同一句），时间挂着等下一条
      if (prev && prev.si === c.si && !pending && mods.at == null && mods.from == null && !dt) { applyMods(prev, mods); prev.end = c.end; continue; }
      const P = pending || { start: c.start, clauses: [], mods: {}, genericStay: false, date: curDate };
      P.clauses.push(c); P.date = curDate;
      for (const k of ['at', 'from', 'to', 'dur']) if (mods[k] != null) P.mods[k] = mods[k];
      if (!must) P.mods.must = false;
      pending = P;
      continue;
    }
    // 什么都没听出来
    flushPending();
    draft.unknown.push({ text: c.text, why: generic ? '没说是哪家酒店，这趟也还没定酒店（「行程」页定了酒店，再说「回酒店」就认）' : '没听出要去哪' });
  }
  // 段尾还挂着的：同一句里前面有地方就并进去，否则 unknown
  if (pending) {
    const prev = entries.length ? entries[entries.length - 1] : null;
    const sameSent = prev && pending.clauses.every(pc => pc.si === prev.si);
    if (sameSent && (!pending.genericStay || prev.kind === 'stay')) { applyMods(prev, pending.mods); prev.end = pending.clauses[pending.clauses.length - 1].end; pending = null; }
    else flushPending();
  }

  // 按天归堆：有日期的按日期排，没日期的排最后
  const byDate = new Map();
  for (const e of entries) {
    const key = e.date == null ? '' : e.date;
    if (!byDate.has(key)) byDate.set(key, []);
    const o = {
      text: src.slice(e.start, e.end).trim(), name: e.name, kind: e.kind, near: e.near,
      dur: e.dur, at: e.at, from: e.from, to: e.to, must: e.must, buy: e.buy,
    };
    if (e.ref) o.ref = e.ref;
    if (e.days) o.days = e.days;
    byDate.get(key).push(o);
  }
  for (const d of draft.days) if (byDate.has(d.date)) { d.entries = byDate.get(d.date); byDate.delete(d.date); }
  for (const key of [...byDate.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1))) draft.days.push({ date: key || null, entries: byDate.get(key) });
  draft.days.sort((a, b) => (a.date == null ? 1 : b.date == null ? -1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return draft;
}

// 句子守恒（15.3）：每一小句都得落在 entry.text / tripText / unknown / hkList 之一。
export function checkConservation(text, draft) {
  const homes = [];
  for (const d of draft.days || []) for (const e of d.entries || []) homes.push(e.text);
  for (const u of draft.unknown || []) homes.push(u.text);
  for (const h of draft.hkList || []) homes.push(h);
  if (draft.tripText) homes.push(draft.tripText);
  const missing = splitSentences(text).filter(c => !homes.some(h => typeof h === 'string' && h.includes(c)));
  return { ok: missing.length === 0, missing };
}
