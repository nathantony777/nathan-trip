// 界面：首页「我的出行」+ 一趟里的 行程 / 地方 / 说话 / 设置 四页。算法在 worker.js 里跑（不卡界面），这里只管显示和改 state。
// 规格：../规格.md 第一节、「二之半、随时改」、第八节（地图按钮）、第九节（存储）、第十四节（旅游版）、第十五节（说话 + 出行的集合）。
// ★ 清单和进度只存在这台手机里（IndexedDB）；家人清单不进代码（应用规范第四节）。
// ★ 三把钥匙（两家地图 + AI）另存（IndexedDB 的 keys），不在 state 里、不进备份、不打印（规格 14.8 / 15.8）。
// ★ 存的是 root（好几趟）；`state` 永远指当前这趟（root.trips[root.current]），没有当前趟时是 null、只能看首页。

import { parseList } from './parse.js';
import * as P from './plan.js';
import * as Trip from './trip.js';
import * as Trips from './trips.js';
import * as MX from './matrix.js';
import { makeProvider } from './providers.js';
import { parseSpeech } from './speech.js';
import { PRESETS, makeAI } from './ai.js';
import { coordsFromText } from './maplinks.js';
import { hm } from './engine.js';
import { trailSVG } from './map.js';
import { parseShare } from './collect.js';
import * as FX from './fx.js';
import { isPlanDoc, parsePlanDoc } from './planDoc.js';   // 整份计划（标题 + 打勾清单 + 购物行）不走「一句话一件事」   // 动效（0924）：错落入场、按压回弹、数字滚动；弹层/提示条/换页仍走 index.html 里的 CSS 过场   // 收藏箱：把分享文字 / 收藏文件认成一条条店（规格 15.13）

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toHM = m => { if (m == null || !isFinite(m)) return ''; const x = Math.round(m); return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const fromHM = s => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmtGot = iso => { const d = new Date(iso || ''); return isNaN(d) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const STATUS_TEXT = { todo: '还没买', bought: '买到', skip: '跳过', enough: '够了', notEnough: '没买够' };
const PROVIDER_NAME = { google: '谷歌', amap: '高德' };

let data, stations, root, state, plan = null, tab = 'trip', curDay = null, undoSnap = null, toastTimer = null, storeOk = true;
let lastTab = null;   // 上一次画的是哪页：换页动效只在它变了时触发
let keys = { google: '', amap: '', ai: '' }, usage = {};
let planSeq = 0, runPlan;
let fetching = null;      // 正在取路程：{ abort, done, total }
let pendingHits = null;   // 搜出来还没加的地方
let pendingDraft = null;  // 「听懂」出来还没确认的草稿：{ text, draft, note, hkItems }
let listening = false;    // 正在找地方（说话页确认之后）
let pendingInboxId = null; // 从收藏箱点「加到这趟」正在填表的那条；存成地方之后记回收藏箱（用在哪一趟）
let showInboxDone = false; // 收藏箱里已处理的（加过 / 不要了）展不展开

// ---------------- 存储（IndexedDB） ----------------

const DB = 'nathan-trip', KV = 'kv';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(KV);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction(KV).objectStore(KV).get(key);
    q.onsuccess = () => res(q.result ?? null);
    q.onerror = () => rej(q.error);
  });
}
async function kvPut(key, val) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(KV, 'readwrite');
    tx.objectStore(KV).put(JSON.parse(JSON.stringify(val)), key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function saveState() {
  try { await kvPut('state', root); storeOk = true; }
  catch (e) { storeOk = false; render(); }   // ★ 存不下来要出声：关掉 app 会丢
}
// 当前这趟整个换掉（恢复备份 / 全部清空）：走 trips.js，id 和 created 留着
function setCurrent(st) { state = Trips.replaceTrip(root, root.current, st); }
const saveKeys = () => kvPut('keys', keys).catch(() => alert('钥匙存不下来（可能是无痕模式）'));
const saveUsage = u => kvPut('usage', u).catch(() => {});

// ---------------- 排路线（worker；不支持就在主线程排） ----------------

function setupPlanner() {
  try {
    const w = new Worker('worker.js', { type: 'module' });
    const waits = new Map();
    w.onmessage = e => { const f = waits.get(e.data.id); if (f) { waits.delete(e.data.id); f(e.data.plan); } };
    // worker 起不来（老系统不支持）：改在主线程排。正在等的那一次也要放掉，不然 replan 会一直以为「还在排」。
    w.onerror = () => { runPlan = mainThreadPlanner(); for (const f of waits.values()) f(null); waits.clear(); replan(); };
    return st => new Promise(res => { const id = ++planSeq; waits.set(id, res); w.postMessage({ id, state: st }); });
  } catch {
    return mainThreadPlanner();
  }
}
function mainThreadPlanner() {
  let T = null;
  return async st => {
    const { makeTransit } = await import('./transit.js');
    const { makeTrip } = await import('./tripPlan.js');
    if (!T) T = makeTransit(data);
    try { return makeTrip(st, data, T); } catch (e) { return { ok: false, error: e.message }; }
  };
}
// 一次只排一遍。排的过程中又改了（在店里连点几样「买到」），只记一笔，这遍排完再按最新的排一遍。
let planning = false, planAgain = false;
async function replan() {
  if (!state) { plan = null; $('#busy').hidden = true; return; }   // 没有当前趟（首页）：没什么可排
  $('#busy').hidden = false;
  if (planning) { planAgain = true; return; }
  planning = true;
  let r = null;
  try {
    do {
      planAgain = false;
      r = await runPlan(JSON.parse(JSON.stringify(state)));
    } while (planAgain);
  } catch (e) {
    r = { ok: false, error: e.message };
  } finally {
    planning = false;
  }
  plan = r || { ok: false, error: '排路线出错了，改一下清单会再排一次' };   // 空结果会让行程页一直停在「正在排…」
  archiveTrail();
  $('#busy').hidden = true;
  render();
}
// 排出来的路线存一份「轨迹」进这趟（首页小图、回顾页的地图都读它）；过去的趟不再排，靠存下来的这份。
// 只在变了的时候写盘，不走 mutate（不算一次「改动」、不进撤销）。
function trailFromPlan(p) {
  if (!p || !p.ok) return null;
  return { days: p.days.filter(d => d && d.ok).map(d => ({
    date: d.date,
    start: d.start ? { name: d.start.name, lat: d.start.lat, lng: d.start.lng, time: d.start.time } : null,
    end: d.end ? { name: d.end.name, lat: d.end.lat, lng: d.end.lng, arrive: d.end.arrive ?? null } : null,
    stops: (d.stops || []).flatMap(s => s.parts.map(pt => ({ name: pt.name, lat: s.lat, lng: s.lng, begin: pt.begin, end: pt.end, storeId: pt.storeId, isPlace: !!pt.isPlace, placeId: pt.placeId || null, addr: pt.addr || '', items: pt.items.filter(i => !i.isPlace).map(i => ({ id: i.id, name: i.name })) }))),
  })) };
}
function archiveTrail() {
  if (!state || !plan || !plan.ok) return;
  const tr = trailFromPlan(plan);
  if (tr && JSON.stringify(tr) !== JSON.stringify(state.trail || null)) { state.trail = tr; saveState(); }
}
// 轨迹里的东西配上现在的状态（买到 / 没货 / 跳过）
function trailWithStatus(t) {
  const tr = t && t.trail; if (!tr) return null;
  const st = new Map((t.items || []).map(i => [i.id, i]));
  return { days: tr.days.map(d => ({ ...d, stops: d.stops.map(s => ({ ...s, items: s.items.map(i => { const it = st.get(i.id); return { ...i, status: it ? it.status : 'todo', noStock: it && (it.noStock || []).includes(s.storeId) }; }) })) })) };
}

// ---------------- 改 state：一律走这里（存盘 + 重排 + 可撤销） ----------------

function mutate(fn, toastText) {
  const before = JSON.stringify(root);
  const wasId = root.current;
  try { fn(); } catch (e) { alert(e.message); return false; }
  state = Trips.currentTrip(root);                       // fn 可能新建 / 切换 / 删了趟
  if (state) Trips.touch(state);
  if (root.current !== wasId) { plan = null; curDay = null; }
  undoSnap = before;
  saveState();
  replan();
  render();
  if (toastText) toast(toastText, true);
  return true;
}
function undo() {
  if (!undoSnap) return;
  const cur = state ? state.matrix || {} : {}, curId = root.current;
  root = JSON.parse(undoSnap);
  state = Trips.currentTrip(root);
  if (state && state.id === curId) state.matrix = { ...(state.matrix || {}), ...cur };   // 取路程是花钱的、不走 mutate：撤销别的改动时把它留住
  if (root.current !== curId) { plan = null; curDay = null; }
  undoSnap = null;
  saveState(); replan(); render();
  toast('撤销了', false);
}
function toast(text, canUndo) {
  clearTimeout(toastTimer);
  $('#toast-root').innerHTML = `<div class="toast"><span class="grow">${esc(text)}</span>${canUndo ? '<button data-act="undo">撤销</button>' : ''}</div>`;
  // 能撤销的留久一点：手机上看到、反应过来要几秒。收起时先加 .leaving 淡出 200ms 再清（下一条 toast 来了 clearTimeout 会把两步一起撤）
  toastTimer = setTimeout(() => {
    const t = $('#toast-root .toast'); if (t) t.classList.add('leaving');
    toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, 200);
  }, canUndo ? 8000 : 3000);
}

// ---------------- 地区 / 联网 ----------------

const region = () => Trip.regionOf(state);
const providerName = () => Trip.REGIONS[region()].provider;     // null = 香港（内置数据）
const hasKey = () => { const p = providerName(); return !!(p && keys[p]); };
function makeProv() {
  const p = providerName();
  if (!p) throw new Error('香港的行程用内置数据，不用联网');
  if (!keys[p]) throw new Error(`还没填${PROVIDER_NAME[p]}的钥匙（设置 → 联网）`);
  const spend = MX.makeSpender({ provider: p, cap: Number(root.settings.caps[p]) || 0, usage, save: saveUsage });
  return makeProvider(p, { key: keys[p], spend });
}
const usedToday = p => (usage[p] && usage[p].date === Trip.localDateStr()) ? usage[p].units : 0;
// AI（把口语听成行程，规格 15.4）：地址 / 模型名在 root.settings.ai，钥匙在 keys.ai；本地模型可以不要钥匙
const aiPreset = () => PRESETS.find(p => p.id === root.settings.ai.preset) || null;
const aiName = () => { const p = aiPreset(); return p ? p.name : (root.settings.ai.base || '自己填的地址'); };
const aiReady = () => !!keys.ai || root.settings.ai.preset === 'local';
function makeAIClient() {
  const A = root.settings.ai;
  if (!aiReady()) throw new Error('还没填 AI 的钥匙（设置 → AI）');
  const spend = MX.makeSpender({ provider: 'ai', cap: Number(root.settings.caps.ai) || 0, usage, save: saveUsage });
  return makeAI({ base: A.base, model: A.model, key: keys.ai, noKey: A.preset === 'local' && !keys.ai, spend });
}

// ---------------- 文字 ----------------

function storeName(id) {
  if (id.startsWith('place:')) { const p = state.places.find(x => 'place:' + x.id === id); return p ? p.name : '（删掉的地方）'; }
  const s = data.stores.find(x => x.id === id);
  return s ? `${s.brand} ${s.name}` : id;
}
function whereText(it) {
  const w = it.where;
  if (!w) return '不知道在哪买';
  let t;
  if (w.type === 'brand') t = `${w.brand}（哪家分店都行，挑近的）`;
  else if (w.type === 'preferred') t = `${w.brand}（首选 ${(w.preferred || []).map(storeName).map(x => x.replace(w.brand + ' ', '')).join(' / ')}）`;
  else if (w.type === 'branch' || w.type === 'stores') t = (w.stores || []).length === 1 ? storeName(w.stores[0]) : `${w.brand || ''}（${(w.stores || []).length} 家里挑一家${w.hint ? '：' + w.hint : ''}）`;
  else if (w.type === 'category') t = `${w.product ? w.product + '：' : ''}${(w.brands || []).join(' / ')} 都行`;
  else if (w.type === 'oneOf') t = `${(w.brands || []).join(' / ')} 选一家`;
  else if (w.type === 'place') { const p = state.places.find(x => x.id === w.place); t = p ? `地方：${p.name}` : '挂的地方被删了'; }
  else t = w.type;
  if (it.forced) t += ` → 一定去 ${storeName(it.forced)}`;
  if ((it.noStock || []).length) t += `（${it.noStock.length} 家标了没货）`;
  return t;
}
function tagsOf(it) {
  const t = [];
  t.push(it.must === false ? '<span class="tag">顺路才买</span>' : '<span class="tag ok">必买</span>');
  if (it.heavy) t.push('<span class="tag">重物·放最后</span>');
  if (it.backupFor) t.push(`<span class="tag warn">备选：${esc(it.backupFor)}没买够才去</span>`);
  return t.join('');
}
const whoText = it => (it.who || []).filter(Boolean).length ? `给${it.who.filter(Boolean).join('、')}` : '';
const backupBrands = () => new Set(state.items.filter(i => i.backupFor).map(i => i.backupFor));
const isPrimary = it => it.where && backupBrands().has(it.where.brand);
const dayLabel = (d, week = true) => Trip.dateLabel(d, week);
const placeHoursText = p => p.hoursText || (p.hours ? '有营业时间' : (p.from != null || p.to != null ? '' : '营业时间不知道，按 10:00–20:00 算'));

// ---------------- 行程 ----------------

function ensureCurDay() {
  const ds = state.trip.days.map(d => d.date);
  if (!ds.includes(curDay)) { const t = Trip.localDateStr(); curDay = ds.includes(t) ? t : ds[0]; }
}
function dayView() { return plan && plan.ok ? (plan.days.find(d => d.date === curDay) || null) : null; }

function renderTrip() {
  ensureCurDay();
  const out = [];
  const R = region();
  if (!storeOk) out.push(`<div class="note err">这台手机存不下来（可能是无痕模式）：关掉 app 会丢。先去「设置」复制一份备份。</div>`);
  const tripName = state.trip.name || Trip.REGIONS[R].name;
  out.push(`<h1>${esc(tripName)}${tripName === Trip.REGIONS[R].name ? '' : ` <span class="tag">${esc(Trip.REGIONS[R].name)}</span>`}</h1>`);
  out.push(`<div class="chips seg lg">${state.trip.days.map(d => `<button class="chip" data-act="pickDay" data-date="${d.date}" aria-pressed="${d.date === curDay}">${esc(dayLabel(d.date))}</button>`).join('')}<button class="chip quiet" data-act="go" data-tab="settings">＋ 加一天</button></div>`);
  if (!state.items.length && !state.places.length) {
    out.push(`<div class="card"><p>还没有想去的地方。</p><div class="row"><button class="primary grow" data-act="go" data-tab="speech">说一句想去哪</button><button class="grow" data-act="go" data-tab="places">去「地方」页加</button></div></div>`);
    return out.join('');
  }
  if (!plan) { out.push('<p class="muted">正在排…</p>'); return out.join(''); }
  if (!plan.ok) { out.push(`<div class="note err">排不出来：${esc(plan.error)}</div>`); return out.join(''); }
  const dv = dayView();
  if (!dv) { out.push('<p class="muted">正在排这一天…</p>'); return out.join(''); }
  for (const w of dv.warnings || []) out.push(`<div class="note">${esc(w)}</div>`);

  const nPlaces = dv.stops.reduce((n, s) => n + s.parts.filter(p => p.isPlace).length, 0);
  const nItems = dv.stops.reduce((n, s) => n + s.parts.reduce((m, p) => m + p.items.filter(i => !i.isPlace).length, 0), 0);
  const what = [nPlaces ? `${nPlaces} 个地方` : '', nItems ? `${nItems} 样东西` : ''].filter(Boolean).join(' · ') || '没有安排';
  const exactTag = plan.exact ? '<span class="tag ok">已是最顺的排法</span>' : `<span class="tag">排法够顺（${plan.method === 'heuristic' ? '几天之间怎么分是近似的' : '没试完所有排法'}）</span>`;
  out.push(`<div class="card summary">
    <div class="title">${dv.cannotReturn ? '这天回不去了' : `${what} · 预计 ${hm(dv.end.arrive)} 回到${esc(dv.end.name)}`}</div>
    <div class="muted small">${esc(dayLabel(dv.date))} · 从${esc(dv.start.name)} ${hm(dv.start.time)} 出发 · 最晚 ${hm(dv.end.deadline)} 到 · ${exactTag}</div>
    ${dv.estimated ? `<div class="flag" style="margin-top:6px">有 ${dv.estimated} 段路程是估的${R !== 'hk' ? '（还没联网取）' : ''}</div>` : ''}
    <div class="row" style="margin-top:10px"><button class="primary grow" data-act="here" data-date="${dv.date}">从这里重排</button>
      ${R !== 'hk' && dv.estimated ? `<button class="grow" data-act="fetchRoutes">联网取路程</button>` : ''}
      <button class="quiet" data-act="go" data-tab="settings">改这天</button></div>
  </div>`);
  { const dayObj = Trip.findDay(state, dv.date); if (dayObj && dayObj.note) out.push(`<div class="note">${esc(dayObj.note).replace(/\n/g, '<br>')}</div>`); }   // 这一天的备注（整份计划里的主要任务 / 出发 / 停车）
  if (dv.cannotReturn) { out.push(`<div class="note err">${esc(dv.text)}</div>`); out.push(renderLeftovers()); return out.join(''); }

  if (!dv.stops.length) {
    out.push(`<div class="card"><p>这天没有安排。</p><p class="muted small">想去的地方都排在别的天了，或者还没加。要指定某个地方这天去：在「地方」页点它 → 哪天去。</p></div>`);
    out.push(renderLeftovers());
    return out.join('');
  }
  // 时间轴（视觉 0924 第五版）：.tl 一根轨，出发 / 每站 / 回到 各一个 .tl-dot，时间只在轨旁（.time），站点卡挂在轨右侧；路段 .leg 是轨上安静的一段
  out.push(`<div class="tl"><div class="tl-pt"><i class="tl-dot end"></i><span class="time">${hm(dv.start.time)}</span><b>${esc(dv.start.name)}</b><span class="tag blue">出发</span></div>`);
  for (const s of dv.stops) {
    const addr = s.parts.map(p => p.addr || p.name).join('；');
    out.push(legHTML(s.leg, `${s.title} ${addr}`));
    out.push(`<div class="tl-stop"><div class="tl-head"><i class="tl-dot"></i><span class="time">${hm(s.arrive)}</span></div><div class="card stop">`);
    s.parts.forEach(p => {
      const acts = [
        p.phone ? `<a class="btn sm" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">打电话</a>` : '',
        p.isPlace ? '' : `<button class="quiet danger sm" data-act="exclude" data-store="${esc(p.storeId)}">这家不去了</button>`,
      ].filter(Boolean).join('');
      out.push(`<div class="part">
        <h3>${esc(p.name)}</h3>
        <div class="meta">${[esc(p.addr), p.hoursToday ? (p.isPlace ? '能去的时间 ' : '当天营业 ') + esc(p.hoursToday) : '', `${hm(p.begin)}–${hm(p.end)} 在这儿`].filter(Boolean).join(' · ')}</div>
        ${p.wait >= 3 ? `<div class="flag">${hm(p.arrive)} 到，等 ${p.wait} 分钟开门</div>` : ''}
        ${p.flags.map(f => `<div class="flag">${esc(f)}</div>`).join('')}
        <div style="margin-top:6px">${p.items.map(it => itemRowToday(it, p)).join('')}</div>
        ${acts ? `<div class="row acts-row">${acts}</div>` : ''}
      </div>`);
    });
    out.push(`</div></div>`);
  }
  out.push(legHTML(dv.back, dv.end.name));
  out.push(`<div class="tl-pt"><i class="tl-dot end"></i><span class="time">${hm(dv.end.arrive)}</span><b>${esc(dv.end.name)}</b><span class="muted small">（最晚 ${hm(dv.end.deadline)}）</span></div></div>`);
  if (dv.preferredCost) out.push(`<div class="note">${esc(dv.preferredCost.text)}。</div>`);
  out.push(renderLeftovers());
  out.push(`<p class="muted small">时间都是估的、偏保守${R !== 'hk' ? '；路程是按白天 10 点左右查的' : ''}${R === 'hk' ? '；「网上有货」不等于门市一定有' : ''}。${plan.elapsedMs != null ? `这次排了 ${plan.elapsedMs} 毫秒。` : ''}</p>`);
  return out.join('');
}

