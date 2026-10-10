// 云函数 tasks：业务员任务列表 / 任务详情（含客户与拜访状态）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ===== ⭐ 2026-09-29 新增：静默吞错的"可见化"（高危1 修复，勘察报告 §F1）=====
//   背景：全项目曾有 22 处 `.catch(() => 默认值)` 既不打日志也不抛错 ——
//   查询失败被伪装成"没有数据"，导致「防重检测 50 米内一模一样都毫无反应」这类
//   查不出原因的 bug（真因是 customers 缺 lat_lng 索引）。
//   这里**不改容错行为**（默认值照旧返回，调用方契约不变），只做两件事：
//     ① 打一条带标签的 console.error（云函数日志里能查到）
//     ② 收进 _silentErrs（最多 30 条），便于排查
function silentCatch(tag, fallback) {
  return (e) => {
    const m = (e && e.message) || String(e);
    console.error('[silent:' + tag + '] ' + m);
    try {
      if (_silentErrs.length < 30) _silentErrs.push(tag + ': ' + m);
    } catch (e2) { /* 静默 */ }
    return fallback;
  };
}
const _silentErrs = [];


// ===== 2026-09-11 批 3：云调用用量自建统计（与 adminapi / visits 写同一份 settings.usageCounter；攒批落库）=====
let _ucCount = 0, _ucAt = 0;
function ucMonth(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 7);
}
async function bumpUsage(n) {
  _ucCount += Number(n) || 1;
  const now = Date.now();
  if (_ucCount < 20 && now - _ucAt < 60000) return;
  const add = _ucCount;
  _ucCount = 0; _ucAt = now;
  try {
    const month = ucMonth(now);
    const r = await db.collection('settings').where({ key: 'usageCounter' }).limit(1).get();
    const cur = r.data[0];
    const val = (cur && cur.value) || { total: 0, months: {} };
    val.total = (val.total || 0) + add;
    val.months = val.months || {};
    val.months[month] = (val.months[month] || 0) + add;
    val.updatedAt = now;
    if (cur) await db.collection('settings').doc(cur._id).update({ data: { value: val, updatedAt: now } });
    else await db.collection('settings').add({ data: { key: 'usageCounter', value: val, updatedAt: now } });
  } catch (e) { /* 统计失败不影响业务 */ }
}

exports.main = async (event) => {
  bumpUsage(1); // 2026-09-11 批 3：用量计数（每次调用 +1，攒批落库）
  const { OPENID } = cloud.getWXContext();
  const { action, taskId } = event || {};

  // ===== ⭐⭐ 2026-09-29 新增：免鉴权自检接口（专为排查"防重检测没反应"）=====
  //   一次调用同时回答三件事，免得再来回猜：
  //     ① 云端这份代码到底是不是最新的（看 code 版本戳 CODE_VER）
  //     ② customers 的 lat/lng 范围查询能不能跑通（顺带验证索引有没有生效）
  //     ③ 指定坐标附近到底有几家店、分别是谁、每家的坐标是多少
  //   ⚠️ 刻意放在**鉴权之前** —— 排查时可能没有登录态；它**只读**、不写任何数据。
  if (action === 'selfCheck') return await selfCheck(event);

  const me = await db.collection('users').where({ openid: OPENID }).get();
  // 2026-09-28：同一 openid 可能**同时绑「实习(trial)」与正式账号**（开发者点「以游客身份进入」）。
  //   默认**正式优先**（原本直接取 data[0]，顺序不确定 —— 这里显式定序，消除随机）；
  //   请求带 asTrial（前端实习态，见 utils/api.js）→ 把 trial 账号排到最前，下面 data[0] 一律取它。
  // ⭐⭐ 2026-09-28 晚修【重大错误】：**实习声明优先于 openid 认人**
  //   背景：开发者（范宇琨）的微信 openid 早就绑了**正式业务员账号**；而「实习体验入口」按老板口径
  //   **不绑定 openid**。原来这里只在「openid 查不到人」时才拿 trialId 核对 →
  //   他点实习进来时 openid 查到了正式账号 → **认成业务员 → 看到业务员的任务**（老板报的正是这个）。
  //   现在：只要请求声明实习(asTrial) 且带 trialId，就**先**拿 trialId 去库里核对
  //   （role=salesman + trial=true）；核对通过 → **直接用它**，不再看 openid 绑的是谁。
  //   ⚠️ 只信库里的数据；核对不过 / 没带实习声明 → 完全维持原逻辑（正式优先，显式定序消除随机）。
  {
    const _asT = !!(event && (event.asTrial === true || event.asTrial === 'true'));
    const _tid = String((event && event.trialId) || '');
    let _picked = null;
    if (_asT && _tid) {
      const _one = await db.collection('users').doc(_tid).get().catch(() => null);
      const _u = _one && _one.data;
      if (_u && _u.role === 'salesman' && _u.trial === true) _picked = _u;
    }
    if (_picked) {
      me.data = [_picked];
    } else {
      const _l = me.data.slice();
      const _tr = _l.filter(x => x.trial);
      me.data = (_asT && _tr.length) ? _tr.concat(_l.filter(x => !x.trial)) : _l.sort((a, b) => (a.trial ? 1 : 0) - (b.trial ? 1 : 0));
    }
  }
  if (!me.data.length) return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  const meDoc = me.data[0];
  // 老板模式（2026-09-10 老板定：管理员模式与老板模式合并——管理员（super_admin/admin）一律按老板处理，
  // 不再看 boss 白名单字段；手机号=15055492888 为老板本人，字段保留仅作历史兜底）
  // 2026-09-09 开发者范宇琨双身份：dev 白名单（13067737286）且请求带 boss 标志 → 按老板处理（全量只读+虚拟写）
  // ⭐ 2026-09-30：**老板兼业务员**（alsoSalesman）声明「以业务员身份进入」→ 这次请求**按业务员认人**
  //   （isBoss=false：看自己的任务、拜访真落库、进统计）。老板朱小利要亲自带队跑样板就靠它。
  //   ⚠️ 声明只会"降权"（老板→业务员），不可能提权；且必须库里 alsoSalesman === true 才认。
  const asSalesman = !!(event && (event.asSalesman === true || event.asSalesman === 'true')) && meDoc.alsoSalesman === true;
  const isBoss = !asSalesman && (['super_admin', 'admin'].includes(meDoc.role)
    || (meDoc.phone === '13067737286' && event && event.boss === true));
  const salesmanId = meDoc._id;

  if (action === 'list') return await list(salesmanId, isBoss);
  if (action === 'detail') return await detail(salesmanId, taskId, isBoss);
  if (action === 'mapData') return await mapData(salesmanId, taskId, isBoss); // 2026-09-09 提速 B：地图轻量接口
  if (action === 'finish') return await finish(salesmanId, taskId, meDoc, isBoss);
  if (action === 'subStatus') return await subStatus(salesmanId, isBoss);
  if (action === 'reviewStatus') return await reviewStatus(salesmanId, isBoss);
  if (action === 'ver') return await taskVer(salesmanId);   // ⭐ 2026-10-10 手机端心跳（只回一个戳）
  if (action === 'replanDay') return await replanDay(salesmanId, event, isBoss);
  if (action === 'bossBoard') return await bossBoard(salesmanId, isBoss);
  if (action === 'bossWar') return await bossWar(isBoss);
  if (action === 'bossTrack') return await bossTrack(isBoss, event); // 老板手机端：业务员今日轨迹
  // 2026-09-25 新增（老板定：「客户详情页」改造成 A 演示稿那套 7 卡骨架，要能看真数据）：
  //   一次返回一家客户在详情页要显示的全部内容（档案 + 订单摘要 + 最近20单明细 + 备注 + 拜访历史）。
  //   权限：**登录的业务员即可读** —— 客户档案本来就全公司共享（大家都要上门拜访）；
  //   写入类动作不在本次范围（后续再开）。
  if (action === 'custDetail') return await custDetail(salesmanId, event, isBoss);
  // ⭐ 2026-09-27 新增：业务员给客户档案补**门店照片**（详情页三个相框，点空框现场拍 → 云存储 → 写档案）
  //   权限：登录业务员即可写（照片全公司共享，现场拍本就该业务员做）
  if (action === 'saveCustPhoto') return await saveCustPhoto(salesmanId, event);
  // ⭐ 2026-09-28 新增：「加新店」——业务员**现场**给还没在库里的店建档（演示稿 _scratch/加新店-演示.html）
  //   newShopCheck  = 防重复（200 米内同电话/同名）+ 区域&商圈自动识别（近邻加权投票）
  //   newShopSubmit = 建档（customers 一条，标 source:'field' + mallPending:true → 后台「现场录入·待商城建档」）
  if (action === 'newShopCheck') return await newShopCheck(event);
  if (action === 'newShopSubmit') return await newShopSubmit(salesmanId, event);
  // ⭐ 2026-09-29 新增：「我的 → 我新加的店」三个接口
  //   myNewShops    = 拉**我自己**提交的现场录入（source:'field'）→ 列表卡片
  //                   （状态就用现成的 mallPending：true=待商城建档 / false=已对上商城）
  //   newShopDetail = 拉单条，给「加新店」页**预填编辑**用
  //   updateNewShop = 改完**直接生效**（老板 2026-09-29 定：不设复核队列、不留痕）
  if (action === 'myNewShops') return await myNewShops(salesmanId, event);
  if (action === 'newShopDetail') return await newShopDetail(salesmanId, event, isBoss);
  if (action === 'updateNewShop') return await updateNewShop(salesmanId, event);
  // ⭐ 2026-10-03 自由拜访：按坐标+半径取附近客户点
  if (action === 'nearbyCustomers') return await nearbyCustomers(salesmanId, event);
  // ⭐ 2026-10-03 自由拜访卡（独立集合 free_trips，不绑任务）
  if (action === 'freeTripCreate') return await freeTripCreate(salesmanId, meDoc, event);
  if (action === 'freeTripList') return await freeTripList(salesmanId, meDoc, event);
  if (action === 'freeTripPause') return await freeTripSetStatus(salesmanId, meDoc, event, 'paused');
  if (action === 'freeTripResume') return await freeTripSetStatus(salesmanId, meDoc, event, 'active');
  if (action === 'freeTripDetail') return await freeTripDetail(salesmanId, meDoc, event);
  if (action === 'freeTripDelete') return await freeTripDelete(salesmanId, meDoc, event);   // ⭐ 2026-10-04 业务员删自己的卡
  if (action === 'walkRoute') return await walkRoute(salesmanId, event);                     // ⭐ 2026-10-04 步行路线（我 → 某家店）
  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' };
};

// =====================================================================================
// ⭐ 2026-09-28 新增：「加新店」两个接口（业务员现场给还没在库里的店建档）
//   演示稿：_scratch/加新店-演示.html ＋ 加新店-防重复-演示.html
//   老板 2026-09-28 拍板：① 电话**选填**（填了就按"同电话 = 铁证"拦；没填只做同名提示）
//                        ② 提交后**直接进客户列表** ＋ 后台备一份「现场录入 · 待商城建档」
//                        ③ 区域与商圈**都自动填**（可手改）
//   数据 biz_index.json（69,733 条：坐标＋行政区＋商圈，金华全域 9 区县 / 198 商圈），
//     由 TMP 大众点评表生成（脚本 _scratch/_gen_newshop_data.py）。
//   识别算法：**半径内按 1/距离 加权投票**（区域用"行政区"、商圈用 regionName），取前 3 候选
//     —— 与 _scratch/loo2_biz.py 留一验证口径一致（R=100m / 权重 1/d / 前 3 覆盖 99.4%）。
// =====================================================================================
// ⭐ 2026-09-28 晚改：识别数据从「云函数包内的 biz_index.json」改成**云端数据库集合 biz_index**
//   —— ① 云函数包瘦身（部署不用再传 3.45MB）② 以后扩城市不受云函数 10MB 上传上限限制。
//   数据由 `admin/tools/import_biz_index.js` 导入（69733 条；_id = b0、b1… 幂等可重跑）。
const BIZ_RADIUS = 100;   // 识别半径（米）—— 留一验证的最佳值
const DUP_RADIUS = 200;   // 防重复"附近"半径（米）—— 演示稿口径

// 按 lat/lng 范围拉附近的点（走 biz_index 的 lat_lng 复合索引）
async function pullNear(lat, lng, d) {
  const r = await db.collection('biz_index')
    .where({ lat: _.gt(lat - d).and(_.lt(lat + d)), lng: _.gt(lng - d).and(_.lt(lng + d)) })
    .field({ lat: true, lng: true, area: true, biz: true })
    .limit(1000).get().catch(silentCatch('tasks·pullNear', { data: [] }));
  return r.data || [];
}

// 近邻加权投票 → { hit, area, bizCircle, cands:[{area,biz,w}] }
//   ⚠️ 2026-09-28 晚起改成 **async**（数据在数据库里了）—— 调用处必须 await
async function geoVote(lat, lng) {
  // 范围先给 ±165 米（0.0015°），足够覆盖 100 米识别半径；拉满 1000 条就收缩范围重拉一次
  let d = 0.0015;
  let pts = await pullNear(lat, lng, d);
  if (pts.length >= 1000) {
    d = 0.0008;
    pts = await pullNear(lat, lng, d);
  }
  const areaW = {}, pairW = {};
  let hit = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || !p.lat || !p.lng) continue;        // ⚠️ 跳过空坐标（源数据里有）
    const dd = haversine(lat, lng, p.lat, p.lng);
    if (dd > BIZ_RADIUS) continue;
    hit++;
    const w = 1 / Math.max(dd, 8);                // 8 米兜底：避免 d→0 时权重爆炸
    if (p.area) areaW[p.area] = (areaW[p.area] || 0) + w;
    if (p.biz) { const k = p.area + '|' + p.biz; pairW[k] = (pairW[k] || 0) + w; }
  }
  const cands = Object.keys(pairW).map(k => {
    const a = k.split('|');
    return { area: a[0], biz: a[1], w: Math.round(pairW[k] * 100) / 100 };
  }).sort((x, y) => y.w - x.w).slice(0, 3);
  let area = '', best = 0;
  Object.keys(areaW).forEach(k => { if (areaW[k] > best) { best = areaW[k]; area = k; } });
  return { hit, area, bizCircle: cands[0] ? cands[0].biz : '', cands };
}

