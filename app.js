// 界面：今天 / 清单 / 设置 三页。算法在 worker.js 里跑（不卡界面），这里只管显示和改 state。
// 规格：../规格.md 第一节、「二之半、随时改」、第八节（地图按钮）、第九节（存储）。
// ★ 清单和进度只存在这台手机里（IndexedDB）；家人清单不进代码（应用规范第四节）。

import { parseList } from './parse.js';
import * as P from './plan.js';
import { hm } from './engine.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toHM = m => { if (m == null || !isFinite(m)) return ''; const x = Math.round(m); return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const fromHM = s => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const STATUS_TEXT = { todo: '还没买', bought: '买到', skip: '跳过', enough: '够了', notEnough: '没买够' };

let data, stations, state, plan = null, tab = 'today', undoSnap = null, toastTimer = null, storeOk = true;
let planSeq = 0, runPlan;

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
async function loadState() {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction(KV).objectStore(KV).get('state');
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}
async function saveState() {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(KV, 'readwrite');
      tx.objectStore(KV).put(JSON.parse(JSON.stringify(state)), 'state');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    storeOk = true;
  } catch (e) {
    storeOk = false;   // ★ 存不下来要出声：关掉 app 会丢
    render();
  }
}

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
    if (!T) T = makeTransit(data);
    try { return P.makePlan(st, data, T); } catch (e) { return { ok: false, error: e.message }; }
  };
}
// 一次只排一遍。排的过程中又改了（在店里连点几样「买到」），只记一笔，这遍排完再按最新的清单排一遍。
// ★ 原来是每改一下就往后台塞一遍：连点三下排三遍，手机上一遍 2–3 秒，最新路线要等 6–9 秒。
let planning = false, planAgain = false;
async function replan() {
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
  plan = r || { ok: false, error: '排路线出错了，改一下清单会再排一次' };   // 空结果会让今天页一直停在「正在排…」
  $('#busy').hidden = true;
  render();
}

// ---------------- 改 state：一律走这里（存盘 + 重排 + 可撤销） ----------------

function mutate(fn, toastText) {
  const before = JSON.stringify(state);
  try { fn(); } catch (e) { alert(e.message); return; }
  undoSnap = before;
  saveState();
  replan();
  render();
  if (toastText) toast(toastText, true);
}
function undo() {
  if (!undoSnap) return;
  state = JSON.parse(undoSnap);
  undoSnap = null;
  saveState(); replan(); render();
  toast('撤销了', false);
}
function toast(text, canUndo) {
  clearTimeout(toastTimer);
  $('#toast-root').innerHTML = `<div class="toast"><span class="grow">${esc(text)}</span>${canUndo ? '<button data-act="undo">撤销</button>' : ''}</div>`;
  toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, canUndo ? 8000 : 3000);   // 能撤销的留久一点：手机上看到、反应过来要几秒
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

// ---------------- 今天 ----------------