function renderLeftovers() {
  const out = [];
  if (plan.unplaced && plan.unplaced.length) {
    out.push(`<h2>哪天都去不了（${plan.unplaced.length} 个地方）</h2><div class="card">`);
    for (const u of plan.unplaced)
      out.push(`<div class="list-row"><div class="grow" data-act="editPlace" data-id="${esc(u.placeId)}"><b>${esc(u.name)}</b><div class="muted small">${esc(u.text)}</div></div></div>`);
    out.push('</div>');
  }
  if (plan.notBought && plan.notBought.length) {
    out.push(`<h2>买不到（${plan.notBought.reduce((n, d) => n + d.items.length, 0)} 样）</h2><div class="card">`);
    for (const d of plan.notBought) for (const it of d.items)
      out.push(`<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}"><b>${esc(it.name)}</b><div class="muted small">${esc(d.text)}</div></div></div>`);
    out.push('</div>');
  }
  if (plan.standby && plan.standby.length) {
    out.push(`<h2>备选，没用上（${plan.standby.length} 样）</h2><div class="card">`);
    for (const it of plan.standby)
      out.push(`<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}"><b>${esc(it.name)}</b><div class="muted small">${esc(it.text)}</div></div></div>`);
    out.push('</div>');
  }
  if (plan.skipped && plan.skipped.length) {
    out.push(`<h2>没排进去（${plan.skipped.reduce((n, d) => n + d.items.length, 0)} 样，点它改）</h2><div class="card">`);
    for (const d of plan.skipped) for (const it of d.items)
      out.push(`<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}"><b>${esc(it.name)}</b><div class="muted small">${esc(d.text)}</div></div></div>`);
    out.push('</div>');
  }
  return out.join('');
}

// 哪个地图：Nathan 0924 定「大陆网络环境用高德，出了大陆的网络环境用谷歌」——按【手机此刻的网络】，不按这一趟去哪。
// 探法：悄悄请求一次谷歌的 204 页（不带 cookie、不读内容），2.5 秒内通了就是「大陆以外的网络」；没探完之前先按这一趟的地区猜。
// ★ 探到结果如果跟猜的不一样，正在看行程页就重画一次，按钮当场换名字；网络变了（online 事件）再探。
let googleReachable = null;   // null = 还没探完
function probeGoogle() {
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 2500);
    fetch('https://www.google.com/generate_204', { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal })
      .then(() => true, () => false)
      .then(ok => { clearTimeout(timer); const was = googleReachable; googleReachable = ok; if (was !== ok && tab === 'trip') render(); });
  } catch { googleReachable = false; }
}
const useAmap = () => googleReachable === null ? region() === 'cn' : !googleReachable;
function legHTML(leg, copyText) {
  const L = leg.links || {};
  const btns = [];
  if (useAmap()) btns.push(`<button class="sm" data-act="openApp" data-app="${esc(L.amap)}" data-web="${esc(L.amapWeb || '')}">高德地图</button>`);
  else btns.push(`<button class="sm" data-act="openApp" data-app="${esc(L.google)}" data-web="${esc(L.googleWeb || '')}">谷歌地图</button>`);
  btns.push(`<button class="quiet sm" data-act="copy" data-text="${esc(L.copyText || copyText)}">复制地址</button>`);
  return `<div class="leg">${leg.mode === 'est' ? `<span class="flag">${esc(leg.text)}</span>` : esc(leg.text)}<div class="row">${btns.join('')}</div></div>`;
}

function itemRowToday(it, part) {
  const meta = [it.qty > 1 ? `×${it.qty}` : '', whoText(it), it.note, it.stockNote].filter(Boolean).join(' · ');
  let acts;
  if (it.isPlace) {
    const pid = it.id.slice(6);
    acts = `<button data-act="placeStatus" data-id="${esc(pid)}" data-status="done">去过了</button><button class="quiet" data-act="placeStatus" data-id="${esc(pid)}" data-status="skip">不去了</button>` +
      (state.trip.days.length > 1 ? `<button class="quiet" data-act="moveDay" data-id="${esc(pid)}">换一天</button>` : '');
  } else {
    const full = state.items.find(x => x.id === it.id);
    const prim = full && isPrimary(full);
    acts = (prim
      ? `<button data-act="mark" data-id="${esc(it.id)}" data-status="enough">够了</button><button data-act="mark" data-id="${esc(it.id)}" data-status="notEnough">没买够</button>`
      : `<button data-act="mark" data-id="${esc(it.id)}" data-status="bought">买到</button>`) +
      (part.isPlace ? '' : `<button class="quiet" data-act="nostock" data-id="${esc(it.id)}" data-store="${esc(part.storeId)}">没货</button>`) +
      `<button class="quiet" data-act="mark" data-id="${esc(it.id)}" data-status="skip">跳过</button>`;
  }
  return `<div class="item"><div class="grow" data-act="${it.isPlace ? 'editPlace' : 'edit'}" data-id="${esc(it.isPlace ? it.id.slice(6) : it.id)}">
      ${it.isPlace ? `<div class="muted small">${esc(meta || '点这里改')}</div>` : `<div class="name">${esc(it.name)}</div>${meta ? `<div class="muted small">${esc(meta)}</div>` : ''}`}</div>
    <div class="acts seg">${acts}</div></div>`;
}

// ---------------- 地方 ----------------

function renderPlaces() {
  const out = ['<h1>地方</h1>'];
  const R = region();
  if (R !== 'hk') {
    out.push(`<div class="card">
      <label class="f">联网搜（${PROVIDER_NAME[providerName()]}）：名字、地址都行${state.trip.city ? `，在「${esc(state.trip.city)}」附近找` : ''}</label>
      <div class="row"><input id="q" class="grow" placeholder="比如：浅草寺、一兰拉面 新宿" ${hasKey() ? '' : 'disabled'}><button class="primary" data-act="search" ${hasKey() ? '' : 'disabled'}>搜</button></div>
      ${hasKey() ? '<p class="small muted">按一次搜一次，每次算 1 次联网。</p>' : `<p class="small flag">要先填${PROVIDER_NAME[providerName()]}的钥匙：<button class="quiet sm" data-act="go" data-tab="settings">去设置</button></p>`}
    </div>`);
  }
  out.push(`<div class="row"><button class="grow" data-act="newPlace">${R === 'hk' ? '加一个地方（吃饭、取货、朋友家）' : '手动加一个（定位 / 贴链接）'}</button></div>`);
  out.push(renderInbox());   // 收藏箱：任何地区都显示
  if (R === 'hk' && plan && plan.ok) out.push(renderRouteStops());
  const todo = state.places.filter(p => p.status === 'todo');
  const done = state.places.filter(p => p.status !== 'todo');
  if (!state.places.length && R !== 'hk') out.push(`<p class="muted small">想去的景点、餐厅、店，搜一个加一个；哪天去可以指定，也可以让算法分。</p>`);
  if (R === 'hk' && state.places.length) out.push('<h2>自己加的</h2>');
  for (const d of state.trip.days) {
    const ps = todo.filter(p => p.day === d.date);
    if (ps.length) out.push(`<h2>${esc(dayLabel(d.date))}（指定这天，${ps.length}）</h2><div class="card">${ps.map(placeRow).join('')}</div>`);
  }
  const orphan = todo.filter(p => p.day && !state.trip.days.some(d => d.date === p.day));
  if (orphan.length) out.push(`<h2>指定的那天不在行程里（${orphan.length}）</h2><div class="card">${orphan.map(placeRow).join('')}</div>`);
  const free = todo.filter(p => !p.day);
  if (free.length) out.push(`<h2>让算法分（${free.length}）</h2><div class="card">${free.map(placeRow).join('')}</div>`);
  if (done.length) out.push(`<h2>去过了 / 不去了（${done.length}）</h2><div class="card">${done.map(placeRow).join('')}</div>`);
  return out.join('');
}
// 香港：路线上要走的店，按天、按顺序；点一站跳到行程页那天
function renderRouteStops() {
  const out = [];
  let i = 0;
  for (const dv of plan.days) {
    if (!dv.stops || !dv.stops.length) continue;
    const n = dv.stops.reduce((m, s) => m + s.parts.length, 0);
    out.push(`<h2>${esc(dayLabel(dv.date))} 要走的（${n} 站）</h2><div class="card tight">`);
    for (const s of dv.stops) for (const p of s.parts) {
      i++;
      const items = p.items.filter(it => !it.isPlace);
      const meta = [esc(p.addr), p.hoursToday ? (p.isPlace ? '能去 ' : '营业 ') + esc(p.hoursToday) : '', items.length ? `买 ${items.length} 样` : ''].filter(Boolean).join(' · ');
      out.push(`<div class="list-row"><span class="idx">${i}</span><div class="grow" data-act="dayGo" data-date="${dv.date}"><b>${esc(p.name)}</b> <span class="num small muted">${hm(p.begin)}–${hm(p.end)}</span>
        <div class="muted small">${meta}</div>${items.length ? `<div class="small">${items.map(it => esc(it.name)).join('、')}</div>` : ''}</div></div>`);
    }
    out.push('</div>');
  }
  if (!i) out.push('<p class="muted small">路线上还没有店：到「说话」页粘贴清单，或者说一句想买什么。</p>');
  return out.join('');
}
function placeRow(p) {
  const meta = [
    p.at != null ? `${toHM(p.at)} 开始` : '', `待 ${p.dur} 分钟`, p.walk ? `另加来回走路 ${p.walk} 分钟` : '',
    p.from != null || p.to != null ? `${toHM(p.from ?? 0)}–${toHM(p.to ?? 1440)} 能去` : '',
    p.must === false ? '顺路才去' : '', p.addr || p.how || '',
  ].filter(Boolean).join(' · ');
  const flag = p.status === 'todo' && !p.hours && p.from == null && p.to == null && p.at == null ? '<div class="flag small">营业时间未核实，按 10:00–20:00 算</div>' : '';
  return `<div class="list-row"><div class="grow" data-act="editPlace" data-id="${esc(p.id)}">
    <b>${esc(p.name)}</b> <span class="tag">${esc(Trip.KINDS[p.kind] || '其他')}</span>${p.status === 'todo' ? '' : `<span class="tag">${p.status === 'done' ? '去过了' : '不去了'}</span>`}
    <div class="muted small">${esc(meta)}</div>${flag}</div>${p.link ? `<a class="small" href="${esc(p.link)}" target="_blank" rel="noopener">原帖</a>` : ''}</div>`;
}

// ---------------- 收藏箱：小红书 / 大众点评 / 抖音里收藏的店，先收进来，再一条条加到这趟 ----------------

function renderInbox() {
  const list = root.inbox || [];
  const st = Trips.inboxStats(root);
  const fresh = list.filter(e => !e.used && !e.dropped).sort((a, b) => String(b.got || '').localeCompare(String(a.got || '')));
  const done = list.filter(e => e.used || e.dropped).sort((a, b) => String(b.got || '').localeCompare(String(a.got || '')));
  const out = [`<h2>收藏箱 <span class="tag blue">${st.fresh} 条还没处理</span></h2>`];
  out.push(`<div class="card">
    <p class="small muted">${st.total ? `一共 ${st.total} 条，上次收进来 ${esc(fmtGot(st.last))}。` : '小红书 / 大众点评 / 抖音里收藏的店，从这里进来。'}再导一次只进新的，重复的自动跳过。</p>
    <div class="row"><button class="grow" data-act="inboxFile">导入收藏文件</button><button class="grow" data-act="inboxPaste">粘贴分享文字</button></div>
    <input type="file" id="inbox-file" accept=".txt,text/plain" hidden>
    <p class="small muted">怎么让文件自己长：看「给Nathan_手机快捷指令.md」——在三个 app 里点分享 → 「存到出行」，就记进手机里的一个文件。</p>
  </div>`);
  if (fresh.length) out.push(`<div class="card tight">${fresh.map(e => inboxRow(e, false)).join('')}</div>`);
  if (done.length) {
    out.push(`<div class="row"><button class="quiet grow" data-act="toggleInboxDone">${showInboxDone ? '收起已处理的' : `看已处理的（${done.length}）`}</button></div>`);
    if (showInboxDone) out.push(`<div class="card tight">${done.map(e => inboxRow(e, true)).join('')}</div>`);
  }
  return out.join('');
}
// 一条的状态字：加到了哪一趟 / 不要了；趟被删了就写地区名
function inboxStatusText(e) {
  if (e.dropped) return '不要了';
  if (e.used) { const t = root.trips[e.used]; return `已加到「${t && t.trip && t.trip.name ? t.trip.name : Trip.REGIONS[region()].name}」`; }
  return '';
}
function inboxRow(e, isDone) {
  const sub = e.addr || String(e.text || '').slice(0, 60);
  return `<div class="list-row"><div class="grow" data-act="inboxOpen" data-id="${esc(e.id)}"><b>${esc(e.name || e.title || '（没有名字）')}</b> ${e.source ? `<span class="tag">${esc(e.source)}</span>` : ''}${isDone ? `<span class="tag">${esc(inboxStatusText(e))}</span>` : ''}
    ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>
    ${isDone ? '' : `<div class="acts"><button data-act="inboxAdd" data-id="${esc(e.id)}">加到这趟</button><button class="quiet" data-act="inboxDrop" data-id="${esc(e.id)}">不要了</button></div>`}</div>`;
}
function inboxPasteSheet() {
  sheet(`<h2>粘贴分享文字</h2>
    <p class="small muted">小红书 / 大众点评 / 抖音里点分享 → 复制链接（或复制文字），贴进来；一次贴很多条也行。</p>
    <textarea id="inbox-text" style="min-height:120px"></textarea>
    <div class="row" style="margin-top:12px"><button class="primary grow" data-act="inboxPasteDo">收下</button><button class="quiet" data-act="closeSheet">取消</button></div>`);
}
function inboxOpenSheet(id) {
  const e = (root.inbox || []).find(x => x.id === id);
  if (!e) return;
  const isDone = !!(e.used || e.dropped);
  sheet(`<h2>${esc(e.name || e.title || '（没有名字）')}</h2>
    <p class="small">${e.source ? `<span class="tag">${esc(e.source)}</span>` : ''}${isDone ? `<span class="tag">${esc(inboxStatusText(e))}</span>` : ''}${e.got ? `<span class="muted">收进来 ${esc(fmtGot(e.got))}</span>` : ''}</p>
    ${e.addr ? `<p class="small">${esc(e.addr)}</p>` : ''}
    ${e.text ? `<p class="small muted" style="white-space:pre-wrap">${esc(e.text)}</p>` : ''}
    ${e.url ? `<p class="small"><a href="${esc(e.url)}" target="_blank" rel="noopener">打开原帖</a></p>` : ''}
    <div class="row" style="margin-top:12px">${isDone ? '' : `<button class="primary grow" data-act="inboxAdd" data-id="${esc(e.id)}">加到这趟</button><button class="quiet danger" data-act="inboxDrop" data-id="${esc(e.id)}">不要了</button>`}<button class="quiet" data-act="closeSheet">关掉</button></div>`);
}
// 收：分享文字 / 收藏文件 → 认出店 → 只进新的。认不出一条就直说，什么都不改。
function inboxIngest(text, from) {
  const entries = parseShare(String(text || ''));
  if (!entries.length) { alert('这段文字里认不出店：要有店名或链接。'); return false; }
  let r = { added: 0, skipped: 0 };
  const ok = mutate(() => { r = Trips.addToInbox(root, entries); });
  if (!ok) return false;
  toast(`认出 ${entries.length} 条，新收 ${r.added} 条${r.skipped ? '，' + r.skipped + ' 条已有' : ''}`, true);
  return true;
}
// 「加到这趟」：开地方表单，名字 / 备注先填上；位置要人定（收藏里没有坐标）。香港：按名字猜一个港铁站先选上。
function inboxAdd(id) {
  const e = (root.inbox || []).find(x => x.id === id);
  if (!e) return;
  if (!state) { alert('先在「我的出行」建一趟，再往里加'); return; }
  let st = '';
  if (region() === 'hk') {
    const hay = [e.addr, e.name, e.text].filter(Boolean).join(' ');
    const hit = stations.find(s => hay.includes(s.name));
    if (hit) st = hit.code;
  }
  pendingInboxId = id;
  editPlace(null, { name: e.name || e.title || '', note: [e.source, e.addr].filter(Boolean).join(' · '), link: e.url || '', st });
}