function normName(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
function maskPhone(p) {
  const s = String(p || '').trim();
  return s.length >= 7 ? (s.slice(0, 3) + '****' + s.slice(-4)) : s;
}
function mdCn(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.getUTCMonth() + 1 + '月' + d.getUTCDate() + '日';
}

// ===== ⭐ 2026-09-29 新增：防重的**模糊匹配**（老板实测报的 bug）=====
//   老板原话："故意移动定位点到盛武肥牛店旁边，输入名字几乎一样的店铺、座机号也近似，
//             结果防重检测毫无反应" —— 根因是老实现只做 `===` 精确匹配，
//             "盛武肥牛" vs "盛武肥牛店"、"…8888" vs "…888 8" 全都测不出来。
//   现在分三档：
//     block   电话**完全一致** → 铁证，拦（保持原行为，老板 2026-09-28 定）
//     sameName 店名**归一化后完全一致** → 提示（保持原行为）
//     suspect  店名**高度相似** 或 电话**近似** → ⭐ 新增：预警但**不拦**（用户可以确认后继续建）
const NAME_TAIL = /(分店|门店|总店|旗舰店|有限公司|有限责任公司|公司|中心|广场|商场|超市|餐厅|饭店|酒楼|大排档|小吃|快餐|店|馆|楼|城|铺|行|家|号)$/;

// 店名归一化：全角→半角、去括号内容、去标点空格、**剥掉"店/馆/楼…"这类通用后缀**
function nameNorm(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角→半角
  t = t.replace(/[（(][^）)]*[）)]/g, '');                        // 去括号里的内容（如"(高镇商业区店)"）
  t = t.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');               // 只留中文/字母/数字
  for (let i = 0; i < 3; i++) {                                   // 最多剥 3 层通用后缀
    const n = t.replace(NAME_TAIL, '');
    if (n === t) break;
    t = n;
  }
  return t;
}
// 编辑距离（Levenshtein）—— 只在 200 米内最多 50 条上算，性能无所谓
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}
// 店名相似度 0~1（归一化后算；一方包含另一方也算高相似）
function nameSim(a, b) {
  const x = nameNorm(a), y = nameNorm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const L = Math.max(x.length, y.length);
  let sim = 1 - lev(x, y) / L;
  // 短的那个被长的完全包含（"肥牛" vs "盛武肥牛"）→ 抬高一点，但仍要求短串别太短
  const short = x.length <= y.length ? x : y, long = x.length <= y.length ? y : x;
  if (short.length >= 3 && long.indexOf(short) >= 0) sim = Math.max(sim, short.length / long.length * 0.5 + 0.5);
  return Math.max(0, Math.min(1, sim));
}
// 电话归一化：只留数字，剥掉 +86 / 86 前缀
function phoneNorm(p) {
  let t = String(p == null ? '' : p).replace(/\D/g, '');
  if (t.length > 11 && t.indexOf('86') === 0) t = t.slice(2);
  return t;
}
// ⭐⭐ 2026-09-29 新增【老板当场指出】：
//   **业务员照门头抄电话，绝不会自己加区号** —— 库里存 `0579-82177093`、业务员填 `82177093`，
//   **这就是同一个号**，应该直接**拦住**（红卡），不能只给个"疑似"提示。
//   所以比较电话一律用这个 **phoneKey()**（把区号剥掉），而不是原始的 phoneNorm()。
//   规则：
//     · 手机号（11 位、1 开头）→ 原样
//     · 座机带区号（0 开头，如 0579 / 0571 / 021）→ 剥掉区号，留本地号（82177093）
//     · 座机不带区号 → 原样
function phoneKey(p) {
  let t = phoneNorm(p);
  if (!t) return '';
  if (t.length === 11 && t.charAt(0) === '1') return t;      // 手机号：原样
  if (t.charAt(0) === '0' && t.length > 8) {                 // 座机带区号：0 + 区号
    // ⚠️ 区号位数**不能一概而论**：010（北京）/ 02x（021~029 沪穗津等）是 **3 位**；
    //    其余（0579 金华、0571 杭州…）是 **4 位**。
    //    写成 `^0\d{2,3}` 会**贪婪剥掉 4 位** → `021-62888888` 被剥成 `2888888`（错）。
    t = t.replace(/^0(?:10|2\d|[3-9]\d{2})/, '');
  }
  if (t.length > 11) t = t.slice(-11);                       // 兜底：异常长号取后 11 位
  return t;
}
// 电话"近似"：**去区号后相同** / 后 8 位相同 / 只差 1 位（长度也要接近）
function phoneNear(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const A = phoneKey(a), B = phoneKey(b);
  if (A && B && A === B) return true;                        // ⭐ 去区号后同号（82177093 == 0579-82177093）
  const x = a.length > 11 ? a.slice(-11) : a;
  const y = b.length > 11 ? b.slice(-11) : b;
  if (x === y) return true;
  if (x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8)) return true;   // 尾号 8 位一致
  if (Math.min(x.length, y.length) >= 7 && Math.abs(x.length - y.length) <= 1 && lev(x, y) <= 1) return true;
  return false;
}

// 相似度门槛：≥0.72 算"疑似同名"（"盛武肥牛" vs "盛武肥牛店" 归一化后是 1.0，稳过）
const NAME_SUSPECT = 0.72;

// ⭐ 代码版本戳：**改这个云函数时顺手 +1**，用来判断"云端跑的是不是最新代码"
//   （老板报"防重没反应"排查用：调 selfCheck 一看 ver 就知道有没有重传）
const CODE_VER = '2026-10-05-0100';   // 2350=修 .limit(50) 截断；2400=电话比较改用 phoneKey（去区号）；1001=加 alsoSalesman 声明（老板兼业务员）；1100=selfCheck 支持 excludeId（后台防重复核用）；0100=自由拜访（nearbyCustomers 分圈取最近500 + walkRoute 步行路线 + 自由拜访卡 CRUD + _logTrip + 集合自愈）

// ⭐⭐ 免鉴权自检（排查"防重检测没反应"专用；**只读，不写任何数据**）
//   入参（全可选）：{ lat, lng, name, phone, radius, excludeId }
//     · excludeId —— 排除自己（⭐ 2026-10-03：后台「🔍 防重检测」复核用；不传的话"自己"会被算成重复）
//   出参：{ ok, ver, radius, nearCount, near[], queryOK, queryErr, dup }
//     · ver     —— 云端代码版本戳（跟本地对不上 = 没重传）
//     · near    —— 该坐标附近（默认 200 米）的店，按距离升序，带距离和坐标
//     · queryOK —— 坐标范围查询能不能跑通（false 说明索引/语法还有问题）
//     · dup     —— 顺手跑一次真实防重（传了 name/phone 时）
async function selfCheck(event) {
  const e = event || {};
  const out = { ok: true, ver: CODE_VER };
  const lat = Number(e.lat), lng = Number(e.lng);
  if (!lat || !lng) { out.msg = '没传 lat/lng，只回了版本号'; return out; }
  const R = Math.min(Math.max(Number(e.radius) || DUP_RADIUS, 10), 5000);
  out.radius = R;
  out.at = { lat: lat, lng: lng };
  const dLat = R / 111000;
  const dLng = R / (111000 * Math.cos(lat * Math.PI / 180) || 1);
  try {
    const r = await db.collection('customers')
      .where({ lat: _.gt(lat - dLat).and(_.lt(lat + dLat)), lng: _.gt(lng - dLng).and(_.lt(lng + dLng)) })
      .field({ name: true, nameRaw: true, phone: true, phone2: true, lat: true, lng: true })
      .limit(100).get();
    const rows = r.data || [];
    out.queryOK = true;
    out.nearCount = rows.length;
    out.near = rows.map(c => ({
      name: c.nameRaw || c.name || '', phone: maskPhone(c.phone),
      dist: Math.round(haversine(lat, lng, c.lat, c.lng)), lat: c.lat, lng: c.lng
    })).sort((a, b) => a.dist - b.dist);
  } catch (err) {
    out.queryOK = false;
    out.queryErr = (err && err.message) || String(err);
  }
  if (e.name || e.phone) {
    // ⭐ 2026-10-03：支持 excludeId —— 后台「🔍 防重检测」复核时要把**自己**排除，
    //   否则"自己跟自己同号"会被当成铁证重复。云函数间调用只能走这条免鉴权路（newShopCheck 要 OPENID）。
    out.dup = await dupCheck(lat, lng, String(e.name || ''), String(e.phone || ''), String(e.excludeId || ''));
  }
  return out;
}

// 防重复：200 米内找"同电话"（铁证，拦）、"同名"、以及**疑似重复**（⭐ 2026-09-29 新增）
//   电话口径（老板 2026-09-28 定）：**只在填了电话时**才查这一档；没填就跳过
//   ⭐ 2026-09-29：多一个 excludeId —— **编辑已有店铺时要排除自己**，
//      否则"改完再点防重检测"会把自己的那条记录当成疑似重复。
async function dupCheck(lat, lng, name, phone, excludeId) {
  const dLat = DUP_RADIUS / 111000;
  const dLng = DUP_RADIUS / (111000 * Math.cos(lat * Math.PI / 180) || 1);
  // ⚠️⚠️ 2026-09-29 修【真凶 · 第三次】：老板报"我就站在店旁边、库里有同名的，却说没有"。
  //   ① 先修的：`.catch(() => ({ data: [] }))` 把查询失败伪装成"附近没有店"（已改成 try/catch + 回传 err）
  //   ② 再修的：索引缺失（customers 的 lat_lng 已补）
  //   ③ **本次真凶**：`.limit(50)` —— **商圈核心 200 米内可能有 80+ 家店**，
  //      只取 50 条、又**没有排序** → 目标店很可能根本没进这 50 条 → 表现成"明明在旁边却说没有"。
  //      实测：金东区万达广场那个坐标 **200 米内有 81 家**。现在改成分批拉到 300 条。
  let near;
  try {
    const rows = [];
    const PAGE = 100;                 // ⚠️ 云开发单次查询上限就是 100
    const MAX = 300;                  // 最多拉 300 条（200 米内极少超过；超了会在下面标 truncated）
    for (let sk = 0; sk < MAX; sk += PAGE) {
      const part = await db.collection('customers')
        .where({ lat: _.gt(lat - dLat).and(_.lt(lat + dLat)), lng: _.gt(lng - dLng).and(_.lt(lng + dLng)) })
        .field({ name: true, nameRaw: true, phone: true, phone2: true, address: true, lat: true, lng: true,
                 mallKey: true, customerType: true })
        .skip(sk).limit(PAGE).get();
      const arr = (part && part.data) || [];
      for (const r of arr) rows.push(r);
      if (arr.length < PAGE) break;   // 已经取完
    }
    near = { data: rows, truncated: rows.length >= MAX };
  } catch (e) {
    return { block: null, sameName: null, suspect: null, err: '附近查询失败：' + ((e && e.message) || e) };
  }
  // ⭐ 用 phoneKey（**去区号**）—— 业务员照门头抄电话不会写区号，
  //   `82177093` 与库里的 `0579-82177093` 必须视为**同号** → 走 block（红卡拦住）
  const p0 = phoneKey(phone);
  const skipId = String(excludeId || '');
  let block = null, sameName = null, suspect = null;
  (near.data || []).forEach(c => {
    if (skipId && c._id === skipId) return;          // ⚠️ 排除自己（编辑模式）
    const d = Math.round(haversine(lat, lng, c.lat, c.lng));
    if (d > DUP_RADIUS) return;
    const info = {
      id: c._id, name: c.nameRaw || c.name || '', address: c.address || '', dist: d,
      phoneMask: maskPhone(c.phone), hasMall: !!(c.mallKey || c.customerType === 'mall'),
      phoneSame: false, phoneNear: false, nameSim: 0
    };
    // ---- ① 电话（都用 phoneKey 比：**去区号后相同 = 同号**）----
    if (p0) {
      const cp1 = phoneKey(c.phone), cp2 = phoneKey(c.phone2);
      if ((cp1 && cp1 === p0) || (cp2 && cp2 === p0)) {
        info.phoneSame = true;
        if (!block) block = info;
      } else if (phoneNear(p0, cp1) || phoneNear(p0, cp2)) {
        info.phoneNear = true;
      }
    }
    // ---- ② 店名（归一化后算相似度）----
    const sim = Math.max(nameSim(name, c.name), nameSim(name, c.nameRaw));
    info.nameSim = Math.round(sim * 100);          // 存百分比，前端好显示
    if (sim >= 0.999) {
      if (!sameName) sameName = info;
    } else if (sim >= NAME_SUSPECT || info.phoneNear) {
      // 疑似：取**最像**的那条（相似度高者优先，其次距离近的）
      if (!suspect || sim > suspect.nameSim / 100 || (sim === suspect.nameSim / 100 && d < suspect.dist)) suspect = info;
    }
  });
  // truncated=true 表示"附近店多到 300 条上限了"，可能仍有遗漏 → 前端会额外提示一句
  return { block, sameName, suspect, truncated: !!(near && near.truncated) };
}

// 查重 + 自动识别（前端改完店名/电话可以再调一次）
async function newShopCheck(event) {
  const e = event || {};
  const lat = Number(e.lat), lng = Number(e.lng);
  if (!lat || !lng) return { ok: false, code: 'NO_COORD', msg: '先采点：没有坐标，查重和自动识别都做不了' };
  const g = await geoVote(lat, lng);         // ⚠️ 数据在数据库里了 → 必须 await
  // ⚠️ excludeId：编辑模式（带 ?id= 进来）会传 → **把自己排除**，免得"改完点防重检测"报自己疑似重复
  const dup = await dupCheck(lat, lng, String(e.name || ''), String(e.phone || ''), String(e.excludeId || ''));
  // ⭐ 2026-09-28 晚：顺带把「录音单条上限 / 录音开关 / 照片上限」带回去 ——
  //   新店页**没有任务**，拿不到任务上快照的这几个配置；从 settings 读，前端就不必写死（后台一改就跟着变）。
  const cfg = await loadSettings();
  return {
    ok: true, hit: g.hit, area: g.area, bizCircle: g.bizCircle, cands: g.cands,
    block: dup.block, sameName: dup.sameName,
    suspect: dup.suspect || null,        // ⭐ 2026-09-29：疑似重复（店名高度相似 / 电话近似）—— 只预警、不拦
    dupErr: dup.err || '',               // ⚠️ 附近查询失败时带回原因（不再被吞成"附近没店"）
    // ⚠️ 附近店多到 300 条上限了 → 可能还有没扫到的，前端补一句提醒
    dupTruncated: !!dup.truncated,
    recLimit: cfg.recordingDurationLimit, recEnabled: cfg.recEnabled, photoLimit: cfg.photoLimit
  };
}

