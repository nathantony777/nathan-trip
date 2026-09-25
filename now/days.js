// 分天（规格 14.6）：一趟好几天 + 一堆想去的地方 → 每个地方分到哪一天，每天再用 engine.planRoute 排路线。
// 纯函数：不碰界面、不碰存储、不碰网络；只 import engine.js / hours.js / geo.js。电脑上 node 能直接测：
//   node 测试/days.test.mjs（150 个随机小例子跟「逐个试遍所有分法」对答案）。
//
// ★ 每个地方 = 一组 + 一家「店」：id 都是 'place:' + 地方 id；待的时间 = dur + walk；分数 必去 100 / 想去 1。
// ★ 目标（规格 14.6，字典序，三层）：
//   ① 各天分数加起来最多（香港时要买的东西的分一并算）；
//   ② 同分 → 最晚回到终点的那一天最早（late = 各天 finish 的最大值）；
//   ③ 还同 → 各天回到终点的时刻加起来最早（finish = 各天 finish 之和）。
//   回不到终点的那天（引擎说 cannotReturn）按 0 分、按那天的最晚时刻算，那天分到的地方全算没排进去。
//   ★ 第 ② 层是 0923 深夜加的（原来只有 ①③）。只有 ①③ 时地方会往前面几天挤：每多一天有地方，就多一趟
//     「酒店出发、回酒店」，回程加起来就晚 —— 实测 6 个地方 × 3 天（每天 9:00–21:00）排成 6 / 0 / 0，
//     第一天 20 点多才回、后两天没出门；9 个 → 5 / 4 / 0。分数没错，但没人这么旅游。
//     加了 ② 之后各天匀开（最累的那天尽量轻），③ 只在最累那天一样时才起作用。这是我（主 agent）定的，Nathan 没拍板；
//     他要是想要「尽量挤在前面、留一天空着」，把 better() 里第 ② 层删掉就回到原来的。
// ★ 一个都不许丢：传进来的每个地方，要么在某一天的 placeIds 里（排进去了），要么在 unplaced 里（带人话理由）。
//   出结果之前逐个核一遍，对不上直接抛错，不许交出一份悄悄少了地方的行程。
// ★ 香港的「买东西」（day.shopping）：按天的顺序排，第 k 天能买的 = 这天给的组里、前面几天没买到的。
//   所以动了第 k 天，第 k+1… 天都要重排（它们能买的变了）。没有 shopping 时这一段完全不起作用。
//   ★ 所以某一天 result.dropped 里的「要买的东西」可能在后面某天买到了 —— 界面别拿单天的 dropped 当「买不到」，
//     看 shoppingUnplaced（整趟都没买到的）。
//
// 两种算法（opts.method）：
//   exhaustive 穷举：每个地方能去的那几天，所有组合逐个试遍。同一个（哪天, 那天哪几个地方[, 那天还剩哪些要买的]）
//     只排一次、记住结果。结果就是最优 —— 前提是每天的 planRoute 自己是精确的（result.exact）。
//   heuristic 近似：规格 14.6 的 ①②③④ —— 定死的先放 → 每天一个种子、按远近分 → 每天排 →
//     挪 / 换，一直到时间用完（默认 1.5 秒）或者再也挪不出更好的；
//     再加一步规格里没有的 ⑤：还有地方没排进去、时间也还有，就「打乱再爬」（为什么见 runHeuristic 里 ⑤ 那段）。
//   auto：分法 ≤ AUTO.maxCombos 且 地方 ≤ AUTO.maxPlaces 且 没有要买的东西 → 穷举；
//     每个地方都只有一天能去（分法 = 1，只算一遍）→ 穷举；其余 → 近似。
//   ★ 两条线是 0923 在这台 Mac（M4、node 26）上量出来的（测试/days.test.mjs ⑩ 每次跑都重量一遍并打印）：
//     - 地方 ≤ 9：不是凭感觉。引擎每一层最多留 1000 个中间状态（engine.js beamWidth），一天 9 个地方最宽的一层
//       是 C(9,5)×5 = 630 个，永远不砍 → 每天都精确；10 个是 C(10,5)×5 = 1260，会砍 → 实测 10 个地方的穷举报「不精确」。
//     - 分法 ≤ 100,000（原定 20,000，量完放宽）。最坏情况（地方每天都能去、每天 8:00–23:00）量了三遍：
//         9 个 × 3 天 =  19,683 种  110–160 ms      8 个 × 4 天 = 65,536 种  约 80 ms
//         7 个 × 5 天 =  78,125 种  约 70 ms        5 个 × 10 天 = 100,000 种  约 100 ms
//         9 个 × 4 天、其中 4 个周一不开 = 82,944 种  150–190 ms   ← auto 走得到的最重的一种
//         9 个 × 4 天全都能去 = 262,144 种  约 275 ms（过线了，auto 走近似）
//       手机按慢 2~3 倍估，auto 走穷举最坏约 0.5 秒，比近似的时间预算（1.5 秒）还短。

