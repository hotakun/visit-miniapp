// 客户详情（演示）· 纯静态演示页（2026-09-13 老板要求）
// ---------------------------------------------------------------------------
// 定位：**给老板看效果的演示页**，数据写死（胡记牛骨头那套示例），
//      不连云端、不写库；交互（录入/点改/拍照/折叠）只改本页内存，退出重进即恢复。
// 配色：照 `_scratch/客户详情页-A-手机演示.html`（白卡 + 品牌橙 + 暖白底）。
// 入口：老板首页「今日战况」黑色卡片下面那个按钮。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2026-09-25 改造（老板定）：本页从「纯静态演示页」升级为**真数据页** ——
//   数据来自云函数 `tasks` 的 `custDetail`（一次返回档案 + 订单 + 明细 + 备注 + 拜访历史）。
//   界面骨架与下面这份 `D` 的字段结构**保持原样**（wxml 一个字没改），只是运行时把 D 换成真数据。
//   本文件顶部那份 D 是**兜底结构参考**，实际显示以 onLoad 组装出来的对象为准。
// ---------------------------------------------------------------------------

// ⚠️ 2026-09-25 补：demo 页原来数据写死、不连云端，所以**没有 require api**；
//    改成真数据页后必须引用（否则一进页面就报 `api is not defined`）。
//    项目规矩：云函数调用一律走这个单入口 utils/api.js 的 call(name, data)。
const api = require('../../utils/api');