// 建档（老板定：直接进客户列表 ＋ 后台备一份「现场录入 · 待商城建档」）
async function newShopSubmit(salesmanId, event) {
  const e = event || {};
  const lat = Number(e.lat), lng = Number(e.lng);
  const name = String(e.name || '').trim();
  const phone = String(e.phone || '').trim();
  const address = String(e.address || '').trim();
  if (!lat || !lng) return { ok: false, code: 'NO_COORD', msg: '还没有坐标：先采点' };
  if (!name) return { ok: false, code: 'NO_NAME', msg: '请填店名' };
  if (!address) return { ok: false, code: 'NO_ADDR', msg: '请填地址' };
  const photos = (Array.isArray(e.photos) ? e.photos : []).filter(Boolean);
  if (!photos.length) return { ok: false, code: 'NO_PHOTO', msg: '店面照必拍：先拍一张门面照' };   // 老板 2026-09-28 定
  // 提交前**再查一次**（填写到提交有时间差，别人可能刚建过同一家）
  const dup = await dupCheck(lat, lng, name, phone);
  if (dup.block) return { ok: false, code: 'DUP_PHONE', msg: '这家店已经在客户库里了（电话一致）', dup: dup.block };

  const g = await geoVote(lat, lng);         // ⚠️ 同上：必须 await
  const area = String(e.area || '').trim() || g.area || '';
  const bizCircle = String(e.bizCircle || '').trim() || g.bizCircle || '❓ 未划分商圈';
  const me = await db.collection('users').doc(salesmanId).get().catch(() => null);
  const now = Date.now();
  const note = String(e.note || '').trim();
  const doc = {
    name: name,
    nameRaw: name,                                    // 原值留底（详情页/后台展示口径）
    phone: phone,
    phone2: String(e.phone2 || '').trim(),
    address: address,
    contactName: String(e.contactName || '').trim(),
    hours: String(e.hours || '').trim(),
    // 三层骨架（与 importdata.deriveGeo 同一口径）
    city: '金华市',
    district: area,
    bizCircle: bizCircle,
    region: area ? ('浙江省>金华市>' + area) : '',
    // 坐标：**GCJ-02 入库**（地图直接可用）；现场采的 **WGS-84 原值也留底**
    lat: lat, lng: lng,
    wgsLat: Number(e.wgsLat) || 0, wgsLng: Number(e.wgsLng) || 0,
    coordSource: 'newshop',                            // 坐标来源：「加新店」现场录入（后台/详情页显示"新店"）
    coordStatus: 'ok',
    // 品类三级 + 服务与设施
    cat1: String(e.cat1 || '').trim(), cat2: String(e.cat2 || '').trim(), cat3: String(e.cat3 || '').trim(),
    flags: (e.flags && typeof e.flags === 'object') ? e.flags : {},    // 外卖 / 团购
    fac: Array.isArray(e.fac) ? e.fac.filter(Boolean) : [],
    mallWish: String(e.mallWish || ''),                // 加入商城意愿：registered / pending / no
    photos: photos,                                     // 现场照 fileID（前端已上传云存储）
    audios: Array.isArray(e.audios) ? e.audios : [],
    remarks: note ? [{ d: mdCn(now), t: note }] : [],
    // ⭐ 2026-09-29 新增：招牌菜（现场录入）→ customers.platManual.dishes
    //   落点刻意与「客户详情页 → 现场提报 → 后台采纳」**完全一致**：
    //   customer.js 的 buildD 会把 platManual.dishes 和平台抓的 customers.dishes 合并显示，
    //   所以客户详情页**一个字都不用改**，建完档立刻能看到招牌菜。
    platManual: (function () {
      const ds = (Array.isArray(e.dishes) ? e.dishes : [])
        .map(x => String(x || '').trim()).filter(Boolean).slice(0, 30);
      return ds.length ? { dishes: ds } : {};
    })(),
    customerType: 'new',                                // 未加入商城
    source: 'field',                                    // ⭐ 现场录入（后台筛"现场录入·待商城建档"靠它）
    mallPending: true,                                  // ⭐ 待商城建档（商城表导入时自动对上）
    createdBy: salesmanId,
    createdByName: (me && me.data && me.data.name) || '',
    createdAt: now, updatedAt: now
  };
  const add = await db.collection('customers').add({ data: doc });
  // ⭐⭐ 2026-09-29【方案 C】建店成功后**发一个"客户有变动"的信号**
  //   背景：后台「🏪 客户管理 / 📦 批次管理」为提速改读**本地缓存快照**（admin/store.js），
  //        手机端新建的店不在快照里 → 老板在后台**看不到**（老板实测："菲菲杂粮煎饼"找不到）。
  //   做法：往 settings 写一条 `custDirtyAt = 当前时间`；后台读缓存时顺手比一下这个时间戳，
  //        比缓存新就在后台**自动重拉**，老板无需任何手动操作。
  //   ⚠️ 失败**不影响建店**（只 log、不抛）—— 缓存晚一点更新而已，丢了这单才是大事。
  try {
    const dr = await db.collection('settings').where({ key: 'custDirtyAt' }).limit(1).get();
    if (dr.data && dr.data.length) {
      await db.collection('settings').doc(dr.data[0]._id).update({ data: { value: now, updatedAt: now } });
    } else {
      await db.collection('settings').add({ data: { key: 'custDirtyAt', value: now, updatedAt: now } });
    }
  } catch (err) { console.error('[custDirtyAt] 写变动信号失败：', err); }
  return { ok: true, customerId: add._id, area: area, bizCircle: bizCircle };
}

// =====================================================================================
// ⭐ 2026-09-29 新增：「我的 → 我新加的店」（老板定：状态就用现成的 mallPending；改动直接生效）
//   ① myNewShops    拉**我自己**提交的现场录入 → 列表卡片（店名 / 提交时间 / 提交人 / 状态）
//   ② newShopDetail 拉单条 → 给「加新店」页**预填编辑**
//   ③ updateNewShop 改完**直接生效**（不设复核队列、不留痕；只允许改自己提交的）
//   状态口径：**就用现成的 mallPending** —— true=待商城建档 / false=已对上商城（商城表导入时自动翻）
// =====================================================================================
const SHOP_PAGE_MAX = 50;

async function myNewShops(salesmanId, event) {
  const e = event || {};
  const size = Math.min(Math.max(Number(e.size) || 20, 1), SHOP_PAGE_MAX);
  const skip = Math.max(Number(e.skip) || 0, 0);
  const w = { source: 'field', createdBy: salesmanId };      // 只看**我自己**建的
  const col = db.collection('customers');
  const [cnt, res] = await Promise.all([
    col.where(w).count().catch(() => ({ total: 0 })),
    // ⭐ 2026-10-02 老板定：**最新加的店排在最下面**（像记笔记一样往下加）→ 用 asc
    col.where(w).orderBy('createdAt', 'asc').skip(skip).limit(size).get().catch(silentCatch('tasks·myNewShops', { data: [] }))
  ]);
  const total = cnt.total || 0;
  const list = (res.data || []).map(c => ({
    id: c._id,
    name: c.name || c.nameRaw || '(没填店名)',
    area: c.district || '',
    bizCircle: c.bizCircle || '',
    address: c.address || '',
    // ⭐ 2026-10-02：**带上坐标** —— 卡片上的「开始拜访」要跳拜访页，拜访页需要 lng/lat 做定位校验
    lng: c.lng || 0, lat: c.lat || 0,
    createdAt: c.createdAt || 0,
    createdByName: c.createdByName || '',
    mallPending: c.mallPending !== false,                    // 默认按"待商城建档"看
    photoCount: Array.isArray(c.photos) ? c.photos.length : 0,
    audioCount: Array.isArray(c.audios) ? c.audios.length : 0
  }));
  return { ok: true, total: total, list: list, hasMore: (skip + list.length) < total };
}

async function newShopDetail(salesmanId, event, isBoss) {
  const id = String((event && event.id) || '');
  if (!id) return { ok: false, code: 'BAD_ARG', msg: '缺少 id' };
  const r = await db.collection('customers').doc(id).get().catch(() => null);
  const c = r && r.data;
  if (!c) return { ok: false, code: 'NOT_FOUND', msg: '找不到这家店' };
  // 只允许编辑**自己**提交的（老板模式只看不改，免得误动业务员的数据）
  if (c.createdBy !== salesmanId) {
    return { ok: false, code: 'FORBIDDEN', msg: isBoss ? '老板模式不修改业务员提交的店' : '只能修改自己提交的店' };
  }
  const pm = c.platManual || {};
  return {
    ok: true,
    shop: {
      id: c._id,
      name: c.name || '', phone: c.phone || '', address: c.address || '',
      contactName: c.contactName || '', hours: c.hours || '',
      area: c.district || '', bizCircle: c.bizCircle || '',
      cat1: c.cat1 || '', cat2: c.cat2 || '', cat3: c.cat3 || '',
      lat: c.lat || '', lng: c.lng || '', wgsLat: c.wgsLat || '', wgsLng: c.wgsLng || '',
      fac: Array.isArray(c.fac) ? c.fac : [],
      flags: (c.flags && typeof c.flags === 'object') ? c.flags : {},
      dishes: Array.isArray(pm.dishes) ? pm.dishes : [],
      mallWish: c.mallWish || '',
      note: (Array.isArray(c.remarks) && c.remarks[0] && c.remarks[0].t) || '',
      photos: Array.isArray(c.photos) ? c.photos : [],
      audios: Array.isArray(c.audios) ? c.audios : [],
      mallPending: c.mallPending !== false,
      createdAt: c.createdAt || 0, createdByName: c.createdByName || ''
    }
  };
}

async function updateNewShop(salesmanId, event) {
  const e = event || {};
  const id = String(e.id || '');
  if (!id) return { ok: false, code: 'BAD_ARG', msg: '缺少 id' };
  const cur = await db.collection('customers').doc(id).get().catch(() => null);
  if (!cur || !cur.data) return { ok: false, code: 'NOT_FOUND', msg: '找不到这家店' };
  if (cur.data.createdBy !== salesmanId) return { ok: false, code: 'FORBIDDEN', msg: '只能修改自己提交的店' };

  const lat = Number(e.lat), lng = Number(e.lng);
  if (!lat || !lng) return { ok: false, code: 'NO_COORD', msg: '还没有坐标：先回第 1 步定位' };
  const name = String(e.name || '').trim();
  const address = String(e.address || '').trim();
  const phone = String(e.phone || '').trim();
  if (!name) return { ok: false, code: 'NO_NAME', msg: '请填店名' };
  if (!address) return { ok: false, code: 'NO_ADDR', msg: '请填地址' };
  // 改完再查一次重；⚠️ 传 id **排除自己**（否则"什么都没改"也会被自己拦住）
  const dup = await dupCheck(lat, lng, name, phone, id).catch(() => null);
  if (dup && dup.block) {
    return { ok: false, code: 'DUP_PHONE', msg: '这家店已经在客户库里了（电话一致）', dup: dup.block };
  }

  const g = await geoVote(lat, lng);
  const area = String(e.area || '').trim() || g.area || '';
  const bizCircle = String(e.bizCircle || '').trim() || g.bizCircle || '❓ 未划分商圈';
  const now = Date.now();
  const note = String(e.note || '').trim();
  const dishes = (Array.isArray(e.dishes) ? e.dishes : [])
    .map(x => String(x || '').trim()).filter(Boolean).slice(0, 30);
  const pm = Object.assign({}, cur.data.platManual || {});
  if (dishes.length) pm.dishes = dishes; else delete pm.dishes;

  const data = {
    name: name, nameRaw: name, phone: phone, address: address,
    phone2: String(e.phone2 || '').trim(),     // ⭐ 2026-10-02：第二个电话（最多两个）—— 编辑模式也要存
    contactName: String(e.contactName || '').trim(),
    hours: String(e.hours || '').trim(),
    district: area, bizCircle: bizCircle,
    region: area ? ('浙江省>金华市>' + area) : '',
    lat: lat, lng: lng,
    wgsLat: Number(e.wgsLat) || 0, wgsLng: Number(e.wgsLng) || 0,
    coordSource: 'newshop', coordStatus: 'ok',
    cat1: String(e.cat1 || '').trim(), cat2: String(e.cat2 || '').trim(), cat3: String(e.cat3 || '').trim(),
    flags: (e.flags && typeof e.flags === 'object') ? e.flags : {},
    fac: Array.isArray(e.fac) ? e.fac.filter(Boolean) : [],
    mallWish: String(e.mallWish || ''),
    platManual: pm,
    updatedAt: now                    // ⭐ 后台本地缓存的增量同步靠它
  };
  if (Array.isArray(e.photos)) data.photos = e.photos.filter(Boolean);
  if (Array.isArray(e.audios)) data.audios = e.audios;
  if (note) {
    const rs = Array.isArray(cur.data.remarks) ? cur.data.remarks.slice() : [];
    data.remarks = rs.length ? rs.map((r, i) => (i === 0 ? { d: r.d, t: note } : r)) : [{ d: mdCn(now), t: note }];
  }

  await db.collection('customers').doc(id).update({ data: data });
  return { ok: true, customerId: id, area: area, bizCircle: bizCircle };
}

// ⭐ 2026-09-27 新增：门店照片落库（设计文档 §四：平台图打底 + 现场拍覆盖 —— 这里只管"现场拍"那一半）
//   入参：{ customerId, fileID, thumbID?, index? }   出参：{ ok, photos }
//   ⚠️ 只动对应格子（index 0~2），其它格子原样保留；写 updatedAt（本地缓存的增量同步靠它）
async function saveCustPhoto(salesmanId, event) {
  const customerId = String((event && event.customerId) || '');
  const fileID = String((event && event.fileID) || '');
  const thumbID = String((event && event.thumbID) || '');
  const index = Math.min(Math.max(Number(event && event.index) || 0, 0), 2);
  if (!customerId || !fileID) return { ok: false, code: 'BAD_ARG', msg: '缺少参数' };
  const cRes = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!cRes || !cRes.data) return { ok: false, code: 'CUST_NOT_FOUND', msg: '客户不存在' };
  const old = Array.isArray(cRes.data.photos) ? cRes.data.photos.slice(0, 3) : [];
  while (old.length < 3) old.push(null);
  old[index] = { fileID: fileID, thumbID: thumbID, by: salesmanId || '', at: Date.now() };
  const photos = old.filter(Boolean);
  await db.collection('customers').doc(customerId).update({ data: { photos: photos, updatedAt: Date.now() } }).catch(silentCatch('tasks·saveCustPhoto·写入', null));
  return { ok: true, photos: photos, msg: '已保存到客户档案 ✓' };
}

// ================= 老板手机端（2026-09-09 §7.13）只读接口 =================
// 首页数据：今日统计 + 全量任务总览（任务带 salesmanId/salesmanName）
async function bossBoard(salesmanId, isBoss) {
  if (!isBoss) return { ok: false, code: 'FORBIDDEN', msg: '仅老板可用' };
  const lt = await list(salesmanId, true);
  const tasks = (lt && lt.tasks) || [];
  let todayTotal = 0, todayDone = 0, visitedSum = 0, totalSum = 0;
  tasks.forEach(t => { todayTotal += (t.todayTotal || 0); todayDone += (t.todayDone || 0); visitedSum += (t.visited || 0); totalSum += (t.total || 0); });
  // 在线/拜访中：latest 位置 ≤10 分钟算在线；visitOngoing 位算拜访中
  // 2026-09-09 老板定：实习（trial 游客账号）不出现在老板手机端任何统计/点列表——统计只算非 trial 业务员
  const now = Date.now();
  const [lRes, smRes] = await Promise.all([
    db.collection('salesman_locations').where({ type: 'latest' }).get(),
    // ⭐ 2026-09-30：**老板兼业务员**（alsoSalesman）也纳入统计 —— 老板定「他按真业务员算」
    //   （他亲自带队跑样板，拜访/任务要进老板看板）。实习(trial) 照旧排除。
    db.collection('users').where(_.and([{ active: true, trial: _.neq(true) }, _.or([{ role: 'salesman' }, { alsoSalesman: true }])])).field({ _id: true }).get()
  ]);
  const realIds = new Set(smRes.data.map(u => u._id));
  let online = 0, ongoing = 0;
  lRes.data.forEach(l => {
    if (!realIds.has(l.salesmanId)) return; // 实习的 latest 不参与统计
    if (l.visitOngoing) ongoing++;
    if (l.t && now - Number(l.t) <= 10 * 60 * 1000) online++;
  });
  // 待审核任务数
  const revN = await db.collection('tasks').where({ status: 'reviewing', archivedAt: _.exists(false) }).count();
  return { ok: true, stats: { todayDone, todayTotal, visited: visitedSum, total: totalSum, online, ongoing, review: revN.total }, tasks };
}

