// 清单文字 → 一样一样的东西（规格第五节）。离线、纯函数；电脑上 node 能跑测试。
// ★ 看不懂的不许丢：进 unknown，界面上让他点一下改。

// 繁 → 简（只收店名、地名里常见的字；够用就行，不求全）
const T2S = {
  '環': '环', '灣': '湾', '銅': '铜', '鑼': '锣', '廣': '广', '門': '门', '龍': '龙', '華': '华', '豐': '丰',
  '寧': '宁', '記': '记', '莊': '庄', '齋': '斋', '陳': '陈', '興': '兴', '際': '际', '馬': '马', '優': '优',
  '品': '品', '恆': '恒', '餅': '饼', '棧': '栈', '歐': '欧', '辦': '办', '館': '馆', '艦': '舰', '樓': '楼',
  '東': '东', '區': '区', '島': '岛', '鐵': '铁', '場': '场', '廈': '厦', '國': '国', '營': '营', '圍': '围',
  '頭': '头', '層': '层', '號': '号', '舖': '铺', '鋪': '铺', '業': '业', '運': '运', '藥': '药', '無': '无',
  '滴': '滴', '潤': '润', '喉': '喉', '寶': '宝', '貝': '贝', '嬰': '婴', '兒': '儿', '撫': '抚', '嘴': '嘴',
  '葉': '叶', '臺': '台', '灣': '湾', '尖': '尖', '沙': '沙', '咀': '咀', '將': '将', '軍': '军', '澳': '澳',
  '觀': '观', '塘': '塘', '葵': '葵', '荃': '荃', '沙': '沙', '屯': '屯', '輕': '轻', '總': '总', '廳': '厅',
  '雞': '鸡', '蛋': '蛋', '雜': '杂', '貨': '货', '鮮': '鲜', '魚': '鱼', '蝦': '虾', '參': '参', '燕': '燕',
  '閣': '阁', '樂': '乐', '麗': '丽', '豬': '猪', '廚': '厨', '買': '买', '賣': '卖', '點': '点', '從': '从',
};
export function norm(s) {
  let out = '';
  for (const ch of String(s || '')) out += T2S[ch] || ch;
  return out.replace(/\s+/g, '').toLowerCase();
}

// 中文地名 → 数据里的英文区名（玛莎的分店名是英文）
const PLACE_EN = {
  '中环': 'central', '上环': 'sheung wan', '金钟': 'admiralty', '湾仔': 'wan chai', '铜锣湾': 'causeway bay',
  '尖沙咀': 'tsim sha tsui', '尖东': 'tsim sha tsui', '旺角': 'mong kok', '油麻地': 'yau ma tei', '佐敦': 'jordan',
  '太子': 'prince edward', '元朗': 'yuen long', '屯门': 'tuen mun', '天水围': 'tin shui wai', '沙田': 'sha tin',
  '荃湾': 'tsuen wan', '将军澳': 'tseung kwan o', '九龙塘': 'kowloon tong', '九龙湾': 'kowloon bay', '西营盘': 'sai ying pun',
  '坚尼地城': 'kennedy town', '太古': 'taikoo', '东涌': 'tung chung', '青衣': 'tsing yi', '跑马地': 'happy valley', '西贡': 'sai kung',
};

// 已知错字 / 别名（规格第五节）。★ 瑞润喉糖 那条待 Nathan 确认
export const ALIASES = { '甘河茶': '甘和茶', '瑞润喉糖': '瑞士润喉糖', '茘': '荔' };

const BRAND_SUFFIX = /(老饼家|饼家|茶庄|茶行|超市|办馆|药房|曲奇)$/;
const STORE_TAIL = /^(咖啡)?(老饼家|饼家|咖啡茶行|茶庄|茶行|生活超市|超市|办馆|药房|曲奇)/;
// 通用称呼表（发布前检查只放行这一行里的称呼）。★不许在这里写家里人的名字：这份文件会发布到网上。
// 名字当标题的行靠「：」结尾或带「&」认出来，不需要写进这里。
const PERSON = /(姥|爷|奶奶|妈|爸|嫂|哥|姐|弟|妹|我们|老婆|自己|家里|丈|婆|公公|孩子|宝宝)/;
const LEAD = /^[\s○●◯•·\-–—☐☑✓✔□■▪*]+|^\d+[.、)）]\s*/;

