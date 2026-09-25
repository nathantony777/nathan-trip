// 动效（0924）：错落入场、按压回弹、弹层滑上、换页位移、数字滚动、toast 上浮。
// 全部走 Web Animations API（el.animate），只动 transform / opacity 两种属性 —— 在合成层上跑，不触发重排。
//
// 四条规矩（每一条都是设计，不是顺手）：
// 1. 每个导出函数都 try/catch 包住、出错静默。动效是锦上添花，挂了不许影响主流程（按钮照样能点、弹层照样能关）。
// 2. 系统开了「减少动态效果」就全部退化：弹层直接出现、数字直接赋值、按压不缩。★每次调用时现查，不缓存 —— 用户中途改设置也要立刻生效。
// 3. 所有时长在 DUR、曲线在 EASE 里。调手感只改这两处，别在函数里写死数字。
// 4. 没有 DOM 的环境（node 测试）里所有函数都能调、都不抛错：animate* 立刻兑现，countUp 直接赋值，mountFx 返回 false。
//
// ★ 和 index.html 里的 CSS 动画（.sheet 的 sheet-up、#view.in、.toast 的 toast-in、button:active 的缩放）是同一件事的两种写法。
//   两边同时在的话这里的会盖过 CSS 的（脚本动画在层叠里排在 CSS 动画之后），不会坏，但等于做了两遍 —— 接线时二选一。

// 时长（毫秒）。
export const DUR = {
  stagger: 380,        // 错落入场：每个元素动多久
  staggerStep: 35,     // 错落入场：相邻两个元素错开多少
  staggerMax: 8,       // 错落入场：最多动几个，后面的直接出现（屏幕上本来也只看得见这么多）
  pressDown: 90,       // 按压：按下去缩到 0.97
  pressUp: 220,        // 按压：松手弹回来
  pressTouchDelay: 40, // 按压：手指按下先等这么久再缩 —— 手指一碰就滑走的（在列表里滚动）不算按
  sheetIn: 380,        // 弹层滑上来
  sheetOut: 260,       // 弹层滑下去
  view: 320,           // 换页
  count: 600,          // 数字滚动
  toastIn: 320,        // toast 上浮
  toastOut: 200,       // toast 收起
};
// 曲线。
export const EASE = {
  out: 'cubic-bezier(.2,.8,.2,1)',       // 快出慢停：入场、按下
  sheet: 'cubic-bezier(.32,.72,0,1)',    // iOS 弹层那条：快出、末尾极轻的过冲感
  spring: 'cubic-bezier(.34,1.56,.64,1)', // 回弹：过头一点再回来（1.56 > 1 就是过冲）
  in: 'cubic-bezier(.4,0,1,1)',          // 慢出快走：收起
};
const PRESS_SCALE = 0.97;

// ---------------- 底座 ----------------

const hasDoc = () => typeof document !== 'undefined' && !!document;

// 系统「减少动态效果」开了没有。每次现查（见规矩 2）；查不了（node、老浏览器）当作没开。
export function reducedMotion() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}
const canAnimate = el => !!el && typeof el.animate === 'function' && !reducedMotion();

// 跑一段动画，回一个「一定会兑现、绝不拒绝」的 Promise（动完 / 被取消 / 不能动 / 出错，四种都兑现）。
// ★ 调用方拿它来「动完再清 DOM」，所以它不许挂着不兑现，也不许抛 —— 否则弹层关不掉。
function run(el, frames, opts) {
  return new Promise(resolve => {
    try {
      if (!canAnimate(el)) return resolve();
      const a = el.animate(frames, opts);
      const done = () => resolve();
      if (a && a.finished && typeof a.finished.then === 'function') a.finished.then(done, done);
      else if (a) { a.onfinish = done; a.oncancel = done; }
      else resolve();
    } catch { resolve(); }
  });
}

// ---------------- 1. 错落入场 ----------------

// 类名照 app.js / index.html 的真实写法：.card 卡片、.list-row 清单行、.leg 路线里的一段。
const ENTER_SEL = '.card, .list-row, .leg';
const entered = new WeakSet();   // 同一元素只做一次