// 战况地图数据：业务员位置点（三态口径）+ 今日动态流（开始/提交拜访）
async function bossWar(isBoss) {
  if (!isBoss) return { ok: false, code: 'FORBIDDEN', msg: '仅老板可用' };
  const now = Date.now();
  const [uRes, lRes] = await Promise.all([
    // 2026-09-09 老板定：战况地图不显示实习（trial 游客账号）的任何信息
    // ⭐ 2026-09-30：老板兼业务员（alsoSalesman）要显示（他按真业务员算，见 bossBoard 同口径）
    db.collection('users').where(_.and([{ active: true, trial: _.neq(true) }, _.or([{ role: 'salesman' }, { alsoSalesman: true }])])).field({ name: true, phone: true }).get(),
    db.collection('salesman_locations').where({ type: 'latest' }).get()
  ]);
  const lMap = {};
  lRes.data.forEach(l => { if (l.salesmanId) lMap[l.salesmanId] = l; });
  // 点状态口径（2026-09-09 老板定）：蓝=拜访中 / 橙=10 分钟内移动 / 灰=静止超 10 分钟；红圈预警前端算
  const points = uRes.data.map(u => {
    const l = lMap[u._id];
    const phone = u.phone || ''; // 老板手机端拨打电话用（注册时填的手机号，老板模式不打码）
    if (!l || !l.lat || !l.lng) return { salesmanId: u._id, name: u.name || '', phone, noData: true };
    const ageMin = l.t ? Math.floor((now - Number(l.t)) / 60000) : 999;
    return {
      salesmanId: u._id, name: u.name || '', phone,
      lat: l.lat, lng: l.lng, t: l.t || 0, acc: l.accuracy || 0,
      visitOngoing: !!l.visitOngoing, ageMin,
      state: l.visitOngoing ? 'ongoing' : (ageMin <= 10 ? 'moving' : 'still')
    };
  });
  // 今日动态：今天全部拜访记录（开始/提交）+ 客户名映射；2026-09-09 老板定：实习记录不出现在动态流
  const day = todayStr();
  const vRes = await db.collection('visits')
    .where({ visitedAt: day, status: _.in(['ongoing', 'normal', 'pending_review']) })
    .limit(200)
    .get();
  const realIdSet = new Set(uRes.data.map(u => u._id)); // 非 trial 业务员集合
  const events = vRes.data
    .filter(v => realIdSet.has(v.salesmanId)) // 排除实习
    .map(v => ({
      t: (v.status === 'ongoing' ? (v.startedAt || v.createdAt) : (v.finishedAt || v.createdAt)) || 0,
      type: v.status === 'ongoing' ? 'start' : 'submit',
      salesmanName: v.salesmanName || '',
      customerId: v.customerId || '',
      result: v.result || ''
    }));
  const cids = [...new Set(events.map(e => e.customerId).filter(Boolean))];
  const cNameMap = {};
  if (cids.length) {
    const cRes = await db.collection('customers').where({ _id: _.in(cids) }).field({ name: true }).get();
    cRes.data.forEach(c => { cNameMap[c._id] = c.name || ''; });
  }
  events.forEach(e => { e.customerName = cNameMap[e.customerId] || ''; delete e.customerId; });
  events.sort((a, b) => (b.t || 0) - (a.t || 0));
  return { ok: true, serverTime: now, points, events: events.slice(0, 100) };
}

// 老板手机端：业务员今日轨迹（2026-09-09 老板定：抽屉卡「📜 今日轨迹」——按天拉轨迹片段展平成点串）
async function bossTrack(isBoss, e) {
  if (!isBoss) return { ok: false, code: 'FORBIDDEN', msg: '仅老板可用' };
  const { salesmanId, day } = e || {};
  if (!salesmanId || !day) return { ok: false, code: 'BAD_ARG', msg: '参数不完整' };
  // 轨迹片段文档分页拉全（一天约几百片段，单次上限 100 需循环）
  const rows = [];
  const PAGE = 100;
  let skip = 0;
  while (true) {
    const r = await db.collection('salesman_locations')
      .where({ type: 'track', salesmanId, day: String(day) })
      .orderBy('createdAt', 'asc')
      .skip(skip).limit(PAGE).get();
    rows.push(...r.data);
    if (r.data.length < PAGE) break;
    skip += PAGE;
  }
  const pts = [];
  rows.forEach(r => (r.pts || []).forEach(p => {
    if (p && p.lat && p.lng) pts.push({ lat: p.lat, lng: p.lng });
  }));
  return { ok: true, pts };
}

// 审核观察员：返回该业务员所有审核中任务的精简信息（供手机端 15 秒轮询等待审批结果）
// ⭐⭐ 2026-10-10 老板定：**任务心跳**（手机端每 15 秒问一次，只回一个戳）
//   老板原话：「每个小操作都应该三方实时反馈，**大批量数据的才是管控对象**」
//   覆盖四件事：**新任务派下来 / 任务被后台结束 / 被延期撤回 / 拜访审核结果** —— 手机端"变了才拉详情"。
//   ⚠️ **省钱的关键**：只回一个戳、**不拉任何业务数据** —— 按 `salesmanId`（有索引）取几十条，
//      在云函数里算个 max，响应几十字节。20 人 ≈ 2~3 元/天。
//   ⚠️ 老板模式（isBoss）**不做心跳** —— 他的实时性由后台/战况页负责（第三段再说）。
async function taskVer(salesmanId) {
  if (!salesmanId) return { ok: true, ver: '0' };
  const r = await db.collection('tasks')
    .where({ salesmanId })
    .field({ updatedAt: true, status: true })
    .limit(200)
    .get().catch(() => null);
  let mx = 0, st = '';
  ((r && r.data) || []).forEach(t => { const u = t.updatedAt || 0; if (u >= mx) { mx = u; st = t.status || ''; } });
  return { ok: true, ver: mx + '-' + st };
}

async function reviewStatus(salesmanId, isBoss) {
  if (isBoss) return { ok: true, list: [] }; // 老板演示：待审数走 adminapi bossBoard
  const res = await db.collection('tasks').where({ salesmanId, status: 'reviewing' })
    .field({ _id: true, name: true, status: true })
    .limit(20).get();
  return { ok: true, list: res.data };
}

// 订阅状态：是否还有可用的订阅凭证（一次性订阅，发送后失效）
// mpBound：业务员已绑定服务号 OpenID 且后台启用服务号通知 → 手机端无需再引导一次性订阅
async function subStatus(salesmanId, isBoss) {
  if (isBoss) return { ok: true, hasSub: false, mpBound: false }; // 老板演示：无订阅
  const res = await db.collection('settings').where({ key: `subToken_${salesmanId}` }).limit(1).get();
  const info = res.data[0];
  const me = await db.collection('users').doc(salesmanId).get().catch(() => null);
  const mpRes = await db.collection('settings').where({ key: 'mpConfig' }).limit(1).get();
  const mpCfg = mpRes.data[0] && mpRes.data[0].value;
  const mpBound = !!(me && me.data && me.data.mpOpenid && mpCfg && mpCfg.enabled);
  return { ok: true, hasSub: !!(info && info.value && info.value.token), mpBound };
}

// 业务员交任务：全部完成且未开启"需管理员确认"→直接 done；
// 提前交（有未完成）或开启确认开关 → reviewing（审核中）+ finishReq 留痕，等管理员审批
async function finish(salesmanId, taskId, user, isBoss) {
  // 游客（实习账号）硬拦（2026-09-08 老板定：游客不能提交数据）
  if (user && user.trial) return { ok: false, code: 'TRIAL_FORBIDDEN', msg: '游客不能提交数据' };
  if (!taskId) return { ok: false, code: 'BAD_ARG', msg: '缺少任务' };
  const tRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const t = tRes && tRes.data;
  if (!t || (t.salesmanId !== salesmanId && !isBoss)) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status === 'reviewing') return { ok: false, code: 'REVIEWING', msg: '已在审核中，等待管理员确认' };
  if (t.status !== 'published') return { ok: false, code: 'STATE', msg: t.status === 'done' ? '任务已结束' : '任务状态异常' };
  if (t.deadline && String(t.deadline) <= todayStr()) return { ok: false, code: 'TASK_EXPIRED', msg: '任务已过期，请联系管理员延期' };

  // 制约（2026-09-05 老板定）：有客户拜访中时不能提交任务结束（提前交也不行），先完成或取消拜访
  const ong = await db.collection('visits')
    .where({ taskId, status: 'ongoing', visitedAt: todayStr() })
    .limit(1).get();
  if (ong.data.length) {
    const o = ong.data[0];
    const cRes = await db.collection('customers').doc(o.customerId).get().catch(() => null);
    return { ok: false, code: 'ONGOING_VISIT', msg: `「${(cRes && cRes.data && cRes.data.name) || '有客户'}」正在拜访中，请先完成或取消拜访` };
  }

  // 未拜访家数
  const ids = t.customerIds || [];
  const left = ids.length - await countVisitedCustomers(taskId);
  // 是否自动审核通过（勾选=全部完成自动结束；不勾选=必须人工审核）
  const setRes = await db.collection('settings').where({ key: 'autoApproveFinish' }).get();
  const autoPass = !!(setRes.data[0] && setRes.data[0].value);

  const now = Date.now();
  // 老板模式（2026-09-09 §7.13）：走完校验后假返回，不写任务状态、不留痕
  if (isBoss) {
    if (left <= 0 && autoPass) return { ok: true, boss: true, status: 'done', msg: '任务已结束 ✓（演示：未保存）' };
    return { ok: true, boss: true, status: 'reviewing', msg: left > 0 ? '已向管理员提交提前结束申请，等待确认（演示：未保存）' : '已提交结束申请，等待管理员审核（演示：未保存）' };
  }
  if (left <= 0 && autoPass) {
    // 全部完成且开启自动通过：直接结束（留 autoDone 流水，2026-09-08 历史任务板块）
    const logs = [...(Array.isArray(t.logs) ? t.logs : []), { at: now, by: t.salesmanName || '业务员', role: 'salesman', type: 'autoDone', detail: { auto: true } }];
    await db.collection('tasks').doc(taskId).update({
      data: { status: 'done', finishedAt: now, finishedBy: t.salesmanName || '', logs }
    });
    return { ok: true, status: 'done', msg: '任务已结束 ✓' };
  }
  // 提前交（left>0）或未勾选自动通过：进入审核中，等待管理员审批（提交申请事件留痕）
  // finishReq 用 _.set 整体替换（否则数据库按子字段合并，finishReq 为 null 时会报 -502001）
  const logs = [...(Array.isArray(t.logs) ? t.logs : []), { at: now, by: t.salesmanName || '业务员', role: 'salesman', type: 'finishReq', detail: { left, type: left > 0 ? 'early' : 'full' } }];
  await db.collection('tasks').doc(taskId).update({
    data: {
      status: 'reviewing',
      finishReq: _.set({ at: now, left, type: left > 0 ? 'early' : 'full' }),
      logs
    }
  });
  return { ok: true, status: 'reviewing', msg: left > 0 ? '已向管理员提交提前结束申请，等待确认' : '已提交结束申请，等待管理员审核' };
}

async function list(salesmanId, isBoss) {
  // 已归档任务业务员端不再显示（2026-09-08 老板定：过期归档=终态封存）
  // 老板模式（2026-09-09 §7.13）：全量进行中/待审任务（跨业务员），附 salesmanId/salesmanName
  const cond = isBoss
    ? { status: _.in(['published', 'reviewing']), archivedAt: _.exists(false) }
    : { salesmanId, status: _.in(['published', 'reviewing', 'done']), archivedAt: _.exists(false) };
  const res = await db.collection('tasks')
    .where(cond)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();

  // 老板模式：业务员名映射（任务卡显示谁的任务）
  const nameMap = {};
  if (isBoss) {
    const sidSet = [...new Set(res.data.map(t => t.salesmanId).filter(Boolean))];
    if (sidSet.length) {
      const uRes = await db.collection('users').where({ _id: _.in(sidSet) }).field({ name: true }).get();
      uRes.data.forEach(u => { nameMap[u._id] = u.name || ''; });
    }
  }

  // 统计各任务拜访进度（按客户家数去重：同一客户多次拜访只算 1 家；ongoing 拜访中不算）
  // 今日计划：任务创建日=第 1 天推算今天该拜访的客户名单，统计名单内已完成家数
  // 今日有拜访中客户的任务集合（首页任务卡蓝边框用）
  const ongSet = new Set();
  {
    const allIds = res.data.map(t => t._id);
    if (allIds.length) {
      let skip = 0;
      const PAGE = 100;
      while (true) {
        const r = await db.collection('visits')
          .where({ taskId: _.in(allIds), status: 'ongoing', visitedAt: todayStr() })
          .field({ taskId: true })
          .skip(skip).limit(PAGE).get();
        r.data.forEach(v => ongSet.add(v.taskId));
        if (r.data.length < PAGE) break;
        skip += PAGE;
      }
    }
  }
  const tasks = [];
  for (const t of res.data) {
    const visited = await countVisitedCustomers(t._id);
    const dayIdx = dayIndexOf(t.startDate, t.createdAt);
    const plan = (t.dayPlan || []).find(p => p.day === dayIdx);
    const todayIds = plan ? (plan.customerIds || []) : [];
    let todayDone = 0;
    if (todayIds.length) {
      const doneSet = new Set();
      let skip = 0;
      const PAGE = 100;
      while (true) {
        const r = await db.collection('visits')
          .where({ taskId: t._id, customerId: _.in(todayIds), status: _.in(['normal', 'pending_review']) })
          .field({ customerId: true })
          .skip(skip).limit(PAGE).get();
        r.data.forEach(v => doneSet.add(v.customerId));
        if (r.data.length < PAGE) break;
        skip += PAGE;
      }
      todayDone = doneSet.size;
    }
    const total = (t.customerIds || []).length;
    const expired = t.status === 'published' && t.deadline && String(t.deadline) <= todayStr();
    tasks.push({
      _id: t._id,
      name: t.name,
      taskNo: t.taskNo || '',
      purpose: t.purpose,
      deadline: t.deadline,
      plannedDays: t.plannedDays,
      status: t.status,
      expired,
      total,
      visited,
      percent: total ? Math.round(visited / total * 100) : 0,
      todayTotal: todayIds.length,
      todayDone,
      hasOngoing: ongSet.has(t._id),
      // 老板模式（2026-09-09 §7.13）：任务归属信息供首页/任务地图显示
      salesmanId: isBoss ? (t.salesmanId || '') : undefined,
      salesmanName: isBoss ? (nameMap[t.salesmanId] || t.salesmanName || '') : undefined
    });
  }
  return { ok: true, tasks };
}

// 今天对应任务第几天（优先任务开始日期 startDate；否则按创建日=第 1 天；东八区日期差 +1）
function dayIndexOf(startDate, createdAt) {
  let d0 = '';
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    d0 = String(startDate);
  } else if (createdAt) {
    d0 = new Date(Number(createdAt) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  } else {
    return 1;
  }
  const d1 = todayStr();
  const diff = Math.round((new Date(d1 + 'T00:00:00Z').getTime() - new Date(d0 + 'T00:00:00Z').getTime()) / 86400000);
  return diff + 1;
}