import { planRoute, hm } from './engine.js';
import { openOn, dowOf, DEFAULT_HOURS } from './hours.js';
import { haversineM } from './geo.js';

export const DAY_MAX = 30;           // 引擎一次最多算 30 组（engine.js solve 里的上限）；一天的地方 + 要买的东西合起来算
export const AUTO = { maxCombos: 100000, maxPlaces: 9 };  // 怎么量的见文件头
const HARD_MAX_COMBOS = 300000;      // 明着要穷举、组合又多过这个数：直接报错（逐个试遍会把手机卡死）
const SLACK = 20;                    // 初分时每个地方另算 20 分钟路上（规格 14.6 ②）
const KICKS = 40;                    // 近似 ⑤：连着打乱这么多次都没更好，就停
const EPS = 1e-6;

const num = (v, d = 0) => { if (v == null || v === '') return d; const x = Number(v); return isFinite(x) ? x : d; };

// 'YYYY-MM-DD' → 「10 月 3 日」
function mdText(date) {
  const m = String(date || '').match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  return m ? `${Number(m[1])} 月 ${Number(m[2])} 日` : String(date);
}

// ---------- 某个地方某一天几点到几点能去 ----------

// 营业时间 → 当天窗口；写法认不出不让整趟排不了，按「未核实」的 10:00–20:00 算，并在 text 里说出来
function rawHours(place, date, isPH) {
  try {
    return { ...openOn(place.hours, dowOf(date), isPH), bad: null };
  } catch (e) {
    return { open: DEFAULT_HOURS, verified: false, bad: e.message };
  }
}

function rangeText(from, to) {
  if (from != null && to != null) return `${hm(from)}–${hm(to)}`;
  if (from != null) return `${hm(from)} 以后`;
  return `${hm(to)} 以前`;
}

// 返回 { open:[[开,关]], verified, text, closed:'closed'|'outside'|null, atOutsideHours? }
// closed：open 为空时是哪种空 —— 'closed' 这天不开门；'outside' 开门的时间跟他定的几点到几点对不上。
function windowInfo(place, date, isPH) {
  const dur = num(place.dur), walk = num(place.walk);
  const raw = rawHours(place, date, isPH);
  const badNote = raw.bad ? `（营业时间写法认不出，按 10:00–20:00 算：${raw.bad}）` : '';
  const at = num(place.at, null);
  if (at != null) {
    // 定了开始时刻（买好票的场次）：只能那个时刻开始。
    // ★ walk 是「从站走过去再走回来」（香港「在某站附近」的地方；别处都是 0），引擎把它算在待的时间里、
    //   从到站那一刻算起 → 窗口两头各留 walk/2，这样人正好 at 那一刻到场（walk=0 时就是 [at, at+dur]）。
    //   原样写 [at, at+dur] 的话，walk>0 的地方窗口比要待的时间短，永远排不进去、理由还是假的。
    const inHours = raw.open.some(([o, c]) => at >= o - EPS && at + dur <= c + EPS);
    const atOutsideHours = raw.verified && !inHours;   // 营业时间没核实的不报（报了也是拿 10–20 点瞎比）
    return {
      open: [[at - walk / 2, at + dur + walk / 2]], verified: raw.verified, closed: null, atOutsideHours,
      text: `定在 ${hm(at)} 开始` + (atOutsideHours ? '（这个时刻不在营业时间里，按你定的算）' : '') + badNote,
    };
  }
  const from = num(place.from, null), to = num(place.to, null);
  const lo = from ?? 0, hi = to ?? 26 * 60;
  const open = [];
  for (const [o, c] of raw.open) {
    const a = Math.max(o, lo), b = Math.min(c, hi);
    if (b > a) open.push([a, b]);
  }
  let text, closed = null;
  if (open.length) text = open.map(([o, c]) => `${hm(o)}–${hm(c)}`).join('、');
  else if (!raw.open.length) { text = '这天不开门'; closed = 'closed'; }
  else { text = `这天开门的时间跟你定的 ${rangeText(from, to)} 对不上`; closed = 'outside'; }
  return { open, verified: raw.verified, text: text + badNote, closed };
}