async function doSearch() {
  const q = ($('#q') && $('#q').value.trim()) || '';
  if (!q) { alert('先写要搜什么'); return; }
  let prov;
  try { prov = makeProv(); } catch (e) { alert(e.message); return; }
  const near = state.trip.home || state.places.find(p => p.status === 'todo') || null;
  const btn = $('[data-act=search]'); if (btn) { btn.disabled = true; btn.textContent = '正在搜…'; }
  try {
    const hits = await prov.search(q, { near: near ? { lat: near.lat, lng: near.lng } : undefined, city: state.trip.city || undefined });
    pendingHits = hits;
    sheet(`<h2>搜「${esc(q)}」</h2>${hits.length ? '' : '<p class="muted">没搜到。换个写法，或者加上城市名。</p>'}
      <div class="card" style="margin:0">${hits.map((h, i) => `<div class="list-row"><div class="grow"><b>${esc(h.name)}</b> <span class="tag">${esc(Trip.KINDS[h.kind] || '其他')}</span>
        <div class="muted small">${esc(h.addr || '')}${h.hoursText ? ' · ' + esc(h.hoursText.split('\n')[0]) : ''}${h.hours ? '' : ' · 营业时间未核实'}</div></div>
        <button data-act="addHit" data-idx="${i}">加进来</button></div>`).join('')}</div>
      <div class="row" style="margin-top:12px"><button class="quiet grow" data-act="closeSheet">关掉</button></div>`);
  } catch (e) { alert(e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '搜'; } }
}
function addHit(i) {
  const h = pendingHits && pendingHits[i];
  if (!h) return;
  const done = mutate(() => {
    const pl = Trip.addPlace(state, {
      name: h.name, addr: h.addr || '', lat: h.lat, lng: h.lng, sys: h.sys, placeId: h.placeId || null, citycode: h.citycode || null,
      kind: h.kind || 'other', hours: h.hours || null, hoursText: h.hoursText || '', hoursVerified: !!h.hoursVerified, phone: h.phone || '',
      source: h.source || providerName(), how: '搜到的',
    });
    if (pendingInboxId) {   // 从收藏箱来、走了「联网搜这个名字」这条路：记回收藏箱，原帖链接带上
      const e = (root.inbox || []).find(x => x.id === pendingInboxId);
      if (e && e.url) pl.link = e.url;
      Trips.markInbox(root, pendingInboxId, { used: root.current });
    }
  }, `加了「${h.name}」，已重排（路程还没取，先按直线估）`);
  if (done) { closeSheet(); pendingHits = null; pendingInboxId = null; }
}

// ---------------- 首页：我的出行（规格 15.2 / 15.7） ----------------

function renderHome() {
  const rows = Trips.listTrips(root);
  const out = ['<h1>我的出行</h1>'];
  if (!storeOk) out.push(`<div class="note err">这台手机存不下来（可能是无痕模式）：关掉 app 会丢。</div>`);
  const cur = rows.find(r => r.current) || null;
  if (cur && state) out.push(heroHTML(cur));
  else out.push(`<div class="card hero"><div class="eyebrow">还没有出行</div><div class="title">说一句就能建一趟</div><div class="sub">比如「10月8日去深圳」「国庆去香港三天」</div>
    <button class="primary big" style="margin-top:16px" data-act="newTripSheet">新的一趟</button></div>`);
  const others = rows.filter(r => !r.current);
  const live = others.filter(r => r.phase !== 'past'), past = others.filter(r => r.phase === 'past');
  const PH = { now: '进行中', future: '将来', past: '过去' };
  const row = r => `<div class="list-row"><div class="cover">${trailSVG(root.trips[r.id].trail, { w: 44, h: 44, mini: true, animate: false }) || '<span class="cover-empty"></span>'}</div>
      <div class="grow" data-act="openTrip" data-id="${esc(r.id)}"><b>${esc(r.name)}</b> <span class="tag">${esc(Trip.REGIONS[r.region].name)}</span><span class="tag">${PH[r.phase]}</span>
        <div class="muted small">${esc(tripDates(r))} · ${esc(tripCounts(r))}</div></div>
      <button class="sm" data-act="openTrip" data-id="${esc(r.id)}">${r.phase === 'past' ? '回顾' : '打开'}</button></div>`;
  if (live.length) out.push(`<h2>其他出行（${live.length}）</h2><div class="card tight">${live.map(row).join('')}</div>`);
  if (past.length) {   // 过去的收着：存档在，不跟眼前这趟抢位置
    out.push(`<h2 class="row" style="justify-content:space-between"><span>过去的出行（${past.length}）</span><button class="quiet sm" data-act="togglePast">${showPast ? '收起' : '展开'}</button></h2>`);
    if (showPast) out.push(`<div class="card tight">${past.map(row).join('')}</div>`);
  }
  if (cur && state) out.push(`<div class="row" style="margin-top:16px"><button class="grow" data-act="newTripSheet">＋ 新的一趟</button></div>`);
  return out.join('');
}
let showPast = false;
const tripDates = r => !r.from ? '还没定日期' : r.from === r.to ? dayLabel(r.from) : `${dayLabel(r.from, false)}–${dayLabel(r.to, false)}（${r.nDays} 天）`;
// 香港那趟的「地方」是数据里的店，不在 places 里——数「站」要看排出来的路线（只有当前这趟排了）；别的地区数 places
function tripCounts(r) {
  const bits = [];
  if (r.region === 'hk') { const n = r.current && plan && plan.ok ? planStops(plan) : 0; if (n) bits.push(`${n} 站`); if (r.nItems) bits.push(`${r.nItems} 样东西`); }
  else { bits.push(`${r.nPlaces} 个地方`); if (r.nItems) bits.push(`${r.nItems} 样东西`); }
  return bits.join(' · ') || '还没安排';
}
const planStops = p => p.days.reduce((n, d) => n + (d.stops ? d.stops.reduce((m, s) => m + s.parts.length, 0) : 0), 0);
function heroHTML(r) {
  const R = region(), rn = Trip.REGIONS[R].name;
  const today = Trip.localDateStr();
  const ds = state.trip.days.map(d => d.date);
  const focus = ds.includes(today) ? today : ds.find(d => d >= today) || ds[ds.length - 1] || null;   // 今天在行程里就看今天，否则看最近的那天
  const dv = plan && plan.ok && focus ? plan.days.find(d => d.date === focus) : null;
  const todoItems = state.items.filter(i => i.status === 'todo').length;
  const stops = plan && plan.ok ? planStops(plan) : 0;
  const todoPlaces = state.places.filter(p => p.status === 'todo').length;
  const eyebrow = [r.phase === 'now' ? '进行中' : r.phase === 'future' ? (r.from ? `${daysUntil(r.from)}` : '将来') : '过去', rn].join(' · ');
  const stat = (v, k, unit) => `<div class="stat"><div class="v">${Number.isFinite(v) ? `<span data-count="${v}">${v}</span>` : v}${unit ? `<small>${unit}</small>` : ''}</div><div class="k">${k}</div></div>`;
  const stats = [stat(r.nDays || 0, '天数', '天'),
    R === 'hk' ? stat(stops, '要走的店', '站') : stat(todoPlaces, '要去的地方', '个'),
    stat(todoItems, R === 'hk' ? '还没买' : '要买的东西', '样')].join('');
  let next = '';
  if (dv && !dv.cannotReturn && dv.stops.length) {
    const parts = dv.stops.flatMap(s => s.parts);
    const shown = parts.slice(0, 6);
    next = `<div class="next"><div class="eyebrow">${esc(dayLabel(focus))}${focus === today ? ' · 今天' : ''}</div>
      <div class="kv"><span class="k">出发</span><span class="v"><span class="num">${hm(dv.start.time)}</span> ${esc(dv.start.name)}</span></div>
      <div class="kv"><span class="k">回到</span><span class="v"><span class="num">${hm(dv.end.arrive)}</span> ${esc(dv.end.name)}<span class="faint">（最晚 ${hm(dv.end.deadline)}）</span></span></div>
      <ul class="mini">${shown.map(p => { const n = p.items.filter(it => !it.isPlace).length; return `<li><span class="num">${hm(p.begin)}</span><span class="n">${esc(p.name)}</span>${n ? `<span class="c">${n} 样</span>` : ''}</li>`; }).join('')}
      ${parts.length > shown.length ? `<li><span class="num"></span><span class="n muted">还有 ${parts.length - shown.length} 站，在「行程」页</span></li>` : ''}</ul></div>`;
  } else if (!state.items.length && !state.places.length) next = `<div class="next muted small">还没有想去的地方。到「说话」页说一句，或者在「地方」页加。</div>`;
  else if (dv && dv.cannotReturn) next = `<div class="next"><div class="flag">${esc(dayLabel(focus))}这天回不去了，去「行程」页看</div></div>`;
  else if (plan && !plan.ok) next = `<div class="next"><div class="flag">排不出来：${esc(plan.error)}</div></div>`;
  const map = trailSVG(state.trail, { w: 343, h: 200, mtr: R === 'hk' ? data.mtr : null });
  const from = state.from ? `<div class="small faint" style="margin-top:4px">照「${esc(state.from.name)}」${state.from.date ? `（${esc(dayLabel(state.from.date, false))}）` : ''}那趟复制的</div>` : '';
  const btns = r.phase === 'past'
    ? `<button class="primary grow" data-act="review">回顾这趟</button><button class="grow" data-act="dupSheet" data-id="${esc(state.id)}">再来一次</button>`
    : `<button class="primary grow" data-act="go" data-tab="trip">看行程</button><button class="grow" data-act="go" data-tab="speech">说一句</button>`;
  return `<div class="card hero"><div class="eyebrow">${esc(eyebrow)}</div><div class="title">${esc(r.name)}</div><div class="sub">${esc(tripDates(r))}${state.trip.home ? ` · 住${esc(state.trip.home.name)}` : ''}</div>${from}
    ${map ? `<div class="map" data-act="review">${map}</div>` : ''}
    <div class="stats">${stats}</div>${next}
    <div class="row" style="margin-top:14px">${btns}</div></div>`;
}

// ---------------- 回顾（Nathan 0924：「有点回顾氛围的那种」）：地图 + 轨迹 + 这趟怎么样 ----------------

function renderReview() {
  const R = region(), rn = Trip.REGIONS[R].name;
  const tr = trailWithStatus(state);
  const rows = Trips.listTrips(root); const r = rows.find(x => x.current) || { phase: 'future', from: null, to: null, nDays: state.trip.days.length, name: state.trip.name || rn };
  const out = [`<div class="row" style="margin:4px 0 0"><button class="quiet sm" data-act="go" data-tab="home">‹ 我的出行</button></div>`];
  out.push(`<div class="eyebrow" style="margin-top:12px">${r.phase === 'past' ? '回顾' : r.phase === 'now' ? '进行中' : '还没出发'} · ${esc(rn)}</div><h1 style="margin-top:2px">${esc(r.name)}</h1><div class="muted" style="margin:-6px 0 12px">${esc(tripDates(r))}${state.trip.home ? ` · 住${esc(state.trip.home.name)}` : ''}</div>`);
  const map = tr ? trailSVG(tr, { w: 343, h: 300, mtr: R === 'hk' ? data.mtr : null }) : '';
  if (map) out.push(`<div class="card map-card"><div class="map">${map}</div><div class="legend"><span><i class="sw port"></i>出发 / 回到</span><span><i class="sw stop"></i>要去的店</span><span><i class="sw got"></i>买到了</span>${R === 'hk' ? '<span><i class="sw base"></i>港铁</span>' : ''}</div></div>`);
  else out.push('<div class="note">还没有路线，所以没有轨迹。到「说话」页说一句，或者在「地方」页加。</div>');
  // 这趟怎么样：数结果
  const items = state.items || [], places = state.places || [];
  const got = items.filter(i => ['bought', 'enough'].includes(i.status)).length;
  const notEnough = items.filter(i => i.status === 'notEnough').length;
  const skipped = items.filter(i => i.status === 'skip').length;
  const todo = items.filter(i => i.status === 'todo').length;
  const noStock = items.filter(i => (i.noStock || []).length).length;
  const visited = places.filter(p => p.status === 'done').length;
  const nStops = tr ? tr.days.reduce((n, d) => n + d.stops.length, 0) : 0;
  const mins = tr ? Math.round(tr.days.reduce((n, d) => n + (d.end && d.end.arrive != null && d.start ? d.end.arrive - d.start.time : 0), 0)) : 0;
  const stat = (v, k, unit) => `<div class="stat"><div class="v">${Number.isFinite(v) ? `<span data-count="${v}">${v}</span>` : v}${unit ? `<small>${unit}</small>` : ''}</div><div class="k">${k}</div></div>`;
  out.push(`<div class="card"><div class="eyebrow">这趟怎么样</div><div class="stats" style="margin-top:10px">${[
    stat(nStops, '要走的店', '站'), stat(got, R === 'hk' ? '买到' : '买到 / 去过', '样'), stat(items.length ? todo : visited, items.length ? '还没买' : '去过的地方', items.length ? '样' : '个'),
  ].join('')}</div>
    <div class="kv"><span class="k">在外面</span><span class="v num">${mins ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : '—'}</span></div>
    ${noStock ? `<div class="kv"><span class="k">碰上没货</span><span class="v">${noStock} 样（下次照这趟复制时，没货的记号会清掉）</span></div>` : ''}
    ${notEnough ? `<div class="kv"><span class="k">没买够</span><span class="v">${notEnough} 样</span></div>` : ''}
    ${skipped ? `<div class="kv"><span class="k">跳过</span><span class="v">${skipped} 样</span></div>` : ''}
    ${state.from ? `<div class="kv"><span class="k">照着</span><span class="v">「${esc(state.from.name)}」${state.from.date ? esc(dayLabel(state.from.date, false)) : ''} 那趟</span></div>` : ''}
  </div>`);
  // 轨迹：一天一段，每站几点到、买了什么
  if (tr) for (const d of tr.days) {
    if (!d.stops.length) continue;
    out.push(`<h2>${esc(dayLabel(d.date))}${d.start ? ` · <span class="num">${hm(d.start.time)}</span> 从${esc(d.start.name)}出发` : ''}</h2><div class="card tight">`);
    d.stops.forEach((s, i) => {
      const its = s.items.map(it => `<span class="tag ${['bought', 'enough'].includes(it.status) ? 'ok' : it.noStock ? 'bad' : it.status === 'skip' || it.status === 'notEnough' ? 'warn' : ''}">${esc(it.name)}${it.noStock ? '·没货' : it.status === 'skip' ? '·跳过' : it.status === 'notEnough' ? '·没买够' : it.status === 'todo' ? '' : ''}</span>`).join('');
      out.push(`<div class="list-row"><span class="idx">${i + 1}</span><div class="grow"><b>${esc(s.name)}</b> <span class="num small muted">${hm(s.begin)}–${hm(s.end)}</span>${s.addr ? `<div class="muted small">${esc(s.addr)}</div>` : ''}${its ? `<div style="margin-top:4px">${its}</div>` : ''}</div></div>`);
    });
    if (d.end && d.end.arrive != null) out.push(`<div class="list-row"><span class="idx" style="background:transparent;color:var(--ink3)">▪</span><div class="grow muted"><span class="num">${hm(d.end.arrive)}</span> 回到${esc(d.end.name)}</div></div>`);
    out.push('</div>');
  }
  // 说过的话
  if ((state.speech || []).length) out.push(`<h2>说过的（${state.speech.length}）</h2><div class="card tight">${state.speech.slice(-5).reverse().map(h => `<div class="list-row"><div class="grow"><div>${esc(h.text)}</div><div class="muted small">${esc(fmtWhen(h.at))}</div></div></div>`).join('')}</div>`);
  out.push(`<div class="row" style="margin-top:20px"><button class="primary grow" data-act="dupSheet" data-id="${esc(state.id)}">照这趟再来一次</button><button class="grow" data-act="exportCopy">复制这趟的备份</button></div>
    <p class="muted small">再来一次 = 地方、要买的东西、酒店、每天几点出发都带过去，只改日期；买到没买到从头记。这趟本身留在这，不动。</p>`);
  return out.join('');
}
function dupSheet(id) {
  const t = root.trips[id]; if (!t) return;
  const name = t.trip.name || Trip.REGIONS[t.trip.region].name;
  const ds = (t.trip.days || []).map(d => d.date).sort();
  const def = ds[0] && ds[0] > Trip.localDateStr() ? ds[0] : Trip.localDateStr();
  sheet(`<h2>照「${esc(name)}」再来一次</h2>
    <p class="small muted">带过去：${t.places.length ? `${t.places.length} 个地方、` : ''}${t.items.length ? `${t.items.length} 样东西、` : ''}${t.trip.home ? '酒店、' : ''}每天几点出发几点回${ds.length > 1 ? `（${ds.length} 天，日期整体平移）` : ''}。买到 / 去过 / 没货的记号从头记。</p>
    <label class="f">这次叫什么</label><input id="dup-name" value="${esc(name)}">
    <label class="f">第一天</label><input type="date" id="dup-date" value="${def}">
    <div class="row" style="margin-top:16px"><button class="primary grow" data-act="dupDo" data-id="${esc(id)}">建这趟</button><button class="quiet" data-act="closeSheet">关掉</button></div>`);
}
function daysUntil(date) {
  const n = Math.round((new Date(date + 'T00:00') - new Date(Trip.localDateStr() + 'T00:00')) / 864e5);
  return n === 0 ? '今天' : n === 1 ? '明天' : n === 2 ? '后天' : n > 0 ? `${n} 天后` : '过去';
}
function newTripSheet() {
  sheet(`<h2>新的一趟</h2>
    <label class="f">说一句就行，比如「10月8日去深圳」「国庆去香港三天」；什么都不说就只选地区</label>
    <textarea id="nt-text" style="min-height:80px" placeholder="10月8日去深圳"></textarea>
    <label class="f">去哪个地区（句子里说了城市会自动判断）</label>
    <select id="nt-region">${Object.entries(Trip.REGIONS).map(([k, v]) => `<option value="${k}">${esc(v.name)}${k === 'hk' ? '（内置数据，不联网）' : `（联网用${PROVIDER_NAME[v.provider]}）`}</option>`).join('')}</select>
    <div class="row" style="margin-top:16px"><button class="primary grow" data-act="newTrip">建这趟</button><button class="quiet" data-act="closeSheet">关掉</button></div>`);
}