// 任务内已拜访家数：有完成拜访记录（normal/pending_review）的客户去重计数，分页取防超时
async function countVisitedCustomers(taskId) {
  const set = new Set();
  let skip = 0;
  const PAGE = 100;
  while (true) {
    const r = await db.collection('visits')
      .where({ taskId, status: _.in(['normal', 'pending_review']) })
      .field({ customerId: true })
      .skip(skip).limit(PAGE).get();
    r.data.forEach(v => set.add(v.customerId));
    if (r.data.length < PAGE) break;
    skip += PAGE;
  }
  return set.size;
}

// 2026-09-09 提速（C 方案）：每客户最新一条已完成拜访记录（分页取全，先到先占）
async function lastVisitMap(taskId, ids) {
  const lastMap = {};
  if (!ids || !ids.length) return lastMap;
  let skip = 0;
  const PAGE = 100;
  while (true) {
    const r = await db.collection('visits')
      .where({ taskId, customerId: _.in(ids), status: _.in(['normal', 'pending_review']) })
      .orderBy('createdAt', 'desc')
      .skip(skip).limit(PAGE).get();
    r.data.forEach(v => { if (!lastMap[v.customerId]) lastMap[v.customerId] = v; });
    if (r.data.length < PAGE) break;
    skip += PAGE;
  }
  return lastMap;
}

// 2026-09-11 降频改造：改为**一次性拉全表 settings**（原来是 8 个配置各查一次的并行查询）
// 原因：配置项从 8 个涨到 19 个，逐个查询会让每次「任务详情」多出十几条读调用；全表一次读最省（settings 表条目很少）
async function loadSettings() {
  const all = {};
  try {
    const r = await db.collection('settings').limit(100).get();
    (r.data || []).forEach(s => { all[s.key] = s.value; });
  } catch (e) { /* 读失败则全部走默认值 */ }
  const locCfg = all.locationCheck || { enabled: true, threshold: 100 };
  const lrVal = Number(all.locRefreshInterval) || 30;
  const locRefresh = [30, 45, 60].includes(lrVal) ? lrVal : 30;
  const lkrVal = Number(all.locKeyRefreshInterval) || 15;
  const locKeyRefresh = [8, 12, 15, 20].includes(lkrVal) ? lkrVal : 15;
  const recVal = Number(all.recordingDurationLimit) || 300;
  const recordingDurationLimit = [180, 300, 600].includes(recVal) ? recVal : 300;
  const vdVal = Number(all.visitDurationLimit) || 3600;
  const visitDurationLimit = [1800, 3600, 7200].includes(vdVal) ? vdVal : 3600;
  const workStartHour = Number.isInteger(Number(all.workStartHour)) ? Number(all.workStartHour) : 7;
  const workEndHour = Number.isInteger(Number(all.workEndHour)) ? Number(all.workEndHour) : 20;
  // 非工作档位：2026-09-11 老板定只留三档（20_120 默认 / 30_180 / 60_300）
  const offDutyTier = ['20_120', '30_180', '60_300'].includes(String(all.offDutyTier)) ? String(all.offDutyTier) : '20_120';
  // ===== 2026-09-11 降频与开关类（默认值与 adminapi.getSettings 保持一致）=====
  const locTrackEnabled = all.locTrackEnabled === undefined ? true : !!all.locTrackEnabled;
  const locLatestEnabled = all.locLatestEnabled === undefined ? true : !!all.locLatestEnabled;
  const locWorkTier = ['5_30', '15_60', '30_120'].includes(String(all.locWorkTier)) ? String(all.locWorkTier) : '30_120';
  const mt = Number(all.locMoveThreshold);
  const locMoveThreshold = Number.isInteger(mt) && mt >= 0 && mt <= 200 ? mt : 20;
  const photoLimit = [3, 6, 9, 15].includes(Number(all.photoLimit)) ? Number(all.photoLimit) : 9;
  const recEnabled = all.recEnabled === undefined ? true : !!all.recEnabled;
  const evidenceRequired = !!all.evidenceRequired;
  const coordFixEnabled = all.coordFixEnabled === undefined ? true : !!all.coordFixEnabled;
  const reviewWatchEnabled = all.reviewWatchEnabled === undefined ? true : !!all.reviewWatchEnabled;
  const salesmanScope = String(all.salesmanScope) === 'all' ? 'all' : 'task';
  const phoneVisibility = String(all.phoneVisibility) === 'masked' ? 'masked' : 'visible';
  return {
    locCfg, locRefresh, locKeyRefresh, recordingDurationLimit, visitDurationLimit,
    workStartHour, workEndHour, offDutyTier,
    locTrackEnabled, locLatestEnabled, locWorkTier, locMoveThreshold,
    photoLimit, recEnabled, evidenceRequired, coordFixEnabled, reviewWatchEnabled,
    salesmanScope, phoneVisibility
  };
}

async function detail(salesmanId, taskId, isBoss) {
  const tRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const t = tRes && tRes.data;
  if (!t || (t.salesmanId !== salesmanId && !isBoss)) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };

  // 任务内客户（保持任务内排列顺序：有 dayPlan 按计划顺序，否则按 customerIds 原序）
  const ids = t.customerIds || [];
  // 2026-09-09 提速（C 方案）：客户/拜访状态/拜访中/坐标审核/系统配置 五路并行（原 10+ 次串行 await）
  const [cRes, lastMap, ongP, fixP, cfgP] = await Promise.all([
    ids.length ? db.collection('customers').where({ _id: _.in(ids) }).get() : Promise.resolve({ data: [] }),
    lastVisitMap(taskId, ids),
    ids.length ? db.collection('visits')
      .where({ taskId, customerId: _.in(ids), status: 'ongoing', visitedAt: todayStr() })
      .field({ customerId: true }).limit(100).get() : Promise.resolve({ data: [] }),
    ids.length ? db.collection('coord_fix_requests')
      .where({ customerId: _.in(ids), status: 'pending' })
      .field({ customerId: true }).get() : Promise.resolve({ data: [] }),
    loadSettings()
  ]);
  const map = {};
  cRes.data.forEach(c => { map[c._id] = c; });
  const customers = ids.filter(id => map[id]).map(id => map[id]);
  const ongSet = new Set();
  ongP.data.forEach(v => ongSet.add(v.customerId));
  const fixSet = {};
  fixP.data.forEach(f => { fixSet[f.customerId] = true; });
  const { locCfg, locRefresh, locKeyRefresh, recordingDurationLimit, visitDurationLimit, workStartHour, workEndHour, offDutyTier } = cfgP;
  const enriched = [];
  for (const c of customers) {
    const last = lastMap[c._id] || null;
    enriched.push({
      _id: c._id,
      name: c.name,
      address: c.address,
      lat: c.lat,
      lng: c.lng,
      phone: c.phone,
      phone2: c.phone2 || '',
      contactName: c.contactName,
      customerType: c.customerType,
      mallJoinedAt: c.mallJoinedAt,
      mallAddedAt: c.mallAddedAt,
      lastOrderAt: c.lastOrderAt,
      lastBrowseAt: c.lastBrowseAt,
      mallSalesman: c.mallSalesman,
      mallLevel: c.mallLevel,
      remark: c.remark,
      coordFixPending: !!fixSet[c._id],
      visitedToday: !!last,
      visitOngoing: ongSet.has(c._id),
      lastVisit: last ? { visitedAt: last.visitedAt, result: last.result, salesmanName: last.salesmanName } : null
    });
  }

  return {
    ok: true,
    task: {
      _id: t._id,
      name: t.name,
      taskNo: t.taskNo || '',
      purpose: t.purpose,
      deadline: t.deadline,
      plannedDays: t.plannedDays,
      dayPlan: t.dayPlan || [],
      status: t.status,
      expired: t.status === 'published' && t.deadline && String(t.deadline) <= todayStr(),
      startDate: t.startDate || '',
      createdAt: t.createdAt || null,
      todayDay: dayIndexOf(t.startDate, t.createdAt),
      // 老板模式（2026-09-09 §7.13）：任务归属显示
      salesmanId: isBoss ? (t.salesmanId || '') : undefined,
      salesmanName: isBoss ? (t.salesmanName || '') : undefined,
      locCheck: { enabled: !!(locCfg && locCfg.enabled), threshold: Number((locCfg && locCfg.threshold) || 0) },
      locRefresh,
      locKeyRefresh,
      recordingDurationLimit,
      visitDurationLimit,
      workStartHour, workEndHour, offDutyTier,
      // 2026-09-11 降频与开关类下发（手机端 loc.js / 拜访页 / app.js 读取；默认值口径同 adminapi.getSettings）
      locTrackEnabled: cfgP.locTrackEnabled, locLatestEnabled: cfgP.locLatestEnabled,
      locWorkTier: cfgP.locWorkTier, locMoveThreshold: cfgP.locMoveThreshold,
      photoLimit: cfgP.photoLimit, recEnabled: cfgP.recEnabled, evidenceRequired: cfgP.evidenceRequired,
      coordFixEnabled: cfgP.coordFixEnabled, reviewWatchEnabled: cfgP.reviewWatchEnabled,
      salesmanScope: cfgP.salesmanScope, phoneVisibility: cfgP.phoneVisibility,
      aboutToVisit: enriched.filter(c => !c.visitedToday).length
    },
    customers: enriched
  };
}

// 东八区今日日期 YYYY-MM-DD
function todayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 2026-09-09 提速（B 方案）：地图专用轻量接口——一次请求返回地图渲染所需全部精简数据
// 业务员（无 taskId）=自己第一个进行中任务；老板（无 taskId）=全量任务摘要（下拉用）+第一个任务地图
// 裁剪：只带地图/拜访跳转字段，砍掉 enriched 全字段/坐标审核/6 次串行 settings（改并行辅助）
async function mapData(salesmanId, taskId, isBoss) {
  const today = todayStr();
  let tasksOut;
  let t = null;
  if (taskId) {
    const tRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
    t = tRes && tRes.data;
    if (!t || (t.salesmanId !== salesmanId && !isBoss)) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  } else if (isBoss) {
    const lRes = await db.collection('tasks').where({ status: _.in(['published', 'reviewing']) }).orderBy('createdAt', 'desc').limit(50).get();
    tasksOut = lRes.data.map(x => ({
      _id: x._id, name: x.name, salesmanName: x.salesmanName || '', salesmanId: x.salesmanId || '', status: x.status
    }));
    t = lRes.data[0] || null;
    if (!t) return { ok: true, tasks: tasksOut, map: null };
  } else {
    const lRes = await db.collection('tasks').where({ salesmanId, status: _.in(['published', 'reviewing']) }).orderBy('createdAt', 'desc').limit(10).get();
    t = lRes.data[0] || null;
    if (!t) return { ok: true, map: null };
  }
  const tid = t._id;
  const ids = t.customerIds || [];
  // 三路并行：客户 / 拜访状态 / 系统配置
  const [cRes, lastMap, ongP, cfgP] = await Promise.all([
    ids.length ? db.collection('customers').where({ _id: _.in(ids) }).get() : Promise.resolve({ data: [] }),
    lastVisitMap(tid, ids),
    ids.length ? db.collection('visits')
      .where({ taskId: tid, customerId: _.in(ids), status: 'ongoing', visitedAt: today })
      .field({ customerId: true }).limit(100).get() : Promise.resolve({ data: [] }),
    loadSettings()
  ]);
  const cMap = {};
  cRes.data.forEach(c => { cMap[c._id] = c; });
  const ongSet = new Set();
  ongP.data.forEach(v => ongSet.add(v.customerId));
  const customers = ids.filter(id => cMap[id]).map(id => {
    const c = cMap[id];
    return {
      _id: c._id, name: c.name, address: c.address, lat: c.lat, lng: c.lng, phone: c.phone,
      visitedToday: !!lastMap[c._id], visitOngoing: ongSet.has(c._id)
    };
  });
  const task = {
    _id: t._id, name: t.name, status: t.status, todayDay: dayIndexOf(t.startDate, t.createdAt),
    dayPlan: t.dayPlan || [],
    locCheck: { enabled: !!(cfgP.locCfg && cfgP.locCfg.enabled), threshold: Number((cfgP.locCfg && cfgP.locCfg.threshold) || 0) },
    locRefresh: cfgP.locRefresh, locKeyRefresh: cfgP.locKeyRefresh,
    recordingDurationLimit: cfgP.recordingDurationLimit, visitDurationLimit: cfgP.visitDurationLimit,
    workStartHour: cfgP.workStartHour, workEndHour: cfgP.workEndHour, offDutyTier: cfgP.offDutyTier,
    // 2026-09-11 降频与开关类（地图页也用到轨迹配置；其余开关供手机端各页读取）
    locTrackEnabled: cfgP.locTrackEnabled, locLatestEnabled: cfgP.locLatestEnabled,
    locWorkTier: cfgP.locWorkTier, locMoveThreshold: cfgP.locMoveThreshold,
    photoLimit: cfgP.photoLimit, recEnabled: cfgP.recEnabled, evidenceRequired: cfgP.evidenceRequired,
    coordFixEnabled: cfgP.coordFixEnabled, reviewWatchEnabled: cfgP.reviewWatchEnabled,
    salesmanScope: cfgP.salesmanScope, phoneVisibility: cfgP.phoneVisibility
  };
  return { ok: true, tasks: tasksOut, map: { task, customers } };
}