// 给界面用：某个地方某天的窗口。text 就是「当天营业」那一行（显示的是算法用的窗口，跟排出来的时刻对得上）；
// 定了 at 的多一个 atOutsideHours（那个时刻店不开门 → 界面另标，算法照样按 at 排）。
export function placeWindow(place, date, isPH = false) {
  const w = windowInfo(place, date, isPH);
  const out = { open: w.open, verified: w.verified, text: w.text };
  if ('atOutsideHours' in w) out.atOutsideHours = w.atOutsideHours;
  return out;
}

// ---------- 主入口 ----------

export function planDays(input, opts = {}) {
  const tStart = Date.now();
  const days = (input && input.days) || [];
  const places = (input && input.places) || [];
  const want = opts.method || 'auto';
  if (!['auto', 'exhaustive', 'heuristic'].includes(want)) throw new Error(`认不出的算法：${want}`);
  const budgetMs = num(opts.timeBudgetMs, 1500);
  if (!days.length) throw new Error('行程里一天都没有，先加一天');

  // 日子自己的检查（错了就报出来，不带着错往下算）
  const dateIdx = new Map();
  days.forEach((d, i) => {
    if (dateIdx.has(d.date)) throw new Error(`行程里 ${mdText(d.date)}出现了两次`);
    dateIdx.set(d.date, i);
    if (!(d.deadline > d.t0)) throw new Error(`${mdText(d.date)}最晚回来的时间（${hm(d.deadline)}）早于出发时间（${hm(d.t0)}）`);
    if (!d.travel || typeof d.travel.between !== 'function') throw new Error(`${mdText(d.date)}没有路程数据`);
  });

  // 每个地方：哪几天能去、那几天的窗口；一天都去不了的当场记进 unplaced
  const unplaced = [];
  const E = [];
  const seenIds = new Set();
  for (const p of places) {
    if (seenIds.has(p.id)) throw new Error(`地方的编号重复了：${p.id}（${p.name}）`);
    seenIds.add(p.id);
    const miss = text => unplaced.push({ placeId: p.id, name: p.name, text });
    if (p.lat == null || p.lng == null || p.lat === '' || p.lng === '' || !isFinite(Number(p.lat)) || !isFinite(Number(p.lng))) { miss('没有位置（缺坐标）'); continue; }
    const wins = days.map(d => windowInfo(p, d.date, !!d.isPH));
    let feas;
    if (p.day) {
      const d = dateIdx.get(p.day);
      if (d === undefined) { miss(`指定的 ${mdText(p.day)}不在行程里`); continue; }
      if (!wins[d].open.length) {
        miss(wins[d].closed === 'closed' ? `指定的 ${mdText(p.day)}不开门` : `指定的 ${mdText(p.day)}${wins[d].text.replace(/^这天/, '')}`);
        continue;
      }
      feas = [d];
    } else {
      feas = days.map((_, d) => d).filter(d => wins[d].open.length);
      if (!feas.length) {
        if (wins.every(w => w.closed === 'closed')) miss('这几天都不开门');
        else if (wins.every(w => w.closed === 'outside')) miss(`这几天开门的时间都跟你定的 ${rangeText(num(p.from, null), num(p.to, null))} 对不上`);
        else miss(`这几天要么不开门，要么开门的时间跟你定的 ${rangeText(num(p.from, null), num(p.to, null))} 对不上`);
        continue;
      }
    }
    E.push({
      place: p, id: p.id, gid: 'place:' + p.id, lat: Number(p.lat), lng: Number(p.lng),
      need: num(p.dur) + num(p.walk), value: p.must !== false ? 100 : 1,
      wins, feas, fixed: !!p.day,
    });
  }

  // 只能去某一天的（指定了日子，或者只有那天开门）先数一遍：一天超过 30 个就报错让他减
  const forced = days.map(() => 0);
  for (const e of E) if (e.feas.length === 1) forced[e.feas[0]]++;
  forced.forEach((n, d) => { if (n > DAY_MAX) throw new Error(overflowText(days, { d, nPlaces: n, nShop: 0 })); });

  // 挑算法
  let combos = 1;
  for (const e of E) { combos *= e.feas.length; if (combos > 1e12) break; }
  const hasShopping = days.some(d => d.shopping && d.shopping.groups && d.shopping.groups.length);
  let method = want;
  if (want === 'auto') {
    method = combos === 1 || (!hasShopping && combos <= AUTO.maxCombos && E.length <= AUTO.maxPlaces) ? 'exhaustive' : 'heuristic';
  }
  if (method === 'exhaustive' && combos > HARD_MAX_COMBOS) {
    throw new Error(`要试的分法有 ${combos > 1e12 ? '上万亿' : combos} 种，逐个试遍会卡住；换近似（method: 'heuristic'）`);
  }

  const ev = makeEvaluator(days, E, opts.engine);
  const best = method === 'exhaustive' ? runExhaustive(days, E, ev) : runHeuristic(days, E, ev, tStart + budgetMs);

  return present(days, places, E, best, unplaced, method, tStart, ev.allExact());
}