// 从数据里建「牌子怎么认」：全名、繁体名、去掉「饼家/超市」之类的核心名
export function buildMatcher(data) {
  const brands = data.brands.map(b => {
    const keys = new Set();
    for (const n of [b.brand, ...(b.names || [])]) {
      const k = norm(n);
      if (k.length >= 2) keys.add(k);
      const core = k.replace(BRAND_SUFFIX, '');
      if (core.length >= 2) keys.add(core);
    }
    return { brand: b.brand, kind: b.kind || '', keys: [...keys].sort((a, c) => c.length - a.length), sells: b.sells || [] };
  });
  const products = (data.products || []).map(p => ({
    product: p.product, brands: p.brands,
    keys: [...new Set([p.product, ...(p.aliases || [])].map(norm).filter(k => k.length >= 2))].sort((a, c) => c.length - a.length),
  }));
  return { brands, products, stores: data.stores };
}

// 在一段文字里找所有牌子出现的位置（长的优先，不重叠）
function findBrands(M, text) {
  const t = norm(text);
  const hits = [];
  for (const b of M.brands) for (const k of b.keys) {
    let i = t.indexOf(k);
    while (i >= 0) {
      // 店名后面跟着的「超市 / 咖啡茶行 / 饼家」也算店名的一部分（「玛莎超市」不能剩下一个「超市」当东西）
      const tail = t.slice(i + k.length).match(STORE_TAIL);
      hits.push({ brand: b.brand, at: i, len: k.length + (tail ? tail[0].length : 0) });
      i = t.indexOf(k, i + 1);
    }
  }
  hits.sort((a, c) => a.at - c.at || c.len - a.len);
  const out = [];
  for (const h of hits) if (!out.some(o => h.at < o.at + o.len && o.at < h.at + h.len)) out.push(h);
  return out;
}

export function findProduct(M, name) {
  const t = norm(fixAlias(name));
  for (const p of M.products) for (const k of p.keys) if (t.includes(k) || (k.includes(t) && t.length >= 2)) return p;
  return null;
}

function fixAlias(s) {
  let out = s;
  for (const [a, b] of Object.entries(ALIASES)) out = out.split(a).join(b);
  return out;
}

// 分店提示（「中環店」「元朗旗舰店」）→ 这个牌子里名字 / 地址 / 区对得上的分店
export function branchesByHint(M, brand, hint) {
  const h = norm(hint).replace(/(全新|三层|有|的|店|分店)/g, '');
  if (!h) return [];
  const en = Object.entries(PLACE_EN).filter(([zh]) => h.includes(zh)).map(([, e]) => e);
  const flagship = /旗舰/.test(h);
  const place = h.replace(/旗舰/g, '');
  const toks = hintTokens(place);
  return M.stores.filter(s => {
    if (s.brand !== brand) return false;
    const hay = norm(s.name + ' ' + s.addr + ' ' + s.district);
    const tokOk = t => hay.includes(t) || (PLACE_EN[t] && hay.includes(PLACE_EN[t].replace(/\s/g, '')));
    const placeOk = !place || hay.includes(place) || (toks.length > 1 ? toks.every(tokOk) : en.some(e => hay.includes(e.replace(/\s/g, ''))));
    const flagOk = !flagship || hay.includes('旗舰');
    return placeOk && flagOk;
  }).map(s => s.id);
}

// 「尖沙咀国际广场」→ [尖沙咀, 国际广场]：地名单拎出来，中英文分开
function hintTokens(h) {
  const places = Object.keys(PLACE_EN).sort((a, b) => b.length - a.length);
  const out = [];
  for (const run of String(h).match(/[a-z0-9]+|[^a-z0-9]+/g) || []) {
    let rest = run;
    for (const p of places) if (rest.includes(p)) { out.push(p); rest = rest.split(p).join(' '); }
    out.push(...rest.split(' ').filter(Boolean));
  }
  return out;
}

let seq = 0;
const newId = () => 'i' + Date.now().toString(36) + (seq++).toString(36);

