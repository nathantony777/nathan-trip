// 「说话输入」的第二层：把口语交给一个 OpenAI 兼容的对话接口，回来的 JSON 校验成 Draft（规格 15.3 / 15.4）。
// ★ 跟 providers.js 同一套规矩：纯网络、不碰存储、不碰界面；fetch / spend / sleep / now 由外面给（app 给真的，测试给假的）。
// ★ 花钱的闸：每次真发请求之前先 await spend(1)。spend 到上限会抛（kind 'cap'），原样往外抛、不吞。
//   重发（去掉 response_format）和重试（网络错）都是真发，所以每次真发之前都再报一次账。
// ★ 出错一律抛 ProviderError { kind, text }（直接复用 providers.js 那个）：key / quota / cap 不重试；net 隔 1 秒重试一次。
//   超时（默认 20 秒）算 net，但不重试 —— 再等一个 20 秒他早就放弃了，退到规则层更快。
// ★ 钥匙只进 Authorization 头；报错文字里绝不出现钥匙（服务端原话进报错之前先把钥匙抹掉）。
// ★ AI 编出来的地方一律不收：entry.text 必须是原文的子串（去掉空白比较），对不上的那条降到 unknown，原话留着让他改。

import { ProviderError } from './providers.js';

// 预设：第一个是默认（Nathan 0924 定「用我现在有的 api」⇒ DeepSeek）。base 不带末尾斜杠。
export const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-v4-flash',
    note: '默认。他已有钥匙；一次约半分钱，不是免费' },
  { id: 'bailian', name: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash',
    note: '他已有钥匙；跨域放行' },
  { id: 'zhipu', name: '智谱', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash',
    note: '免费（官方「模型概览」页写的）；要自己开账号拿钥匙' },
  { id: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct',
    note: '有免费档；模型名按定价页免费档填，这个是我挑的一个' },
  { id: 'local', name: '本地（自己的 Mac）', base: 'https://<mac>:11434/v1', model: '',
    note: '只在家里同一 Wi-Fi、Mac 醒着时能用；网页是 https，Mac 那头也得是 https，把 <mac> 换成 Mac 的地址' },
];