// ---------- 算一种分法：每天排一遍，记住排过的 ----------

function makeEvaluator(days, E, engineOpts) {
  const memo = new Map();
  const D = days.length;
  let allExact = true;   // 排过的每一天都精确？穷举「最优」靠的是【试过的每一种】都算对了，不只是挑中的那几天

  // 第 d 天、这几个地方（E 的下标，从小到大）、还剩这些要买的组 → 那天的排法
  function dayPlan(d, list, shop) {
    const key = d + '|' + list.join(',') + (shop ? '|' + shop.map(g => g.id).join('\u0001') : '');
    const hit = memo.get(key);
    if (hit) return hit;
    const day = days[d];
    const stores = [], groups = [], ids = new Set();
    for (const i of list) {
      const e = E[i];
      stores.push({ id: e.gid, name: e.place.name, lat: e.lat, lng: e.lng, open: e.wins[d].open, base: e.need, queue: 0 });
      ids.add(e.gid);
      groups.push({ id: e.gid, label: e.place.name, stores: [e.gid], items: 0, value: e.value });
    }
    if (shop && shop.length) {
      // 要买的东西挂在某个地方上时，那家店的 id 也是 'place:…'：同一天里以这边算的窗口为准，不重复加
      for (const s of day.shopping.stores || []) if (!ids.has(s.id)) stores.push(s);
      groups.push(...shop);
    }
    const problem = { t0: day.t0, deadline: day.deadline, start: day.start, end: day.end, stores, groups };
    const result = planRoute(problem, day.travel, engineOpts);
    const ok = result.status !== 'cannotReturn';
    const r = { problem, result, ok, value: ok ? result.value : 0, finish: ok ? result.finish : day.deadline, covered: new Set(ok ? result.covered : []) };
    if (result.exact !== true) allExact = false;
    memo.set(key, r);
    return r;
  }

  // assign[i] = 第几天（-1 = 没分）。返回 { ok:true, value, finish, days:[每天的 dayPlan] }；
  // 某天超过 30 组 → { ok:false, d, nPlaces, nShop }（这种分法不许用）
  function evaluate(assign) {
    const per = Array.from({ length: D }, () => []);
    for (let i = 0; i < assign.length; i++) if (assign[i] >= 0) per[assign[i]].push(i);
    const bought = new Set();
    let value = 0, finish = 0, late = 0;
    const out = new Array(D);
    for (let d = 0; d < D; d++) {
      const sp = days[d].shopping;
      const shop = sp && sp.groups && sp.groups.length ? sp.groups.filter(g => !bought.has(g.id)) : null;
      const nShop = shop ? shop.length : 0;
      if (per[d].length + nShop > DAY_MAX) return { ok: false, d, nPlaces: per[d].length, nShop };
      const r = dayPlan(d, per[d], shop);
      value += r.value; finish += r.finish; late = Math.max(late, r.finish);
      if (shop) for (const g of shop) if (r.covered.has(g.id)) bought.add(g.id);
      out[d] = r;
    }
    return { ok: true, value, finish, late, days: out };
  }

  return { evaluate, routes: () => memo.size, allExact: () => allExact };
}