// 首页「建这趟」：句子先过规则层拿 名字 / 地区 / 城市 / 哪几天；有地方的话建完接着「听懂」（走完整流程，含 AI）
function newTripFromBox() {
  const text = ($('#nt-text') ? $('#nt-text').value : '').trim();
  const sel = $('#nt-region').value;
  let d = null;
  if (text) {
    try { d = parseSpeech(text, { today: Trip.localDateStr(), days: [], region: sel }); }
    catch (e) { alert('没听懂这句：' + e.message); return; }
  }
  const region = (d && d.trip && d.trip.region && Trip.REGIONS[d.trip.region]) ? d.trip.region : sel;
  const dates = d ? [...new Set(d.days.map(x => x.date).filter(Boolean))] : [];
  const city = (d && d.trip && d.trip.city) || '';
  const name = (d && d.trip && d.trip.name) || city || '';
  const hasMore = d && (d.days.some(x => x.entries.length) || d.unknown.length || (d.hkList || []).length);
  let made = null;
  if (!mutate(() => { made = Trips.newTrip(root, { region, name, city, days: dates }); }, `建了「${name || Trip.REGIONS[region].name}」${dates.length ? `，${dates.length} 天` : ''}`)) return;
  closeSheet();
  tab = hasMore ? 'speech' : 'trip'; render(); window.scrollTo(0, 0);
  if (hasMore) listen(text);
  void made;
}

// ---------------- 说话（规格 15.7）；香港的「要买的东西」也在这页 ----------------