function renderToday() {
  const out = [];
  const S = state.settings;
  if (!storeOk) out.push(`<div class="card err">这台手机存不下来（可能是无痕模式）：关掉 app 会丢。先去「设置」复制一份备份。</div>`);
  const todoN = state.items.filter(i => i.status === 'todo').length + state.places.filter(p => p.status === 'todo').length;
  if (!state.items.length && !state.places.length) {
    out.push(`<h1>还没有清单</h1><div class="card"><p>去「清单」页粘贴一段清单文字，或者一样一样加。</p><button class="primary big" data-act="go" data-tab="list">去清单</button></div>`);
    return out.join('');
  }
  out.push(`<h1>${esc(S.date)} 的路线</h1>`);
  if (!plan) { out.push('<p class="muted">正在排…</p>'); return out.join(''); }
  if (!plan.ok) { out.push(`<div class="card err">排不出来：${esc(plan.error)}</div>`); return out.join(''); }
  for (const w of plan.warnings || []) out.push(`<div class="card warn">${esc(w)}</div>`);

  const bought = plan.stops.reduce((n, s) => n + s.parts.reduce((m, p) => m + p.items.length, 0), 0);
  out.push(`<div class="card summary">
    <div class="big-line">${plan.cannotReturn ? '回不去了' : `${bought} 样 · ${plan.stops.length} 站 · 预计 ${hm(plan.end.arrive)} 到${esc(plan.end.name)}`}</div>
    <div class="muted small">从${esc(plan.start.name)} ${hm(plan.start.time)} 出发 · 最晚 ${hm(plan.end.deadline ?? S.deadline)} 到 · 还有 ${todoN} 样没办
      · <span class="tag ${plan.exact ? 'ok' : ''}">${plan.exact ? '已是最顺的排法' : '排法够顺（没试完所有排法）'}</span></div>
    <div class="row" style="margin-top:10px"><button class="primary grow" data-act="here">从这里重排</button><button class="quiet" data-act="go" data-tab="settings">改起终点</button></div>
  </div>`);
  if (plan.cannotReturn) { out.push(`<div class="card err">${esc(plan.text)}</div>`); out.push(renderLeftovers()); return out.join(''); }

  out.push(`<div class="row"><span class="time">${hm(plan.start.time)}</span><b>${esc(plan.start.name)}</b></div>`);
  for (const s of plan.stops) {
    const addr = s.parts.map(p => p.addr || p.name).join('；');
    out.push(legHTML(s.leg, `${s.title} ${addr}`));
    out.push(`<div class="card stop">`);
    s.parts.forEach(p => {
      out.push(`<div class="part">
        <div class="row"><span class="time">${hm(p.begin)}</span><div class="grow"><h3>${esc(p.name)}</h3>
          ${p.wait >= 3 ? `<div class="flag">${hm(p.arrive)} 到，等 ${p.wait} 分钟开门</div>` : ''}</div></div>
        <div class="muted small">${[esc(p.addr), p.hoursToday ? (p.isPlace ? '能去的时间 ' : '当天营业 ') + esc(p.hoursToday) : '', `${hm(p.begin)}–${hm(p.end)} 在店里`].filter(Boolean).join(' · ')}</div>
        ${p.flags.map(f => `<div class="flag">${esc(f)}</div>`).join('')}
        <div style="margin-top:6px">${p.items.map(it => itemRowToday(it, p)).join('')}</div>
        <div class="row" style="margin-top:8px">
          ${p.phone ? `<a class="btn" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">打电话</a>` : ''}
          ${p.isPlace ? '' : `<button class="quiet danger" data-act="exclude" data-store="${esc(p.storeId)}">这家不去了</button>`}
        </div>
      </div>`);
    });
    out.push(`</div>`);
  }
  out.push(legHTML(plan.back, plan.end.name));
  out.push(`<div class="row"><span class="time">${hm(plan.end.arrive)}</span><b>${esc(plan.end.name)}</b><span class="muted small">（最晚 ${hm(plan.end.deadline)}）</span></div>`);
  if (plan.preferredCost) out.push(`<div class="card small">${esc(plan.preferredCost.text)}。</div>`);
  out.push(renderLeftovers());
  out.push(`<p class="muted small">时间都是估的、偏保守；「网上有货」不等于门市一定有。${plan.elapsedMs != null ? `这次排了 ${plan.elapsedMs} 毫秒。` : ''}</p>`);
  return out.join('');
}

function renderLeftovers() {
  const out = [];
  if (plan.dropped && plan.dropped.length) {
    out.push(`<h2>去不了（${plan.dropped.reduce((n, d) => n + d.items.length, 0)} 样）</h2><div class="card">`);
    for (const d of plan.dropped) for (const it of d.items)
      out.push(`<div class="list-row"><div class="grow" data-act="${it.isPlace ? 'editPlace' : 'edit'}" data-id="${esc(it.isPlace ? it.id.slice(6) : it.id)}"><b>${esc(it.name)}</b><div class="muted small">${esc(d.text)}</div></div></div>`);
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

function legHTML(leg, copyText) {
  const L = leg.links;
  return `<div class="leg">${esc(leg.text)}
    <div class="row">
      <a class="btn" href="${esc(L.apple)}">苹果地图</a>
      <button data-act="gmaps" data-app="${esc(L.google)}" data-web="${esc(L.googleWeb)}">谷歌地图</button>
      <button class="quiet" data-act="copy" data-text="${esc(copyText)}">复制地址</button>
    </div></div>`;
}

function itemRowToday(it, part) {
  const meta = [it.qty > 1 ? `×${it.qty}` : '', whoText(it), it.note, it.stockNote].filter(Boolean).join(' · ');
  let acts;
  if (it.isPlace) {
    const pid = it.id.slice(6);
    acts = `<button data-act="placeStatus" data-id="${esc(pid)}" data-status="done">去过了</button><button class="quiet" data-act="placeStatus" data-id="${esc(pid)}" data-status="skip">不去了</button>`;
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
      <div class="name">${esc(it.name)}</div>${meta ? `<div class="muted small">${esc(meta)}</div>` : ''}</div>
    <div class="acts">${acts}</div></div>`;
}

// ---------------- 清单 ----------------

function renderList() {
  const out = [`<h1>清单</h1>
    <div class="row"><button class="primary grow" data-act="paste">粘贴清单</button><button class="grow" data-act="newItem">加一样</button><button class="grow" data-act="newPlace">加一个地方</button></div>`];
  const todo = state.items.filter(i => i.status === 'todo');
  const done = state.items.filter(i => i.status !== 'todo');
  out.push(`<h2>还没买（${todo.length}）</h2>`);
  out.push(todo.length ? `<div class="card">${todo.map(listRow).join('')}</div>` : '<p class="muted">没有了。</p>');
  out.push(`<h2>地方（${state.places.length}）</h2>`);
  out.push(state.places.length ? `<div class="card">${state.places.map(p => `<div class="list-row"><div class="grow" data-act="editPlace" data-id="${esc(p.id)}">
      <b>${esc(p.name)}</b> ${p.status === 'todo' ? '' : `<span class="tag">${p.status === 'done' ? '去过了' : '不去了'}</span>`}
      <div class="muted small">待 ${p.dur} 分钟${p.walk ? `（另加来回走路 ${p.walk} 分钟）` : ''}${p.from != null || p.to != null ? ` · ${toHM(p.from ?? 0)}–${toHM(p.to ?? 1440)} 能去` : ''}${p.how ? ' · ' + esc(p.how) : ''}</div></div></div>`).join('')}</div>`
    : '<p class="muted small">吃饭、取货、朋友家这种数据里没有的地方，在这里加。</p>');
  if (done.length) {
    out.push(`<h2>已处理（${done.length}）</h2><div class="card">`);
    for (const it of done) out.push(`<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}"><b>${esc(it.name)}</b> <span class="tag ${it.status === 'bought' || it.status === 'enough' ? 'ok' : ''}">${STATUS_TEXT[it.status]}</span></div>
      <button class="quiet" data-act="mark" data-id="${esc(it.id)}" data-status="todo">恢复</button></div>`);
    out.push('</div>');
  }
  return out.join('');
}
function listRow(it) {
  const meta = [it.qty > 1 ? `×${it.qty}` : '', whoText(it), it.note].filter(Boolean).join(' · ');
  return `<div class="list-row"><div class="grow" data-act="edit" data-id="${esc(it.id)}">
    <b>${esc(it.name)}</b> ${tagsOf(it)}
    <div class="muted small">${esc(whereText(it))}${meta ? ' · ' + esc(meta) : ''}</div></div></div>`;
}

// ---------------- 设置 ----------------

function pointOptions(cur, forEnd) {
  const o = [];
  if (forEnd) for (const e of P.END_OPTIONS) {
    const v = e.station ? `station:${e.station}` : 'port';
    o.push(`<option value="${v}" ${keyOfPt(cur) === v ? 'selected' : ''}>${esc(e.name)}</option>`);
  } else {
    o.push(`<option value="port" ${keyOfPt(cur) === 'port' ? 'selected' : ''}>深圳湾口岸</option>`);
    if (cur.kind === 'here') o.push(`<option value="here" selected>我上次定位的位置</option>`);
  }
  o.push(`<optgroup label="港铁站">${stations.map(s => `<option value="station:${s.code}" ${keyOfPt(cur) === 'station:' + s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup>`);
  if (state.places.length) o.push(`<optgroup label="自己加的地方">${state.places.map(p => `<option value="place:${p.id}" ${keyOfPt(cur) === 'place:' + p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`);
  return o.join('');
}
function keyOfPt(p) { return !p || p.kind === 'port' ? 'port' : p.kind === 'station' ? 'station:' + p.code : p.kind === 'place' ? 'place:' + p.id : 'here'; }
function ptOfKey(k, cur) {
  if (k === 'port') return { kind: 'port' };
  if (k === 'here') return cur;
  const [kind, id] = k.split(':');
  return kind === 'station' ? { kind, code: id } : { kind, id };
}

function renderSettings() {
  const S = state.settings;
  return `<h1>设置</h1>
  <div class="card">
    <label class="f">哪一天（决定营业时间、公众假期）</label><input type="date" id="s-date" value="${esc(S.date)}">
    <label class="f">从哪出发</label><select id="s-start">${pointOptions(S.start, false)}</select>
    <label class="f">几点出发</label><input type="time" id="s-t0" value="${toHM(S.startTime)}">
    <label class="f">最后到哪</label><select id="s-end">${pointOptions(S.end, true)}</select>
    <label class="f">最晚几点到</label><input type="time" id="s-dl" value="${toHM(S.deadline)}">
    <label class="f">每家店至少待几分钟（另外每样加 4 分钟）</label><input type="number" inputmode="numeric" id="s-base" value="${S.base}">
    <label class="f">中秋当天饼家多算几分钟排队</label><input type="number" inputmode="numeric" id="s-queue" value="${S.bakeryQueue}">
    <button class="primary big" style="margin-top:14px" data-act="saveSettings">保存并重排</button>
  </div>
  <h2>备份（清单只存在这台手机里）</h2>
  <div class="card">
    <div class="row"><button class="grow" data-act="exportCopy">复制备份文字</button>${navigator.share ? '<button class="grow" data-act="exportShare">发到备忘录</button>' : ''}</div>
    <label class="f">恢复：把备份文字粘贴进来</label><textarea id="s-import" placeholder="Nathan出行备份 v1 …"></textarea>
    <button class="big" data-act="importBackup">恢复</button>
  </div>
  <h2>全部清空</h2>
  <div class="card"><button class="danger big" data-act="clearAll">清空清单、地方和进度</button></div>
  <p class="muted small">香港数据 ${esc(data.version)} 版：${data.stores.length} 家店、港铁 ${stations.length} 个站、深圳湾过关巴士 ${data.border.buses.map(b => b.route).join(' ')}。
  查不到营业时间的店按 10:00–20:00 算，页面上会标「未核实」。时间都是估的，偏保守。</p>`;
}

// ---------------- 弹出来的表单 ----------------

function sheet(html) {
  $('#sheet-root').innerHTML = `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet"><div class="inner">${html}</div></div>`;
}
function closeSheet() { $('#sheet-root').innerHTML = ''; }

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
        : `<p class="small flag">还没有自己加的地方。先保存，再去「加一个地方」。</p>`;
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

function editPlace(id) {
  const isNew = !id;
  const p = isNew ? { name: '', lat: null, lng: null, dur: 15, from: null, to: null, must: true, note: '', how: '', status: 'todo' } : state.places.find(x => x.id === id);
  if (!p) return;
  sheet(`<h2>${isNew ? '加一个地方' : '改这个地方'}</h2>
    <label class="f">叫什么</label><input id="p-name" value="${esc(p.name)}" placeholder="比如：吃午饭、朋友家取货">
    <label class="f">在哪（三选一）</label>
    <div class="card" style="margin:0">
      <button class="big" data-act="placeGPS">用我现在的位置</button>
      <label class="f">或者：贴谷歌 / 苹果地图的分享链接，或直接写坐标</label><textarea id="p-link" style="min-height:70px" placeholder="https://www.google.com/maps/…@22.28,114.15…"></textarea>
      <label class="f">或者：在哪个港铁站附近</label>
      <div class="row"><select id="p-st" class="grow"><option value="">（不选）</option>${stations.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
        <input id="p-walk" type="number" inputmode="numeric" style="width:6.5em" placeholder="走几分钟"></div>
      <p class="small muted" id="p-pos">${p.lat != null ? `现在的位置：${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${p.how ? '（' + esc(p.how) + '）' : ''}` : '还没有位置'}</p>
    </div>
    <label class="f">待多久（分钟）</label><input id="p-dur" type="number" inputmode="numeric" value="${p.dur}">
    <div class="row"><div class="grow"><label class="f">最早几点能去（可空）</label><input id="p-from" type="time" value="${toHM(p.from)}"></div>
      <div class="grow"><label class="f">最晚几点离开（可空）</label><input id="p-to" type="time" value="${toHM(p.to)}"></div></div>
    <label class="f">要不要</label>
    <select id="p-must"><option value="1" ${p.must !== false ? 'selected' : ''}>一定去</option><option value="0" ${p.must === false ? 'selected' : ''}>顺路才去</option></select>
    <label class="f">备注（地址之类，会显示在路线上）</label><input id="p-note" value="${esc(p.note || '')}">
    ${isNew ? '' : `<label class="f">状态</label><select id="p-status"><option value="todo" ${p.status === 'todo' ? 'selected' : ''}>还没去</option><option value="done" ${p.status === 'done' ? 'selected' : ''}>去过了</option><option value="skip" ${p.status === 'skip' ? 'selected' : ''}>不去了</option></select>`}
    <div class="row" style="margin-top:16px"><button class="primary grow" data-act="savePlace" data-id="${esc(p.id || '')}">保存</button>
      ${isNew ? '' : `<button class="danger" data-act="delPlace" data-id="${esc(p.id)}">删掉</button>`}<button class="quiet" data-act="closeSheet">取消</button></div>`);
  $('#sheet-root').dataset.lat = p.lat ?? '';
  $('#sheet-root').dataset.lng = p.lng ?? '';
  $('#sheet-root').dataset.how = p.how || '';
}

function getGPS() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('这台手机不给定位'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(new Error(e.code === 1 ? '没给定位权限（设置 → 隐私 → 定位服务 → Safari 网站）' : '定位没拿到，换「在哪个站附近」')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
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
  const bk = P.importBackup(text);
  if (bk) { pendingParse = { backup: bk }; $('#l-preview').innerHTML = `<div class="card warn">这是一份备份：恢复会替换现在的全部清单。</div><button class="primary big" data-act="parseCommit">恢复这份备份</button>`; return; }
  const r = parseList(text, data);
  const unknownItems = r.unknown.map(u => ({ id: u.id, name: u.name, qty: u.qty || 1, who: u.who || [], note: u.note || '', where: null, must: true, heavy: false, backupFor: null, status: 'todo', src: u.src, why: u.why }));
  pendingParse = { items: [...r.items, ...unknownItems] };
  $('#l-preview').innerHTML = `<h2>我是这么理解的（${r.items.length} 样${unknownItems.length ? `，${unknownItems.length} 行没看懂` : ''}）</h2>
    <div class="card">${r.items.map(it => `<div class="list-row"><div class="grow"><b>${esc(it.name)}</b>${it.qty > 1 ? ` ×${it.qty}` : ''} ${tagsOf(it)}
      <div class="muted small">${esc(whereText(it))}${whoText(it) ? ' · ' + esc(whoText(it)) : ''}${it.note ? ' · ' + esc(it.note) : ''}</div></div></div>`).join('')}
    ${unknownItems.map(u => `<div class="list-row"><div class="grow"><b class="flag">没看懂：${esc(u.name)}</b><div class="muted small">${esc(u.why || '')}；照样加进去，之后在清单里点它改</div></div></div>`).join('')}</div>
    <button class="primary big" data-act="parseCommit">全部加进去</button>`;
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
    case 'mark': { const it = state.items.find(x => x.id === id); mutate(() => P.markItem(state, id, el.dataset.status), `「${it ? it.name : ''}」${STATUS_TEXT[el.dataset.status]}，已重排`); break; }
    case 'nostock': { const it = state.items.find(x => x.id === id); mutate(() => P.noStockAt(state, id, el.dataset.store), `这家没有「${it ? it.name : ''}」，换别家重排`); break; }
    case 'exclude': mutate(() => P.excludeStore(state, el.dataset.store), `不去 ${storeName(el.dataset.store)}，已重排`); break;
    case 'placeStatus': mutate(() => P.updatePlace(state, id, { status: el.dataset.status }), el.dataset.status === 'done' ? '去过了，已重排' : '不去了，已重排'); break;
    case 'edit': editItem(id); break;
    case 'newItem': editItem(null); break;
    case 'editPlace': editPlace(id); break;
    case 'newPlace': editPlace(null); break;
    case 'closeSheet': closeSheet(); break;
    case 'paste': pasteSheet(); break;
    case 'parsePreview': parsePreview(); break;
    case 'parseCommit': {
      const pp = pendingParse; pendingParse = null;
      if (!pp) break;
      if (pp.backup) mutate(() => { state = pp.backup; }, '恢复了备份');
      else mutate(() => P.addItems(state, pp.items), `加了 ${pp.items.length} 样，已重排`);
      closeSheet(); tab = 'list'; render(); break;
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
    case 'placeGPS': {
      el.textContent = '正在定位…';
      try {
        const g = await getGPS();
        Object.assign($('#sheet-root').dataset, { lat: g.lat, lng: g.lng, how: `手机定位（误差约 ${Math.round(g.acc)} 米）` });
        $('#p-pos').textContent = `现在的位置：${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}（手机定位，误差约 ${Math.round(g.acc)} 米）`;
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
      const link = $('#p-link').value.trim();
      if (link) {
        const c = P.coordsFromText(link);
        if (!c) { alert('这段文字里找不到坐标。短链接（maps.app.goo.gl）离线打不开：在谷歌地图里长按那个点，复制坐标贴进来；或者选「在哪个站附近」。'); break; }
        lat = c.lat; lng = c.lng; how = '地图链接'; walk = 0;
      } else if ($('#p-st').value) {
        const s = stations.find(x => x.code === $('#p-st').value);
        const w = Math.max(0, Number($('#p-walk').value) || 0);
        lat = s.lat; lng = s.lng; how = `在${s.name}站附近${w ? `，走路约 ${w} 分钟` : ''}`;
        walk = w * 2;
      }
      if (lat == null) { alert('还没有位置：用定位、贴链接、或者选一个站'); break; }
      const patch = {
        name: $('#p-name').value.trim() || '（没写名字）', lat, lng, how, walk,
        dur: Math.max(0, Number($('#p-dur').value) || 0),
        from: fromHM($('#p-from').value), to: fromHM($('#p-to').value),
        must: $('#p-must').value === '1', note: $('#p-note').value.trim(),
      };
      if ($('#p-status')) patch.status = $('#p-status').value;
      if (id) mutate(() => P.updatePlace(state, id, patch), '改好了，已重排');
      else mutate(() => P.addPlace(state, patch), `加了「${patch.name}」，已重排`);
      closeSheet(); break;
    }
    case 'delPlace': mutate(() => P.removePlace(state, id), '删了这个地方'); closeSheet(); break;
    case 'here': hereSheet(); break;
    case 'hereGPS': {
      el.textContent = '正在定位…';
      try {
        const g = await getGPS();
        mutate(() => { state.settings.start = { kind: 'here', lat: g.lat, lng: g.lng }; state.settings.startTime = nowMin(); }, `从这里（${toHM(nowMin())}）重排`);
        closeSheet();
      } catch (err) { el.textContent = '用手机定位'; alert(err.message); }
      break;
    }
    case 'hereStation': {
      const code = $('#h-st').value;
      if (!code) { alert('选一个站'); break; }
      const t = fromHM($('#h-t').value) ?? nowMin();
      mutate(() => { state.settings.start = { kind: 'station', code }; state.settings.startTime = t; }, `从${stations.find(s => s.code === code).name}站 ${toHM(t)} 重排`);
      closeSheet(); break;
    }
    case 'gmaps': {
      const web = el.dataset.web;
      let left = false;
      const onHide = () => { left = true; };
      document.addEventListener('visibilitychange', onHide, { once: true });
      location.href = el.dataset.app;
      setTimeout(() => { document.removeEventListener('visibilitychange', onHide); if (!left && !document.hidden) window.open(web, '_blank'); }, 1500);
      break;
    }
    case 'copy': {
      try { await navigator.clipboard.writeText(el.dataset.text); toast('地址复制好了', false); }
      catch { prompt('复制这段：', el.dataset.text); }
      break;
    }
    case 'saveSettings': {
      const S = state.settings;
      const t0 = fromHM($('#s-t0').value), dl = fromHM($('#s-dl').value);
      if (t0 == null || dl == null) { alert('时间没填好'); break; }
      mutate(() => {
        S.date = $('#s-date').value || S.date;
        S.start = ptOfKey($('#s-start').value, S.start);
        S.startTime = t0;
        S.end = ptOfKey($('#s-end').value, S.end);
        S.deadline = dl <= t0 ? dl + 24 * 60 : dl;   // 最晚时间填了凌晨 = 过了午夜
        S.base = Math.max(0, Number($('#s-base').value) || 0);
        S.bakeryQueue = Math.max(0, Number($('#s-queue').value) || 0);
      }, '设置存好了，已重排');
      tab = 'today'; render(); break;
    }
    case 'exportCopy': {
      const txt = P.exportText(state);
      try { await navigator.clipboard.writeText(txt); toast('备份文字复制好了，贴到备忘录里存着', false); } catch { prompt('复制这段：', txt); }
      break;
    }
    case 'exportShare': { try { await navigator.share({ title: '出行备份', text: P.exportText(state) }); } catch { /* 他取消了 */ } break; }
    case 'importBackup': {
      try {
        const bk = P.importBackup($('#s-import').value);
        if (!bk) { alert('这不是备份文字（开头应该是「Nathan出行备份 v1」）。清单文字请去「清单」页粘贴。'); break; }
        if (!confirm('恢复会替换现在的全部清单和进度，确定？')) break;
        mutate(() => { state = bk; }, '恢复好了');
      } catch (err) { alert('恢复失败：' + err.message); }
      break;
    }
    case 'clearAll': if (confirm('清空全部清单、地方和进度？（清完 8 秒内还能撤销）')) mutate(() => { state = P.newState(); }, '全部清空了'); break;
  }
});

function hereSheet() {
  sheet(`<h2>从这里重排</h2>
    <p class="small muted">从现在的位置、现在的时间（${toHM(nowMin())}）重新排还没买的。</p>
    <button class="primary big" data-act="hereGPS">用手机定位</button>
    <label class="f">或者：我在哪个港铁站附近</label>
    <select id="h-st"><option value="">（选一个站）</option>${stations.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
    <label class="f">从几点开始算</label><input id="h-t" type="time" value="${toHM(nowMin())}">
    <div class="row" style="margin-top:12px"><button class="grow" data-act="hereStation">按这个站重排</button><button class="quiet" data-act="closeSheet">取消</button></div>`);
}

// ---------------- 画 ----------------

function render() {
  for (const b of document.querySelectorAll('#tabs button')) b.toggleAttribute('aria-current', b.dataset.tab === tab), b.dataset.tab === tab && b.setAttribute('aria-current', 'page');
  const v = $('#view');
  let html = tab === 'today' ? renderToday() : tab === 'list' ? renderList() : renderSettings();
  // 重排要 1–3 秒：这段时间下面还是改之前的路线（刚导入时会显示「0 样 · 0 站」），不说清楚会以为没改上。
  // 按钮照样能点（在店里要连着标几样）。
  if (tab === 'today' && planning && plan) html = `<div class="card warn">正在按刚才的改动重排，下面还是改之前的路线…</div><div class="stale">${html}</div>`;
  v.innerHTML = html;
}

async function boot() {
  try {
    data = await fetch('数据/hk.json').then(r => { if (!r.ok) throw new Error('香港数据没下载下来（第一次打开要联网）'); return r.json(); });
  } catch (e) {
    $('#view').innerHTML = `<div class="card err">打不开：${esc(e.message)}</div>`;
    return;
  }
  stations = data.mtr.st.map(([code, name, lat, lng]) => ({ code, name, lat, lng })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  try { state = await loadState(); } catch { storeOk = false; }
  if (!state) state = P.newState();
  state.settings = { ...P.PLAN_DEFAULTS, ...state.settings };
  state.excluded = state.excluded || [];
  runPlan = setupPlanner();
  render();
  replan();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