// 两种分法谁好（文件头「目标」那三层）：分数多 → 最晚回来的那天早 → 各天回来的时刻加起来早
function better(a, b) {
  if (a.value !== b.value) return a.value > b.value;
  if (Math.abs(a.late - b.late) > EPS) return a.late < b.late;
  return a.finish < b.finish - EPS;
}

function overflowText(days, bad) {
  const md = mdText(days[bad.d].date);
  if (!bad.nShop) return `${md}要去 ${bad.nPlaces} 个地方，一天最多 ${DAY_MAX} 个，减几个`;
  return `${md}要去 ${bad.nPlaces} 个地方、另有 ${bad.nShop} 组要买的东西，合起来 ${bad.nPlaces + bad.nShop} 组，一天最多 ${DAY_MAX} 组，减几个`;
}

// ---------- 穷举 ----------
// 每个地方在它能去的那几天里挑一天，所有组合逐个算（像里程表一样一格一格进位）；同分取先遇到的。
// 花多久：见文件头 auto 那段的实测数。
function runExhaustive(days, E, ev) {
  const n = E.length;
  const idx = new Array(n).fill(0), assign = new Array(n);
  let best = null, bad = null;
  for (;;) {
    for (let i = 0; i < n; i++) assign[i] = E[i].feas[idx[i]];
    const r = ev.evaluate(assign);
    if (r.ok) { if (!best || better(r, best)) best = { ...r, assign: assign.slice() }; }
    else if (!bad) bad = r;
    let k = 0;
    while (k < n && ++idx[k] === E[k].feas.length) { idx[k] = 0; k++; }
    if (k === n) break;
  }
  if (!best) throw new Error(overflowText(days, bad));
  return best;
}

// ---------- 近似（规格 14.6 ①②③④） ----------