// 让 nodes（一个元素、或元素数组）里新出现的卡片 / 行 / 段错落进场。回：真正动了几个。
// 只动最外层：卡片里的行不再单独动（不然一张卡里外两层一起飘）。屏幕下面看不见的不动、不占名额。
export function staggerIn(nodes) {
  try {
    if (reducedMotion()) return 0;
    const list = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
    const found = [];
    for (const root of list) {
      if (!root || root.nodeType !== 1) continue;
      if (root.matches && root.matches(ENTER_SEL)) found.push(root);
      if (typeof root.querySelectorAll === 'function') found.push(...root.querySelectorAll(ENTER_SEL));
    }
    const limit = typeof innerHeight === 'number' ? innerHeight : Infinity;
    let n = 0;
    for (const el of found) {
      if (entered.has(el)) continue;
      if (el.parentElement && el.parentElement.closest && el.parentElement.closest(ENTER_SEL)) continue;   // 外层已经在动
      entered.add(el);
      if (n >= DUR.staggerMax) continue;                                                                  // 超过上限：直接出现
      if (el.getBoundingClientRect && el.getBoundingClientRect().top > limit) continue;                   // 屏幕下面：直接出现
      run(el, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: DUR.stagger, delay: n * DUR.staggerStep, easing: EASE.out, fill: 'backwards' });   // backwards：等待期间停在第一帧（透明），动完不留任何样式
      n++;
    }
    return n;
  } catch { return 0; }
}

// ---------------- 2. 按压反馈 ----------------

// 按下缩到 0.97、松手带过冲弹回。Apple 风：只缩放，不做 ripple。
// 类名照真实写法：button、.btn、.list-row（清单行整行是点击区）。
// ★ 页签栏 nav.tabs button 不缩 —— index.html 明确写了 `nav.tabs button:active { transform: none }`，这里跟它一致。
const PRESS_SEL = 'button, .btn, .list-row';
const PRESS_SKIP = 'nav.tabs button, [disabled], [aria-disabled="true"]';
let pressed = null;   // 正按着的：{ el, anim, timer }

const currentTransform = el => {
  try { const t = getComputedStyle(el).transform; return t && t !== 'none' ? t : 'none'; } catch { return 'none'; }
};
function pressStart(p) {
  try {
    p.timer = null;
    // 从当前样子开始缩（CSS 的 :active 可能已经把它缩了一点），不然会先跳回 1 再缩，看着抖一下
    p.anim = p.el.animate([{ transform: currentTransform(p.el) }, { transform: `scale(${PRESS_SCALE})` }],
      { duration: DUR.pressDown, easing: EASE.out, fill: 'forwards' });
  } catch { p.anim = null; }
}
function pressRelease(bounce) {
  const p = pressed; if (!p) return; pressed = null;
  try {
    if (p.timer) {
      clearTimeout(p.timer); p.timer = null;
      // 还没开始缩就松了（很快的一点）：也要有反馈，一口气缩下去再弹回
      if (bounce) run(p.el, [{ transform: 'scale(1)', offset: 0 }, { transform: `scale(${PRESS_SCALE})`, offset: DUR.pressDown / (DUR.pressDown + DUR.pressUp), easing: EASE.spring }, { transform: 'scale(1)' }],
        { duration: DUR.pressDown + DUR.pressUp, easing: EASE.out });
      return;
    }
    const from = currentTransform(p.el);   // 先读再取消：读到的是缩到一半的样子
    if (p.anim) p.anim.cancel();
    if (bounce) run(p.el, [{ transform: from }, { transform: 'scale(1)' }], { duration: DUR.pressUp, easing: EASE.spring });
  } catch {}
}
function onPointerDown(e) {
  try {
    if (e.button != null && e.button !== 0) return;                  // 右键 / 中键不算按
    const t = e.target && typeof e.target.closest === 'function' ? e.target.closest(PRESS_SEL) : null;
    if (!t || (t.matches && t.matches(PRESS_SKIP)) || !canAnimate(t)) return;
    pressRelease(false);                                               // 上一个还按着（多指）：先放掉，不弹
    pressed = { el: t, anim: null, timer: null };
    if (e.pointerType === 'touch') pressed.timer = setTimeout(() => { if (pressed && pressed.timer) pressStart(pressed); }, DUR.pressTouchDelay);
    else pressStart(pressed);
  } catch {}
}
function onPointerUp() { pressRelease(true); }