// ================= 手机端：以我的位置重排当天未完成客户（2026-09-08 老板拍板） =================
// 口径：只重排当天「未完成且非拜访中」的客户；已完成/拜访中保持原相对位置；
// 结果写回任务 dayPlan（顺序+真实路线），老板后台同步可见；logs 留痕。
async function replanDay(salesmanId, event, isBoss) {
  const { taskId, day, origin, customerIds } = event || {};
  if (!taskId || !day || !origin || !origin.lat || !origin.lng) {
    return { ok: false, code: 'BAD_ARG', msg: '缺少任务/天/定位参数' };
  }
  if (!Array.isArray(customerIds) || customerIds.length < 2) {
    return { ok: false, code: 'BAD_ARG', msg: '当天未完成客户不足 2 家，无需重排' };
  }
  const tRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const t = tRes && tRes.data;
  if (!t || (t.salesmanId !== salesmanId && !isBoss)) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status !== 'published') return { ok: false, code: 'STATE', msg: '仅进行中任务可重排' };
  if (t.deadline && String(t.deadline) <= todayStr()) {
    return { ok: false, code: 'TASK_EXPIRED', msg: '任务已过期，请联系管理员延期' };
  }

  // 参与重排客户坐标
  const cRes = await db.collection('customers').where({ _id: _.in(customerIds) }).get();
  const cmap = {};
  cRes.data.forEach(c => { cmap[c._id] = c; });
  const todo = customerIds.map(id => cmap[id]).filter(Boolean);
  const withCoord = todo.filter(c => c && c.lat && c.lng);
  const noCoord = todo.filter(c => !(c && c.lat && c.lng));

  const dist = (a, b) => haversine(a.lat, a.lng, b.lat, b.lng);
  let newOrder = [], dm = 0, durationMin = null, pts = null, fallback = false;

  if (withCoord.length >= 2) {
    // 第 1 层：贪心候选（起手店=离我最近的前 3 家，逐点最近邻）
    const byOrigin = [...withCoord].sort((a, b) => dist(origin, a) - dist(origin, b));
    const startPool = byOrigin.slice(0, Math.min(3, byOrigin.length));
    const candidates = [];
    for (const first of startPool) {
      const ord = [first];
      let cur = first;
      const pool = withCoord.filter(c => c !== first);
      while (pool.length) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const d = dist(cur, pool[i]);
          if (d < bd) { bd = d; bi = i; }
        }
        cur = pool[bi];
        ord.push(cur);
        pool.splice(bi, 1);
      }
      candidates.push(ord);
    }
    // 第 2 层：腾讯 **walking（步行）** 验真 —— ⚠️ walking 不支持途经点（见 walkSegmentsTx），逐段调用再累加。
    //   3 个候选逐个算（串行）+ 总预算 4.5 秒（这条调用走 HTTP API，等待上限只有 ~4~5 秒）；
    //   预算用尽 → 用已算出的最优候选（一个都没算完 → 下面的直线兜底）。
    const segCache = {};   // 本次重排内"同一段"共享结果（候选之间常有重复段，省调用）
    const DEADLINE = Date.now() + 4500;
    let best = null;
    for (const ord of candidates) {
      if (Date.now() > DEADLINE) break;
      const r = await walkSegmentsTx(origin, ord, Math.max(600, DEADLINE - Date.now()), segCache);
      if (r && (!best || r.distanceMeters < best.distanceMeters)) {
        best = { order: ord.map(c => c._id), distanceMeters: r.distanceMeters, durationMin: r.durationMin, pts: r.pts };
      }
    }
    if (best) {
      newOrder = best.order;
      dm = best.distanceMeters;
      durationMin = best.durationMin;
      pts = (Array.isArray(best.pts) && best.pts.length >= 2) ? best.pts : null;   // ⭐ walking 逐段合并后的绝对坐标
      if (!pts || pts.length < 2) pts = fallbackPts(origin, withCoord, best.order); // 无轨迹直线兜底
    } else {
      newOrder = candidates[0].map(c => c._id);
      dm = Math.round(candidates[0].reduce((s, c, i, a) => i ? s + dist(a[i - 1], c) : s, 0));
      pts = fallbackPts(origin, withCoord, newOrder);
      fallback = true;
    }
  } else if (withCoord.length === 1) {
    newOrder = [withCoord[0]._id];
    dm = Math.round(dist(origin, withCoord[0]));
    pts = null;
  }
  newOrder = newOrder.concat(noCoord.map(c => c._id)); // 无坐标垫后
  if (!newOrder.length) return { ok: false, code: 'BAD_ARG', msg: '没有可重排的客户' };
  // 老板模式（2026-09-09 §7.13）：只算不存——返回重排结果供页面演示，不写 dayPlan/不留痕
  if (isBoss) {
    return {
      ok: true, boss: true, distanceMeters: dm, durationMin, fallback,
      msg: fallback ? '已按你的位置重排（路线接口不可用，直线估算）（演示：未保存）' : '已按你的位置重排（演示：未保存）'
    };
  }

  // 写回 dayPlan：已完成/拜访中保持原相对位置在前，未完成按新序
  const pl = (t.dayPlan || []).find(p => p.day === Number(day));
  const planIds = (pl && Array.isArray(pl.customerIds)) ? pl.customerIds : (t.customerIds || []);
  const doneSet = await visitedSet(taskId, planIds, ['normal', 'pending_review']);
  const ongSet = await visitedSet(taskId, planIds, ['ongoing']);
  const todoSet = new Set(customerIds);
  const rest = planIds.filter(id => !todoSet.has(id) || doneSet.has(id) || ongSet.has(id));
  const newIds = rest.concat(newOrder.filter(id => !doneSet.has(id) && !ongSet.has(id)));

  const dayPlan = (t.dayPlan || []).map(p =>
    p.day === Number(day) ? { ...p, customerIds: newIds, route: pts ? { pts, distanceMeters: dm, durationMin } : (p.route || null) } : p
  );
  // 同步任务全序 customerIds：当天客户按新序重新排位，其他天客户相对位置不动（后台任务详情行序一致）
  const daySet = new Set(planIds);
  let fill = 0;
  const fullIds = (t.customerIds || []).map(id => daySet.has(id) ? newIds[fill++] : id);
  const now = Date.now();
  const logs = [...(Array.isArray(t.logs) ? t.logs : []), {
    at: now, by: t.salesmanName || '业务员', role: 'salesman', type: 'replan',
    detail: { day: Number(day), distanceMeters: dm, fallback }
  }];
  await db.collection('tasks').doc(taskId).update({ data: { dayPlan, customerIds: fullIds, logs } });
  return {
    ok: true, distanceMeters: dm, durationMin, fallback,
    msg: fallback ? '已按你的位置重排（路线接口不可用，直线估算）' : '已按你的位置重排'
  };
}

// 任务内某批客户的状态集合（按状态）——分页防超时
async function visitedSet(taskId, ids, statuses) {
  const set = new Set();
  if (!ids.length) return set;
  let skip = 0;
  const PAGE = 100;
  while (true) {
    const r = await db.collection('visits')
      .where({ taskId, customerId: _.in(ids), status: _.in(statuses) })
      .field({ customerId: true })
      .skip(skip).limit(PAGE).get();
    r.data.forEach(v => set.add(v.customerId));
    if (r.data.length < PAGE) break;
    skip += PAGE;
  }
  return set;
}

// 腾讯 **WebServiceAPI** key（云函数服务端调用专用；后台可配）
// ⭐⭐ 2026-10-07 重要：**不能复用后台地图那个 key**！`admin.html` 用的 `SQWBZ-…-S7F2D` 是
//   「Web 端(JS API)」类型 —— 腾讯对这类 key 的**服务端调用一律回 `status:111 签名验证失败`**，
//   换任何 SK、任何签名写法都没用（2026-10-07 拿真 key 把 8 种签名写法全试过，全 111）。
//   → 必须**另建一个「WebServiceAPI」类型的 key**，存 `settings.mpWSKey`；
//     若那个 key 开了「签名校验」，再把签名密钥存 `settings.mpSK`（见下面 txUrl / txSign）。
//   ⚠️ 没配 `mpWSKey` 时退回旧的 `mpKey`（老行为：接口失败 → 直线兜底，页面照常能用）。
async function getMpKey() {
  for (const k of ['mpWSKey', 'mpKey']) {
    const res = await db.collection('settings').where({ key: k }).limit(1).get().catch(() => ({ data: [] }));
    const v = String((res.data[0] && res.data[0].value) || '').trim();
    if (v) return v;
  }
  return 'SQWBZ-K326U-MU3VH-GWUHA-HGNES-S7F2D';
}

// 腾讯 WebServiceAPI 的**签名密钥 SK**（该 key 开了「签名校验」才需要；没配则返回空 = 不签名）
async function getMpSK() {
  const res = await db.collection('settings').where({ key: 'mpSK' }).limit(1).get().catch(() => ({ data: [] }));
  return String((res.data[0] && res.data[0].value) || '').trim();
}

// 腾讯 WebServiceAPI 的 **SN 签名**（官方文档：lbs.qq.com/faq/serverFaq/webServiceKey）
//   规则：`md5( 请求路径 + '?' + 参数按「参数名」升序拼接 + SK )`
//   ⚠️ 参数值用**原文**、不要 URL 编码；`output` 这类参数**也要算进**签名串里。
function txSign(path, qs, sk) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(path + '?' + qs + sk, 'utf8').digest('hex');
}

// 拼一条腾讯 WebServiceAPI 请求地址：参数**按参数名升序**（腾讯签名要求）+ 需要时附 `sig`
//   入参：path（如 '/ws/direction/v1/walking/'）、params（对象，值用**原文**，别预先编码）
//   ⚠️ 以后所有"云函数调腾讯接口"的地方都走这里，别再手拼 —— 手拼必漏签名（2026-10-07 踩过）。
// ⭐⭐ 2026-10-10 实测更正（老板定：**清掉签名，统一成"直接带 key"**）：
//   **`mpWSKey` 这个 key 没开签名校验 —— 直接带 key 就能用**
//   （curl 实测：`{"status":0,"result":{"routes":[{"distance":1525,"polyline":[…]}]}}` ✅）
//   ⚠️ 反过来，设置里一旦填了 `mpSK`，这里就**会**加 `sig` —— 而服务器并不认这个签名 → **反而被拒（111）**。
//   ✅ 所以**一律不签名**。`txSign` / `getMpSK` 作为死代码保留（万一以后换成开了签名校验的 key，
//      把下面那行 `// if (sk) …` 放开即可）。
async function txUrl(path, params) {
  const key = await getMpKey();
  const p = Object.assign({}, params, { key: key, output: 'json' });
  const qs = Object.keys(p).sort().map(k => k + '=' + p[k]).join('&');
  // const sk = await getMpSK();                       // ⚠️ 需要签名校验的 key 才放开
  // if (sk) return 'https://apis.map.qq.com' + path + '?' + qs + '&sig=' + txSign(path, qs, sk);
  return 'https://apis.map.qq.com' + path + '?' + qs;
}

// 通用 HTTPS GET JSON（腾讯地图等公网接口；Referer 需匹配 key 白名单）
function httpGetJson(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Referer: 'https://localhost/' } }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('接口返回非 JSON')); }
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 腾讯 driving polyline 差分解压：[lat0, lng0, dlat1, dlng1...]，差分单位 1e-6 度（纬度在前，与后台 nt-map.js 一致）
function decodePolyline(pl) {
  const pts = [];
  if (!Array.isArray(pl) || pl.length < 2) return pts;
  let lat = pl[0], lng = pl[1];
  pts.push([lat, lng]);
  for (let i = 2; i + 1 < pl.length; i += 2) {
    lat += pl[i] / 1e6;
    lng += pl[i + 1] / 1e6;
    pts.push([lat, lng]);
  }
  return pts;
}

// ⭐⭐ 2026-10-10 晚（老板定）：**手机端「重排」也改走【步行】算路** —— 与后台"智能/手动规划"同一口径
//   （业务员是走路的；原来用 driving 驾车 —— 距离偏长，时长还把"分钟"当"秒"处理）。
//   ⚠️⚠️ **腾讯 walking 接口不支持 waypoints（途经点）**（实测：带不带返回一模一样，被静默忽略）
//      → 「我的位置→店1→店2→…→店N」必须**逐段调用再累加**（本函数）。
//   ⚠️ **duration 单位是【分钟】**（实测同 driving）—— 老代码 `Math.round(route.duration / 60)` 是当秒处理 → 恒 1 分钟（已修）。
function encodePolyline(pts) {   // 保留（adminapi 侧多段合并要回写压缩格式）；tasks 侧直接用 pts
  if (!pts || !pts.length) return null;
  const out = [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length; i++) {
    out.push(Math.round((pts[i][0] - pts[i - 1][0]) * 1e6));
    out.push(Math.round((pts[i][1] - pts[i - 1][1]) * 1e6));
  }
  return out;
}
// 轻量并发池（tasks 里没有 runPool）：把 items 的索引分给若干 worker 轮流跑
async function poolEach(items, size, fn) {
  let i = 0;
  const n = Math.min(Math.max(Number(size) || 1, 1), items.length);
  await Promise.all(new Array(n).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}
// 步行逐段算路：我的位置 → 店1 → … → 店N；返回 { distanceMeters, durationMin, pts(绝对坐标) } 或 null（失败/超预算）
async function walkSegmentsTx(origin, ordered, budgetMs, segCache) {
  const pts = [{ lat: origin.lat, lng: origin.lng }].concat(ordered.map(c => ({ lat: c.lat, lng: c.lng })));
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  if (!segs.length) return null;
  const cache = segCache || {};
  const t0 = Date.now();
  const out = new Array(segs.length).fill(null);
  let failed = false;
  await poolEach(segs.map((s, i) => i), 5, async (idx) => {
    if (failed || Date.now() - t0 > budgetMs) { failed = true; return; }
    const s = segs[idx];
    const ck = s[0].lat + ',' + s[0].lng + ';' + s[1].lat + ',' + s[1].lng;
    if (cache[ck]) { out[idx] = cache[ck]; return; }
    try {
      const u = await txUrl('/ws/direction/v1/walking/', { from: `${s[0].lat},${s[0].lng}`, to: `${s[1].lat},${s[1].lng}` });
      let r = await httpGetJson(u);
      if (!(r && r.status === 0 && r.result && r.result.routes && r.result.routes.length)) {
        await new Promise(z => setTimeout(z, 350));       // 可能是瞬时配额，退一步重试一次
        r = await httpGetJson(u);
      }
      if (r && r.status === 0 && r.result && r.result.routes && r.result.routes.length) {
        const rt = r.result.routes[0];
        const seg = { d: Math.round(rt.distance || 0), m: Math.max(1, Math.round(rt.duration || 1)), pl: rt.polyline || null };
        cache[ck] = seg; out[idx] = seg;
      } else { failed = true; }
    } catch (e) { failed = true; }
  });
  if (failed || out.some(x => !x)) return null;
  let d = 0, m = 0;
  const allPts = [];
  for (const s of out) {
    d += s.d || 0; m += s.m || 0;
    const p = decodePolyline(s.pl);
    for (const q of p) {
      const last = allPts[allPts.length - 1];
      if (last && Math.abs(last[0] - q[0]) < 1e-9 && Math.abs(last[1] - q[1]) < 1e-9) continue;   // 衔接重复点
      allPts.push(q);
    }
  }
  return { distanceMeters: d, durationMin: Math.max(1, m), pts: allPts.length >= 2 ? allPts : null };
}

// 直线兜底折线：起点=我的位置 → 按新序逐店（[lat,lng]，纬度在前）
function fallbackPts(start, ordered, ids) {
  const map = {};
  ordered.forEach(c => { map[c._id] = c; });
  const pts = [[start.lat, start.lng]];
  ids.forEach(id => { if (map[id]) pts.push([map[id].lat, map[id].lng]); });
  return pts.length >= 2 ? pts : null;
}

// 球面距离（米）——与 adminapi/前端口径一致
// ⭐ 2026-10-03 自由拜访：按「坐标 + 半径」取附近客户点
//   入参：{ lat, lng, radius }（radius 米，档位 200/500/1000/2000）
//   出参：{ ok, radius, center, count, total, truncated, points:[{i,n,nr,la,ln,ad,d,b,ph,ds,cst}] }
//   ⚠️ **返回上限 500 条**（按距离升序取最近的）—— 2 公里内可能有几千家，不封顶会把手机画卡
//   ⚠️ 查询方式与 dupCheck 同源：先用**矩形**在库里粗筛（走 lat/lng 索引），再用 haversine **精筛**成圆
//   ⚠️ 排除已删客户（回收站里的不在图上）
async function nearbyCustomers(salesmanId, event) {
  const lat = Number(event.lat), lng = Number(event.lng);
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
    return { ok: false, code: 'BAD_PARAM', msg: '缺少定位坐标' };
  }
  let radius = Number(event.radius) || 500;
  if (!isFinite(radius) || radius < 50) radius = 50;
  if (radius > 5000) radius = 5000;

  const MAX = 500;      // 最终返回上限（老板 2026-10-04 定：**就是最近 500 家**）
  const PAGE = 100;     // 云开发单次 get 上限就是 100
  // ⚠️⚠️ 2026-10-04【重要修正】原来的做法：一次性矩形粗筛最多 3000 条（**没有排序 → 命中哪 3000 条是随机的**）
  //   → 再按距离排序取 500。结果 **"最近的 500 家"是假的**（探针实测：义乌商贸区 2 公里内有 3279 家，
  //   3000 都捞不完，取出来的其实是"随机 3000 里最近的 500"）。
  //   现在改成 **由近到远分圈查**：200m → 500m → 1km → 2km → …→ 用户选的半径，
  //   每圈查完看够不够，**凑够 MAX×1.5 就停**，最后按距离排序取前 MAX。
  //   这样既**真的按距离由近到远**，又不会一上来就拉几千条（快）。
  const rings = [200, 500, 1000, 2000, 3000, 5000, 10000, 50000].filter(r => r <= radius);
  if (!rings.length || rings[rings.length - 1] < radius) rings.push(radius);

  // ⭐ 2026-10-05 老板要的：**顺手把「现场证据 / 定位」配置一起带回去** ——
  //   自由拜访没有 taskId，进不了「tasks.detail / mapData」那条写 globalData.sysCfg 的路
  //   （见 AGENTS.md 那条"已知取舍"）→ 拜访页会退回默认值。这里搭个顺风车。
  const cfgP = await loadSettings().catch(() => ({}));
  const seen = {};        // 去重（同一家可能在多次查询里都命中）
  const pts = [];
  try {
    for (const rr of rings) {
      const dLat = rr / 111000;
      const dLng = rr / (111000 * Math.cos(lat * Math.PI / 180) || 1);
      for (let sk = 0; sk < 3000; sk += PAGE) {          // 每圈最多拉 3000 条再精筛
        const part = await db.collection('customers')
          .where({
            lat: _.gt(lat - dLat).and(_.lt(lat + dLat)),
            lng: _.gt(lng - dLng).and(_.lt(lng + dLng)),
            deleted: _.neq(true)
          })
          .field({ name: true, nameRaw: true, lat: true, lng: true, address: true,
                   district: true, bizCircle: true, phone: true, coord_status: true })
          .skip(sk).limit(PAGE).get();
        const arr = (part && part.data) || [];
        for (const c of arr) {
          if (seen[c._id]) continue;
          seen[c._id] = 1;
          const d = Math.round(haversine(lat, lng, c.lat, c.lng));
          if (!isFinite(d) || d > radius) continue;      // 精筛成圆（不大于用户选的半径）
          pts.push({
            i: c._id,
            n: String(c.name || ''),
            nr: String(c.nameRaw || ''),
            la: Number(c.lat) || 0,
            ln: Number(c.lng) || 0,
            ad: String(c.address || ''),
            d: String(c.district || ''),
            b: String(c.bizCircle || ''),
            ph: String(c.phone || ''),
            ds: d,                                        // 距我多少米
            cst: String(c.coord_status || '')
          });
        }
        if (arr.length < PAGE) break;                     // 这圈取完了
        if (pts.length >= MAX * 3) break;                 // 已经够多了，别再拉
      }
      if (pts.length >= MAX * 1.5) break;                 // ⭐ 凑够 1.5 倍就停，不必查到最外圈
    }
  } catch (e) {
    return { ok: false, code: 'QUERY_FAIL', msg: '附近查询失败：' + ((e && e.message) || e) };
  }

  pts.sort((a, b) => a.ds - b.ds);                        // 由近到远
  return {
    ok: true,
    radius: radius,
    center: { lat: lat, lng: lng },
    count: Math.min(pts.length, MAX),
    total: pts.length,
    truncated: pts.length > MAX,
    // ⭐ 现场证据 / 定位配置（前端拿去写 globalData.sysCfg，自由拜访的拜访页才能跟后台档位走）
    cfg: {
      photoLimit: cfgP.photoLimit,
      recEnabled: cfgP.recEnabled,
      evidenceRequired: cfgP.evidenceRequired,
      recordingDurationLimit: cfgP.recordingDurationLimit,
      visitDurationLimit: cfgP.visitDurationLimit,
      locKeyRefresh: cfgP.locKeyRefresh,
      locCheck: cfgP.locCheck
    },
    points: pts.slice(0, MAX)
  };
}