function runHeuristic(days, E, ev, deadlineMs) {
  const D = days.length, n = E.length;
  const assign = new Array(n).fill(-1);
  const shopN = days.map(d => (d.shopping && d.shopping.groups ? d.shopping.groups.length : 0));
  const count = days.map(() => 0), load = days.map(() => 0);
  // 连直接回终点都赶不上的天：初分时不往那儿放（挪的时候还能试）
  const cap = days.map(d => (d.t0 + d.travel.toEnd(d.start, d.t0) > d.deadline ? 0 : d.deadline - d.t0));
  const put = (i, d) => { assign[i] = d; count[d]++; load[d] += E[i].need + SLACK; };
  // ★ 30 组上限初分时按「这天给的要买的东西全都还在」算（保守）；之后挪的时候按真剩下的算
  const room = d => count[d] + shopN[d] < DAY_MAX;

  // ① 只能去某一天的先放（指定了日子，或者只有那天开门）
  for (let i = 0; i < n; i++) if (E[i].feas.length === 1) put(i, E[i].feas[0]);

  // ② 种子：那天已有地方的中心；没有就挑离别的种子最远的地方（一个种子都没有时，挑离所有地方中心最远的）
  const seed = days.map((_, d) => centroid(E, assign, d));
  const all = centroid(E, E.map(() => 0), 0);
  for (let d = 0; d < D; d++) {
    if (seed[d]) continue;
    const have = seed.filter(Boolean);
    let bi = -1, bd = -1;
    if (cap[d] > 0 && room(d)) {
      for (let i = 0; i < n; i++) {
        if (assign[i] !== -1 || !E[i].feas.includes(d)) continue;
        const dist = have.length ? Math.min(...have.map(s => haversineM(s, E[i]))) : haversineM(all, E[i]);
        if (dist > bd) { bd = dist; bi = i; }
      }
    }
    if (bi >= 0) { put(bi, d); seed[d] = { lat: E[bi].lat, lng: E[bi].lng }; }
    else seed[d] = { lat: days[d].start.lat, lng: days[d].start.lng };
  }
  // 其余的：能去的天少的先分、必去的先分、待得久的先分；去离种子最近、还装得下的那天
  // （装得下 = Σ(待多久 + 20 分钟) ≤ 那天出发到最晚回来的时长）；哪天都装不下就放最近的那天，让引擎挑
  const order = [...Array(n).keys()].filter(i => assign[i] === -1)
    .sort((a, b) => E[a].feas.length - E[b].feas.length || E[b].value - E[a].value || E[b].need - E[a].need || a - b);
  for (const i of order) {
    const ds = E[i].feas.filter(room).sort((x, y) => haversineM(seed[x], E[i]) - haversineM(seed[y], E[i]) || x - y);
    if (!ds.length) continue;   // 能去的那几天都已经 30 组了：不分，最后记进 unplaced
    const fit = ds.find(d => load[d] + E[i].need + SLACK <= cap[d]);
    put(i, fit !== undefined ? fit : (ds.find(d => cap[d] > 0) ?? ds[0]));
  }

  // ③ 每天排
  let cur = ev.evaluate(assign);
  if (!cur.ok) throw new Error(overflowText(days, cur));

  // ④ 改进：挪 / 换，只收「更好」的（分数更高，或同分回程加起来更早）；时间到或者一整轮没改进就停
  const timeUp = () => Date.now() >= deadlineMs;
  const movable = i => E[i].feas.length > 1;
  const covered = i => assign[i] >= 0 && cur.days[assign[i]].covered.has(E[i].gid);
  const dist = (i, c) => haversineM(E[i], c);
  function attempt(changes) {
    const old = changes.map(([i]) => assign[i]);
    for (const [i, d] of changes) assign[i] = d;
    const r = ev.evaluate(assign);
    if (r.ok && better(r, cur)) { cur = r; return true; }
    changes.forEach(([i], k) => { assign[i] = old[k]; });
    return false;
  }

  // ④ 这一步包成函数：⑤ 每打乱一次要再走一遍
  function climb() {
    search: for (;;) {
      let improved = false;
      const cen = days.map((day, d) => centroid(E, assign, d) || { lat: day.start.lat, lng: day.start.lng });
      const nearFirst = i => (x, y) => dist(i, cen[x]) - dist(i, cen[y]) || x - y;

      // a. 没排进去的地方，挨个试挪到别的能去的天；直接挪不行，再试「挪进去 + 把那天排进去的一个挪去第三天」
      const unc = [...Array(n).keys()].filter(i => movable(i) && !covered(i)).sort((x, y) => E[y].value - E[x].value || x - y);
      for (const i of unc) {
        if (covered(i)) continue;
        const targets = E[i].feas.filter(d => d !== assign[i]).sort(nearFirst(i));
        let done = false;
        for (const d of targets) {
          if (timeUp()) break search;
          if (attempt([[i, d]])) { done = true; break; }
        }
        if (!done) {
          chain: for (const d of targets) {
            for (let j = 0; j < n; j++) {
              if (j === i || assign[j] !== d || !movable(j) || !covered(j)) continue;
              for (const d2 of E[j].feas) {
                if (d2 === d) continue;
                if (timeUp()) break search;
                if (attempt([[i, d], [j, d2]])) { done = true; break chain; }
              }
            }
          }
        }
        if (done) improved = true;
      }

      // b. 交换：两天各拿一个换。先试「两边都离对方那天的地方更近」的
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const A = assign[i];
        if (A < 0 || !movable(i)) continue;
        for (let j = i + 1; j < n; j++) {
          const B = assign[j];
          if (B < 0 || B === A || !movable(j) || !E[i].feas.includes(B) || !E[j].feas.includes(A)) continue;
          pairs.push([i, j, A, B, dist(i, cen[B]) - dist(i, cen[A]) + dist(j, cen[A]) - dist(j, cen[B])]);
        }
      }
      pairs.sort((x, y) => x[4] - y[4] || x[0] - y[0] || x[1] - y[1]);
      for (const [i, j, A, B] of pairs) {
        if (assign[i] !== A || assign[j] !== B) continue;   // 前面收了别的改动，这一对已经不是原样了
        if (timeUp()) break search;
        if (attempt([[i, B], [j, A]])) improved = true;
      }

      // c. 挪：排进去的地方挪去别的能去的天（同分回程更早也收）
      for (let i = 0; i < n; i++) {
        if (!movable(i) || !covered(i)) continue;
        for (const d of E[i].feas.filter(d => d !== assign[i]).sort(nearFirst(i))) {
          if (timeUp()) break search;
          if (attempt([[i, d]])) { improved = true; break; }
        }
      }

      if (!improved) break;
    }
  }
  climb();

  // ⑤（规格之外，用 ④ 停下来之后剩下的时间）打乱再爬。
  //   ④ 一次最多动两个地方；要同时挪三个才排得进去的，它看不见，就会把一个其实排得进去的地方报成「哪天都塞不下」。
  //   0923 实测（跟穷举比「总分一样」的比例）：一天 4–9 小时的紧行程，10–11 个地方 × 3 天 60 例：只做到 ④ 88.3%
  //   （7 例少排了能排进去的地方），加上 ⑤ 100%；2 天 × 10–14 个 150 例：96.7% → 100%；7–9 个 × 3–4 天 300 例：
  //   98.7% → 99.7%。一天 4–13 小时的 2 天 × 10–14 个 150 例：94.7% → 99.3%。
  //   做法：只在还有地方没排进去时做。从目前最好的分法出发，挑一个没排进去的 —— 能挪就把它塞去另一天、再从那天
  //   挤走一两个；只能去那一天的，就只从那天挤走一两个 —— 然后再走一遍 ④，比最好的还好就收。
  //   连着 KICKS 次没收、全都排进去了、或者时间到了，就停。
  //   代价：有地方排不进去时会多花时间（量的：20 个地方 × 4 天 最多约 0.6 秒；30 × 5 天会用满 1.5 秒）；全排得进去时不花。
  //   ★ 随机数种子是固定的，同样的输入排出同样的结果 —— 除非是「时间到了」才停的（大行程、慢手机），
  //     那时打乱了几次跟机器快慢有关，手机上的结果可能比电脑上的差一点。
  let best = { ...cur, assign: assign.slice() };
  const rand = lcg(n * 7919 + D * 104729 + 1);
  const pick = a => a[Math.floor(rand() * a.length)];
  const mov = [...Array(n).keys()].filter(movable);
  for (let fails = 0; fails < KICKS && mov.length && !timeUp();) {
    for (let i = 0; i < n; i++) assign[i] = best.assign[i];
    cur = best;
    const lost = [...Array(n).keys()].filter(i => !covered(i));
    if (!lost.length) break;   // 全都排进去了：分数到顶，不再打乱
    const i = rand() < 0.8 ? pick(lost) : pick(mov);
    let d;
    if (movable(i)) { d = pick(E[i].feas.filter(x => x !== assign[i])); assign[i] = d; }
    else d = E[i].feas[0];
    const others = mov.filter(j => j !== i && assign[j] === d);
    for (let k = 1 + Math.floor(rand() * 2); k > 0 && others.length; k--) {
      const j = others.splice(Math.floor(rand() * others.length), 1)[0];
      assign[j] = pick(E[j].feas.filter(x => x !== d));
    }
    const r = ev.evaluate(assign);   // 挤出来一天超过 30 组的：这次不算，r.ok 为 false
    if (r.ok) { cur = r; climb(); }
    if (r.ok && better(cur, best)) { best = { ...cur, assign: assign.slice() }; fails = 0; } else fails++;
  }
  return best;
}