function renderSpeech() {
  const R = region();
  const out = ['<h1>说话</h1>'];
  const aiCap = Number(root.settings.caps.ai) || 0;
  const aiLine = aiReady() ? `AI：${aiName()} · 今天听了 ${usedToday('ai')} 次${aiCap ? `，上限 ${aiCap}` : ''}` : 'AI 还没填钥匙（设置 → AI），先按规则听';
  // 说话页交代清楚三件事：能说什么（三类，各给一句能点的例子）、按了会发生什么、什么时候才真的加进去
  //（Nathan 0924 看了说「这个说话的模块看着比较抽象，该交代什么说的不是很清楚」）
  const EX = R === 'hk'
    ? ['明天上午去元朗买老婆饼，然后去中环', '10月2日去香港两天，住尖沙咀', '给同事带两盒合桃酥']
    : ['10月8日去深圳，住福田', '明天上午去人才公园，然后去附近的免税店', '给同事带两盒特产'];
  out.push(`<div class="card">
    <div class="eyebrow">能说三类话 · 一句一件事</div>
    <div class="kv stack"><span class="k">哪天去 / 去几天</span><span class="v">「10月8日去深圳」「国庆去香港三天」</span></div>
    <div class="kv stack"><span class="k">去哪、先后顺序</span><span class="v">「上午去人才公园，然后去附近的免税店」</span></div>
    <div class="kv stack"><span class="k">买什么、给谁</span><span class="v">「给同事带两盒特产」</span></div>
    <label class="f" style="margin-top:12px">照着说，或者点一句例子填进去改：</label>
    <div class="row" style="margin-bottom:8px">${EX.map(t => `<button class="sm" data-act="spExample" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <textarea id="sp-text" placeholder="比如：${esc(EX[1])}">${esc(pendingDraft ? pendingDraft.text : '')}</textarea>
    <div class="row" style="margin-top:10px"><button class="primary grow" data-act="listen" ${listening ? 'disabled' : ''}>听懂</button>${R === 'hk' ? '<button data-act="paste">粘贴清单</button>' : ''}</div>
    <p class="small muted">按「听懂」→ 它把这段话拆成【哪天 / 去哪 / 买什么】列给你看 → 你点「对」才会加进行程，不对可以先改。${R === 'hk' ? '「粘贴清单」是把一整份采买清单（一行一样）贴进来。' : ''}</p>
    <p class="small muted">${esc(aiLine)}${navigator.onLine ? '' : ' · 现在没网，按规则听的；找地方要等联网'}。</p>
  </div>`);
  const hist = state.speech || [];
  if (hist.length) {
    out.push(`<h2>说过的（${hist.length}）</h2><div class="card">`);
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      const bits = [`加了 ${h.added.length} 个地方`];
      if (h.items) bits.push(`${h.items} 样东西`);
      if (h.notFound.length) bits.push(`<span class="flag">${h.notFound.length} 条没找到</span>`);
      if (h.unknown) bits.push(`<span class="flag">${h.unknown} 句没听懂</span>`);
      out.push(`<div class="list-row"><div class="grow" data-act="speechOpen" data-idx="${i}"><div>${esc(h.text)}</div>
        <div class="muted small">${esc(fmtWhen(h.at))} · ${esc(h.note)} · ${bits.join('，')}</div></div></div>`);
    }
    out.push('</div>');
  }
  if (R === 'hk') out.push(renderListBody());
  return out.join('');
}
const fmtWhen = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${toHM(d.getHours() * 60 + d.getMinutes())}`; };

// 一条「说过的」点开：原话 + 没找到的 + 没听懂的，能再听一遍
function speechOpen(i) {
  const h = (state.speech || [])[i];
  if (!h) return;
  sheet(`<h2>这段话</h2><p>${esc(h.text)}</p><p class="small muted">${esc(fmtWhen(h.at))} · ${esc(h.note)}</p>
    ${h.added.length ? `<h3>加了（${h.added.length}）</h3><p class="small">${h.added.map(esc).join('、')}</p>` : ''}
    ${h.noted && h.noted.length ? `<h3>按这趟的酒店算的（${h.noted.length}）</h3><p class="small">${h.noted.map(n => esc(n.text)).join('、')}</p>` : ''}
    ${h.notFound.length ? `<h3>没找到（${h.notFound.length}）</h3><div class="card" style="margin:0">${h.notFound.map(n => `<div class="list-row"><div class="grow"><b>${esc(n.name)}</b><div class="muted small">${esc(n.text)} · ${esc(n.why)}</div></div></div>`).join('')}</div>` : ''}
    ${h.unknownText && h.unknownText.length ? `<h3>没听懂（${h.unknownText.length}）</h3><div class="card" style="margin:0">${h.unknownText.map(u => `<div class="list-row"><div class="grow"><b>${esc(u.text)}</b><div class="muted small">${esc(u.why)}</div></div></div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:12px"><button class="primary grow" data-act="speechAgain" data-idx="${i}">再听一遍（会再加一次）</button><button class="quiet" data-act="closeSheet">关掉</button></div>`);
}

// 「听懂」：规则层永远跑；有钥匙且有网就再问 AI，AI 成了用 AI 的。两层都出 Draft，界面只认 Draft（规格 15.4）。
async function listen(text) {
  text = (text ?? ($('#sp-text') ? $('#sp-text').value : '')).trim();
  if (!text) { alert('先说一句'); return; }
  if (listening) return;
  listening = true;
  const btn = $('[data-act=listen]'); if (btn) { btn.disabled = true; btn.textContent = '正在听…'; }
  const ctx = { today: Trip.localDateStr(), days: state.trip.days.map(d => d.date), region: region(), city: state.trip.city || '', home: state.trip.home ? state.trip.home.name : null };
  let draft, note, hkList = [], doc = null;
  try {
    if (isPlanDoc(text)) {
      // 一整份计划：标题里的日期当「哪天」，购物行走清单读法，其余行原样当那天的备注。不发给 AI（分拣不需要它，而且它会把称呼当地方）
      doc = parsePlanDoc(text, { today: ctx.today });
      draft = { trip: {}, days: doc.date ? [{ date: doc.date, entries: [] }] : [], unknown: [], hkList: doc.shopLines };
      hkList = doc.shopLines;
      note = `按一份计划读的：${doc.date ? dayLabel(doc.date) : '没写哪天'} · ${doc.shopLines.length} 行要买的 · ${doc.notes.length} 条备注`;
    } else {
    draft = parseSpeech(text, ctx);
    hkList = draft.hkList || [];
    note = '按规则听的';
    // 「店～东西」那种行走老清单读法（规格 15.5），不发给 AI
    const aiText = hkList.length ? text.split('\n').filter(l => !hkList.includes(l.trim())).join('\n').trim() : text;
    if (aiReady() && navigator.onLine && aiText) {
      try {
        const r = await makeAIClient().parse(aiText, ctx);
        draft = r.draft;
        note = `${aiName()} 听的` + (r.dropped && r.dropped.length ? `（${r.dropped.length} 条对不上原话，降成没听懂）` : '') + (r.truncated ? '（太长，只听了前 4000 字）' : '');
      } catch (e) { note = `AI 没连上（${e.message}），按规则听的`; }
    } else if (aiReady() && !navigator.onLine) note = '现在没网，按规则听的';
    }
  } catch (e) { alert('没听懂：' + e.message); listening = false; render(); return; }
  listening = false;
  let hkItems = [];
  if (hkList.length && (region() === 'hk' || doc)) {   // 整份计划里的购物行，不是香港也照读（认不出在哪买的进「没看懂」，照样加）
    const r = parseList(hkList.join('\n'), data);
    hkItems = [...r.items, ...r.unknown.map(u => ({ id: u.id, name: u.name, qty: u.qty || 1, who: u.who || [], note: u.note || '', where: null, must: true, heavy: false, backupFor: null, status: 'todo', src: u.src, why: u.why }))];
  }
  pendingDraft = { text, draft: { trip: draft.trip || {}, days: draft.days || [], unknown: draft.unknown || [] }, note, hkItems, doc };
  render();
  showDraft();
}

const ENTRY_KINDS = { ...Trip.KINDS, stay: '住的酒店' };
const slotText = e => e.at != null ? `${toHM(e.at)} 开始` : (e.from != null || e.to != null) ? `${toHM(e.from ?? 0)}–${toHM(e.to ?? 1440)}` : '';

// 确认页（规格 15.6 第 1 步）：按天列出，每条能改名字 / 类别 / 哪天 / 待多久 / 要不要 / 删；没听懂的单独一块
function showDraft() {
  const pd = pendingDraft; if (!pd) return;
  const D = pd.draft, R = region();
  const dayOpts = (cur) => {
    const ds = state.trip.days.map(d => d.date);
    const extra = cur && !ds.includes(cur) ? [cur] : [];
    return `<option value="" ${!cur ? 'selected' : ''}>让算法分</option>` + [...ds, ...extra].map(d => `<option value="${d}" ${d === cur ? 'selected' : ''}>${esc(dayLabel(d))}${ds.includes(d) ? '' : '（会加这一天）'}</option>`).join('');
  };
  const nEntries = D.days.reduce((n, d) => n + d.entries.length, 0);
  const out = [`<h2>我听成这样（${nEntries} 个地方${D.unknown.length ? `，${D.unknown.length} 句没听懂` : ''}${pd.hkItems.length ? `，${pd.hkItems.length} 样要买的` : ''}）</h2><p class="small muted">${esc(pd.note)}。改好了点最下面「对，找地方并排进去」。</p>`];
  if (pd.doc) {
    const dc = pd.doc;
    out.push(`<div class="card"><div class="eyebrow">这份计划</div>
      <div class="kv stack"><span class="k">哪天</span><span class="v">${dc.date ? esc(dayLabel(dc.date)) + (Trip.findDay(state, dc.date) ? '' : '（不在行程里，会加这一天）') : '标题里没写日期，东西按「让算法分」'}</span></div>
      ${dc.task ? `<div class="kv stack"><span class="k">主要任务</span><span class="v">${esc(dc.task)}</span></div>` : ''}
      ${dc.notes.length ? `<div class="kv stack"><span class="k">备注（原样记在那天顶上，不当地方）</span><span class="v">${dc.notes.map(esc).join('<br>')}</span></div>` : ''}
    </div>`);
  }
  if (D.trip && (D.trip.city || D.trip.name || D.trip.region) && (D.trip.city && D.trip.city !== state.trip.city)) {
    out.push(`<label class="row inset" style="margin:8px 0"><input type="checkbox" id="dr-city"> 把这趟的城市改成「${esc(D.trip.city)}」（现在是「${esc(state.trip.city || '没定')}」）</label>`);
  }
  D.days.forEach((d, di) => {
    const inTrip = !d.date || Trip.findDay(state, d.date);
    if (!d.entries.length) {
      // 「8号到10号」「玩两天」带出来的空天：不在行程里的会加，已在行程里的不用说
      if (d.date && !inTrip) out.push(`<h3>${esc(dayLabel(d.date))} <span class="tag warn">这天没说去哪，会加这一天</span></h3>`);
      return;
    }
    out.push(`<h3>${d.date ? esc(dayLabel(d.date)) : '没说哪天（让算法分）'}${inTrip ? '' : ' <span class="tag warn">不在行程里，会加这一天</span>'}</h3><div class="card" style="margin:0 0 8px">`);
    d.entries.forEach((e, ei) => {
      if (e.ref === 'home') {   // 「回酒店」「回家」：按这趟的酒店 / 口岸算，不另搜、不另加
        out.push(`<div class="part" data-e="${di},${ei}" data-ref="home"><div class="row"><span class="grow"><b>${esc(e.name === '家' ? '回家' : '回酒店：' + e.name)}</b></span><button class="quiet danger" data-act="draftDel" data-d="${di}" data-i="${ei}">删</button></div>
          <div class="muted small" style="margin-top:4px">${[esc(e.text), slotText(e), e.dur ? `待 ${e.dur} 分钟` : '', '每天本来就从这出发、回这，不另加地方'].filter(Boolean).join(' · ')}</div></div>`);
        return;
      }
      out.push(`<div class="part" data-e="${di},${ei}">
        <div class="row"><input class="de-name grow" value="${esc(e.name)}" placeholder="地方名（联网搜的关键词）"><button class="quiet danger" data-act="draftDel" data-d="${di}" data-i="${ei}">删</button></div>
        <div class="row" style="margin-top:6px"><select class="de-kind grow">${Object.entries(ENTRY_KINDS).map(([k, v]) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <select class="de-day grow">${dayOpts(d.date)}</select>
          <input class="de-dur" type="number" inputmode="numeric" style="width:6em" value="${e.dur ?? ''}" placeholder="分钟">
          <select class="de-must"><option value="1" ${e.must !== false ? 'selected' : ''}>一定去</option><option value="0" ${e.must === false ? 'selected' : ''}>顺路才去</option></select></div>
        <div class="muted small" style="margin-top:4px">${[esc(e.text), e.near === 'prev' ? '上一处附近' : e.near ? `${esc(e.near)}附近` : '', slotText(e), e.days > 1 ? `连着 ${e.days} 天` : '', (e.buy || []).length ? '买：' + esc(e.buy.join('、')) : ''].filter(Boolean).join(' · ')}</div>
      </div>`);
    });
    out.push('</div>');
  });
  if (D.unknown.length) {
    out.push(`<h3>没听懂（${D.unknown.length}）—— 原话留着，你定</h3><div class="card" style="margin:0 0 8px">`);
    D.unknown.forEach((u, ui) => out.push(`<div class="list-row"><div class="grow"><b>${esc(u.text)}</b><div class="muted small">${esc(u.why || '')}</div></div>
      <button data-act="draftAsPlace" data-i="${ui}">当地方名搜</button><button class="quiet" data-act="draftDropUnknown" data-i="${ui}">删</button></div>`));
    out.push('</div>');
  }
  if (pd.hkItems.length) {
    out.push(`<h3>要买的（${pd.hkItems.length}，按老清单读的）</h3><div class="card" style="margin:0 0 8px">${pd.hkItems.map(it => `<div class="list-row"><div class="grow"><b>${esc(it.name)}</b>${it.qty > 1 ? ` ×${it.qty}` : ''} ${it.why ? `<span class="tag warn">没看懂：${esc(it.why)}</span>` : tagsOf(it)}<div class="muted small">${esc(it.where ? whereText(it) : '')}</div></div></div>`).join('')}</div>`);
  }
  const willSearch = R === 'hk' ? 0 : D.days.reduce((n, d) => n + d.entries.filter(e => e.ref !== 'home').length + d.entries.filter(e => e.near && e.near !== 'prev').length, 0);   // 每条 1 次，「A 附近的」先搜 A 再 1 次；回酒店那条不搜
  const canSearch = R === 'hk' || hasKey();
  out.push(`<p class="small muted">${R === 'hk' ? '香港不联网：牌子变成要买的东西、说到港铁站的按站算，其余要去「地方」页手动加。' : canSearch ? `要联网搜 ${willSearch} 次（${PROVIDER_NAME[providerName()]}，今天已用 ${usedToday(providerName())}）。每个地方默认取搜到的第 1 家，排进去以后在「地方」页能换。` : `<span class="flag">还没填${PROVIDER_NAME[providerName()]}的钥匙，找不了地方：先去设置填，或者先点「对」记下来、之后再找。</span>`}</p>
    <div class="row" style="margin-top:12px"><button class="primary grow" data-act="draftCommit" ${listening ? 'disabled' : ''}>对，找地方并排进去</button><button class="quiet" data-act="closeSheet">先不加</button></div>`);
  sheet(out.join(''));
}
// 把确认页上改过的字读回草稿（删一条要重画，先读回来，不然改的字丢了）
function readDraftEdits() {
  const pd = pendingDraft; if (!pd) return;
  for (const el of $$('[data-e]')) {
    const [di, ei] = el.dataset.e.split(',').map(Number);
    const e = pd.draft.days[di] && pd.draft.days[di].entries[ei]; if (!e) continue;
    if (el.dataset.ref === 'home') continue;   // 回酒店那行只读
    e.name = el.querySelector('.de-name').value.trim() || e.name;
    e.kind = el.querySelector('.de-kind').value;
    e.must = el.querySelector('.de-must').value === '1';
    const dur = el.querySelector('.de-dur').value; e.dur = dur === '' ? null : Math.max(0, Number(dur) || 0);
    const day = el.querySelector('.de-day').value || null;
    if (day !== (pd.draft.days[di].date || null)) e._moveTo = day;   // 换了天：下面统一搬
  }
  // 搬到别的天
  for (const d of pd.draft.days) for (const e of [...d.entries]) if ('_moveTo' in e) {
    const to = e._moveTo; delete e._moveTo;
    d.entries.splice(d.entries.indexOf(e), 1);
    let target = pd.draft.days.find(x => (x.date || null) === to);
    if (!target) { target = { date: to, entries: [] }; pd.draft.days.push(target); }
    target.entries.push(e);
  }
  const c = $('#dr-city'); pd.applyCity = !!(c && c.checked);
}

// 香港不联网（规格 15.6 第 2 步）：牌子 → 要买的东西；说到港铁站 → 站附近的地方；其余没找到
function hkResolve(e, prevHit) {
  const brand = data.brands.find(b => e.name.includes(b.brand));
  if (brand) {
    const name = (e.buy || []).length ? e.buy.join('、') : e.name.replace(brand.brand, '').trim() || brand.brand;
    return { item: { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, qty: 1, who: [], note: e.text, where: { type: 'brand', brand: brand.brand }, must: e.must !== false, heavy: false, backupFor: null, status: 'todo', src: e.text } };
  }
  const nearName = e.near && e.near !== 'prev' ? e.near : '';
  const st = stations.find(s => (nearName || e.name).includes(s.name)) || (nearName ? stations.find(s => e.name.includes(s.name)) : null);
  if (st) return { hit: { name: e.name, addr: '', lat: st.lat, lng: st.lng, sys: 'wgs84', source: 'station', how: `在${st.name}站附近（说话）`, walk: 10 } };
  if (e.near === 'prev' && prevHit) return { hit: { name: e.name, addr: '', lat: prevHit.lat, lng: prevHit.lng, sys: 'wgs84', source: 'station', how: '上一处附近（说话）', walk: 10 } };
  return { why: '香港版不联网找地方：去「地方」页手动加（定位 / 选港铁站）' };
}

// 「对」→ 逐条找地方 → 一次写进 state → 重排（规格 15.6 第 2–4 步）。三道守恒的第二道在这：条数 = 加进去的 + 没找到的 + 酒店
async function commitDraft() {
  readDraftEdits();
  const pd = pendingDraft; if (!pd || listening) return;
  const R = region(), D = pd.draft;
  const entries = []; D.days.forEach(d => d.entries.forEach(e => entries.push({ ...e, date: d.date || null })));
  const homeRefs = entries.filter(e => e.ref === 'home');   // 「回酒店」「回家」：记下来，不搜不加（行程本来就从酒店 / 口岸出发回去）
  const stays = entries.filter(e => e.kind === 'stay' && e.ref !== 'home'), rest = entries.filter(e => e.kind !== 'stay' && e.ref !== 'home');
  let prov = null, provErr = '';
  if (R !== 'hk' && entries.length) { try { prov = makeProv(); } catch (e) { provErr = e.message; } }
  listening = true;
  const btn = $('[data-act=draftCommit]'); if (btn) btn.disabled = true;
  const added = [], notFound = [], items = [...pd.hkItems];
  let prevHit = null, stop = null, i = 0;
  const search = async (q, near) => prov.search(q, { near: near ? { lat: near.lat, lng: near.lng } : undefined, city: state.trip.city || undefined });
  for (const e of rest) {
    i++; if (btn) btn.textContent = `找地方 ${i}/${rest.length}…`;
    let hit = null, why = null;
    if (stop) why = stop;
    else if (!e.name) why = '没有地方名';
    else if (R === 'hk') { const r = hkResolve(e, prevHit); if (r.item) { items.push(r.item); continue; } hit = r.hit || null; why = r.why || null; }
    else if (!prov) why = provErr;
    else {
      try {
        let near = null;
        if (e.near === 'prev') near = prevHit;
        else if (e.near) { const nh = await search(e.near, null); if (nh.length) near = nh[0]; }
        if (!near && state.trip.home) near = state.trip.home;
        const hits = await search(e.name, near);
        if (hits.length) hit = { ...hits[0], others: hits.length - 1 }; else why = '联网没搜到，换个写法或加上城市名再说一遍';
      } catch (err) { why = err.message; if (err.kind === 'cap' || err.kind === 'key' || err.kind === 'quota') stop = err.message; }
    }
    if (hit) { prevHit = hit; added.push({ e, hit }); } else notFound.push({ e, why: why || '没找到' });
  }
  // 酒店：搜到了问一句要不要设成这趟的酒店；没搜到进「没找到」
  let home = null;
  for (const e of stays) {
    let hit = null, why = null;
    if (R === 'hk' || !prov) why = R === 'hk' ? '香港的行程从口岸出发，不用酒店；要住的地方去「地方」页加' : provErr;
    else if (stop) why = stop;
    else { try { const hs = await search(e.name, state.trip.home); if (hs.length) hit = hs[0]; else why = '联网没搜到'; } catch (err) { why = err.message; } }
    if (hit && !home && confirm(`「${hit.name}」${hit.addr ? '（' + hit.addr + '）' : ''}设成这趟的酒店？每天默认从这出发、回这。`)) home = { hit, e };
    else if (hit) notFound.push({ e, why: '你没设成酒店，这条没加' });
    else notFound.push({ e, why });
  }
  listening = false;
  const newDays = [];
  const ok = mutate(() => {
    // 「8号到10号」「玩两天」说到的天，哪怕那天没说去哪也加上（确认页上标过「会加这一天」）
    for (const d of D.days) if (d.date && !Trip.findDay(state, d.date)) { Trip.addDay(state, d.date); newDays.push(d.date); }
    if (pd.doc && pd.doc.date && Trip.findDay(state, pd.doc.date)) {   // 整份计划：主要任务 + 后勤行当那天的备注，行程页概要卡下面显示
      const prev = Trip.findDay(state, pd.doc.date).note || '';
      const add = [pd.doc.task, ...pd.doc.notes].filter(Boolean).join('\n');
      if (add) Trip.updateDay(state, pd.doc.date, { note: prev && !prev.includes(add) ? prev + '\n' + add : (prev.includes(add) ? prev : add) });
    }
    for (const { e, hit } of added) {
      if (e.date && !Trip.findDay(state, e.date)) { Trip.addDay(state, e.date); newDays.push(e.date); }
      Trip.addPlace(state, {
        name: hit.name, addr: hit.addr || '', lat: hit.lat, lng: hit.lng, sys: hit.sys, placeId: hit.placeId || null, citycode: hit.citycode || null,
        kind: Trip.KINDS[e.kind] ? e.kind : 'other', hours: hit.hours || null, hoursText: hit.hoursText || '', hoursVerified: !!hit.hoursVerified, phone: hit.phone || '',
        source: hit.source || providerName() || 'manual', how: hit.how || (hit.others ? `说话找到的（还有 ${hit.others} 家同名，不对就在这里换）` : '说话找到的'), walk: hit.walk || 0,
        day: e.date, at: e.date ? e.at ?? null : null, from: e.from ?? null, to: e.to ?? null, dur: e.dur ?? null, must: e.must !== false,
        note: [e.text, (e.buy || []).length ? '买：' + e.buy.join('、') : ''].filter(Boolean).join(' · '),
      });
    }
    if (items.length) P.addItems(state, items);
    if (home) Trip.setHome(state, { lat: home.hit.lat, lng: home.hit.lng, name: home.hit.name, addr: home.hit.addr || '', citycode: home.hit.citycode || null });
    if (pd.applyCity && D.trip && D.trip.city) state.trip.city = D.trip.city;
    (state.speech = state.speech || []).push({
      at: new Date().toISOString(), text: pd.text, note: pd.note,
      added: added.map(a => a.hit.name).concat(home ? [`酒店：${home.hit.name}`] : []), items: items.length,
      noted: homeRefs.map(e => ({ name: e.name === '家' ? '回家' : '回酒店', text: e.text })),
      notFound: notFound.map(n => ({ name: n.e.name, text: n.e.text, why: n.why })),
      unknown: D.unknown.length, unknownText: D.unknown.map(u => ({ text: u.text, why: u.why || '' })), days: newDays,
    });
    // ★ 第二道守恒：条数 = 加进去的 + 没找到的 + 酒店 + 变成东西的（hk）。对不上就不写，出声
    const hkItems = items.length - pd.hkItems.length;
    if (added.length + notFound.length + (home ? 1 : 0) + hkItems + homeRefs.length !== entries.length) throw new Error(`数不对：${entries.length} 条，加了 ${added.length}、没找到 ${notFound.length}、酒店 ${home ? 1 : 0}、东西 ${hkItems}、回酒店 ${homeRefs.length}。这次没加，跟我说一声`);
  }, `加了 ${added.length} 个地方${items.length ? `、${items.length} 样东西` : ''}${home ? '，酒店定好了' : ''}${newDays.length ? `，加了 ${newDays.map(d => dayLabel(d, false)).join('、')}` : ''}${homeRefs.length ? `；「回酒店」${homeRefs.length} 句按这趟的酒店算，没另加` : ''}${notFound.length ? `；${notFound.length} 条没找到` : ''}，已重排`);
  if (!ok) { render(); return; }
  closeSheet(); pendingDraft = null; tab = 'trip'; render(); window.scrollTo(0, 0);
  if (notFound.length) alert(`${notFound.length} 条没找到（「说话」页点那段话能看到）：\n` + notFound.map(n => `· ${n.e.name}：${n.why}`).join('\n'));
}

function renderListBody() {
  const out = [`<h2>要买的东西</h2><div class="row"><button class="grow" data-act="newItem">加一样</button></div>`];
  const todo = state.items.filter(i => i.status === 'todo');
  const done = state.items.filter(i => i.status !== 'todo');
  out.push(`<h2>还没买（${todo.length}）</h2>`);
  out.push(todo.length ? `<div class="card">${todo.map(listRow).join('')}</div>` : '<p class="muted">没有了。</p>');
  if (done.length) {
    out.push(`<h2>已处理（${done.length}）</h2><div class="card">`);
    for (const it of done) out.push(`<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}"><b>${esc(it.name)}</b> <span class="tag ${it.status === 'bought' || it.status === 'enough' ? 'ok' : ''}">${STATUS_TEXT[it.status]}</span></div>
      <button class="quiet" data-act="mark" data-id="${esc(it.id)}" data-status="todo">恢复</button></div>`);
    out.push('</div>');
  }
  out.push('<p class="muted small">自己加的地方（吃饭、取货）在「地方」页。</p>');
  return out.join('');
}
function listRow(it) {
  const meta = [it.qty > 1 ? `×${it.qty}` : '', whoText(it), it.note].filter(Boolean).join(' · ');
  return `<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}">
    <b>${esc(it.name)}</b> ${tagsOf(it)}
    <div class="muted small">${esc(whereText(it))}${meta ? ' · ' + esc(meta) : ''}</div></div></div>`;
}

// ---------------- 设置 ----------------

function keyOfPt(p) {
  if (!p) return region() === 'hk' ? 'port' : 'home';
  return p.kind === 'port' ? 'port' : p.kind === 'home' ? 'home' : p.kind === 'station' ? 'station:' + p.code : p.kind === 'place' ? 'place:' + p.id : p.kind;   // here / geo 保持原样
}
function ptOfKey(k, cur) {
  if (k === 'port' || k === 'home') return { kind: k };
  if (k === 'here' || k === 'geo') return cur;
  const [kind, id] = k.split(':');
  return kind === 'station' ? { kind, code: id } : { kind, id };
}
function pointOptions(cur, forEnd) {
  const o = [], k = keyOfPt(cur), R = region();
  const sel = v => k === v ? 'selected' : '';
  if (R === 'hk') {
    if (forEnd) for (const e of P.END_OPTIONS) o.push(`<option value="${e.station ? 'station:' + e.station : 'port'}" ${sel(e.station ? 'station:' + e.station : 'port')}>${esc(e.name)}</option>`);
    else o.push(`<option value="port" ${sel('port')}>深圳湾口岸</option>`);
  } else {
    o.push(`<option value="home" ${sel('home')}>酒店${state.trip.home ? `（${esc(state.trip.home.name)}）` : '（还没定）'}</option>`);
  }
  if (cur && cur.kind === 'here') o.push(`<option value="here" selected>我上次定位的位置</option>`);
  if (cur && cur.kind === 'geo') o.push(`<option value="geo" selected>${esc(cur.name || '一个位置')}</option>`);
  if (R === 'hk') o.push(`<optgroup label="港铁站">${stations.map(s => `<option value="station:${s.code}" ${sel('station:' + s.code)}>${esc(s.name)}</option>`).join('')}</optgroup>`);
  if (state.places.length) o.push(`<optgroup label="自己加的地方">${state.places.map(p => `<option value="place:${p.id}" ${sel('place:' + p.id)}>${esc(p.name)}</option>`).join('')}</optgroup>`);
  return o.join('');
}

function renderSettings() {
  const S = state.settings, R = region(), p = providerName();
  const home = state.trip.home;
  const out = [`<h1>设置</h1>`];
  out.push(`<h2>行程</h2><div class="card">
    <label class="f">这趟叫什么</label><input id="t-name" value="${esc(state.trip.name || '')}">
    <label class="f">去哪个地区（决定用哪家地图、哪套坐标）</label>
    <select id="t-region">${Object.entries(Trip.REGIONS).map(([k, v]) => `<option value="${k}" ${k === R ? 'selected' : ''}>${esc(v.name)}${k === 'hk' ? '（内置数据，不联网）' : `（联网用${PROVIDER_NAME[v.provider]}）`}</option>`).join('')}</select>
    ${R !== 'hk' ? `<label class="f">城市（联网搜的时候在这附近找）</label><input id="t-city" value="${esc(state.trip.city || '')}" placeholder="比如：东京 / 成都">` : ''}
    <label class="f">酒店（每天默认从这出发、回这）</label>
    <div class="row"><span class="grow small">${home ? `${esc(home.name)}${home.addr ? ' · ' + esc(home.addr) : ''}` : '还没定'}</span><button data-act="homeSheet">${home ? '换' : '定酒店'}</button>${home ? '<button class="quiet danger" data-act="homeClear">清掉</button>' : ''}</div>
    <h3>哪几天</h3>
    ${state.trip.days.map(d => `<div class="inset day-card" data-day="${d.date}">
      <div class="row"><input type="date" class="d-date grow" value="${d.date}"><button class="quiet danger" data-act="delDay" data-date="${d.date}" ${state.trip.days.length > 1 ? '' : 'disabled'}>删这天</button></div>
      <label class="f">从哪出发</label><select class="d-start">${pointOptions(d.start, false)}</select>
      <div class="row"><div class="grow"><label class="f">几点出发</label><input type="time" class="d-t0" value="${toHM(d.startTime)}"></div>
        <div class="grow"><label class="f">最晚几点到终点</label><input type="time" class="d-dl" value="${toHM(d.deadline)}"></div></div>
      <label class="f">最后到哪</label><select class="d-end">${pointOptions(d.end, true)}</select>
    </div>`).join('')}
    <button data-act="addDay">加一天</button>
    ${R === 'hk' ? `<label class="f">每家店至少待几分钟（另外每样加 4 分钟）</label><input type="number" inputmode="numeric" id="s-base" value="${S.base}">
    <label class="f">中秋当天饼家多算几分钟排队</label><input type="number" inputmode="numeric" id="s-queue" value="${S.bakeryQueue}">` : ''}
    <button class="primary big" style="margin-top:14px" data-act="saveSettings">保存并重排</button>
  </div>`);
  if (p) {
    const st = MX.matrixStats(state, null);
    const cap = Number(root.settings.caps[p]) || 0;
    const masked = keys[p] ? `已存（末四位 ${esc(keys[p].slice(-4))}）` : '还没填';
    out.push(`<h2>联网（${PROVIDER_NAME[p]}）</h2><div class="card">
      <label class="f">${PROVIDER_NAME[p]}的钥匙（只存在这台手机里，不进备份）：${masked}</label>
      <div class="row"><input type="password" id="k-key" class="grow" autocomplete="off" placeholder="${keys[p] ? '粘贴新的可以替换' : '粘贴钥匙'}"><button data-act="keySave">存</button></div>
      <div class="row" style="margin-top:8px"><button data-act="keyTest" ${keys[p] ? '' : 'disabled'}>试一下钥匙（算 1 次）</button>${keys[p] ? '<button class="quiet danger" data-act="keyClear">清掉钥匙</button>' : ''}</div>
      <p class="small muted">怎么开账号拿钥匙：看「给Nathan_开账号拿钥匙.md」。${p === 'amap' ? '高德要「Web 服务」那种 key。' : '谷歌要开 Places API (New) 和 Routes API。'}</p>
      <label class="f">每天最多联网多少次（0 = 不封顶）</label><input type="number" inputmode="numeric" id="k-cap" value="${cap}">
      <p class="small muted">今天用了 ${usedToday(p)} 次${cap ? `，上限 ${cap}` : ''}。搜 1 次算 1；取路程按格数算（${p === 'amap' ? '高德一格 1 次' : '谷歌一格 1 个'}）。</p>
      <h3>路程</h3>
      <p class="small muted">${st.points} 个点、${st.pairs} 段路：取到 ${st.have}、查过没路 ${st.noRoute}、还没取 ${st.missing}${st.near ? `，另有 ${st.near} 段很近按走路算` : ''}。${st.lastAt ? `上次取：${esc(new Date(st.lastAt).toLocaleString('zh-CN'))}` : ''}</p>
      <div id="fx-progress">${fetching ? `<div class="progress"><div style="width:${fetching.total ? Math.round(100 * fetching.done / fetching.total) : 0}%"></div></div><p class="small muted">取路程 ${fetching.done}/${fetching.total}…</p>` : ''}</div>
      <div class="row"><button class="grow" data-act="fetchRoutes" ${fetching || !keys[p] ? 'disabled' : ''}>联网取路程（缺 ${st.missing} 段）</button>${fetching ? '<button data-act="fetchCancel">取消</button>' : ''}</div>
      <button class="quiet danger" style="margin-top:8px" data-act="matrixClear" ${Object.keys(state.matrix || {}).length ? '' : 'disabled'}>清掉存好的路程（重新取）</button>
    </div>`);
  }
  const A = root.settings.ai, ap = aiPreset(), aiCap = Number(root.settings.caps.ai) || 0;
  out.push(`<h2>AI（把口语听成行程）</h2><div class="card">
    <label class="f">用哪家</label>
    <select id="ai-preset">${PRESETS.map(x => `<option value="${x.id}" ${A.preset === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="custom" ${A.preset === 'custom' ? 'selected' : ''}>自己填地址</option></select>
    <label class="f">地址（OpenAI 兼容的那种，不带 /chat/completions）</label><input id="ai-base" value="${esc(A.base)}" autocapitalize="off" autocorrect="off">
    <label class="f">模型名</label><input id="ai-model" value="${esc(A.model)}" autocapitalize="off" autocorrect="off">
    ${ap && ap.note ? `<p class="small muted">${esc(ap.note)}</p>` : ''}
    <label class="f">每天最多让 AI 听几次（0 = 不封顶）</label><input type="number" inputmode="numeric" id="ai-cap" value="${aiCap}">
    <button style="margin-top:10px" data-act="aiSave">保存这几项</button>
    <label class="f">钥匙（只存在这台手机里，不进备份）：${keys.ai ? `已存（末四位 ${esc(keys.ai.slice(-4))}）` : (A.preset === 'local' ? '本地模型可以不填' : '还没填')}</label>
    <div class="row"><input type="password" id="ai-key" class="grow" autocomplete="off" placeholder="${keys.ai ? '粘贴新的可以替换' : '粘贴钥匙'}"><button data-act="aiKeySave">存并试一下</button></div>
    <div class="row" style="margin-top:8px"><button data-act="aiTest" ${aiReady() ? '' : 'disabled'}>试一下（算 1 次）</button>${keys.ai ? '<button class="quiet danger" data-act="aiKeyClear">清掉钥匙</button>' : ''}</div>
    <p class="small muted">今天听了 ${usedToday('ai')} 次${aiCap ? `，上限 ${aiCap}` : ''}。发出去的只有框里的字、今天日期、这趟的地区 / 城市 / 哪几天；不发钥匙、不发坐标。怎么拿钥匙：看「给Nathan_开账号拿钥匙.md」。没填也能用：按规则听。</p>
  </div>`);
  out.push(`<h2>这趟</h2><div class="card">
    <div class="row"><button class="grow" data-act="go" data-tab="home">回到「我的出行」</button><button class="danger" data-act="delTrip">删掉这趟</button></div>
    <p class="small muted">删掉这趟 = 它的行程、地方、清单、进度一起没了（8 秒内能撤销）。钥匙和 AI 设置是整个 app 的，不跟趟走。</p>
  </div>`);
  out.push(`<h2>备份（清单只存在这台手机里；不含钥匙）</h2>
  <div class="card">
    <label class="f">这一趟</label>
    <div class="row"><button class="grow" data-act="exportCopy">复制这趟的备份</button>${navigator.share ? '<button class="grow" data-act="exportShare">发到备忘录</button>' : ''}</div>
    <label class="f">全部出行（${Object.keys(root.trips).length} 趟 + 收藏箱 ${(root.inbox || []).length} 条，换手机用这个）</label>
    <div class="row"><button class="grow" data-act="exportAllCopy">复制全部的备份</button>${navigator.share ? '<button class="grow" data-act="exportAllShare">发到备忘录</button>' : ''}</div>
    <label class="f">恢复：把备份文字粘贴进来（一趟的、全部的都认）</label><textarea id="s-import" placeholder="Nathan出行备份 v2 … / Nathan出行全部备份 v3 …"></textarea>
    <button class="big" data-act="importBackup">恢复</button>
  </div>
  <h2>全部清空</h2>
  <div class="card"><button class="danger big" data-act="clearAll">清空这趟的地方、清单和进度</button></div>
  <p class="muted small">${R === 'hk' ? `香港数据 ${esc(data.version)} 版：${data.stores.length} 家店、港铁 ${stations.length} 个站、深圳湾过关巴士 ${data.border.buses.map(b => b.route).join(' ')}。查不到营业时间的店按 10:00–20:00 算，页面上会标「未核实」。` : '没联网取路程的两点之间按直线估，页面上标「估的」。'}时间都是估的，偏保守。</p>`);
  return out.join('');
}

function readSettings() {
  const R0 = region();
  const newRegion = $('#t-region').value;
  const days = $$('[data-day]').map(el => ({
    was: el.dataset.day, date: el.querySelector('.d-date').value,
    start: ptOfKey(el.querySelector('.d-start').value, Trip.findDay(state, el.dataset.day).start),
    startTime: fromHM(el.querySelector('.d-t0').value), end: ptOfKey(el.querySelector('.d-end').value, Trip.findDay(state, el.dataset.day).end),
    deadline: fromHM(el.querySelector('.d-dl').value),
  }));
  for (const d of days) { if (!d.date || d.startTime == null || d.deadline == null) throw new Error('日期或时间没填好'); if (d.deadline <= d.startTime) d.deadline += 24 * 60; }   // 最晚时间填了凌晨 = 过了午夜
  return () => {
    if (newRegion !== R0) Trip.setRegion(state, newRegion);          // ★ 先换地区：它会把名字、城市重置成默认，所以放在最前面
    state.trip.name = $('#t-name').value.trim() || Trip.REGIONS[newRegion].name;
    if ($('#t-city') && newRegion === R0) state.trip.city = $('#t-city').value.trim();   // 换了地区时城市输入框还是旧地区的，不收
    // 换了地区：表单里的起终点、几点出发还是旧地区的默认（香港 7:15 口岸），只收日期，其余用新地区的默认（浏览器里量到过：国外的一天变成 7:15–23:30）
    for (const d of days) { const { was, ...patch } = d; Trip.updateDay(state, was, newRegion !== R0 ? { date: patch.date } : patch); }
    if ($('#s-base')) state.settings.base = Math.max(0, Number($('#s-base').value) || 0);
    if ($('#s-queue')) state.settings.bakeryQueue = Math.max(0, Number($('#s-queue').value) || 0);
    if ($('#k-cap') && newRegion === R0) root.settings.caps[providerName()] = Math.max(0, Number($('#k-cap').value) || 0);   // 换了地区时输入框里还是旧地区那家的上限，不收（浏览器里量到：谷歌的 1500 写进了高德）
  };
}

// ---------------- 联网：取路程、试钥匙 ----------------

function updateProgress() {
  const box = $('#fx-progress');
  if (box) box.innerHTML = fetching ? `<div class="progress"><div style="width:${fetching.total ? Math.round(100 * fetching.done / fetching.total) : 0}%"></div></div><p class="small muted">取路程 ${fetching.done}/${fetching.total}…</p>` : '';
  $('#busy').hidden = !fetching && !planning;
  if (fetching) { $('#busy').hidden = false; $('#busy').textContent = `取路程 ${fetching.done}/${fetching.total}`; } else $('#busy').textContent = '正在排…';
}
async function fetchRoutes() {
  if (fetching) { toast('正在取，等它取完', false); return; }
  let prov;
  try { prov = makeProv(); } catch (e) { alert(e.message); return; }
  fetching = { abort: new AbortController(), done: 0, total: 0 };
  render(); updateProgress();
  let r = null, err = null;
  try {
    r = await MX.fetchMissing({ state, T: null, provider: prov, signal: fetching.abort.signal, save: saveState,
      onProgress: p => { fetching.done = p.done; fetching.total = p.total; updateProgress(); } });
  } catch (e) { err = e; }
  fetching = null;
  updateProgress();
  saveState(); replan(); render();
  if (err) alert(err.kind === 'other' && /取消/.test(err.message) ? '取消了，取到的已经存下来' : `取路程停下来了：${err.message}\n已经取到的存下来了，下次接着取。`);
  else if (r && r.total === 0) toast('路程都有了，不用取', false);
  else {
    toast(`取到 ${r.fetched} 段路程${r.noRoute ? `，${r.noRoute} 段查不到路（按估的）` : ''}，已重排`, false);
    if (r.note) alert(r.note);
  }
}
async function testKey() {
  let prov;
  try { prov = makeProv(); } catch (e) { alert(e.message); return; }
  const btn = $('[data-act=keyTest]'); if (btn) { btn.disabled = true; btn.textContent = '正在试…'; }
  try { const r = await prov.testKey(); alert(r.text); }
  catch (e) { alert(e.message); }
  finally { render(); }
}

// ---------------- 弹出来的表单 ----------------

// 玻璃动效（0924）：关闭时先加 .closing 让它滑下去，200ms 后才清 DOM。系统开了「减少动态效果」就直接清。
// ★ 关到一半又开新弹层：sheet() 要把关闭定时器和 .closing 都撤掉，不然新弹层会被 200ms 后那次清空抹掉。
const noMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let sheetCloseTimer = null;
function sheet(html) {
  clearTimeout(sheetCloseTimer); sheetCloseTimer = null;
  const r = $('#sheet-root'); r.classList.remove('closing');
  r.innerHTML = `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet"><div class="inner">${html}</div></div>`;
}
function closeSheet() {
  const r = $('#sheet-root');
  if (!r.firstChild || sheetCloseTimer) return;            // 没开着 / 已经在关：不重复
  if (noMotion()) { r.innerHTML = ''; return; }
  r.classList.add('closing');
  sheetCloseTimer = setTimeout(() => { sheetCloseTimer = null; r.classList.remove('closing'); r.innerHTML = ''; }, 200);
}

function brandOptions(sel) {
  return data.brands.map(b => `<option value="${esc(b.brand)}" ${sel === b.brand ? 'selected' : ''}>${esc(b.brand)}</option>`).join('');
}
function storeOptions(brand, selected) {
  return data.stores.filter(s => s.brand === brand).map(s => `<option value="${esc(s.id)}" ${selected.includes(s.id) ? 'selected' : ''}>${esc(s.name)}（${esc(s.district || s.addr)}）</option>`).join('');
}

function editItem(id) {
  const isNew = !id;
  const it = isNew ? { id: 'n' + Date.now().toString(36), name: '', qty: 1, who: [], note: '', where: null, must: true, heavy: false, backupFor: null, status: 'todo' } : state.items.find(x => x.id === id);
  if (!it) return;
  const w = it.where || { type: 'none' };
  const typeSel = t => (w.type === t || (t === 'category' && w.type === 'oneOf') || (t === 'branch' && w.type === 'stores')) ? 'selected' : '';
  const brand = w.brand || (w.brands || [])[0] || data.brands[0].brand;
  const selStores = w.stores || w.preferred || [];
  sheet(`<h2>${isNew ? '加一样' : '改这一样'}</h2>
    <label class="f">买什么</label><input id="e-name" value="${esc(it.name)}">
    <div class="row"><div class="grow"><label class="f">数量</label><input id="e-qty" type="number" inputmode="numeric" value="${it.qty || 1}"></div>
      <div class="grow"><label class="f">给谁（逗号隔开）</label><input id="e-who" value="${esc((it.who || []).join('，'))}"></div></div>
    <label class="f">备注</label><input id="e-note" value="${esc(it.note || '')}">
    <label class="f">在哪买</label>
    <select id="e-type">
      <option value="brand" ${typeSel('brand')}>某个牌子，哪家分店都行（挑近的）</option>
      <option value="preferred" ${typeSel('preferred')}>某个牌子，首选某家分店</option>
      <option value="branch" ${typeSel('branch')}>只去指定的分店</option>
      <option value="category" ${typeSel('category')}>几个牌子都行（比如任何药房）</option>
      <option value="place" ${typeSel('place')}>自己加的地方</option>
      <option value="none" ${typeSel('none')}>还不知道</option>
    </select>
    <div id="e-where"></div>
    <label class="f">要不要</label>
    <select id="e-must"><option value="1" ${it.must !== false ? 'selected' : ''}>必买</option><option value="0" ${it.must === false ? 'selected' : ''}>顺路才买（不挤掉必买的）</option></select>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="e-heavy" ${it.heavy ? 'checked' : ''}> 重物，放最后买</label>
    ${it.backupFor ? `<p class="small muted">这是「${esc(it.backupFor)}」的备选：${esc(it.backupFor)}没买够或者去不了才去。</p>` : ''}
    <label class="f">状态</label>
    <select id="e-status">${Object.entries(STATUS_TEXT).map(([k, v]) => `<option value="${k}" ${it.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    ${it.src ? `<p class="small muted">原文：${esc(it.src)}</p>` : ''}
    <div class="row" style="margin-top:16px"><button class="primary grow" data-act="saveItem" data-id="${esc(it.id)}" data-new="${isNew ? 1 : ''}">保存</button>
      ${isNew ? '' : `<button class="danger" data-act="delItem" data-id="${esc(it.id)}">删掉</button>`}<button class="quiet" data-act="closeSheet">取消</button></div>`);
  const drawWhere = () => {
    const t = $('#e-type').value;
    const box = $('#e-where');
    if (t === 'brand') box.innerHTML = `<select id="e-brand">${brandOptions(brand)}</select>`;
    else if (t === 'preferred' || t === 'branch') {
      box.innerHTML = `<select id="e-brand">${brandOptions(brand)}</select><label class="f">${t === 'preferred' ? '首选哪家（可多选）' : '去哪几家（可多选）'}</label><select id="e-stores" multiple>${storeOptions(brand, selStores)}</select>`;
      $('#e-brand').onchange = () => { $('#e-stores').innerHTML = storeOptions($('#e-brand').value, []); };
    } else if (t === 'category') {
      const cur = w.brands || [];
      box.innerHTML = `<label class="f">哪几个牌子都行（可多选）</label><select id="e-brands" multiple>${data.brands.map(b => `<option value="${esc(b.brand)}" ${cur.includes(b.brand) ? 'selected' : ''}>${esc(b.brand)}</option>`).join('')}</select>`;
    } else if (t === 'place') {
      box.innerHTML = state.places.length ? `<select id="e-place">${state.places.map(p => `<option value="${esc(p.id)}" ${w.place === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
        : `<p class="small flag">还没有自己加的地方。先保存，再去「地方」页加。</p>`;
    } else box.innerHTML = '';
  };
  $('#e-type').onchange = drawWhere;
  drawWhere();
}

function readWhere(old) {
  const t = $('#e-type').value;
  const multi = sel => sel ? [...sel.selectedOptions].map(o => o.value) : [];
  if (t === 'none') return null;
  if (t === 'brand') return { type: 'brand', brand: $('#e-brand').value };
  if (t === 'preferred') {
    const pref = multi($('#e-stores'));
    if (!pref.length) return { type: 'brand', brand: $('#e-brand').value };
    return { type: 'preferred', brand: $('#e-brand').value, preferred: pref };
  }
  if (t === 'branch') {
    const st = multi($('#e-stores'));
    if (!st.length) throw new Error('至少选一家分店');
    return { type: 'branch', brand: $('#e-brand').value, stores: st };
  }
  if (t === 'category') {
    const b = multi($('#e-brands'));
    if (!b.length) throw new Error('至少选一个牌子');
    const keepOneOf = old && old.type === 'oneOf';
    return { type: keepOneOf ? 'oneOf' : 'category', brands: b, product: old && old.product };
  }
  if (t === 'place') { const s = $('#e-place'); if (!s) return null; return { type: 'place', place: s.value }; }
  return null;
}

// pre：从收藏箱来的预填 { name, note, link(原帖), st(港铁站 code) }；只在新增时用
function editPlace(id, pre) {
  const isNew = !id;
  const R = region();
  const p = isNew ? { name: '', lat: null, lng: null, kind: 'other', dur: Trip.DEFAULT_DUR.other, day: null, at: null, from: null, to: null, must: true, note: '', how: '', status: 'todo', hoursText: '' } : state.places.find(x => x.id === id);
  if (!p) return;
  if (isNew && pre) { p.name = pre.name || ''; p.note = pre.note || ''; }
  const fromInbox = isNew && pre ? `<p class="small muted">从收藏箱来的：位置要你定（定位 / 贴地图链接 / 选站）${pre.link ? ` · <a href="${esc(pre.link)}" target="_blank" rel="noopener">打开原帖</a>` : ''}</p>
    ${R !== 'hk' && hasKey() ? `<div class="row"><button class="grow" data-act="inboxSearch" data-q="${esc(p.name)}">联网搜这个名字</button></div>` : ''}` : '';
  const linkHint = R === 'cn' ? '贴高德 / 苹果地图的分享链接，或直接写坐标（谷歌的坐标在大陆会偏几百米，不收）' : '贴谷歌 / 苹果地图的分享链接，或直接写坐标';
  sheet(`<h2>${isNew ? '加一个地方' : '改这个地方'}</h2>${fromInbox}
    <label class="f">叫什么</label><input id="p-name" value="${esc(p.name)}" placeholder="比如：吃午饭、朋友家取货">
    <label class="f">在哪${isNew ? '' : '（不改就留着）'}</label>
    <div class="inset" style="margin:0">
      <button class="big" data-act="placeGPS">用我现在的位置</button>
      <label class="f">或者：${linkHint}</label><textarea id="p-link" style="min-height:70px" placeholder="${R === 'cn' ? 'https://surl.amap.com/… 不行；要 uri.amap.com/marker?position=经度,纬度 或 直接写 30.66,104.07' : 'https://www.google.com/maps/…@22.28,114.15…'}"></textarea>
      ${R === 'hk' ? `<label class="f">或者：在哪个港铁站附近</label>
      <div class="row"><select id="p-st" class="grow"><option value="">（不选）</option>${stations.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
        <input id="p-walk" type="number" inputmode="numeric" style="width:6.5em" placeholder="走几分钟"></div>` : ''}
      <p class="small muted" id="p-pos">${p.lat != null ? `现在的位置：${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}${p.how ? '（' + esc(p.how) + '）' : ''}${p.addr ? ' · ' + esc(p.addr) : ''}` : '还没有位置'}</p>
    </div>
    <div class="row"><div class="grow"><label class="f">是什么</label><select id="p-kind">${Object.entries(Trip.KINDS).map(([k, v]) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="grow"><label class="f">待多久（分钟）</label><input id="p-dur" type="number" inputmode="numeric" value="${p.dur}"></div></div>
    <div class="row"><div class="grow"><label class="f">哪天去</label><select id="p-day"><option value="">让算法分</option>${state.trip.days.map(d => `<option value="${d.date}" ${p.day === d.date ? 'selected' : ''}>${esc(dayLabel(d.date))}</option>`).join('')}${p.day && !Trip.findDay(state, p.day) ? `<option value="${esc(p.day)}" selected>${esc(dayLabel(p.day))}（不在行程里）</option>` : ''}</select></div>
      <div class="grow"><label class="f">定好的开始时刻（可空，买了票那种）</label><input id="p-at" type="time" value="${toHM(p.at)}"></div></div>
    <div class="row"><div class="grow"><label class="f">最早几点能去（可空）</label><input id="p-from" type="time" value="${toHM(p.from)}"></div>
      <div class="grow"><label class="f">最晚几点离开（可空）</label><input id="p-to" type="time" value="${toHM(p.to)}"></div></div>
    <p class="small muted">营业时间：${esc(p.hoursText ? p.hoursText.split('\n').join('；') : (p.hours ? '有（搜来的）' : '不知道，按 10:00–20:00 算，页面会标「未核实」；知道的话填上面「几点能去」'))}</p>
    <label class="f">要不要</label>
    <select id="p-must"><option value="1" ${p.must !== false ? 'selected' : ''}>一定去</option><option value="0" ${p.must === false ? 'selected' : ''}>顺路才去</option></select>
    <label class="f">备注（会显示在路线上）</label><input id="p-note" value="${esc(p.note || '')}">
    ${isNew ? '' : `<label class="f">状态</label><select id="p-status"><option value="todo" ${p.status === 'todo' ? 'selected' : ''}>还没去</option><option value="done" ${p.status === 'done' ? 'selected' : ''}>去过了</option><option value="skip" ${p.status === 'skip' ? 'selected' : ''}>不去了</option></select>`}
    <div class="row" style="margin-top:16px"><button class="primary grow" data-act="savePlace" data-id="${esc(p.id || '')}">保存</button>
      ${isNew ? '' : `<button class="danger" data-act="delPlace" data-id="${esc(p.id)}">删掉</button>`}<button class="quiet" data-act="closeSheet">取消</button></div>`);
  $('#sheet-root').dataset.lat = p.lat ?? '';
  $('#sheet-root').dataset.lng = p.lng ?? '';
  $('#sheet-root').dataset.how = p.how || '';
  $('#sheet-root').dataset.link = (isNew && pre && pre.link) || '';   // 原帖链接：存成地方时带上；不从收藏箱来就清空，别沾上上一次的
  if (isNew && pre && pre.st && $('#p-st')) $('#p-st').value = pre.st;
}

function getGPS() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('这台手机不给定位'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(new Error(e.code === 1 ? '没给定位权限（设置 → 隐私 → 定位服务 → Safari 网站）' : '定位没拿到，换贴链接或选站')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}
// 定位 → 这个地区用的坐标（大陆换成高德那套）
async function gpsHere() {
  const g = await getGPS();
  const c = Trip.toRegionCoords(state, g);
  return { ...c, acc: g.acc, how: `手机定位（误差约 ${Math.round(g.acc)} 米${c.sys === 'gcj02' ? '，已换成高德坐标' : ''}）` };
}

function homeSheet() {
  const R = region();
  sheet(`<h2>定酒店</h2>
    <p class="small muted">每天默认从这出发、回这。每一天也能单独改。</p>
    ${R !== 'hk' && hasKey() ? `<label class="f">联网搜（算 1 次）</label><div class="row"><input id="h-q" class="grow" placeholder="酒店名字"><button data-act="homeSearch">搜</button></div><div id="h-hits"></div>` : ''}
    <button class="big" style="margin-top:10px" data-act="homeGPS">用我现在的位置</button>
    <label class="f">或者：贴地图链接 / 直接写坐标</label><textarea id="h-link" style="min-height:60px"></textarea>
    <label class="f">叫什么</label><input id="h-name" value="${esc(state.trip.home ? state.trip.home.name : '酒店')}">
    <div class="row" style="margin-top:12px"><button class="primary grow" data-act="homeSaveLink">按链接 / 坐标存</button><button class="quiet" data-act="closeSheet">取消</button></div>`);
}
function moveDaySheet(id) {
  const p = state.places.find(x => x.id === id);
  if (!p) return;
  sheet(`<h2>「${esc(p.name)}」哪天去</h2>
    <div class="row" style="flex-direction:column;align-items:stretch">
      <button class="big ${!p.day ? 'primary' : ''}" data-act="setDay" data-id="${esc(id)}" data-date="">让算法分</button>
      ${state.trip.days.map(d => `<button class="big ${p.day === d.date ? 'primary' : ''}" data-act="setDay" data-id="${esc(id)}" data-date="${d.date}">${esc(dayLabel(d.date))}</button>`).join('')}
      <button class="quiet" data-act="closeSheet">取消</button></div>`);
}

function pasteSheet() {
  sheet(`<h2>粘贴清单</h2>
    <p class="small muted">一行一样；「店～东西、东西」「东西*2 (店名)」这些写法都认。单独一行的人名当「给谁」。</p>
    <textarea id="l-text" placeholder="恒香饼家～老婆饼、合桃酥"></textarea>
    <div class="row" style="margin-top:10px"><button class="primary grow" data-act="parsePreview">看看怎么理解</button><button class="quiet" data-act="closeSheet">取消</button></div>
    <div id="l-preview"></div>`);
}
let pendingParse = null;
function parsePreview() {
  const text = $('#l-text').value;
  let bk = null;
  try { bk = Trip.importBackup(text); } catch (e) { $('#l-preview').innerHTML = `<div class="note err">这像一份备份，但读不了：${esc(e.message)}</div>`; return; }
  if (bk) { pendingParse = { backup: bk }; $('#l-preview').innerHTML = `<div class="note">这是一份备份：恢复会替换现在的全部清单。</div><button class="primary big" data-act="parseCommit">恢复这份备份</button>`; return; }
  const r = parseList(text, data);
  const unknownItems = r.unknown.map(u => ({ id: u.id, name: u.name, qty: u.qty || 1, who: u.who || [], note: u.note || '', where: null, must: true, heavy: false, backupFor: null, status: 'todo', src: u.src, why: u.why }));
  pendingParse = { items: [...r.items, ...unknownItems] };
  $('#l-preview').innerHTML = `<h2>我是这么理解的（${r.items.length} 样${unknownItems.length ? `，${unknownItems.length} 行没看懂` : ''}）</h2>
    <div class="card">${r.items.map(it => `<div class="list-row"><div class="grow"><b>${esc(it.name)}</b>${it.qty > 1 ? ` ×${it.qty}` : ''} ${tagsOf(it)}
      <div class="muted small">${esc(whereText(it))}${whoText(it) ? ' · ' + esc(whoText(it)) : ''}${it.note ? ' · ' + esc(it.note) : ''}</div></div></div>`).join('')}
    ${unknownItems.map(u => `<div class="list-row"><div class="grow"><b class="flag">没看懂：${esc(u.name)}</b><div class="muted small">${esc(u.why || '')}；照样加进去，之后在清单里点它改</div></div></div>`).join('')}</div>
    <button class="primary big" data-act="parseCommit">全部加进去</button>`;
}

function hereSheet(date) {
  const R = region();
  sheet(`<h2>从这里重排（${esc(dayLabel(date))}）</h2>
    <p class="small muted">从现在的位置、现在的时间（${toHM(nowMin())}）重新排这一天还没去的。</p>
    <button class="primary big" data-act="hereGPS" data-date="${date}">用手机定位</button>
    ${R === 'hk' ? `<label class="f">或者：我在哪个港铁站附近</label>
    <select id="h-st"><option value="">（选一个站）</option>${stations.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>` :
    `<button class="big" style="margin-top:10px" data-act="hereHome" data-date="${date}">从酒店出发</button>`}
    <label class="f">从几点开始算</label><input id="h-t" type="time" value="${toHM(nowMin())}">
    <div class="row" style="margin-top:12px">${R === 'hk' ? `<button class="grow" data-act="hereStation" data-date="${date}">按这个站重排</button>` : ''}<button class="quiet" data-act="closeSheet">取消</button></div>`);
}

// ---------------- 事件 ----------------

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act],[data-tab]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  if (!act && el.dataset.tab) { tab = el.dataset.tab; render(); window.scrollTo(0, 0); return; }
  switch (act) {
    case 'go': tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'undo': undo(); break;
    case 'pickDay': curDay = el.dataset.date; render(); break;
    case 'mark': { const it = state.items.find(x => x.id === id); mutate(() => { P.markItem(state, id, el.dataset.status); const x = state.items.find(y => y.id === id); if (x) { if (el.dataset.status === 'todo') delete x.markedAt; else x.markedAt = new Date().toISOString(); } }, `「${it ? it.name : ''}」${STATUS_TEXT[el.dataset.status]}，已重排`); break; }
    case 'nostock': { const it = state.items.find(x => x.id === id); mutate(() => P.noStockAt(state, id, el.dataset.store), `这家没有「${it ? it.name : ''}」，换别家重排`); break; }
    case 'exclude': mutate(() => P.excludeStore(state, el.dataset.store), `不去 ${storeName(el.dataset.store)}，已重排`); break;
    case 'placeStatus': mutate(() => Trip.updatePlace(state, id, { status: el.dataset.status, markedAt: new Date().toISOString() }), el.dataset.status === 'done' ? '去过了，已重排' : '不去了，已重排'); break;
    case 'moveDay': moveDaySheet(id); break;
    case 'setDay': {
      const d = el.dataset.date || null;
      const p = state.places.find(x => x.id === id);
      mutate(() => Trip.updatePlace(state, id, { day: d, at: d && p && p.day === d ? p.at : null }), d ? `「${p ? p.name : ''}」改到 ${dayLabel(d)}，已重排` : '交给算法分，已重排');
      closeSheet(); break;
    }
    case 'edit': editItem(id); break;
    case 'newItem': editItem(null); break;
    case 'editPlace': editPlace(id); break;
    case 'newPlace': editPlace(null); break;
    case 'closeSheet': closeSheet(); pendingInboxId = null; break;   // 取消 = 收藏箱那条没加成，别让下一个新地方沾上它
    case 'inboxFile': $('#inbox-file').click(); break;
    case 'inboxPaste': inboxPasteSheet(); break;
    case 'inboxPasteDo': if (inboxIngest($('#inbox-text').value, '粘贴')) closeSheet(); break;
    case 'inboxOpen': inboxOpenSheet(id); break;
    case 'inboxAdd': inboxAdd(id); break;
    case 'inboxDrop': mutate(() => Trips.markInbox(root, id, { dropped: true }), '不要了（8 秒内能撤销）'); closeSheet(); break;
    case 'toggleInboxDone': showInboxDone = !showInboxDone; render(); break;
    case 'inboxSearch': { closeSheet(); const q = $('#q'); if (q) q.value = el.dataset.q || ''; doSearch(); break; }   // 不清 pendingInboxId：搜到再「加进来」时记回收藏箱
    case 'paste': pasteSheet(); break;
    case 'parsePreview': parsePreview(); break;
    case 'parseCommit': {
      const pp = pendingParse; pendingParse = null;
      if (!pp) break;
      if (pp.backup) mutate(() => setCurrent(pp.backup), '恢复了备份');
      else mutate(() => P.addItems(state, pp.items), `加了 ${pp.items.length} 样，已重排`);
      closeSheet(); tab = 'speech'; render(); break;
    }
    case 'saveItem': {
      let where;
      const old = el.dataset.new ? null : state.items.find(x => x.id === id);
      try { where = readWhere(old && old.where); } catch (err) { alert(err.message); break; }
      const patch = {
        name: $('#e-name').value.trim() || '（没写名字）', qty: Math.max(1, Number($('#e-qty').value) || 1),
        who: $('#e-who').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean), note: $('#e-note').value.trim(),
        where, must: $('#e-must').value === '1', heavy: $('#e-heavy').checked, status: $('#e-status').value,
      };
      const whereChanged = old && JSON.stringify(old.where) !== JSON.stringify(where);
      if (whereChanged) { patch.forced = null; patch.noStock = []; }
      if (el.dataset.new) mutate(() => P.addItems(state, [{ id, backupFor: null, ...patch }]), `加了「${patch.name}」，已重排`);
      else mutate(() => P.updateItem(state, id, patch), `改好了，已重排`);
      closeSheet(); break;
    }
    case 'delItem': { const it = state.items.find(x => x.id === id); mutate(() => P.removeItem(state, id), `删了「${it ? it.name : ''}」`); closeSheet(); break; }
    case 'search': doSearch(); break;
    case 'addHit': addHit(Number(el.dataset.idx)); break;
    case 'placeGPS': {
      el.textContent = '正在定位…';
      try {
        const g = await gpsHere();
        Object.assign($('#sheet-root').dataset, { lat: g.lat, lng: g.lng, how: g.how });
        $('#p-pos').textContent = `现在的位置：${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}（${g.how}）`;
        el.textContent = '已用现在的位置';
      } catch (err) { el.textContent = '用我现在的位置'; alert(err.message); }
      break;
    }
    case 'savePlace': {
      const ds = $('#sheet-root').dataset;
      const old = id ? state.places.find(x => x.id === id) : null;
      let lat = ds.lat ? Number(ds.lat) : null, lng = ds.lng ? Number(ds.lng) : null, how = ds.how || '';
      // walk = 从港铁站走过去再走回来的分钟数，只有「在某站附近」才有；换成定位 / 链接就归零
      let walk = old && how === (old.how || '') ? (old.walk || 0) : 0;
      let source = old ? old.source : 'manual';
      const link = $('#p-link').value.trim();
      if (link) {
        const c = coordsFromText(link, region());
        if (!c) { alert('这段文字里找不到坐标。短链接离线打不开：在地图里长按那个点复制坐标贴进来，或者用「联网搜」。'); break; }
        if (c.error) { alert(c.error); break; }
        lat = c.lat; lng = c.lng; how = '地图链接'; walk = 0; source = 'link';
      } else if ($('#p-st') && $('#p-st').value) {
        const s = stations.find(x => x.code === $('#p-st').value);
        const w = Math.max(0, Number($('#p-walk').value) || 0);
        lat = s.lat; lng = s.lng; how = `在${s.name}站附近${w ? `，走路约 ${w} 分钟` : ''}`;
        walk = w * 2; source = 'station';
      } else if (how !== (old ? old.how || '' : '') && /定位/.test(how)) source = 'gps';
      if (lat == null) { alert('还没有位置：用定位、贴链接' + (region() === 'hk' ? '、或者选一个站' : '、或者去「地方」页联网搜')); break; }
      const day = $('#p-day').value || null, at = fromHM($('#p-at').value);
      if (at != null && !day) { alert('定了开始时刻，就要选是哪一天'); break; }
      const patch = {
        name: $('#p-name').value.trim() || '（没写名字）', lat, lng, how, walk, source,
        kind: $('#p-kind').value, dur: Math.max(0, Number($('#p-dur').value) || 0),
        day, at, from: fromHM($('#p-from').value), to: fromHM($('#p-to').value),
        must: $('#p-must').value === '1', note: $('#p-note').value.trim(),
      };
      if ($('#p-status')) patch.status = $('#p-status').value;
      const done = id ? mutate(() => Trip.updatePlace(state, id, patch), '改好了，已重排') : mutate(() => {
        const pl = Trip.addPlace(state, patch);
        if (pendingInboxId) {   // 从收藏箱来的：原帖链接带上，收藏箱那条记成「已加到这趟」
          if (ds.link) pl.link = ds.link;
          Trips.markInbox(root, pendingInboxId, { used: root.current });
        }
      }, `加了「${patch.name}」，已重排`);
      if (done) { closeSheet(); pendingInboxId = null; }
      break;
    }
    case 'delPlace': mutate(() => Trip.removePlace(state, id), '删了这个地方'); closeSheet(); break;
    case 'here': hereSheet(el.dataset.date || curDay); break;
    case 'hereGPS': {
      el.textContent = '正在定位…';
      const date = el.dataset.date;
      try {
        const g = await gpsHere();
        const t = fromHM($('#h-t').value) ?? nowMin();
        mutate(() => Trip.updateDay(state, date, { start: { kind: 'here', lat: g.lat, lng: g.lng }, startTime: t }), `从这里（${toHM(t)}）重排`);
        closeSheet();
      } catch (err) { el.textContent = '用手机定位'; alert(err.message); }
      break;
    }
    case 'hereHome': {
      const t = fromHM($('#h-t').value) ?? nowMin();
      if (mutate(() => Trip.updateDay(state, el.dataset.date, { start: { kind: 'home' }, startTime: t }), `从酒店 ${toHM(t)} 重排`)) closeSheet();
      break;
    }
    case 'hereStation': {
      const code = $('#h-st').value;
      if (!code) { alert('选一个站'); break; }
      const t = fromHM($('#h-t').value) ?? nowMin();
      mutate(() => Trip.updateDay(state, el.dataset.date, { start: { kind: 'station', code }, startTime: t }), `从${stations.find(s => s.code === code).name}站 ${toHM(t)} 重排`);
      closeSheet(); break;
    }
    case 'openApp': {   // 先试 app 的链接，没装就开网页版
      const web = el.dataset.web;
      let left = false;
      const onHide = () => { left = true; };
      document.addEventListener('visibilitychange', onHide, { once: true });
      location.href = el.dataset.app;
      setTimeout(() => { document.removeEventListener('visibilitychange', onHide); if (!left && !document.hidden && web) window.open(web, '_blank'); }, 1500);
      break;
    }
    case 'copy': {
      try { await navigator.clipboard.writeText(el.dataset.text); toast('地址复制好了', false); }
      catch { prompt('复制这段：', el.dataset.text); }
      break;
    }
    case 'addDay': mutate(() => Trip.addDay(state), '加了一天'); break;
    case 'delDay': {
      const n = state.places.filter(p => p.day === el.dataset.date).length;
      if (!confirm(`删掉 ${dayLabel(el.dataset.date)}？${n ? `指定在这天的 ${n} 个地方会改成「让算法分」。` : ''}`)) break;
      mutate(() => Trip.removeDay(state, el.dataset.date), '删了这一天'); break;
    }
    case 'homeSheet': homeSheet(); break;
    case 'homeClear': mutate(() => Trip.setHome(state, null), '清掉了酒店'); break;
    case 'homeGPS': {
      el.textContent = '正在定位…';
      try {
        const g = await gpsHere();
        if (mutate(() => Trip.setHome(state, { lat: g.lat, lng: g.lng, name: $('#h-name').value.trim() || '酒店' }), '酒店定好了，已重排')) closeSheet();
      } catch (err) { el.textContent = '用我现在的位置'; alert(err.message); }
      break;
    }
    case 'homeSaveLink': {
      const c = coordsFromText($('#h-link').value.trim(), region());
      if (!c) { alert('这段文字里找不到坐标'); break; }
      if (c.error) { alert(c.error); break; }
      if (mutate(() => Trip.setHome(state, { lat: c.lat, lng: c.lng, name: $('#h-name').value.trim() || '酒店' }), '酒店定好了，已重排')) closeSheet();
      break;
    }
    case 'homeSearch': {
      const q = $('#h-q').value.trim();
      if (!q) { alert('先写酒店名字'); break; }
      let prov; try { prov = makeProv(); } catch (err) { alert(err.message); break; }
      el.disabled = true; el.textContent = '正在搜…';
      try {
        const hits = await prov.search(q, { city: state.trip.city || undefined });
        pendingHits = hits;
        $('#h-hits').innerHTML = hits.length ? `<div class="card" style="margin:8px 0">${hits.map((h, i) => `<div class="list-row"><div class="grow"><b>${esc(h.name)}</b><div class="muted small">${esc(h.addr || '')}</div></div><button data-act="homePick" data-idx="${i}">就这家</button></div>`).join('')}</div>` : '<p class="muted small">没搜到</p>';
      } catch (err) { alert(err.message); }
      finally { el.disabled = false; el.textContent = '搜'; }
      break;
    }
    case 'homePick': {
      const h = pendingHits && pendingHits[Number(el.dataset.idx)];
      if (!h) break;
      if (mutate(() => Trip.setHome(state, { lat: h.lat, lng: h.lng, name: h.name, addr: h.addr || '', citycode: h.citycode || null }), `酒店定为「${h.name}」，已重排`)) { closeSheet(); pendingHits = null; }
      break;
    }
    case 'saveSettings': {
      let apply;
      try { apply = readSettings(); } catch (err) { alert(err.message); break; }
      const newRegion = $('#t-region').value;
      if (newRegion !== region()) {
        const sys = Trip.REGIONS[newRegion].sys;
        const n = state.places.filter(p => p.sys !== sys).length;
        if (!confirm(`换到「${Trip.REGIONS[newRegion].name}」：${n ? `现有 ${n} 个地方是另一套坐标，会全部清掉；` : ''}酒店、每天的起终点和存好的路程会重来。确定？`)) break;
      }
      if (mutate(apply, '设置存好了，已重排')) { tab = 'trip'; render(); }
      break;
    }
    case 'keySave': {
      const p = providerName(); const v = $('#k-key').value.trim();
      if (!v) { alert('先粘贴钥匙'); break; }
      keys[p] = v; $('#k-key').value = '';
      await saveKeys(); render(); toast('钥匙存在这台手机里了；点「试一下钥匙」验一次', false);
      break;
    }
    case 'keyClear': { if (!confirm('清掉这把钥匙？')) break; keys[providerName()] = ''; await saveKeys(); render(); break; }
    case 'keyTest': testKey(); break;
    case 'fetchRoutes': fetchRoutes(); break;
    case 'fetchCancel': if (fetching) fetching.abort.abort(); break;
    case 'matrixClear': if (confirm('清掉存好的路程？下次要重新联网取（算次数）。')) mutate(() => { state.matrix = {}; }, '清掉了，现在按直线估'); break;
    case 'exportCopy': {
      const txt = Trip.exportText(state);
      try { await navigator.clipboard.writeText(txt); toast('备份文字复制好了，贴到备忘录里存着', false); } catch { prompt('复制这段：', txt); }
      break;
    }
    case 'exportShare': { try { await navigator.share({ title: '出行备份', text: Trip.exportText(state) }); } catch { /* 他取消了 */ } break; }
    case 'exportAllCopy': {
      const txt = Trips.exportRoot(root);
      try { await navigator.clipboard.writeText(txt); toast(`全部 ${Object.keys(root.trips).length} 趟的备份复制好了，贴到备忘录里存着`, false); } catch { prompt('复制这段：', txt); }
      break;
    }
    case 'exportAllShare': { try { await navigator.share({ title: '出行全部备份', text: Trips.exportRoot(root) }); } catch { /* 他取消了 */ } break; }
    case 'importBackup': {
      try {
        const bk = Trips.importAny($('#s-import').value);
        if (!bk) { alert('这不是备份文字（开头应该是「Nathan出行备份 v2」或「Nathan出行全部备份 v3」）。清单文字请去「说话」页粘贴。'); break; }
        if (bk.kind === 'root') {
          if (!confirm(`这是全部出行的备份（${bk.n} 趟）。恢复会替换手机上现在的全部出行（${Object.keys(root.trips).length} 趟），确定？（8 秒内能撤销）`)) break;
          if (mutate(() => { root = bk.root; }, `恢复了 ${bk.n} 趟`)) { tab = state ? 'trip' : 'home'; render(); window.scrollTo(0, 0); }
          break;
        }
        if (!confirm('恢复会替换现在这趟的全部行程、地方、清单和进度，确定？')) break;
        mutate(() => setCurrent(bk.state), '恢复好了');
      } catch (err) { alert('恢复失败：' + err.message); }
      break;
    }
    case 'clearAll': if (confirm('清空这趟的地方、清单和进度？（地区和钥匙留着；清完 8 秒内还能撤销）')) mutate(() => setCurrent(Trip.newState(region())), '全部清空了'); break;
    // ---- 出行的集合 / 说话 / AI（规格第十五节） ----
    case 'newTrip': newTripFromBox(); break;
    case 'newTripSheet': newTripSheet(); break;
    case 'dayGo': curDay = el.dataset.date; tab = 'trip'; render(); window.scrollTo(0, 0); break;
    case 'openTrip': { const past = (Trips.listTrips(root).find(x => x.id === id) || {}).phase === 'past'; if (mutate(() => Trips.switchTrip(root, id))) { tab = past ? 'review' : 'trip'; render(); window.scrollTo(0, 0); } break; }
    case 'review': tab = 'review'; render(); window.scrollTo(0, 0); break;
    case 'togglePast': showPast = !showPast; render(); break;
    case 'dupSheet': dupSheet(el.dataset.id); break;
    case 'dupDo': {
      const name = ($('#dup-name') ? $('#dup-name').value : '').trim(), firstDate = $('#dup-date') ? $('#dup-date').value : '';
      if (!firstDate) { alert('先选第一天'); break; }
      if (mutate(() => Trips.dupTrip(root, el.dataset.id, { name, firstDate }), `建了「${name || '这趟'}」，照上次的复制过来了`)) { closeSheet(); tab = 'trip'; render(); window.scrollTo(0, 0); }
      break;
    }
    case 'delTrip': {
      const name = state.trip.name || Trip.REGIONS[region()].name;
      if (!confirm(`删掉「${name}」这趟？行程、地方、清单、进度一起没了（8 秒内能撤销）。`)) break;
      if (mutate(() => Trips.removeTrip(root, root.current), `删了「${name}」`)) { tab = state ? 'trip' : 'home'; render(); window.scrollTo(0, 0); }
      break;
    }
    case 'listen': listen(); break;
    case 'spExample': { const ta = $('#sp-text'); if (ta) { ta.value = el.dataset.text; ta.focus(); } break; }
    case 'speechOpen': speechOpen(Number(el.dataset.idx)); break;
    case 'speechAgain': { const h = (state.speech || [])[Number(el.dataset.idx)]; closeSheet(); if (h) listen(h.text); break; }
    case 'draftDel': { readDraftEdits(); const d = pendingDraft.draft.days[Number(el.dataset.d)]; if (d) d.entries.splice(Number(el.dataset.i), 1); showDraft(); break; }
    case 'draftDropUnknown': { readDraftEdits(); pendingDraft.draft.unknown.splice(Number(el.dataset.i), 1); showDraft(); break; }
    case 'draftAsPlace': {   // 没听懂的那句当地方名去搜：进「没说哪天」那组
      readDraftEdits();
      const [u] = pendingDraft.draft.unknown.splice(Number(el.dataset.i), 1);
      if (!u) break;
      let d = pendingDraft.draft.days.find(x => !x.date); if (!d) { d = { date: null, entries: [] }; pendingDraft.draft.days.push(d); }
      d.entries.push({ text: u.text, name: u.text, kind: 'other', near: null, dur: null, at: null, from: null, to: null, must: true, buy: [] });
      showDraft(); break;
    }
    case 'draftCommit': commitDraft(); break;
    case 'aiSave': {
      const preset = $('#ai-preset').value, base = $('#ai-base').value.trim().replace(/\/+$/, ''), model = $('#ai-model').value.trim();
      if (!base) { alert('地址不能空'); break; }
      if (!/^https:\/\//.test(base)) { alert('地址要 https:// 开头（网页是 https 的，浏览器不让连 http）'); break; }
      root.settings.ai = { preset, base, model };
      root.settings.caps.ai = Math.max(0, Number($('#ai-cap').value) || 0);
      saveState(); render(); toast('AI 设置存好了', false); break;
    }
    case 'aiKeySave': {
      const v = $('#ai-key').value.trim();
      if (!v) { alert('先粘贴钥匙'); break; }
      keys.ai = v; $('#ai-key').value = '';
      await saveKeys(); render();
      aiTest(); break;   // 贴完就试一次（算 1 次），省得他再点
    }
    case 'aiKeyClear': { if (!confirm('清掉 AI 的钥匙？')) break; keys.ai = ''; await saveKeys(); render(); break; }
    case 'aiTest': aiTest(); break;
  }
});
async function aiTest() {
  let ai; try { ai = makeAIClient(); } catch (e) { alert(e.message); return; }
  const btn = $('[data-act=aiTest]'); if (btn) { btn.disabled = true; btn.textContent = '正在试…'; }
  try { const r = await ai.testKey(); alert(r.text); }
  catch (e) { alert(e.message); }
  finally { render(); }
}

// ---------------- 画 ----------------

function render() {
  if (!state && tab !== 'home') tab = 'home';            // 没有当前趟：只能看首页
  if (tab === 'review' && !state) tab = 'home';
  const navTab = tab === 'review' ? 'home' : tab;
  for (const b of document.querySelectorAll('#tabs button')) {
    b.hidden = !state && b.dataset.tab !== 'home';
    if (b.dataset.tab === navTab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const v = $('#view');
  // 换页淡入：只在页签真的变了才重加 .in（重排、改数据引起的同页重画不加，不然每次都闪）
  const pageChanged = tab !== lastTab;
  if (pageChanged) { lastTab = tab; v.classList.remove('in'); void v.offsetWidth; v.classList.add('in'); }
  let html = tab === 'home' ? renderHome() : tab === 'review' ? renderReview() : tab === 'trip' ? renderTrip() : tab === 'places' ? renderPlaces() : tab === 'speech' ? renderSpeech() : renderSettings();
  // 重排要 1–3 秒：这段时间下面还是改之前的路线（刚导入时会显示「0 样 · 0 站」），不说清楚会以为没改上。
  // 按钮照样能点（在店里要连着标几样）。
  if (tab === 'trip' && planning && plan) html = `<div class="note">正在按刚才的改动重排，下面还是改之前的路线…</div><div class="stale">${html}</div>`;
  v.innerHTML = html;
  if (pageChanged) FX.countUpAll(v);   // 大数字只在换页时滚一次；同页重画（改一样东西）不滚，不然每次都从 0 数
  const ps = $('#ai-preset');   // 换预设：把地址、模型名填成那家的（自己填地址时不动）
  if (ps) ps.onchange = () => { const x = PRESETS.find(p => p.id === ps.value); if (x) { $('#ai-base').value = x.base; $('#ai-model').value = x.model; } };
}

async function boot() {
  try {
    data = await fetch('数据/hk.json').then(r => { if (!r.ok) throw new Error('香港数据没下载下来（第一次打开要联网）'); return r.json(); });
  } catch (e) {
    $('#view').innerHTML = `<div class="note err">打不开：${esc(e.message)}</div>`;
    return;
  }
  stations = data.mtr.st.map(([code, name, lat, lng]) => ({ code, name, lat, lng })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  let raw = null;
  try { raw = await kvGet('state'); keys = { google: '', amap: '', ai: '', ...((await kvGet('keys')) || {}) }; usage = (await kvGet('usage')) || {}; } catch { storeOk = false; }
  const wasV3 = !!(raw && raw.v === 3);
  root = Trips.migrateRoot(raw);           // 旧版（一趟）的存档升级成集合；空存档 = 没有趟，先看首页
  state = Trips.currentTrip(root);
  if (raw && !wasV3) saveState();          // 升级了就当场存回去
  if (!state) tab = 'home';
  runPlan = setupPlanner();
  render();
  replan();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
probeGoogle(); window.addEventListener('online', probeGoogle);   // 地图按钮按此刻网络选高德还是谷歌
FX.mountFx();   // 先装动效再 boot：boot 第一次 render 出来的卡片也要错落入场
boot();
// 收藏文件：选中就读、读完清掉 value（同一个文件再选一次也能触发）
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp || inp.id !== 'inbox-file') return;
  const f = inp.files && inp.files[0];
  if (!f) return;
  try { inboxIngest(await f.text(), f.name); } catch (err) { alert('这个文件读不了：' + err.message); }
  inp.value = '';
});