// 主函数：text → { items, unknown, headers }
// item = { id, name, qty, who:[..], note, where:{type, brand?, brands?, stores?, preferred?}, must, heavy, backupFor, status:'todo', src }
export function parseList(text, data, opts = {}) {
  const M = opts.matcher || buildMatcher(data);
  const items = [], unknown = [];
  let who = opts.defaultWho || '';
  let sectionFirstStoreItem = null;

  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(LEAD, '').replace(LEAD, '').trim();
    if (!line) continue;
    line = fixAlias(line);
    // ---- 「东西-给谁」（0924 Nathan 的计划一行一样这么写：「安怡 x 2罐-给谁」「无糖奶粉-谁和谁-我来买」）----
    // 行尾 -xxx（≤8 字、没数字）是给谁（按 和/、 拆成几个人）；再往后的 -yyy 当备注。原来整串「-给谁」都进了名字。
    let lineWho = [], lineNote = [];
    {
      const segs = line.split(/\s*[-－—–]\s*/);
      const tail = segs.slice(1).filter(Boolean);
      if (segs.length > 1 && segs[0].trim() && tail.length && tail.every(t => t.length <= 8 && !/\d/.test(t))) {
        line = segs[0].trim();
        lineWho = tail[0].split(/[和、&＆,，]/).map(x => x.trim()).filter(Boolean);
        lineNote = tail.slice(1);
      }
    }

    // ---- 给谁的标题 ----
    const brandsHere = findBrands(M, line);
    const prodHere = findProduct(M, line);
    const isHeader = /[:：]$/.test(line) || (!brandsHere.length && !prodHere && line.length <= 12 && (PERSON.test(line) || /[&＆]/.test(line)) && !/[*×xX]\s*\d/.test(line));
    if (isHeader) {
      who = line.replace(/[:：]$/, '').replace(/更新$/, '').trim();
      sectionFirstStoreItem = null;
      continue;
    }

    // ---- 整行共用的：括号、数量、特殊说法 ----
    let rest = line;
    const extraWho = [];
    const notes = [];
    let backup = false, heavy = false, must = true;
    let preferHint = null;
    const extras = [];   // 「X 我要用」
    const parenStores = []; // [{brand, hint, at}]
    const parenBranch = [];  // 「中環店」这种，挂到它前面最近的牌子
    rest = rest.replace(/[（(]([^）)]*)[）)]/g, (m, inner, at) => {
      const s = inner.trim();
      if (/我们也买/.test(s)) { extraWho.push('我们'); return ' '; }
      if (/^(顺路(才)?买|有就买|可买可不买|不一定要)$/.test(s)) { must = false; return ' '; }
      if (/^(重物|很重|放最后(买)?)$/.test(s)) { heavy = true; return ' '; }
      const bs = findBrands(M, s);
      if (bs.length) {
        // 「(万宁 / 惠康)」两家都算；「(万宁 尖沙咀国际广场)」后半截是分店。
        // ★ 原来只取第一家、分店只认「…店」结尾：惠康被悄悄丢掉，路线变窄却不说。
        const ns = norm(s);
        let rest = '';
        for (let i = 0; i < ns.length; i++) if (!bs.some(b => i >= b.at && i < b.at + b.len)) rest += ns[i];
        rest = rest.replace(/[\/／、,，或和及]|都行|都可以|都可|任选|选一家/g, '');
        parenStores.push({ brands: [...new Set(bs.map(b => b.brand))], hint: rest, at });
        return ' ';
      }
      if (/店$/.test(s)) { parenBranch.push({ hint: s, at }); return ' '; }
      if (s) notes.push(s);
      return ' ';
    });
    if (/第一家买的差不多就不去|前面买够了就不去|买够了就不去/.test(rest)) { backup = true; rest = rest.replace(/[，,]?\s*第一家买的差不多就不去这家|[，,]?\s*(前面)?买够了就不去(这家)?/g, ' '); }
    rest = rest.replace(/[，,]?\s*可以挑选离得近的门店|[，,]?\s*挑(选)?离得近的(门店|分店)?|[，,]?\s*就近(买)?/g, ' ');
    rest = rest.replace(/([一-龥]{2,4})有(全新)?[一-龥]{0,4}旗舰店/g, (m, place) => { preferHint = place + '旗舰'; return ' '; });
    rest = rest.replace(/对比价格|比较价格|比价/g, () => { notes.push('对比价格'); return ' '; });
    if (/顺路(才)?买|有就买|可买可不买|不一定要/.test(rest)) { must = false; rest = rest.replace(/[（(]?(顺路(才)?买|有就买|可买可不买|不一定要)[）)]?/g, ' '); }
    if (/重物|很重|放最后/.test(rest)) { heavy = true; rest = rest.replace(/重物|很重|放最后(买)?/g, ' '); }
    rest = rest.replace(/([一-龥A-Za-z0-9版]{2,10})我要用/g, (m, x) => { extras.push(x); return ' '; });
    rest = rest.replace(/\s+/g, ' ').trim();

    // ---- 拆成「店 → 东西」 ----
    const pieces = []; // [{brands:[..], names:[..], hint?, oneOf?}]
    const sep = rest.match(/^(.+?)[～~:：](.*)$/);
    if (sep) {
      const left = sep[1].trim();
      const lb = findBrands(M, left);
      if (lb.length) {
        const names = splitNames(sep[2]);
        pieces.push({ brands: lb.map(b => b.brand), oneOf: lb.length > 1 && /[\/／或]/.test(left), names, hint: branchHintFrom(left, lb) });
      } else {
        // 左边不是店名：「主礼：…」这种，当备注
        notes.push(left);
        pieces.push(...piecesFromFree(M, sep[2]));
      }
    } else {
      pieces.push(...piecesFromFree(M, rest));
    }

    // 括号里的店：管这一行所有没有店的东西
    for (const p of pieces) {
      if (!p.brands.length && parenStores.length) {
        const ps = parenStores[0];
        p.brands = ps.brands;
        if (ps.brands.length > 1) p.oneOf = true;
        else if (ps.hint) p.hint = ps.hint;
      }
    }
    for (const pb of parenBranch) {
      // 挂到行里最后一个出现在它前面的店
      const target = [...pieces].reverse().find(p => p.brands.length && (p.at == null || p.at <= pb.at)) || pieces.find(p => p.brands.length);
      if (target) target.hint = pb.hint;
      else notes.push(pb.hint);
    }

    let producedStoreItem = null;
    for (const p of pieces) {
      const names = p.names.length ? p.names : [''];
      for (let nm of names) {
        const q = nm.match(/[*×xX＊]\s*(\d+)/);
        const qty = q ? Number(q[1]) : 1;
        nm = nm.replace(/[*×xX＊]\s*\d+\s*(?:罐|盒|包|瓶|袋|个|支|条|套|份|箱)?/, '').trim();   // 「x 2罐」量词一起吃掉，别留个「罐」在名字里
        const item = { id: newId(), name: nm || '（到店再定）', qty, who: [...(lineWho.length ? lineWho : [who]), ...extraWho].filter(Boolean), note: '',
          where: null, must, heavy: heavy || /奶粉/.test(nm), backupFor: null, status: 'todo', src: raw.trim() };
        const noteBits = [...notes, ...lineNote];
        // 「川贝杏仁露润喉止咳」：前面对上这家店卖的东西，后面算备注
        if (p.brands.length === 1 && nm) {
          const b = M.brands.find(x => x.brand === p.brands[0]);
          for (const s of b.sells) {
            const k = norm(String(s).replace(/[（(].*$/, ''));
            const nn = norm(nm);
            if (k.length >= 2 && nn.startsWith(k) && nn.length > k.length) { item.name = nm.slice(0, k.length); noteBits.push(nm.slice(k.length)); break; }
          }
        }
        item.note = noteBits.join('；');
        if (p.brands.length) {
          if (p.oneOf) item.where = { type: 'oneOf', brands: p.brands };
          else {
            const brand = p.brands[0];
            const hinted = p.hint ? branchesByHint(M, brand, p.hint) : [];
            const pref = preferHint ? branchesByHint(M, brand, preferHint) : [];
            if (hinted.length) item.where = { type: 'branch', brand, stores: hinted, hint: p.hint };
            else if (pref.length) item.where = { type: 'preferred', brand, preferred: pref, hint: preferHint };
            else item.where = { type: 'brand', brand };
            if (p.hint && !hinted.length) item.note = [item.note, `没找到「${p.hint}」这家分店，先按任一分店排`].filter(Boolean).join('；');
          }
        } else {
          const prod = findProduct(M, nm);
          if (prod) item.where = { type: 'category', brands: prod.brands, product: prod.product };
        }
        if (!item.where) { unknown.push({ ...item, why: '不知道在哪买' }); continue; }
        items.push(item);
        if (!producedStoreItem && item.where.brand) producedStoreItem = item;
      }
    }
    for (const x of extras) {
      const prod = findProduct(M, x);
      const item = { id: newId(), name: x, qty: 1, who: [who].filter(Boolean), note: '我要用', where: prod ? { type: 'category', brands: prod.brands, product: prod.product } : null,
        must: true, heavy: false, backupFor: null, status: 'todo', src: raw.trim() };
      if (item.where) items.push(item); else unknown.push({ ...item, why: '不知道在哪买' });
    }
    if (backup) {
      const firstId = sectionFirstStoreItem ? sectionFirstStoreItem.where.brand : null;
      // 没写买什么的备选（「奇华饼家～第一家买的差不多就不去」）：名字写成要补的那几样，站在店里一眼知道买什么
      const primaryNames = firstId ? items.filter(i => i.where && i.where.brand === firstId).map(i => i.name) : [];
      for (const it of items.filter(i => i.src === raw.trim())) {
        it.backupFor = firstId;
        if (it.name === '（到店再定）' && primaryNames.length) it.name = `补${firstId}没买够的：${primaryNames.join('、')}`;
      }
      if (!firstId) notes.push('没找到它顶替的是哪家');
    }
    if (!sectionFirstStoreItem && producedStoreItem && !backup) sectionFirstStoreItem = producedStoreItem;
    if (!pieces.length && !extras.length) unknown.push({ id: newId(), name: line, src: raw.trim(), why: '没看懂这一行' });
  }
  return { items, unknown };
}