// ═══════════════════════════════════════════════════════════════════
// ⭐ 2026-10-03 自由拜访卡（独立集合 `free_trips`）
//   老板口径（详见 _scratch/自由拜访-方案与口径.md）：
//   · 业务员自己建、**不绑任务**、**没有目标客户名单**、**不算进度**、**没有截止日**
//   · 卡片上的「已拜访 N 家」= `customerIds` 数组长度（**去重**：同一家跑几次都算 1 家）
//   · `customerIds` 一字段三用：①家数 ②点进去看客户卡片 ③地图上灰针（去过）的判断
//   · 能结束（paused）也能唤醒（active）；⚠️ 新拜访只进「最新建的那张**在用**卡」
//   · ⚠️ 实习（trial）**能看不能建**（与项目既有「实习不能提交」一致）
// ═══════════════════════════════════════════════════════════════════
const FREE_TRIP_MAX = 50;   // 单个业务员最多保留这么多张（防数据无限膨胀）

function _tripOut(t) {
  return {
    id: t._id,
    salesmanId: t.salesmanId || '',
    salesmanName: t.salesmanName || '',
    district: t.district || '',
    bizCircle: t.bizCircle || '',
    radius: Number(t.radius) || 0,
    lat: Number(t.centerLat) || 0,
    lng: Number(t.centerLng) || 0,
    status: t.status || 'active',
    visitedCount: Array.isArray(t.customerIds) ? t.customerIds.length : 0,
    createdAt: Number(t.createdAt) || 0,
    updatedAt: Number(t.updatedAt) || 0,
    pausedAt: Number(t.pausedAt) || 0
  };
}

// 用坐标反查「区域 / 商圈」：取附近最近几家客户的众数（前端没传时的兜底）
async function _guessArea(lat, lng) {
  const out = { district: '', bizCircle: '' };
  try {
    const d = 300 / 111000;
    const r = await db.collection('customers')
      .where({ lat: _.gt(lat - d).and(_.lt(lat + d)), lng: _.gt(lng - d).and(_.lt(lng + d)),
               deleted: _.neq(true) })
      .field({ district: true, bizCircle: true, lat: true, lng: true })
      .limit(100).get();
    const rows = (r.data || []).slice().sort((a, b) =>
      haversine(lat, lng, a.lat, a.lng) - haversine(lat, lng, b.lat, b.lng));
    const cnt = (key) => {
      const m = {};
      rows.forEach(x => { const v = String(x[key] || '').trim(); if (v) m[v] = (m[v] || 0) + 1; });
      let best = '', n = 0;
      Object.keys(m).forEach(k => { if (m[k] > n) { n = m[k]; best = k; } });
      return best;
    };
    out.district = cnt('district');
    out.bizCircle = cnt('bizCircle');
  } catch (e) { /* 反查失败就不填，不阻塞建卡 */ }
  return out;
}

// 建卡
async function freeTripCreate(salesmanId, meDoc, event) {
  if (meDoc && meDoc.trial === true) return { ok: false, code: 'TRIAL_FORBIDDEN', msg: '实习体验不能建自由拜访卡' };
  const lat = Number(event.lat), lng = Number(event.lng);
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
    return { ok: false, code: 'BAD_PARAM', msg: '缺少定位坐标' };
  }
  const cnt = await db.collection('free_trips').where({ salesmanId: salesmanId }).count()
    .catch(() => ({ total: 0 }));
  if ((cnt.total || 0) >= FREE_TRIP_MAX) {
    return { ok: false, code: 'TOO_MANY', msg: '自由拜访卡已有 ' + FREE_TRIP_MAX + ' 张，先在后台清理一些再建' };
  }
  let district = String(event.district || '').trim();
  let bizCircle = String(event.bizCircle || '').trim();
  if (!district && !bizCircle) {
    const g = await _guessArea(lat, lng);
    district = g.district; bizCircle = g.bizCircle;
  }
  const now = Date.now();
  const doc = {
    salesmanId: salesmanId,
    salesmanName: (meDoc && meDoc.name) || '',
    centerLat: lat,
    centerLng: lng,
    district: district,
    bizCircle: bizCircle,
    radius: Math.min(Math.max(Number(event.radius) || 500, 50), 5000),
    customerIds: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    pausedAt: 0,
    createdByName: (meDoc && meDoc.name) || ''
  };
  let r;
  try {
    r = await db.collection('free_trips').add({ data: doc });
  } catch (e) {
    // ⚠️⚠️ 2026-10-04【老板真机实测踩到】集合还不存在时（`init` 没跑过一次）`.add()` 会抛，
    //   原来没接住 → 前端把**一整段英文异常**弹给了业务员（"点击建卡弹一堆英文报错"）。
    //   现在：**云端自愈创建一次再重试**（不指望用户先跑 init）。
    const em = String((e && e.message) || e) + ' ' + String((e && e.errCode) || '');
    if (em.indexOf('not exists') >= 0 || em.indexOf('-502005') >= 0) {
      await db.createCollection('free_trips').catch(() => {});
      await new Promise(res => setTimeout(res, 600));   // 建表后稍等一下再写
      r = await db.collection('free_trips').add({ data: doc });
    } else {
      return { ok: false, code: 'DB_FAIL', msg: '建卡失败，请稍后再试' };
    }
  }
  const id = (r && (r._id || (r.id))) || '';
  await _logTrip('create', Object.assign({ _id: id }, doc), meDoc, { visitedCount: 0 });   // ⭐ 进后台滚动消息
  return { ok: true, id: id, trip: _tripOut(Object.assign({ _id: id }, doc)) };
}

// 列自己的卡（最新在前）
async function freeTripList(salesmanId, meDoc, event) {
  const limit = Math.min(Math.max(Number(event.limit) || 50, 1), 100);
  const r = await db.collection('free_trips')
    .where({ salesmanId: salesmanId })
    .orderBy('createdAt', 'desc').limit(limit).get()
    .catch(silentCatch('tasks·freeTripList', { data: [] }));
  const list = (r.data || []).map(_tripOut);
  const activeCnt = list.filter(t => t.status === 'active').length;
  return { ok: true, count: list.length, activeCount: activeCnt, list: list };
}

// 结束 / 唤醒（只动 status，不碰客户与拜访）
async function freeTripSetStatus(salesmanId, meDoc, event, status) {
  const id = String(event.tripId || event.id || '');
  if (!id) return { ok: false, code: 'BAD_PARAM', msg: '缺少 tripId' };
  const r = await db.collection('free_trips').doc(id).get().catch(() => ({ data: [] }));
  const t = (r.data && r.data[0]) || (r.data && !Array.isArray(r.data) ? r.data : null);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '自由拜访卡不存在' };
  if (t.salesmanId !== salesmanId) return { ok: false, code: 'NO_AUTH', msg: '只能操作自己的自由拜访卡' };
  const now = Date.now();
  const upd = { status: status, updatedAt: now, pausedAt: status === 'paused' ? now : 0 };
  await db.collection('free_trips').doc(id).update({ data: upd });
  await _logTrip(status === 'paused' ? 'pause' : 'resume', t, meDoc, { visitedCount: Array.isArray(t.customerIds) ? t.customerIds.length : 0 });   // ⭐ 进后台滚动消息
  return { ok: true, id: id, status: status };
}

// 卡片详情：卡的字段 + 「去过的店」列表（去重，按最后拜访时间倒序）
async function freeTripDetail(salesmanId, meDoc, event) {
  const id = String(event.tripId || event.id || '');
  if (!id) return { ok: false, code: 'BAD_PARAM', msg: '缺少 tripId' };
  const r = await db.collection('free_trips').doc(id).get().catch(() => ({ data: [] }));
  const t = (r.data && r.data[0]) || (r.data && !Array.isArray(r.data) ? r.data : null);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '自由拜访卡不存在' };
  if (t.salesmanId !== salesmanId && !meDoc.boss) {
    return { ok: false, code: 'NO_AUTH', msg: '只能看自己的自由拜访卡' };
  }
  const ids = Array.isArray(t.customerIds) ? t.customerIds.filter(Boolean) : [];
  let custs = [];
  if (ids.length) {
    // ⚠️ 分片查（云开发 where in 单次别塞太多）
    for (let i = 0; i < ids.length; i += 100) {
      const part = await db.collection('customers')
        .where({ _id: _.in(ids.slice(i, i + 100)) })
        .field({ name: true, nameRaw: true, address: true, district: true, bizCircle: true,
                 phone: true, lat: true, lng: true, coord_status: true, deleted: true })
        .get().catch(silentCatch('tasks·freeTripDetail', { data: [] }));
      for (const c of (part.data || [])) custs.push(c);
    }
    // ⚠️ 客户可能已被删进回收站 → 自动跳过、不报错
    custs = custs.filter(c => c.deleted !== true);
  }
  return {
    ok: true,
    trip: _tripOut(t),
    customers: custs.map(c => ({
      id: c._id,
      name: c.name || '',
      nameRaw: c.nameRaw || '',
      address: c.address || '',
      district: c.district || '',
      bizCircle: c.bizCircle || '',
      phone: c.phone || '',
      lat: Number(c.lat) || 0,
      lng: Number(c.lng) || 0,
      coordStatus: c.coord_status || ''
    }))
  };
}

// ⭐ 2026-10-04 自由拜访「大操作」留痕 —— 供后台「📬 消息中心 → 📜 滚动消息」显示
//   （老板要："这些大的操作后台的滚动消息要有提示"）
//   记：建卡 / 结束 / 唤醒 / 删除 四类。⚠️ 日志**独立于卡片** —— 卡删了日志还在（老板要能回溯）。
//   ⚠️ 写日志失败**绝不影响主操作**（全部 catch 吞掉）。
async function _logTrip(action, t, meDoc, extra) {
  try {
    await db.collection('free_trip_logs').add({
      data: {
        tripId: (t && t._id) || '',
        action: action,                                   // create | pause | resume | delete
        salesmanId: (t && t.salesmanId) || (meDoc && meDoc._id) || '',
        salesmanName: (t && t.salesmanName) || (meDoc && meDoc.name) || '',
        district: (t && t.district) || '',
        bizCircle: (t && t.bizCircle) || '',
        visitedCount: (extra && extra.visitedCount) || 0,
        lat: (t && t.centerLat) || 0,
        lng: (t && t.centerLng) || 0,
        at: Date.now()
      }
    });
  } catch (e) {
    // ⚠️ 集合不存在时自愈一次（同 freeTripCreate 的处理）
    const em = String((e && e.message) || e) + ' ' + String((e && e.errCode) || '');
    if (em.indexOf('not exists') >= 0 || em.indexOf('-502005') >= 0) {
      await db.createCollection('free_trip_logs').catch(() => {});
    }
  }
}