// ---------- 工具 ----------
function esc(s) { return String(s == null ? '' : s); }
function daysAgo(dateStr) {                      // 'YYYY-MM-DD' → 'X 天前' / '今天'
  if (!dateStr) return '';
  const d = new Date(String(dateStr).replace(/-/g, '/') + ' 00:00:00');
  if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days > 0 ? days + ' 天前' : '今天';
}
function mdShort(at) {                           // 时间戳/日期 → 'MM-DD'（备注历史用，不带年份）
  if (!at) return '';
  const d = new Date(typeof at === 'number' ? at : String(at).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return '';
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function mdCn(dateStr) {                         // 'YYYY-MM-DD' → '8月24日'（订单列表用）
  if (!dateStr) return '';
  const p = String(dateStr).slice(0, 10).split('-');
  return p.length === 3 ? (Number(p[1]) + '月' + Number(p[2]) + '日') : String(dateStr);
}
function fmtDur(sec) {                           // 秒 → '2 分 30 秒' / '45 秒'（录音时长，2026-09-27）
  const n = Math.round(Number(sec) || 0);
  if (!n) return '';
  const m = Math.floor(n / 60), s = n % 60;
  return m ? (m + ' 分' + (s ? (' ' + s + ' 秒') : '')) : (s + ' 秒');
}
function uniqueJoin(a, b, c) {                   // 大中小类去重后拼（'美食 · 东北菜'）
  const seen = [], out = [];
  [a, b, c].forEach(x => {
    const t = esc(x).trim();
    if (t && seen.indexOf(t) < 0) { seen.push(t); out.push(t); }
  });
  return out.join(' · ');
}
// 2026-09-25 老板定：**地址不显示省份和地级市** ——
//   例：浙江省金华市永康市市场路188号 → 永康市市场路188号
//   做法：拿 region（"浙江省>金华市>永康市"）拆出前两级，**只剥开头匹配**的（不匹配就原样返回，不会误删）。
function stripProvCity(addr, region) {
  let s = String(addr || '').trim();
  if (!s) return '';
  const parts = String(region || '').split('>');
  [parts[0], parts[1]].forEach(p => {
    const t = String(p || '').trim();
    if (t && s.indexOf(t) === 0) s = s.slice(t.length);
  });
  return s.trim();
}
// 2026-09-25 老板定：**名称里带「赠品」字样的品种，不进「常买」** ——
//   例：「【赠品】4kg洗洁精雕牌」「【赠品】礼品：聚火配送围裙」「【赠品】航空水晶杯」。
//   老板原话「是带有"赠品"字样的品种不要显示」→ **只认这两个字**，不要自己扩展别的规则。
function isGift(name) {
  return String(name || '').indexOf('赠品') >= 0;
}
// 2026-09-25 老板定：**营业时间里的换行符要去掉，折成一行** ——
//   大众点评原始数据里 hours 自带换行（实测 463 家里 169 家有），如：
//     '周一至周日\n09:00-13:30\n18:00-22:00'
//   ⚠️ 这类换行是**字符里的真 `\n`**，CSS 的 white-space:nowrap 治不了（而且小程序 <text> 会保留 \n）。
//   老板选的方案 B：**换行换成空格**，多余空白合并，结果 → '周一至周日 09:00-13:30 18:00-22:00'
function flatHours(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || '未收录营业时间';
}
// 平台「收录时间」→ 收录年数（≥3 年才在店名旁显示胶囊）
function listedYears(v) {
  if (!v) return 0;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Math.max(0, Math.floor((Date.now() - new Date(m[0].replace(/-/g, '/')).getTime()) / 31536000000));
  const n = Number(s);                            // Excel 序列号（1899-12-30 起算）
  if (isFinite(n) && n > 20000) {
    const days = n - 25569;                       // 1970-01-01 的 Excel 序号
    return Math.max(0, Math.floor((Date.now() - days * 86400000) / 31536000000));
  }
  return 0;
}

// ---------- 组装：把 custDetail 的返回变成页面要的 D ----------
function buildD(res, photoUrls, recUrls) {
  const c = res.customer || {};
  const p = c.plat || {};
  const pm = c.platManual || {};
  const orders = res.orders || [];
  const items = res.orderItems || {};
  // 2026-09-25 老板定：**「常买」里去掉「本身就是赠品」的品种**
  //   数据里的标识是**名称带「赠品」**（如「【赠品】4kg洗洁精雕牌」），
  //   另有「聚火内部专用」这类内部用品（0 价、也不是客户订的货）一并去掉。
  //   ⚠️ 不能简单按「卖价为 0」筛 —— 像「27cm笑脸塑料袋」是正常商品，只是偶尔 0 价送过，老板要保留。
  const topGoods = (res.topGoods || []).filter(g => !isGift(g.name));
  const hasMall = !!(c.mallKey || c.customerType === 'mall');
  const goodText = (o, r) => (Number(r.qty) || 0) + (r.unit ? ' ' + r.unit : ' 件') + ' · ¥' + (r.price != null ? r.price : '—');

  // 门店照片三格（fileID 已在外层换成可直接显示的 URL；空位补空串，保证恒为 3 格）
  const photos = (photoUrls && photoUrls.length ? photoUrls : []).slice(0, 3);
  while (photos.length < 3) photos.push('');

  // 招牌菜：平台抓的 + 业务员现场录的（platManual.dishes）
  const dishes = String(p.dishes || '').split(',').map(x => x.trim()).filter(Boolean);
  (pm.dishes || []).forEach(x => { if (x && dishes.indexOf(x) < 0) dishes.push(x); });
  // 设施：三类合并（特色服务 / 服务设施 / 配套设施），平台是空格分隔 → 拆标签
  const facRaw = [p.features, p.services, p.facilities].filter(Boolean).join(' ');
  const fac = facRaw.split(/\s+/).map(x => x.trim())
    .filter(x => x && !/^收录\d+年$/.test(x));   // 配套设施里混着的「收录N年」滤掉
  (pm.facs || []).forEach(x => { if (x && fac.indexOf(x) < 0) fac.push(x); });
  // ⭐ 2026-09-27：业务员现场提报（待管理员审核）—— 菜品/设施并入列表并标「（待审核）」；团购外卖记 flagPending
  const frs = res.fieldReports || [];
  const flagPending = {};
  frs.forEach(f => {
    if (f.kind === 'dish' && f.value) { const t = f.value + '（待审核）'; if (dishes.indexOf(t) < 0) dishes.push(t); }
    else if (f.kind === 'fac' && f.value) { const t = f.value + '（待审核）'; if (fac.indexOf(t) < 0) fac.push(t); }
    else if (f.kind === 'flag' && f.flagName) flagPending[f.flagName] = true;
  });

  // 订单：日期 + 金额 + 商品行（点开看明细）
  const ordList = orders.map(o => ({
    d: mdCn(o.orderedAt),
    a: Number(o.actualAmount) || 0,
    open: false,
    items: (items[o.orderNo] || []).map(r => [r.name || '（未命名商品）', r.spec || '', (Number(r.qty) || 0) + (r.unit ? ' ' + r.unit : ' 件'), Number(r.amount) || 0])
  }));

  // 备注：新 → 旧；日期不带年份
  const remarks = (res.remarks || []).map(r => ({ d: mdShort(r.at), t: esc(r.text) }));

  // 拜访历史：状态胶囊 / 日期时间 / 拜访人 / 时长 / 文字 / 样品 / 现场证据
  const ST = { normal: '已回访', pending_review: '待审核', ongoing: '拜访中', cancelled: '已取消' };
  const history = (res.visits || []).map((v, i) => {
    const at = String(v.visitedAt || '');
    const md = at ? (mdCn(at) + (v.duration ? '' : '')) : '';
    return {
      tag: ST[v.status] || '已回访',
      md: md + (v.duration ? '' : ''),
      who: esc(v.salesmanName) || '—',
      mins: v.duration ? ('时长 ' + Math.round(v.duration / 60) + ' 分钟') : '',
      txt: esc(v.remark) || esc(v.trText) || '',
      samp: esc(v.samples) || '',
      latest: i === 0,
      open: false,
      // ⭐ 2026-09-27：真录音（fileID 已在 onLoad 换成临时 URL）—— 有 URL 才出播放条；
      //   转写文字独立判断（wxml 里 rec.txt 为空就不出那一块）
      rec: (function () {
        const au = (v.audios || []).filter(a => a && a.fileID && recUrls && recUrls[a.fileID]);
        if (!au.length) return null;
        return { url: recUrls[au[0].fileID], dur: fmtDur(au[0].duration), txt: esc(v.trText) || '', playing: false, pct: 0 };
      })(),
      shots: (v.thumbs || []).slice(0, 3)
    };
  });

  return {
    // 地址：老板 2026-09-25 定 —— **不显示省份和地级市**（浙江省金华市永康市… → 永康市…）
    name: esc(c.name), addr: stripProvCity(c.address, c.region), hours: flatHours(p.hours),
    status: esc(p.bizStatus) || '',
    // 游客（实习）打码：后四位 ****（2026-09-08 口径「游客不能看完整电话」；maskTrialPhone 对已打码串幂等）
    tel: api.isTrialUser() ? api.maskTrialPhone(esc(c.phone) || esc(p.phone1) || '') : (esc(c.phone) || esc(p.phone1) || ''),
    contact: esc(c.contactName) || '', hasMall: hasMall,
    listedYears: listedYears(p.listedTime),
    cat: uniqueJoin(p.cat1, p.cat2, p.cat3),
    rank: esc(p.rank),
    mallRows: [
      ['注册商城时间', esc(c.mallJoinedAt) || '—'],
      ['签约业务员', esc(c.salesman) || '—'],
      ['最近下单', esc(c.lastOrderAt) ? (mdCn(c.lastOrderAt) + (daysAgo(c.lastOrderAt) ? '（' + daysAgo(c.lastOrderAt) + '）' : '')) : '—'],
      ['最近浏览商城', esc(c.lastBrowseAt) ? (mdCn(c.lastBrowseAt) + (daysAgo(c.lastBrowseAt) ? '（' + daysAgo(c.lastBrowseAt) + '）' : '')) : '—']
    ],
    // ⭐ 2026-09-27：商城信息卡头小字（原 wxml 里写死「最近购买 8月24日」）——
    //   最近购买 → 没有则 最近浏览 → 再没有 注册；未入商城直接「未加入商城」
    mallSub: hasMall
      ? (esc(c.lastOrderAt) ? ('最近购买 ' + mdCn(c.lastOrderAt))
        : (esc(c.lastBrowseAt) ? ('最近浏览 ' + mdCn(c.lastBrowseAt))
          : (esc(c.mallJoinedAt) ? ('注册 ' + mdCn(c.mallJoinedAt)) : '')))
      : '未加入商城',
    photos: photos,
    purchase: {
      total: (res.orderTotal || 0) + ' 单',
      amount: '¥' + Math.round(res.orderAmountSum || 0),
      last: orders[0] ? (mdCn(orders[0].orderedAt) + (daysAgo(orders[0].orderedAt) ? '（' + daysAgo(orders[0].orderedAt) + '）' : '')) : '',
      freq: topGoods.map(g => [g.name, Math.round(g.qty)]),
      lastItems: '',
      note: ''            // 老板 2026-09-13 定：不要「💡 补货提示」
    },
    orders: ordList,
    rate: esc(p.rating) || '',
    // ⭐ 2026-09-27：卡头小字（原来把「人均 ¥46/人」写死在 wxml 里 —— 那是演示稿的假数据）
    rateSub: (esc(p.rating) ? (esc(p.rating) + ' 分') : '平台未收录')
      + (esc(p.rating) && esc(p.avgPriceText) ? (' · ' + esc(p.avgPriceText)) : ''),
    newShop: !!esc(p.newShop),      // ⭐「新店」蓝胶囊（平台"新店标签"有值就显示）
    rateTxt: esc(p.reviewCount) ? (esc(p.reviewCount) + ' 条评价' + (p.reviewCount2025 ? '（2025年 ' + esc(p.reviewCount2025) + ' 条）' : '')) : '',
    bars: [['口味', esc(p.taste) || '—', 0], ['环境', esc(p.env) || '—', 0], ['服务', esc(p.service) || '—', 0]]
      .map(b => [b[0], b[1], (parseFloat(b[1]) || 0) / 5 * 100]),
    extra: [
      ['人均消费', esc(p.avgPriceText) || '—'],
      ['评论总数', esc(p.reviewCount) ? (esc(p.reviewCount) + ' 条') : '—']
    ].concat(Number(p.chainCount) >= 1 ? [['连锁情况', esc(p.chainCount) + ' 家']] : []),   // 单店不显示（老板定）
    dishes: dishes, flags: [['团购', !!p.groupon], ['外卖', !!p.takeout]],
    flagPending: flagPending,      // ⭐ 2026-09-27：待审核的团购/外卖（wxml 显示「· 待审核」）
    // 商圈：老板 2026-09-25 定 —— **也不显示省和地级市** →
    //   原来拼了 `c.region`（"浙江省>金华市>永康市"）会重复出现省级信息，现在**只显示商圈名**（平台 regionName）。
    fac: fac, region: esc(p.regionName),
    lat: Number(c.lat) || 0, lng: Number(c.lng) || 0,
    meLat: 0, meLng: 0, route: [],
    // 2026-09-25 老板定：这家正在拜访中 → 底部按钮变**蓝色「拜访中」**（由云函数 visitOngoing 判定）
    visiting: !!res.visitOngoing,
    remarks: remarks, history: history
  };
}

// ⭐ 2026-09-28 老板定：默认展开**固定**为「📝 管理员备注 + 🕑 拜访历史」，其它卡一律收起。
//   （覆盖 2026-09-27 的"按内容判断"版本 —— 那版在"没备注也没历史"时会自动展开「🏪 商城信息」，
//    老板实际看到的一直是商城信息卡打开，要求改成固定开这两张。）
//   注：参数 d 保留（调用方仍会传），当前不再使用。
function defaultOpen(d) {
  return { mall: false, purchase: false, rate: false, serv: false, remark: true, hist: true };
}

const D = {
  name: '胡记牛骨头(永康东塔店)',
  addr: '浙江省金华市永康市新天大厦西(东塔路)',
  hours: '周一至周日 09:00-22:00',
  status: '正常营业',
  tel: '15257811518',
  contact: '胡老板',
  hasMall: true,
  listedYears: 6,                                  // 平台收录 6 年 → 店名旁淡红胶囊
  cat: '美食 · 东北菜',                             // 大中小类（去重后）
  rank: '东站美食热门榜 · 第1名',                    // 榜单信息（口碑卡内 + 品类行右侧）
  // 🏪 商城信息
  mallRows: [
    ['注册商城时间', '2025-08-14'],
    ['签约业务员', '快餐盒c聚火配送🔥'],
    ['最近下单', '8月24日（19 天前）'],
    ['最近浏览商城', '9月5日（7 天前）']
  ],
  photos: ['', '', ''],                            // 门店照片三格（空 = 可现场拍）
  // 📦 购买记录
  purchase: {
    total: '13 单',
    amount: '¥1,744',
    last: '8月24日（19 天前）',
    freq: [['500方盒小', 5], ['750方盒小', 3], ['1000圆碗小', 3], ['450圆碗', 2], ['750圆碗小', 2], ['1500圆碗小', 2]],
    lastItems: '450圆碗 ×1 ｜ 1000圆碗小 ×1 ｜ 本单 ¥154',
    note: '这家的节奏大概两三周补一次货，最近一单已经是 19 天前 —— 大概率该补了，先问碗盒够不够'
  },
  orders: [
    { d: '8月24日', a: 154, items: [['450圆碗', '透明×450套', '1 箱', 78], ['1000圆碗小', '透明×300套', '1 箱', 76]] },
    { d: '8月15日', a: 101, items: [['DS1大号汤勺', '透明×1000个', '1 箱', 45], ['500方盒小', '透明×300套', '1 箱', 56]] },
    { d: '8月13日', a: 129, items: [['P1调料盒连体', '透明×2000套', '1 箱', 73], ['500方盒小', '透明×300套', '1 箱', 56]] },
    { d: '7月24日', a: 238, items: [['500方盒小', '透明×300套', '2 箱', 112], ['750方盒小', '透明×300套', '1 箱', 69], ['500方盒大', '透明×300套', '1 箱', 57]] },
    { d: '7月14日', a: 222, items: [['750圆碗小', '透明×300套', '1 箱', 70], ['1000圆碗小', '透明×300套', '1 箱', 76], ['1500圆碗小', '透明×200套', '1 箱', 76]] },
    { d: '5月4日', a: 224, items: [['500方盒小', '透明×300套', '4 箱', 224]] },
    { d: '5月3日', a: 208, items: [['750方盒小', '透明×300套', '2 箱', 138], ['750圆碗小', '透明×300套', '1 箱', 70]] },
    { d: '4月10日', a: 72, items: [['1000方盒小', '透明×300套', '1 箱', 72]] }
  ],
  // 📊 平台口碑
  rate: '3.7',
  rateTxt: '11 条评价（2025年）· 分项齐全',
  bars: [['口味', '3.8', 76], ['环境', '3.7', 74], ['服务', '3.7', 74]],
  extra: [['人均消费', '¥46/人'], ['评论总数', '11 条（2025年）']],   // 「连锁情况」是单店 → 不显示
  dishes: ['胡记牛肉', '营养咸饭', '牛杂炒面', '小肚丝面', '养生牛尾汤'],
  // 🛎 服务与设施
  flags: [['团购', false], ['外卖', true]],          // 外卖默认已开
  fac: ['明厨亮灶', '花园餐厅', '沿街', '空调开放', '可预点餐', '宝宝椅', '免费停车', '可电话预定'],
  region: '城东路 · 永康市',
  // 客户坐标（2026-09-13：商圈与位置的小地图用）—— 真身来自客户表 lng/lat；**纬度在前**显示（项目口径）
  lat: 28.8892, lng: 120.05388,
  // 「我」的假位置（2026-09-13 老板定）：离客户约 **80 米**（斜向 56.6m + 56.6m，东北方向）—— 演示用，
  // 真身是业务员实时定位（wx.getLocation）；这里写死一个点位，不申请定位权限
  meLat: 28.8897082, meLng: 120.0544605,
  // 步行路线（2026-09-13 老板要：从蓝点画条路径到店）：[纬度, 经度] 依次是
  //   我 → 向西 → 向南 → 向西 → 向南进店（4 个拐点，走街区；纯演示，真机可用腾讯路线规划）
  route: [
    [28.8897082, 120.0544605],   // ① 我（蓝点）
    [28.8897082, 120.0542100],   // ② 沿街向西 ≈ 24 米
    [28.8895600, 120.0542100],   // ③ 向南 ≈ 16 米
    [28.8895600, 120.0538800],   // ④ 向西 ≈ 32 米
    [28.8892000, 120.0538800]    // ⑤ 向南进店（客户坐标）
  ],
  // 📝 管理员备注
  remarks: [
    { d: '09-05', t: '老板交代重点跟进：这家人流好、单价不低，先谈小额试单。' },
    { d: '08-28', t: '已加上老板微信（同手机号）。他说下月可能补 1000 圆碗，先别催单。' }
  ],
  // 🕑 拜访历史
  history: [
    { tag: '已下单', md: '8月30日 14:20', who: '快餐盒c聚火配送🔥', mins: '时长 26 分钟', txt: '带了两款样品，老板要了 3 箱试销，说下周看动销。', samp: '牛骨头 · 小份装 ×3', latest: true, open: false,
      /* 现场证据（演示）：一段拜访录音 + 它的转写文字 + 现场拍的 3 张餐盒照片
         —— 照片是包内的缩略小图（images/box-demo-*.jpg）；录音是模拟播放（真机里放真实文件） */
      rec: {
        dur: '02:14', playing: false, pct: 0,
        txt: '老板说这周先拿三箱试销，主要要 500 方盒小和 750 方盒小，价格再谈谈；另外他妹妹那家店也可以一起带两箱，下周一起送。'
      },
      shots: ['/images/box-demo-1.jpg', '/images/box-demo-2.jpg', '/images/box-demo-3.jpg'] },
    { tag: '已注册商城', md: '8月14日 10:05', who: '快餐盒c聚火配送🔥', mins: '时长 18 分钟', txt: '老板当场扫码注册，手机号已开通。', samp: '', latest: false, open: false }
  ]
};

Page({
  data: {
    // 2026-09-25 改造：**初始为空** —— 真数据在 onLoad 里从 custDetail 取回后 setData 填入。
    // （原来写死 `d: D` 会让页面打开瞬间闪一下示例数据；wxml 也加了 wx:if="{{d}}" 兜住）
    d: null,
    loadErr: '',   // 加载失败原因（2026-09-25 加：直接显示在页面上，别只弹一个会被盖掉的 toast）
    // 地图标记 / 路线：初始为空，onLoad 拿到真坐标后用 _mkMarkers() 生成
    //（客户 = 橙针 60% 透明 + 常显店名气泡；「我」= 蓝点，只有定位成功才加）
    markers: [],
    polyline: [],
    open: { mall: false, purchase: false, rate: false, serv: false, remark: false, hist: false },   // ⭐ 实际展开由 defaultOpen(d) 算（见 onLoad）
    // 弹层
    addShow: false, addKind: '', addTitle: '', addPh: '', addVal: '',
    flagShow: false, flagName: '', flagTo: true,
    // ⭐ 2026-09-27：📍报错弹层（接 coordfix 真提交）
    fixShow: false, fixNote: '', fixShots: ['', '', ''],
    sheetShow: false,
    viewerShow: false, viewerUrl: ''
  },

  // ---------- 加载真数据（2026-09-25 新增）----------
  // 入口参数：`?id=<customerId>`（或 customerId）；数据来自 tasks 云函数的 custDetail。
  async onLoad(query) {
    // 客户 id 的两个来源（按优先级）：
    //   ① 入口参数 ?id=xxx（新写法，将来用）
    //   ② 上一页塞进 storage 的 `curCustomer._id` —— **现有两个入口都走这条**：
    //      pages/task 和 pages/map 点客户时都会先 setStorageSync('curCustomer', 客户对象) 再跳过来。
    //      （那两处 navigateTo 不带 url 参数；这里兜底读 storage 更稳，也兼容将来新入口。）
    const cc = wx.getStorageSync('curCustomer') || {};
    const id = (query && (query.id || query.customerId)) || cc._id || '';
    this._cid = id;
    this._taskId = (query && query.taskId) || cc.taskId || '';   // 开始拜访要用（任务设置也从 cc 兜底）
    if (!id) { this.setData({ loadErr: '缺少客户参数（上一页没传客户 id）' }); return; }
    this.setData({ loadErr: '' });
    try {
      const res = await api.call('tasks', { action: 'custDetail', customerId: id });
      // 把云函数返回的**原始错误**带出来（光看"加载失败"没法排查）
      if (!res || !res.ok) {
        throw new Error('云函数返回：' + ((res && (res.msg || res.code)) || JSON.stringify(res || null)));
      }
      this._cust = res.customer || {};              // 原始档案（白名单后的）

      // 门店照片：云存储 fileID **不能直接塞给 <image>** → 先换临时 URL
      let photoUrls = [];
      const raw = ((res.customer && res.customer.photos) || []);
      const ids = raw.map(p => (p && (p.fileID || p.thumbID)) || (typeof p === 'string' ? p : '')).filter(Boolean);
      if (ids.length) {
        try {
          const r = await wx.cloud.getTempFileURL({ fileList: ids.slice(0, 3) });
          photoUrls = (r.fileList || []).map(x => x.tempFileURL).filter(Boolean);
        } catch (e) { /* 取图失败不影响其它内容 */ }
      }

      // ⭐ 2026-09-27：拜访录音同理（audio fileID → 临时 URL；一次最多 20 个，够覆盖近几条历史）
      let recUrls = {};
      const recIds = [];
      (res.visits || []).forEach(v => (v.audios || []).forEach(a => { if (a && a.fileID) recIds.push(a.fileID); }));
      if (recIds.length) {
        try {
          const r2 = await wx.cloud.getTempFileURL({ fileList: recIds.slice(0, 20) });
          (r2.fileList || []).forEach(x => { if (x.fileID && x.tempFileURL) recUrls[x.fileID] = x.tempFileURL; });
        } catch (e) { /* 取录音失败不影响其它内容 */ }
      }

      const d = buildD(res, photoUrls, recUrls);
      // ⭐ 2026-09-27：默认展开按内容算（defaultOpen），不再写死
      this.setData({ d, open: defaultOpen(d), markers: this._mkMarkers(d, false), polyline: [] });
      if (d.name) wx.setNavigationBarTitle({ title: d.name });
    } catch (e) {
      // 2026-09-25 修：错误**直接显示在页面上**（原来只用 toast，会被 hideLoading 盖掉 → 只看到"一直加载中"，没法排查）
      const msg = (e && (e.errMsg || e.message)) || String(e);
      this.setData({ loadErr: msg });
      console.error('[客户详情] 加载失败：', e);
    }
  },

  // 地图标记：① 客户 = 橙针（60% 透明）+ **常显店名气泡**；② 「我」= 微信风格蓝点（拿到定位才加）
  // 锚点规则：针图（针尖在底部）用默认 {x:0.5,y:1}；蓝点是圆形，必须显式 {x:0.5,y:0.5}，否则整体偏上半个图标高
  _mkMarkers(d, withMe) {
    const arr = [{
      id: 1, latitude: d.lat, longitude: d.lng,
      iconPath: '/images/pin.png', width: 26, height: 34,
      anchor: { x: 0.5, y: 1 }, zIndex: 9, alpha: 0.6
      // ⭐ 2026-09-28 老板定：**地图上不显示店家名称胶囊** → 原来那个 callout（常显店名气泡）已删除
    }];
    if (withMe && d.meLat && d.meLng) {
      arr.push({ id: 2, latitude: d.meLat, longitude: d.meLng, iconPath: '/images/locdot.png', width: 26, height: 26, anchor: { x: 0.5, y: 0.5 } });
    }
    return arr;
  },

  // ---------- 卡片折叠 ----------
  toggle(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    const open = Object.assign({}, this.data.open);
    open[k] = !open[k];
    this.setData({ open });
  },

  // ---------- 演示提示（真机才有真实动作的地方） ----------
  tip(e) {
    const t = (e.currentTarget.dataset.t) || '演示版：真机才有此功能';
    wx.showToast({ title: t, icon: 'none', duration: 1800 });
  },

  // ---------- 录入（菜品 / 设施）----------
  openAdd(e) {
    const kind = e.currentTarget.dataset.kind;
    const cfg = {
      dish: { title: '录入菜品', ph: '例如：招牌牛肉面' },
      fac: { title: '录入设施', ph: '例如：有停车场、可电话预定' }
    }[kind] || { title: '录入', ph: '' };
    this.setData({ addShow: true, addKind: kind, addTitle: cfg.title, addPh: cfg.ph, addVal: '' });
  },
  addInput(e) { this._addVal = e.detail.value; },
  addNo() { this.setData({ addShow: false }); },
  // ⭐ 2026-09-27：录入**真提报**（修正 008）—— 提交到 coordfix 云函数 → 后台审核 → 采纳后才写进客户档案；
  //   审核期间在卡片里显示「（待审核）」
  async addYes() {
    const v = String(this._addVal || '').trim();
    const kind = this.data.addKind;
    if (!v) { this.setData({ addShow: false }); return; }
    const ok = await this._submitField({ kind: kind, value: v });
    if (!ok) return;
    const d = this.data.d;
    const t = v + '（待审核）';
    if (kind === 'dish') d.dishes = d.dishes.concat([t]);
    else if (kind === 'fac') d.fac = d.fac.concat([t]);
    this.setData({ d, addShow: false });
  },
  // 提报公共逻辑（招牌菜/设施/团购外卖共用）：成功 → toast + 返回 true
  async _submitField(payload) {
    if (this._fieldBusy) return false;
    if (!this._cid) { wx.showToast({ title: '缺少客户参数', icon: 'none' }); return false; }
    this._fieldBusy = true;
    wx.showLoading({ title: '提交中…', mask: true });
    try {
      const res = await api.call('coordfix', Object.assign({ customerId: this._cid }, payload));
      wx.hideLoading();
      this._fieldBusy = false;
      if (!res || !res.ok) { wx.showModal({ title: '提交失败', content: (res && res.msg) || '请稍后再试', showCancel: false }); return false; }
      wx.showToast({ title: res.msg || '已提报', icon: 'none', duration: 2000 });
      return true;
    } catch (e) {
      wx.hideLoading();
      this._fieldBusy = false;
      wx.showModal({ title: '提交失败', content: (e && (e.errMsg || e.message)) || '网络异常', showCancel: false });
      return false;
    }
  },

  // ---------- 团购 / 外卖：点了切「已开 / 未开」----------
  openFlag(e) {
    const name = e.currentTarget.dataset.name;
    const cur = !!e.currentTarget.dataset.on;
    this.setData({ flagShow: true, flagName: name, flagTo: !cur });
  },
  flagNo() { this.setData({ flagShow: false }); },
  // ⭐ 2026-09-27：点改也走**真提报**（后台审核后生效）
  async flagYes() {
    const name = this.data.flagName, to = this.data.flagTo;
    const ok = await this._submitField({ kind: 'flag', flagName: name, flagTo: to });
    if (!ok) return;
    const d = this.data.d;
    d.flags = d.flags.map(f => (f[0] === name ? [f[0], to] : f));
    const fp = Object.assign({}, d.flagPending);
    fp[name] = true;
    d.flagPending = fp;
    this.setData({ d, flagShow: false });
  },

  // ---------- 门店照片：点空框 → 就地拍照 → **传云存储 + 写客户档案**（2026-09-27 真落库）----------
  takePhoto(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: async (r) => {
        const f = (r.tempFiles || [])[0];
        if (!f || !f.tempFilePath) return;
        const cid = this._cid;
        if (!cid) { wx.showToast({ title: '缺少客户参数', icon: 'none' }); return; }
        wx.showLoading({ title: '上传中…', mask: true });
        try {
          const up = await wx.cloud.uploadFile({
            cloudPath: 'custphotos/' + cid + '/' + Date.now() + '_' + i + '.jpg',
            filePath: f.tempFilePath
          });
          const res = await api.call('tasks', { action: 'saveCustPhoto', customerId: cid, fileID: up.fileID, index: i });
          wx.hideLoading();
          if (!res || !res.ok) { wx.showModal({ title: '保存失败', content: (res && res.msg) || '请稍后再试', showCancel: false }); return; }
          const d = this.data.d;
          const photos = d.photos.slice();
          photos[i] = f.tempFilePath;
          d.photos = photos;
          this.setData({ d });
          wx.showToast({ title: '已保存到客户档案', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showModal({ title: '上传失败', content: (err && (err.errMsg || err.message)) || '网络异常，请重试', showCancel: false });
        }
      },
      fail: () => { /* 用户取消，不打扰 */ }
    });
  },

  // ---------- 📍 坐标报错（2026-09-27：从"只弹提示"改为**真提交** coord_fix_requests）----------
  //   流程：点报错 → 弹层（原因可选 + 现场照片可选）→ 提交时**现场精确定位** → 传照片 → 调 coordfix 云函数
  //   ⚠️ 云函数侧：同客户已有 pending 报错会拒绝（去重）；老板模式=模拟成功不落库
  openFix() {
    this.setData({ fixShow: true, fixNote: '', fixShots: ['', '', ''] });
  },
  fixClose() { this.setData({ fixShow: false }); },
  fixNoteIn(e) { this.setData({ fixNote: e.detail.value }); },
  fixShot(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: (r) => {
        const f = (r.tempFiles || [])[0];
        if (!f || !f.tempFilePath) return;
        const s = this.data.fixShots.slice();
        s[i] = f.tempFilePath;
        this.setData({ fixShots: s });
      },
      fail: () => { /* 用户取消 */ }
    });
  },
  async submitFix() {
    if (this._fixBusy) return;
    this._fixBusy = true;
    const cid = this._cid;
    if (!cid) { wx.showToast({ title: '缺少客户参数', icon: 'none' }); this._fixBusy = false; return; }
    try {
      // ① 现场精确定位（失败即拦截 —— 报错的意义就是"人在这儿、坐标不对"）
      wx.showLoading({ title: '正在精确定位…', mask: true });
      const loc = await new Promise((resolve, reject) => {
        wx.getLocation({ type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 5000, success: resolve, fail: reject });
      });
      // ② 现场照片（可选，最多 3 张）先传云存储
      const shots = (this.data.fixShots || []).filter(Boolean).slice(0, 3);
      const photos = [];
      for (let k = 0; k < shots.length; k++) {
        wx.showLoading({ title: '上传照片 ' + (k + 1) + '/' + shots.length + '…', mask: true });
        const up = await wx.cloud.uploadFile({
          cloudPath: 'coordfix/' + cid + '/' + Date.now() + '_' + k + '.jpg',
          filePath: shots[k]
        });
        photos.push({ fileID: up.fileID, thumbID: '' });
      }
      // ③ 提交（云函数 coordfix：写 coord_fix_requests 待后台审核）
      wx.showLoading({ title: '提交中…', mask: true });
      const res = await api.call('coordfix', {
        customerId: cid,
        lat: loc.latitude,
        lng: loc.longitude,
        note: String(this.data.fixNote || '').trim().slice(0, 100),
        photos: photos
      });
      wx.hideLoading();
      this._fixBusy = false;
      if (!res || !res.ok) { wx.showModal({ title: '提交失败', content: (res && res.msg) || '请稍后再试', showCancel: false }); return; }
      this.setData({ fixShow: false });
      wx.showModal({ title: '已提交 ✓', content: res.msg || '管理员审核后会更新客户坐标', showCancel: false });
    } catch (err) {
      wx.hideLoading();
      this._fixBusy = false;
      wx.showModal({
        title: '定位失败',
        content: '请走到店门口、确认手机定位已打开，再重新提交。\n（' + ((err && (err.errMsg || err.message)) || '未知原因') + '）',
        showCancel: false
      });
    }
  },

  // ---------- 大图查看 ----------
  openPhoto(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    this.setData({ viewerShow: true, viewerUrl: url });
  },
  closePhoto() { this.setData({ viewerShow: false }); },

  // ---------- 购买记录：全屏抽屉 ----------
  openSheet() { this.setData({ sheetShow: true }); },
  closeSheet() { this.setData({ sheetShow: false }); },
  toggleOrder(e) {                                   // 抽屉里：点一单展开明细
    const i = Number(e.currentTarget.dataset.i);
    const d = this.data.d;
    d.orders = d.orders.map((o, k) => (k === i ? Object.assign({}, o, { open: !o.open }) : o));
    this.setData({ d });
  },
  toggleHist(e) {                                    // 历史卡：点一下展开/收起拜访记录
    const i = Number(e.currentTarget.dataset.i);
    const d = this.data.d;
    d.history = d.history.map((v, k) => (k === i ? Object.assign({}, v, { open: !v.open }) : v));
    this.setData({ d });
  },

  // ---------- 开始拜访（2026-09-25 改：**真客户、真任务**，不再是 demo 标记）----------
  // 入口页（pages/task / pages/map）已经把**完整客户对象 + 任务设置**存进 curCustomer，
  // 这里**原样接力、只补齐可能缺的字段** —— ⚠️ 千万别自己重组整个对象：
  // 那会把 locCheck / locKeyRefresh / visitDurationLimit / recordingDurationLimit 等**任务级设置丢掉**，
  // 拜访页拿不到就不会做定位校验、录音档位也会退回默认值。
  goVisit() {
    const d = this.data.d;
    const c = wx.getStorageSync('curCustomer') || {};
    wx.setStorageSync('curCustomer', Object.assign({}, c, {
      _id: c._id || this._cid || '',
      taskId: c.taskId || this._taskId || '',
      name: d.name || c.name || '',
      phone: api.isTrialUser() ? api.maskTrialPhone(d.tel || c.phone || '') : (d.tel || c.phone || ''),
      contactName: d.contact || c.contactName || '',
      address: d.addr || c.address || '',
      lng: d.lng || c.lng || 0, lat: d.lat || c.lat || 0
    }));
    wx.navigateTo({ url: '/pages/visit/visit' });
  },

  // ---------- 拜访录音：**真播放**（2026-09-27 从"进度条模拟"改为 wx.createInnerAudioContext）----------
  //   ⚠️ obeyMuteSwitch=false 是项目铁律（真机静音键下也要出声）；同一时刻只放一条（单实例）
  _stopAudio() {
    if (this._audio) {
      try { this._audio.stop(); } catch (e) { /* 静默 */ }
      try { this._audio.destroy(); } catch (e) { /* 静默 */ }
      this._audio = null;
    }
    this._audioIdx = -1;
  },
  _setRec(i, patch) {
    const h = this.data.d.history.slice();
    if (!h[i] || !h[i].rec) return;
    h[i] = Object.assign({}, h[i], { rec: Object.assign({}, h[i].rec, patch) });
    this.setData({ 'd.history': h });
  },
  playRec(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    const arr = this.data.d.history.slice();
    if (!arr[i] || !arr[i].rec || !arr[i].rec.url) return;
    const wasPlaying = arr[i].rec.playing && this._audioIdx === i;
    this._stopAudio();
    if (wasPlaying) {                       // 再点一下 = 停止
      this._setRec(i, { playing: false, pct: 0 });
      return;
    }
    const au = wx.createInnerAudioContext();
    au.obeyMuteSwitch = false;
    au.src = arr[i].rec.url;
    this._audio = au;
    this._audioIdx = i;
    this._setRec(i, { playing: true, pct: 0 });
    au.onTimeUpdate(() => {
      const k = this._audioIdx;
      if (k < 0) return;
      const dur = Number(au.duration) || 0;
      const pct = dur ? Math.min(Math.round(Number(au.currentTime) / dur * 100), 100) : 0;
      this._setRec(k, { pct: pct });
    });
    au.onEnded(() => { const k = this._audioIdx; this._stopAudio(); if (k >= 0) this._setRec(k, { playing: false, pct: 0 }); });
    au.onError(() => {
      const k = this._audioIdx;
      this._stopAudio();
      if (k >= 0) this._setRec(k, { playing: false, pct: 0 });
      wx.showToast({ title: '录音播放失败（可稍后重进页面再试）', icon: 'none' });
    });
    au.play();
  },
  onUnload() { this._stopAudio(); },

  // 阻止弹层内部点击冒泡到遮罩
  noop() {}
});