export const MAX_TEXT = 4000;            // 超过就截断，返回里带 truncated:true
const TIMEOUT_MS = 20000;
const RETRY_MS = 1000;
const KINDS = new Set(['sight', 'food', 'shop', 'stay', 'other']);
const REGIONS = new Set(['hk', 'cn', 'abroad']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEST_SENTENCE = '明天上午去故宫';

// system 提示词固定在代码里（规格 15.4）。Draft 的定义原样给；三条硬规矩写死。
export const SYSTEM_PROMPT = `你是一个行程助手。用户会用中文口语说他想去哪里玩，你要把这段话变成一个 JSON 对象（只输出 JSON，不要别的字）。

JSON 的形状（叫 Draft）：
{
  "trip": { "name": 这趟的名字(可选), "region": "hk"|"cn"|"abroad"(可选), "city": 城市(可选) },
  "days": [ { "date": "YYYY-MM-DD" 或 null(没说哪天), "entries": [ Entry, ... ] }, ... ],
  "unknown": [ { "text": 原话片段, "why": 为什么没听懂(一句人话) }, ... ]
}
Entry 的形状：
{
  "text": 原话片段（必须一字不改地从用户原话里截出来）,
  "name": 地方名，就是拿去地图上搜的关键词，比如「深圳人才公园」「免税店」,
  "kind": "sight"(玩/逛/看) | "food"(吃/喝) | "shop"(买) | "stay"(住/酒店) | "other",
  "near": null | "prev"(「附近的」= 上一处附近) | 某个地方名(「老街站附近」= "老街站"),
  "dur": 待多久(分钟) 或 null（只有说了才填：两个小时=120、一下午=180、半天=240）,
  "at": 几点到(从 0 点起算的分钟) 或 null（「三点的场」= 900）,
  "from": 时段开始(分钟) 或 null, "to": 时段结束(分钟) 或 null（上午 540-720、中午 660-840、下午 780-1080、晚上 1080-1320）,
  "must": true | false（「顺便」「有空的话」「可去可不去」= false，其余 true）,
  "buy": [ 要买的东西, ... ]（「买老婆饼」= ["老婆饼"]；没说就是 []）,
  "ref": "home"（只有「回酒店」「回家」这种没说哪家、指这趟住的地方时才填；name 填「酒店」；说了酒店名字的不填）
}

三条硬规矩，一条都不许破：
1. 只用原话里的信息。不补地方、不猜地址、不加原话里没有的景点；地方名只能从原话里来。
2. 原话拆成的每一小句都要落到一处：要么是某条 Entry 的 text，要么是 trip 字段的来源，要么进 unknown。一句都不许丢。听不出要去哪的小句进 unknown，why 写人话，比如「没听出要去哪」。
3. 日期按用户告诉你的「今天是 YYYY-MM-DD 周X」推算：明天、后天、周六、下周三、10月8日、8号 都换算成 YYYY-MM-DD；年份没说算今年，已经过去就算明年；一句没说日期就沿用上一句的；整段一个日期都没有就 date 填 null。「第N天」指这趟已有的第 N 天，没有那么多天就进 unknown（why「这趟没有第 N 天」），不许自己加一天。`;

// 把 ctx（今天、周几、这趟的地区 / 城市 / 哪几天）和原文拼成 user 消息。发出去的只有这些（规格 15.4 隐私）。
export function buildMessages(text, ctx = {}) {
  const lines = [];
  const today = typeof ctx.today === 'string' && DATE_RE.test(ctx.today) ? ctx.today : null;
  const weekday = typeof ctx.weekday === 'string' && ctx.weekday ? ctx.weekday : (today ? weekdayOf(today) : '');
  if (today) lines.push(`今天是 ${today}${weekday ? ' ' + weekday : ''}。`);
  const trip = [];
  if (ctx.region && REGIONS.has(ctx.region)) trip.push(`地区 ${{ hk: '香港', cn: '中国大陆', abroad: '国外' }[ctx.region]}`);
  if (typeof ctx.city === 'string' && ctx.city.trim()) trip.push(`城市 ${ctx.city.trim()}`);
  const days = Array.isArray(ctx.days) ? ctx.days.map(d => (typeof d === 'string' ? d : d && d.date)).filter(d => typeof d === 'string' && DATE_RE.test(d)) : [];
  if (days.length) trip.push(`已有的天：${days.map((d, i) => `第${i + 1}天=${d}`).join('、')}`);
  if (trip.length) lines.push(`这趟：${trip.join('，')}。`);
  lines.push('用户原话：');
  lines.push(String(text ?? ''));
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}
function localDate(now) {
  const d = new Date(now), p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// ======================= 校验：AI 回的东西 → Draft =======================

const squash = s => String(s).replace(/\s+/g, '');
const isStr = s => typeof s === 'string' && s.trim() !== '';
// 0～1440 的整数才收；别的（小数、负数、字符串「120」、超过一天）都置 null —— 排程那侧算不了就别给它
const minute = v => (Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null);
// 「YYYY-MM-DD」且真有这一天（2 月 30 号不算）
function goodDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}
function emptyDraft() { return { trip: {}, days: [], unknown: [] }; }

// 校验 + 收集「被校验降下来的那些」。validateDraft 只交 Draft；parse 还要把 dropped 单独交出去给界面显示那行小字。
function checkDraft(obj, text) {
  const draft = emptyDraft(), dropped = [];
  const original = squash(text ?? '');
  const drop = (t, why) => { const item = { text: t, why }; dropped.push(item); draft.unknown.push(item); };

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    // 不是对象：整段原话进 unknown，一个字不丢
    drop(String(text ?? ''), 'AI 回的不是草稿的形状');
    return { draft, dropped };
  }

  // trip：只收说到了的、形状对的
  const trip = obj.trip && typeof obj.trip === 'object' && !Array.isArray(obj.trip) ? obj.trip : {};
  if (isStr(trip.name)) draft.trip.name = trip.name.trim();
  if (typeof trip.region === 'string' && REGIONS.has(trip.region)) draft.trip.region = trip.region;
  if (isStr(trip.city)) draft.trip.city = trip.city.trim();
  if (isStr(trip.home)) draft.trip.home = trip.home.trim();

  // days
  const days = Array.isArray(obj.days) ? obj.days : [];
  for (const day of days) {
    if (!day || typeof day !== 'object' || Array.isArray(day)) continue;
    const entries = Array.isArray(day.entries) ? day.entries : [];
    const dateOk = day.date == null || goodDate(day.date);
    if (!dateOk) {
      // 日期认不出：这一天的每条都降到 unknown（原话留着），不猜它是哪天
      for (const e of entries) drop(entryText(e), `AI 给的日期认不出：${cut(String(day.date))}`);
      continue;
    }
    const out = { date: day.date == null ? null : day.date, entries: [] };
    for (const e of entries) {
      const r = checkEntry(e, original);
      if (r.entry) out.entries.push(r.entry); else drop(r.text, r.why);
    }
    draft.days.push(out);
  }

  // unknown：AI 自己没听懂的，形状对的照收
  const unknown = Array.isArray(obj.unknown) ? obj.unknown : [];
  for (const u of unknown) {
    if (!u || typeof u !== 'object') continue;
    if (!isStr(u.text)) continue;
    draft.unknown.push({ text: u.text, why: isStr(u.why) ? u.why.trim() : 'AI 没说为什么没听懂' });
  }
  return { draft, dropped };
}