function installPress(doc) {
  try {
    if (!doc || typeof doc.addEventListener !== 'function' || doc.__fxPress) return false;
    doc.__fxPress = true;
    doc.addEventListener('pointerdown', onPointerDown, { passive: true });
    doc.addEventListener('pointerup', onPointerUp, { passive: true });
    doc.addEventListener('pointercancel', onPointerUp, { passive: true });   // 手指滑起来滚动了：系统会发 cancel，照松手处理
    return true;
  } catch { return false; }
}

// ---------------- 装配 ----------------

let armed = false;   // animateViewIn 调过之后，下一批 DOM 变化要做错落
let mounted = false;

// 装一次：按压反馈（事件委托在 document 上）+ 监听 #view 里新出现的卡片做错落入场。
// root 默认是 document；没有 document（node）或没有 MutationObserver 的环境返回 false，不抛。
// opts.always = true：每次 #view 里有新东西都错落。默认 false：只在「换页」那一批变化里做 ——
//   判「换页」有两条路，任一条成立：① 这批变化之前调过 animateViewIn()；② 同一批里 #view 的 class 变了
//   （app.js 的 render() 换页时先重加 .in 再换 innerHTML，两条记录同一批到）。
//   同页重画（改一样东西、重排完）不算换页，不错落 —— 不然每次重排都闪一下。
export function mountFx(root, opts = {}) {
  try {
    root = root || (hasDoc() ? document : null);
    if (!root || mounted) return false;
    const doc = root.nodeType === 9 ? root : (root.ownerDocument || null);
    installPress(doc || root);
    const view = opts.view || (typeof root.querySelector === 'function' ? root.querySelector('#view') : null);
    if (view && typeof MutationObserver === 'function') {
      const mo = new MutationObserver(records => {
        try {
          const pageChanged = !!opts.always || armed || records.some(r => r.type === 'attributes' && r.target === view);
          armed = false;
          if (!pageChanged) return;
          const added = [];
          for (const r of records) for (const n of r.addedNodes || []) if (n.nodeType === 1) added.push(n);
          if (added.length) staggerIn(added);
        } catch {}
      });
      mo.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    mounted = true;
    return true;
  } catch { return false; }
}

// ---------------- 3. 底部弹层 ----------------

// el 可以是 .sheet 本身，也可以是装着 .sheet-bg + .sheet 的容器（#sheet-root）：容器的话遮罩一起淡。
function sheetParts(el) {
  try {
    if (!el) return { sheet: null, bg: null };
    if (el.matches && el.matches('.sheet')) return { sheet: el, bg: el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('.sheet-bg') : null };
    const q = typeof el.querySelector === 'function' ? s => el.querySelector(s) : () => null;
    return { sheet: q('.sheet') || el, bg: q('.sheet-bg') };
  } catch { return { sheet: null, bg: null }; }
}
// 从底下滑上来（100% → 0），遮罩同时淡入。回 Promise，动完兑现。
export function animateSheetIn(el) {
  try {
    const { sheet, bg } = sheetParts(el);
    if (bg) run(bg, [{ opacity: 0 }, { opacity: 1 }], { duration: Math.round(DUR.sheetIn * 0.7), easing: 'ease-out' });
    return run(sheet, [{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: DUR.sheetIn, easing: EASE.sheet });
  } catch { return Promise.resolve(); }
}
// 滑下去（0 → 100%），遮罩淡出。停在终点（fill: forwards）等调用方清 DOM —— 不然动完会跳回来闪一下。
// 用法：await animateSheetOut(root); root.innerHTML = '';
export function animateSheetOut(el) {
  try {
    const { sheet, bg } = sheetParts(el);
    if (bg) run(bg, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.sheetOut, easing: 'ease-in', fill: 'forwards' });
    return run(sheet, [{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: DUR.sheetOut, easing: EASE.in, fill: 'forwards' });
  } catch { return Promise.resolve(); }
}

// ---------------- 4. 换页 ----------------

// dir：'left' = 往后翻（新页从右边 16px 滑进来）；'right' = 往回翻（从左边滑进来）；'none' = 只淡入。
// ★ 调过它之后，mountFx 的监听器会把紧接着那一批新出现的卡片做错落（见 mountFx）。
// ★ 动画期间 el 有 transform，它里面的 position: fixed 会失效 —— 弹层 / toast / 底栏都是 #view 的兄弟，不在里面，没事。
export function animateViewIn(el, dir = 'none') {
  try {
    armed = true;
    const x = dir === 'left' ? 16 : dir === 'right' ? -16 : 0;
    return run(el, [{ opacity: 0, transform: x ? `translateX(${x}px)` : 'none' }, { opacity: 1, transform: 'none' }],
      { duration: DUR.view, easing: EASE.sheet });
  } catch { return Promise.resolve(); }
}
// 从 from 页翻到 to 页该往哪边动。order 是页签顺序；不给就读 #tabs 里按钮的 data-tab。同页 / 认不出的页回 'none'。
export function viewDir(from, to, order) {
  try {
    if (!order && hasDoc()) order = [...document.querySelectorAll('#tabs [data-tab]')].map(b => b.dataset.tab);
    if (!Array.isArray(order) || from == null || to == null || from === to) return 'none';
    const a = order.indexOf(from), b = order.indexOf(to);
    if (a < 0 || b < 0) return 'none';
    return b > a ? 'left' : 'right';
  } catch { return 'none'; }
}

// ---------------- 5. 数字滚动 ----------------

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// 从 0 滚到 to，写进 el.textContent。fmt(数) → 字，默认取整；没给 fmt 时中间帧也取整。
// 减少动态效果 / 没有 requestAnimationFrame（node）/ to 不是数：直接赋值（不是数就原样写进去，不走 fmt）。
export function countUp(el, to, { ms = DUR.count, fmt } = {}) {
  try {
    if (!el) return;
    const f = typeof fmt === 'function' ? fmt : v => String(Math.round(v));
    const target = typeof to === 'number' ? to : Number(to);
    if (!Number.isFinite(target)) { el.textContent = String(to); return; }
    if (reducedMotion() || typeof requestAnimationFrame !== 'function' || !(ms > 0)) { el.textContent = f(target); return; }
    const t0 = now();
    const step = () => {
      try {
        const p = Math.min(1, (now() - t0) / ms);
        const e = 1 - Math.pow(1 - p, 3);                     // 快出慢停，最后几格慢下来才像「数到了」
        el.textContent = f(p < 1 ? target * e : target);      // 最后一帧一定写 target 本身，不留浮点尾巴
        if (p < 1) requestAnimationFrame(step);
      } catch {}
    };
    el.textContent = f(0);
    requestAnimationFrame(step);
  } catch {}
}
// 把 root 里所有带 data-count 的元素一起滚：<span data-count="12">12</span>；data-count-dec="1" 保留 1 位小数。
// 用法：render() 换完 innerHTML 之后 countUpAll($('#view'))。回：滚了几个。
export function countUpAll(root) {
  try {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    let n = 0;
    for (const el of root.querySelectorAll('[data-count]')) {
      const dec = Number(el.dataset && el.dataset.countDec);
      const fmt = Number.isInteger(dec) && dec > 0 ? v => Number(v).toFixed(dec) : undefined;
      countUp(el, el.dataset ? el.dataset.count : el.getAttribute('data-count'), { fmt });
      n++;
    }
    return n;
  } catch { return 0; }
}

// ---------------- 6. toast ----------------

// 从底下上浮 8px + 淡入。
export function animateToastIn(el) {
  try { return run(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.toastIn, easing: EASE.sheet }); }
  catch { return Promise.resolve(); }
}
// 往下沉 8px + 淡出，停在终点等清 DOM。用法：await animateToastOut(t); root.innerHTML = '';
export function animateToastOut(el) {
  try { return run(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }], { duration: DUR.toastOut, easing: 'ease-in', fill: 'forwards' }); }
  catch { return Promise.resolve(); }
}