// ⭐ 2026-10-04 业务员删自己的自由拜访卡（老板要的「结束旁边加删除」）
//   ⚠️ 与后台删除**同口径**：只删「归类」—— 把该卡下所有 visits 的 freeTripId 置空
//      （退化成「无任务拜访」），**拜访记录本身一条不删**。
async function freeTripDelete(salesmanId, meDoc, event) {
  const id = String(event.tripId || event.id || '');
  if (!id) return { ok: false, code: 'BAD_PARAM', msg: '缺少 tripId' };
  const r = await db.collection('free_trips').doc(id).get().catch(() => ({ data: [] }));
  const t = (r.data && r.data[0]) || (r.data && !Array.isArray(r.data) ? r.data : null);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '自由拜访卡不存在' };
  if (t.salesmanId !== salesmanId) return { ok: false, code: 'NO_AUTH', msg: '只能删除自己的自由拜访卡' };
  // 摘归属（批量，别逐条 —— 卡里可能跑了几十家）
  await db.collection('visits').where({ freeTripId: id }).update({ data: { freeTripId: '' } }).catch(() => {});
  await _logTrip('delete', t, meDoc, { visitedCount: Array.isArray(t.customerIds) ? t.customerIds.length : 0 });   // ⭐ 卡删了、日志还在
  await db.collection('free_trips').doc(id).remove();
  return { ok: true, id: id, msg: '已删除（拜访记录保留）' };
}

// ⭐ 2026-10-04 步行路线（我 → 某家店）—— 供「自由拜访」客户小窗的「🧭 路径」按钮
//   老板要的是**真实道路**路线（不是两点直线）。复用项目现成的三件套：
//   `getMpKey()` 取 key + `httpGetJson` 请求 + `decodePolyline` 解压轨迹。
//   ⚠️ **云函数调腾讯接口不受小程序域名白名单限制**（任务地图 / 后台的路线也是这么调的），
//      所以**不需要去微信后台配 request 域名**。
//   ⚠️ 用 `walking`（步行）而不是任务地图那个 `driving`（驾车）—— 业务员是走路的。
//   ⚠️ 腾讯接口失败时**返回直线兜底**（前端照样能画，不至于"点了没反应"）。
const WALK_PATH = '/ws/direction/v1/walking/';   // ⚠️ 是**路径**（不是完整 URL）—— 交给 txUrl() 拼
async function walkRoute(salesmanId, event) {
  const fLat = Number(event.fromLat), fLng = Number(event.fromLng);
  const tLat = Number(event.toLat), tLng = Number(event.toLng);
  if (!isFinite(fLat) || !isFinite(fLng) || !isFinite(tLat) || !isFinite(tLng)) {
    return { ok: false, code: 'BAD_PARAM', msg: '缺少起终点坐标' };
  }
  const from = fLat + ',' + fLng, to = tLat + ',' + tLng;
  let pts = null, distance = 0, durationMin = null;
  try {
    // ⭐ 2026-10-07：改走 `txUrl()`（统一拼参 + 需要时附签名）——
    //   原来手拼且**未签名** → 开了签名校验的 key 一律 111 → **路线一直是直线**（老板报的）。
    const r = await httpGetJson(await txUrl(WALK_PATH, { from: from, to: to }));
    if (r && r.status === 0 && r.result && r.result.routes && r.result.routes.length) {
      const route = r.result.routes[0];
      distance = Math.round(route.distance || 0);
      durationMin = Math.max(1, Math.round((route.duration || 0) / 60));
      if (Array.isArray(route.polyline) && route.polyline.length >= 4) pts = decodePolyline(route.polyline);
    }
  } catch (e) { /* 走兜底 */ }
  const fallback = !pts || pts.length < 2;
  if (fallback) pts = [[fLat, fLng], [tLat, tLng]];   // 直线兜底
  return {
    ok: true,
    fallback: fallback,
    pts: pts.map(p => [Number(p[0]), Number(p[1])]),
    distanceMeters: distance || Math.round(haversine(fLat, fLng, tLat, tLng)),
    durationMin: durationMin
  };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ================= 客户详情（2026-09-25：手机端「客户详情页」的数据出口）=================
// 老板定的改造方向：手机端套用 `_scratch/客户详情页-A-手机演示.html` 那套 **7 卡固定骨架**
//（店名卡 + 🏪商城信息 / 📦购买记录 / 📊平台口碑 / 🛎服务与设施 / 📝管理员备注 / 🕑拜访历史），
// 数据全部来自云端真数据。本函数一次给全，减少手机端来回请求。
// 逻辑与 adminapi.getCustomerDetail 一致（后台那版已上线验证过），差别只在权限：
// **登录的业务员即可读**（客户档案本来就全公司共享，大家都要上门拜访）。
async function custDetail(salesmanId, event, isBoss) {
  const customerId = (event && event.customerId) || '';
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const cDoc = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!cDoc || !cDoc.data) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const c = cDoc.data;
  const code = c.mallCode || '';

  // —— ① 订单：**全部拉下来**（"累计 N 单 / 金额合计"要真数；云开发单页上限 1000，分页取）——
  let orders = [];
  if (code) {
    orders = await fetchAllPaged('orders', { customerCode: code },
      { orderNo: true, orderedAt: true, actualAmount: true, orderStatus: true, payMethod: true });
    orders.sort((a, b) => String(b.orderedAt || '').localeCompare(String(a.orderedAt || '')));
  }

  // —— ② 明细：只查**最近 20 单**（与后台口径一致；上百单的明细全拉会拖慢甚至超时）——
  const orderNoList = orders.slice(0, 20).map(o => o.orderNo).filter(Boolean);
  let items = [];
  for (let i = 0; i < orderNoList.length; i += 20) {
    const r = await db.collection('order_items')
      .where({ orderNo: _.in(orderNoList.slice(i, i + 20)) }).limit(500).get().catch(silentCatch('tasks·for', { data: [] }));
    items = items.concat(r.data || []);
  }
  const linesOf = {};   // 单号 → 商品行数
  const byGoods = {};   // 同一商品累计（常买）
  items.forEach(it => {
    if (it.orderNo) linesOf[it.orderNo] = (linesOf[it.orderNo] || 0) + 1;
    const k = it.goodsName || it.goodsCode || '';
    if (!k) return;
    if (!byGoods[k]) byGoods[k] = { name: k, spec: it.spec || '', unit: it.unit || '', qty: 0, amount: 0, times: 0 };
    byGoods[k].qty += Number(it.orderQty) || 0;
    byGoods[k].amount += Number(it.amount) || 0;
    byGoods[k].times += 1;
  });
  const topGoods = Object.keys(byGoods).map(k => byGoods[k]).sort((a, b) => b.qty - a.qty).slice(0, 8);

  // —— ③ 拜访历史（该客户全部，跨任务；带转写文字与现场照片缩略图 fileID）——
  const vRes = await db.collection('visits').where({ customerId })
    .orderBy('createdAt', 'desc').limit(30).get().catch(silentCatch('tasks·for', { data: [] }));
  const visits = (vRes.data || []).map(v => ({
    _id: v._id,
    taskId: v.taskId || '',
    status: v.status || '',
    visitedAt: v.visitedAt || '',
    result: v.result || '',
    duration: Number(v.duration) || 0,
    remark: v.remark || v.text || '',
    salesmanName: v.salesmanName || '',
    audioCount: (Array.isArray(v.audios) && v.audios.length) || (v.audio && v.audio.fileID ? 1 : 0),
    trText: (v.trEdited && v.trEdited.text) || '',
    // ⭐ 2026-09-27：手机端详情页的「拜访历史」要**真播放录音 + 显示样品**
    //   （原来只给 audioCount / trText，前端只能画进度条模拟；这里补 fileID 与时长、样品文本）
    audios: ((Array.isArray(v.audios) && v.audios.length) ? v.audios : ((v.audio && v.audio.fileID) ? [v.audio] : []))
      .map(a => ({ fileID: (a && a.fileID) || '', duration: Number(a && a.duration) || 0 }))
      .filter(a => a.fileID).slice(0, 6),
    samples: String(v.samples || ''),
    thumbs: (v.photos || []).map(p => (p && (p.thumbID || p.fileID)) || (typeof p === 'string' ? p : '')).filter(Boolean).slice(0, 3)
  }));

  // —— ③b 这家客户**是否正处于拜访中** ——
  //   2026-09-25 老板定：详情页底部的「开始拜访」按钮，如果这家正在拜访中 → 变成**蓝色「拜访中」**。
  //   单独查一次（不复用上面那 30 条：ongoing 是"当前状态"，不该受历史条数限制）。
  const ongRes = await db.collection('visits')
    .where({ customerId, status: 'ongoing' }).limit(1).get().catch(silentCatch('tasks·for', { data: [] }));
  const visitOngoing = !!(ongRes.data && ongRes.data.length);

  // —— ④ 管理员备注（新 → 旧）——
  const rmk = await fetchAllPaged('customer_remarks', { customerId }, {});
  rmk.sort((a, b) => (b.at || 0) - (a.at || 0));

  // —— ⑤ 现场提报（待审核：招牌菜 / 设施 / 团购外卖）—— 手机端在对应位置显示「（待审核）」（修正 008）——
  const fr = await db.collection('coord_fix_requests')
    .where({ customerId, status: 'pending', type: 'field' }).limit(50).get().catch(silentCatch('tasks·for', { data: [] }));
  const fieldReports = (fr.data || []).map(f => ({
    _id: f._id, kind: f.kind || '', value: f.value || '', flagName: f.flagName || '', flagTo: !!f.flagTo
  }));

  return {
    ok: true,
    // 这家客户是否正在拜访中（前端据此把底部按钮变成蓝色「拜访中」）
    visitOngoing: visitOngoing,
    // ⭐ 2026-09-27：该客户**待审核的现场提报**（手机端据此显示"待审核"）
    fieldReports: fieldReports,
    // ⚠️ 2026-09-25 检查时加固：**不能把整个文档原样返回给业务员** ——
    //   customers 里混着财务/工商字段（bank/bankAccount/creditLimit/invoiceType/legalPerson/regCapital…）。
    //   虽然**本批 463 家这些字段全是空的**（已扫过全部分片确认），但换批更全的数据就可能有值。
    //   这里按**白名单**挑手机端 7 卡要用的字段（顺带把返回体压小，手机端更快）。
    customer: (() => {
      const KEEP = ['_id', 'name', 'nameRaw', 'mallCode', 'mallKey', 'region', 'address', 'phone', 'phone2',
        'contactName', 'lat', 'lng', 'coord_status', 'coordSource',
        'mallJoinedAt', 'lastOrderAt', 'lastBrowseAt', 'mallSalesman', 'mallLevel', 'mallSource',
        'salesman', 'level', 'orderCount', 'buyFreq', 'avgPrice', 'source', 'mallTags', 'mallCategory', 'mallType',
        'customerType', 'batchIds', 'remark', 'platShopUuid', 'platMatched', 'lastVisitAt', 'createdAt',
        'plat', 'platManual', 'photos', 'remarks',
        // ⭐ 2026-10-07 补：**现场录入（手机端「加新店」）写的顶层字段** ——
        //   原来白名单里没有它们，手机端 7 卡就只能读到"平台侧"那份（plat.*），
        //   于是现场建的店在手机端**看不到品类 / 营业时间 / 服务与设施 / 团购外卖**
        //   （而后台详情页读的是顶层 → 后台看得到。老板报的"后台有、手机没有"就是这个）。
        //   ⚠️ 前端拿到后是"平台优先、现场兜底"，见 pages/customer/customer.js 的 buildD。
        'cat1', 'cat2', 'cat3', 'hours', 'fac', 'flags',
        // ⭐ 2026-10-07 补：**「加新店」建店时录的现场录音**（customers.audios）——
        //   前端（pages/customer）2026-10-03 就把「读取 + 换临时 URL + 播放 + 渲染」全写好了
        //   （buildD 的 d.siteRec、playSiteRec、customer.wxml 的「现场录音」块），
        //   **唯独这里没放 audios** → 数据被白名单滤掉 → 那块永远不显示（老板 2026-10-07 报的）。
        //   ⚠️ 别删：删了手机端就再也听不到建档时录的音（后台读的是同一份字段，不受此处影响）。
        'audios',
        // ⭐ 2026-09-28 晚：现场录入的「待商城建档」标记（手机端据此显示「⏳ 待商城建档」淡色胶囊）
        'mallPending'];
      const o = {};
      KEEP.forEach(k => { if (c[k] !== undefined) o[k] = c[k]; });
      // ⭐ 2026-10-07 老板报障：**「最近下单」以实际订单为准**（与 adminapi.listCustomers 同口径）——
      //   库里存的 `lastOrderAt` 是**商城表导入时的快照**，会滞后于我们自己的销售订单
      //   （实例：吕记鲜饺 —— 购买记录 9/19、商城信息 8/26）→ 手机端不再直接用它。
      //   ⚠️ 本函数上面已经把这个客户的**全部订单**拉下来了（`orders`），取最大日期即可，零额外查询。
      const _lastReal = (() => {
        let m = '';
        (orders || []).forEach(x => { const d = String(x.orderedAt || '').slice(0, 10); if (d > m) m = d; });
        return m;
      })();
      if (_lastReal) o.lastOrderAt = _lastReal;   // 只有"一单都没有"时才回落到库里那个兜底值
      return o;
    })(),
    // 订单摘要 + 最近 20 单（每单带 lines=商品行数，列表里显示"N 品种"）
    orders: orders.slice(0, 20).map(o => ({
      orderNo: o.orderNo, orderedAt: o.orderedAt, actualAmount: o.actualAmount,
      orderStatus: o.orderStatus, payMethod: o.payMethod, lines: linesOf[o.orderNo] || 0
    })),
    // 这 20 单的商品明细（单号 → 商品行）—— 手机端点某一单展开明细要用
    orderItems: (() => {
      const keep = {};
      orders.slice(0, 20).forEach(o => { if (o.orderNo) keep[o.orderNo] = true; });
      const by = {};
      items.forEach(it => {
        if (!it.orderNo || !keep[it.orderNo]) return;
        (by[it.orderNo] = by[it.orderNo] || []).push({
          name: it.goodsName || '', spec: it.spec || '', unit: it.unit || '',
          qty: Number(it.orderQty) || 0, price: it.salePrice != null ? Number(it.salePrice) : null,
          amount: Number(it.amount) || 0, category: it.category || ''
        });
      });
      return by;
    })(),
    orderTotal: orders.length,
    orderAmountSum: orders.reduce((a, o) => a + (Number(o.actualAmount) || 0), 0),
    topGoods,
    visits,
    remarks: rmk.slice(0, 30).map(r => ({ text: r.text || '', at: r.at || 0, by: r.by || '' }))
  };
}

// 分页拉全量（云开发单次 limit 上限 1000）
async function fetchAllPaged(coll, where, field) {
  const out = [];
  let skip = 0;
  while (true) {
    let q = db.collection(coll);
    if (where && typeof where === 'object' && Object.keys(where).length) q = q.where(where);
    if (field && typeof field === 'object' && Object.keys(field).length) q = q.field(field);
    const r = await q.skip(skip).limit(1000).get().catch(silentCatch('tasks·while', { data: [] }));
    out.push(...(r.data || []));
    if (!r.data || r.data.length < 1000) break;
    skip += 1000;
    if (skip > 20000) break;   // 保险：最多 2 万条
  }
  return out;
}