// 可复现的随机数（⑤ 打乱用；同一个种子出同一串）
function lcg(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// 第 d 天分到的地方的中心；一个都没有返回 null
function centroid(E, assign, d) {
  let la = 0, ln = 0, k = 0;
  for (let i = 0; i < E.length; i++) if (assign[i] === d) { la += E[i].lat; ln += E[i].lng; k++; }
  return k ? { lat: la / k, lng: ln / k } : null;
}

// ---------- 翻成输出，并核对一个没丢 ----------

function present(days, places, E, best, unplaced, method, tStart, allExact) {
  const { assign } = best;
  const idOfGid = new Map(E.map(e => [e.gid, e.id]));
  const outDays = days.map((day, d) => {
    const r = best.days[d];
    const mine = new Set();
    for (let i = 0; i < E.length; i++) if (assign[i] === d) mine.add(E[i].gid);
    const placeIds = [];   // 按路线先后
    if (r.ok) for (const v of r.result.visits) for (const part of v.parts) for (const g of part.groups) if (mine.has(g)) placeIds.push(idOfGid.get(g));
    return { date: day.date, problem: r.problem, result: r.result, placeIds, coveredGroups: r.ok ? [...r.result.covered] : [] };
  });

  // 分了天但没排进去的：用那天引擎给的理由
  for (let i = 0; i < E.length; i++) {
    const e = E[i], d = assign[i];
    if (d >= 0 && best.days[d].covered.has(e.gid)) continue;
    let text;
    if (d < 0) {
      text = `能去的那几天都已经排满 ${DAY_MAX} 组了（一天最多算 ${DAY_MAX} 组），没排它`;
    } else {
      const day = days[d], md = mdText(day.date), r = best.days[d];
      let why;
      if (!r.ok) why = `${hm(day.t0)} 出发、${hm(day.deadline)} 前回不到终点，那天什么都排不了`;
      else {
        const dr = (r.result.dropped || []).find(x => x.group === e.gid);
        why = dr ? dr.text : '没排进去（引擎没给原因）';
      }
      if (e.fixed) text = `指定的 ${md}排不下：${why}`;
      else if (e.feas.length === 1) text = `只有 ${md}能去，那天排不下：${why}`;
      else text = `哪天都塞不下（放在 ${md}时：${why}）`;
    }
    unplaced.push({ placeId: e.id, name: e.place.name, text });
  }

  // ★ 核对：每个传进来的地方正好记一次（排进某一天，或者在 unplaced 里）
  const seen = new Map();
  for (const od of outDays) for (const id of od.placeIds) seen.set(id, (seen.get(id) || 0) + 1);
  for (const u of unplaced) seen.set(u.placeId, (seen.get(u.placeId) || 0) + 1);
  for (const p of places) {
    const k = seen.get(p.id) || 0;
    if (k !== 1) throw new Error(`分天算法内部核对不上：「${p.name}」记了 ${k} 次（应该正好 1 次）`);
  }
  if (seen.size !== places.length) throw new Error('分天算法内部核对不上：结果里有传进来时没有的地方');

  // 要买的东西（香港）：整趟都没买到的，带最后一次没买到那天引擎给的理由
  const shoppingUnplaced = [];
  const boughtAll = new Set(outDays.flatMap(od => od.coveredGroups));
  const label = new Map(), why = new Map();
  days.forEach((day, d) => {
    const sp = day.shopping;
    if (!sp || !sp.groups) return;
    for (const g of sp.groups) if (!label.has(g.id)) label.set(g.id, g.label || g.id);
    const r = best.days[d];
    if (!r.ok) { for (const g of sp.groups) if (!boughtAll.has(g.id)) why.set(g.id, `${mdText(day.date)}回不到终点，那天什么都排不了`); return; }
    for (const x of r.result.dropped || []) if (label.has(x.group)) why.set(x.group, `${mdText(day.date)}：${x.text}`);
  });
  for (const [gid, lb] of label) if (!boughtAll.has(gid)) shoppingUnplaced.push({ groupId: gid, label: lb, text: why.get(gid) || '没排进去' });

  return {
    days: outDays,
    unplaced,
    shoppingUnplaced,
    // ★ 精确 = 穷举 + 挑中的每天精确 + 试过的每一天也都精确（引擎一天超过 9 个地方就可能不精确，见文件头）
    exact: method === 'exhaustive' && allExact && outDays.every(od => od.result.exact === true),
    method,
    elapsedMs: Date.now() - tStart,
  };
}