function entryText(e) {
  if (e && typeof e === 'object') { if (isStr(e.text)) return e.text; if (isStr(e.name)) return e.name; }
  return cut(JSON.stringify(e ?? null), 80);
}

// 一条 entry：收 → { entry }；不收 → { text, why }
function checkEntry(e, original) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { text: entryText(e), why: 'AI 给的这条形状不对' };
  if (!isStr(e.text)) return { text: entryText(e), why: 'AI 给的这条没带原话' };
  // ★ 硬规矩：text 必须是原文的子串（去掉空白比较）。AI 编出来的地方一律不收
  if (!original.includes(squash(e.text))) return { text: e.text, why: 'AI 给的这条对不上原话' };
  if (!isStr(e.name)) return { text: e.text, why: 'AI 没给这条的地方名' };
  const near = e.near == null ? null : (e.near === 'prev' ? 'prev' : (isStr(e.near) ? e.near.trim() : null));
  const buy = Array.isArray(e.buy) ? e.buy.filter(isStr).map(s => s.trim()) : [];
  return {
    entry: {
      text: e.text, name: e.name.trim(),
      kind: KINDS.has(e.kind) ? e.kind : 'other',
      near,
      dur: minute(e.dur), at: minute(e.at), from: minute(e.from), to: minute(e.to),
      must: e.must === false ? false : true,
      buy,
      ...(e.ref === 'home' ? { ref: 'home' } : {}),
    },
  };
}

export function validateDraft(obj, text) { return checkDraft(obj, text).draft; }

// ======================= 从回话里取 JSON =======================

// 回来的 content 可能被 ```json … ``` 包着，也可能前后带一句废话；先剥围栏，再退而求其次取第一个 { 到最后一个 }
export function extractJSON(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 往下试 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 认不出 */ } }
  return null;
}

// ======================= 网络 =======================

function cut(s, n = 160) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function errText(e) { return (e && (e.text || e.message)) || String(e); }

