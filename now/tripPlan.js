// 旅游版：整趟怎么排（规格 14.6 的调用方）。
// 分天在 days.js，每一天的排路线在 engine.js，翻译成界面要的样子在 plan.js 的 present()。
// 香港的行程：买东西那套（品牌 / 分店 / 备选）照旧走 plan.js 的 buildProblem，按天喂给 days.js；
// 大陆 / 国外：路程从存好的矩阵来（geo.js 的 makeMatrixTravel），没存的按直线估、界面标「估的」。
// ★ 不存路线：每次都拿【当时的 state】从头排（规格「二之半」）。

import { hm } from './engine.js';
import { HK_PH_2026 } from './hours.js';
import { makeMatrixTravel } from './geo.js';
import { planDays } from './days.js';
import { mapLinks, walkFromLeg, navLinks } from './maplinks.js';
import * as Trip from './trip.js';
import { buildProblem, present } from './plan.js';

const itemView = it => ({ id: it.id, name: it.name, qty: it.qty || 1, who: it.who || [], note: it.note || '', isPlace: !!it.isPlace, stockNote: '' });

export function makeTrip(state, data, T, opts = {}) {
  const t0 = Date.now();
  if (!state.trip) return { ok: false, error: '这份数据还是旧版的（没有行程）' };
  const region = Trip.regionOf(state);
  const days = state.trip.days;
  if (!days.length) return { ok: false, error: '行程里一天都没有（设置 → 行程 → 加一天）' };
  for (const d of days) if (!(d.deadline > d.startTime)) return { ok: false, error: `${Trip.dateLabel(d.date)}：最晚回到终点（${hm(d.deadline)}）早于出发时间（${hm(d.startTime)}）` };
  const MT = region === 'hk' ? null : makeMatrixTravel(state.matrix || {});

  // 挂了东西的地方由买东西那套管（它是那几样东西的「店」）；其余还没去的地方交给 days.js 分天
  const attached = new Set(state.items.filter(i => (i.status === 'todo' || !i.status) && i.where && i.where.type === 'place').map(i => i.where.place));
  const places = state.places.filter(p => p.status === 'todo' && !attached.has(p.id));

  const build = backupsOn => days.map(d => {
    let b;
    if (region === 'hk') b = buildProblem(state, data, T, { backupsOn, day: d, includePlaces: false });
    else b = { problem: null, groupItems: new Map(), skipped: [], pendingBackups: [], day: d,
      start: Trip.resolvePoint(state, T, d.start, 'start'), end: Trip.resolvePoint(state, T, d.end, 'end') };
    const travel = region === 'hk' ? T.forTrip(b.start, b.end) : MT.forTrip(b.start, b.end);
    const shopping = b.problem && b.problem.groups.length ? { stores: b.problem.stores, groups: b.problem.groups } : null;
    return { built: b, input: { date: d.date, t0: d.startTime, deadline: d.deadline, start: b.start, end: b.end, travel, isPH: region === 'hk' && HK_PH_2026.has(d.date), shopping } };
  });

  let backupsActivated = null;
  try {
    let B = build(new Set());
    const run = () => planDays({ days: B.map(x => x.input), places }, { timeBudgetMs: opts.timeBudgetMs, engine: opts.engine, method: opts.method });
    let R = run();
    if (region === 'hk') {
      // 条件备选（奇华顶替恒香）：它顶替的那家在哪一天都没排进去 → 把它加进来再排一次（规格 3.3）
      const covered = new Set(R.days.flatMap(d => d.coveredGroups || []));
      const b0 = B[0].built, droppedBrands = new Set();
      for (const it of b0.pendingBackups) {
        const Bn = it.backupFor;
        const primGroups = [...b0.groupItems.entries()].filter(([, its]) => its.some(i => i.where && (i.where.brand === Bn || (i.where.brands || []).includes(Bn))));
        const primSkipped = b0.skipped.some(s => s.items.some(i => i.where && i.where.brand === Bn));
        if (primSkipped || (primGroups.length && primGroups.every(([gid]) => !covered.has(gid)))) droppedBrands.add(Bn);
      }
      if (droppedBrands.size) { B = build(droppedBrands); R = run(); backupsActivated = [...droppedBrands]; }
    }

    const dayViews = R.days.map((rd, i) => {
      const gi = new Map(B[i].built.groupItems);
      for (const p of places) gi.set('place:' + p.id, [{ id: 'place:' + p.id, name: p.name, qty: 1, who: [], note: p.note || '', must: p.must !== false, isPlace: true }]);
      const built = { ...B[i].built, problem: rd.problem, groupItems: gi, backupsActivated: i === 0 ? backupsActivated : null };
      const v = present(state, data, T, built, rd.result, {
        describe: region === 'hk' ? undefined : (a, b) => MT.describe(a, b),
        links: (a, b, leg) => mapLinks(region, a, b, { walk: walkFromLeg(leg) }),
        options: region === 'hk' ? undefined : (a, b, t, leg) => null,   // 不是香港 → 没有港铁表，让 present 按直线估几种走法
        nav: (a, b, mode) => navLinks(region, a, b, mode),
      });
      v.date = rd.date;
      v.placeIds = rd.placeIds || [];
      v.dropped = [];       // 一天里排不进的东西可能排在别的天：去不了的一律在整趟层面说（下面 notBought / unplaced）
      v.skipped = [];
      return v;
    });

    // 整趟层面：哪些东西哪天都买不到（买东西的组一天都没排到）
    const coveredAll = new Set(R.days.flatMap(d => d.coveredGroups || []));
    const lastDropped = new Map();
    for (const rd of R.days) for (const d of (rd.result && rd.result.dropped) || []) lastDropped.set(d.group, d);
    const gi0 = B[0].built.groupItems;
    const notBought = [...gi0.entries()].filter(([gid]) => !gid.startsWith('place:') && !coveredAll.has(gid))
      .map(([gid, its]) => ({ items: its.map(itemView), text: (lastDropped.get(gid) || {}).text || '哪一天都排不进去' }));
    const skipped = B[0].built.skipped.map(s => ({ items: s.items.map(itemView), why: s.why, text: s.text }));
    // 条件备选（主店买够了就不用去的）：没启用的一律列出来带原因，不许哪儿都不出现
    const standby = B[0].built.pendingBackups.map(it => ({ ...itemView(it), text: `「${it.backupFor}」排进去了，买够了就不用去这家；没买够时标「没买够」会自动加进来` }));

    return {
      ok: true, region, days: dayViews,
      unplaced: R.unplaced || [],          // 地方：哪天都去不了（带原因）
      notBought, skipped, standby,         // 东西：哪天都买不到 / 没排（不知道在哪买、数据里没店）/ 备选没启用
      exact: !!R.exact, method: R.method, elapsedMs: Date.now() - t0, backupsActivated,
      estimated: dayViews.reduce((n, d) => n + (d.estimated || 0), 0),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
