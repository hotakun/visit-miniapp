// 客户详情 · 真数据页（2026-09-25 起；原为 2026-09-13 的静态演示页）
// ---------------------------------------------------------------------------
// 定位：数据来自云函数 `tasks.custDetail`（档案 + 订单 + 明细 + 备注 + 拜访历史）；
//      录入 / 拍照 / 坐标修正等交互会真写云端（下面 `D` 仅作字段结构兜底参考）。
// 配色：照 `_scratch/客户详情页-A-手机演示.html`（白卡 + 品牌橙 + 暖白底）。
// 入口：任务 / 地图 / 自由拜访地图点客户；老板首页「今日战况」下方按钮。
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
function daysAgo(dateStr) {                      // 'YYYY-MM-DD' / 时间戳 → 'X 天前' / '今天'
  if (!dateStr) return '';
  // ⭐ 2026-10-12：也认时间戳（原来只认 'YYYY-MM-DD'，是时间戳时算不出来 → "X 天前"整段消失）
  const s = String(dateStr).trim();
  let d;
  if (/^\d{10,}$/.test(s)) { const n = Number(s); d = new Date(n > 1e12 ? n : n * 1000); }
  else {
    const n0 = Number(s);
    // ⚠️ 2026-10-12：商城表那几个日期是 **Excel 序列号**（46306.70…）→ 也要认，否则"（X 天前）"不显示
    if (!isNaN(n0) && n0 > 20000 && n0 < 80000) d = new Date(Math.round((n0 - 25569) * 86400000));
    else d = new Date(s.replace(/-/g, '/') + ' 00:00:00');
  }
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
function mdCn(dateStr) {                 // 'YYYY-MM-DD' → '8月24日'；⭐ 2026-10-12 起**也认时间戳**
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  // ⭐ 2026-10-12 老板报障（手机端客户详情页「时间是一串数字，没有被转换成正确的时间」）——
  //   原因：这里原来只认 'YYYY-MM-DD'，而 `visits.visitedAt` 常常是**毫秒时间戳**（如 1760…）→
  //   解析不出 '-' → 走 else → **把那串数字原样吐出来**。
  //   现在三种都认：10/13 位时间戳、'YYYY-MM-DD'（含 ISO 串）、其它原样返回。
  if (/^\d{10,}$/.test(s)) {
    const n = Number(s);
    const d = new Date(n > 1e12 ? n : n * 1000);   // 13 位=毫秒；10 位=秒
    if (!isNaN(d.getTime())) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  {
    const n0 = Number(s);
    // ⚠️⚠️ 2026-10-12 老板截图实测（铁证）：**商城表那些日期列存的是 Excel 日期序列号**，
    //   如 46306.70516079861（= 2026-10-12），**不是毫秒时间戳** —— 上面那个分支匹配不上，
    //   于是原样吐出来就是"一串数字"。Excel 序列号 ≈ 20000~80000（1954~2064 年）→ 按区间识别，不会误伤其它数字。
    if (!isNaN(n0) && n0 > 20000 && n0 < 80000) {
      const d0 = new Date(Math.round((n0 - 25569) * 86400000));   // 25569 = 1970-01-01 的 Excel 序列号
      if (!isNaN(d0.getTime())) return (d0.getUTCMonth() + 1) + '月' + d0.getUTCDate() + '日';
    }
  }
  const p = s.slice(0, 10).split('-');
  return p.length === 3 ? (Number(p[1]) + '月' + Number(p[2]) + '日') : s;
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
  // ⭐ 2026-10-07 补：**现场建档时直接录的设施**（「加新店」第 3 步写在顶层 `fac` 数组，如 ['有外卖','沿街']）——
  //   原来只并 `platManual.facs`（后台采纳的提报）→ 漏了现场建档那一刻录下的那批
  //   （老板报"手机上看不到设施/品类"就是这个 + 下面几处同源）。
  (c.fac || []).forEach(x => { if (x && fac.indexOf(x) < 0) fac.push(x); });
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
  // ⭐ 2026-10-10：「✎ 编辑」只给自己的记录显示 → 先取"我"的 id
  const meId = ((getApp() && getApp().globalData && getApp().globalData.user) || {})._id || '';
  const history = (res.visits || []).map((v, i) => {
    const at = String(v.visitedAt || '');
    const md = at ? (mdCn(at) + (v.duration ? '' : '')) : '';
    return {
      // ⭐ 2026-10-10 老板定：这里显示**拜访结果**（加入商城 / 需要样品 / 已下单 / 不愿改 / 有抵触 /
      //   闭店 / 搬迁 / 其他），**不是**拜访状态。三种兜底：
      //   · 拜访中（还没提交）→ 没结果，显"拜访中"  · 老记录没结果 → 退回状态  · 都没有 → 已回访
      tag: (v.status === 'ongoing') ? '拜访中' : (v.result || ST[v.status] || '已回访'),
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
      shots: (v.thumbs || []).slice(0, 9),   // ⭐ 2026-10-12：最多 9 张（原来 3 张 → 拍了 5 张只显示 3 张）
      // ⭐ 2026-10-10 老板定：拜访记录可编辑 —— 记 visitId + 是不是"我"记的（只有自己的才显示「✎ 编辑」）
      vid: v._id || '',
      // ⚠️ 2026-10-11 老板报障（他进客户详情看不到编辑/删除按钮）：原来只给"自己记的"显示 ——
      //   但**老板要管数据**，所以**老板模式 / 管理员账号**也一律给（云端 editSubmitted / deleteVisit 同步放行 isBoss）。
      //   业务员仍然只能动自己记的那条。
      // ⭐ 2026-10-11：**优先用云端算好的 mine**（云端知道真实身份，最可靠 —— custDetail 现在会下发它）；
      //   本地那两段留作兜底（老版本云端、或字段缺失时）。
      mine: !!v.mine || !!(meId && v.salesmanId === meId) ||
        !!(getApp() && getApp().globalData && (getApp().globalData.bossMode || ((getApp().globalData.user || {}).role === 'admin')))
    };
  });

  return {
    // 地址：老板 2026-09-25 定 —— **不显示省份和地级市**（浙江省金华市永康市… → 永康市…）
    // ⭐⭐ 2026-10-17 老板定：**店名要完整带编号**（如「c933 福建沙县小吃」）。
    //   优先级：nameRaw（原值就是「编号 + 店名」）→ 没 nameRaw 就用 mallCode 拼 → 最后才用 name。
    //   ⚠️ 配套：413 家客户的 name 已按 nameRaw 补回编号（备案 _scratch/店名加回编号-备案-*.json）；
    //      这里是"万一还有漏的"兜底，保证显示永远带编号。
    name: esc((function () {
      const raw = String(c.nameRaw || '').trim();
      if (raw) return raw;
      const nm = String(c.name || '');
      const code = String(c.mallCode || '').trim();
      if (code && nm.indexOf(code) !== 0) return code + ' ' + nm;
      return nm;
    })()), addr: stripProvCity(c.address, c.region),
    // ⭐ 2026-10-11 加、2026-10-17 起**不再显示**（编号已并进店名，wxml 里那行小标签已删）。
    //   字段保留：万一以后别处还要单独用编号。
    code: esc(c.mallCode || ''),
    // ⭐ 2026-10-07 修：营业时间**平台优先、现场兜底** —— 平台写在 plat.hours，现场（「加新店」）写在顶层 hours。
    hours: flatHours(p.hours || c.hours),
    // ⭐⭐ 2026-10-12 老板定：**拜访时选了「闭店」→ 顶部营业状态显示"闭店"**（覆盖平台给的"正常"）
    //   ⚠️ 拜访历史在页面上是**时间正序**（老的在上）→ 取**最后一条**当"最近一次"。
    status: (function () {
      const vs = c.visits || [];
      const last = vs.length ? vs[vs.length - 1] : null;
      if (last && String(last.result || '').indexOf('闭店') >= 0) return '闭店';
      return esc(p.bizStatus) || '';
    })(),
    // 游客（实习）打码：后四位 ****（2026-09-08 口径「游客不能看完整电话」；maskTrialPhone 对已打码串幂等）
    tel: api.isTrialUser() ? api.maskTrialPhone(esc(c.phone) || esc(p.phone1) || '') : (esc(c.phone) || esc(p.phone1) || ''),
    contact: esc(c.contactName) || '', hasMall: hasMall,
    // ⭐ 2026-09-28 晚 老板定：「⏳ 待商城建档」淡色胶囊（业务员现场用「加新店」录的店，商城侧还没档案）
    mallPending: !!c.mallPending,
    listedYears: listedYears(p.listedTime),
    // ⭐ 2026-10-07 修：品类**平台优先、现场兜底** —— 平台（大众点评）写在 plat.cat1/2/3，
    //   现场（「加新店」三级下拉）写在**顶层** cat1/2/3。原来只读平台 → 现场建的店**看不到品类**
    //   （老板报的正是这条："后台能看到大中小类，手机上却看不到"）。与招牌菜同一路数：平台 + 现场合并显示。
    cat: uniqueJoin(p.cat1 || c.cat1, p.cat2 || c.cat2, p.cat3 || c.cat3),
    rank: esc(p.rank),
    mallRows: (function () {
      const rows = [
        ['注册商城时间', mdCn(c.mallJoinedAt) || '—'],   // ⭐ 2026-10-12：原来直接显示原值 → 时间戳就成"一串数字"
        ['签约业务员', esc(c.salesman) || '—'],
        ['最近下单', esc(c.lastOrderAt) ? (mdCn(c.lastOrderAt) + (daysAgo(c.lastOrderAt) ? '（' + daysAgo(c.lastOrderAt) + '）' : '')) : '—'],
        ['最近浏览商城', esc(c.lastBrowseAt) ? (mdCn(c.lastBrowseAt) + (daysAgo(c.lastBrowseAt) ? '（' + daysAgo(c.lastBrowseAt) + '）' : '')) : '—']
      ];
      // ⭐ 2026-10-18：副店 / 连锁（老板定：同编号一条档案 + 副店信息；连锁互标「同一老板」）
      //   ⚠️ 只有真的有才追加 —— 绝大多数客户没有这两项，不多占一行。
      const subs = Array.isArray(c.subAccounts) ? c.subAccounts : [];
      if (subs.length) {
        rows.push(['副店', subs.map(x => esc(x.name || '') + (x.phone ? ' · ' + esc(x.phone) : '')).join('、')]);
      }
      const chains = Array.isArray(c.chainNames) ? c.chainNames : [];
      if (chains.length) rows.push(['连锁', '同一老板：' + chains.map(x => esc(x)).join('、')]);
      return rows;
    })(),
    // ⭐ 2026-09-27：商城信息卡头小字（原 wxml 里写死「最近购买 8月24日」）——
    //   最近购买 → 没有则 最近浏览 → 再没有 注册
    // ⭐ 2026-09-28 晚老板定：**未加入商城就留空**（原来写「未加入商城」）——
    //   "没有"的事不摆出来；是否已入商城由店名卡的辉光表达，不靠文字。
    mallSub: hasMall
      ? (esc(c.lastOrderAt) ? ('最近购买 ' + mdCn(c.lastOrderAt))
        : (esc(c.lastBrowseAt) ? ('最近浏览 ' + mdCn(c.lastBrowseAt))
          : (esc(c.mallJoinedAt) ? ('注册 ' + mdCn(c.mallJoinedAt)) : '')))
      : '',
    photos: photos,
    // ⭐ 2026-10-03：「加新店」现场录的音（customers.audios）—— 与拜访录音无关，单独一块。
    //   渲染在「🏪 商城信息」卡的照片下面；没录音就是 null，wxml 用 wx:if 挡掉。
    siteRec: (function () {
      const au = ((c.audios) || []).filter(a => a && a.fileID && recUrls && recUrls[a.fileID]);
      if (!au.length) return null;
      return { url: recUrls[au[0].fileID], dur: fmtDur(au[0].duration), playing: false, pct: 0 };
    })(),
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
    // ⭐ 2026-09-27 卡头小字（原来把「人均 ¥46/人」写死在 wxml 里 —— 那是演示稿的假数据）
    // ⭐ 2026-09-28 晚老板定：**没评分就留空** —— 原来这里写「平台未收录」，
    //   会让人误以为平台没有这家店的信息（其实都有，只是这家还没评分）。有评分才显示「x 分」。
    rateSub: (esc(p.rating) ? (esc(p.rating) + ' 分') : '')
      + (esc(p.rating) && esc(p.avgPriceText) ? (' · ' + esc(p.avgPriceText)) : ''),
    newShop: !!esc(p.newShop),      // ⭐「新店」蓝胶囊（平台"新店标签"有值就显示）
    rateTxt: esc(p.reviewCount) ? (esc(p.reviewCount) + ' 条评价' + (p.reviewCount2025 ? '（2025年 ' + esc(p.reviewCount2025) + ' 条）' : '')) : '',
    bars: [['口味', esc(p.taste) || '—', 0], ['环境', esc(p.env) || '—', 0], ['服务', esc(p.service) || '—', 0]]
      .map(b => [b[0], b[1], (parseFloat(b[1]) || 0) / 5 * 100]),
    extra: [
      ['人均消费', esc(p.avgPriceText) || '—'],
      ['评论总数', esc(p.reviewCount) ? (esc(p.reviewCount) + ' 条') : '—']
    ].concat(Number(p.chainCount) >= 1 ? [['连锁情况', esc(p.chainCount) + ' 家']] : []),   // 单店不显示（老板定）
    // ⭐ 2026-10-07 修：团购/外卖**平台优先、现场兜底** —— 现场（「加新店」）写在顶层 `flags`
    //   （形如 {外卖:true, 团购:false}，见 newshop.js 的 _flags()）。原来只读平台 → 现场建的店两个都显示"未开"。
    dishes: dishes,
    flags: [['团购', !!(p.groupon || (c.flags && c.flags['团购']))],
            ['外卖', !!(p.takeout || (c.flags && c.flags['外卖']))]],
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
// ⭐ 2026-10-07 老板定：**没内容的卡不要默认展开** ——
//   「📝 管理员备注」「🕑 拜访历史」**只有真有内容时才展开**；空的那张保持收起（只留标题栏）。
//   （沿革：2026-09-27 是"按内容算"，后来被改回"写死开这两张"—— 于是空卡也展开、白占一屏；
//     现在按老板 2026-10-07 的要求恢复成"有内容才开"，且**不会**顺手自动展开商城信息那类卡。）
function defaultOpen(d) {
  const dd = d || {};
  return {
    mall: false, purchase: false, rate: false, serv: false,
    remark: !!(dd.remarks && dd.remarks.length),
    hist: !!(dd.history && dd.history.length)
  };
}


Page({
  data: {
    // 2026-09-25 改造：**初始为空** —— 真数据在 onLoad 里从 custDetail 取回后 setData 填入。
    // （原来写死 `d: D` 会让页面打开瞬间闪一下示例数据；wxml 也加了 wx:if="{{d}}" 兜住）
    d: null,
    isGuest: false,   // ⭐ 2026-10-20：店家分享链接（未注册）只读模式
    loadErr: '',   // 加载失败原因（2026-09-25 加：直接显示在页面上，别只弹一个会被盖掉的 toast）
    // 地图标记 / 路线：初始为空，onLoad 拿到真坐标后用 _mkMarkers() 生成
    //（客户 = 橙针 60% 透明 + 常显店名气泡；「我」= 蓝点，只有定位成功才加）
    markers: [],
    polyline: [],
    open: { mall: false, purchase: false, rate: false, serv: false, remark: false, hist: false },   // ⭐ 实际展开由 defaultOpen(d) 算（见 onLoad）
    // ⭐ 2026-10-07 老板定：「配套·服务·设施」的标签群**默认收起、只露一行**（设施多的店会撑得很长），点标题行展开
    foldFac: true,
    // ⭐ 2026-10-07 老板定：步行规划大弹窗（只有 1 公里内才弹；见 onWalk）
    walkShow: false, walkLine: [], walkCenterLat: '', walkCenterLng: '', walkInfo: '', walkTip: '',
    // 弹层
    addShow: false, addKind: '', addTitle: '', addPh: '', addVal: '',
    flagShow: false, flagName: '', flagTo: true,
    // ⭐ 2026-09-28 晚：**地图修正模式**（点「修正」进入）——
    //   fixing=true → 地图可拖（enable-scroll）+ 正中显示图钉 + 上方经纬度改成显示"地图中心点"和与原坐标的距离
    //   ⚠️ centerLat/centerLng = **地图当前中心**：修正模式下 map 的 latitude/longitude 绑它俩。
    //      **绝不能绑 d.lat** —— 那样用户一拖地图，页面任何 setData 都会把视野拉回客户点（地图根本拖不动）。
    fixing: false, fixLat: '', fixLng: '', fixDist: '', centerLat: '', centerLng: '',
    // 📍 报错：⭐ 2026-10-07 起**本页不再有弹层** —— 直接跳独立整屏取点页 pages/coordfix/
    //   （弹层版（含大半屏那版）被老板真机否掉："卡片太小、操作实在不方便"）
    //   → 所以 fixShow / fixNote / fixPick 三个字段都不需要了
    sheetShow: false,
    viewerShow: false, viewerUrl: '', viewerList: [], viewerCur: 0,
    notesN: 0          // ⭐ 2026-09-28：本机「我的记事」条数（只读 storage，不联网）
  },

  // ---------- 加载真数据（2026-09-25 新增）----------
  // 入口参数：`?id=<customerId>`（或 customerId）；数据来自 tasks 云函数的 custDetail。
  async onLoad(query) {
    // 客户 id 的两个来源（按优先级）：
    //   ① 入口参数 ?id=xxx（新写法，将来用）
    //   ② 上一页塞进 storage 的 `curCustomer._id` —— **现有两个入口都走这条**：
    //      pages/task 和 pages/map 点客户时都会先 setStorageSync('curCustomer', 客户对象) 再跳过来。
    //      （那两处 navigateTo 不带 url 参数；这里兜底读 storage 更稳，也兼容将来新入口。）
    // ⚠️⚠️⚠️ 2026-10-12 老板严令「绝对绝对要避免再出现（串档）」—— **身份只认 URL，绝不从 storage 兜底**。
    //   以前是 `query.id || cc._id`：storage 里恰好留着"上一家"时，整页就认成上一家
    //   → 点「开始拜访」记录写到别人头上（当天连串几家的事故就是这么来的）。
    //   现在：**URL 没带 id 就明确报错**（入口必须传），**宁可报错也不猜**。
    const id = (query && (query.id || query.customerId)) || '';
    this._cid = id;
    // 2026-10-20 老板定：店家点分享链接（未注册）→ 免注册只读详情；已注册用户仍走完整功能。
    const _app0 = getApp();
    const _logged0 = !!(_app0 && _app0.globalData && _app0.globalData.user);
    const _share0 = String((query && query.share) || '');
    this._guest = !!_share0 && !_logged0;
    this._shareToken = _share0 || '';
    this.setData({ isGuest: this._guest });
    // ⭐⭐ 2026-10-12 老板定（兜底）：**进"别的"客户详情页 → 把上一家的「拜访中」强行结束**
    //   判据：手机里存的"当前客户"（storage.curCustomer._id）**不是这家** = 上一家没正常收尾（漏网之鱼）。
    //   ⚠️ 同一家（从拜访页返回）**不调** —— 否则会把正在进行的拜访自己结束掉。
    if (!this._guest) {
      try {
        const ccPrev = wx.getStorageSync('curCustomer') || {};
        if (ccPrev._id && ccPrev._id !== id) api.call('visits', { action: 'endMyOngoing' }).catch(() => { /* 静默 */ });
      } catch (e) { /* 静默 */ }
    }
    this._taskId = (query && query.taskId) || '';   // 任务 id 同样只从 URL 来（storage 里的可能是上一家的）
    // ⭐ 2026-10-07 老板定：「我新加的店」的按钮改成「客户详情」→ 从这里进来时带 freeVisit=1。
    //   ⚠️ 必须在这里**清掉 taskId**：goVisit() 是 Object.assign **接力 storage 里的 curCustomer**，
    //      而 storage 里可能还留着上次任务拜访的 taskId → 点「开始拜访」会变成"任务拜访"
    //      （云函数会去查任务、校验客户在不在任务里 → 报错 / 串数据）。
    if (!this._guest && query && query.freeVisit === '1') {
      const ccFv = wx.getStorageSync('curCustomer') || {};
      wx.setStorageSync('curCustomer', Object.assign({}, ccFv, { _id: id, taskId: '', freeVisit: true }));
      this._taskId = '';
    }
    if (!id) { this.setData({ loadErr: '缺少客户参数（上一页没传客户 id）' }); return; }
    this.setData({ loadErr: '' });
    // ⭐⭐ 2026-10-15 老板定「客户的订单/信息每天拉一次就够，看就看缓存」：
    //   **今天已经拉过这家 → 直接用本地缓存渲染**（秒开、零请求）；只有"刚改过"（`custNeedRefresh`）才强制重拉。
    //   ⚠️ 云存储临时 URL 有效期约 2 小时 → 超过 90 分钟**只重换 URL**，不重拉数据。
    const dc = require('../../utils/detailCache');
    const _force = !!this._forceReload;
    this._forceReload = false;
    if (!_force && !this._guest) {
      const hit = dc.get('custDetail', id);
      if (hit && hit.res) {
        try {
          this._renderCust(hit.res, hit.photoUrls || [], hit.recUrls || {});
          if (hit.res.shareToken) this._shareToken = hit.res.shareToken;
          else if (!this._shareToken) {
            api.call('tasks', { action: 'shareToken', customerId: id }).then(r => { if (r && r.ok) this._shareToken = r.shareToken; }).catch(() => { /* 静默 */ });
          }
          this._shareImgFrom(hit.res);                                   // 分享封面（本地文件，每次都要重新下）
          if (!hit.urlAt || Date.now() - hit.urlAt > 90 * 60 * 1000) this._refreshMediaUrls(hit.res, id);
          // ⭐⭐ 2026-10-14 老板定（依《手机端-详情页缓存与减负方案》B 条「**先渲染缓存 → 后台静默更新**」）：
          //   以前这里是直接 `return`（拿缓存就不再问云端）→ **一旦某处漏了失效标记，页面会一直显示旧数据**
          //   （2026-10-14 两次事故正是这个套路：提交了拜访 / 改了信息，回来看还是旧的）。
          //   现在：**照样先渲染缓存（秒开），但顺手在后台静默再拉一次** —— 拉回来有变化就覆盖。
          //   于是"漏了标记"最多只错几秒，**不再依赖"每处都记得置标记"**（这正是根治那两次事故的思路）。
          //   ⚠️ 静默更新：不显示 loading、失败完全静默、内容没变一个字不 setData（不打断、不闪、不白费）。
          this._silentRefresh(id, hit);
          return;
        } catch (e) { /* 缓存坏了 → 落到下面走云端 */ }
      }
    }
    try {
      const _payload = this._guest
        ? { action: 'publicCustDetail', customerId: id, share: this._shareToken }
        : { action: 'custDetail', customerId: id };
      const res = await api.call('tasks', _payload);
      if (!this._guest && res && res.shareToken) this._shareToken = res.shareToken;
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
      // ⭐ 2026-10-07 老板定：**分享卡片封面用这家店的门头照**。
      //   ⚠️ 但**不能用上面的临时 URL** —— 它的域名是 tcb.qcloud.la（云开发**开发环境**域名），
      //      微信**不允许**把它配进 downloadFile 白名单（后台会提示"不可在正式环境下使用"，提交审核会被拒）。
      //   解法：**提前把门头照下载成【本地文件】**，分享时直接给本地路径 ——
      //      `wx.cloud.downloadFile` 属于**云能力，不受域名白名单限制**（这也是分享卡片唯一稳的路子）。
      //   ⚠️ onShareAppMessage 必须**同步返回**，所以只能在这里先下好，不能等分享时才下。
      if (ids.length) {
        try {
          const dl = await wx.cloud.downloadFile({ fileID: ids[0] });
          if (dl && dl.tempFilePath) this._shareImg = dl.tempFilePath;
        } catch (e) { /* 下载失败 → 分享时自动回退统一封面 */ }
      }

      // ⭐ 2026-09-27：拜访录音同理（audio fileID → 临时 URL；一次最多 20 个，够覆盖近几条历史）
      let recUrls = {};
      const recIds = [];
      (res.visits || []).forEach(v => (v.audios || []).forEach(a => { if (a && a.fileID) recIds.push(a.fileID); }));
      // ⭐ 2026-10-03：「加新店」录的音存在**客户档案**上（customers.audios），跟拜访录音是两条互不相干的线 ——
      //   一并换成临时 URL（共用同一个 recUrls map），详情页「🏪 商城信息」卡里就能听。
      ((res.customer && res.customer.audios) || []).forEach(a => { if (a && a.fileID) recIds.push(a.fileID); });
      if (recIds.length) {
        try {
          const r2 = await wx.cloud.getTempFileURL({ fileList: recIds.slice(0, 20) });
          (r2.fileList || []).forEach(x => { if (x.fileID && x.tempFileURL) recUrls[x.fileID] = x.tempFileURL; });
        } catch (e) { /* 取录音失败不影响其它内容 */ }
      }

      // ⭐ 2026-10-15：拉回来的整块结果**存本地**（当天有效）—— 今天再进这家就不必再拉
      if (!this._guest) {
        try { dc.set('custDetail', id, { res, photoUrls, recUrls, urlAt: Date.now() }); } catch (e) { /* 静默：缓存失败不影响显示 */ }
      }
      this._renderCust(res, photoUrls, recUrls);
    } catch (e) {
      // 2026-09-25 修：错误**直接显示在页面上**（原来只用 toast，会被 hideLoading 盖掉 → 只看到"一直加载中"，没法排查）
      const msg = (e && (e.errMsg || e.message)) || String(e);
      this.setData({ loadErr: msg });
      console.error('[客户详情] 加载失败：', e);
    }
  },
  // ⭐ 2026-10-15：把「数据 + 已换好的 URL → 界面」抽出来 —— **云端数据与本地缓存共用同一套渲染**
  //   （原来这段在 onLoad 里，缓存命中时没法复用；两处各写一遍迟早不一致）
  _renderCust(res, photoUrls, recUrls, opts) {
    this._cust = res.customer || {};
    const d = buildD(res, photoUrls, recUrls);
    // ⭐ 2026-09-27：默认展开按内容算（defaultOpen），不再写死
    // ⚠️ 2026-10-14：**后台静默更新**（`opts.keepOpen`）时**不要重置折叠状态** ——
    //   用户可能正把某张卡折起来看，数据一变就整块重算 `open` 会把它又弹开（页面"自己抖一下"）。
    const open = (opts && opts.keepOpen && this.data.open) ? this.data.open : defaultOpen(d);
    // ⚠️ centerLat/centerLng 一起初始化：地图的 latitude/longitude 绑的是它俩（见 wxml），
    //    平时 = 客户坐标；缩放结束后会被"拉回"这里实现"以针点为中心缩放"。
    this.setData({ d, open, markers: this._mkMarkers(d, false), polyline: [], centerLat: d.lat, centerLng: d.lng });
    if (d.name) wx.setNavigationBarTitle({ title: d.name });
  },
  // ⭐⭐ 2026-10-14 老板定：**后台静默更新**（缓存先渲染 → 再拉一次云端；有变化才覆盖）。
  //   只用在**客户详情页**这一页 —— 它数据面最广、最容易被"别处写"改到
  //   （拜访提交/取消/编辑、更正信息、拍照/删照、现场提报、坐标报错），
  //   而任何一处漏了失效标记，旧做法"拿缓存就 return"就会一直显示旧数据。静默拉一次 = 一层自愈保险。
  //   ⚠️ 三条纪律：① 不显示 loading（不打断）② 失败完全静默 ③ **内容没变就什么都不做**（省重绘、避免页面抖）。
  //   ⚠️ 临时 URL **沿用缓存里那份**（没过期就不重换，省一次云调用）；确有变化时由 _refreshMediaUrls 兜。
  async _silentRefresh(id, hit) {
    const dc = require('../../utils/detailCache');
    const _w = dc.who();          // ⭐ C01：**请求开始那一刻**的身份快照（回包时若身份已变，就不写进新名义下）
    // ⚠️ **节流 60 秒**：刚拉过这家就不再静默拉 —— 连续进出详情页（业务员常干）不重复问云端，
    //   否则"缓存"就只剩"首屏秒开"、调用一点没省（省调用本来就是这次改造的目标之一）。
    //   ⚠️ 真"刚改过"的情况有 `custNeedRefresh` → `_forceReload` **强制重拉**兜底（那条路不走这里），
    //   所以这里节流是安全的：最多 60 秒后自然自愈。
    const _at = (dc.meta('custDetail', id) || {}).at || 0;
    if (Date.now() - _at < 60 * 1000) return;
    let res = null;
    try { res = await api.call('tasks', { action: 'custDetail', customerId: id }); }
    catch (e) { return; }                                  // 离线/超时：不影响已经渲染出来的缓存
    if (!res || !res.ok || !res.customer) return;
    // 内容指纹对比（**必须去掉每次都变的 `at`**，否则每次都判"有变化"）
    const strip = o => { if (!o || typeof o !== 'object') return o; const c = Object.assign({}, o); delete c.at; return c; };
    let same = false;
    try { same = JSON.stringify(strip(hit && hit.res)) === JSON.stringify(strip(res)); } catch (e) { same = false; }
    if (same) return;                                      // 没变 → 一个字都不动
    // ⭐⭐ 2026-10-15 修（依《全项目审查》C03）：**写之前重读一次缓存**。
    //   本函数与 `_refreshMediaUrls` 是**并行**的（`onLoad` 里两个都不 await）——
    //   如果媒体那边已经写入了**更新过的临时 URL**，这里用 `hit` 里那份旧的盖回去就白干了。
    //   所以 URL 相关三项一律**以缓存里的为准**，实在没有才退回 `hit`。
    const cur = dc.get('custDetail', id);
    const photoUrls = (cur && cur.photoUrls) || (hit && hit.photoUrls) || [];
    const recUrls = (cur && cur.recUrls) || (hit && hit.recUrls) || {};
    const urlAt = (cur && cur.urlAt) || (hit && hit.urlAt) || 0;
    try { dc.set('custDetail', id, { res, photoUrls, recUrls, urlAt }, _w); } catch (e) { /* 静默 */ }
    try { this._renderCust(res, photoUrls, recUrls, { keepOpen: true }); } catch (e) { /* 静默：渲染失败保留原样 */ }
  },
  // ⭐ 2026-10-15：分享封面 —— 云存储 fileID 换成**本地文件**（`wx.cloud.downloadFile` 不受域名白名单限制）。
  //   ⚠️ 本地临时文件重启即失效，所以每次进页面都要重新下（很便宜，只有 1 张）。
  _shareImgFrom(res) {
    try {
      const raw = ((res && res.customer && res.customer.photos) || []);
      const ids = raw.map(p => (p && (p.fileID || p.thumbID)) || (typeof p === 'string' ? p : '')).filter(Boolean);
      if (!ids.length) return;
      wx.cloud.downloadFile({ fileID: ids[0] })
        .then(dl => { if (dl && dl.tempFilePath) this._shareImg = dl.tempFilePath; })
        .catch(() => { /* 下载失败 → 分享时回退统一封面 */ });
    } catch (e) { /* 静默 */ }
  },
  // ⭐ 2026-10-15：缓存命中但**临时 URL 快过期**时，只重换 URL（数据一个字不重拉）
  async _refreshMediaUrls(res, id) {
    try {
      const dc = require('../../utils/detailCache');
      const _w = dc.who();          // ⭐ C01：身份快照
      const raw = ((res.customer && res.customer.photos) || []);
      const fids = raw.map(p => (p && (p.fileID || p.thumbID)) || (typeof p === 'string' ? p : '')).filter(Boolean);
      let photoUrls = [];
      if (fids.length) {
        const r = await wx.cloud.getTempFileURL({ fileList: fids.slice(0, 3) });
        photoUrls = (r.fileList || []).map(x => x.tempFileURL).filter(Boolean);
      }
      const recIds = [];
      (res.visits || []).forEach(v => (v.audios || []).forEach(a => { if (a && a.fileID) recIds.push(a.fileID); }));
      ((res.customer && res.customer.audios) || []).forEach(a => { if (a && a.fileID) recIds.push(a.fileID); });
      let recUrls = {};
      if (recIds.length) {
        const r2 = await wx.cloud.getTempFileURL({ fileList: recIds.slice(0, 20) });
        (r2.fileList || []).forEach(x => { if (x.fileID && x.tempFileURL) recUrls[x.fileID] = x.tempFileURL; });
      }
      // ⭐⭐ 2026-10-15 修（依《全项目审查》C03）：**不要把"进页面时那份 res"整块写回去** ——
      //   本函数与 `_silentRefresh` **并行**（`onLoad` 里两个都不 await）。如果静默更新先拿到了**新详情**并写入，
      //   随后这里用**旧的 `res`** 覆盖 → **刚出现的记录又消失**；而且 `urlAt: Date.now()` 还会把它贴上
      //   "刚更新过"的时间戳，让"URL 快过期"的判断一并失灵。
      //   所以：**以缓存里当前那份 res 为准**（它可能是静默更新刚写的新详情），只覆盖 URL 三项。
      //   ⚠️ 若此刻缓存已不可用（读不到 / 身份变了被 `get` 拦掉）→ **不写、也不渲染**（别把旧数据糊上去）。
      const cur = dc.get('custDetail', id);
      if (!cur || !cur.res) return;
      dc.set('custDetail', id, { res: cur.res, photoUrls, recUrls, urlAt: Date.now() }, _w);
      this._renderCust(cur.res, photoUrls, recUrls);
    } catch (e) { /* 静默：换不到 URL 就保持现状 */ }
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

  // ⭐ 2026-10-07 老板定：「配套·服务·设施」标签群单独折叠（收起只露一行，点标题行切换）
  toggleFac() {
    this.setData({ foldFac: !this.data.foldFac });
  },

  // ⭐⭐ 2026-10-07 老板定：小地图下方的「🚶 步行」—— **1 公里内**弹大窗画真实步行路线（绿色加粗，同自由拜访）；
  //   **超过 1 公里不弹窗**、只提示"走路太远"（避免业务员白走一趟）。
  //   ⚠️ 路线由云函数 tasks.walkRoute 调腾讯 walking 接口算 —— 云函数不受小程序域名白名单限制，不用去配 request 域名；
  //      接口挂掉时云端回**直线兜底**，这里照画，并在弹窗底部注明。
  onWalk() {
    const d = this.data.d;
    if (!d || !d.lat || !d.lng) { wx.showToast({ title: '这家没有坐标，画不了路线', icon: 'none' }); return; }
    wx.getLocation({
      type: 'gcj02',
      success: (r) => {
        const toLat = Number(d.lat), toLng = Number(d.lng);
        // 直线距离（Haversine，这里内联一份，不依赖本页其它函数）
        const R = 6371000, rad = Math.PI / 180;
        const dLat = (toLat - r.latitude) * rad, dLng = (toLng - r.longitude) * rad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(r.latitude * rad) * Math.cos(toLat * rad) * Math.sin(dLng / 2) ** 2;
        const m = 2 * R * Math.asin(Math.sqrt(a));
        if (!isFinite(m)) { wx.showToast({ title: '取不到位置，请稍后再试', icon: 'none' }); return; }
        if (m > 1000) {
          wx.showToast({ title: '距离约 ' + (m / 1000).toFixed(1) + ' 公里，走路太远了', icon: 'none', duration: 2600 });
          return;
        }
        this._drawWalk(r.latitude, r.longitude, toLat, toLng);
      },
      fail: () => { wx.showToast({ title: '没拿到你的位置，请检查定位权限', icon: 'none' }); }
    });
  },
  // 调云端算步行路线 → 画到弹窗那张地图上
  _drawWalk(fromLat, fromLng, toLat, toLng) {
    wx.showLoading({ title: '规划路线…', mask: false });
    api.call('tasks', { action: 'walkRoute', fromLat, fromLng, toLat, toLng }).then(r => {
      wx.hideLoading();
      if (!r || !r.ok || !r.pts || r.pts.length < 2) { wx.showToast({ title: '路线获取失败，请稍后再试', icon: 'none' }); return; }
      const pts = r.pts.map(q => ({ latitude: q[0], longitude: q[1] }));
      const km = r.distanceMeters >= 1000 ? (r.distanceMeters / 1000).toFixed(1) + ' 公里' : r.distanceMeters + ' 米';
      this.setData({
        walkShow: true,
        walkCenterLat: (fromLat + toLat) / 2, walkCenterLng: (fromLng + toLng) / 2,
        walkInfo: '步行 ' + km + (r.durationMin ? (' · 约 ' + r.durationMin + ' 分钟') : ''),
        walkTip: r.fallback ? '（路线接口暂时不可用，这里画的是近似直线）' : '',
        walkLine: [{ points: pts, color: '#16A34A', width: 8, arrowLine: true, borderColor: '#FFFFFF', borderWidth: 2 }]
      }, () => {
        // ⚠️ setData 是异步的；等节点渲染出来再框住整条路线（否则 includePoints 拿不到地图）
        wx.createMapContext('wmap', this).includePoints({ points: pts, padding: [60, 60, 60, 60] });
      });
    }).catch(e => {
      wx.hideLoading();
      console.error('[客户详情] 步行路线失败', e);
      wx.showToast({ title: '路线获取失败，请稍后再试', icon: 'none' });
    });
  },
  walkClose() { this.setData({ walkShow: false, walkLine: [] }); },

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
      if (!res || !res.ok) { api.toast((res && res.msg) || '提交失败，请稍后再试'); return false; }
      wx.showToast({ title: res.msg || '已提报', icon: 'none', duration: 2000 });
      return true;
    } catch (e) {
      wx.hideLoading();
      this._fieldBusy = false;
      api.toast((e && (e.errMsg || e.message)) || '提交失败，网络异常');
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
  // 点三格 → 先问「拍照 / 从相册选」，再按来源取图（⭐ 2026-09-28 晚老板定：**页内所有"点格子拍照"统一**）
  //   ⚠️ 不靠 `sourceType:['camera','album']` 碰运气 —— 微信各机型行为不一致
  //      （有时弹"拍照/从相册选择"，有时直接跳相册；微信分身环境还只认一个来源）。
  takePhoto(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    wx.showActionSheet({
      itemList: ['拍照', '从相册选'],
      success: (r) => this.takePhotoBySource(i, r.tapIndex === 0 ? 'camera' : 'album'),
      fail: () => { /* 用户取消 */ }
    });
  },
  // 真正取图（原逻辑不动：上传云存储 + 写客户档案），只是来源改为按选择传入
  takePhotoBySource(i, src) {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: [src], sizeType: ['compressed'],
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
          if (!res || !res.ok) { api.toast((res && res.msg) || '保存失败，请稍后再试'); return; }
          // ⚠️ 2026-10-12：与 uploadPhotoFile 同一个雷（本地临时路径不能当 image src 用）→ 换成云上的地址回显
          let showUrl = f.tempFilePath;
          try {
            const us = await wx.cloud.getTempFileURL({ fileList: [up.fileID] });
            const f0 = (us && us.fileList && us.fileList[0]) || null;
            if (f0 && f0.tempFileURL) showUrl = f0.tempFileURL;
          } catch (e2) { /* 换不到就先用本地路径顶着 */ }
          const d = this.data.d;
          const photos = d.photos.slice();
          photos[i] = showUrl;
          d.photos = photos;
          this.setData({ d });
          wx.showToast({ title: '已保存到客户档案', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          api.toast((err && (err.errMsg || err.message)) || '上传失败，请重试');
        }
      },
      fail: () => { /* 用户取消，不打扰 */ }
    });
  },

  // ---------- 🧭 导航到该客户（⭐ 2026-09-28 晚老板定：小地图下方新增「导航」按钮）----------
  //   用 wx.openLocation 打开**微信内置地图**（无需任何 key）：用户在里面可一键跳高德/百度继续导航。
  //   无坐标（d.lat 空）时按钮本身不渲染（wxml 里 wx:if）。
  onNav() {
    const d = this.data.d || {};
    const lat = Number(d.lat), lng = Number(d.lng);
    if (!lat || !lng) { api.toast('这个客户还没有坐标'); return; }
    wx.openLocation({
      latitude: lat, longitude: lng, scale: 18,
      name: d.name || '客户位置',
      address: d.addr || ''
    });
  },

  // 从记事页返回时刷新「我的记事 · N 条」（只读本机 storage，不联网）
  // ⭐⭐ 2026-10-16 老板定：**给客户详情补「下拉刷新」**（他说"新店页的刷新 / 下拉很有用，看还能用到哪些方面"，
  //   并同意"客户详情也加上 —— 但它得先补个下拉刷新"）。
  //   ⚠️ **必须走 `_forceReload` 这条路**：详情页是"**当天有缓存就直接用**"，
  //      不置这个标记的话，下拉会拿到旧缓存 → **看不到最新**（与 `onShow` 里那条"改完必须真的刷新"同一个坑）。
  //   ⚠️ 顺带这也让"客户详情的时效可以放心放到当天"（老板 2026-10-16 定的方向）。
  async onPullDownRefresh() {
    try {
      if (this._cid) { this._forceReload = true; await this.onLoad({ id: this._cid }); }
    } catch (e) { /* 静默：刷新失败保留原样，不打断 */ }
    wx.stopPullDownRefresh();
  },
  onShow() {
    this._loadNotes();
    // ⭐ 2026-10-10：从「编辑拜访记录」回来 → 重拉详情（铁律：改完必须真的刷新）
    if (wx.getStorageSync('custNeedRefresh')) {
      wx.removeStorageSync('custNeedRefresh');
      if (this._cid) { this._forceReload = true; setTimeout(() => this.onLoad({ id: this._cid }), 50); }
      // ⭐ 2026-10-15：**必须设 `_forceReload`** —— 现在详情页"当天有缓存就直接用"，
      //   不设这个标记的话，改完返回会拿旧缓存、**看不到刚改的内容**（正是老板最反感的那种）。
    }
    // ⭐⭐ 2026-10-14（依《全项目审查》V01）：上次在拜访页**强行离页自动提交**时，
    //   有照片/录音没跟着传上（照片还是临时路径、离开页面可能就失效）→ 进这家店时**提醒补拍**。
    //   ⚠️ 清单由 `visit.js` 的 `_notePendingEvidence()` 写入；**提示过一次就清掉**（不反复弹）。
    try {
      const all = this._cid ? (wx.getStorageSync('evPending') || {}) : {};
      const p = all[this._cid];
      if (p && (p.pics || p.recs)) {
        delete all[this._cid];
        wx.setStorageSync('evPending', all);
        setTimeout(() => {
          try {
            wx.showModal({
              title: '上次有证据没传上',
              content: '上次离开拜访页时，有 ' + (p.pics || 0) + ' 张照片、' + (p.recs || 0) + ' 段录音没确认上传。如果还需要，请重新拍一次。',
              showCancel: false, confirmText: '知道了'
            });
          } catch (e) { /* 静默 */ }
        }, 700);
      }
    } catch (e) { /* 静默：提示失败不能影响页面 */ }
  },

  // ---------- ✏️ 更正信息（⭐ 2026-10-10 老板定：电话行右侧那块 44×44，原「快速记事」被替换）----------
  //   场景：业务员到店发现**店名 / 老板换了** → 点它打开「加新店」第 2 步的同款表单
  //   （pages/custedit，预填这家店现在的信息），选择性修改后**直接生效**（老板拍板）。
  //   ⚠️ 原「快速记事」入口已放弃（老板 2026-10-10："记事入口暂时放弃，以后再说"）。
  goCorrect() {
    wx.navigateTo({ url: '/pages/custedit/custedit?customerId=' + (this._cid || '') });
  },
  // ⭐⭐ 2026-10-10 老板定：点「✎ 编辑」→ 回拜访页（编辑模式）改这条拜访记录
  //   ⚠️ 拜访页 onLoad 会读 storage 里的 curCustomer → 先把它补好（这家店）
  // ⭐ 2026-10-13 老板：「经纬度后面跟一个复制按钮，能点击产生复制功能」
  //   复制**当前显示的那一组**（修正模式下就是地图中心的新坐标）—— 纬度在前（项目口径），
  //   复制出来的格式正好能直接粘到后台「📍 输入经纬度」框里用。
  copyLL() {
    // ⚠️⚠️ 2026-10-13 修（老板真机截图：坐标明明显示着，点复制却提示"还没有坐标"）：
    //   根因 —— 本页客户数据在 `this.data.d` 里（wxml 写的是 {{d.lat}}），
    //   而修正模式的两个临时字段（fixLat/fixLng）是**顶层**（wxml 写的是 {{fixLat}}）。
    //   上一版我全写成了 this.data.lat / d.fixing → 永远取不到 → 误报。这次按真实层级取。
    const s = this.data || {}, d = s.d || {};
    const fLat = s.fixLat || d.fixLat, fLng = s.fixLng || d.fixLng;
    const lat = (s.fixing && fLat) ? fLat : d.lat;
    const lng = (s.fixing && fLng) ? fLng : d.lng;
    if (!lat || !lng) { wx.showToast({ title: '这家还没有坐标', icon: 'none' }); return; }
    wx.setClipboardData({
      data: lat + ',' + lng
      // ⚠️ setClipboardData 自己会弹「内容已复制」，别再叠一个 toast（会打架）
    });
  },
  editVisit(e) {
    const vid = e.currentTarget.dataset.vid;
    if (!vid) return;
    const d = this.data.d || {};
    const cc = wx.getStorageSync('curCustomer') || {};
    wx.setStorageSync('curCustomer', Object.assign({}, cc, { _id: this._cid, name: d.name || cc.name || '' }));
    wx.navigateTo({ url: '/pages/visit/visit?editVisitId=' + vid });
  },
  // ⭐ 2026-10-11 老板定：拜访记录右下角「🗑 删除」—— 删掉这条拜访
  //   ⚠️ 口径与"取消拜访"一致：**真删、不留痕**（不可恢复）；**只能删自己的**（云端也会拦）；
  //      任务进度是实时算的 → 删完自动回退；自由拜访卡的"已拜访家数"由云端重算。
  async delVisit(e) {
    const vid = e.currentTarget.dataset.vid;
    if (!vid) return;
    const ok = await new Promise(res => wx.showModal({
      title: '删除这条拜访记录？', content: '删掉后这次拜访就没了（不可恢复），任务进度也会退回。',
      confirmText: '删除', cancelText: '取消', confirmColor: '#E5484D',
      success: r => res(!!r.confirm), fail: () => res(false)
    }));
    if (!ok) return;
    wx.showLoading({ title: '删除中…', mask: true });
    let r = null;
    try { r = await api.call('visits', { action: 'deleteVisit', visitId: vid }); }
    catch (err) { console.error('[customer] 删拜访异常', err); }
    wx.hideLoading();
    if (!r || !r.ok) { api.toast((r && r.msg) || '删除失败，请稍后再试'); return; }
    wx.showToast({ title: '已删除', icon: 'success' });
    // ⭐⭐ 2026-10-14 老板报障（业务员："提示删除了、记录还在"）：**重拉前必须先强制**！
    //   详情页现在是"当天有缓存就直接渲染、不问云端"（`onLoad` 里的 `if (!_force)`），
    //   所以**不置 `_forceReload` 的"重拉"等于什么都没拉到** —— 表现就是"删了、还在"。
    //   ⚠️ 云端那一次其实**真删掉了**（实测 `visit_deleted` 名单有记录），纯粹是页面没刷新。
    this._forceReload = true;
    this.onLoad({ id: this._cid });   // 重拉详情（铁律：改完必须真的刷新）
  },
  // ---------- 📝 快速记事（2026-10-10 老板当天改回：放在「更正信息」**左边**）----------
  //   点它 = 以本客户为对象快速记一笔（标题 / 关联客户自动带好）。
  //   ⚠️ 记事**只存本机**（2026-09-28 老板定），落地见 pages/notes/editor/。
  goQuickNote() {
    const d = this.data.d || {};
    wx.navigateTo({
      url: '/pages/notes/editor/editor?customerId=' + (this._cid || '') + '&customerName=' + encodeURIComponent(d.name || '')
    });
  },
  // 更正保存后由 custedit 页回调（铁律：改完之后必须真的刷新）—— 重跑一次详情加载
  // ⚠️ 2026-10-14：**必须先置 `_forceReload`** —— 否则"重跑 onLoad"会命中当天缓存、拿的还是旧数据
  //   （同 `delVisit` 那处；这是"改了看不到"的另一条同类路径）。
  onCorrectDone() {
    if (this._cid) { this._forceReload = true; this.onLoad({ id: this._cid }); }
  },
  // ---------- 📝 我的记事（这一家本机记了几条；点进列表只看这一家）----------
  goNotes() {
    const d = this.data.d || {};
    wx.navigateTo({
      url: '/pages/notes/notes?customerId=' + (this._cid || '') + '&customerName=' + encodeURIComponent(d.name || '')
    });
  },
  _loadNotes() {
    try { this.setData({ notesN: require('../../utils/notes').countBy(this._cid || '') }); } catch (e) { /* 静默 */ }
  },

  // ---------- ⭐ 2026-09-28 晚：**地图修正模式**（点「📍 修正」→ 拖地图取中心点 → 确定提交审核）----------
  //   老板口径：① 地图可移动 ② 取新的经纬度 ③ 上方经纬度显示新坐标 + 与原坐标的距离
  //             ④ 「修正」变「确定」、左边多出「取消」 ⑤ 确定后变成新经纬度并**自动提交后台审核**
  //   ⚠️ **两个都留**：原来的「📍 报错」（弹层 + 手机 GPS 现场定位）照旧保留；本条走**地图中心点**。
  //   ⚠️ 云端 `coordfix` **一个字没改** —— 它本来就收 { customerId, lat, lng, note, photos }（这条不传 photos）。
  //   ⚠️ 老板模式：云函数会模拟成功不落库（跟「报错」那条一样的老规矩）。
  startFix() {
    const d = this.data.d || {};
    if (!d.lat || !d.lng) { api.toast('这个客户还没有坐标'); return; }
    // ⚠️ 把"地图当前中心"也初始化成客户坐标：修正模式下 latitude 绑的是 centerLat/centerLng
    //    （若继续绑 d.lat，用户一拖地图、页面任何 setData 都会把视野**拉回**客户点 → 根本拖不动）
    this.setData({ fixing: true, centerLat: d.lat, centerLng: d.lng, fixLat: d.lat, fixLng: d.lng, fixDist: '' });
    // ⭐ 2026-09-28 晚老板定：引导文案**不再用 wx.showToast** —— 那是屏幕正中的一个胶囊，
    //   正好压在地图中心 + 红点上（老板："放中间很不好，挡视线"）。
    //   改为小地图**上边缘**的页内提示条常显（wxml 的 .cmap-tip，`wx:if="{{fixing}}"`）：
    //   只要在修正模式就一直看得见，不用靠一次性的 toast。
  },
  // 地图视野变化（拖动 / 缩放都会走这里）
  //   ⚠️ 用事件自带的 e.detail.centerLocation，**不要用 mapCtx.getCenterLocation()** ——
  //      后者会触发地图重算视野，表现就是"一拖就弹回去"（2026-09-28 踩过）。
  //
  //   ⭐ 2026-09-28 晚老板反馈："缩放是按鼠标/手指位置缩放的，不是按针点" ——
  //     这是微信 <map> 的原生行为（缩放中心 = 手势/光标位置），**没有任何开关能改**。
  //     所以在这里自己修：
  //       · **缩放**（e.detail.scale 变了）→ 把视野**拉回针点**（平时 = 客户坐标 / 修正中 = 上一次的中心）
  //         → 用户看到的效果就是"**以针点为中心缩放**"；
  //       · **拖动**（scale 没变）→ 修正模式下更新针点位置；平时不可拖，不管。
  onRegionChange(e) {
    if (e && e.type && e.type !== 'end') return;   // 只在"结束"那一刻处理，避免过程中疯狂 setData
    // 🔴 2026-09-28 晚（老板报"地图很卡、经常卡死不刷新"）：
    //   **自己 setData 把视野拉回去，会再触发一次 regionchange → 再拉 → 无限循环 → 卡死**。
    //   打一个"这次是我自己发起的"标记，下一次进来直接忽略（只忽略一次，不吞用户的真实操作）。
    if (this._selfMove) { this._selfMove = false; return; }

    const d = this.data.d || {};
    const det = (e && e.detail) || {};
    const sc = (det.scale == null || det.scale === '') ? null : Number(det.scale);
    const isZoom = (this._lastScale != null && sc != null && sc !== this._lastScale);
    if (sc != null) this._lastScale = sc;
    // 小工具：当前中心是否已经在 (la,ln) —— 已经在就**别再 setData**（省一次地图重绘，也避免抖动）
    const at = (la, ln) => Math.abs(Number(la) - Number(this.data.centerLat)) < 1e-6 && Math.abs(Number(ln) - Number(this.data.centerLng)) < 1e-6;

    if (this.data.fixing) {
      if (isZoom) {
        // 修正模式 · 缩放 → 拉回**针点**（= 上一次的中心）：实现"以针点为中心缩放"
        const la = Number(this.data.fixLat), ln = Number(this.data.fixLng);
        if (!la || !ln || at(la, ln)) return;
        this._selfMove = true;
        this.setData({ centerLat: la, centerLng: ln });
      } else {
        // 修正模式 · 拖动 → 针点跟着走到新的地图中心
        const c = det.centerLocation;
        if (!c) return;
        const lat = Number(c.latitude.toFixed(6)), lng = Number(c.longitude.toFixed(6));
        if (at(lat, lng)) return;   // 没真的动 → 不 setData
        this.setData({ centerLat: lat, centerLng: lng, fixLat: lat, fixLng: lng, fixDist: this._distText(d.lat, d.lng, lat, lng) });
      }
    } else if (isZoom) {
      // 平时（不可拖，只可能缩放）→ 缩放后把中心拉回**客户坐标**
      const la = Number(d.lat), ln = Number(d.lng);
      if (!la || !ln || at(la, ln)) return;
      this._selfMove = true;
      this.setData({ centerLat: la, centerLng: ln });
    }
  },
  cancelFix() {
    const d = this.data.d || {};
    // 退出修正模式 → 中心回到 d.lat/d.lng（客户原位），地图自然回到客户点上；_lastScale 也清掉
    this._lastScale = null;
    this.setData({ fixing: false, fixLat: d.lat, fixLng: d.lng, fixDist: '', centerLat: d.lat, centerLng: d.lng });
  },
  // 与原坐标的球面距离（Haversine；小程序没有"算距离"的 API，自己算）
  _distText(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = (x) => x * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    const m = Math.round(2 * R * Math.asin(Math.sqrt(a)));
    return m < 1000 ? (m + ' 米') : ((m / 1000).toFixed(1) + ' 公里');
  },
  async confirmFix() {
    if (this._fixBusy) return;
    const cid = this._cid;
    const { fixLat, fixLng } = this.data;
    if (!cid || !fixLat || !fixLng) { api.toast('缺少参数'); return; }
    this._fixBusy = true;
    wx.showLoading({ title: '提交审核…', mask: true });
    try {
      // note 固定写「地图修正」；云函数侧 note ≤100 字、同客户已有 pending 会拒绝（去重）
      const res = await api.call('coordfix', { customerId: cid, lat: fixLat, lng: fixLng, note: '地图修正（业务员在地图上拖动定位）' });
      wx.hideLoading();
      if (res && res.ok) {
        // ⚠️ 2026-09-28 晚老板反馈"改了定位但后台没收到、铃铛没提示"——**不是通知坏了**：
        //   若以「👑 老板模式」进小程序，api.js 会自动带 boss:true → 云端 isBoss=true →
        //   **虚拟写、不落库**（老板模式本来就是"全量只读 + 虚拟写"）。后台查不到 → 自然不会响铃/播报。
        //   这里给明确提示，别让人误以为提交成功了。
        if (res.boss) {
          this._fixBusy = false;
          this.setData({ fixing: false, fixDist: '' });
          api.toast('演示模式：本次修正不进后台');
          return;
        }
        // 立即生效：上方经纬度换成新值（真正写进客户档案要等后台审核通过）
        const d = Object.assign({}, this.data.d, { lat: fixLat, lng: fixLng });
        // ⭐ 2026-09-28 晚老板定：**在新位置打一个「半透明蓝点」**（= 待审核的新位置）——
        //   直接用现成的 /images/locdot.png + `alpha: 0.5`（老板明确："就用半透明蓝点，不要自己画"）。
        //   原来的橙针**保留在原坐标不动**，两个点一眼能看出差多远。
        //   同时把地图中心 centerLat/centerLng 也换成新坐标 → **地图以新针点为中心**（缩放也围着它）。
        //   id 固定用 99，重复确定时先剔除旧的，不会越打越多。
        const ms = (this.data.markers || []).filter(m => m.id !== 99);
        ms.push({
          id: 99, latitude: fixLat, longitude: fixLng,
          iconPath: '/images/locdot.png', width: 26, height: 26,
          anchor: { x: 0.5, y: 0.5 }, zIndex: 10, alpha: 0.5
        });
        this._lastScale = null;   // 中心变了，让下一次缩放重新判定
        this.setData({ d, markers: ms, fixing: false, fixLat: fixLat, fixLng: fixLng, fixDist: '',
          centerLat: fixLat, centerLng: fixLng });
        api.toast('已提交，后台审核后更新', 'success');
      } else {
        api.toast((res && res.msg) || '提交失败，请稍后重试');
      }
    } catch (err) {
      wx.hideLoading();
      api.toast((err && (err.errMsg || err.message)) || '提交失败，请重试');
    }
    this._fixBusy = false;
  },

  // ---------- 📍 坐标报错（2026-09-27 起真提交 coord_fix_requests）----------
  //   ⭐ 2026-10-07 老板定：**改成独立整屏取点页 pages/coordfix/** ——
  //     本页只负责带着客户现有坐标跳过去；取点（📱手机 / 📡北斗 / ✎拖地图微调）+ 原因 + 提交都在那个页面做。
  //     （沿革：小弹层 → 当天上午的大半屏弹层 → 当天下午老板真机否掉"卡片太小、操作不方便" → 整屏页）
  //   ⚠️ 云端 coordfix 一个字没改；老板模式仍是"模拟成功不落库"，与「地图修正」同一条规矩。
  openFix() {
    const d = this.data.d || {};
    if (!d.lat || !d.lng) { api.toast('这个客户还没有坐标'); return; }
    wx.navigateTo({
      url: '/pages/coordfix/coordfix?customerId=' + (this._cid || '') +
           '&lat=' + d.lat + '&lng=' + d.lng +
           '&name=' + encodeURIComponent(d.name || '')
    });
  },

  // ---------- 大图查看 ----------
  openPhoto(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    // ⭐ 2026-10-10：记下"第几格" —— 门店三格带 data-i（大图里才显示「重拍/删除」）；
    //   拜访历史的照片不带 data-i → 记 -1（那两个按钮不显示，仍只有「关闭」）
    const ds = e.currentTarget.dataset || {};
    const idx = (ds.i === undefined || ds.i === null || ds.i === '') ? -1 : Number(ds.i);
    // ⭐⭐ 2026-10-12 老板定：**大图要能左右滑**（老板："门店照片和拜访详情中的照片，相互之间应该可以滑动切换"）
    //   做法：把**这一组**照片一起带进弹窗（swiper 渲染），左右滑、滑到哪张就对哪张操作。
    //   ① 门店三格（带 data-i）→ 一组 = 这家店的 3 格（去掉空位）
    //   ② 拜访历史的照片（不带 data-i）→ 一组 = 那条拜访的 shots
    let list = [url];
    if (idx >= 0) {
      const ps = (this.data.d.photos || []).filter(Boolean);
      if (ps.length) list = ps;
    } else {
      const hs = (this.data.d.history || []);
      for (let i = 0; i < hs.length; i++) {
        const s = (hs[i] && hs[i].shots) || [];
        if (s.indexOf(url) >= 0) { list = s.slice(); break; }
      }
    }
    let cur = list.indexOf(url);
    if (cur < 0) { list = [url]; cur = 0; }
    this.setData({ viewerShow: true, viewerUrl: url, viewerIdx: idx, viewerList: list, viewerCur: cur });
  },
  // ⭐ 2026-10-12：大图左右滑 → 记住滑到第几张（「重拍/编辑/删除」跟着它走；门店三格的格位号也同步）
  onViewerSwipe(e) {
    const i = (e && e.detail && Number(e.detail.current)) || 0;
    const list = this.data.viewerList || [];
    const patch = { viewerCur: i, viewerUrl: list[i] || this.data.viewerUrl };
    if (this.data.viewerIdx >= 0) patch.viewerIdx = i;
    this.setData(patch);
  },
  closePhoto() { this.setData({ viewerShow: false }); },
  // ⭐ 2026-10-12：空处理 —— 只为**吃掉 swiper 上的点击**，别冒泡到外层（外层是"点一下关闭"）
  noop() { /* 什么都不做 */ },
  // ⭐ 2026-10-10 老板定：门店照片大图里「📷 重拍」—— 直接开相机，复用现有上传链路（覆盖同一格）
  retakePhoto() {
    const i = Number(this.data.viewerIdx);
    if (!(i >= 0)) return;
    this.setData({ viewerShow: false });
    this.takePhotoBySource(i, 'camera');
  },
  // ⭐ 2026-10-12：把"一个本地文件"上传到第 i 格（从 takePhotoBySource 里抽出来 —— 裁剪后复用它）
  async uploadPhotoFile(i, filePath) {
    const cid = this._cid;
    if (!cid) { wx.showToast({ title: '缺少客户参数', icon: 'none' }); return; }
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const up = await wx.cloud.uploadFile({
        cloudPath: 'custphotos/' + cid + '/' + Date.now() + '_' + i + '.jpg',
        filePath: filePath
      });
      const res = await api.call('tasks', { action: 'saveCustPhoto', customerId: cid, fileID: up.fileID, index: i });
      wx.hideLoading();
      if (!res || !res.ok) { api.toast((res && res.msg) || '保存失败，请稍后再试'); return; }
      // ⚠️⚠️ 2026-10-12 老板报「裁剪之后，界面上的小图就看不到了」：
      //   原来拿**本地临时路径**塞进 photos[i] 回显 —— 而 wx.editImage 给的临时路径
      //   在部分机型**不能直接当 image src**（重拍那条路也埋着同一个雷）。
      //   修法：上传成功后**用云存储的 fileID 换临时 URL** 来显示（与 onLoad 读照片同一条路）。
      let showUrl = filePath;
      try {
        const us = await wx.cloud.getTempFileURL({ fileList: [up.fileID] });
        const f0 = (us && us.fileList && us.fileList[0]) || null;
        if (f0 && f0.tempFileURL) showUrl = f0.tempFileURL;
      } catch (e2) { /* 换不到就先用本地路径顶着 */ }
      const d = this.data.d;
      const photos = d.photos.slice();
      photos[i] = showUrl;
      d.photos = photos;
      this.setData({ d });
      wx.showToast({ title: '已保存到客户档案', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.error('[customer] 上传失败（裁剪后）', err);
      api.toast('保存失败，请稍后再试');
    }
  },
  // ⭐⭐ 2026-10-12 老板定：门店照片大图里加「✂️ 编辑」—— **只要裁剪**（用微信自带的编辑界面 wx.editImage，可裁剪/旋转）
  //   流程：先下载成本地临时文件 → wx.editImage → 拿回临时文件 → **覆盖同一格**（复用上传链路）。
  //   ⚠️ wx.editImage 要基础库 2.11.0+；不支持时给人话提示（不静默）。
  editPhoto() {
    const i = Number(this.data.viewerIdx);
    if (!(i >= 0)) return;
    const url = this.data.viewerUrl;
    if (!url) return;
    if (!wx.editImage) { api.toast('当前微信版本不支持裁剪，请升级微信'); return; }
    wx.showLoading({ title: '准备中…', mask: true });
    wx.downloadFile({
      url: url,
      success: (d) => {
        wx.hideLoading();
        if (!d || d.statusCode !== 200 || !d.tempFilePath) { api.toast('拿不到这张图，稍后再试'); return; }
        wx.editImage({
          src: d.tempFilePath,
          success: (r) => {
            if (!r || !r.tempFilePath) return;
            this.setData({ viewerShow: false });
            this.uploadPhotoFile(i, r.tempFilePath);      // ← 覆盖同一格
          },
          fail: (e) => { console.warn('[customer] editImage 取消/失败', e); }
        });
      },
      fail: (e) => { wx.hideLoading(); api.toast('拿不到这张图，稍后再试'); console.error('[customer] 下载原图失败', e); }
    });
  },
  // ⭐ 2026-10-10 老板定：门店照片大图里「🗑 删除」—— 云端删记录（+ 尽力删云存储文件）→ 重拉详情
  async delPhoto() {
    const i = Number(this.data.viewerIdx);
    if (!(i >= 0)) return;
    const ok = await new Promise(res => wx.showModal({
      title: '删除这张照片？', content: '删掉后这家店的门店照片就少一张（记录和云文件都会清掉）。',
      confirmText: '删除', cancelText: '取消', confirmColor: '#E5484D',
      success: r => res(!!r.confirm), fail: () => res(false)
    }));
    if (!ok) return;
    wx.showLoading({ title: '删除中…', mask: true });
    let r = null;
    try { r = await api.call('tasks', { action: 'saveCustPhoto', customerId: this._cid, index: i, del: true }); }
    catch (e) { console.error('[customer] 删照片异常', e); }
    wx.hideLoading();
    if (!r || !r.ok) { api.toast((r && r.msg) || '删除失败，请稍后再试'); return; }
    this.setData({ viewerShow: false });
    wx.showToast({ title: '已删除', icon: 'success' });
    this._forceReload = true;   // ⚠️ 2026-10-14：同 delVisit —— 不强制就命中当天缓存，删了也看不到
    this.onLoad({ id: this._cid });   // 重拉详情（照片会前移，界面保持一致）
  },

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

  // ⭐ 2026-10-07 老板定：**分享这家店给同事**（右上角三个点的「转发给朋友」也会因此点亮）
  //   ⚠️ path 必须带 id —— 对方点开直达这家店的详情页（onLoad 认 ?id=）
  //   ⚠️ 封面只能用 images/share.png：该客户的门头照是云存储 fileID，分享卡片吃不了
  onShareAppMessage() {
    const d = this.data.d || {};
    // ⭐ 2026-10-07 老板定：**拿这家店的门头照当分享封面** —— 同事一眼就能认出是哪家店。
    //   ⚠️ imageUrl 只吃「本地包内路径」或「https 网络 URL」，**云存储 fileID 不行**；
    //      而 d.photos[0] 在 onLoad 里已经被 wx.cloud.getTempFileURL 换成**临时 URL**了（见本文件 298-306 行），
    //      所以这里直接拿来用即可，**不需要异步**（onShareAppMessage 必须同步返回）。
    //   ⚠️ 没照片的店（新店 / 没拍过门头照）→ 自动回退到统一的 /images/share.png。
    // ⚠️ 封面优先用**已经下载到本地的门头照**（见 onLoad 里的 wx.cloud.downloadFile）——
    //   本地路径不需要任何域名白名单；没有就回退统一的 /images/share.png。
    const cover = this._shareImg || '/images/share.png';
    return {
      title: '聚火拜访 · ' + (d.name || '客户详情'),
      path: '/pages/customer/customer?id=' + this._cid + (this._shareToken ? ('&share=' + encodeURIComponent(this._shareToken)) : ''),
      imageUrl: cover
    };
  },

  // ---------- 开始拜访（2026-09-25 改：**真客户、真任务**，不再是 demo 标记）----------
  // 入口页（pages/task / pages/map）已经把**完整客户对象 + 任务设置**存进 curCustomer，
  // 这里**原样接力、只补齐可能缺的字段** —— ⚠️ 千万别自己重组整个对象：
  // 那会把 locCheck / locKeyRefresh / visitDurationLimit / recordingDurationLimit 等**任务级设置丢掉**，
  // 拜访页拿不到就不会做定位校验、录音档位也会退回默认值。
  goVisit() {
    if (this._guest) return;   // 2026-10-20：店家分享链接只读，不执行拜访
    const d = this.data.d;
    const c = wx.getStorageSync('curCustomer') || {};
    // ⚠️⚠️ 2026-10-12 修【严重串档】老板报：「一家家往下跑，当前一家的拜访记录跑到上一家的拜访历史里去了」
    //   根因：这行原来写 `_id: c._id || this._cid` —— **优先用了 storage 里的旧值**！
    //   当这家是从**带 ?id= 的入口**进来的（我新加的店 / 新店列表 / 拜访历史里跳转），
    //   storage 里的 curCustomer 还是**上一条** → 点「开始拜访」就把记录写到了上一家头上。
    //   正解：**当前页面的客户（this._cid）优先** —— 它是 onLoad 时按 URL/入口定死的，最可靠。
    //   顺带：**换了客户就不带旧任务**（否则拜访还会挂到上一家的任务上）。
    const sameCust = !!this._cid && c._id === this._cid;
    wx.setStorageSync('curCustomer', Object.assign({}, c, {
      _id: this._cid || c._id || '',
      taskId: sameCust ? (c.taskId || '') : '',
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

  // ---------- 「加新店」现场录音（⭐ 2026-10-03）：与拜访录音**同一套机制**，只是挂在 d.siteRec 上 ----------
  //   ⚠️ 复用同一个 _audio 单实例 —— 播新的会自动停掉上一条（项目铁律：同一时刻只放一条）
  _setSiteRec(patch) {
    const r = this.data.d && this.data.d.siteRec;
    if (!r) return;
    this.setData({ 'd.siteRec': Object.assign({}, r, patch) });
  },
  playSiteRec() {
    const r = this.data.d && this.data.d.siteRec;
    if (!r || !r.url) return;
    const wasPlaying = !!r.playing;
    this._stopAudio();
    if (wasPlaying) { this._setSiteRec({ playing: false, pct: 0 }); return; }   // 再点一下 = 停止
    const au = wx.createInnerAudioContext();
    au.obeyMuteSwitch = false;             // ⚠️ 项目铁律：真机静音键下也要出声
    au.src = r.url;
    this._audio = au;
    this._audioIdx = -2;                   // -2 = 「现场录音」这一路（与历史卡的 index 区分开）
    this._setSiteRec({ playing: true, pct: 0 });
    au.onTimeUpdate(() => {
      if (this._audioIdx !== -2) return;
      const dur = Number(au.duration) || 0;
      this._setSiteRec({ pct: dur ? Math.min(Math.round(Number(au.currentTime) / dur * 100), 100) : 0 });
    });
    au.onEnded(() => { this._stopAudio(); this._setSiteRec({ playing: false, pct: 0 }); });
    au.onError(() => {
      this._stopAudio();
      this._setSiteRec({ playing: false, pct: 0 });
      wx.showToast({ title: '录音播放失败（可稍后重进页面再试）', icon: 'none' });
    });
    au.play();
  },
  onUnload() { this._stopAudio(); },

  // 阻止弹层内部点击冒泡到遮罩
  noop() {}
});