export function makeAI(opts = {}) {
  const env = {
    base: String(opts.base || PRESETS[0].base).trim().replace(/\/+$/, ''),
    model: String(opts.model || PRESETS[0].model).trim(),
    key: typeof opts.key === 'string' ? opts.key.trim() : '',
    noKey: opts.noKey === true,                       // 本地模型（Ollama）不要钥匙：调用方明说才免
    fetch: opts.fetch || ((url, init) => globalThis.fetch(url, init)),
    spend: opts.spend || (() => {}),
    sleep: opts.sleep || (ms => new Promise(r => setTimeout(r, ms))),
    now: opts.now || (() => Date.now()),
    timeoutMs: Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS,
  };
  const url = `${env.base}/chat/completions`;
  // 报错文字里绝不出现钥匙：服务端原话有时会把 Bearer 后面那串回显出来
  const hide = s => (env.key && env.key.length >= 4 ? String(s).split(env.key).join('<钥匙>') : String(s));
  const serverSaid = body => {
    const m = body && body.error && (typeof body.error === 'string' ? body.error : body.error.message);
    return isStr(m) ? `（AI 那边原话：${cut(hide(m))}）` : '';
  };

  // 发一次（含 response_format 被拒就去掉重发、网络错重试一次、超时）。成了返回解析好的 body。
  async function send(messages) {
    let withFormat = true, netRetried = false;
    for (;;) {
      const payload = { model: env.model, messages, temperature: 0 };
      if (withFormat) payload.response_format = { type: 'json_object' };
      const headers = { 'Content-Type': 'application/json' };
      if (env.key) headers.Authorization = `Bearer ${env.key}`;
      await env.spend(1);                               // ★ 真发之前先报账；超上限它会抛，原样往外抛
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), env.timeoutMs);
      let res;
      try {
        res = await env.fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted || (e && e.name === 'AbortError')) {
          throw new ProviderError('net', `AI 等了 ${Math.round(env.timeoutMs / 1000)} 秒没回话`);
        }
        if (!(e instanceof TypeError)) throw new ProviderError('other', `AI 的请求没发出去：${cut(hide(errText(e)))}`);
        if (!netRetried) { netRetried = true; await env.sleep(RETRY_MS); continue; }
        throw new ProviderError('net', '网络不通，隔一秒重试过一次，还是不通');
      } finally { clearTimeout(timer); }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      const code = res.status;
      if (res.ok) {
        if (!body || typeof body !== 'object') throw new ProviderError('other', 'AI 回的内容认不出（不是 JSON）');
        return body;
      }
      const said = serverSaid(body);
      if (code === 401 || code === 403) throw new ProviderError('key', `AI 的钥匙不对或没权限（HTTP ${code}）${said}`);
      if (code === 429) throw new ProviderError('quota', `AI 那边说用量到上限或请求太频繁（HTTP 429）${said}`);
      if (code === 402) throw new ProviderError('quota', `AI 账户余额不够了（HTTP 402）${said}`);
      if (code === 400 && withFormat && /response_format/i.test(said)) {
        withFormat = false;                             // 这家不认 response_format：去掉再发一次（只这一次）
        continue;
      }
      if (code >= 500) {
        if (!netRetried) { netRetried = true; await env.sleep(RETRY_MS); continue; }
        throw new ProviderError('net', `AI 那边暂时出错（HTTP ${code}），隔一秒重试过一次还是不行`);
      }
      throw new ProviderError('other', `AI 回了错误（HTTP ${code}）${said}`);
    }
  }

  // 口语 → { draft, dropped, truncated? }。text 空的不发（不花钱），回空草稿。
  async function parse(text, ctx = {}) {
    let s = String(text ?? '');
    if (!s.trim()) return { draft: emptyDraft(), dropped: [] };
    if (!env.key && !env.noKey) throw new ProviderError('key', '还没填 AI 钥匙');
    let truncated = false;
    if (s.length > MAX_TEXT) { s = s.slice(0, MAX_TEXT); truncated = true; }
    const body = await send(buildMessages(s, ctx));
    const choice = Array.isArray(body.choices) ? body.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : null;
    const obj = extractJSON(content);
    if (obj === null) throw new ProviderError('other', 'AI 回的不是 JSON');
    const { draft, dropped } = checkDraft(obj, s);
    return truncated ? { draft, dropped, truncated: true } : { draft, dropped };
  }

  // 「试一下」：发一句固定短句，能校验出至少一条 entry 才算通（算 1 次）
  async function testKey() {
    try {
      const today = localDate(env.now());
      const r = await parse(TEST_SENTENCE, { today, weekday: weekdayOf(today) });
      const n = r.draft.days.reduce((s, d) => s + d.entries.length, 0);
      if (n >= 1) return { ok: true, text: 'AI 能用' };
      const why = r.draft.unknown.length ? r.draft.unknown.map(u => u.why).join('；') : 'JSON 里一个地方都没有';
      return { ok: false, text: `AI 连上了，但那句「${TEST_SENTENCE}」没听成地方（${why}）` };
    } catch (e) { return { ok: false, text: hide(errText(e)) }; }
  }

  return { parse, testKey };
}