function splitNames(s) {
  // ★ 不按「和」拆：「甘和茶」会被拆成「甘」「茶」
  return String(s).split(/[、，,；;\/／]/).map(x => x.trim()).filter(Boolean);
}

function branchHintFrom(left, lb) {
  const m = left.match(/([一-龥]{2,4})店/);
  return m && !lb.some(b => norm(left).slice(b.at, b.at + b.len).includes(norm(m[1]))) ? m[0] : null;
}

// 没有「～」的一行：可能有 0 / 1 / 多个店名
// 「小零食去大生超市买巧克力、玛莎超市」→ 大生：巧克力；玛莎：小零食
function piecesFromFree(M, text) {
  const t = String(text).trim();
  if (!t) return [];
  const hits = findBrands(M, t);
  if (!hits.length) {
    const names = splitNames(t);
    return names.length ? [{ brands: [], names }] : [];
  }
  // norm() 去掉了空格，位置要换回原文：按字符逐个对
  const map = []; let k = 0;
  for (let i = 0; i < t.length; i++) { if (!/\s/.test(t[i])) map[k++] = i; }
  map[k] = t.length;
  const segs = hits.map((h, i) => ({ brand: h.brand, start: map[h.at], end: map[h.at + h.len], next: i + 1 < hits.length ? map[hits[i + 1].at] : t.length }));
  const lead = t.slice(0, segs[0].start).replace(/(去|到|在)$/, '').trim();
  const out = [];
  for (const s of segs) {
    let after = t.slice(s.end, s.next).replace(/^[\s买:：]+/, '').replace(/[、，,\s]+$/, '').trim();
    let names = splitNames(after);
    if (!names.length && lead) names = splitNames(lead);
    out.push({ brands: [s.brand], names, at: s.start });
  }
  if (hits.length === 1 && lead && out[0].names.length && out[0].names.join() !== splitNames(lead).join()) {
    // 「面膜*2 龙丰」这种店名在后：前面那段也是这家店的
    out[0].names = [...splitNames(lead), ...out[0].names];
  }
  return out;
}
