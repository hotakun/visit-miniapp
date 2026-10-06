// 管理后台 API（HTTP 访问服务入口）
// 鉴权：开发期使用账号+密码逐次校验（sha256 比对），上线前升级为 token 会话
// 模板：服务单提醒 tCQ_Xi5OaMQ9t9-UX9NeEZ4Tv4nHJ-L1PAEVWOdDhxs
// ┌──────────────────────────────────────────────────────────────────────┐
// │ 📖 文件结构索引（2026-09-23 加 —— 为了在 3000+ 行里能快速找到东西）
// └──────────────────────────────────────────────────────────────────────┘
//
// 本文件 = 后台唯一入口（3000+ 行，行数/行号都会随编辑漂移 —— 别背数字）。内容按
// `// ===== 标题 =====` 分成 **22 个域**；action 由 exports.main 用 `if (action === 'xxx')`
// 逐条分发（实现在同域内，多数函数与 action 同名）。
// ⚠️ 本索引块**故意不用 `// =====` 边框** —— 免得被 grep/脚本当成一个"域"。
//
// 【怎么定位（⚠️ 行号会随编辑漂移，不要背行号）】
//   1) 列出全部域：     grep -n "// =====" miniprogram/cloudfunctions/adminapi/index.js
//   2) 找某个 action：  grep -n "'getTask'" miniprogram/cloudfunctions/adminapi/index.js
//      —— 命中处即分发点
//   3) 刷新「域 + action 行号」对照表：python _scratch/gen_adminapi_index.py
//      → 输出 _scratch/_adminapi_index.txt（域分组 + dispatch 全集 + ACTIONS 全集）
//
// 【22 个域（按分节标题，顺序即文件顺序）】
//    1) 云调用用量自建统计        2) 用量告警模板            3) 拜访时长上限·动态闹钟
//    4) 位置监控接口              5) 后台文件分发            6) 任务操作
//    7) 流程流水 logs             8) 服务号模板消息          9) 商城客户列表导入＋三档模糊比对
//   10) 本地比对支持            11) 待确认认领清单         12) 注册审核
//   13) 人员管理                14) 系统设置               15) 降频开关类设置（默认值）
//   16) 模板 ID 不明文回显       17) 降频开关类设置         18) 服务号 OpenID 绑定
//   19) 坐标报错审核            20) 分批可续的数据清理      21) 客户批次管理
//   22) 智能排序
//   （另有 **2 处不在分节里**：文件头正下方的 `saveVisitTrText`，以及 `exports.main` 自身）
//
// 【action 按用途分组（全集见下方 ACTIONS 数组）】
//   登录：login
//   任务：listTasks, getTask, createTask, editTask, rescheduleTask, extendTask,
//         reassignTask, withdrawTask, deleteTask, sendTask, reviewFinishRequest,
//         cancelOngoing, autoArchiveExpired, smartSortDay
//   客户与数据维护：listCustomers, importCustomers, importMallCustomers,
//         updateCustomerRemark, purgeUnbatchedCustomers, resetTestData, wipeData,
//         getTempFileURL, listCustomerVisits, purgeCancelled, purgeCustomerVisits
//   商城库比对与认领：runMallMatch, listMallLibrary, applyMallMatch, listMallClaims,
//         resolveMallClaim, getLastMallImport
//   客户批次：listCustomerBatches, getCustomerBatchInfo, renameCustomerBatch,
//         deleteCustomerBatch, createManualBatch, archiveInitialBatch,
//         removeCustomerFromBatch, addCustomersToBatch
//   审核：listRegistrations, reviewRegistration, listCoordFixes, reviewCoordFix
//   位置监控：listLatestLocations, getDayTrack, getVisitTrack
//   人员与设置：listSalesmen, listAdmins, addSalesman, addAdmin, setUserActive,
//         unbindUser, deleteUser, setUserBoss, getSettings, setSetting
//   服务号与用量：setMpOpenid, testMpSend, mpTokenPush, usageStats, testMpAlert
//   转写：transcribeVisit, transcribeUsage, saveVisitTrText
//   分发与杂项：uploadAdminDist, ping
//
// 【⚠️ 免鉴权特例（安全相关，动它们之前先读注释）】
//   ① getAdminDistMeta / getAdminDistPart —— 在 ACTIONS 校验之前 return（文员机拉更新包用）。
//      注意：这 2 条**不在 ACTIONS 数组里** → 所以 dispatch 比 ACTIONS 多这 2 条。
//   ② 定时器入口 —— 必须同时满足 `Type === 'Timer'` 与 `TriggerName === TICK_TRIGGER_NAME`
//      （2026-09-23 收紧；原写法 `event.TriggerName || event.Type === 'Timer'` 可被客户端伪造）
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

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

const $ = db.command.aggregate;   // 2026-09-26：分级聚合要用 $.sum / $.avg（custGeoAggregate）

// ⭐⭐ 2026-09-29【回收站】（老板定：「客户管理里面做个回收站功能，删除的客户先放在里面呗，以后再统一清理」）
//   **所有"查客户给别人看 / 做统计"的地方都要带上它** —— 否则已删客户会从列表 / 地图 / 总数里冒出来。
//   ⚠️ MongoDB 语义：`deleted: _.neq(true)` **能匹配"字段不存在"的文档** → 老客户（没这个字段）照常命中，
//      不会因为加了这一条就"全消失"（这个坑 2026-09-27 在 backfillMallCode 里踩过：`$ne:''` 会匹配不存在的字段，
//      当时把 6 万家没 mallKey 的点评客户全圈了进去）。这里用 `$ne:true` 是**故意**的语义，安全。
//   ⚠️ **订单聚合刻意不带**（老板定「订单数据等还是要纳入总额的」）—— 订单按 customerCode 走，与客户在不在回收站无关。
const NOT_DELETED = { deleted: _.neq(true) };
// ⚠️⚠️ **聚合（`.aggregate().match()`）专用** —— 它**不认 `db.command` 的 `_.neq()`**，必须用原生 `$ne`。
//   用错了**不报错、只是静默不生效**（气泡数照旧含已删客户）—— 这种"错得看不出来"的最坑，所以单独列一份。
const NOT_DELETED_AGG = { deleted: { $ne: true } };

const TEMPLATE_ID = 'tCQ_Xi5OaMQ9t9-UX9NeEZ4Tv4nHJ-L1PAEVWOdDhxs';
// 老板手机号（2026-09-09 老板定：谁用这个号码注册谁就是老板；老板账号后台不可停用/不可关老板模式/不可删除）
const BOSS_PHONE = '15055492888';
// 定时触发器名（2026-09-23 新增）：**必须与 config.json 的 triggers[0].name 一致**。
// 用途：在 exports.main 顶部区分「云开发定时触发器」与「客户端伪造的 { Type:'Timer' }」（见入口处注释）。
const TICK_TRIGGER_NAME = 'visitTimeoutTick';
// 服务号（公众号）模板消息：业务员关注服务号一次 → 永久免授权收新任务提醒（2026-09-04 老板定稿 §7.6）
const MP_API = 'https://api.weixin.qq.com';
const ACTIONS = ['login', 'listTasks', 'getTask', 'createTask', 'editTask', 'rescheduleTask', 'listLatestLocations', 'getDayTrack', 'getVisitTrack', 'uploadAdminDist', 'extendTask', 'reassignTask', 'withdrawTask', 'deleteTask', 'sendTask', 'listCustomers', 'custGeoOptions', 'custGeoAggregate', 'custMapPoints', 'custSync', 'custPageAgg', 'customerNames', 'importCustomers', 'importMallCustomers', 'runMallMatch', 'listMallLibrary', 'applyMallMatch', 'listMallClaims', 'resolveMallClaim', 'listCustomerVisits', 'reviewFinishRequest', 'getLastMallImport', 'listSalesmen', 'listAdmins', 'addSalesman', 'addAdmin', 'setUserActive', 'setUserStar', 'setUserReferrer', 'referrerStats', 'getUserDetail', 'unbindUser', 'deleteUser', 'getSettings', 'setSetting', 'setMpOpenid', 'testMpSend', 'mpTokenPush', 'cancelOngoing', 'purgeCancelled', 'purgeCustomerVisits', 'listCoordFixes', 'reviewCoordFix', 'reviewFieldReport', 'fixLegacyPendingCoords', 'smartSortDay', 'resetTestData', 'wipeData', 'listCustomerBatches', 'getCustomerBatchInfo', 'renameCustomerBatch', 'deleteCustomerBatch', 'createManualBatch', 'backfillMallCode', 'archiveInitialBatch', 'removeCustomerFromBatch', 'addCustomersToBatch', 'deleteCustomers', 'getTempFileURL', 'autoArchiveExpired', 'updateCustomerRemark', 'listCustomerRemarks', 'purgeUnbatchedCustomers', 'listRegistrations', 'reviewRegistration', 'setUserBoss', 'setUserAlsoSalesman', 'transcribeVisit', 'transcribeUsage', 'saveVisitTrText', 'transcribeCustAudio', 'pollCustAudioText', 'deleteCustAudio', 'saveCustAudioText', 'usageStats', 'testMpAlert', 'getCustomerDetail', 'updateCustomerCoords', 'updateCustomerFields', 'dupCheckCust', 'refreshFromMall', 'backfillGeo', 'backfillAddressFromPlat', 'fixPlatMatched', 'setCustPhotos', 'msgCount', 'msgCenter', 'fieldList', 'listDeletedCustomers', 'restoreCustomers', 'custDirty', 'listFreeTrips', 'deleteFreeTrip', 'freeTripDetailAdmin', 'listShareImages', 'saveShareImages', 'ping'];

// =====================================================================================
// ⭐ 2026-09-28 晚 老板定：**消息中心**（后台边栏「📬 消息中心」+ 铃铛/角标数字）
//   老板口径：分两类 ——
//     · **重点消息**（要人做决定 → **计入铃铛/角标**）：坐标修正 / 现场提报 / 注册审核 / 任务审核
//     · **滚动消息**（业务员动态 → **只读流水，不计入数字**）：开始拜访 / 拜访完毕 / 坐标&提报留痕
//   为什么这么设计：**数字 = 实时查"未处理条数"**（不是"读过就减"）→ **后台关着期间产生的消息一条都不会漏**
//   （老板报的痛点：后台没启动时提交的审核，铃铛和语音都漏了）。
//   处理完一条（采纳/忽略、同意/驳回）→ 对应记录 status 变化 → 下次查数字自动减。
// =====================================================================================

// =====================================================================================
// ⭐ 2026-09-28 晚 老板定：**「⏳ 待商城建档」**（后台边栏独立一页）
//   这批客户 = 业务员**现场用「加新店」建的**（customers.mallPending === true，source='field'）。
//   他们**已经是正式客户**（能派任务 / 能拜访 / 能记笔记），只是**商城侧信息还没有** ——
//   等以后导商城表把他们对上，就把 mallPending 去掉（本页也提供"手工取消标记"）。
//   入参：{ page, pageSize, q }；q = 店名/电话/地址 模糊（不区分大小写）
// =====================================================================================
async function fieldList(event) {
  const page = Math.max(0, Number(event.page) || 0);
  const size = Math.min(100, Math.max(5, Number(event.pageSize) || 30));
  const q = String(event.q || '').trim();

  // ⭐ 2026-09-29 回收站：已删客户不算「待商城建档」
  let qy = db.collection('customers').where(_.and([{ mallPending: true }, NOT_DELETED]));
  if (q) {
    const re = db.RegExp({ regexp: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
    qy = db.collection('customers').where(_.and([
      { mallPending: true },
      NOT_DELETED,
      _.or([{ name: re }, { nameRaw: re }, { phone: re }, { phone2: re }, { address: re }])
    ]));
  }
  const totalRes = await qy.count().catch(() => ({ total: 0 }));
  const res = await qy.orderBy('createdAt', 'desc').skip(page * size).limit(size).get().catch(silentCatch('adminapi·if', { data: [] }));

  const list = res.data.map(c => {
    // photos 可能是 fileID 字符串数组，也可能是 {fileID} 对象数组 —— 两种都兼容
    let photo = '';
    const ps = c.photos;
    if (Array.isArray(ps) && ps.length) {
      const f = ps[0];
      photo = typeof f === 'string' ? f : ((f && (f.fileID || f.fileId || f.url)) || '');
    }
    return {
      id: c._id,
      name: c.name || c.nameRaw || '(未填店名)',
      nameRaw: c.nameRaw || '',
      phone: c.phone || c.phone2 || '',
      address: c.address || '',
      area: (c.region || '').split('>').pop() || c.district || '',
      bizCircle: c.bizCircle || '',
      lat: c.lat || 0, lng: c.lng || 0,
      photo: photo,
      createdByName: c.createdByName || '',
      createdAt: c.createdAt || 0,
      hasMall: !!(c.mallCode || c.mallKey || c.mallJoinedAt || c.orderCount)
    };
  });

  return { ok: true, total: (totalRes && totalRes.total) || 0, page: page, pageSize: size, list: list };
}

// ⛔ 2026-09-29【老板定：这个手动"一键建档"是错的，已从前端撤掉】
//   老板原话：「错就错在已建档这个按钮，我按下按钮就变成商城用户了，其实应该是**导入商城表格文件**才能行的；
//              不能直接按键就改成商城用户了，但是连注册时间和关联业务员这些信息都没有，以后销售订单信息也不好匹配了。」
//   问题本质：「已加入商城」是个**事实**，只能由**商城数据**决定。
//             手动抹掉 mallPending 之后，注册商城时间 / 签约业务员 / 客户编号**全是空的** → 订单接不上、数据自相矛盾。
//   正确链路：**导入商城表 → 比对对上 → 才算真正建档**
//             （补 mallPending:false + customerType:'mall' + mallJoinedAt/mallSalesman/mallKey，见 runMallMatch / applyMallMatch）。
// ⛔⛔ 2026-10-03【老板定：删掉】`fieldDone` 函数**已彻底删除**（连同 dispatch 与 ACTIONS 条目）——
//   它只写 `mallPending:false` + `mallPendingDoneAt`、**一个商城字段都不写**，是"**假对上商城**"的唯一制造者：
//   手机端「我新加的店」卡片据此把它显示成「已对上商城」，可它从没匹配过商城（老板实测报障的那家就是）。
//   ⚠️ 以后遇到"确实已入商城、但商城表里没有档案"的个例，走**导入商城表比对**这条路，不要复活这个函数。


// 只要"未处理数"（轻量：铃铛 + 边栏角标轮询用；不做客户/业务员名映射，只数条数）
async function msgCount() {
  const C = (q) => q.count().then(r => (r && r.total) || 0).catch(() => 0);
  const [coord, field, reg, task, shopNew] = await Promise.all([
    C(db.collection('coord_fix_requests').where({ status: 'pending', type: _.neq('field') })),  // 坐标修正
    C(db.collection('coord_fix_requests').where({ status: 'pending', type: 'field' })),         // 现场提报
    C(db.collection('registrations').where({ status: 'pending' })),                             // 注册审核
    C(db.collection('tasks').where({ status: 'reviewing', archivedAt: _.exists(false) })),      // 任务审核
    // ⭐⭐ 2026-09-29【老板定：加新店要进重点消息】
    //   老板原话：「从建立新店开始到最后，不管滚动消息还是重点消息都没有任何通知，而且这个应该进重点消息里面。」
    //   判据 = mallPending:true（现场录入、商城侧还没有档案）→ **导入商城表对上后自动减**
    //   （转正逻辑见 runMallMatch / applyMallMatch：写 mallPending:false）
    C(db.collection('customers').where(_.and([{ mallPending: true }, NOT_DELETED])))            // 现场新录的店（已删的不算）
  ]);
  return { ok: true, coord, field, reg, task, shopNew, total: coord + field + reg + task + shopNew };
}

// 消息中心页面数据
//  入参：{ tab: 'imp' | 'roll', page: 0, pageSize: 20 }
//   · imp  → 待处理的重点消息（带客户名/业务员名/距离，供列表展示 + 就地审核）
//   · roll → 时间倒序流水（**必须分页**：visits 几千条，一次全拉会撞云函数 100KB 出参上限）
async function msgCenter(event) {
  const tab = String(event.tab || 'imp');
  const page = Math.max(0, Number(event.page) || 0);
  const size = Math.min(50, Math.max(5, Number(event.pageSize) || 20));

  // ---------- ① 重点消息 ----------
  if (tab === 'imp') {
    const [fRes, rRes, tRes, sRes] = await Promise.all([
      db.collection('coord_fix_requests').where({ status: 'pending' }).orderBy('createdAt', 'desc').limit(50).get(),
      db.collection('registrations').where({ status: 'pending' }).orderBy('createdAt', 'desc').limit(30).get(),
      db.collection('tasks').where({ status: 'reviewing', archivedAt: _.exists(false) }).orderBy('createdAt', 'desc').limit(30).get(),
      // ⭐⭐ 2026-09-29【老板定：加新店要进重点消息】现场录入的店（mallPending:true）
      //   —— 老板报"从建立新店开始到最后，不管滚动消息还是重点消息都没有任何通知"。
      db.collection('customers').where(_.and([{ mallPending: true }, NOT_DELETED])).orderBy('createdAt', 'desc').limit(50).get()
        .catch(silentCatch('adminapi·msgShopNew', { data: [] }))
    ]);
    const cids = [...new Set(fRes.data.map(f => f.customerId).filter(Boolean))];
    const uids = [...new Set([].concat(fRes.data.map(f => f.salesmanId), tRes.data.map(t => t.salesmanId)).filter(Boolean))];
    const [cRes, uRes] = await Promise.all([
      // ⭐ 2026-09-28 晚 老板定：客户名要**带编码的原值**（如 `c347 早阳肉包(科创路店)`）→ 取 nameRaw（导入时留底），回退 name
      cids.length ? db.collection('customers').where({ _id: _.in(cids) }).field({ name: true, nameRaw: true, lat: true, lng: true, customerType: true }).get() : { data: [] },
      uids.length ? db.collection('users').where({ _id: _.in(uids) }).field({ name: true }).get() : { data: [] }
    ]);
    const cmap = {}; cRes.data.forEach(c => { cmap[c._id] = c; });
    const umap = {}; uRes.data.forEach(u => { umap[u._id] = u; });
    const items = [];
    fRes.data.forEach(f => {
      const c = cmap[f.customerId] || {}, u = umap[f.salesmanId] || {};
      const dist = (c.lat && c.lng && f.newLat && f.newLng) ? Math.round(haversine(f.newLat, f.newLng, c.lat, c.lng)) : null;
      items.push({
        kind: (f.type === 'field') ? 'field' : 'coord',
        id: f._id, at: f.createdAt || 0,
        customerId: f.customerId, customerName: c.nameRaw || c.name || '', customerType: c.customerType || '',
        salesmanName: u.name || '', note: f.note || '',
        oldLat: c.lat || null, oldLng: c.lng || null, newLat: f.newLat || null, newLng: f.newLng || null,
        distance: dist, photos: Array.isArray(f.photos) ? f.photos : [],
        fieldKind: f.kind || '', fieldValue: f.value || '', flagName: f.flagName || ''
      });
    });
    rRes.data.forEach(r => items.push({
      kind: 'reg', id: r._id, at: r.createdAt || 0, name: r.name || '', phone: r.phone || '',
      referrerName: r.referrerName || '', trial: !!r.trial, msg: '新用户注册待审核'
    }));
    tRes.data.forEach(t => items.push({
      kind: 'task', id: t._id, at: t.createdAt || 0, taskNo: t.taskNo || '', taskName: t.name || '',
      salesmanName: umap[t.salesmanId] ? umap[t.salesmanId].name : '', msg: '任务审核中，等待处理'
    }));
    // ⭐⭐ 2026-09-29【老板定：加新店要进重点消息】
    //   业务员现场建的店在这里列出 —— 老板一眼看到"谁 在什么时候 录了哪家店，还没对上商城"。
    //   ⚠️ 这里**不给"一键建档"**（老板定：商城状态只能由导入商城表比对决定）→
    //      前端这一条点了是**去「客户管理」看**；导入商城表对上后自动从这里消失（mallPending → false）。
    (sRes.data || []).forEach(s => items.push({
      kind: 'shopNew', id: s._id, at: s.createdAt || 0,
      customerId: s._id,
      customerName: s.nameRaw || s.name || '(未填店名)',
      customerType: s.customerType || '',
      salesmanName: s.createdByName || '',                 // 现场录入人（建档时存下来的名字）
      note: s.address || '',
      newLat: s.lat || null, newLng: s.lng || null, distance: null,
      photos: Array.isArray(s.photos) ? s.photos : [],
      area: s.district || '', bizCircle: s.bizCircle || '',
      phone: s.phone || '',
      msg: '现场新建店铺，等商城建档'
    }));
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    return { ok: true, tab: 'imp', total: items.length, items };
  }

  // ---------- ② 滚动消息 ----------
  const vRes = await db.collection('visits')
    .where({ startedAt: _.exists(true) })
    .orderBy('startedAt', 'desc').skip(page * size).limit(size)
    .field({ customerId: true, salesmanId: true, startedAt: true, finishedAt: true, result: true })
    .get().catch(silentCatch('adminapi·if', { data: [] }));
  const vRows = vRes.data || [];
  const cids = [...new Set(vRows.map(v => v.customerId).filter(Boolean))];
  const uids = [...new Set(vRows.map(v => v.salesmanId).filter(Boolean))];
  const [cRes, uRes] = await Promise.all([
    // ⭐ 2026-09-28 晚 老板定：客户名带编码原值（nameRaw）
    cids.length ? db.collection('customers').where({ _id: _.in(cids) }).field({ name: true, nameRaw: true }).get() : { data: [] },
    uids.length ? db.collection('users').where({ _id: _.in(uids) }).field({ name: true }).get() : { data: [] }
  ]);
  const cmap = {}; cRes.data.forEach(c => { cmap[c._id] = c; });
  const umap = {}; uRes.data.forEach(u => { umap[u._id] = u; });
  const list = [];
  vRows.forEach(v => {
    const cc = cmap[v.customerId] || {};
    const cn = cc.nameRaw || cc.name || '某客户';   // ⭐ 带编码的原值（老板 2026-09-28 定）
    const sn = (umap[v.salesmanId] || {}).name || '业务员';
    if (v.startedAt) list.push({ id: v._id + '-s', kind: 'visitStart', at: v.startedAt, salesmanName: sn, customerId: v.customerId, customerName: cn, text: '开始拜访 ' + cn });
    if (v.finishedAt) list.push({ id: v._id + '-f', kind: 'visitDone', at: v.finishedAt, salesmanName: sn, customerId: v.customerId, customerName: cn, text: '拜访完毕 ' + cn + (v.result ? '（' + v.result + '）' : '') });
  });
  // 坐标修正 / 现场提报的留痕（含已处理的 → 有迹可循：谁改过、你采纳还是忽略）
  try {
    const fRes = await db.collection('coord_fix_requests')
      .orderBy('createdAt', 'desc').skip(page * size).limit(size)
      // ⭐ 2026-09-28 晚：**必须把 reviewedAt / reviewedBy 取出来** —— 滚动消息里要显示"时间 + 审核人"
      .field({ type: true, customerId: true, salesmanId: true, status: true, createdAt: true, reviewedAt: true, reviewedBy: true }).get();
    const fids = [...new Set(fRes.data.map(f => f.customerId).filter(Boolean))];
    const fuid = [...new Set(fRes.data.map(f => f.salesmanId).filter(Boolean))];
    const [fcRes, fuRes] = await Promise.all([
      fids.length ? db.collection('customers').where({ _id: _.in(fids) }).field({ name: true, nameRaw: true }).get() : { data: [] },
      fuid.length ? db.collection('users').where({ _id: _.in(fuid) }).field({ name: true }).get() : { data: [] }
    ]);
    const fcm = {}; fcRes.data.forEach(c => { fcm[c._id] = c; });
    const fum = {}; fuRes.data.forEach(u => { fum[u._id] = u; });
    fRes.data.forEach(f => {
      const fc = fcm[f.customerId] || {};
      const cn = fc.nameRaw || fc.name || '某客户';   // ⭐ 带编码的原值（老板 2026-09-28 定）
      const sn = (fum[f.salesmanId] || {}).name || '业务员';
      const what = (f.type === 'field') ? '提交资料' : '修正坐标';
      // ⭐ 2026-09-28 晚 修 bug（老板报"修正坐标通过的那条，滚动消息却显示**已作废**"）：
      //   **坐标审核「同意」写的是 `confirmed`**，而这里原来只认 `approved` → 落到最后分支成了"已作废"。
      //   现场提报走的是 `approved` —— 两套值不一样，所以**两个都算"已采纳"**；
      //   真正的"作废"只有 `superseded`（重新提报时旧条被顶掉）。
      const isDone = (f.status === 'approved' || f.status === 'confirmed');
      const st = f.status === 'pending' ? '待审核'
        : (isDone ? '已采纳 ✓'
          : (f.status === 'rejected' ? '已忽略'
            : (f.status === 'superseded' ? '已作废' : String(f.status || ''))));
      // ⭐ 2026-09-28 晚 老板定：**审核人单独返回**（前端把它放在"时间"后面），**正文里不写审核人**；
      //   正文开头已经有"范宇琨 修正坐标…"了，右边再重复一次产生人是多余的。
      //   时间优先用"审核时间"（审核后按审核时间排更合理，待审核时才用提交时间）。
      list.push({ id: f._id + '-r', kind: 'coordfix', at: f.reviewedAt || f.createdAt || 0, salesmanName: sn, customerId: f.customerId, customerName: cn, reviewedBy: f.reviewedBy || '', text: sn + ' ' + what + ' · ' + cn + ' · ' + st });
    });
  } catch (e) { /* 留痕取不到不影响主流程 */ }
  // ⭐ 2026-09-28 晚 老板报"审核人员通过，滚动消息里没记录"→ 补上**注册审核**的流水。
  //   （registrations 没有 customerId / salesmanId，它是"人"的事 → 单独一段，不带客户名）
  try {
    const rRes = await db.collection('registrations')
      .orderBy('createdAt', 'desc').skip(page * size).limit(size)
      .field({ name: true, phone: true, status: true, createdAt: true, reviewedAt: true, reviewedBy: true, trial: true }).get();
    rRes.data.forEach(r => {
      const st = r.status === 'pending' ? '待审核' : (r.status === 'approved' ? '已通过 ✓' : '已拒绝');
      const tail = (r.status === 'pending') ? '' : (' · ' + st);
      // ⭐ 2026-09-28 晚 老板定：审核人**单独返回**（前端放在"时间"后面），**正文里不写**（避免重复）
      list.push({
        id: r._id + '-g', kind: 'register', at: r.reviewedAt || r.createdAt || 0,
        salesmanName: '', customerId: '', customerName: '', reviewedBy: r.reviewedBy || '',
        text: '👤 新用户注册 · ' + (r.name || '未填姓名') + (r.phone ? ('（' + r.phone + '）') : '') + (r.trial ? ' · 实习' : '') + tail
      });
    });
  } catch (e) { /* 注册流水取不到不影响主流程 */ }
  // ⭐ 2026-10-04 自由拜访「大操作」（建卡 / 结束 / 唤醒 / 删除）进滚动消息
  //   （老板要："这些大的操作后台的滚动消息要有提示"）
  //   ⚠️ 只在**第 0 页**并入 —— 滚动消息是时间倒序 + 分页的，自由拜访日志量小、最近一批够看；
  //      若也参与 skip/limit 会让分页计数跟其它来源打架。
  if (page === 0) {
    try {
      const tr = await db.collection('free_trip_logs')
        .orderBy('at', 'desc').limit(50).get()
        .catch(() => ({ data: [] }));
      (tr.data || []).forEach(g => {
        const area = [g.district, g.bizCircle].filter(Boolean).join(' · ') || '未划分商圈';
        const act = g.action === 'create' ? '建立自由拜访卡'
          : g.action === 'pause' ? '结束自由拜访卡'
            : g.action === 'resume' ? '唤醒自由拜访卡'
              : g.action === 'delete' ? '删除自由拜访卡' : '自由拜访卡';
        const cnt = g.visitedCount ? ('（已拜访 ' + g.visitedCount + ' 家）') : '';
        list.push({
          id: 'ft-' + (g.tripId || '') + '-' + (g.at || 0) + '-' + g.action,
          kind: 'freeTrip',
          at: g.at || 0,
          salesmanName: g.salesmanName || '业务员',
          customerId: '',
          customerName: '',
          text: (g.salesmanName || '业务员') + ' ' + act + ' · ' + area + cnt
        });
      });
    } catch (e) { /* 日志读不到不影响其它消息 */ }
  }
  list.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { ok: true, tab: 'roll', page, pageSize: size, hasMore: vRows.length >= size, items: list };
}

// 2026-09-11 老板定：后台可编辑转写文字（改错别字）—— 写 visits.trEdited（与小程序同一字段，两边同步可见）
async function saveVisitTrText(event) {
  const visitId = String(event.visitId || '');
  if (!visitId) return { ok: false, code: 'BAD_ARG', msg: '缺少拜访 ID' };
  const text = String(event.text == null ? '' : event.text).slice(0, 20000);
  const vr = await db.collection('visits').doc(visitId).get().catch(() => null);
  if (!vr || !vr.data) return { ok: false, code: 'NOT_FOUND', msg: '拜访记录不存在' };
  const adminName = (event._admin && event._admin.name) || '管理员';
  await db.collection('visits').doc(visitId).update({
    data: { trEdited: { text, by: adminName, byId: (event._admin && event._admin._id) || '', at: Date.now() } }
  });
  return { ok: true, text, editedAt: Date.now(), msg: '已保存' };
}

// ===== 2026-09-11 批 3：云调用用量自建统计（老板要「看得见、能刹车」）=====
// 原理：微信云开发查不到自己的用量 → 自己数：每次函数调用 +1（实例内累计），
//       攒够 20 次或满 60 秒才合并写一次库（避免"统计本身"产生大量写调用）。
// 口径：只统计「我们自己云函数的调用次数」，不含数据库/存储调用 → 低于控制台真值，仅作趋势与预警。
const UC_QUOTA_DEFAULT = 1000000; // 免费额度参考：100 万次/月（设置页可配 usageQuota）
let _ucCount = 0, _ucAt = 0;
function ucMonth(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 7); // YYYY-MM（东八区）
}
async function bumpUsage(n) {
  _ucCount += Number(n) || 1;
  const now = Date.now();
  if (_ucCount < 20 && now - _ucAt < 60000) return; // 攒够 20 次或满 60 秒才落库
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

// ===== 用量告警模板（2026-09-12 老板新申请「实时交易提醒」模板，编号 47862）=====
// 后台设置页可填模板 ID（mpAlertTemplateId）；留空则回落到任务通知模板
async function getAlertTemplateId() {
  try {
    const r = await db.collection('settings').where({ key: 'mpAlertTemplateId' }).limit(1).get();
    const v = String((r.data[0] && r.data[0].value) || '').trim();
    if (v) return v;
  } catch (e) { /* 读失败 → 回落任务模板 */ }
  const cfg = await getMpConfig();
  return (cfg && cfg.templateId) || '';
}

// 管理员信息收件人（2026-09-12 老板定）：系统/管理类通知（用量告警等）只发这些手机号对应的账号
// ⚠️ 口径：**不走"绑了服务号的管理员"自动收件** —— 老板明确要求这类信息不要发给朱小利的微信
// 配置项 key = adminNotifyPhones（逗号/空格/分号分隔，只认 11 位数字，最多 10 个）
async function getNotifyPhones() {
  try {
    const r = await db.collection('settings').where({ key: 'adminNotifyPhones' }).limit(1).get();
    const raw = String((r.data[0] && r.data[0].value) || '');
    return raw.split(/[,，;\s]+/).map(s => s.trim()).filter(s => /^\d{11}$/.test(s)).slice(0, 10);
  } catch (e) { return []; }
}

// 取「管理员信息收件人」对应的服务号 OpenID 列表（未绑定服务号的手机号会被跳过并回报）
async function resolveNotifyOpenids(extraPhone) {
  const phones = await getNotifyPhones();
  if (extraPhone && /^\d{11}$/.test(String(extraPhone).trim())) phones.unshift(String(extraPhone).trim());
  const uniq = [...new Set(phones)];
  if (!uniq.length) return { list: [], skipped: [], phones: [] };
  const r = await db.collection('users').where({ phone: _.in(uniq) }).limit(20).get().catch(silentCatch('adminapi·resolveNotifyOpenids', { data: [] }));
  const byPhone = {};
  r.data.forEach(u => { byPhone[String(u.phone || '')] = u; });
  const list = [];
  const skipped = [];
  uniq.forEach(ph => {
    const u = byPhone[ph];
    if (u && u.mpOpenid) { if (!list.includes(u.mpOpenid)) list.push(u.mpOpenid); }
    else skipped.push(ph + (u ? '（未绑服务号）' : '（无此账号）'));
  });
  return { list, skipped, phones: uniq };
}

// 用量告警模板数据（参数名取自模板详情：thing1 商户名称 / thing3 交易类型 / amount4 交易金额 / time2 交易时间 / thing7 商品名称）
// 类型规则（微信）：thing ≤20 字；amount 只能是数字；time 需 "YYYY-MM-DD HH:mm" → 详细文案放 thing7，金额只放数字
function buildAlertMpData(info) {
  const limit20 = s => String(s || '').slice(0, 20);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const timeStr = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}`;
  // 2026-09-12：数字可读性修正 —— 不足 1 万次时直接用「次」，避免小量被"万次"抹平成 0（测试消息当时显示 0 就是这个原因）
  const usedN = Number(info.used) || 0;
  const isBig = usedN >= 10000;
  const amountNum = isBig ? (Math.round(usedN / 1000) / 10) : usedN;
  const unitTxt = isBig ? '万次' : '次';
  return {
    thing1: { value: limit20('聚火拜访') },
    thing3: { value: limit20('云开发调用用量提醒') },
    amount4: { value: String(amountNum) },
    time2: { value: timeStr },
    thing7: { value: limit20('用量已达 ' + (info.pct || 0) + '%，共 ' + amountNum + ' ' + unitTxt) }
  };
}

// 用量查询（后台设置页展示 + 红线告警）
async function usageStats(event) {
  const month = ucMonth(Date.now());
  const r = await db.collection('settings').where({ key: 'usageCounter' }).limit(1).get();
  const val = (r.data[0] && r.data[0].value) || { total: 0, months: {} };
  const used = Number((val.months || {})[month] || 0);
  const qRes = await db.collection('settings').where({ key: 'usageQuota' }).limit(1).get();
  const quota = Number((qRes.data[0] && qRes.data[0].value) || 0) || UC_QUOTA_DEFAULT;
  const aRes = await db.collection('settings').where({ key: 'usageAlertPct' }).limit(1).get();
  const alertRaw = Number((aRes.data[0] && aRes.data[0].value) || 0);
  const alertPct = [60, 80].includes(alertRaw) ? alertRaw : 60;
  const pct = quota > 0 ? Math.round(used / quota * 1000) / 10 : 0;
  // 红线告警（每月一次）：达到 alertPct 就给「已绑定服务号」的管理员发模板消息
  // 2026-09-12：改用用量告警专用模板（mpAlertTemplateId，后台可填；留空回落任务模板）
  let alerted = '';
  try {
    if (pct >= alertPct && val.alertedMonth !== month) {
      // 2026-09-12 老板定：**只发给「管理员信息收件人」**（后台配置的手机号），
      // 不再自动发给"绑了服务号的管理员"（老板明确：这类信息不要发给朱小利的微信）
      const rn = await resolveNotifyOpenids();
      const toList = rn.list;
      const skipped = rn.skipped || [];
      const cfg = await getMpConfig();
      const tplId = await getAlertTemplateId();
      if (!toList.length) {
        alerted = '未发送：未配置「管理员信息收件人」' + (skipped.length ? '（' + skipped.join('、') + '）' : '');
      } else if (cfg && cfg.enabled && tplId) {
        const token = await getMpAccessToken(cfg);
        for (const to of toList) {
          await mpRequest(`/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
            touser: to,
            template_id: tplId,
            data: buildAlertMpData({ used, pct, quota })
          }).catch(() => null);
        }
        alerted = `已发送用量提醒（${toList.length} 人）`;
      }
      val.alertedMonth = month;
      if (r.data[0]) await db.collection('settings').doc(r.data[0]._id).update({ data: { value: val, updatedAt: Date.now() } }).catch(silentCatch('adminapi·for·写入', null));
    }
  } catch (e) { /* 告警失败静默 */ }
  return {
    ok: true, month, used, quota, pct, alertPct, alerted,
    total: Number(val.total || 0), months: val.months || {},
    quotaDefault: UC_QUOTA_DEFAULT,
    updatedAt: val.updatedAt || null,
    note: '自建统计，只含云函数调用次数，低于控制台真值，看趋势用'
  };
}

// 用量告警「测试发送」（2026-09-12 老板定）：按当前模板 ID + 字段映射发一条真实消息，便于核对文案
// 收件人：openid 直传 > phone 指定账号 > 设置页「管理员信息收件人」的第一个（**不发管理员微信**）
async function testMpAlert(event) {
  const cfg = await getMpConfig();
  if (!cfg || !cfg.enabled || !cfg.appid || !cfg.appsecret) {
    return { ok: false, code: 'MP_CFG', msg: '请先在系统设置启用服务号配置' };
  }
  const tplId = await getAlertTemplateId();
  if (!tplId) return { ok: false, code: 'NO_TPL', msg: '未配置用量告警模板 ID' };
  let openid = String(event.openid || '').trim();
  let picked = 'openid';
  if (!openid && event.phone) {
    const u = await db.collection('users').where({ phone: String(event.phone).trim() }).limit(1).get();
    const uu = u.data[0];
    openid = (uu && uu.mpOpenid) || '';
    picked = uu ? (uu.name || '') + '（' + uu.phone + '）' : ('手机号 ' + event.phone);
    if (!openid) return { ok: false, code: 'NO_OPENID', msg: picked + ' 未绑定服务号 OpenID（请先在「人员管理」绑定）' };
  }
  if (!openid) {
    // 2026-09-12 老板定：默认发给「管理员信息收件人」配置里的第一个手机号（**不再自动发给管理员微信**）
    const rn = await resolveNotifyOpenids();
    if (!rn.list.length) {
      return {
        ok: false, code: 'NO_RECIPIENT',
        msg: '未配置「管理员信息收件人」' + (rn.skipped && rn.skipped.length ? '（' + rn.skipped.join('、') + '）' : '') + '，请在设置页填写收件人手机号'
      };
    }
    openid = rn.list[0];
    picked = '管理员信息收件人 ' + (rn.phones[0] || '');
  }
  const stats = await usageStats({}); // 复用真实用量（内部含红线去重，不会重复告警）
  try {
    const token = await getMpAccessToken(cfg);
    const r = await mpRequest(`/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
      touser: openid,
      template_id: tplId,
      data: buildAlertMpData({ used: stats.used, pct: stats.pct, quota: stats.quota })
    });
    if (r && r.errcode === 0) {
      return { ok: true, sent: true, msgid: r.msgid, templateId: tplId, to: picked, used: stats.used, pct: stats.pct, msg: '测试消息已发送给 ' + picked + '，请查看该微信服务号的「服务通知」' };
    }
    return { ok: false, sent: false, code: 'MP_ERR', templateId: tplId, to: picked, msg: `errcode=${r && r.errcode} ${(r && r.errmsg) || ''}` };
  } catch (e) {
    return { ok: false, sent: false, code: 'MP_ERR', templateId: tplId, msg: e.message || '发送失败' };
  }
}

exports.main = async (event) => {
  const action = (event && event.action) || 'login';

  // 2026-09-11 批 3：用量计数（每次调用 +1；只统计函数调用次数，攒批落库）
  // ⚠️ 2026-09-23 复核：**故意留在鉴权之前** —— 未鉴权/被伪造的调用同样消耗云调用配额，
  //    挪到鉴权之后会让「本月云调用」统计偏低、失去趋势意义（"被刷高"= 真实消耗，不是安全问题）。
  bumpUsage(1);

  // 定时触发器入口（2026-09-08 M1：拜访时长上限动态闹钟，每 10 分钟 cron 调一次，免管理员鉴权）
  // ⚠️ 2026-09-23 收紧（安全修复）：原写法 `event.TriggerName || event.Type === 'Timer'` 语义太宽 ——
  //    小程序端任意用户 `wx.cloud.callFunction({ name:'adminapi', data:{ Type:'Timer' } })` 即可**越过鉴权**
  //    触发 visitTimeoutTick（一个会改任务/拜访状态的写操作）。现要求「Type=Timer」**且**「TriggerName
  //    与 config.json 声明的触发器名一致」。
  // 🔴 部署配套：**必须去云开发控制台核对触发器名就叫 TICK_TRIGGER_NAME**，否则定时任务会静默停摆
  //    （它负责拜访超时自动提交/取消、过期任务补记，坏了没有任何人会察觉）。
  if (event && event.Type === 'Timer' && event.TriggerName === TICK_TRIGGER_NAME) {
    await visitTimeoutTick();
    return { ok: true, cron: true };
  }

  // 后台分发明文读取（2026-09-08 老板定：文员机 server 转发用；代码文件非敏感，免鉴权）
  if (action === 'getAdminDistMeta') return await getAdminDistMeta();
  if (action === 'getAdminDistPart') return await getAdminDistPart(event);

  if (!ACTIONS.includes(action)) return { ok: false, code: 'BAD_ACTION', msg: '未知操作' };
  // 除 login 外均需管理员校验
  if (action !== 'login') {
    const user = await verifyAdmin(event);
    if (!user) return { ok: false, code: 'NO_AUTH', msg: '登录失效，请重新登录' };
    event._admin = user;
  }

  try {
    if (action === 'login') return await login(event);
    if (action === 'listTasks') return await listTasks(event);
    if (action === 'getTask') return await getTask(event);
    if (action === 'createTask') return await createTask(event);
    if (action === 'editTask') return await editTask(event);
    if (action === 'rescheduleTask') return await rescheduleTask(event);
    if (action === 'listLatestLocations') return await listLatestLocations(event);
    if (action === 'getDayTrack') return await getDayTrack(event);
    if (action === 'getVisitTrack') return await getVisitTrack(event);
    if (action === 'uploadAdminDist') return await uploadAdminDist(event);
    if (action === 'extendTask') return await extendTask(event);
    if (action === 'reassignTask') return await reassignTask(event);
    if (action === 'withdrawTask') return await withdrawTask(event);
    if (action === 'deleteTask') return await deleteTask(event);
    if (action === 'sendTask') return await sendTask(event);
    if (action === 'listCustomers') return await listCustomers(event);
    if (action === 'custGeoOptions') return await custGeoOptions(event);
    if (action === 'custGeoAggregate') return await custGeoAggregate(event);   // 2026-09-26：地图分级聚合（group by city/district/bizCircle）
    if (action === 'custMapPoints') return await custMapPoints(event);         // 2026-09-27：轻量客户点（分片，地图/客户管理用）
    if (action === 'custSync') return await custSync(event);                   // 2026-09-27：客户增量同步（updatedAt > since）
    if (action === 'custDirty') return await custDirty();
    if (action === 'listShareImages') return await listShareImages();
    if (action === 'saveShareImages') return await saveShareImages(event);
    if (action === 'listFreeTrips') return await listFreeTrips(event);    // ⭐ 2026-10-03 后台：自由拜访卡列表（可按业务员筛）
    if (action === 'deleteFreeTrip') return await deleteFreeTrip(event);
    if (action === 'freeTripDetailAdmin') return await freeTripDetailAdmin(event);  // ⭐ 2026-10-03 后台：看这张卡去过的店  // ⭐ 2026-10-03 后台：删自由拜访卡（只删归类，拜访记录保留）                      // ⭐ 2026-09-29【方案 C】数据变动信号（手机端建店后写；后台据此自动刷缓存）
    // ⚠️ 2026-09-27 补接线（老板报障「客户列表 全局态/任务状态/订单总数/订单总额/最近下单/最近拜访 全空」）：
    //   本 action 在 ACTIONS 白名单里、实现函数也有，但 **dispatch 里漏了分支** → 落到末尾兜底 `return {ok:true,pong}`
    //   → 前端拿到 ok:true 却没有 byId/byCode → 静默不填 → 六列全空、且不报错。
    if (action === 'custPageAgg') return await custPageAgg(event);
    if (action === 'backfillAddressFromPlat') return await backfillAddressFromPlat(event);   // 2026-09-27：用平台地址补全 customers.address（一次性/幂等）
    // ⭐ 2026-10-04：修 platMatched 被商城导入覆盖成 false（后台详情页平台口碑卡不显示）—— dry=true 只统计
    if (action === 'fixPlatMatched') return await fixPlatMatched(event);
    // ⭐ 2026-10-06：后台客户详情页「门店照片」保存（管理员传图/换图/删图）
    if (action === 'setCustPhotos') return await setCustPhotos(event);
    // ⭐ 2026-09-28 晚：**消息中心**（边栏「📬 消息中心」+ 铃铛/角标数字，老板 2026-09-28 定）
    if (action === 'msgCount') return await msgCount(event);     // 只要"未处理数"（轻量，供角标轮询）
    if (action === 'msgCenter') return await msgCenter(event);   // 消息中心页面数据（重点消息 / 滚动消息）
    // ⭐ 2026-09-28 晚 老板定：**「⏳ 待商城建档」**（边栏独立一页）——
    //   业务员现场录的店（customers.mallPending === true）等商城表来对上，这里列给老板看
    if (action === 'fieldList') return await fieldList(event);
    // ⭐⭐ 2026-09-29 老板定：**客户回收站**（软删 —— 删除的客户先放这里，可随时恢复）
    if (action === 'listDeletedCustomers') return await listDeletedCustomers(event);   // 回收站列表
    if (action === 'restoreCustomers') return await restoreCustomers(event);           // 从回收站恢复
    if (action === 'customerNames') return await customerNames(event);
    if (action === 'importCustomers') return await importCustomers(event);
    if (action === 'importMallCustomers') return await importMallCustomers(event);
    if (action === 'runMallMatch') return await runMallMatch(event);
    if (action === 'listMallLibrary') return await listMallLibrary(event);
    if (action === 'applyMallMatch') return await applyMallMatch(event);
    if (action === 'refreshFromMall') return await refreshFromMall(event);   // 2026-09-25：从商城更新客户信息（白名单字段 + 先预览）
    // 2026-09-26 多城市改造第 1 步：给 customers 回填三层骨架字段（city / district / bizCircle）
    if (action === 'backfillGeo') return await backfillGeo(event);
    if (action === 'listMallClaims') return await listMallClaims(event);
    if (action === 'resolveMallClaim') return await resolveMallClaim(event);
    if (action === 'listCustomerVisits') return await listCustomerVisits(event);
    if (action === 'transcribeVisit') return await transcribeVisit(event);
    if (action === 'transcribeUsage') return await transcribeUsage(event);
    if (action === 'transcribeCustAudio') return await transcribeCustAudio(event);   // ⭐ 2026-10-03：「加新店」录音转写（现场证据）
    if (action === 'pollCustAudioText') return await pollCustAudioText(event);       // ⭐ 2026-10-03：取转写结果并回写客户档案
    if (action === 'deleteCustAudio') return await deleteCustAudio(event);           // ⭐ 2026-10-03：删录音文件（有文字则保留文字）
    if (action === 'saveCustAudioText') return await saveCustAudioText(event);       // ⭐ 2026-10-03：改转写文字（纠错）
    if (action === 'reviewFinishRequest') return await reviewFinishRequest(event);
    if (action === 'getLastMallImport') return await getLastMallImport(event);
    if (action === 'listSalesmen') return await listSalesmen(event);
    if (action === 'listAdmins') return await listAdmins(event);
    if (action === 'setUserBoss') return await setUserBoss(event);
    if (action === 'setUserAlsoSalesman') return await setUserAlsoSalesman(event);   // ⭐ 2026-09-30 老板兼业务员开关
    if (action === 'addSalesman') return await addSalesman(event);
    if (action === 'addAdmin') return await addAdmin(event);
    if (action === 'setUserActive') return await setUserActive(event);
    if (action === 'setUserStar') return await setUserStar(event);         // 2026-09-24 星级：后台设定业务员星级
    if (action === 'setUserReferrer') return await setUserReferrer(event); // 2026-09-24 推荐人：手工补录/修改
    if (action === 'referrerStats') return await referrerStats(event);     // 2026-09-24 推荐人：拉人排行
    if (action === 'getUserDetail') return await getUserDetail(event);     // 2026-09-24 个人详情（人员管理点开）
    if (action === 'unbindUser') return await unbindUser(event);
    if (action === 'deleteUser') return await deleteUser(event);
    if (action === 'listRegistrations') return await listRegistrations(event);
    if (action === 'reviewRegistration') return await reviewRegistration(event);
    if (action === 'getSettings') return await getSettings(event);
    if (action === 'setSetting') return await setSetting(event);
    if (action === 'setMpOpenid') return await setMpOpenid(event);
    if (action === 'testMpSend') return await testMpSend(event);
    if (action === 'mpTokenPush') return await mpTokenPush(event);
    if (action === 'cancelOngoing') return await cancelOngoing(event);
    if (action === 'purgeCancelled') return await purgeCancelled(event);
    if (action === 'purgeCustomerVisits') return await purgeCustomerVisits(event);
    if (action === 'listCoordFixes') return await listCoordFixes(event);
    if (action === 'reviewCoordFix') return await reviewCoordFix(event);
    if (action === 'reviewFieldReport') return await reviewFieldReport(event);   // ⚠️ 2026-09-27 补接线（同样漏了，导致「现场提报」审核静默失效）
    if (action === 'fixLegacyPendingCoords') return await fixLegacyPendingCoords(event);   // 2026-09-26：一次性把存量“待定”按新规则写回（幂等）
    if (action === 'smartSortDay') return await smartSortDay(event);
    if (action === 'resetTestData') return await resetTestData(event);
    if (action === 'wipeData') return await wipeData(event);
    if (action === 'listCustomerBatches') return await listCustomerBatches(event);
    if (action === 'getCustomerBatchInfo') return await getCustomerBatchInfo(event);
    if (action === 'renameCustomerBatch') return await renameCustomerBatch(event);
    if (action === 'deleteCustomerBatch') return await deleteCustomerBatch(event);
    if (action === 'createManualBatch') return await createManualBatch(event);
    if (action === 'backfillMallCode') return await backfillMallCode(event);
    if (action === 'archiveInitialBatch') return await archiveInitialBatch(event);
    if (action === 'removeCustomerFromBatch') return await removeCustomerFromBatch(event);
    if (action === 'addCustomersToBatch') return await addCustomersToBatch(event);
    if (action === 'deleteCustomers') return await deleteCustomers(event);
    if (action === 'getTempFileURL') return await getTempFileURL(event);
    if (action === 'autoArchiveExpired') return await autoArchiveExpired(event);
    if (action === 'updateCustomerRemark') return await updateCustomerRemark(event);
    if (action === 'listCustomerRemarks') return await listCustomerRemarks(event);
    if (action === 'purgeUnbatchedCustomers') return await purgeUnbatchedCustomers(event);
    if (action === 'saveVisitTrText') return await saveVisitTrText(event);
    if (action === 'usageStats') return await usageStats(event); // 2026-09-11 批 3：云调用用量查询
    if (action === 'testMpAlert') return await testMpAlert(event); // 2026-09-12：用量告警测试发送
    if (action === 'ping') return { ok: true, pong: Date.now() };
    if (action === 'getCustomerDetail') return await getCustomerDetail(event);        // 2026-09-25：客户详情页聚合查询
    if (action === 'updateCustomerCoords') return await updateCustomerCoords(event);  // 2026-09-25：后台改坐标（直接生效）
    if (action === 'updateCustomerFields') return await updateCustomerFields(event);  // 2026-09-25：后台改客户资料
    if (action === 'dupCheckCust') return await dupCheckCust(event);                  // ⭐ 2026-10-03：后台「防重检测」（复核用，只读）
    // ⚠️ 2026-09-27 改：原来这里返回 `{ ok:true, pong }` —— 任何"白名单有、dispatch 漏接线"的 action 都会被伪装成
    //   "调用成功但没有数据"（前端静默、不报错，极难发现，本次客户列表六列全空就是这么来的）。改为一律明确报错。
    return { ok: false, code: 'BAD_ACTION', msg: '未知操作：' + action };
  } catch (e) {
    return { ok: false, code: 'ERROR', msg: e.message || '服务异常' };
  }
};

// ===== 客户详情页（2026-09-25 新增）=====
// `getCustomerDetail` —— 一次把详情页要的数据全取回来：客户主档（含 plat）+ 订单（按业务键 customerCode，
//   同编号主副两家都算）+ 明细汇总（常买商品）+ 全部拜访（跨任务）+ 备注历史。
// `updateCustomerCoords` —— 后台管理员改坐标 **直接生效**（老板 09-24 定：不搞"待审核"那套），
//   同时写 coordSource='admin' 与 coordUpdatedAt，供详情页显示来源标签 / 距上个坐标。
// `updateCustomerFields` —— 编辑态保存客户资料（**白名单字段**，防止误改 mallKey 这类关联键）。
// ⭐ 2026-10-03 老板定：后台详情页的编辑能力扩展到**区域 / 商圈 / 品类 / 业务员** ——
//   背景（老板报障）：「加新店」现场录的店，后台详情页看不到品类/区域/商圈；老板要求这几项都能在后台改。
//   · district / bizCircle —— 区域 / 商圈（客户档案上就是这两个字段）
//   · cat1 / cat2 / cat3   —— 品类三级（后台用与手机端同一套词表做三级下拉，见 admin.html 的 CAT_WORDS）
//   · salesman             —— 业务员（后台下拉选系统业务员；⚠️ 商城再导入时**会被商城值盖掉**，见 mallFieldsFrom）
//   ⚠️ businessArea 留着（历史字段，全库无值；卡片已不再展示那一行，避免误改成没人看的东西）
const EDITABLE_CUST_FIELDS = ['name', 'phone', 'phone2', 'address', 'businessArea', 'businessHours', 'category', 'contactName',
                              'district', 'bizCircle', 'cat1', 'cat2', 'cat3', 'salesman'];

async function getCustomerDetail(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const cDoc = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!cDoc || !cDoc.data) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const c = cDoc.data;
  const code = c.mallCode || '';

  // —— ① 订单（按业务键 customerCode；同编号的主副两家都会命中）——
  let orders = [];
  if (code) {
    // ⚠️⚠️ 2026-09-25 修（老板报障：c490「订单总数」列显示 112 单，进详情却是"累计 50 单"）：
    //   原先这里 `.limit(50)` —— **只拉了 50 单**，于是"累计 N 单"和"金额合计"都被截断在 50。
    //   改成：**订单全部拉下来**（用 fetchAll 分页，只为真实计数与金额合计）；
    //   云端 orderBy 与分页不能同时用，所以拉回来后在内存里按日期倒序排。
    orders = await fetchAll('orders', { customerCode: code }, {
      orderNo: true, orderedAt: true, actualAmount: true, orderStatus: true, payMethod: true
    }).catch(() => []);
    orders.sort((a, b) => String(b.orderedAt || '').localeCompare(String(a.orderedAt || '')));
  }
  // 明细只查**最近 20 单** —— 小窗里就是展示这 20 单，没必要把上百单的明细全拉回来（会拖慢甚至超时）
  const orderNoList = orders.slice(0, 20).map(o => o.orderNo).filter(Boolean);

  // —— ② 明细（这些订单的商品行）→ 汇总「常买」+ 每单行数 ——
  let items = [];
  for (let i = 0; i < orderNoList.length; i += 20) {
    const part = await db.collection('order_items')
      .where({ orderNo: _.in(orderNoList.slice(i, i + 20)) }).limit(500).get().catch(silentCatch('adminapi·for', { data: [] }));
    items = items.concat(part.data || []);
  }
  const linesOf = {};
  const byGoods = {};
  items.forEach(it => {
    linesOf[it.orderNo] = (linesOf[it.orderNo] || 0) + 1;
    const k = it.goodsName || it.goodsCode || '';
    if (!k) return;
    if (!byGoods[k]) byGoods[k] = { name: k, spec: it.spec || '', unit: it.unit || '', qty: 0, amount: 0, times: 0 };
    byGoods[k].qty += Number(it.orderQty) || 0;
    byGoods[k].amount += Number(it.amount) || 0;
    byGoods[k].times += 1;
  });
  const topGoods = Object.keys(byGoods).map(k => byGoods[k]).sort((a, b) => b.qty - a.qty).slice(0, 8);

  // —— ③ 拜访（该客户全部，跨任务；带转写文字与现场照片缩略图 fileID）——
  const vRes = await db.collection('visits').where({ customerId })
    .orderBy('createdAt', 'desc').limit(30).get().catch(silentCatch('adminapi·for', { data: [] }));
  const visits = (vRes.data || []).map(v => ({
    _id: v._id,
    taskId: v.taskId || '',
    status: v.status || '',
    visitedAt: v.visitedAt || '',
    result: v.result || '',
    duration: Number(v.duration) || 0,
    remark: v.remark || v.text || '',
    audioCount: (Array.isArray(v.audios) && v.audios.length) || (v.audio && v.audio.fileID ? 1 : 0),
    trText: (v.trEdited && v.trEdited.text) || '',
    thumbs: (v.photos || []).map(p => (p && (p.thumbID || p.fileID)) || (typeof p === 'string' ? p : '')).filter(Boolean).slice(0, 3)
  }));

  // —— ④ 备注历史（新 → 旧）——
  const rmk = await fetchAll('customer_remarks', { customerId }, {});
  rmk.sort((a, b) => (b.at || 0) - (a.at || 0));

  // —— ⑤ ⭐ 2026-09-27：业务员现场提报（待审核：招牌菜/设施/团购外卖）—— 后台详情页审核用（修正 008）——
  const frRes = await db.collection('coord_fix_requests')
    .where({ customerId, status: 'pending', type: 'field' })
    .orderBy('createdAt', 'desc').limit(50).get().catch(silentCatch('adminapi·for', { data: [] }));
  const fieldReports = (frRes.data || []).map(f => ({
    _id: f._id, kind: f.kind || '', value: f.value || '',
    flagName: f.flagName || '', flagTo: !!f.flagTo,
    salesmanName: f.salesmanName || '', createdAt: f.createdAt || 0
  }));

  return {
    ok: true,
    customer: c,
    orders: orders.slice(0, 20).map(o => ({
      orderNo: o.orderNo, orderedAt: o.orderedAt, actualAmount: o.actualAmount,
      orderStatus: o.orderStatus, payMethod: o.payMethod, lines: linesOf[o.orderNo] || 0
    })),
    // 2026-09-25 老板定：后台「购买记录」里点某一单 → **弹出小窗看该单的商品明细**（商品名/规格/数量/单价/金额）。
    // 只带上上面返回的那 20 单的明细（orders.slice(0,20)），避免返回体过大。
    // ⚠️ 前端拿不到明细就没法弹窗 —— 所以必须在这里带上（原先只返回了汇总 topGoods + 每单行数）。
    orderItems: (() => {
      const keep = {};
      orders.slice(0, 20).forEach(o => { if (o.orderNo) keep[o.orderNo] = true; });
      const by = {};
      items.forEach(it => {
        if (!it.orderNo || !keep[it.orderNo]) return;
        (by[it.orderNo] = by[it.orderNo] || []).push({
          name: it.goodsName || '', spec: it.spec || '', unit: it.unit || '',
          qty: Number(it.orderQty) || 0, price: it.salePrice != null ? Number(it.salePrice) : null,
          amount: Number(it.amount) || 0, category: it.category || '', barcode: it.barcode || ''
        });
      });
      return by;
    })(),
    orderTotal: orders.length,
    orderAmountSum: orders.reduce((a, o) => a + (Number(o.actualAmount) || 0), 0),
    topGoods,
    visits,
    remarks: rmk.slice(0, 30).map(r => ({ text: r.text || '', at: r.at || 0, by: r.by || '' })),
    fieldReports: fieldReports      // ⭐ 2026-09-27：待审核的现场提报（后台详情页审核用）
  };
}

// ⭐ 2026-10-03 老板定：后台客户详情页的「🔍 防重检测」—— **复核用，只读，不改任何数据**。
//   为什么这么实现：
//     · `tasks.selfCheck` 虽免鉴权只读，但它的附近列表里**电话打了码** —— 复核恰恰要看清电话，所以不转发它；
//     · 判定（同号 / 同名 / 疑似）**一律转发 `tasks.selfCheck`** —— 它内部跑的就是「加新店」录入时拦截用的
//       同一个 `dupCheck`，所以「事前拦截」与「事后复核」还是同一把尺子 → 口径**永不漂移**
//       （这里绝不复制 phoneKey / 相似度算法）。
//       ⚠️ 只能走 `selfCheck`：它是 tasks 里**刻意放在鉴权之前**的免鉴权入口；
//          而 `newShopCheck` 在鉴权之后，云函数间调用没有 OPENID → 必然 NO_AUTH（2026-10-03 踩过）；
//     · 唯一自己干的事：把半径内的店**完整列出来**（含**完整电话** —— 后台是管理员，本来就有权看），
//       并把 tasks 给出的判定按 `id` 标注到对应那家身上（hit: block / sameName / suspect）。
//   ⚠️ 默认半径 200 米（与手机端 DUP_RADIUS 同口径）；上限 1000 米。
async function dupCheckCust(event) {
  const customerId = String(event.customerId || '').trim();
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const cDoc = await db.collection('customers').doc(customerId).get().catch(() => null);
  const self = cDoc && cDoc.data;
  if (!self) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const lat = Number(self.lat), lng = Number(self.lng);
  if (!lat || !lng) return { ok: false, code: 'NO_COORD', msg: '这家店还没有坐标，做不了防重检测' };
  const R = Math.min(Math.max(Number(event.radius) || 200, 10), 1000);
  const name = String(self.nameRaw || self.name || '').trim();
  const phone = String(self.phone || '').trim();

  // ① 判定：转发 tasks.newShopCheck（excludeId = 自己，免得把自己报成"疑似重复"）
  let block = null, sameName = null, suspect = null, dupErr = '', dupTruncated = false;
  try {
    // ⚠️⚠️ 必须走 `selfCheck`（**刻意放在鉴权之前**的那条免鉴权路）——
    //   云函数间调用**没有 OPENID**，而 `newShopCheck` 在鉴权之后 → 必然 `NO_AUTH 未登录` 失败
    //   （2026-10-03 老板实测报障："判定服务异常 + 一堆英文"，就是这个）。
    //   ⭐ 同批给 selfCheck 补了 `excludeId` 透传，所以这里能正确把"自己"排除掉。
    const r = await cloud.callFunction({
      name: 'tasks',
      data: { action: 'selfCheck', lat, lng, name, phone, radius: R, excludeId: customerId }
    });
    const res = (r && r.result) || {};
    const dup = res.dup || {};
    block = dup.block || null; sameName = dup.sameName || null; suspect = dup.suspect || null;
    dupTruncated = !!dup.truncated;
    if (res.ok === false) dupErr = res.msg || '判定服务返回异常';
  } catch (err) {
    dupErr = '判定服务无响应：' + ((err && err.message) || '调用失败');
  }
  const hitOf = (id) => (block && block.id === id) ? 'block'
    : (sameName && sameName.id === id) ? 'sameName'
    : (suspect && suspect.id === id) ? 'suspect' : '';

  // ② 附近完整列表（⚠️ 同 dupCheck 的口径：PAGE=100 / MAX=300 分批 —— limit(50) 是历史上的真凶）
  const dLat = R / 111000;
  const dLng = R / (111000 * Math.cos(lat * Math.PI / 180) || 1);
  const rows = [];
  try {
    const PAGE = 100, MAX = 300;
    for (let sk = 0; sk < MAX; sk += PAGE) {
      const part = await db.collection('customers')
        .where({ lat: _.gt(lat - dLat).and(_.lt(lat + dLat)), lng: _.gt(lng - dLng).and(_.lt(lng + dLng)) })
        .field({ name: true, nameRaw: true, phone: true, phone2: true, address: true, lat: true, lng: true,
                 mallKey: true, mallCode: true, customerType: true, source: true, deleted: true })
        .skip(sk).limit(PAGE).get();
      const arr = (part && part.data) || [];
      for (const x of arr) rows.push(x);
      if (arr.length < PAGE) break;   // 取完了
    }
  } catch (err) {
    return { ok: false, code: 'QUERY_FAIL', msg: '附近查询失败：' + ((err && err.message) || err) };
  }
  const HIT_RANK = (h) => h === 'block' ? 0 : h === 'sameName' ? 1 : h === 'suspect' ? 2 : 3;
  const list = rows
    .filter(x => x._id !== customerId)
    .map(x => {
      const d = Math.round(haversine(lat, lng, x.lat, x.lng));
      return {
        id: x._id, name: x.nameRaw || x.name || '', phone: x.phone || '', phone2: x.phone2 || '',
        address: x.address || '', dist: d, mallCode: x.mallCode || '',
        customerType: x.customerType || '', source: x.source || '', deleted: !!x.deleted,
        hit: hitOf(x._id)
      };
    })
    .filter(x => x.dist <= R)
    // ⚠️ 按档位排：同号 → 同名 → 疑似 → 其余，档内按距离（复核时最要紧的一眼在最上面）
    .sort((a, b) => (HIT_RANK(a.hit) - HIT_RANK(b.hit)) || (a.dist - b.dist));
  return {
    ok: true, radius: R,
    self: { id: customerId, name, phone, lat, lng },
    list, count: list.length,
    truncated: rows.length >= 300,     // 到上限了 → 可能还有没扫到的
    block, sameName, suspect, dupErr, dupTruncated
  };
}

// 后台管理员改坐标 —— **直接生效**（这是后台管理员本人操作，不走业务员报错那条审核路）
async function updateCustomerCoords(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const la = Number(event.lat), ln = Number(event.lng);
  if (!isFinite(la) || !isFinite(ln)) return { ok: false, code: 'BAD_ARG', msg: '经纬度必须是数字' };
  if (la < -90 || la > 90 || ln < -180 || ln > 180) {
    return { ok: false, code: 'BAD_ARG', msg: '坐标超出范围（纬度 ±90 / 经度 ±180）' };
  }
  const _now = Date.now();
  await db.collection('customers').doc(customerId).update({
    // 2026-09-27 补 updatedAt：增量同步（custSync）靠它判断"这条改过"
    data: { lat: la, lng: ln, coord_status: 'ok', coordSource: 'admin', coordUpdatedAt: _now, updatedAt: _now }
  });
  return { ok: true, lat: la, lng: ln, coordSource: 'admin' };
}

// 编辑态保存客户资料（白名单）
async function updateCustomerFields(event) {
  const { customerId, fields } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  if (!fields || typeof fields !== 'object') return { ok: false, code: 'BAD_ARG', msg: '没有要保存的字段' };
  const data = {};
  EDITABLE_CUST_FIELDS.forEach(k => {
    if (fields[k] !== undefined) data[k] = String(fields[k] == null ? '' : fields[k]).trim().slice(0, 200);
  });
  if (!Object.keys(data).length) return { ok: false, code: 'BAD_ARG', msg: '没有可保存的字段' };
  // ⭐ 2026-10-03：改了店名 → **同时把 nameRaw 一起改**，两处口径必须一致 ——
  //   `nameRaw` 是"原值留底"，但**展示和防重检测读的都是 `nameRaw || name`**；
  //   只改 name 不改 nameRaw 的话，后台显示的还是旧名、防重检测也拿旧名去比（老板刚好同时报这两个问题）。
  if (data.name !== undefined) data.nameRaw = data.name;
  data.updatedAt = Date.now();
  await db.collection('customers').doc(customerId).update({ data });
  return { ok: true, saved: Object.keys(data) };
}

async function verifyAdmin(event) {
  // Web 后台账号密码校验（管理员唯一入口）
  const { username, password } = event;
  if (!username || !password) return null;
  const res = await db.collection('users')
    .where({ username, role: _.in(['super_admin', 'admin']), active: true })
    .get();
  if (!res.data.length) return null;
  const u = res.data[0];
  if (!u.passwordHash || u.passwordHash !== sha256(password)) return null;
  return u;
}

async function login(event) {
  const { username, password } = event;
  if (!username || !password) return { ok: false, code: 'BAD_ARG', msg: '请输入账号和密码' };
  const res = await db.collection('users')
    .where({ username, role: _.in(['super_admin', 'admin']), active: true })
    .get();
  if (!res.data.length) return { ok: false, code: 'NO_USER', msg: '账号不存在' };
  const u = res.data[0];
  if (!u.passwordHash || u.passwordHash !== sha256(password)) {
    return { ok: false, code: 'BAD_PWD', msg: '密码不正确' };
  }
  await db.collection('users').doc(u._id).update({ data: { lastLoginAt: Date.now() } });
  return {
    ok: true,
    admin: { _id: u._id, name: u.name, role: u.role }
  };
}

async function listTasks(event) {
  // 分区（2026-09-08 老板定）：active=当前（草稿/进行中/审核中/已过期未归档）；history=历史（已完成/已归档）；all=全部
  const mode = (event && event.mode) || 'active';
  let rows;
  if (mode === 'history') {
    rows = await fetchAll('tasks', {}, {});
    rows = rows.filter(t => t.status === 'done' || t.archivedAt);
  } else if (mode === 'all') {
    rows = await fetchAll('tasks', {}, {});
  } else {
    rows = await fetchAll('tasks', { status: _.in(['draft', 'published', 'reviewing']), archivedAt: _.exists(false) }, {});
  }
  // 历史按结束（归档/完成）时间倒序；当前按创建时间倒序
  const sortKey = t => (mode === 'history' ? ((t.archivedAt || t.finishedAt || t.createdAt) || 0) : ((t.createdAt) || 0));
  rows.sort((a, b) => sortKey(b) - sortKey(a));
  // 一次批量查 visits（HTTP API 有 5 秒超时，循环 count 会 N+1 超时）
  // 按客户家数去重：同一客户多次拜访只算 1 家；ongoing 拜访中不算
  const tids = rows.map(t => t._id);
  let countMap = {};
  if (tids.length) {
    const visits = await fetchAll('visits', { taskId: _.in(tids), status: _.in(['normal', 'pending_review']) }, { taskId: true, customerId: true });
    const setMap = {};
    visits.forEach(v => {
      if (!setMap[v.taskId]) setMap[v.taskId] = new Set();
      setMap[v.taskId].add(v.customerId);
    });
    Object.keys(setMap).forEach(tid => { countMap[tid] = setMap[tid].size; });
  }
  const tasks = rows.map(t => {
    // 2026-09-08 修复：任务客户在 dayPlan[].customerIds（不在顶层 customerIds）；
    // 补 salesmanId/customerIds/dayPlan 供位置监控客户点按业务员过滤（B 口径）
    const dayPlan = t.dayPlan || [];
    const cids = [];
    dayPlan.forEach(d => (d.customerIds || []).forEach(id => cids.push(id)));
    const total = cids.length;
    return {
      _id: t._id, name: t.name, taskNo: t.taskNo || '', salesmanName: t.salesmanName,
      salesmanId: t.salesmanId || '',
      purpose: t.purpose, deadline: t.deadline, status: t.status,
      startDate: t.startDate || '', plannedDays: t.plannedDays || 1, createdAt: t.createdAt || null,
      finishReq: t.finishReq || null, finishedAt: t.finishedAt || null,
      archivedAt: t.archivedAt || null, endedAt: (t.archivedAt || t.finishedAt || t.createdAt) || null,
      customerIds: cids, dayPlan,
      total, visited: countMap[t._id] || 0,
      percent: total ? Math.round((countMap[t._id] || 0) / total * 100) : 0
    };
  });
  return { ok: true, tasks, mode };
}

// 分页拉全量（云数据库单次 limit 上限 1000；where/field 为空对象时跳过——云开发 where({})/field({}) 非法）
async function fetchAll(coll, where, field) {
  const out = [];
  const PAGE = 1000; // 云函数端单次 limit 上限 1000；大 PAGE 减少往返（导入匹配池全量拉取曾因 100 页导致超时）
  let skip = 0;
  while (true) {
    let q = db.collection(coll);
    if (where && typeof where === 'object' && Object.keys(where).length) q = q.where(where);
    if (field && typeof field === 'object' && Object.keys(field).length) q = q.field(field);
    const r = await q.skip(skip).limit(PAGE).get();
    out.push(...r.data);
    if (r.data.length < PAGE) break;
    skip += PAGE;
  }
  return out;
}

async function getTask(event) {
  const t = await db.collection('tasks').doc(event.taskId).get().catch(() => null);
  if (!t || !t.data) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  const task = t.data;
  const ids = task.customerIds || [];
  let customers = [];
  if (ids.length) {
    const cRes = await db.collection('customers').where({ _id: _.in(ids) }).get();
    const map = {};
    cRes.data.forEach(c => { map[c._id] = c; });
    customers = ids.filter(id => map[id]).map(id => map[id]);
  }
  // 今日拜访状态：已完成→visited；进行中→ongoing；无→pending
  const today = todayStr();
  const vRes = ids.length
    ? await db.collection('visits').where({ customerId: _.in(ids), visitedAt: today }).field({ customerId: true, status: true }).get()
    : { data: [] };
  // 每客户最近一次已完成拜访的结果（该任务内；分页取防超时）
  const resultMap = {};
  if (ids.length) {
    let skip = 0;
    const PAGE = 100;
    while (true) {
      const r = await db.collection('visits')
        .where({ taskId: event.taskId, customerId: _.in(ids), status: _.in(['normal', 'pending_review']) })
        .orderBy('createdAt', 'desc')
        .skip(skip).limit(PAGE).get();
      r.data.forEach(v => { if (!resultMap[v.customerId]) resultMap[v.customerId] = v.result || ''; });
      if (r.data.length < PAGE) break;
      skip += PAGE;
    }
  }
  // 全局拜访次数（客户档案弹窗显示用，2026-09-08）
  const countMap = {};
  if (ids.length) {
    const gv = await fetchAll('visits', { customerId: _.in(ids), status: _.in(['normal', 'pending_review']) }, { customerId: true });
    gv.forEach(v => { countMap[v.customerId] = (countMap[v.customerId] || 0) + 1; });
  }
  // 状态口径（2026-09-03 改）：该任务内有过完成记录→visited（跨天保持已回访）；否则今日进行中→ongoing；否则→pending
  const vMap = {};
  Object.keys(resultMap).forEach(id => { vMap[id] = 'visited'; });
  vRes.data.forEach(v => {
    if (v.status === 'ongoing' && !vMap[v.customerId]) vMap[v.customerId] = 'ongoing';
  });
  // 坐标审核中标记（客户报错待审 → 后台「审核」胶囊）
  const fixSet = {};
  if (ids.length) {
    const fx = await db.collection('coord_fix_requests')
      .where({ customerId: _.in(ids), status: 'pending' })
      .field({ customerId: true })
      .get();
    fx.data.forEach(f => { fixSet[f.customerId] = true; });
  }
  return {
    ok: true,
    task: {
      _id: task._id, name: task.name, taskNo: task.taskNo || '', salesmanId: task.salesmanId, salesmanName: task.salesmanName,
      purpose: task.purpose, deadline: task.deadline, plannedDays: task.plannedDays,
      dayPlan: task.dayPlan || [], status: task.status, createdAt: task.createdAt || null, startDate: task.startDate || '',
      finishedAt: task.finishedAt || null, finishedBy: task.finishedBy || '',
      archivedAt: task.archivedAt || null,
      logs: mergeTaskLogs(task),
      todayDay: dayIndexOf(task.startDate, task.createdAt),
      finishReq: task.finishReq || null
    },
    customers: customers.map(c => ({
      _id: c._id, name: c.name, customerType: c.customerType, address: c.address,
      phone: c.phone, phone2: c.phone2 || '', coord_status: c.coord_status,
      lat: c.lat, lng: c.lng,
      coordFixPending: !!fixSet[c._id],
      visitStatus: vMap[c._id] || 'pending',
      visitResult: resultMap[c._id] || '',
      visitCount: countMap[c._id] || 0, // 全局拜访次数（2026-09-08 弹窗显示）
      mallJoinedAt: c.mallJoinedAt || '', lastOrderAt: c.lastOrderAt || '',
      lastBrowseAt: c.lastBrowseAt || '', mallSalesman: c.mallSalesman || '',
      mallLevel: c.mallLevel || ''
    }))
  };
}

// 东八区今日日期 YYYY-MM-DD（与 visits 云函数同口径）
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 2026-09-11 修复（老板反馈：青恩艳那条任务过期后，流程档案里查不到记录）：
// 「过期」原本只是按 deadline 实时算出来的状态（tasks 的 expired 是现算的），系统里没有任何写入点 → 档案空白。
// 这里由 10 分钟定时器兜底补记一条 expired 日志；用 expiredLoggedAt 做幂等，同一任务只写一次。
// 返回补记条数。调用点=visitTimeoutTick 开头（必须独立于"是否有拜访中"，故放在其 return 之前）。
async function expiredTaskTick() {
  const today = todayStr();
  const rows = await fetchAll('tasks', { status: 'published', archivedAt: _.exists(false) },
    { _id: true, name: true, deadline: true, customerIds: true, salesmanName: true, logs: true, expiredLoggedAt: true });
  const now = Date.now();
  let marked = 0;
  for (const t of rows) {
    if (!t.deadline || String(t.deadline) > today) continue;   // 还没过期
    if (t.expiredLoggedAt) continue;                            // 已记过 → 跳过
    const total = (t.customerIds || []).length;
    const logs = withLog(t, {
      at: now, by: '系统', role: 'system', type: 'expired',
      detail: { deadline: t.deadline, total, taskName: t.name || '' }
    });
    // 2026-09-11（审查发现）：改为【条件更新】——只有"仍未标记"时才写入，天然原子，
    // 避免后台 15 秒轮询与 10 分钟定时器并发时，同一条 expired 日志被重复补记。
    const up = await db.collection('tasks')
      .where({ _id: t._id, expiredLoggedAt: _.exists(false) })
      .update({ data: { logs, expiredLoggedAt: now } });
    if (up && up.stats && up.stats.updated) marked++;
  }
  return marked;
}

// ===== 拜访时长上限 · 动态闹钟（2026-09-08 M1 老板定） =====
// 每 10 分钟定时触发（cron 配置在云开发控制台，见部署说明）：
// ① remindAt 到点且未提醒 → 服务号提醒一次（标记 remindSentAt 防重复）
// ② autoCancelAt 到点 → 双态：有草稿结果→自动提交（跳过距离、无照片录音）；无→自动取消；均写任务 logs + 服务号告知
// ③ 2026-09-11 新增：任务「过期」补记流程档案（老板反馈：过期时档案里没有记录）
async function visitTimeoutTick() {
  const now = Date.now();
  await expiredTaskTick();   // ← ③ 必须独立于"是否有拜访中"，所以放在 return 之前
  const ong = await fetchAll('visits', { status: 'ongoing' }, {});
  if (!ong.length) return;

  for (const v of ong) {
    try {
      if (!v.autoCancelAt) continue;
      const task = await getTaskDoc(v.taskId);
      if (!task) continue;
      const cRes = await db.collection('customers').doc(v.customerId).get().catch(() => null);
      const custName = (cRes && cRes.data && cRes.data.name) || '';
      const notify = () => sendNotify(v.salesmanId, {
        name: task.name || '', taskNo: task.taskNo || '', salesmanName: v.salesmanName || '',
        purpose: task.purpose || 'activate', deadline: task.deadline || '', startDate: task.startDate || '',
        days: task.plannedDays || 1, total: (task.customerIds || []).length, type: 'update'
      });
      const logs = [...(Array.isArray(task.logs) ? task.logs : [])];
      const limitMin = v.startedAt ? Math.max(1, Math.round((v.autoCancelAt - v.startedAt) / 60000)) : 0;
      if (Number(v.autoCancelAt) <= now) {
        const d = v.draft && v.draft.result ? v.draft : null;
        if (d) {
          // 自动提交：ongoing 升级为完成（结果/备注/样品落库；时长=上限；跳过定位校验；无照片录音——老板定稿）
          await db.collection('visits').doc(v._id).update({
            data: {
              status: 'normal', result: d.result, text: d.text || '', samples: d.samples || '',
              durationSeconds: v.startedAt ? Math.round((v.autoCancelAt - v.startedAt) / 1000) : null,
              finishedAt: now, autoSubmitted: true
            }
          });
          logs.push({ at: now, by: '系统', role: 'system', type: 'visitAutoSubmit', detail: { name: custName, result: d.result, limitMin } });
        } else {
          await db.collection('visits').doc(v._id).remove(); // 自动取消：零痕迹（沿用取消口径）
          logs.push({ at: now, by: '系统', role: 'system', type: 'visitAutoCancel', detail: { name: custName, limitMin } });
        }
        // ⭐ 2026-10-04【对抗性检查修】自由拜访：自动提交/自动取消也要重算卡片
        //   —— 否则「已拜访 N 家」会虚高（取消没摘）或偏低（提交没加）。
        //   ⚠️ 上面那条 `_resyncFreeTrip` 在 visits 云函数里，这里是 adminapi，得单独算。
        if (v.freeTripId) await resyncFreeTrip(v.freeTripId).catch(() => {});
        // ⚠️ 2026-10-04【修】自由拜访的 taskId 是空字符串 → `.doc('')` 会抛错，必须判空
        //   （原来每遇到一条自由拜访就抛一次，被下面 catch 吞掉，任务日志整段丢失）
        if (v.taskId) {
          await db.collection('tasks').doc(v.taskId).update({ data: { logs } });
          await notify().catch(() => {});
        }
        // 最新位置状态位同步（2026-09-08 老板定：拜访状态变化必须立即反映到后台；不伪造坐标）
        await db.collection('salesman_locations').doc('latest_' + v.salesmanId).update({ data: { visitOngoing: false } }).catch(() => {});
      } else if (v.remindAt && Number(v.remindAt) <= now && !v.remindSentAt) {
        // 5 分钟前提醒一次
        await notify().catch(() => {});
        await db.collection('visits').doc(v._id).update({ data: { remindSentAt: now } });
      }
    } catch (e) { /* 单条失败继续下一条 */ }
  }
}

// 过期任务自动归档（2026-09-08 老板定：自然完成的进历史；过期达设置档位天数的自动归档终态）
// 档位 settings.expireArchiveDays：2/3/5 天（默认 3）；后台 15 秒轮询静默触发（幂等）
async function autoArchiveExpired(event) {
  const setRes = await db.collection('settings').where({ key: 'expireArchiveDays' }).limit(1).get();
  const raw = Number(setRes.data[0] && setRes.data[0].value) || 3;
  const days = [2, 3, 5].includes(raw) ? raw : 3;
  const cutoff = addDays(todayStr(), -days); // deadline <= cutoff（今天已过 cutoff？）→ 归档
  const rows = await fetchAll('tasks', { status: 'published' }, { _id: true, deadline: true, archivedAt: true, logs: true });
  const now = Date.now();
  let archived = 0;
  for (const t of rows) {
    if (t.archivedAt || !t.deadline || String(t.deadline) > cutoff) continue;
    const logs = withLog(t, { at: now, by: '系统', role: 'system', type: 'archive', detail: { reason: 'expired', deadline: t.deadline } });
    await db.collection('tasks').doc(t._id).update({ data: { archivedAt: now, logs } });
    archived++;
  }
  const tracksCleaned = await cleanExpiredTracks(); // 2026-09-08 M2：轨迹过期清理附带执行
  return { ok: true, archived, cutoff, tracksCleaned };
}

// ===== 位置监控接口（2026-09-08 M2：实时位置/当天轨迹/拜访轨迹回放） =====
async function listLatestLocations() {
  const rows = await fetchAll('salesman_locations', { type: 'latest' }, {});
  return {
    ok: true,
    locations: rows.map(r => ({
      salesmanId: r.salesmanId, name: r.name || '',
      lat: r.lat, lng: r.lng, accuracy: r.accuracy || 0,
      t: r.t || r.updatedAt || 0, visitOngoing: !!r.visitOngoing
    }))
  };
}

async function getDayTrack(event) {
  const { salesmanId, day } = event;
  if (!salesmanId || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { ok: false, code: 'BAD_ARG', msg: '参数不合法' };
  const rows = await fetchAll('salesman_locations', { type: 'track', salesmanId, day: String(day) }, {});
  rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const pts = [];
  rows.forEach(r => (r.pts || []).forEach(p => pts.push(p)));
  return { ok: true, pts };
}

async function getVisitTrack(event) {
  const { visitId } = event;
  if (!visitId) return { ok: false, code: 'BAD_ARG', msg: '缺少拜访记录' };
  const v = await db.collection('visits').doc(visitId).get().catch(() => null);
  if (!v || !v.data) return { ok: false, code: 'NOT_FOUND', msg: '拜访记录不存在' };
  const d = v.data;
  const day = String(d.visitedAt || todayStr());
  const t0 = Number(d.startedAt || 0) - 60000;
  const t1 = Number(d.finishedAt || Date.now()) + 60000;
  const rows = await fetchAll('salesman_locations', { type: 'track', salesmanId: d.salesmanId, day }, {});
  const pts = [];
  rows.forEach(r => (r.pts || []).forEach(p => { if (p.t >= t0 && p.t <= t1) pts.push(p); }));
  return { ok: true, pts };
}

// 轨迹过期清理（2026-09-08 M2：trackKeepDays 设置项，默认 30 天；随 autoArchiveExpired 每日附带执行）
async function cleanExpiredTracks() {
  const tkRes = await db.collection('settings').where({ key: 'trackKeepDays' }).limit(1).get();
  const rawDays = Number(tkRes.data[0] && tkRes.data[0].value) || 30;
  const keep = Math.max(1, Math.min(365, rawDays));
  const cutoff = addDays(todayStr(), -keep);
  const rows = await fetchAll('salesman_locations', { type: 'track', day: _.lte(cutoff) }, { _id: true });
  for (let i = 0; i < rows.length; i += 50) {
    await Promise.all(rows.slice(i, i + 50).map(r => db.collection('salesman_locations').doc(r._id).remove()));
  }
  return rows.length;
}

// ===================== 后台文件分发（2026-09-08 老板定：文员点刷新自动对齐版本号） =====================
// 云端存 {version, adminHtml, ntMapJs}（settings 单文档）；云函数出入参 100KB 限制 → 90KB 分片。
// 上传需鉴权（老板手动触发）；读取免鉴权（代码文件非敏感，文员 server 转发）。
const DIST_CHUNK = 90000;
const DIST_DOC = 'admin_dist';

async function readDist() {
  const r = await db.collection('settings').doc(DIST_DOC).get().catch(() => null);
  return (r && r.data && r.data.value) || null;
}

async function uploadAdminDist(event) {
  const { kind, part, total, content, version } = event;
  if (!['adminHtml', 'ntMapJs'].includes(kind)) return { ok: false, code: 'BAD_ARG', msg: 'kind 不合法' };
  const p = parseInt(part, 10), t = parseInt(total, 10);
  if (!(p >= 0 && t >= 1 && p < t)) return { ok: false, code: 'BAD_ARG', msg: '分片参数不合法' };
  if (typeof content !== 'string' || !content) return { ok: false, code: 'BAD_ARG', msg: '分片内容为空' };
  const prev = (await readDist()) || { version: '', adminHtml: '', ntMapJs: '' };
  if (p === 0) prev[kind] = '';
  prev[kind] += content;
  if (p === t - 1) {
    prev.version = String(version || prev.version || '0.9.00');
    prev.updatedAt = Date.now();
  }
  await db.collection('settings').doc(DIST_DOC).set({ data: { key: 'adminDist', value: prev } });
  return { ok: true, part: p + 1, total: t };
}

async function getAdminDistMeta() {
  const d = await readDist();
  if (!d || !d.adminHtml || !d.ntMapJs) return { ok: false, code: 'NO_DIST', msg: '云端暂无分发文件' };
  return {
    ok: true,
    version: d.version,
    adminHtmlParts: Math.ceil(d.adminHtml.length / DIST_CHUNK),
    ntMapJsParts: Math.ceil(d.ntMapJs.length / DIST_CHUNK)
  };
}

async function getAdminDistPart(event) {
  const { kind, part } = event;
  if (!['adminHtml', 'ntMapJs'].includes(kind)) return { ok: false, code: 'BAD_ARG', msg: 'kind 不合法' };
  const d = await readDist();
  if (!d || !d[kind]) return { ok: false, code: 'NO_DIST', msg: '分片不存在' };
  const p = parseInt(part, 10);
  const chunk = d[kind].slice(p * DIST_CHUNK, (p + 1) * DIST_CHUNK);
  if (!chunk) return { ok: false, code: 'NO_PART', msg: '分片不存在' };
  return { ok: true, kind, part: p, content: chunk };
}

// 日期加 N 天（YYYY-MM-DD → YYYY-MM-DD，UTC 运算避免时区偏差）
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  const p = x => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 今天对应任务第几天（优先 startDate；否则创建日=第 1 天）
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

// 任务编号：区域码-8位混码（如 JH05-42379761）
// 老板口径（2026-09-04 定稿）：JH05=区域码（settings.taskRegionCode 可配置）；混码 = 「年尾数月日5位 ×1000 + 当日序号3位」× 2654435761 取后 8 位
// 说明：混码不可逆（只有我们能后台查库），外人看不出日期与当日任务数量；撞号概率极低，生成时查重顺延
// 样例：60904-001（2026-09-04 第 1 单）→ JH05-42379761
async function genTaskNo() {
  const regRes = await db.collection('settings').where({ key: 'taskRegionCode' }).limit(1).get();
  const region = (regRes.data[0] && String(regRes.data[0].value || '').trim()) || 'JH05';
  const now8 = new Date(Date.now() + 8 * 3600 * 1000);
  const y = now8.getUTCFullYear() % 10; // 年份尾数：2026→6 … 2035→5
  const md = `${String(now8.getUTCMonth() + 1).padStart(2, '0')}${String(now8.getUTCDate()).padStart(2, '0')}`;
  const dateInt = parseInt(`${y}${md}`, 10); // 如 60904
  // 东八区当天 0 点时间戳（createdAt 按此区间统计当日已建任务数）
  const nowMs = Date.now() + 8 * 3600 * 1000;
  const dayStart = Math.floor(nowMs / 86400000) * 86400000 - 8 * 3600 * 1000;
  const dayEnd = dayStart + 86400000;
  const cnt = await db.collection('tasks').where({ createdAt: _.gte(dayStart).and(_.lt(dayEnd)) }).count();
  const seq = cnt.total + 1; // 当日序号
  const N = dateInt * 1000 + seq; // 如 60904001
  // 防重：撞号顺延，最多 5 次后兜底用毫秒尾数（乘法超 Number 精度，用 BigInt）
  for (let i = 0; i < 5; i++) {
    const X = Number((BigInt(N) * 2654435761n + BigInt(i)) % 100000000n);
    const no = `${region}-${String(X).padStart(8, '0')}`;
    const dup = await db.collection('tasks').where({ taskNo: no }).count();
    if (!dup.total) return no;
  }
  return `${region}-${String(Date.now() % 100000000).padStart(8, '0')}`;
}

async function createTask(event) {
  const { name, salesmanId, customerIds, deadline, plannedDays, purpose, startDate, status, dayGroups, dayRoutes, batchId } = event;
  if (!name || !salesmanId || !Array.isArray(customerIds) || !customerIds.length) {
    return { ok: false, code: 'BAD_ARG', msg: '任务名称/业务员/客户不能为空' };
  }
  if (batchId) {
    await ensureBatchColls();
    const b = await db.collection('customer_batches').doc(batchId).get().catch(() => null);
    if (!b || !b.data) return { ok: false, code: 'NOT_FOUND', msg: '客户批次不存在，请刷新后重试' };
  }
  const salesRes = await db.collection('users').doc(salesmanId).get().catch(() => null);
  // ⭐ 2026-09-30：**老板兼业务员**（alsoSalesman）也可以被派单（他按真业务员算，与 listSalesmen 同口径）
  if (!salesRes || !salesRes.data || (salesRes.data.role !== 'salesman' && salesRes.data.alsoSalesman !== true)) {
    return { ok: false, code: 'BAD_SALESMAN', msg: '业务员不存在' };
  }
  const sm = salesRes.data;

  const days = Math.min(7, Math.max(1, parseInt(plannedDays, 10) || 1));
  // 开始日期 = 任务第 1 天（默认今天；表单默认明天）；截止日期 = 开始日期 + 天数（自动计算，忽略传入值）
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) ? String(startDate) : todayStr();
  const deadlineCalc = addDays(start, days);
  // 排期：地图选店传入 dayGroups（每天客户 id 数组，尊重选择/排序顺序）；缺省回退平均分摊
  // dayRoutes（2026-09-08 手机地图页）：每天规划路线 {pts[[lat,lng]],distanceMeters,durationMin} 或 null（未规划→手机端直线兜底）
  const normRoute = r => {
    if (!r || !Array.isArray(r.pts) || !r.pts.length) return null;
    const pts = r.pts.slice(0, 800).map(p => (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') ? [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))] : null).filter(Boolean);
    return pts.length ? { pts, distanceMeters: Number(r.distanceMeters) || null, durationMin: Number(r.durationMin) || null } : null;
  };
  let dayPlan = [];
  if (Array.isArray(dayGroups) && dayGroups.length === days && dayGroups.every(g => Array.isArray(g)) &&
      dayGroups.flat().length === customerIds.length && dayGroups.flat().every(id => customerIds.includes(id))) {
    dayPlan = dayGroups.map((g, i) => ({ day: i + 1, customerIds: g, route: normRoute(Array.isArray(dayRoutes) ? dayRoutes[i] : null) }));
  } else {
    for (let d = 0; d < days; d++) {
      const startIdx = Math.floor(d * customerIds.length / days);
      const endIdx = Math.floor((d + 1) * customerIds.length / days);
      dayPlan.push({ day: d + 1, customerIds: customerIds.slice(startIdx, endIdx), route: null });
    }
  }

  const isDraft = event.status === 'draft';
  const taskNo = await genTaskNo();
  const logs = [{
    at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'create',
    detail: { name: String(name).trim(), days, startDate: start, deadline: deadlineCalc, purpose: purpose || 'activate', customerCount: customerIds.length, batchId: batchId || '' }
  }];
  const add = await db.collection('tasks').add({
    data: {
      name,
      taskNo,
      salesmanId: sm._id,
      salesmanName: sm.name,
      customerIds,
      startDate: start,
      deadline: deadlineCalc,
      status: isDraft ? 'draft' : 'published',
      plannedDays: days,
      dayPlan,
      purpose: purpose || 'activate',
      batchId: batchId || null,
      sentAt: isDraft ? null : Date.now(),
      createdAt: Date.now(),
      createdBy: event._admin && event._admin.name,
      logs
    }
  });

  // 发布：全局状态由 tasks 实时推导（两层状态模型 2026-09-07），无需写任何状态字段

  // 草稿不通知；发布才推送（尽力而为：失败不影响任务）；发送事件留痕（含通知渠道）
  let notify = null;
  if (!isDraft) {
    notify = await sendNotify(sm._id, {
      name, taskNo, salesmanName: sm.name, purpose: purpose || 'activate', deadline: deadlineCalc,
      startDate: start, days, total: customerIds.length, type: 'new'
    });
    await db.collection('tasks').doc(add._id).update({
      data: { logs: withLog({ logs }, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'send', detail: { channel: (notify && notify.channel) || 'none' } }) }
    });
  }

  return { ok: true, taskId: add._id, taskNo, status: isDraft ? 'draft' : 'published', notify };
}

// ===== 任务操作（编辑/延期/改派/撤回/删除/复制，均留痕） =====
async function getTaskDoc(taskId) {
  const r = await db.collection('tasks').doc(taskId).get().catch(() => null);
  return r && r.data;
}

// ===== 流程流水（2026-09-08 历史任务板块）：统一 logs 事件 {at, by, role, type, detail}
// type: create|send|edit|extend|reassign|withdraw|finishReq|reviewApprove|reviewReject|autoDone
// 旧 editLog/extendLog/reassignLog/withdrawLog 只读保留，getTask 时 mergeTaskLogs 合并成一条时间线
function withLog(t, evt) {
  return [...(Array.isArray(t.logs) ? t.logs : []), evt];
}
function evtNow(admin, type, detail) {
  return { at: Date.now(), by: (admin && admin.name) || '系统', role: 'admin', type, detail: detail || {} };
}
function mergeTaskLogs(t) {
  const out = [];
  const push = (at, by, type, detail) => {
    if (at) out.push({ at: Number(at), by: by || '系统', role: 'admin', type, detail: detail || {} });
  };
  (t.editLog || []).forEach(x => push(x.at, x.by, 'edit', { name: x.name, startDate: x.startDate, plannedDays: x.plannedDays }));
  (t.extendLog || []).forEach(x => push(x.at, x.by, 'extend', { from: x.from || '', to: x.to || '' }));
  (t.reassignLog || []).forEach(x => push(x.at, x.by, 'reassign', { from: x.from || '', to: x.to || '' }));
  (t.withdrawLog || []).forEach(x => push(x.at, x.by, 'withdraw', {}));
  (t.logs || []).forEach(x => { if (x && x.at) out.push(x); });
  return out.sort((a, b) => a.at - b.at);
}

function buildDayPlan(customerIds, days) {
  const plan = [];
  for (let d = 0; d < days; d++) {
    const s = Math.floor(d * customerIds.length / days);
    const e = Math.floor((d + 1) * customerIds.length / days);
    plan.push({ day: d + 1, customerIds: customerIds.slice(s, e) });
  }
  return plan;
}

async function editTask(event) {
  const { taskId, name, startDate, plannedDays } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (!['published', 'draft'].includes(t.status)) return { ok: false, code: 'STATE', msg: '当前状态不可编辑' };
  if (!name || !String(name).trim()) return { ok: false, code: 'BAD_ARG', msg: '请填写任务名称' };
  // 天数锁定（2026-09-08 老板定）：编辑任务不可修改天数；被绕过时统一拒绝
  const reqDays = parseInt(plannedDays, 10);
  if (reqDays && reqDays !== (t.plannedDays || 1)) {
    return { ok: false, code: 'NO_DAY_EDIT', msg: '编辑任务不支持修改天数（天数不可改，如需调整请新建任务）' };
  }
  const days = t.plannedDays || 1;
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) ? String(startDate) : (t.startDate || todayStr());
  const deadline = addDays(start, days);
  // 天数不变：保留原 dayPlan（分组与路线不被重建/丢失）
  const dayPlan = (Array.isArray(t.dayPlan) && t.dayPlan.length) ? t.dayPlan : buildDayPlan(t.customerIds || [], days);
  const logs = withLog(t, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'edit', detail: { from: { name: t.name || '', startDate: t.startDate || '', plannedDays: t.plannedDays || 0 }, to: { name: String(name).trim(), startDate: start, plannedDays: days } } });
  await db.collection('tasks').doc(taskId).update({
    data: { name: String(name).trim(), startDate: start, plannedDays: days, deadline, dayPlan, logs }
  });
  let notify = null;
  if (t.status === 'published') {
    notify = await sendNotify(t.salesmanId, { name: String(name).trim(), taskNo: t.taskNo, salesmanName: t.salesmanName, purpose: t.purpose || 'activate', deadline, startDate: start, days, total: (t.customerIds || []).length, type: 'update' });
  }
  return { ok: true, notify };
}

// 改期（2026-09-08 老板定）：改变任务开始日期 → 截止日按同公式重算、dayPlan 天数序号不变
// （手机端天页签日期/今天对应第几天均由 startDate 动态推算，自动对齐）；
// 已过期任务改到未来自动恢复执行；日志 resched 留痕；published 推送更新通知。
async function rescheduleTask(event) {
  const { taskId, startDate } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (!['published', 'draft'].includes(t.status)) return { ok: false, code: 'STATE', msg: '当前状态不可改期' };
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) ? String(startDate) : '';
  if (!start) return { ok: false, code: 'BAD_ARG', msg: '请选择新的开始日期' };
  if (start === (t.startDate || '')) return { ok: false, code: 'SAME', msg: '开始日期未变化' };
  const days = t.plannedDays || 1;
  const deadline = addDays(start, days);
  const logs = withLog(t, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'resched', detail: { from: t.startDate || '', to: start, deadline, days } });
  await db.collection('tasks').doc(taskId).update({
    data: { startDate: start, deadline, logs }
  });
  let notify = null;
  if (t.status === 'published') {
    notify = await sendNotify(t.salesmanId, { name: t.name, taskNo: t.taskNo, salesmanName: t.salesmanName, purpose: t.purpose || 'activate', deadline, startDate: start, days, total: (t.customerIds || []).length, type: 'update' });
  }
  return { ok: true, notify, deadline };
}

async function extendTask(event) {
  const { taskId, newDeadline } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status !== 'published') return { ok: false, code: 'STATE', msg: '仅进行中的任务可延期' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(newDeadline || ''))) return { ok: false, code: 'BAD_ARG', msg: '请选择新截止日期' };
  const logs = withLog(t, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'extend', detail: { from: t.deadline || '', to: newDeadline } });
  await db.collection('tasks').doc(taskId).update({ data: { deadline: newDeadline, logs } });
  const notify = await sendNotify(t.salesmanId, { name: t.name, taskNo: t.taskNo, salesmanName: t.salesmanName, purpose: t.purpose || 'activate', deadline: newDeadline, startDate: t.startDate, days: t.plannedDays, total: (t.customerIds || []).length, type: 'update' });
  return { ok: true, notify };
}

async function reassignTask(event) {
  const { taskId, newSalesmanId } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (!['published', 'draft'].includes(t.status)) return { ok: false, code: 'STATE', msg: '当前状态不可改派' };
  if (!newSalesmanId) return { ok: false, code: 'BAD_ARG', msg: '请选择新业务员' };
  if (newSalesmanId === t.salesmanId) return { ok: false, code: 'SAME', msg: '已是该业务员的任务' };
  const smRes = await db.collection('users').doc(newSalesmanId).get().catch(() => null);
  const sm = smRes && smRes.data;
  if (!sm || (sm.role !== 'salesman' && sm.alsoSalesman !== true) || sm.active === false) return { ok: false, code: 'BAD_SALESMAN', msg: '业务员不存在或已停用' };
  const busy = await db.collection('tasks').where({ salesmanId: newSalesmanId, status: _.in(['published', 'reviewing']) }).count();
  if (busy.total > 0) return { ok: false, code: 'HAS_TASK', msg: '该业务员已有进行中任务，不能接改派' };
  const logs = withLog(t, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'reassign', detail: { from: t.salesmanName || '', to: sm.name } });
  await db.collection('tasks').doc(taskId).update({
    data: { salesmanId: sm._id, salesmanName: sm.name, logs }
  });
  let notify = null;
  if (t.status === 'published') {
    notify = await sendNotify(sm._id, { name: t.name, taskNo: t.taskNo, salesmanName: sm.name, purpose: t.purpose || 'activate', deadline: t.deadline || '', startDate: t.startDate, days: t.plannedDays, total: (t.customerIds || []).length, type: 'new' });
  }
  return { ok: true, notify };
}

// 清理任务内残留的「拜访中」记录（2026-09-06 老板定：撤回/删除任务时清除，防止悬挂拜访中；
// 已完成的拜访记录保留）
async function purgeOngoingOfTask(taskId) {
  const ongs = await fetchAll('visits', { taskId, status: 'ongoing' }, { _id: true });
  const BATCH = 50;
  for (let i = 0; i < ongs.length; i += BATCH) {
    await Promise.all(ongs.slice(i, i + BATCH).map(v => db.collection('visits').doc(v._id).remove()));
  }
  return ongs.length;
}

async function withdrawTask(event) {
  const { taskId } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status !== 'published') return { ok: false, code: 'STATE', msg: '仅进行中的任务可撤回' };
  const logs = withLog(t, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'withdraw', detail: {} });
  await db.collection('tasks').doc(taskId).update({ data: { status: 'draft', logs } });
  await purgeOngoingOfTask(taskId);
  return { ok: true };
}

async function deleteTask(event) {
  const { taskId } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status !== 'draft') return { ok: false, code: 'STATE', msg: '仅草稿可删除' };
  await purgeOngoingOfTask(taskId);
  await db.collection('tasks').doc(taskId).remove();
  return { ok: true };
}

// 草稿发送：draft → published，推送给业务员（发送事件留痕含通知渠道；不再重置 createdAt——创建时间保持真实，2026-09-08）
async function sendTask(event) {
  const { taskId } = event;
  const t = await getTaskDoc(taskId);
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status !== 'draft') return { ok: false, code: 'STATE', msg: '仅草稿可发送' };
  if (!t.salesmanId) return { ok: false, code: 'BAD_ARG', msg: '草稿缺少业务员，请先编辑' };
  const notify = await sendNotify(t.salesmanId, { name: t.name, taskNo: t.taskNo, salesmanName: t.salesmanName, purpose: t.purpose || 'activate', deadline: t.deadline || '', startDate: t.startDate, days: t.plannedDays, total: (t.customerIds || []).length, type: 'new' });
  const logs = withLog(t, { at: Date.now(), by: (event._admin && event._admin.name) || '系统', role: 'admin', type: 'send', detail: { channel: (notify && notify.channel) || 'none' } });
  await db.collection('tasks').doc(taskId).update({
    data: { status: 'published', sentAt: Date.now(), createdBy: (event._admin && event._admin.name) || t.createdBy, logs }
  });
  return { ok: true, notify };
}

// 任务通知：优先服务号模板消息（长期免授权，§7.6）；失败/未绑定回退小程序一次性订阅
async function sendNotify(salesmanId, info) {
  const mp = await sendMpMessage(salesmanId, info);
  if (mp.sent) return { sent: true, channel: 'mp', msgid: mp.msgid };
  const sub = await sendSubMessage(salesmanId, info);
  if (sub.sent) return { sent: true, channel: 'subscribe' };
  return {
    sent: false,
    channel: null,
    msg: `服务号：${mp.msg || '未启用'}；订阅消息：${sub.msg || '未授权'}`
  };
}

// ===== 服务号模板消息（公众号） =====
// 收件人：users.mpOpenid（老板在后台「人员管理」绑定；openid 取自公众平台用户列表）
async function sendMpMessage(salesmanId, info) {
  try {
    const cfg = await getMpConfig();
    if (!cfg || !cfg.enabled) return { sent: false, msg: '服务号通知未启用' };
    if (!cfg.appid || !cfg.appsecret || !cfg.templateId) return { sent: false, msg: '服务号配置不完整（AppID/AppSecret/模板ID）' };
    const smRes = await db.collection('users').doc(salesmanId).get().catch(() => null);
    const sm = smRes && smRes.data;
    if (!sm || !sm.mpOpenid) return { sent: false, msg: '业务员未绑定服务号 OpenID' };
    const token = await getMpAccessToken(cfg);
    const r = await mpRequest(`/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
      touser: sm.mpOpenid,
      template_id: cfg.templateId,
      data: buildMpData(info)
    });
    if (r && r.errcode === 0) return { sent: true, msgid: r.msgid };
    return { sent: false, msg: `发送失败 errcode=${r && r.errcode} ${(r && r.errmsg) || ''}` };
  } catch (e) {
    return { sent: false, msg: e.message || String(e) };
  }
}

async function getMpConfig() {
  const res = await db.collection('settings').where({ key: 'mpConfig' }).limit(1).get();
  const info = res.data[0];
  return info ? info.value : null;
}

// 服务号 access_token（缓存 settings.mpAccessToken；失败抛错并附微信原始 errcode/errmsg 便于诊断）
async function getMpAccessToken(cfg) {
  const res = await db.collection('settings').where({ key: 'mpAccessToken' }).limit(1).get();
  const cur = res.data[0];
  if (cur && cur.value && cur.value.token && Number(cur.value.expiresAt) > Date.now() + 300000) {
    return cur.value.token;
  }
  const r = await mpRequest(`/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appid)}&secret=${encodeURIComponent(cfg.appsecret)}`, null, 'GET');
  if (!r || !r.access_token) {
    const e = new Error(`服务号 access_token 获取失败：errcode=${r && r.errcode} ${(r && r.errmsg) || '接口无响应'}（若为 40164：请在后台重新登录触发 token 同步，或清空服务号 IP 白名单）`);
    e.errcode = r && r.errcode;
    e.errmsg = (r && r.errmsg) || '接口无响应';
    throw e;
  }
  const data = { key: 'mpAccessToken', value: { token: r.access_token, expiresAt: Date.now() + ((r.expires_in || 7200) - 300) * 1000 }, updatedAt: Date.now() };
  if (cur) await db.collection('settings').doc(cur._id).update({ data });
  else await db.collection('settings').add({ data });
  return r.access_token;
}

// 微信接口请求（云函数直连 api.weixin.qq.com）
function mpRequest(pathWithQuery, body, method) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request(MP_API + pathWithQuery, {
      method: method === 'GET' ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('微信接口返回非 JSON：' + buf.slice(0, 200))); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('微信接口请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 服务号模板字段映射（2026-09-05 重新配置 5 词，实测探测确认，模板 kdgr7e7C-…zzmZMeFyFhAySs0XUk8VdDf4）：
// character_string1=订单编号(任务编号)、thing2=服务人员(业务员姓名)、thing6=服务用户(任务名称)、time5=服务时间(开始日期)、thing7=地点(共X家客户，X天时长，请及时完成)
// thing 类 ≤20 字；勿增删字段（多余/缺失都报 47003）
function buildMpData(info) {
  const limit20 = s => String(s || '').slice(0, 20);
  const startText = (info.startDate && /^\d{4}-\d{2}-\d{2}/.test(String(info.startDate))) ? info.startDate + ' 00:00' : '';
  // 地点行文案（方案 B）：共X家客户，X天时长，X月X日开始（thing ≤20 字）
  const m = String(info.startDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const startMD = m ? `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日` : '';
  const tip = `共${info.total || 0}家客户，${info.days || 1}天时长${startMD ? '，' + startMD + '开始' : ''}`;
  return {
    character_string1: { value: String(info.taskNo || '').slice(0, 30) },
    thing2: { value: limit20(info.salesmanName || '') },
    thing6: { value: limit20(info.name) },
    time5: { value: startText },
    thing7: { value: String(tip).slice(0, 20) }
  };
}

// 小程序一次性订阅消息（原有逻辑；服务号不可用时回退）
async function sendSubMessage(salesmanId, info) {
  try {
    // 1) 订阅授权凭证（一次性）
    const tokenRes = await db.collection('settings').where({ key: `subToken_${salesmanId}` }).get();
    const tokenInfo = tokenRes.data[0];
    if (!tokenInfo || !tokenInfo.value || !tokenInfo.value.token) return { sent: false, msg: '业务员未授权订阅，任务已创建但未推送' };
    // 2) 收件人 openid：从业务员账号取（subscribe 存的 token 里没有 openid）
    const smRes = await db.collection('users').doc(salesmanId).get().catch(() => null);
    const openid = smRes && smRes.data && smRes.data.openid;
    if (!openid) return { sent: false, msg: '业务员微信未绑定，任务已创建但未推送' };

    // 字段映射（2026-09-02 按模板详情实况修正）：
    // 客户姓名=thing1 任务名；申请时间=time4 发布时间；服务项目=thing5 目的；完成时间=time6 截止日；温馨提示=thing7 动态文案
    const pad = n => String(n).padStart(2, '0');
    const fmtTime = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const limit20 = s => String(s || '').slice(0, 20);
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    // 完成时间必须是合法时间格式：有截止日用截止日 23:59，否则用 7 天后
    let deadlineText;
    if (info.deadline && /^\d{4}-\d{2}-\d{2}/.test(info.deadline)) {
      deadlineText = info.deadline + ' 23:59';
    } else {
      const d7 = new Date(Date.now() + 7 * 86400 * 1000);
      deadlineText = `${d7.getFullYear()}-${pad(d7.getMonth() + 1)}-${pad(d7.getDate())} 23:59`;
    }
    const tip = info.type === 'update' ? '任务已更新，请查看最新计划' : `新任务已发，共${info.total}家客户`;
    // 拜访目的中文名（2026-09-07 老板定：回访三种 = 激活增单/走访维护/活动推广）
    const PURP_CN = { activate: '激活增单', maintain: '走访维护', promote: '活动推广', develop: '新客开发' };
    const data = {
      thing1: { value: limit20(info.name) },
      time4: { value: fmtTime(now) },
      thing5: { value: PURP_CN[info.purpose] || '回访' },
      time6: { value: deadlineText },
      thing7: { value: limit20(tip) }
    };
    const r = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: TEMPLATE_ID,
      page: 'pages/home/home',
      data,
      miniprogramState: 'developer'
    });
    // 一次性订阅：发送成功后凭证即失效，删除记录避免二次使用
    await db.collection('settings').doc(tokenInfo._id).remove();
    return { sent: true, errcode: r.errcode };
  } catch (e) {
    // 模板字段标识未知：记录但不影响任务创建
    return { sent: false, msg: '推送失败（模板字段待核对）：' + (e.errMsg || e.message || e) };
  }
}

async function listCustomers(event) {
  // ⭐ 2026-09-26 改造（老板定：库里要从 463 家涨到 6 万家）：**按范围 + 分页取**，不再全量拉。
  //    原做法是全量 fetchAll（6 万家 ≈ 145MB 返回体）→ 云函数必超时、后台客户页打不开。
  //    范围 = 城市 / 区域 / 商圈（三层入口）+ 关键词搜索；**搜索范围就是当前选中的范围**。
  //    批次模式（batchId）保留：批内成员先取集合，再按范围过滤（批内数量级可控）。
  await ensureBatchColls();
  const ev = event || {};
  const { batchId } = ev;
  const size = Math.min(Math.max(parseInt(ev.pageSize, 10) || 50, 1), 200);
  const pg = Math.max(parseInt(ev.page, 10) || 1, 1);

  // ⭐ 2026-09-29 回收站：**已删客户不进任何客户列表**
  //   （批次模式下面用 `Object.assign({_id:...}, where)` 反查，也会自动带上这一条）
  const where = Object.assign({}, NOT_DELETED);
  if (ev.city) where.city = String(ev.city);
  if (ev.district) where.district = String(ev.district);
  if (ev.bizCircle) where.bizCircle = String(ev.bizCircle);
  if (ev.q) {
    const esc = String(ev.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40);
    if (esc) where.name = db.RegExp({ regexp: esc, options: 'i' });   // 模糊匹配店名
  }

  let rows = [], total = 0;
  if (batchId) {
    // 批次模式：先取批内成员集合，再按范围过滤。
    // ⚠️ **批次模式不分页**（2026-09-26）：批内客户可控（几十~几千），而且「批次详情页」「未分批页」
    //    前端自己按 20 条/页翻，靠的是**拿全**再本地分页 —— 这里若也切页会把批次客户截断。
    const members = await fetchAll('batch_members', { batchId }, { customerId: true });
    const set = new Set(members.map(m => m.customerId));
    if (set.size) {
      // ⚠️ 2026-09-27 修 -601008（第三处）：原写法是"全量拉 customers 再按批内成员过滤"——
      //    导入 6 万家后 = 61 次串行请求 → **批次详情必超时，而且跟批次大小无关**（40 人的小批次也照样挂，
      //    因为它要先拉全库）。现改为**用批内成员 id 反查**（_.in 每片 100 个，分片查完合并），
      //    走 _id 索引，40 人的批次就是 1 次查询。
      const idArr = [...set];
      const ID_CHUNK = 100;
      const collected = [];
      for (let i = 0; i < idArr.length; i += ID_CHUNK) {
        const w = Object.assign({ _id: _.in(idArr.slice(i, i + ID_CHUNK)) }, where);
        const part = await fetchAll('customers', w, {});
        for (const c of part) collected.push(c);
      }
      collected.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      total = collected.length;
      rows = collected;
    }
  } else {
    const cnt = await db.collection('customers').where(where).count().catch(() => ({ total: 0 }));
    total = cnt.total || 0;
    const r = await db.collection('customers').where(where)
      .orderBy('createdAt', 'desc').skip((pg - 1) * size).limit(size).get().catch(silentCatch('adminapi·for', { data: [] }));
    rows = r.data || [];
  }
  const ids = rows.map(c => c._id);
  // 两层状态模型（2026-09-07 老板定稿）：全局状态=任务中/无任务（实时推导，跨批次统一）；
  // 任务内状态（待回访/拜访中/已回访）按客户当前所在任务推导（2026-09-08 弹窗显示用）。
  // 另附 visitCount（全局拜访次数）与 lastVisitAt（最近拜访日期）
  const stateMap = {};
  const taskMap = {};     // customerId -> 当前任务 taskId（published/reviewing 中任选一个）
  const lastVisitMap = {};
  const countMap = {};
  // 2026-09-25 老板定（报障：c26 实际最新订单是 9-24，客户列表却显示 8-12）：
  // 「最近下单」**必须以实际订单为准**，不能再取商城客户表里的 lastOrderAt
  //（那是商城系统记账的值，与后来导入的销售订单不同步，有时还差一天）。
  // ⭐ 2026-09-26：改成**只查当前页这批客户的订单**（customerCode in 查），库里 6 万家也不怕。
  const codes = rows.map(c => String(c.mallCode || '').trim()).filter(Boolean);
  const oAll = codes.length
    ? await fetchAll('orders', { customerCode: _.in(codes) }, { customerCode: true, orderedAt: true, actualAmount: true })
    : [];
  const lastOrderMap = {};
  // 2026-09-25 老板定：批次详情页要加「**订单总数**」列（同样可排序）→ 顺手在同一个循环里按店号计数。
  // ⚠️ 注意：这里算的是**实际订单条数**，跟客户档案里的 `orderCount`（商城表的「购买次数」）是两码事。
  const orderCountMap = {};
  // ⭐ 2026-09-26 老板定：再加「**订单总额**」（放在订单总数右边）。
  //   金额口径与客户详情页的 `orderAmountSum` **保持一致**：累加 `actualAmount`（实际金额）。
  const orderAmountMap = {};
  oAll.forEach(o => {
    const code = String(o.customerCode || '').trim();
    if (code) {
      orderCountMap[code] = (orderCountMap[code] || 0) + 1;
      orderAmountMap[code] = (orderAmountMap[code] || 0) + (Number(o.actualAmount) || 0);
    }
    const d = String(o.orderedAt || '').slice(0, 10);
    if (!code || !d) return;
    if (!lastOrderMap[code] || d > lastOrderMap[code]) lastOrderMap[code] = d;
  });
  const today = todayStr();
  const vAll = ids.length
    ? await fetchAll('visits', { customerId: _.in(ids) }, { customerId: true, taskId: true, status: true, visitedAt: true })
    : [];
  vAll.forEach(v => {
    if (v.status !== 'normal' && v.status !== 'pending_review') return;
    countMap[v.customerId] = (countMap[v.customerId] || 0) + 1;
    if (!lastVisitMap[v.customerId] || String(v.visitedAt || '') > String(lastVisitMap[v.customerId])) {
      lastVisitMap[v.customerId] = v.visitedAt || '';
    }
  });
  // 任务：只拉"进行中"的（published/reviewing，总量可控），再在内存里匹配当前页客户
  const tAll = await fetchAll('tasks', { status: _.in(['published', 'reviewing']) },
    { customerIds: true, status: true, deadline: true });
  tAll.forEach(t => {
    if (t.status !== 'published' && t.status !== 'reviewing') return;
    // 2026-09-24 修复（老板报障：任务已过期，客户详情/批次列表仍显示「任务中」+ 任务状态）：
    // 原逻辑只看 status，没看截止日 —— 而"过期"是按 deadline **实时算**的，tasks.status 并不会被改，
    // 所以过期任务的客户一直被当成"任务中"。这里与 expiredTaskTick 用同一口径：deadline <= today 即已过期。
    if (t.deadline && String(t.deadline) <= today) return;
    (t.customerIds || []).forEach(id => { stateMap[id] = 'in_task'; if (!taskMap[id]) taskMap[id] = t._id; });
  });
  // 任务内状态：该客户当前任务内有完成记录→visited；否则今日 ongoing→ongoing；否则 pending
  const taskDoneSet = new Set();
  const taskOngSet = new Set();
  vAll.forEach(v => {
    if (!v.taskId || taskMap[v.customerId] !== v.taskId) return;
    if (v.status === 'normal' || v.status === 'pending_review') taskDoneSet.add(v.customerId);
    else if (v.status === 'ongoing' && v.visitedAt === today) taskOngSet.add(v.customerId);
  });
  // 坐标审核中标记（只查当前页客户）
  const fixSet = {};
  if (ids.length) {
    const fx = await fetchAll('coord_fix_requests', { customerId: _.in(ids), status: 'pending' },
      { customerId: true, status: true });
    fx.forEach(f => { fixSet[f.customerId] = true; });
  }
  return {
    ok: true,
    total, page: pg, pageSize: size, totalPages: Math.max(1, Math.ceil(total / size)),
    customers: rows.map(c => ({
      _id: c._id, name: c.name, customerType: c.customerType, address: c.address,
      phone: c.phone, phone2: c.phone2 || '', lat: c.lat, lng: c.lng, coord_status: c.coord_status,
      // ⚠️ 2026-09-25 补 4 个字段（此处是**手工逐个组装**，不补前端就拿不到）：
      //   nameRaw  = 导入时保留的原值「编号 + 店名」（如 `a101 沙县小吃(市场路店)`）→ 前端"店名带编号"就用它
      //   mallCode = **客户编号**（`a101` / `c350`）—— ⚠️ 别和 mallKey 搞混：那是 22 位商城内部系统 Key
      //   salesman / level = 业务负责人（原值）与商城等级 —— 新数据的字段名是这两个，
      //                      原先只返回 mallSalesman/mallLevel → 与数据对不上，详情页那两行一直是空的（本次一并修）
      nameRaw: c.nameRaw || '', mallCode: c.mallCode || '',
      // ⭐ 2026-09-26 三层骨架（📍 地域管理页要用）：城市 / 区域 / 商圈
      city: c.city || '', district: c.district || '', bizCircle: c.bizCircle || '',
      salesman: c.salesman || '', level: c.level || '',
      mallJoinedAt: c.mallJoinedAt || null,
      // 2026-09-25 新增：**订单总数**（实际订单条数；批次详情页的新列，可排序）
      orderCount: orderCountMap[String(c.mallCode || '').trim()] || 0,
      // ⚠️ 2026-09-25 老板定：「最近下单」**以实际订单为准**（lastOrderMap 是 orders 聚合出的每个店号最新下单日）；
      //    完全没订单的客户，才回落到商城客户表带来的 lastOrderAt 兜底。
      lastOrderAt: lastOrderMap[String(c.mallCode || '').trim()] || c.lastOrderAt || '',
      lastBrowseAt: c.lastBrowseAt || '',
      mallSalesman: c.mallSalesman || c.salesman || '', mallLevel: c.mallLevel || c.level || '',
      status: c.status,
      region: c.region || '',
      batchIds: Array.isArray(c.batchIds) ? c.batchIds : [],
      remark: c.remark || '',
      coordFixPending: !!fixSet[c._id],
      // ⭐ 2026-09-26 补：**坐标来源**（前端要显示 商城/平台/采集/修改/待审核）—— 此处手工逐字段组装，不补前端就拿不到
      coordSource: c.coordSource || '',
      visitState: stateMap[c._id] || 'free', // 全局状态：in_task 任务中 / free 无任务
      visitStatus: stateMap[c._id] === 'in_task' ? (taskDoneSet.has(c._id) ? 'visited' : (taskOngSet.has(c._id) ? 'ongoing' : 'pending')) : '', // 任务内三态（仅任务中）
      visitCount: countMap[c._id] || 0, // 全局拜访次数
      lastVisitAt: lastVisitMap[c._id] || '',
      // ⭐ 2026-09-26 新增：**订单总额**（累加 actualAmount，口径与客户详情页的 orderAmountSum 一致）
      orderAmountSum: orderAmountMap[String(c.mallCode || '').trim()] || 0
    }))
  };
}

// ⭐ 2026-09-27 老板定（**一次性 + 幂等**）：把平台（点评）的信息补进**顶层字段**。
//   背景：点评导入是“已有值让位”（见 importdata），而且平台的电话/地址原先**只写进嵌套的 `plat` 块**，
//         → 老板报障“导入了平台信息，客户详情里却看不到地址/电话”。
//   ⚠️ **两个字段规则不同，别搞混**：
//     · `address`  —— **谁详细用谁**（`plat.addr` 比现有更长才覆盖）；
//     · `phone` / `phone2` —— **商城优先**（**只在顶层为空时**才用平台的；老板原话“两个都有就用商城的”）。
//   入参：`{ dry: true }` 只统计不写；`{ offset, limit }` **分批**（⚠️ 云函数 20~30 秒就超时，**必须分批** —— 见 backfillGeo 的同一条教训）。
//   调用方循环：拿返回的 `nextOffset` 继续调，直到 `done: true`。
//   ⭐ **一键脚本**：`node admin\tools\backfill_address_loop.js`（自动循环 + 进度；加 `--dry` 先干跑）
// ⭐ 2026-10-04 新增（修老板报障）：**修复被覆盖的 platMatched**
//   现象：后台客户详情页「📊 平台口碑」整卡不显示（只剩菜品），例 C1534 大铁牛螺蛳粉(古山店)。
//   库内 `plat.rating` / `plat.avgPriceText` / `plat.dishes` 全都躺着，**唯独 `platMatched` 是 false**。
//   根因：`import_excel.py` 的**商城路径** `build_customers` 在"没匹配上点评"时写 `platMatched: false`，
//     而商城导入走 **overwrite** 模式 → `upsertOne` 对非空字段一律照写（**布尔 false 不算空值**）→
//     把点评路径刚写好的 `true` 冲掉；同一 payload 里的 `plat: {}` 被 `isEmptyVal`（空对象）跳过
//     → **plat 幸存、标记被冲掉**。⇒ 凡是「先导点评、后导/重导商城」的客户，全变成"有画像但后台不显示"。
//   入参 { dry, limit }：**dry=true 只统计 + 给样本，不写库**。
async function fixPlatMatched(event) {
  const dry = event.dry === true;
  const cnt = async (where) => {
    const r = await db.collection('customers').where(where).count()
      .catch(silentCatch('adminapi·fixPlatMatched', { total: -1 }));
    return r.total;
  };
  const total = await cnt({});
  const matched = await cnt({ platMatched: true });
  const hasUuid = await cnt({ platShopUuid: _.exists(true) });
  // 脏数据 = **确实有平台画像**（`plat.shopUuid` 落地即代表画像写成功了），但 platMatched 不是 true
  //   ⚠️ 判据**不能用 `platShopUuid` 存在** —— 那个字段商城路径**每家都写**（含没匹配上点评的），
  //      会把「同编号副档空壳」（plat 为 {}）也误标成"有画像"。实测：81 家里有 4 家是这种空壳。
  //   ⚠️ `_.neq(true)` 在 MongoDB 语义下**能匹配"字段不存在"的文档**（这里是故意的，老客户不受影响）
  const dirtyWhere = { 'plat.shopUuid': _.exists(true), platMatched: _.neq(true) };
  const dirty = await cnt(dirtyWhere);
  const r = await db.collection('customers').where(dirtyWhere)
    .field({ name: true, mallCode: true, platShopUuid: true, platMatched: true, plat: true })
    .limit(Math.min(Math.max(Number(event.limit) || 20, 1), 50)).get()
    .catch(silentCatch('adminapi·fixPlatMatched', { data: [] }));
  const samples = (r.data || []).map(c => {
    const p = c.plat || {};
    return {
      name: c.name, mallCode: c.mallCode || '', uuid: c.platShopUuid || '',
      platMatched: (c.platMatched === undefined ? '(缺字段)' : c.platMatched),
      platFields: Object.keys(p).length,
      rating: p.rating || '', avgPrice: p.avgPriceText || '',
      dishes: String(p.dishes || '').slice(0, 24)
    };
  });
  if (dry) return { ok: true, dry: true, total, matched, hasUuid, dirty, samples };
  // 批量刷：**每轮更新完，这些文档就不再匹配 dirtyWhere → 天然分页**（不必手写游标）
  let updated = 0, rounds = 0;
  while (rounds++ < 50) {
    const w = await db.collection('customers').where(dirtyWhere)
      .update({ data: { platMatched: true, updatedAt: Date.now() } })
      .catch(e => { throw new Error('批量更新失败：' + ((e && e.message) || e)); });
    const n = (w && w.stats && w.stats.updated) || 0;
    updated += n;
    if (!n) break;
  }
  return { ok: true, dry: false, total, matched, hasUuid, dirty, updated, rounds };
}

// ⭐ 2026-10-06 新增：后台客户详情页「门店照片」保存（管理员传图 / 换图 / 删图）
//   背景（老板 2026-10-06 定）：「后台可以保存客户详情里的照片，也可以在编辑状态添加或更改」。
//   口径：① 只有在**编辑态点「💾 保存」**时才写库（与其它字段一致、可反悔）
//         ② **固定 3 格**（与手机端「门店照片」、以及设计定稿的三格一致）
//         ③ 每张可删（前端 ✕）→ 后端就是"整份覆盖"，删掉的自然不在数组里
//   入参 { customerId, photos: [{fileID, thumbID}, …] }（最多 3 项，顺序即展示顺序）
//   与手机端 `tasks.saveCustPhoto` **共用同一个 `customers.photos` 结构**（{fileID, thumbID, by, at}）→
//   后台传的图，业务员在小程序里点开客户详情同样能看到。
async function setCustPhotos(event) {
  const admin = await verifyAdmin(event);
  if (!admin) return { ok: false, code: 'NO_AUTH', msg: '账号或密码不正确（或无权限）' };
  const customerId = String((event && event.customerId) || '');
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const raw = Array.isArray(event.photos) ? event.photos : null;
  if (!raw) return { ok: false, code: 'BAD_ARG', msg: '缺少照片参数' };
  // 只留最多 3 项、且必须有 fileID；空位直接丢弃（数组长度即"有几张"）
  const photos = raw.slice(0, 3)
    .map(p => {
      const fileID = String((p && p.fileID) || (typeof p === 'string' ? p : '')).trim();
      if (!fileID) return null;
      return {
        fileID: fileID,
        thumbID: String((p && p.thumbID) || '').trim(),
        by: String((p && p.by) || ('admin:' + (admin.name || ''))),
        at: Number((p && p.at)) || Date.now()
      };
    })
    .filter(Boolean);
  await db.collection('customers').doc(customerId)
    .update({ data: { photos: photos, updatedAt: Date.now() } });
  return { ok: true, count: photos.length };
}

async function backfillAddressFromPlat(event) {
  const dry = event.dry === true;
  const offset = Math.max(0, Number(event.offset) || 0);
  const limit = Math.min(Math.max(Number(event.limit) || 200, 1), 300);
  const r = await db.collection('customers').orderBy('_id', 'asc').skip(offset).limit(limit)
    .field({ address: true, phone: true, phone2: true, plat: true })
    .get().catch(silentCatch('adminapi·backfillAddressFromPlat', { data: [] }));
  const rows = r.data || [];
  const todo = [];
  let addrN = 0, phoneN = 0, noPlat = 0;
  rows.forEach(c => {
    const pl = c.plat || {};
    const platAddr = String(pl.addr || '').trim();
    const curAddr = String(c.address || '').trim();
    const from = {}, to = {};
    // ① 地址：谁详细用谁
    if (platAddr && platAddr.length > curAddr.length) { from.address = curAddr; to.address = platAddr; addrN++; }
    // ② 电话：商城优先 —— 顶层为空才用平台的
    [['phone', 'phone1'], ['phone2', 'phone2']].forEach(pair => {
      const tgt = pair[0], src = pair[1];
      const cur = String(c[tgt] || '').trim();
      const pv = String(pl[src] || '').trim();
      if (cur || !pv) return;                    // 顶层已有（商城的）→ 不动；平台也没有 → 不动
      from[tgt] = cur; to[tgt] = pv; phoneN++;
    });
    if (!platAddr) noPlat++;
    if (Object.keys(to).length) todo.push({ id: c._id, from: from, to: to });
  });
  const done = rows.length < limit;
  const nextOffset = offset + rows.length;
  if (dry) {
    return { ok: true, dry: true, offset, processed: rows.length, willFix: todo.length, addrWillFix: addrN, phoneWillFix: phoneN, noPlat, done, nextOffset, samples: todo.slice(0, 3) };
  }
  let fixed = 0;
  for (let i = 0; i < todo.length; i += 20) {
    await Promise.all(todo.slice(i, i + 20).map(x =>
      db.collection('customers').doc(x.id).update({ data: Object.assign({}, x.to, { updatedAt: Date.now() }) }).catch(silentCatch('adminapi·for·写入', null))
    ));
    fixed += Math.min(20, todo.length - i);
  }
  return { ok: true, offset, processed: rows.length, fixed, addrFixed: addrN, phoneFixed: phoneN, noPlat, done, nextOffset };
}

// ⭐ 2026-09-27 新增：**地图/客户管理用的轻量客户点**（列表层字段）。
//   ⚠️ 不能用 listCustomers —— 它返回 47 列 + 查订单，5 万条会撞 100KB 返回上限、还慢。
//   分片：用 `_id` 游标（orderBy('_id') + 只取 cursor 之后的），每片 ≤1000 条。
//   入参：{ cursor, limit }     出参：{ ok, points: [{i,n,la,ln,c,d,b}], next, got }
//   ⚠️ **拜访状态不在这里算**（那要查任务/拜访，5 万条会拖垮）——
//      由后台拉完点之后再拉一次 listTasks，本地合成状态（见架构文档 §10）。
// ⭐ 2026-09-27 老板定：**把「客户列表 6 列」的聚合预聚合进本地缓存**（原按页调 custPageAgg）。
//   口径与 custPageAgg **完全一致**（订单按 customerCode；任务中=published/reviewing 且未过期；拜访只看 normal/pending_review）。
//   custMapPoints（全量分片）与 custSync（增量）共用本函数，保证两边算出来的值一模一样。
async function buildAggMaps(rows) {
  const _today = todayStr();
  const _byCode = {}, _byId = {};
  const _ids = rows.map(c => c._id);
  const _codes = rows.map(c => String(c.mallCode || '').trim()).filter(Boolean);
  _ids.forEach(id => { _byId[id] = { lv: '', vc: 0, vs: 'free', vt: '' }; });
  // ① 订单：按客户编号（每 100 个一批，防 _.in 过长）
  for (let ci = 0; ci < _codes.length; ci += 100) {
    const slice = _codes.slice(ci, ci + 100);
    const os = await fetchAll('orders', { customerCode: _.in(slice) },
      { customerCode: true, orderedAt: true, actualAmount: true });
    os.forEach(o => {
      const code = String(o.customerCode || '').trim();
      if (!code) return;
      const cur = _byCode[code] || (_byCode[code] = { oc: 0, oa: 0, lo: '' });
      cur.oc += 1;
      cur.oa += Number(o.actualAmount) || 0;
      const d = String(o.orderedAt || '').slice(0, 10);
      if (d && d > (cur.lo || '')) cur.lo = d;
    });
  }
  // ② 任务中集合（过期任务不算）
  const _taskMap = {};
  const _tAll = await fetchAll('tasks', { status: _.in(['published', 'reviewing']) },
    { customerIds: true, status: true, deadline: true });
  _tAll.forEach(tk => {
    if (tk.status !== 'published' && tk.status !== 'reviewing') return;
    if (tk.deadline && String(tk.deadline) <= _today) return;
    (tk.customerIds || []).forEach(id => { if (_byId[id]) { _byId[id].vs = 'in_task'; if (!_taskMap[id]) _taskMap[id] = tk._id; } });
  });
  // ③ 拜访（分 100 一批）
  const _doneSet = new Set(), _ongSet = new Set();
  for (let vi = 0; vi < _ids.length; vi += 100) {
    const slice = _ids.slice(vi, vi + 100);
    const vs = await fetchAll('visits', { customerId: _.in(slice) },
      { customerId: true, taskId: true, status: true, visitedAt: true });
    vs.forEach(v => {
      const rec = _byId[v.customerId];
      if (!rec) return;
      if (v.status === 'normal' || v.status === 'pending_review') {
        rec.vc += 1;
        if (String(v.visitedAt || '') > String(rec.lv || '')) rec.lv = v.visitedAt || '';
        if (v.taskId && _taskMap[v.customerId] === v.taskId) _doneSet.add(v.customerId);
      } else if (v.status === 'ongoing' && v.visitedAt === _today && v.taskId && _taskMap[v.customerId] === v.taskId) {
        _ongSet.add(v.customerId);
      }
    });
  }
  _ids.forEach(id => {
    const rec = _byId[id];
    if (rec.vs === 'in_task') rec.vt = _doneSet.has(id) ? 'visited' : (_ongSet.has(id) ? 'ongoing' : 'pending');
  });
  return { byCode: _byCode, byId: _byId };
}
// 把聚合结果并进一个轻量点（字段名尽量短，控制缓存体积）
function mergeAgg(p, id, code, agg) {
  const o = agg.byCode[String(code || '').trim()] || {};
  const v = agg.byId[id] || {};
  p.oc = o.oc || 0;
  p.oa = o.oa || 0;
  p.lo = o.lo || '';
  p.vc = v.vc || 0;
  p.lv = v.lv || '';
  p.vs = v.vs || 'free';
  p.vt = v.vt || '';
  return p;
}

async function custMapPoints(event) {
  const e0 = event || {};
  const limit = Math.min(Math.max(Number(e0.limit) || 1000, 1), 1000);
  const cursor = String(e0.cursor || '').trim();
  // ⭐ 2026-09-29 回收站：**已删客户不在地图上显示**（老板定「进了回收站的客户…不再地图上显示」）
  //   custMapPoints 是全量分片 = 地图 + 后台本地缓存的数据源 → 必须在这里排除
  const where = cursor ? _.and([{ _id: _.gt(cursor) }, NOT_DELETED]) : Object.assign({}, NOT_DELETED);
  const r = await db.collection('customers').where(where)
    .orderBy('_id', 'asc').limit(limit)
    // ⭐ 2026-09-27 M2b：字段扩到「列表层 18 项」—— 客户管理页 / 批次总表切本地缓存后，
    //   店名原值 / 建档时间 / 客户类型 / 电话 / 备注 / 批次归属 也要能本地渲染（订单/拜访聚合走 custPageAgg 按页拉）
    .field({ name: true, nameRaw: true, lat: true, lng: true, city: true, district: true, bizCircle: true,
             address: true, coordSource: true, coord_status: true, mallCode: true, mallKey: true, updatedAt: true,
             createdAt: true, customerType: true, phone: true, remark: true, batchIds: true, mallJoinedAt: true })
    .get().catch(silentCatch('adminapi·custMapPoints', { data: [] }));
  const rows = r.data || [];
  const _agg = await buildAggMaps(rows);   // 6 列预聚合（与 custPageAgg 同口径）
  const points = rows.map(c => ({
    i: c._id,
    n: String(c.name || ''),
    la: Number(c.lat) || 0,
    ln: Number(c.lng) || 0,
    c: String(c.city || ''), d: String(c.district || ''), b: String(c.bizCircle || ''),
    ad: String(c.address || ''),            // 地址
    cs: String(c.coordSource || ''),        // 坐标来源（商城/平台/采集/修改）
    cst: String(c.coord_status || ''),      // 坐标状态（ok / pending）
    mc: String(c.mallCode || ''),           // 客户编号（商城侧）
    mk: String(c.mallKey || ''),            // 商城系统 Key（判断"已入商城"）
    u: Number(c.updatedAt) || 0,            // 最后修改时间
    // ⭐ 2026-09-27 M2b 新增 6 项（本地列表渲染要用；订单/拜访聚合**不在这里算** —— 见 custPageAgg）
    nr: String(c.nameRaw || ''),            // 店名原值（「编号 + 店名」，列表显示层用）
    ca: Number(c.createdAt) || 0,           // 建档时间（列表默认按它倒序）
    ct: String(c.customerType || ''),       // 客户类型（回访 mall / 新客 new）
    ph: String(c.phone || ''),              // 电话（批次总表列）
    rm: String(c.remark || ''),             // 备注（列表「备注」列高亮用）
    bi: Array.isArray(c.batchIds) ? c.batchIds.join(',') : '',  // 批次归属（"未分批"过滤用）
    mj: String(c.mallJoinedAt || ''),       // 注册商城时间（新客列表的「已入商城」日期）
  })).map((p, idx) => mergeAgg(p, rows[idx]._id, rows[idx].mallCode, _agg));   // 6 列预聚合
  return { ok: true, points: points, next: rows.length >= limit ? String(rows[rows.length - 1]._id) : null, got: rows.length };
}

// ⭐ 2026-09-27 新增：**客户增量同步** —— 只回 `updatedAt > since` 的客户（同样是轻量字段）。
//   前提：customers 的**所有写入点都要写 updatedAt**（2026-09-27 已补齐 21 处，见架构文档 §九）。
//   ⚠️ **删除拉不到**（被删的记录不会出现在结果里）→ 由后台**每天全量对账**补（架构文档 §3.2）。
//   入参：{ since(毫秒), cursor, limit }   出参：{ ok, points, next, maxUpdatedAt, got }
//   next 非空 = 还有下一页，后台循环拉；maxUpdatedAt 用于推进本地 lastSync。
async function custSync(event) {
  const e0 = event || {};
  const since = Number(e0.since) || 0;
  const limit = Math.min(Math.max(Number(e0.limit) || 500, 1), 1000);
  const cursor = String(e0.cursor || '').trim();
  // ⭐ 2026-09-29 回收站：增量同步**也要排除已删**
  //   ⚠️ **必须交代清楚的行为**：**删除不会通过增量同步"传"给后台** ——
  //      客户被删时虽然 updatedAt 变了，但 `NOT_DELETED` 会把它挡住，后台**收不到这条"删除事件"**。
  //      所以前端删完必须**自己调 `/mapPoints/patch` 的 removeIds** 把它从本地缓存摘掉（见 admin.html 的 geoDeletePicked）。
  //      · 全量刷新（custMapPoints，同样排除了已删）→ 不会把它带回来 ✅
  //      · **恢复**时它重新符合 `NOT_DELETED` → 会被增量同步带回来 ✅（等下一轮 15 秒保鲜轮询即可）
  const conds = [{ updatedAt: _.gt(since) }, NOT_DELETED];
  if (cursor) conds.push({ _id: _.gt(cursor) });
  const where = conds.length > 1 ? _.and(conds) : conds[0];
  const r = await db.collection('customers').where(where)
    .orderBy('_id', 'asc').limit(limit)
    .field({ name: true, nameRaw: true, lat: true, lng: true, city: true, district: true, bizCircle: true,
             address: true, coordSource: true, coord_status: true, mallCode: true, mallKey: true, updatedAt: true,
             createdAt: true, customerType: true, phone: true, remark: true, batchIds: true, mallJoinedAt: true })
    .get().catch(silentCatch('adminapi·custSync', { data: [] }));
  const rows = r.data || [];
  const _aggS = await buildAggMaps(rows);   // ⭐ 2026-09-27：增量同步同样带上 6 列预聚合（口径与 custMapPoints 一致）
  let maxU = since;
  const points = rows.map(c => {
    const u = Number(c.updatedAt) || 0;
    if (u > maxU) maxU = u;
    return {
      i: c._id,
      n: String(c.name || ''),
      la: Number(c.lat) || 0,
      ln: Number(c.lng) || 0,
      c: String(c.city || ''), d: String(c.district || ''), b: String(c.bizCircle || ''),
      ad: String(c.address || ''), cs: String(c.coordSource || ''), cst: String(c.coord_status || ''),
      mc: String(c.mallCode || ''), mk: String(c.mallKey || ''),
      u: u,
      nr: String(c.nameRaw || ''), ca: Number(c.createdAt) || 0, ct: String(c.customerType || ''),
      ph: String(c.phone || ''), rm: String(c.remark || ''), bi: Array.isArray(c.batchIds) ? c.batchIds.join(',') : '',
      mj: String(c.mallJoinedAt || '')
    };
  }).map((p, idx) => mergeAgg(p, rows[idx]._id, rows[idx].mallCode, _aggS));
  return { ok: true, points: points, next: rows.length >= limit ? String(rows[rows.length - 1]._id) : null, maxUpdatedAt: maxU, got: rows.length };
}

// ⭐⭐ 2026-09-29【方案 C】客户数据变动信号（极轻：只读一个 settings 文档，~10ms）
//   谁写：`tasks.newShopSubmit`（手机端「加新店」建档成功后）→ settings.custDirtyAt = 时间戳
//   谁读：后台 `admin/store.js` 读本地缓存时顺手比一下 —— 若比缓存的 pulledAt 新，
//        说明"手机端刚加了店 / 后台刚改了数据"，就在后台自动重拉（走 custSync 增量），老板无需手动点刷新。
//   ⚠️ 读失败一律当"没变动"返回，绝不因此报错打断前端。
// ⭐ 2026-10-04 自由拜访：以**真实拜访记录**为准重算某张卡的 customerIds
//   （与 `visits` 云函数里的 _resyncFreeTrip 同口径 —— 那边管业务员主动提交/取消，
//     这边管**定时器自动提交/自动取消**，两条路都必须重算，否则「已拜访 N 家」会不准）
async function resyncFreeTrip(tripId) {
  if (!tripId) return;
  const ids = [];
  for (let sk = 0; sk < 1000; sk += 100) {
    const part = await db.collection('visits')
      .where({ freeTripId: tripId, status: _.neq('ongoing') })
      .field({ customerId: true }).skip(sk).limit(100).get();
    const arr = (part && part.data) || [];
    for (const r of arr) if (r.customerId) ids.push(r.customerId);
    if (arr.length < 100) break;
  }
  const uniq = Array.from(new Set(ids));
  await db.collection('free_trips').doc(tripId).update({ data: { customerIds: uniq, updatedAt: Date.now() } });
}

async function custDirty() {
  try {
    const r = await db.collection('settings').where({ key: 'custDirtyAt' }).limit(1).get();
    const at = (r.data && r.data.length) ? (Number(r.data[0].value) || 0) : 0;
    return { ok: true, at: at };
  } catch (e) {
    return { ok: true, at: 0 };
  }
}

// ⭐ 2026-10-03 自由拜访（后台）：列出「自由拜访卡」
//   入参：{ salesmanId }（不传 = 全部业务员）
//   出参：{ ok, count, list:[{...}] } —— 字段与手机端 free_trip 口径一致
async function listFreeTrips(event) {
  const sid = String(event.salesmanId || "");
  const where = sid ? { salesmanId: sid } : {};
  const r = await db.collection("free_trips").where(where)
    .orderBy("createdAt", "desc").limit(200).get()
    .catch(silentCatch("adminapi·listFreeTrips", { data: [] }));
  const list = (r.data || []).map(t => ({
    id: t._id,
    salesmanId: t.salesmanId || "",
    salesmanName: t.salesmanName || "",
    district: t.district || "",
    bizCircle: t.bizCircle || "",
    radius: Number(t.radius) || 0,
    status: t.status || "active",
    visitedCount: Array.isArray(t.customerIds) ? t.customerIds.length : 0,
    customerIds: Array.isArray(t.customerIds) ? t.customerIds : [],
    lat: Number(t.centerLat) || 0,
    lng: Number(t.centerLng) || 0,
    createdAt: Number(t.createdAt) || 0,
    updatedAt: Number(t.updatedAt) || 0
  }));
  return { ok: true, count: list.length, list: list };
}

// ⭐ 2026-10-03 自由拜访（后台）：删除一张自由拜访卡
//   ⚠️ **只删归类，拜访记录本身不删** —— 把该卡下所有 visits 的 freeTripId **置空**
//      （退化成「无任务拜访」），不留悬空引用。与「客户回收站=软删」同一思路。
async function deleteFreeTrip(event) {
  const id = String(event.tripId || event.id || "");
  if (!id) return { ok: false, code: "BAD_ARG", msg: "缺少 tripId" };
  const r = await db.collection("free_trips").doc(id).get().catch(() => ({ data: [] }));
  const t = (r.data && r.data[0]) || (r.data && !Array.isArray(r.data) ? r.data : null);
  if (!t) return { ok: false, code: "NOT_FOUND", msg: "自由拜访卡不存在" };
  // ① 先把拜访记录上的归属摘掉（保留记录本身）
  let cleared = 0;
  try {
    // ⚠️ 2026-10-04【对抗性检查修】原来逐条 doc().update()：
    //   一张卡跑了几十家时 = 几十次串行请求，**很容易把云函数拖到超时**（免费环境 30 秒上限）。
    //   改成 **where().update() 批量更新**（云函数里支持），一次搞定。
    const before = await db.collection("visits").where({ freeTripId: id }).count().catch(() => ({ total: 0 }));
    cleared = before.total || 0;
    await db.collection("visits").where({ freeTripId: id }).update({ data: { freeTripId: "" } });
  } catch (e) { /* 摘不掉也不挡删卡 */ }
  // ② 再删卡
  // ⭐ 2026-10-05【检查修】后台删卡也要进「滚动消息」—— 原来漏了，导致
  //   「业务员删卡有记录、老板后台删卡没记录」，而且老板删卡更该留痕。
  //   ⚠️ 记在**删之前**（删完卡就没了，拿不到 district/bizCircle）。
  try {
    await db.collection('free_trip_logs').add({
      data: {
        tripId: id,
        action: 'delete',
        salesmanId: t.salesmanId || '',
        salesmanName: String(t.salesmanName || '') + '（后台删除）',
        district: t.district || '',
        bizCircle: t.bizCircle || '',
        visitedCount: Array.isArray(t.customerIds) ? t.customerIds.length : 0,
        byAdmin: true,
        at: Date.now()
      }
    });
  } catch (e) { /* 日志写不进去不挡删卡 */ }
  await db.collection("free_trips").doc(id).remove();
  return { ok: true, id: id, visitsCleared: cleared, msg: "已删除（拜访记录保留为无任务拜访）" };
}

// ⭐ 2026-10-03 自由拜访（后台）：看某张卡「去过的店」（去重）
async function freeTripDetailAdmin(event) {
  const id = String(event.tripId || event.id || "");
  if (!id) return { ok: false, code: "BAD_ARG", msg: "缺少 tripId" };
  const r = await db.collection("free_trips").doc(id).get().catch(() => ({ data: [] }));
  const t = (r.data && r.data[0]) || (r.data && !Array.isArray(r.data) ? r.data : null);
  if (!t) return { ok: false, code: "NOT_FOUND", msg: "自由拜访卡不存在" };
  const ids = Array.isArray(t.customerIds) ? t.customerIds.filter(Boolean) : [];
  let custs = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = await db.collection("customers")
      .where({ _id: _.in(ids.slice(i, i + 100)) })
      .field({ name: true, nameRaw: true, address: true, district: true, bizCircle: true,
               phone: true, lat: true, lng: true, deleted: true })
      .get().catch(silentCatch("adminapi·freeTripDetailAdmin", { data: [] }));
    for (const c of (part.data || [])) custs.push(c);
  }
  custs = custs.filter(c => c.deleted !== true);   // 进回收站的自动跳过
  return {
    ok: true,
    trip: { id: t._id, salesmanName: t.salesmanName || "", district: t.district || "",
            bizCircle: t.bizCircle || "", status: t.status || "active", radius: Number(t.radius) || 0,
            visitedCount: ids.length, createdAt: Number(t.createdAt) || 0 },
    customers: custs.map(c => ({ id: c._id, name: c.name || "", address: c.address || "",
      district: c.district || "", bizCircle: c.bizCircle || "", phone: c.phone || "" }))
  };
}

// ⭐ 2026-09-27 M2b 新增：**按页聚合**（客户管理页 / 批次总表切本地缓存后，
//   订单 / 拜访 / 任务状态 / 坐标报错待审 这几列要查别的表 —— 按**当前页**的客户现算，一次 ≤200 家，很快）。
//   口径**逐条对齐 listCustomers**（两处显示必须一致）：
//     · 订单：按 customerCode 聚合，只算**实际订单条数**；总额累加 actualAmount；最近下单取最大 orderedAt
//     · 拜访：只算 normal / pending_review；最近拜访取最大 visitedAt
//     · 任务三态：只看 published / reviewing 且**未过期**的任务（deadline <= 今天 视为已过期，同 expiredTaskTick 口径）
//     · 坐标报错待审：coord_fix_requests status=pending
//   入参：{ codes: ['c347', ...], ids: ['<_id>', ...] }   出参：{ ok, byCode, byId }
async function custPageAgg(event) {
  const e0 = event || {};
  const codes = (Array.isArray(e0.codes) ? e0.codes : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 500);
  const ids = (Array.isArray(e0.ids) ? e0.ids : []).map(x => String(x || '')).filter(Boolean).slice(0, 500);
  const today = todayStr();
  const byCode = {}, byId = {};
  // ① 订单聚合（按客户编号）
  if (codes.length) {
    const oAll = await fetchAll('orders', { customerCode: _.in(codes) },
      { customerCode: true, orderedAt: true, actualAmount: true });
    oAll.forEach(o => {
      const code = String(o.customerCode || '').trim();
      if (!code) return;
      const cur = byCode[code] || (byCode[code] = { oc: 0, oa: 0, lo: '' });
      cur.oc += 1;
      cur.oa += Number(o.actualAmount) || 0;
      const d = String(o.orderedAt || '').slice(0, 10);
      if (d && d > (cur.lo || '')) cur.lo = d;
    });
  }
  // ② 拜访 + 任务三态 + 报错待审（按 _id）
  if (ids.length) {
    ids.forEach(id => { byId[id] = { lv: '', vc: 0, vs: 'free', vt: '', cf: false }; });
    const vAll = await fetchAll('visits', { customerId: _.in(ids) },
      { customerId: true, taskId: true, status: true, visitedAt: true });
    const tAll = await fetchAll('tasks', { status: _.in(['published', 'reviewing']) },
      { customerIds: true, status: true, deadline: true });
    const taskMap = {};
    tAll.forEach(t => {
      if (t.status !== 'published' && t.status !== 'reviewing') return;
      if (t.deadline && String(t.deadline) <= today) return;      // 过期任务不算「任务中」
      (t.customerIds || []).forEach(id => { if (byId[id]) { byId[id].vs = 'in_task'; if (!taskMap[id]) taskMap[id] = t._id; } });
    });
    const doneSet = new Set(), ongSet = new Set();
    vAll.forEach(v => {
      const rec = byId[v.customerId];
      if (!rec) return;
      if (v.status === 'normal' || v.status === 'pending_review') {
        rec.vc += 1;
        if (String(v.visitedAt || '') > String(rec.lv || '')) rec.lv = v.visitedAt || '';
        if (v.taskId && taskMap[v.customerId] === v.taskId) doneSet.add(v.customerId);
      } else if (v.status === 'ongoing' && v.visitedAt === today && v.taskId && taskMap[v.customerId] === v.taskId) {
        ongSet.add(v.customerId);
      }
    });
    ids.forEach(id => {
      const rec = byId[id];
      if (rec.vs === 'in_task') rec.vt = doneSet.has(id) ? 'visited' : (ongSet.has(id) ? 'ongoing' : 'pending');
    });
    const fx = await fetchAll('coord_fix_requests', { customerId: _.in(ids), status: 'pending' },
      { customerId: true, status: true });
    fx.forEach(f => { if (byId[f.customerId]) byId[f.customerId].cf = true; });
  }
  return { ok: true, byCode: byCode, byId: byId };
}

// ⭐ 2026-09-26 新增：地图的**分级聚合**（战况监控 / 任务地图）—— 数万客户不能一次全画。
//   入参：{ level, minLat, maxLat, minLng, maxLng, city, district }
//        level = 'city' | 'district' | 'bizCircle'；视野矩形四项全传才生效（不传 = 全量聚合，用于“全览”）
//   出参：{ ok, level, groups: [{ name, count, lat, lng }], total, capped }
//   原理：服务端 group by 层级字段 + **avg(lat/lng) 当气泡位置** → 不管库里多少家，永远只返回几十条。
//   ⚠️ 依赖 customers 的 city / district / bizCircle 索引（2026-09-26 已建）。
async function custGeoAggregate(event) {
  const e0 = event || {};
  const level = ['city', 'district', 'bizCircle'].indexOf(String(e0.level)) >= 0 ? String(e0.level) : 'district';
  const field = '$' + level;
  const hasBounds = ['minLat', 'maxLat', 'minLng', 'maxLng'].every(k => typeof e0[k] === 'number' && isFinite(e0[k]));
  // ⭐ 2026-09-29 回收站：**已删客户不出现在地图上**（老板定「进了回收站的客户…不再地图上显示」）
  //   → 用聚合专用写法（见 NOT_DELETED_AGG）；注：`.match()` 里 `_.exists()` 支持，但 `_.neq()` 不行，必须原生 `$ne`
  const where = Object.assign({ lat: _.exists(true), lng: _.exists(true) }, NOT_DELETED_AGG);   // 没坐标的客户不上地图（坐标列会显示“补标”）
  if (e0.city) where.city = String(e0.city);
  if (e0.district) where.district = String(e0.district);
  if (hasBounds) {
    where.lat = _.gte(e0.minLat).and(_.lte(e0.maxLat));
    where.lng = _.gte(e0.minLng).and(_.lte(e0.maxLng));
  }
  let groups = [];
  try {
    const r = await db.collection('customers').aggregate()
      .match(where)
      .group({ _id: field, n: $.sum(1), lat: $.avg('$lat'), lng: $.avg('$lng') })
      .sort({ n: -1 })
      .limit(300)
      .end();
    groups = (r.list || []).map(x => ({
      name: (x._id === null || x._id === undefined || x._id === '') ? '未标注' : String(x._id),
      count: x.n || 0,
      lat: x.lat, lng: x.lng
    })).filter(g => g.lat && g.lng);
  } catch (err) {
    return { ok: false, msg: '聚合失败：' + (err && err.message ? err.message : err), groups: [] };
  }
  return { ok: true, level, groups, total: groups.reduce((a, g) => a + g.count, 0), capped: groups.length >= 300 };
}

// ⭐ 2026-09-26 新增：三层入口的**下拉选项**（城市 / 区域 / 商圈）—— 从库里现有客户去重生成。
//   ⚠️ 教训（坑 D）：选项**必须从数据里动态生成**，绝不写死清单 —— 否则会出现"选了却是空表"。
//   用聚合 group 一次拿全（6 万家也只返回几百个组合），比全量拉客户省得多。
async function custGeoOptions(event) {
  let list = [];
  try {
    const r = await db.collection('customers').aggregate()
      // ⭐ 2026-09-29 回收站：下拉选项也不该给出"只剩回收站客户"的区域（否则选了就是空表 —— 坑 D 的翻版）
      .match(NOT_DELETED_AGG)
      .group({ _id: { c: '$city', d: '$district', b: '$bizCircle' } })
      .limit(20000)
      .end();
    list = (r.list || []).map(x => x._id || {});
  } catch (e) {
    // 聚合失败或结果为空 → 退回"只取三列"的分页扫，稳妥但慢些
    const all = await fetchAll('customers', NOT_DELETED, { city: true, district: true, bizCircle: true });
    list = all.map(c => ({ c: c.city, d: c.district, b: c.bizCircle }));
  }
  const cities = new Map();      // city -> Set(district)
  const bizByDist = new Map();   // "city|district" -> Set(bizCircle)
  list.forEach(x => {
    const c = String(x.c || '').trim(), d = String(x.d || '').trim(), b = String(x.b || '').trim();
    if (c) { if (!cities.has(c)) cities.set(c, new Set()); if (d) cities.get(c).add(d); }
    if (d && b) {
      const k = (c || '') + '|' + d;
      if (!bizByDist.has(k)) bizByDist.set(k, new Set());
      bizByDist.get(k).add(b);
    }
  });
  const districts = {}, bizCircles = {};
  cities.forEach((set, c) => { districts[c] = [...set].sort(); });
  bizByDist.forEach((set, k) => { bizCircles[k] = [...set].sort(); });
  return { ok: true, cities: [...cities.keys()].sort(), districts, bizCircles };
}

// ⭐ 2026-09-26 新增：按 ID 批量取客户名（任务卡 / 批次卡这类"只要名字"的地方用）。
//   原先这些地方靠 admin.html 里那份**全量客户缓存**（custCache）—— 6 万家后必须改成按需查。
async function customerNames(event) {
  const ids = Array.isArray(event && event.ids) ? event.ids.filter(Boolean).slice(0, 500) : [];
  const rows = {};
  if (!ids.length) return { ok: true, rows };
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const r = await db.collection('customers').where({ _id: _.in(part) })
      .field({ name: true, nameRaw: true, mallCode: true }).limit(100).get().catch(silentCatch('adminapi·for', { data: [] }));
    (r.data || []).forEach(c => {
      rows[c._id] = { name: c.name || '', nameRaw: c.nameRaw || '', mallCode: c.mallCode || '' };
    });
  }
  return { ok: true, rows };
}

// 批量导入客户（2026-09-07 批次化改造）：两阶段——preview 返回 B 级疑似冲突弹窗收集决定；
// 执行阶段带 decisions 写入。自动建批（或追加进指定 batchId）；分级匹配合并（S/A/B/C 口径见 §7.12）
async function importCustomers(event) {
  const { customers, customerType, batchId, decisions, preview } = event;
  if (!Array.isArray(customers) || !customers.length) return { ok: false, code: 'BAD_ARG', msg: '没有可导入的数据' };
  const type = customerType === 'new' ? 'new' : 'mall';
  await ensureBatchColls();
  const rows = customers.filter(c => String(c.name || '').trim());
  const now = Date.now();

  // 匹配池 = 现有全部客户档案，预规范化 nName/nAddr（避免匹配循环内对同一档案反复清洗字符串）
  // ⭐ 2026-09-29 回收站：**已删客户不进匹配池** —— 否则导入可能"合并"进一个躺在回收站里的客户，新数据等于看不见
  const pool = (await fetchAll('customers', NOT_DELETED, { _id: true, name: true, phone: true, address: true, region: true })).map(p => normPoolEntry(p));

  // 预检：找出全部 B 级疑似冲突
  const conflicts = [];
  rows.forEach((c, i) => {
    const m = matchExistingCust(c, pool);
    if (m && m.level === 'B') {
      conflicts.push({
        index: i,
        row: { name: String(c.name).trim(), phone: String(c.phone || '').trim(), address: String(c.address || '').trim(), region: String(c.region || '').trim() },
        candidates: m.candidates.slice(0, 5).map(p => ({ _id: p._id, name: p.name, phone: p.phone || '', address: p.address || '', region: p.region || '' }))
      });
    }
  });
  const decMap = {};
  (Array.isArray(decisions) ? decisions : []).forEach(d => { if (d && d.index !== undefined) decMap[d.index] = d; });
  const unresolved = conflicts.filter(c => !decMap[c.index]);

  if (preview || unresolved.length) {
    // 只返回尚未决定的冲突（执行阶段已决定的冲突不再重复弹窗）
    return { ok: true, needConfirm: true, conflicts: unresolved.length ? unresolved : [], total: rows.length, msg: unresolved.length ? `有 ${unresolved.length} 家疑似重复需确认` : '预检完成' };
  }

  // 确定批次：指定 batchId 追加，否则自动建批
  let bid = batchId;
  let batchName = '';
  if (bid) {
    const b = await db.collection('customer_batches').doc(bid).get().catch(() => null);
    if (!b || !b.data) return { ok: false, code: 'NOT_FOUND', msg: '批次不存在' };
    batchName = b.data.name;
  } else {
    const gn = await genBatchName();
    batchName = gn.name;
    const add = await db.collection('customer_batches').add({
      data: { name: gn.name, subtitle: '', autoNamePrefix: gn.prefix, createdAt: now, createdBy: event._admin && event._admin.name }
    });
    bid = add._id;
  }

  // 第一遍：纯内存做分级匹配决定（不写库）。新建行用占位 id 入池，保证批内后续行不重复建档案
  const newRows = []; // { c, ph }
  const mergeTargets = [];
  let added = 0, merged = 0, ignored = 0;
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const m = matchExistingCust(c, pool);
    const decision = decMap[i];
    let act, targetId;
    if (m && m.level === 'A') { act = 'merge'; targetId = m.target._id; }
    else if (m && m.level === 'B') {
      act = (decision && decision.action) || 'ignore';
      targetId = decision && decision.targetId;
      if (act === 'merge' && !targetId && m.target) targetId = m.target._id;
    } else { act = 'new'; }
    if (act === 'ignore') { ignored++; continue; }
    if (act === 'merge' && targetId) { merged++; mergeTargets.push(targetId); continue; }
    const ph = '@new' + i;
    newRows.push({ c, ph });
    pool.push(normPoolEntry({ _id: ph, name: c.name, phone: c.phone, address: c.address, region: c.region }));
    added++;
  }
  // 第二遍：并行写库（曾串行 100 条 × 2 次 add 共 200 次往返超时 -601008；15 并发分批）
  const realId = {};
  await runPool(newRows, 15, async r => {
    const c = r.c;
    const add = await db.collection('customers').add({
      data: {
        name: String(c.name || '').trim(),
        customerType: type,
        region: String(c.region || '').trim(),
        address: String(c.address || '').trim(),
        phone: String(c.phone || '').trim(),
        phone2: String(c.phone2 || '').trim(),
        lng: Number(c.lng) || null,
        lat: Number(c.lat) || null,
        coord_status: (Number(c.lng) && Number(c.lat)) ? 'ok' : 'pending',
        status: 'active',
        batchIds: [bid],
        createdAt: now,
        updatedAt: now        // 2026-09-27 补：新增客户必须能被增量同步（custSync）看到
      }
    });
    await db.collection('batch_members').add({ data: { batchId: bid, customerId: add._id, status: 'todo', createdAt: now } });
    realId[r.ph] = add._id;
  });
  // 合并入批（占位解析为真实 _id；同一目标去重后并行——addCustomerToBatch 幂等检查并发不安全）
  const uniqTargets = [...new Set(mergeTargets.map(t => realId[t] || t))];
  await runPool(uniqTargets, 15, async tid => { await addCustomerToBatch(tid, bid); });
  return { ok: true, batchId: bid, batchName, added, merged, ignored, total: rows.length, msg: `导入完成：新增 ${added} 家、并入已有 ${merged} 家、忽略 ${ignored} 家（批次「${batchName}」）` };
}

// ===== 商城客户列表导入 + 三档模糊比对（电话→名称→地址） =====
// 分档：≥75 自动合入；45~74 待确认；<45 忽略
function normName(s) {
  return String(s || '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[\s，。、·—\-_/\\"'“”‘’':：]+/g, '');
}
function normAddr(s) {
  let t = String(s || '');
  ['浙江省', '江苏省', '金华市', '永康市', '省', '市'].forEach(p => { t = t.replace(p, ''); });
  return t.replace(/[\s，。、·—\-_/]+/g, '');
}
function lcsLen(a, b) {
  const n = a.length, m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}
function dice(a, b) {
  if (!a || !b) return 0;
  return (2 * lcsLen(a, b)) / (a.length + b.length);
}

function matchMall(v, m, nameV, addrV, vPhones, nameM, addrM) {
  // 1) 电话命中（主号/备号）
  const mPhone = String(m.phone || '').trim();
  if (mPhone && vPhones.includes(mPhone)) {
    return { score: 100, reason: '电话一致', mall: m };
  }
  const nameSim = dice(nameV, nameM);
  const addrEq = !!(addrV && addrM && addrV === addrM);
  const addrSim = dice(addrV, addrM);
  // 2) 名称+地址组合
  if (nameSim >= 0.9 && (addrEq || addrSim >= 0.85)) return { score: 95, reason: '名称一致+地址一致', mall: m };
  if (nameSim >= 0.85) return { score: 80, reason: '名称高度相似', mall: m };
  if (nameSim >= 0.6 && addrSim >= 0.7) return { score: 75, reason: '名称近似+地址近似', mall: m };
  if (addrEq && nameSim >= 0.35) return { score: 70, reason: '地址一致+名称近似', mall: m };
  if (addrEq) return { score: 60, reason: '仅地址一致', mall: m };
  if (nameSim >= 0.75) return { score: 60, reason: '仅名称相似', mall: m };
  if (nameSim >= 0.5 || addrSim >= 0.6) return { score: 50, reason: '名称/地址轻度相似', mall: m };
  return { score: 0, reason: '', mall: m };
}

async function importMallCustomers(event) {
  const { customers, fileName, chunkIndex, chunkTotal } = event;
  if (!Array.isArray(customers) || !customers.length) return { ok: false, code: 'BAD_ARG', msg: '没有可导入的数据' };
  const now = Date.now();

  // 0) 集合自愈：不存在则自动创建（已存在会抛错，忽略）
  try { await db.createCollection('mall_customers'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('import_batches'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('mall_claims'); } catch (e) { /* 已存在 */ }

  // 1) 商城客户库入库（mallKey 去重：新 key 新增；老 key 有变化才更新——静态字段 diff，动态字段必刷）
  //    分片模式：只查本片需要的 keys（免费环境云函数 3 秒超时，全量拉取会超时）
  const keys = customers.map(c => String(c.mallKey || '').trim()).filter(Boolean);
  const existMap = {};
  for (let i = 0; i < keys.length; i += 80) {
    const r = await db.collection('mall_customers').where({ mallKey: _.in(keys.slice(i, i + 80)) }).get();
    r.data.forEach(x => { existMap[x.mallKey] = x; });
  }
  // ⭐ 2026-09-29：**与 MALL_FIELD_PAIRS 对齐（14 项）** —— 补 mallCode。
  //   mallCode（客户编号）是**订单匹配的钥匙**（orders.customerCode），以前解析端和这里都漏了它。
  const STATIC_FIELDS = ['mallCode', 'name', 'region', 'address', 'phone', 'tags', 'category', 'salesman', 'source', 'level'];
  const toAdd = [];
  const toUpdate = [];
  customers.forEach(c => {
    const key = String(c.mallKey || '').trim();
    const doc = {
      mallKey: key, mallCode: String(c.mallCode || '').trim(),
      name: String(c.name || '').trim(), region: String(c.region || '').trim(),
      address: String(c.address || '').trim(), phone: String(c.phone || '').trim(),
      addedAt: c.addedAt || '', lastOrderAt: c.lastOrderAt || '', lastBrowseAt: c.lastBrowseAt || '',
      tags: c.tags || '', category: c.category || '', salesman: c.salesman || '',
      source: c.source || '', level: c.level || '', updatedAt: now
    };
    const old = existMap[key];
    if (!key || !old) { toAdd.push(doc); existMap[key] = doc; }
    else {
      const staticChanged = STATIC_FIELDS.some(f => String(old[f] || '') !== String(doc[f] || ''));
      const dynamicChanged = String(old.lastOrderAt || '') !== doc.lastOrderAt || String(old.lastBrowseAt || '') !== doc.lastBrowseAt || String(old.addedAt || '') !== doc.addedAt;
      if (staticChanged || dynamicChanged) toUpdate.push({ old, doc });
    }
  });
  const BATCH = 50;
  for (let i = 0; i < toAdd.length; i += BATCH) {
    await Promise.all(toAdd.slice(i, i + BATCH).map(doc => db.collection('mall_customers').add({ data: doc })));
  }
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    await Promise.all(toUpdate.slice(i, i + BATCH).map(x =>
      db.collection('mall_customers').doc(x.old._id).update({ data: x.doc })
    ));
    updated += toUpdate.slice(i, i + BATCH).length;
  }

  // 分片模式：非最后一片只入库；最后一片由前端再调 runMallMatch 比对认领
  if (chunkTotal && chunkIndex !== chunkTotal - 1) {
    return { ok: true, chunk: true, added: toAdd.length, updated };
  }
  if (chunkTotal) {
    // 最后一片：入库完成，比对另起（避免本函数超时）
    return { ok: true, chunk: true, last: true, added: toAdd.length, updated };
  }
  // 兼容单次调用（小数据量）：直接入库 + 比对
  const matchRes = await runMallMatch(event);
  return { ok: true, added: toAdd.length, updated, ...matchRes };
}

// ⭐⭐ 2026-09-29【老板定：**商城库里的字段，有信息就全倒过来**】
//   老板原话：「就是库里这 13 个，只要有信息就倒过来」+「商城优先 —— 商城有值就写上（覆盖现场填的）」。
//   背景：原来只倒 7 个（mallKey / addedAt / salesman / level / source / lastOrderAt / lastBrowseAt），
//         **漏了 name / region / address / phone / tags / category** —— 同一件事两套口径（比对认领 vs 刷新按钮）。
//   这张表是**唯一真相**：商城库字段名 → 客户档案落点。
//   ⚠️ 必须与 `admin/server.js` 的 MALL_HEADER_ALIAS（商城表解析，13 列）**保持一致** ——
//      那边少解析一列，这边就倒不出东西（链路是：Excel → mall_customers → customers）。
const MALL_FIELD_PAIRS = [
  ['mallKey',      'mallKey'],        // 商城系统 Key（认领关系的根）
  ['mallCode',     'mallCode'],       // ⭐ 客户编号（如 c347 / AA021）—— **订单按 customerCode 匹配，缺了它订单永远挂不上**
  ['addedAt',      'mallJoinedAt'],   // 注册商城时间
  ['name',         'name'],           // 店名（商城值优先）
  ['region',       'region'],         // 地区
  ['address',      'address'],        // 公司地址
  ['phone',        'phone'],          // 联系电话
  ['salesman',     'mallSalesman'],   // 业务负责人（签约业务员，原值照抄，不许改成真人名）
  ['level',        'mallLevel'],      // 等级
  ['source',       'mallSource'],     // 来源（落点沿用现口径 mallSource）
  ['tags',         'mallTags'],       // 客户标签
  ['category',     'mallCategory'],   // 客户分类
  ['lastOrderAt',  'lastOrderAt'],    // 最后下单
  ['lastBrowseAt', 'lastBrowseAt']    // 最后浏览商城
];
// ⚠️⚠️ **绝不覆盖字段（硬拦）** —— 老板 2026-09-29 明确：「**经纬度要以现场为准**」。
//   理由：商城坐标是"注册时填的地址 / 商城侧地图定位"；**业务员现场采的才是真的到过那个点**。
//   所以坐标及其状态/来源**永远由现场（业务员）说了算**，商城表倒多少次都不许碰。
//   这道拦截是**安全网**：正常走不到（MALL_FIELD_PAIRS 里本来就没有坐标字段），
//   但它保证"以后有人往表里加了 lat —— 也不会把现场坐标冲掉"。
const MALL_NO_TOUCH = ['lat', 'lng', 'wgsLat', 'wgsLng', 'coord_status', 'coordSource', 'coordUpdatedAt', 'coordFixReviewedAt'];
// 从商城档案抽出"该写进客户档案的字段"。
// ⚠️ **商城值为空 → 不覆盖**（否则会把客户已有的地址/电话抹成空）。
function mallFieldsFrom(m) {
  const out = {};
  MALL_FIELD_PAIRS.forEach(pair => {
    const v = m[pair[0]];
    if (v === undefined || v === null || String(v) === '') return;
    if (MALL_NO_TOUCH.indexOf(pair[1]) >= 0) return;   // ⚠️ 坐标类字段一律不碰（见上）
    out[pair[1]] = v;
  });
  // ⭐ 2026-10-03 老板定：业务员**「随时可改，导入时被盖」** ——
  //   商城表带来的是「业务负责人」，除了照抄进 mallSalesman（原值，商城信息卡显示"签约业务员"），
  //   **同时写进 salesman**（= 后台详情页那个可下拉的「业务员」格）→ 商城表再导入一次，就把手选的盖掉。
  //   ⚠️ 商城值为空 → 上面 forEach 已经 return，两个字段都不动（不会把现场/手填的值抹掉）。
  if (out.mallSalesman !== undefined) out.salesman = out.mallSalesman;
  return out;
}

// 独立比对认领（2026-09-08 批次化：batchId 存在=仅比对/认领该批次成员；缺省=全量回访客户）
async function runMallMatch(event) {
  const { fileName, batchId } = event || {};
  const now = Date.now();
  try { await db.createCollection('mall_customers'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('mall_claims'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('import_batches'); } catch (e) { /* 已存在 */ }

  // 回访客户与商城库比对（电话→名称→地址，三档）；批次模式只取该批次成员
  // ⚠️ 必须把 source 取出来 —— 下面要区分"现场录入的店"（source:'field'）
  // ⭐ 2026-09-29：**带上 MALL_FIELD_PAIRS 的全部落点字段** ——
  //   同 key 分支要按落点逐字段 diff，少 fetch 一个字段就会把它当成"变了"而重复写（或反过来漏写）。
  const V_FIELDS = { phone: true, phone2: true, name: true, address: true, region: true,
                     mallKey: true, mallCode: true,
                     lastOrderAt: true, lastBrowseAt: true, mallJoinedAt: true,
                     mallSource: true, mallLevel: true, mallSalesman: true,
                     salesman: true,   // ⭐ 2026-10-03：mallFieldsFrom 现在也回写 salesman（业务员「导入时被盖」）—— 不 fetch 它，diff 就会每轮误判"变了"而重写
                     mallTags: true, mallCategory: true,
                     source: true };
  let visitCusts;
  if (batchId) {
    const members = await fetchAll('batch_members', { batchId }, { customerId: true });
    const ids = members.map(m => m.customerId);
    // ⭐ 2026-09-29 回收站：已删客户**不参与比对**（躺在回收站里的店不该被"认领"回来）
    visitCusts = ids.length ? await fetchAll('customers', _.and([{ _id: _.in(ids), customerType: 'mall' }, NOT_DELETED]), V_FIELDS) : [];
  } else {
    visitCusts = await fetchAll('customers', _.and([{ customerType: 'mall' }, NOT_DELETED]), V_FIELDS);
  }
  // ⭐⭐ 2026-09-29【老板定：**导入商城内有关这个客户的档案，才算建档**】
  //   原来只比对 `customerType:'mall'` → **现场录入的店（customerType:'new' + source:'field'）根本不在范围内**
  //   → 它们**永远对不上商城** → 唯一出口只剩「待商城建档」页那个手动按钮
  //   → 一按就把 mallPending 抹掉、可注册时间/关联业务员/编号**全是空的**，以后销售订单也接不上
  //     （老板原话："不能直接按键就改成商城用户了"）。
  //   现在把 `source:'field'` 的店**也纳入比对** —— 导入商城表后真对上了，才算真正建档。
  const fieldCusts = await fetchAll('customers', _.and([{ source: 'field' }, NOT_DELETED]), V_FIELDS);
  const _seenV = {};
  visitCusts.forEach(v => { _seenV[v._id] = 1; });
  fieldCusts.forEach(v => { if (!_seenV[v._id]) visitCusts.push(v); });
  // ⭐ 2026-09-29：商城库字段**取全（14 个）** —— mallFieldsFrom 要按 MALL_FIELD_PAIRS 逐个抽
  const mallAll = await fetchAll('mall_customers', {}, {
    mallKey: true, mallCode: true, name: true, region: true, address: true, phone: true,
    addedAt: true, lastOrderAt: true, lastBrowseAt: true,
    tags: true, category: true, salesman: true, source: true, level: true
  });
  // 预规范化：双重循环内不再对同一字符串反复清洗（曾 15 万次 pair × 4 次正则清洗超时 -601008）
  const mallPool = mallAll.map(m => ({ m, nName: normName(m.name), nAddr: normAddr(m.address) }));
  const vPool = visitCusts.map(v => ({
    v,
    nName: normName(v.name),
    nAddr: normAddr(v.address),
    phones: [v.phone, v.phone2].map(p => String(p || '').trim()).filter(Boolean)
  }));
  let autoMatched = 0;
  let dynamicRefreshed = 0;
  let staticChangedCnt = 0;
  const pendingList = [];
  const autoUpdates = [];
  vPool.forEach(({ v, nName, nAddr, phones }) => {
    let best = { score: 0, reason: '', mall: null };
    for (const { m, nName: mn, nAddr: ma } of mallPool) {
      const r = matchMall(v, m, nName, nAddr, phones, mn, ma);
      if (r.score > best.score) best = r;
    }
    if (best.score >= 75 && best.mall) {
      const m = best.mall;
      autoMatched++;
      // ⭐⭐ 2026-09-29【老板定：商城库 13 个字段**有信息就全倒**】
      //   老板原话：「就是库里这 13 个，只要有信息就倒过来」+「商城优先 —— 商城有值就写上」
      //            +「但是经纬度要以现场为准」。
      //   所以：① 统一用 mallFieldsFrom(m) 抽（含 name / region / address / phone / mallTags / mallCategory）；
      //        ② 坐标类字段**永不入表**（硬拦在 mallFieldsFrom 里，见 MALL_NO_TOUCH）。
      const _data = Object.assign(mallFieldsFrom(m), {
        mallMatchScore: best.score,
        mallMatchedAt: now
      });
      // ⭐⭐ 2026-09-29【老板定：**导入商城内有关这个客户的档案，才算建档**】
      //   现场录入的店（source:'field'）一旦在商城里对上 → **这才算真正建档**：
      //   置 mallPending:false + customerType:'mall' —— 此刻**注册商城时间 / 关联（签约）业务员 / 客户编号**全都齐了，
      //   以后的销售订单也接得上。
      //   （以前靠「待商城建档」页那个手动按钮抹标记 —— 已按老板要求去掉，见 fieldDone 注释）
      if (v.source === 'field') {
        _data.mallPending = false;
        _data.customerType = 'mall';
        _data.mallPendingDoneAt = now;
      }
      autoUpdates.push({ v, data: _data });
    } else if (best.score >= 45 && best.mall) {
      pendingList.push({
        customerId: v._id, customerName: v.name,
        mallKey: best.mall.mallKey, mallName: best.mall.name,
        score: best.score, reason: best.reason,
        batchId: batchId || '', // 2026-09-08：待确认归属批次（批次卡上的待确认清单只显示本批）
        status: 'pending', batchAt: now, createdAt: now
      });
    }
  });
  // 认领写入策略：未认领→全量写入；同一 mallKey→**按 MALL_FIELD_PAIRS 逐字段 diff**；换人→全量更新
  // ⭐ 2026-09-29 改：原来只 diff 5 个手写的静态字段（MALL_STATIC），漏了 name/region/address/phone/tags/category
  //   → 表现成"同一家店明明改了标签/分类，比对跑完却什么都没更新"。现在统一按映射表逐字段比，**与全量写入同一口径**。
  const BATCH = 50;
  for (let i = 0; i < autoUpdates.length; i += BATCH) {
    await Promise.all(autoUpdates.slice(i, i + BATCH).map(async ({ v, data }) => {
      const oldMallKey = v.mallKey || '';
      if (!oldMallKey) {
        await db.collection('customers').doc(v._id).update({ data: Object.assign({}, data, { updatedAt: Date.now() }) });   // 2026-09-27 补：增量同步用
        return;
      }
      if (oldMallKey === data.mallKey) {
        const upd = {};
        Object.keys(data).forEach(cf => {
          if (cf === 'mallMatchScore' || cf === 'mallMatchedAt') return;   // 这两个每次都写，不参与 diff
          if (String(v[cf] || '') !== String(data[cf] || '')) upd[cf] = data[cf];
        });
        if (Object.keys(upd).length) {
          if (upd.lastOrderAt || upd.lastBrowseAt) dynamicRefreshed++;
          await db.collection('customers').doc(v._id).update({ data: Object.assign({}, upd, { updatedAt: Date.now() }) });   // 2026-09-27 补
        }
      } else {
        staticChangedCnt++;
        await db.collection('customers').doc(v._id).update({ data: Object.assign({}, data, { updatedAt: Date.now() }) });   // 2026-09-27 补
      }
    }));
  }
  // 待确认：同一回访客户只保留最新一条待确认（confirmed/rejected 人工结果不动）
  for (let i = 0; i < pendingList.length; i += BATCH) {
    await Promise.all(pendingList.slice(i, i + BATCH).map(async p => {
      const old = await db.collection('mall_claims').where({ customerId: p.customerId, status: 'pending' }).get();
      await Promise.all(old.data.map(o => db.collection('mall_claims').doc(o._id).remove()));
      await db.collection('mall_claims').add({ data: p });
    }));
  }

  // 批次记录（可追溯）
  const report = {
    fileName: fileName || '',
    type: 'mall',
    autoMatched,
    dynamicRefreshed,
    staticChangedCnt,
    pending: pendingList.length,
    ignored: visitCusts.length - autoMatched - pendingList.length,
    createdAt: now
  };
  await db.collection('import_batches').add({ data: report });
  return { ok: true, ...report };
}

// ===== 本地比对支持（2026-09-08 老板定：比对在浏览器本地跑，云端只拉库/写结果，防 30s 超时） =====
// 拉全量商城库（比对源；字段裁剪到比对+认领所需）
async function listMallLibrary(event) {
  // ⭐ 2026-09-29：**商城库字段取全（14 个）** —— 本地比对认领后要按 MALL_FIELD_PAIRS 整批倒进客户档案，
  //   少取一个（如 mallCode / tags / category / region）就会变成"浏览器比对 和 云端比对 结果不一样"。
  const malls = await fetchAll('mall_customers', {}, {
    mallKey: true, mallCode: true, name: true, region: true, address: true, phone: true,
    addedAt: true, lastOrderAt: true, lastBrowseAt: true,
    tags: true, category: true, salesman: true, source: true, level: true
  });
  return { ok: true, count: malls.length, malls };
}

// 应用本地比对结果：认领写档案（策略与 runMallMatch 一致）+ 待确认写 mall_claims + 批次记录
async function applyMallMatch(event) {
  const { batchId, claims, pendings, ignored } = event;
  const now = Date.now();
  try { await db.createCollection('mall_claims'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('import_batches'); } catch (e) { /* 已存在 */ }
  const claimList = (Array.isArray(claims) ? claims : []).filter(c => c && c.customerId && c.mall && c.mall.mallKey);
  const pendingList = (Array.isArray(pendings) ? pendings : []).filter(p => p && p.customerId && p.mallKey);
  if (!claimList.length && !pendingList.length) return { ok: false, code: 'BAD_ARG', msg: '没有可应用的结果' };

  // 1) 认领写档案：拉客户当前值 → 内存 diff → 并行写（未认领→全量；同 mallKey→仅动态刷新；换人→全量）
  let autoMatched = 0, dynamicRefreshed = 0, staticChangedCnt = 0;
  if (claimList.length) {
    const ids = [...new Set(claimList.map(c => c.customerId))];
    // ⚠️ 带上 source —— 认领的是"现场录入的店"时要顺手把 mallPending 结掉（与 runMallMatch 同口径）
    // ⚠️ 带上 source + MALL_FIELD_PAIRS 的全部落点 —— 逐字段 diff 要用（少一个就会误判"变了"）
    const custRows = await fetchAll('customers', { _id: _.in(ids) }, {
      mallKey: true, mallCode: true, lastOrderAt: true, lastBrowseAt: true, mallJoinedAt: true,
      mallSource: true, mallLevel: true, mallSalesman: true, salesman: true, mallTags: true, mallCategory: true,   // ⭐ salesman：与 mallFieldsFrom 的回写对齐（否则 diff 误判）
      name: true, region: true, address: true, phone: true, phone2: true, source: true
    });
    const cMap = {};
    custRows.forEach(c => { cMap[c._id] = c; });
    await runPool(claimList, 15, async ({ customerId, mall, score }) => {
      const v = cMap[customerId];
      if (!v) return;
      // ⭐⭐ 2026-09-29【老板定：商城库 13 个字段**有信息就全倒**，不是只倒 7 个】
      //   与 runMallMatch **完全同口径**：统一走 mallFieldsFrom（含 name / region / address / phone / mallTags / mallCategory）；
      //   坐标类字段永不入表（硬拦在 mallFieldsFrom 里 —— 老板定：「经纬度要以现场为准」）。
      const data = Object.assign(mallFieldsFrom(mall), {
        mallMatchScore: Number(score) || 0,
        mallMatchedAt: now
      });
      // ⭐⭐ 2026-09-29【老板定：导入商城档案才算建档】—— 与 runMallMatch **完全同口径**：
      //   本地比对认领（浏览器里跑）这条路也必须把"现场录入的店"转正，
      //   否则会出现"云端自动比对能转正、本地认领不能"的不一致。
      if (v.source === 'field') {
        data.mallPending = false;
        data.customerType = 'mall';
        data.mallPendingDoneAt = now;
      }
      autoMatched++;
      const oldMallKey = v.mallKey || '';
      if (!oldMallKey) { await db.collection('customers').doc(customerId).update({ data: Object.assign({}, data, { updatedAt: Date.now() }) }); return; }   // 2026-09-27 补
      if (oldMallKey === data.mallKey) {
        const upd = {};
        if (String(v.lastOrderAt || '') !== data.lastOrderAt) upd.lastOrderAt = data.lastOrderAt;
        if (String(v.lastBrowseAt || '') !== data.lastBrowseAt) upd.lastBrowseAt = data.lastBrowseAt;
        // ⭐ 2026-09-29：改成**按落点逐字段 diff**（原来只比 5 个手写字段，漏了 name/region/address/phone/tags/category）
        Object.keys(data).forEach(cf => {
          if (cf === 'mallMatchScore' || cf === 'mallMatchedAt') return;   // 每次都写，不参与 diff
          if (String(v[cf] || '') !== String(data[cf] || '')) upd[cf] = data[cf];
        });
        if (Object.keys(upd).length) {
          if (upd.lastOrderAt || upd.lastBrowseAt) dynamicRefreshed++;
          await db.collection('customers').doc(customerId).update({ data: Object.assign({}, upd, { updatedAt: Date.now() }) });   // 2026-09-27 补
        }
      } else {
        staticChangedCnt++;
        await db.collection('customers').doc(customerId).update({ data: Object.assign({}, data, { updatedAt: Date.now() }) });   // 2026-09-27 补
      }
    });
  }
  // 2) 待确认写 mall_claims（同一回访客户只保留最新一条 pending；人工确认/拒绝的结果不动）
  await runPool(pendingList, 15, async p => {
    const old = await db.collection('mall_claims').where({ customerId: p.customerId, status: 'pending' }).get();
    await Promise.all(old.data.map(o => db.collection('mall_claims').doc(o._id).remove()));
    await db.collection('mall_claims').add({
      data: {
        customerId: p.customerId, customerName: p.customerName || '',
        mallKey: p.mallKey, mallName: p.mallName || '',
        score: Number(p.score) || 0, reason: p.reason || '',
        batchId: batchId || '', status: 'pending', batchAt: now, createdAt: now
      }
    });
  });
  // 3) 批次记录（可追溯）
  await db.collection('import_batches').add({
    data: {
      fileName: '', type: 'mall',
      autoMatched, dynamicRefreshed, staticChangedCnt,
      pending: pendingList.length,
      ignored: Number(ignored) || 0,
      createdAt: now
    }
  });
  return { ok: true, autoMatched, dynamicRefreshed, staticChangedCnt, pending: pendingList.length, msg: `已应用：自动认领 ${autoMatched} 家、待确认 ${pendingList.length} 条、忽略 ${Number(ignored) || 0} 条` };
}

// ===== 从商城更新客户信息（2026-09-25 老板定：做成按钮 —— 先预览、确认后才写、且只写白名单字段）=====
// 背景：原先的「商城比对认领」（runMallMatch / applyMallMatch）是**自动**跑的，老板要的是**可控**：
//   点一下先看"将更新 N 家 / 共 M 个字段（逐字段 from → to）"，确认后**才**写。
// ⭐⭐ 2026-09-29 老板定：白名单**与比对认领同源** —— 不再各写一份。
//   老板原话：「就是库里这 13 个，只要有信息就倒过来」+「商城优先」+「但是经纬度要以现场为准」。
//   原来这里是**手写的第二份清单**（10 项，且漏了 name / addedAt）→ 两套口径必然漂移
//   （表现：自动比对倒得全、点这个按钮反而倒得少）。本次合并成**一张表**（MALL_FIELD_PAIRS）。
const REFRESH_MAP = MALL_FIELD_PAIRS;
// ⚠️ **绝不被商城覆盖的**（客户自己的资料 / 现场事实）：
//   · lat / lng / coord_status / coordSource ← 坐标（老板定：「**经纬度要以现场为准**」）
//   · remark（客户备注）、photos（现场照片）、batchIds（批次归属）、status、customerType
//   · plat 里**人工录入**的内容（招牌菜 / 设施等，来自业务员现场提报）
//   —— 坐标类由 MALL_NO_TOUCH 在 mallFieldsFrom 里**代码级硬拦**；plat 不在 MALL_FIELD_PAIRS 里，天然不碰。
// ⚠️ `plat`（平台画像：评分/口味环境服务/菜品/设施/图片…）**不在商城库里** —— 它来自大众点评，
//   只在导入 customers 分片时写入，所以本入口拿不到、也不动它（要更新 plat 走分片导入）。
async function refreshFromMall(event) {
  const doApply = !!(event && event.apply);   // 不传 apply = 只预览，绝不写库
  // ⚠️ 字段要与 MALL_FIELD_PAIRS 的**落点**对齐（少一个 → diff 时误判"变了"）
  // ⭐ 2026-09-29 回收站：已删客户**不参与"从商城更新"**（免得它没在列表里、却偷偷被改）
  const custs = await fetchAll('customers', NOT_DELETED, {
    _id: true, mallKey: true, mallCode: true, name: true, region: true,
    address: true, phone: true, phone2: true,
    lastOrderAt: true, lastBrowseAt: true, mallJoinedAt: true,
    mallLevel: true, mallSalesman: true, salesman: true,   // ⭐ salesman：「从商城更新」也照"业务员导入时被盖"的口径（见 mallFieldsFrom）
    mallSource: true, mallTags: true, mallCategory: true
  });
  const malls = await fetchAll('mall_customers', {}, {});
  const byKey = {};
  malls.forEach(m => { const k = String(m.mallKey || '').trim(); if (k) byKey[k] = m; });

  const items = [];   // 预览明细
  const writes = [];  // 待写
  custs.forEach(c => {
    const k = String(c.mallKey || '').trim();
    if (!k) return;                       // 没认领过商城的，跳过（认领走比对那条链路）
    const m = byKey[k];
    if (!m) return;
    const diff = [];
    const upd = {};
    REFRESH_MAP.forEach(([mf, cf]) => {
      const nv = String(m[mf] == null ? '' : m[mf]).trim();
      const ov = String(c[cf] == null ? '' : c[cf]).trim();
      if (!nv || nv === ov) return;       // 商城值为空 → 视为"没这项"，不覆盖（防止把已有值清空）
      diff.push({ field: cf, from: ov, to: nv });
      upd[cf] = m[mf];
    });
    // ⭐ 2026-10-03 老板定（业务员「随时可改，导入时被盖」）：
    //   「从商城更新」走的也是这张映射表，但 `salesman` **不是它的落点**（落点是 mallSalesman），
    //   这里单独补一次 —— 与 mallFieldsFrom（比对 / 认领那条链路）**同一口径**：
    //   商城有业务负责人就写进 salesman。
    const nvSm = String(m.salesman == null ? '' : m.salesman).trim();
    if (nvSm && nvSm !== String(c.salesman == null ? '' : c.salesman).trim()) {
      diff.push({ field: 'salesman', from: String(c.salesman || ''), to: nvSm });
      upd.salesman = m.salesman;
    }
    if (diff.length) {
      items.push({ customerId: c._id, name: c.name, mallName: m.name || '', changes: diff });
      writes.push({ id: c._id, upd });
    }
  });
  const fieldCount = items.reduce((s, x) => s + x.changes.length, 0);

  if (!doApply) {
    return {
      ok: true, preview: true, customers: items.length, fields: fieldCount,
      items: items.slice(0, 300),   // 明细最多回 300 家，避免返回值过大
      msg: `将更新 ${items.length} 家、共 ${fieldCount} 个字段（尚未写入）`
    };
  }

  const t0 = Date.now();
  let updated = 0, failed = 0;
  for (let i = 0; i < writes.length; i += 20) {
    await Promise.all(writes.slice(i, i + 20).map(async w => {
      try {
        await db.collection('customers').doc(w.id).update({ data: Object.assign({}, w.upd, { mallRefreshedAt: Date.now(), updatedAt: Date.now() }) });   // 2026-09-27 补
        updated++;
      } catch (e) { failed++; }   // 单条失败不影响其他
    }));
  }
  return { ok: true, preview: false, customers: writes.length, fields: fieldCount, updated, failed, ms: Date.now() - t0, msg: `已更新 ${updated} 家（共 ${fieldCount} 个字段）${failed ? '，失败 ' + failed + ' 家' : ''}` };
}

// ===== 多城市改造 · 第 1 步：回填三层骨架字段（2026-09-26）=====
// 给 customers 补 city / district / bizCircle 三个字段（设计文档 §05）。
// ⚠️ 云函数 30 秒超时 → **必须分批调用**（每次 200 条，调用方循环 offset；200 条一轮约 1~2 秒）。
// 返回值带 samples（前 5 条算出来的结果）→ 可以先 dry=true 看规则对不对，再真写。
async function backfillGeo(event) {
  const offset = Math.max(0, Number(event.offset) || 0);
  const limit  = Math.min(Math.max(Number(event.limit) || 200, 1), 500);
  const dry    = event.dry === true;          // true = 只算不写

  const r = await db.collection('customers').orderBy('_id', 'asc').skip(offset).limit(limit).get();
  const list = r.data || [];
  const samples = [], writes = [];
  let skipped = 0;

  list.forEach(c => {
    const geo = deriveGeo(c);
    if (samples.length < 5) samples.push({ name: c.name, ...geo });
    if (!geo.changed) { skipped++; return; }
    writes.push({ id: c._id, geo });
  });

  if (dry) {
    return { ok: true, dry: true, offset, processed: list.length, willUpdate: writes.length, skipped, samples };
  }

  let updated = 0, failed = 0;
  for (let i = 0; i < writes.length; i += 20) {
    await Promise.all(writes.slice(i, i + 20).map(async w => {
      try {
        await db.collection('customers').doc(w.id).update({ data: {
          city: w.geo.city, district: w.geo.district, bizCircle: w.geo.bizCircle,
          geoBackfilledAt: Date.now(),
          updatedAt: Date.now()          // 2026-09-27 补：增量同步用
        } });
        updated++;
      } catch (e) { failed++; }
    }));
  }
  const cnt = await db.collection('customers').count().catch(() => ({ total: 0 }));
  return { ok: true, dry: false, offset, processed: list.length, updated, skipped, failed,
           total: cnt.total, nextOffset: offset + list.length, samples };
}

// 取数规则（设计文档 §05）：
//   city      ← plat.city        退化：region（"浙江省>金华市>永康市"）第 2 段
//   district  ← plat.district    退化：region 第 3 段
//   bizCircle ← plat.regionName  退化："❓ 未划分商圈"（骨架不断裂、不丢客户）
function deriveGeo(c) {
  const p = c.plat || {};
  const seg = String(c.region || '').split('>').map(s => s.trim()).filter(Boolean);
  let city = String(p.city || '').trim() || seg[1] || '';
  if (city && !/市$/.test(city)) city += '市';
  const district = String(p.district || '').trim() || seg[2] || '';
  // ⚠️ 2026-10-06 修（老板报障 C1562/A389/C419/C723「商圈没显示」）——
  //   原来**只认 `plat.regionName`**，没有像 city / district 那样的分段退化 → 没有 plat 的客户
  //   直接落兜底「❓ 未划分商圈」。而商城表的「地区」列格式是 `浙江省>金华市>永康市>龙山镇`
  //   （seg[1]=市 / seg[2]=区县 / **seg[3]=商圈**）→ 补上 seg[3] 退化。
  //   ⚠️ 与 `importdata` 的 deriveGeo **必须保持一致**（改一处要改两处）。
  const bizCircle = String(p.regionName || '').trim() || seg[3] || '❓ 未划分商圈';
  const changed = String(c.city || '') !== city
               || String(c.district || '') !== district
               || String(c.bizCircle || '') !== bizCircle;
  return { city, district, bizCircle, changed };
}

// ===== 待确认认领清单（mall_claims 人工确认/拒绝；2026-09-08 批次化：batchId 过滤本批） =====
async function listMallClaims(event) {
  const { batchId } = event || {};
  try { await db.createCollection('mall_claims'); } catch (e) { /* 已存在 */ }
  let q = { status: 'pending' };
  if (batchId) {
    // 本批次待确认 = 认领记录带 batchId 的（新比对写入）；兼容老记录（无 batchId）仅在无批次模式显示
    q = { status: 'pending', batchId };
  }
  const res = await db.collection('mall_claims').where(q).orderBy('createdAt', 'desc').limit(200).get();
  // 附上商城库最新档案（确认前预览）
  const keys = [];
  const keySet = {};
  res.data.forEach(c => { if (c.mallKey && !keySet[c.mallKey]) { keySet[c.mallKey] = true; keys.push(c.mallKey); } });
  const mallMap = {};
  for (let i = 0; i < keys.length; i += 80) {
    const r = await db.collection('mall_customers').where({ mallKey: _.in(keys.slice(i, i + 80)) }).get();
    r.data.forEach(m => { mallMap[m.mallKey] = m; });
  }
  return {
    ok: true,
    claims: res.data.map(c => {
      const m = mallMap[c.mallKey] || {};
      return {
        _id: c._id, customerId: c.customerId, customerName: c.customerName,
        mallKey: c.mallKey, mallName: c.mallName, score: c.score, reason: c.reason,
        mallAddedAt: m.addedAt || '', mallLastOrderAt: m.lastOrderAt || '',
        mallLastBrowseAt: m.lastBrowseAt || '', mallSalesman: m.salesman || '',
        mallLevel: m.level || '', mallSource: m.source || '',
        batchAt: c.batchAt, createdAt: c.createdAt
      };
    })
  };
}

async function resolveMallClaim(event) {
  const { claimId, decision } = event;
  if (!claimId || !['confirm', 'reject'].includes(decision)) {
    return { ok: false, code: 'BAD_ARG', msg: '参数错误' };
  }
  const cRes = await db.collection('mall_claims').doc(claimId).get().catch(() => null);
  const claim = cRes && cRes.data;
  if (!claim) return { ok: false, code: 'NOT_FOUND', msg: '认领记录不存在' };
  if (claim.status !== 'pending') return { ok: false, code: 'DONE', msg: '该记录已处理过' };
  const now = Date.now();
  const by = event._admin && event._admin.name;

  if (decision === 'reject') {
    await db.collection('mall_claims').doc(claimId).update({ data: { status: 'rejected', resolvedAt: now, resolvedBy: by } });
    return { ok: true, decision: 'rejected' };
  }

  // confirm：把商城档案（取商城库最新值）写入回访客户
  const custRes = await db.collection('customers').doc(claim.customerId).get().catch(() => null);
  if (!custRes || !custRes.data) {
    return { ok: false, code: 'CUST_NOT_FOUND', msg: '回访客户不存在（可能已删除）' };
  }
  const mRes = await db.collection('mall_customers').where({ mallKey: claim.mallKey }).limit(1).get();
  const m = mRes.data[0] || {};
  await db.collection('customers').doc(claim.customerId).update({
    data: {
      mallKey: claim.mallKey,
      updatedAt: Date.now(),        // 2026-09-27 补：增量同步（custSync）用
      mallJoinedAt: m.addedAt || '',
      lastOrderAt: m.lastOrderAt || '',
      lastBrowseAt: m.lastBrowseAt || '',
      mallSource: m.source || '',
      mallLevel: m.level || '',
      mallSalesman: m.salesman || '',
      mallMatchScore: claim.score,
      mallMatchedAt: now
    }
  });
  await db.collection('mall_claims').doc(claimId).update({ data: { status: 'confirmed', resolvedAt: now, resolvedBy: by } });
  return { ok: true, decision: 'confirmed' };
}

// 管理员审批任务结束申请：同意→done；拒绝→回到 published（业务员继续完成）
async function reviewFinishRequest(event) {
  const { taskId, approve } = event;
  if (!taskId) return { ok: false, code: 'BAD_ARG', msg: '缺少任务' };
  const tRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const t = tRes && tRes.data;
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '任务不存在' };
  if (t.status !== 'reviewing') return { ok: false, code: 'STATE', msg: '该任务不在审核中' };
  const now = Date.now();
  const admin = (event._admin && event._admin.name) || '系统';
  if (approve) {
    // 同意：finishReq 保留作历史档案（2026-09-08 历史任务板块），审核动作写流水
    const logs = withLog(t, { at: now, by: admin, role: 'admin', type: 'reviewApprove', detail: {} });
    await db.collection('tasks').doc(taskId).update({
      data: { status: 'done', finishedAt: now, finishedBy: admin, logs }
    });
    return { ok: true, status: 'done', msg: '已同意，任务提前结束' };
  }
  // 拒绝：finishReq 保留（业务员可再次提交会覆盖），拒绝人/时间/原因入流水
  const note = String(event.note || '').trim().slice(0, 200);
  const logs = withLog(t, { at: now, by: admin, role: 'admin', type: 'reviewReject', detail: { note } });
  await db.collection('tasks').doc(taskId).update({
    data: { status: 'published', logs }
  });
  return { ok: true, status: 'published', msg: '已驳回，业务员继续完成任务' };
}

// 某客户在某任务内的全部拜访记录（拜访详情弹窗用；时间倒序）
async function listCustomerVisits(event) {
  const { taskId, customerId } = event;
  if (!taskId || !customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少任务或客户' };
  const res = await db.collection('visits')
    .where({ taskId, customerId })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  // 2026-09-11 M2c：批量带上每条拜访的语音转写（状态 + 文字），供后台「拜访详情」显示
  const withAudio = res.data.filter(v => (Array.isArray(v.audios) && v.audios.length) || (v.audio && v.audio.fileID));
  const trMap = {};
  withAudio.forEach(v => { trMap[v._id] = { total: 0, done: 0, failed: 0, running: 0, segs: [] }; });
  if (withAudio.length) {
    const tr = await db.collection('transcripts')
      .where({ visitId: _.in(withAudio.map(v => v._id)) })
      .orderBy('segIndex', 'asc').limit(300).get();
    (tr.data || []).forEach(t => {
      const m = trMap[t.visitId];
      if (!m) return;
      m.total++;
      if (t.status === 'done') { m.done++; m.segs.push(t); }
      else if (t.status === 'failed') m.failed++;
      else m.running++;
    });
  }
  // 2026-09-11 老板定：多段录音的转写之间要有分隔标识（让人分得清哪段是哪段）
  const segsText = (segs) => {
    const list = (segs || []).slice().sort((a, b) => (a.segIndex || 0) - (b.segIndex || 0));
    if (!list.length) return '';
    // 2026-09-11 修复（审查发现）：编号用转录记录里的【真实 segIndex】，而不是「已成功段的下标」。
    // 否则某段未转写/失败时，后面的【录音 N】会前移错位（真实第 3 段被标成第 2 段）。
    const multi = list.length > 1 || (Number(list[0].segIndex) || 0) > 0;
    if (!multi) return list[0].text || '';
    return list.map(x => `【录音 ${(Number(x.segIndex) || 0) + 1}】\n${x.text || ''}`).join('\n\n');
  };
  // 2026-09-11 老板定：转写文字可人工修订 → trEdited 优先（与 visits.history 同口径，前后台同步）
  const trOf = (v) => {
    const m = trMap[v._id];
    const edited = v.trEdited && typeof v.trEdited.text === 'string' ? v.trEdited.text : '';
    if (!m || !m.total) return null;
    const status = m.running > 0 ? 'processing' : (m.done > 0 ? (m.failed > 0 ? 'partial' : 'done') : 'failed');
    return {
      status,
      segCount: m.total,
      edited: !!edited,
      editedAt: (v.trEdited && v.trEdited.at) || 0,
      text: edited || segsText(m.segs)
    };
  };
  return {
    ok: true,
    visits: res.data.map(v => ({
      _id: v._id,
      visitedAt: v.visitedAt,
      timeHM: fmtHM(v.finishedAt || v.createdAt),
      status: v.status,
      result: v.result || '',
      text: v.text || '',
      samples: v.samples || '',
      durationSeconds: Number(v.durationSeconds) || 0,
      salesmanName: v.salesmanName || '',
      distanceToCustomer: v.distanceToCustomer !== undefined ? v.distanceToCustomer : null,
      photos: Array.isArray(v.photos) ? v.photos : [],
      // 2026-09-11 M2c：多段录音下发（audios 优先，audio 兼容旧数据）
      audios: Array.isArray(v.audios) && v.audios.length ? v.audios : (v.audio ? [v.audio] : []),
      audio: v.audio || null,
      transcribe: trOf(v)
    }))
  };
}

// 2026-09-11 M2c：后台手动触发某次拜访的语音转写 —— 转发到 transcribe 云函数，用管理员账号密码鉴权、真实执行（不走老板演示）
async function transcribeVisit(event) {
  const visitId = String(event.visitId || '').trim();
  if (!visitId) return { ok: false, code: 'BAD_ARG', msg: '缺少拜访 ID' };
  try {
    const r = await cloud.callFunction({
      name: 'transcribe',
      data: {
        action: 'start',
        visitId,
        segIndexes: Array.isArray(event.segIndexes) ? event.segIndexes : null,
        username: event.username,
        password: event.password
      }
    });
    return (r && r.result) || { ok: false, code: 'CALL_FAIL', msg: '转写服务无响应' };
  } catch (err) {
    return { ok: false, code: 'CALL_FAIL', msg: (err && err.message) || '转写调用失败' };
  }
}

// ⭐ 2026-10-03 老板要：「加新店」现场录的音**后台也能转文字**。
//   与 transcribeVisit（拜访录音）同一套路：转发到 transcribe 云函数并带管理员账号密码 ——
//   云函数间调用没有 OPENID，transcribe 会用账号密码校验并**自动补 real:true** 真执行（不走"老板演示的虚拟成功"）。
//   ⚠️ 走的是 transcribe 的 **fileIDs 分支**（那条路本来就不依赖 visitId，正是为这种场景留的），并把 customerId 带下去 ——
//      这样写出来的 transcripts 记录带着 customerId + audioFileID，下面按它取结果。
async function transcribeCustAudio(event) {
  const customerId = String(event.customerId || '').trim();
  const fileID = String(event.fileID || '').trim();
  if (!customerId || !fileID) return { ok: false, code: 'BAD_ARG', msg: '缺少客户或录音' };
  try {
    const r = await cloud.callFunction({
      name: 'transcribe',
      data: {
        action: 'start',
        fileIDs: [{ fileID, duration: Number(event.duration) || 0 }],
        customerId,
        username: event.username,
        password: event.password
      }
    });
    const res = (r && r.result) || { ok: false, code: 'CALL_FAIL', msg: '转写服务无响应' };
    const seg = (res && Array.isArray(res.segs) && res.segs[0]) || {};
    return Object.assign({}, res, { transcriptId: seg.transcriptId || '' });
  } catch (err) {
    return { ok: false, code: 'CALL_FAIL', msg: (err && err.message) || '转写调用失败' };
  }
}

// ⭐ 2026-10-03：取「加新店」录音的转写结果 —— **一出结果就回写客户档案**（`customers.audios[i].text`），
//   这样后台详情页与手机端客户详情页都能直接显示（两边读的都是客户档案，不用各自再查一次转写表）。
//   ⚠️ 为什么不用 transcribe.poll 拿明细：云函数间调用**没有 OPENID** → transcribe 的 `poll` 会直接走 `pollAll()`，
//      根本不看传进去的 transcriptIds。所以这里分两步：先 poll **当推进器**（让它去腾讯云把状态落库），再自己查 transcripts。
//   ⚠️ 幂等：文字没变就不写库（免得每次轮询都把 updatedAt 顶上去）。
async function pollCustAudioText(event) {
  const customerId = String(event.customerId || '').trim();
  const fileID = String(event.fileID || '').trim();
  if (!customerId || !fileID) return { ok: false, code: 'BAD_ARG', msg: '缺少客户或录音' };
  // ① 推进：transcribe.poll 无参 → 云端 pollAll()，把处理中的挨个结算（含刚提交这段）
  try { await cloud.callFunction({ name: 'transcribe', data: { action: 'poll' } }); } catch (err) { /* 推进失败不影响下面查库，下次轮询再试 */ }
  // ② 查这段录音对应的转写记录（同一 fileID 理论上只一条；多的话取最新）—— ⚠️ 不用 orderBy，免得要复合索引
  const tr = await db.collection('transcripts')
    .where({ customerId, audioFileID: fileID }).limit(10).get().catch(() => ({ data: [] }));
  const t = (tr.data || []).slice()
    .sort((a, b) => (Number(b.requestedAt) || 0) - (Number(a.requestedAt) || 0))[0] || null;
  if (!t) return { ok: true, status: 'none', text: '' };
  // ③ 出结果 → 回写客户档案上那条录音的 text
  if (t.status === 'done' && t.text) {
    const cDoc = await db.collection('customers').doc(customerId).get().catch(() => null);
    const c = cDoc && cDoc.data;
    const auds = (c && Array.isArray(c.audios)) ? c.audios.slice() : [];
    const i = auds.findIndex(a => a && a.fileID === fileID);
    if (i >= 0 && auds[i].text !== t.text) {
      auds[i] = Object.assign({}, auds[i], { text: t.text });
      await db.collection('customers').doc(customerId).update({ data: { audios: auds, updatedAt: Date.now() } });   // updatedAt：本地缓存增量同步用
    }
  }
  return { ok: true, status: t.status || '', text: t.text || '', errorMsg: t.errorMsg || '' };
}

// ⭐ 2026-10-03 老板定：「加新店」的录音**可以删** —— 老板原话「如果已经转成文字，则删除录音保留文字」。
//   所以删的时候分两种：
//     · **没有文字** → 整条从 `customers.audios` 里**移除**
//     · **有文字**   → **保留文字**：那条改成 `{ text, duration }`（去掉 fileID），播放器自然就渲染不出来了
//   ⚠️ 云存储上的音频文件**真删**（`cloud.deleteFile`）—— 不真删的话"删除"就没意义了。
//   ⚠️ 用 **index** 定位（不是 fileID）：删完 fileID 就没了，后续（改文字）还得按位置找，用 index 一致。
async function deleteCustAudio(event) {
  const customerId = String(event.customerId || '').trim();
  const idx = Number(event.index);
  if (!customerId || !(idx >= 0)) return { ok: false, code: 'BAD_ARG', msg: '缺少客户或序号' };
  const cDoc = await db.collection('customers').doc(customerId).get().catch(() => null);
  const c = cDoc && cDoc.data;
  if (!c) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const auds = Array.isArray(c.audios) ? c.audios.slice() : [];
  const a = auds[idx];
  if (!a) return { ok: false, code: 'BAD_ARG', msg: '这条录音不存在（可能已被删，刷新看看）' };
  const fileID = String(a.fileID || '');
  const keepText = String(a.text || '').trim();
  // ① 云存储文件真删（失败不阻断 —— 库里先摘掉，文件回头再清理）
  let fileDeleted = false;
  if (fileID) {
    try { await cloud.deleteFile({ fileList: [fileID] }); fileDeleted = true; } catch (e) { /* 见 fileDeleted */ }
  }
  // ② 库里：有文字 → 只留文字；没有文字 → 整条移除
  if (keepText) auds[idx] = { text: keepText, duration: Number(a.duration) || 0, audioDeletedAt: Date.now() };
  else auds.splice(idx, 1);
  await db.collection('customers').doc(customerId).update({ data: { audios: auds, updatedAt: Date.now() } });
  return { ok: true, keptText: !!keepText, fileDeleted: fileDeleted, audios: auds.length };
}

// ⭐ 2026-10-03 老板定：转写出来的文字**要能改**（有的识别错了）——
//   老板原话「应该增加一个编辑按钮，因为有的文字转写错误，需要修改」。
//   ⚠️ 同样按 **index** 定位（不是 fileID）：录音文件可能已被删、只留文字，那时 fileID 已经没了。
//   ⚠️ text 传空 = 清空那段文字（允许）。
async function saveCustAudioText(event) {
  const customerId = String(event.customerId || '').trim();
  const idx = Number(event.index);
  if (!customerId || !(idx >= 0)) return { ok: false, code: 'BAD_ARG', msg: '缺少客户或序号' };
  const text = String(event.text == null ? '' : event.text).slice(0, 20000);
  const cDoc = await db.collection('customers').doc(customerId).get().catch(() => null);
  const c = cDoc && cDoc.data;
  if (!c) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const auds = Array.isArray(c.audios) ? c.audios.slice() : [];
  if (!auds[idx]) return { ok: false, code: 'BAD_ARG', msg: '这条录音不存在（刷新看看）' };
  auds[idx] = Object.assign({}, auds[idx], { text: text, textEditedAt: Date.now() });
  await db.collection('customers').doc(customerId).update({ data: { audios: auds, updatedAt: Date.now() } });
  return { ok: true, text: text };
}

// 2026-09-11 M2c：本月转写用量（后台用量条）
async function transcribeUsage() {
  const cfgR = await db.collection('settings').where({ key: 'asrConfig' }).get();
  const cfg = (cfgR.data[0] && cfgR.data[0].value) || {};
  const cn = new Date(Date.now() + 8 * 3600 * 1000);
  const startTs = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), 1) - 8 * 3600 * 1000;
  const doneR = await db.collection('transcripts')
    .where({ status: 'done', doneAt: _.gte(startTs) }).field({ duration: true }).limit(1000).get();
  const sec = (doneR.data || []).reduce((s, x) => s + (Number(x.duration) || 0), 0);
  const allR = await db.collection('transcripts').field({ status: true }).limit(1000).get();
  const counts = {};
  (allR.data || []).forEach(x => { const k = x.status || 'pending'; counts[k] = (counts[k] || 0) + 1; });
  return {
    ok: true,
    enabled: cfg.enabled !== false,
    usedMin: Math.round(sec / 60),
    quotaMin: Number(cfg.monthlyQuotaMin || 600),
    counts
  };
}

// 客户备注（2026-09-24 老板定：**逐条保留历史**，不再覆盖）
// · 每次保存 = 往 customer_remarks 插一条历史（内容 + 时间 + 操作人）
// · customers.remark 始终同步为**最新一条** —— 业务员手机端只看这条，所以手机端不用改
async function updateCustomerRemark(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const remark = String(event.remark || '').trim().slice(0, 500);
  const c = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!c || !c.data) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const by = String(event.username || '').trim().slice(0, 30); // 操作人 = 当前登录的后台账号
  if (remark) {
    await db.collection('customer_remarks').add({ data: { customerId, text: remark, at: Date.now(), by } });
  }
  await db.collection('customers').doc(customerId).update({ data: { remark, updatedAt: Date.now() } });   // 2026-09-27 补：增量同步用
  return { ok: true, remark, msg: remark ? '已保存（后台逐条留存历史）· 业务员手机端可见最新一条 ✓' : '已清空最新备注（历史仍保留在后台）' };
}

// 某客户的历史备注（后台备注弹窗展示；新 → 旧）
async function listCustomerRemarks(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const rows = await fetchAll('customer_remarks', { customerId }, {});
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { ok: true, remarks: rows.map(r => ({ _id: r._id, text: r.text || '', at: r.at || 0, by: r.by || '' })) };
}

// 清空未分批客户（2026-09-08 老板定：彻底清除未分批档案+其拜访/报错记录+云存储照片录音文件）
async function purgeUnbatchedCustomers(event) {
  const all = await fetchAll('customers', {}, { _id: true, batchIds: true });
  const ids = all.filter(c => !(c.batchIds || []).length).map(c => c._id);
  if (!ids.length) return { ok: true, customers: 0, visits: 0, fixes: 0, files: 0, msg: '没有未分批客户，无需清除' };
  // 1) 收集关联云存储文件（照片/录音）
  const fileIDs = new Set();
  const visitRows = await fetchAll('visits', { customerId: _.in(ids) }, { photos: true, audio: true });
  visitRows.forEach(v => {
    (v.photos || []).forEach(p => { if (p && p.fileID) fileIDs.add(p.fileID); if (p && p.thumbID) fileIDs.add(p.thumbID); });
    if (v.audio && v.audio.fileID) fileIDs.add(v.audio.fileID);
  });
  const fixRows = await fetchAll('coord_fix_requests', { customerId: _.in(ids) }, { photos: true });
  fixRows.forEach(f => {
    (f.photos || []).forEach(p => { if (p && p.fileID) fileIDs.add(p.fileID); if (p && p.thumbID) fileIDs.add(p.thumbID); });
  });
  // 2) 删除数据库文档（分批 50）
  const delAll = async (coll, rows) => {
    for (let i = 0; i < rows.length; i += 50) {
      await Promise.all(rows.slice(i, i + 50).map(d => db.collection(coll).doc(d._id).remove()));
    }
  };
  await delAll('customers', ids.map(_id => ({ _id })));
  await delAll('visits', visitRows);
  await delAll('coord_fix_requests', fixRows);
  // 3) 云存储文件删除
  const fidList = [...fileIDs].filter(Boolean);
  let files = 0;
  for (let i = 0; i < fidList.length; i += 50) {
    try {
      const r = await cloud.deleteFile({ fileList: fidList.slice(i, i + 50) });
      (r.fileList || []).forEach(f => { if (f.status === 0) files++; });
    } catch (e) { /* 该批失败继续 */ }
  }
  return { ok: true, customers: ids.length, visits: visitRows.length, fixes: fixRows.length, files, msg: `已清除未分批客户 ${ids.length} 家（拜访记录 ${visitRows.length} 条、报错 ${fixRows.length} 条、文件 ${files} 个）` };
}

// fileID 批量换临时 https 链接（后台展示现场照片/播放录音用；分批 ≤50，防 HTTP 超时）
// ⭐ 2026-10-05 老板定：**分享封面**（图放云存储、不占主包；后台可排序/删除）
//   存在 settings.shareImages = [{ fileID, name, at }]，顺序即显示顺序。
//   ⚠️ 手机端读不到 adminapi（后台入口、要账号密码）→ 业务员那份由 tasks 的 shareImages 出。
async function listShareImages() {
  const r = await db.collection('settings').where({ key: 'shareImages' }).limit(1).get().catch(() => ({ data: [] }));
  const v = (r.data && r.data[0] && r.data[0].value) || [];
  return { ok: true, list: Array.isArray(v) ? v : [] };
}
// 保存分享封面列表（整体覆盖：排序 / 删除 / 新增都靠它）
async function saveShareImages(event) {
  const raw = Array.isArray(event && event.list) ? event.list : null;
  if (!raw) return { ok: false, code: 'BAD_ARG', msg: '缺少 list' };
  const list = raw.slice(0, 30).map(x => ({
    fileID: String((x && x.fileID) || '').slice(0, 300),
    name: String((x && x.name) || '').slice(0, 40),
    at: Number((x && x.at) || Date.now())
  })).filter(x => x.fileID);
  const old = await db.collection('settings').where({ key: 'shareImages' }).limit(1).get().catch(() => ({ data: [] }));
  if (old.data && old.data[0]) {
    await db.collection('settings').doc(old.data[0]._id).update({ data: { value: list } });
  } else {
    await db.collection('settings').add({ data: { key: 'shareImages', value: list } });
  }
  return { ok: true, count: list.length, list: list };
}
async function getTempFileURL(event) {
  const list = Array.isArray(event.fileIDs) ? event.fileIDs.filter(f => typeof f === 'string' && f) : [];
  if (!list.length) return { ok: true, urls: {} };
  const urls = {};
  for (let i = 0; i < list.length; i += 50) {
    const r = await cloud.getTempFileURL({ fileList: list.slice(i, i + 50) });
    (r.fileList || []).forEach(f => { if (f.status === 0 && f.tempFileURL) urls[f.fileID] = f.tempFileURL; });
  }
  return { ok: true, urls };
}

// 毫秒时间戳 → 东八区 24 小时制 HH:mm
function fmtHM(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function listSalesmen(event) {
  // 返回全部业务员（含停用，便于人员管理页启停）；新建任务下拉由前端过滤 active
  // ⭐ 2026-09-30：**老板兼业务员**（users.alsoSalesman，朱小利）也要出现在这里 —— 否则后台派单**选不到他**；
  //   他按真业务员算（接单 / 拜访 / 进统计），与真业务员完全一致。
  const res = await db.collection('users')
    .where(_.or([{ role: 'salesman' }, { alsoSalesman: true }]))
    .orderBy('createdAt', 'asc').get();
  // 进行中/审核中的业务员（有任务不可再被选；done 后可重新派发）
  const tRes = await db.collection('tasks').where({ status: _.in(['published', 'reviewing']) }).field({ salesmanId: true }).limit(100).get();
  const busy = {};
  tRes.data.forEach(t => { busy[t.salesmanId] = true; });
  // 2026-09-24 推荐人：每个人"拉了几个人"（users 里 referrerId 指向他的已入职人数）
  const refCountMap = {};
  try {
    const refRows = await db.collection('users').field({ referrerId: true }).limit(1000).get();
    refRows.data.forEach(u => { if (u.referrerId) refCountMap[u.referrerId] = (refCountMap[u.referrerId] || 0) + 1; });
  } catch (e) { /* 统计失败不影响人员列表 */ }
  // 2026-09-09 老板定：人员列表显示当前状态——latest 位置（在线/离线/拜访中）+ 今日拜访数
  const locRows = await fetchAll('salesman_locations', { type: 'latest' }, { salesmanId: true, t: true, visitOngoing: true });
  const locMap = {};
  locRows.forEach(r => { if (r.salesmanId) locMap[r.salesmanId] = { t: r.t || 0, visitOngoing: !!r.visitOngoing }; });
  const today = todayStr();
  const vRows = await fetchAll('visits', { visitedAt: today }, { salesmanId: true });
  const todayMap = {};
  vRows.forEach(v => { todayMap[v.salesmanId] = (todayMap[v.salesmanId] || 0) + 1; });
  return {
    ok: true,
    salesmen: res.data.map(s => ({
      _id: s._id, name: s.name, phone: s.phone,
      star: Number(s.star || 0.5), // 2026-09-24 星级（0.5~5 共 10 档，新人默认半星；存量/未设过的一律按半星兜底）
      hasTask: !!busy[s._id], active: s.active !== false,
      bound: !!s.openid,
      trial: !!s.trial,
      mpBound: !!(s.mpOpenid),
      mpOpenidMask: s.mpOpenid ? String(s.mpOpenid).slice(0, 8) + '…' + String(s.mpOpenid).slice(-6) : '',
      lastLoginAt: s.lastLoginAt || 0,
      loc: locMap[s._id] || null,
      todayCount: todayMap[s._id] || 0,
      // 2026-09-24 推荐人（谁分享的链接把他拉来的 / 后台手工补录的）
      referrerId: s.referrerId || '',
      referrerName: s.referrerName || '',
      referrerSource: s.referrerSource || '', // 'link' | 'manual'
      refCount: refCountMap[s._id] || 0,       // 他拉了几个人（已入职）
      // 2026-09-24 个人资料（业务员自填；列表只带这几个轻字段，详细统计走 getUserDetail）
      profile: {
        gender: s.gender || '', age: s.age || 0, hometown: s.hometown || '', address: s.address || ''
      }
    }))
  };
}

async function listAdmins(event) {
  const res = await db.collection('users').where({ role: _.in(['super_admin', 'admin']) }).get();
  return {
    ok: true,
    admins: res.data.map(a => ({
      _id: a._id, name: a.name, username: a.username, role: a.role,
      active: a.active !== false, boss: a.boss === true,
      // ⭐ 2026-10-01 补：老板「兼业务员」标记 —— **不带它，后台那一列永远显示"未开启"**（点了按钮也看不出变化）
      alsoSalesman: a.alsoSalesman === true,
      phone: a.phone || '', lastLoginAt: a.lastLoginAt || 0,
      // 2026-09-10 老板定：新人注册通知走服务号 → 管理员也支持服务号绑定（人员管理显示绑定状态）
      mpOpenidMask: a.mpOpenid ? String(a.mpOpenid).slice(0, 8) + '…' + String(a.mpOpenid).slice(-6) : ''
    }))
  };
}

// 老板白名单开关（2026-09-09 老板定：仅指定账号启用老板页面/战况地图）
async function setUserBoss(event) {
  const { userId, boss } = event || {};
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  if (!['super_admin', 'admin'].includes(u.role)) return { ok: false, code: 'FORBIDDEN', msg: '仅管理员账号可设为老板' };
  // 2026-09-09 老板定：老板手机号账号永远启用老板模式，不可停用
  if (u.phone === BOSS_PHONE && !boss) return { ok: false, code: 'FORBIDDEN', msg: '老板账号不可停用老板模式' };
  await db.collection('users').doc(userId).update({ data: { boss: !!boss } });
  return { ok: true, msg: boss ? '已启用老板模式' : '已停用老板模式' };
}

// ⭐ 2026-09-30 老板（朱小利）定：**老板兼业务员** —— 他也要「三身份入口」（业务员 / 老板 / 游客），
//   而且要能像真业务员一样**被派单、跑任务、提拜访**（老板定：**按真业务员算** —— 进统计、进战况地图）。
//   开启后：① 后台「选业务员」下拉会出现他（listSalesmen / createTask / reassignTask 均已放行）
//           ② 手机端登录后显示「三身份选择页」（login 下发 alsoSalesman）
//           ③ 选「以业务员身份进入」时前端带 asSalesman 声明 → 云端按业务员认人（isBoss=false）
//   ⚠️ 只对管理员账号有意义（真业务员本来就是业务员，不需要这个标记）。
//   入参：{ userId, on }   出参：{ ok, msg }
async function setUserAlsoSalesman(event) {
  const { userId, on } = event || {};
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  if (!['super_admin', 'admin'].includes(u.role)) return { ok: false, code: 'FORBIDDEN', msg: '仅管理员账号可设为「老板兼业务员」' };
  await db.collection('users').doc(userId).update({ data: { alsoSalesman: !!on } });
  return { ok: true, msg: on ? '已开启「老板兼业务员」：他可用业务员身份接单跑任务' : '已关闭「老板兼业务员」' };
}

// ===== 注册审核（2026-09-09 老板拍板：登录改「注册→后台审核→通过后免登进入」） =====
// 待审核申请 + 最近 20 条已处理（通过/拒绝）留痕
async function listRegistrations(event) {
  const pend = await db.collection('registrations').where({ status: 'pending' }).orderBy('createdAt', 'desc').limit(100).get();
  const done = await db.collection('registrations').where({ status: _.in(['approved', 'rejected']) }).orderBy('reviewedAt', 'desc').limit(20).get();
  const fmt = r => ({
    _id: r._id, name: r.name || '', phone: r.phone || '', status: r.status,
    reason: r.reason || '', createdAt: r.createdAt || 0, reviewedAt: r.reviewedAt || 0,
    phoneVerified: !!r.phoneVerified, // 2026-09-09 老板定：微信一键验证标记，后台审核可见
    openidMask: r.openid ? String(r.openid).slice(0, 8) + '…' + String(r.openid).slice(-4) : '',
    refFrom: r.refFrom || '', refFromName: r.refFromName || '' // 2026-09-24 推荐人（分享链接带进来的）
  });
  return { ok: true, pending: pend.data.map(fmt), done: done.data.map(fmt) };
}

// 审核动作：approve=手机号匹配已有业务员则绑 openid、不匹配则新建业务员；reject=状态置拒绝（可填原因）
async function reviewRegistration(event) {
  // 2026-09-10 修复：业务动作改读 event.act（原先读 event.action 与分发字段同名，
  // 前端 {...extra} 展开覆盖后云端收到的 action 变成 'reject'/'approve' → 报"未知操作"）
  const { regId, act, reason } = event || {};
  if (!regId || !['approve', 'reject'].includes(act)) return { ok: false, code: 'BAD_ARG', msg: '参数错误' };
  const rRef = db.collection('registrations').doc(regId);
  const rr = await rRef.get().catch(() => null);
  const r = rr && rr.data;
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '申请不存在' };
  if (r.status !== 'pending') return { ok: false, code: 'STATE', msg: '该申请已处理' };
  // ⭐ 2026-09-28 晚：**记下审核人** —— 滚动消息里要显示"日期时间 + 操作员姓名"
  const _by = (event && event._admin && event._admin.name) || '管理员';
  if (act === 'reject') {
    await rRef.update({ data: { status: 'rejected', reason: String(reason || '').slice(0, 100), reviewedAt: Date.now(), reviewedBy: _by } });
    return { ok: true, msg: '已拒绝该申请' };
  }
  // approve：匹配已有业务员（同手机号）→ 绑定；否则新建
  const phone = String(r.phone || '');
  const uRes = await db.collection('users').where({ phone, role: 'salesman' }).get();
  let boundId = '';
  if (uRes.data.length) {
    const u = uRes.data[0];
    if (u.openid && u.openid !== r.openid) return { ok: false, code: 'BOUND_OTHER', msg: '该手机号的业务员已绑定其他微信，请先核对' };
    // 2026-09-09 模拟核验修复：审核通过=老板认可该身份 → 同时恢复 active（否则曾被停用的业务员
    // 即使绑上 openid，login 的 active:true 查询仍不命中，永远进不了小程序）
    await db.collection('users').doc(u._id).update({ data: { openid: r.openid, lastLoginAt: Date.now(), active: true } });
    boundId = u._id;
  } else {
    const add = await db.collection('users').add({
      data: {
        openid: r.openid, name: String(r.name || '').trim(), phone,
        role: 'salesman', active: true, trial: false,
        remark: '注册申请审核通过', createdAt: Date.now()
      }
    });
    boundId = add._id;
  }
  // 推荐人（2026-09-24）：谁分享的链接把他拉来的 → 落进 users
  // 兜底：本次申请没带 refFrom（被拒后重提会**新建**一条申请，带 refFrom 的是旧那条）→ 回查同 openid 的历史申请
  let refFrom = String(r.refFrom || '');
  let refFromName = String(r.refFromName || '');
  if (!refFrom) {
    try {
      const hist = await db.collection('registrations')
        .where({ openid: r.openid, refFrom: _.neq('') })
        .orderBy('createdAt', 'desc').limit(1).get();
      if (hist.data.length) {
        refFrom = String(hist.data[0].refFrom || '');
        refFromName = String(hist.data[0].refFromName || '');
      }
    } catch (e) { /* 兜底失败就不记推荐人 */ }
  }
  if (refFrom) {
    try {
      await db.collection('users').doc(boundId).update({
        data: { referrerId: refFrom, referrerName: refFromName, referrerSource: 'link', referrerAt: Date.now() }
      });
    } catch (e) { /* 推荐人写入失败不阻断审核通过 */ }
  }
  // ⭐ 2026-09-28 晚：**通过时也记审核人**（滚动消息里要显示"审核人"）
  await rRef.update({ data: { status: 'approved', reviewedAt: Date.now(), userId: boundId, reviewedBy: _by } });
  return { ok: true, msg: '已通过并绑定微信（免登录进入）' };
}

// ===== 人员管理（新增/启停/删除） =====
async function addSalesman(event) {
  const { name, phone, remark, trial } = event;
  if (!name || !String(name).trim()) return { ok: false, code: 'BAD_ARG', msg: '请填写姓名' };
  if (!phone || !String(phone).trim()) return { ok: false, code: 'BAD_ARG', msg: '请填写手机号' };
  const p = String(phone).trim();
  const exist = await db.collection('users').where({ phone: p, role: 'salesman' }).count();
  if (exist.total > 0) return { ok: false, code: 'DUP', msg: '该手机号的业务员已存在' };
  const add = await db.collection('users').add({
    data: {
      openid: '',
      name: String(name).trim(),
      phone: p,
      role: 'salesman',
      active: true,
      trial: !!trial, // 游客体验（2026-09-08 老板定：小程序审核/演示用，任意微信可绑定）
      remark: String(remark || '').trim(),
      createdAt: Date.now()
    }
  });
  return { ok: true, userId: add._id, msg: '业务员已添加，首次登录小程序时选择姓名绑定微信' };
}

async function addAdmin(event) {
  const { name, username, password } = event;
  if (!name || !String(name).trim()) return { ok: false, code: 'BAD_ARG', msg: '请填写姓名' };
  if (!username || !String(username).trim()) return { ok: false, code: 'BAD_ARG', msg: '请填写登录账号' };
  if (!password || String(password).length < 6) return { ok: false, code: 'BAD_ARG', msg: '密码至少 6 位' };
  const uname = String(username).trim();
  const exist = await db.collection('users').where({ username: uname }).count();
  if (exist.total > 0) return { ok: false, code: 'DUP', msg: '该登录账号已存在' };
  const add = await db.collection('users').add({
    data: {
      username: uname,
      passwordHash: sha256(String(password)),
      name: String(name).trim(),
      phone: '',
      role: 'admin',
      active: true,
      createdAt: Date.now()
    }
  });
  return { ok: true, userId: add._id, msg: '管理员已添加' };
}

// 2026-09-10 老板定：人员管理「解绑」——清掉该账号的小程序 openid 绑定
// （手机端配合启动云端复核，被解绑者下次打开小程序即被踢回注册页）
async function unbindUser(event) {
  const { userId } = event;
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  // 老板账号保护（与 setUserActive/deleteUser 口径一致）
  if (u.phone === BOSS_PHONE) return { ok: false, code: 'FORBIDDEN', msg: '老板账号不可解绑' };
  if (!u.openid) return { ok: true, msg: '该账号本来就没有绑定微信' };
  await db.collection('users').doc(userId).update({ data: { openid: '' } });
  return { ok: true, msg: '已解绑：该微信下次打开小程序将回到注册页' };
}

async function setUserActive(event) {
  const { userId, active } = event;
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  if (u.role === 'super_admin') return { ok: false, code: 'FORBIDDEN', msg: '超级管理员不可停用' };
  // 2026-09-09 老板定：老板手机号账号不可停用
  if (u.phone === BOSS_PHONE && !active) return { ok: false, code: 'FORBIDDEN', msg: '老板账号不可停用' };
  await db.collection('users').doc(userId).update({ data: { active: !!active } });
  return { ok: true, active: !!active };
}

// ===== 业务员星级（2026-09-24 老板定：管理员在人员管理里设定；手机端首页显示在姓名右边）=====
// 档位：**0.5 ~ 5，步长 0.5，共 10 档**（新人进来默认半星，**没有"未评"**）
// 显示：★ = 1 星，☆ = 半星（2 星半 → ★★☆）；见小程序 pages/home/home.js 的 _starText
async function setUserStar(event) {
  const { userId, star } = event || {};
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const n = Number(star);
  if (!isFinite(n) || n < 0.5 || n > 5 || Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) {
    return { ok: false, code: 'BAD_ARG', msg: '星级只能是 0.5 ~ 5 之间的半星档位' };
  }
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  const v = Math.round(n * 2) / 2; // 归一化，避免浮点尾巴
  await db.collection('users').doc(userId).update({ data: { star: v } });
  return { ok: true, star: v, msg: '星级已设为 ' + v + ' 星' };
}

// ===== 个人详情（2026-09-24 老板定：人员管理加「个人详情」列，点开看这个人的完整档案）=====
// 返回三组：① 个人资料（业务员自己在「我的→个人资料」填）② 入职与推荐 ③ 工作数据（实时算、不预存）
async function getUserDetail(event) {
  const userId = String((event && event.userId) || '');
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };

  // 推荐人姓名（兜底：姓名快照没存时回查；对方可能已被删）
  let referrerName = u.referrerName || '';
  if (!referrerName && u.referrerId) {
    const rr = await db.collection('users').doc(u.referrerId).get().catch(() => null);
    referrerName = (rr && rr.data && rr.data.name) || '（已删除）';
  }
  // 他推荐了几人
  let refCount = 0;
  try {
    const rc = await db.collection('users').where({ referrerId: userId }).count();
    refCount = rc.total || 0;
  } catch (e) { /* 忽略 */ }

  // 工作数据：拜访（去重客户 / 总次数 / 本月）+ 入商城战果 + 任务完成率
  let visitRows = [];
  try {
    visitRows = await fetchAll('visits', { salesmanId: userId }, { customerId: true, result: true, visitedAt: true });
  } catch (e) { /* 忽略 */ }
  const MALL_RESULTS = ['加入商城', '已签约商城'];
  const month = todayStr().slice(0, 7); // YYYY-MM
  const custSet = {}; const mallSet = {}; let monthVisits = 0;
  visitRows.forEach(v => {
    if (v.customerId) custSet[v.customerId] = true;
    if (String(v.visitedAt || '').slice(0, 7) === month) monthVisits++;
    if (v.customerId && MALL_RESULTS.includes(v.result)) mallSet[v.customerId] = true;
  });
  let tDone = 0, tAll = 0;
  try {
    const tr = await db.collection('tasks').where({ salesmanId: userId }).field({ status: true }).limit(1000).get();
    tr.data.forEach(t => { if (t.status === 'draft') return; tAll++; if (t.status === 'done') tDone++; });
  } catch (e) { /* 忽略 */ }

  return {
    ok: true,
    user: {
      _id: u._id, name: u.name || '', phone: u.phone || '', role: u.role || '',
      active: u.active !== false, trial: !!u.trial, star: Number(u.star || 0.5),
      // ① 个人资料（业务员自填）
      gender: u.gender || '', age: u.age || 0, hometown: u.hometown || '', address: u.address || '',
      wechat: u.wechat || '', emergencyName: u.emergencyName || '', emergencyPhone: u.emergencyPhone || '',
      // ② 入职与推荐
      createdAt: u.createdAt || 0,
      referrerId: u.referrerId || '', referrerName, referrerSource: u.referrerSource || '', refCount,
      // ③ 工作数据
      visitCustomers: Object.keys(custSet).length,
      visitTimes: visitRows.length,
      monthVisits,
      mallCustomers: Object.keys(mallSet).length,
      taskDone: tDone, taskTotal: tAll, taskRate: tAll ? Math.round(tDone * 100 / tAll) : 0,
      // 账号
      bound: !!u.openid, mpBound: !!u.mpOpenid, lastLoginAt: u.lastLoginAt || 0
    }
  };
}

// ===== 推荐人（2026-09-24 老板定：谁分享的链接 / 谁拉的，就记谁为推荐人）=====
// ① 手工补录/修改：存量的人当年没有分享链路，只能由管理员在人员管理里指定（来源标记 'manual'）
// ② 校验：不能选自己；不能形成互相推荐（沿"候选人的推荐人链"往上走，链上出现本用户就拒绝）
async function setUserReferrer(event) {
  const { userId, referrerId } = event || {};
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  const rid = String(referrerId || '').trim();
  if (!rid) {
    await db.collection('users').doc(userId).update({ data: { referrerId: '', referrerName: '', referrerSource: '', referrerAt: 0 } });
    return { ok: true, msg: '已清除推荐人' };
  }
  if (rid === userId) return { ok: false, code: 'BAD_ARG', msg: '不能把自己设为推荐人' };
  const rRes = await db.collection('users').doc(rid).get().catch(() => null);
  const r = rRes && rRes.data;
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '推荐人不存在（只能是系统里的人）' };
  let cur = r, depth = 0;
  while (cur && cur.referrerId && depth < 20) {
    if (cur.referrerId === userId) return { ok: false, code: 'LOOP', msg: '会形成互相推荐（A→B→A），请换一个' };
    const nx = await db.collection('users').doc(cur.referrerId).get().catch(() => null);
    cur = nx && nx.data;
    depth++;
  }
  await db.collection('users').doc(userId).update({
    data: { referrerId: rid, referrerName: String(r.name || ''), referrerSource: 'manual', referrerAt: Date.now() }
  });
  return { ok: true, msg: '推荐人已设为 ' + (r.name || '（未填姓名）') };
}

// 推荐排行（2026-09-24 老板定：不光记谁拉的，还要看"谁拉来的人最能干"）
// 口径（已与老板对齐）：
//   拉人数 hired   = users 里 referrerId=我 的**已入职**人数
//   待审核 pending = registrations 里 refFrom=我 且仍在 pending 的条数
//   拜访数 visits  = 我这些下级的 visits 条数
//   完成率         = 下级的 tasks 里 status='done' ÷ 非草稿任务数（任务终态只有 done）
//   入商城数       = 下级拜访结果选了「加入商城 / 已签约商城」的**去重客户数**
// ⚠️ 刻意**不用**"客户档案的签约业务员" —— 那是客户表「业务负责人」原值（如 快餐盒c聚火配送🔥），
//    与 users 姓名根本对不上；混进来会让"推荐贡献"和"客户归属"两个口径打架
async function referrerStats(event) {
  const uAll = await db.collection('users').field({ name: true, referrerId: true }).limit(1000).get();
  const byId = {}; const kids = {};
  uAll.data.forEach(u => {
    byId[u._id] = u;
    if (u.referrerId) (kids[u.referrerId] = kids[u.referrerId] || []).push(u._id);
  });
  // 待审核（链接拉来、还没入职）
  const pendBy = {};
  try {
    const pr = await db.collection('registrations').where({ status: 'pending' }).field({ refFrom: true }).limit(200).get();
    pr.data.forEach(r => { if (r.refFrom) pendBy[r.refFrom] = (pendBy[r.refFrom] || 0) + 1; });
  } catch (e) { /* 忽略 */ }
  const allKids = [];
  Object.keys(kids).forEach(k => { allKids.push(...kids[k]); });
  // 只拉"被推荐的人"的拜访与任务（避免全表扫；分批 _.in，每批 50）
  const visits = [], taskRows = [];
  for (let i = 0; i < allKids.length; i += 50) {
    const part = allKids.slice(i, i + 50);
    const vr = await fetchAll('visits', { salesmanId: _.in(part) }, { salesmanId: true, customerId: true, result: true });
    visits.push(...vr);
    try {
      const tr = await db.collection('tasks').where({ salesmanId: _.in(part) })
        .field({ salesmanId: true, status: true }).limit(1000).get();
      taskRows.push(...tr.data);
    } catch (e) { /* 任务统计失败不影响其它指标 */ }
  }
  const MALL_RESULTS = ['加入商城', '已签约商城'];
  const rows = Object.keys(kids).map(rid => {
    const kidSet = {}; kids[rid].forEach(id => { kidSet[id] = true; });
    let visitCount = 0; const mallCust = {};
    visits.forEach(v => {
      if (!kidSet[v.salesmanId]) return;
      visitCount++;
      if (v.customerId && MALL_RESULTS.includes(v.result)) mallCust[v.customerId] = true;
    });
    let tDone = 0, tAll = 0;
    taskRows.forEach(t => {
      if (!kidSet[t.salesmanId] || t.status === 'draft') return;
      tAll++;
      if (t.status === 'done') tDone++;
    });
    const ref = byId[rid];
    return {
      referrerId: rid,
      referrerName: (ref && ref.name) ? ref.name : '（推荐人已删除）',
      hired: kids[rid].length,
      pending: pendBy[rid] || 0,
      visits: visitCount,
      taskDone: tDone,
      taskTotal: tAll,
      taskRate: tAll ? Math.round(tDone * 100 / tAll) : 0,
      mallCustomers: Object.keys(mallCust).length
    };
  }).sort((a, b) => (b.hired - a.hired) || (b.mallCustomers - a.mallCustomers) || (b.visits - a.visits));
  return { ok: true, rows };
}

async function deleteUser(event) {
  const { userId } = event;
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  if (!u) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  if (u.role === 'super_admin') return { ok: false, code: 'FORBIDDEN', msg: '超级管理员不可删除' };
  // 2026-09-09 老板定：老板手机号账号不可删除
  if (u.phone === BOSS_PHONE) return { ok: false, code: 'FORBIDDEN', msg: '老板账号不可删除' };
  if (u.role === 'salesman') {
    const t = await db.collection('tasks').where({ salesmanId: userId, status: 'published' }).count();
    if (t.total > 0) return { ok: false, code: 'HAS_TASK', msg: '该业务员有进行中任务，请先处理任务再删除' };
  }
  await db.collection('users').doc(userId).remove();
  return { ok: true };
}

// 最近一次商城列表导入时间（展示在导入按钮旁）
async function getLastMallImport(event) {
  const res = await db.collection('import_batches').where({ type: 'mall' }).orderBy('createdAt', 'desc').limit(1).get();
  const last = res.data[0] || null;
  return { ok: true, last: last ? { createdAt: last.createdAt, fileName: last.fileName || '' } : null };
}

// ===== 系统设置 =====
async function getSettings(event) {
  const res = await db.collection('settings').get();
  const map = {};
  res.data.forEach(s => { map[s.key] = s.value; });
  // 服务号配置：不回传明文 AppSecret（防泄漏；保存时留空=保留旧值）
  if (map.mpConfig) {
    map.mpConfig = {
      appid: map.mpConfig.appid || '',
      appsecretSet: !!(map.mpConfig.appsecret),
      templateId: map.mpConfig.templateId || '',
      enabled: !!map.mpConfig.enabled
    };
  }
  // 服务号 access_token：只回传有效性状态，不回传 token 本身
  if (map.mpAccessToken) {
    const t = map.mpAccessToken || {};
    map.mpAccessToken = { valid: !!(t.token && Number(t.expiresAt) > Date.now()) };
  }
  // 腾讯地图 Key：前端渲染地图必需，明文返回；未配置回默认
  if (!map.mpKey) map.mpKey = 'SQWBZ-K326U-MU3VH-GWUHA-HGNES-S7F2D';
  // ===== 2026-09-11 降频与开关类设置：未设置时回默认值（前端不必各自兜底）=====
  // 默认值口径：维持线上现有行为；locWorkTier 默认 30S/120S、photoLimit 默认 9（老板 2026-09-11 拍板）
  const DEF_SETTINGS = {
    locTrackEnabled: true, locLatestEnabled: true,
    locWorkTier: '30_120', locPackUpload: true, locPackSec: 60, locMoveThreshold: 20,
    adminAutoRefresh: true, adminHiddenPause: true,
    tickIntervalMin: 30, asrPollMin: 15, reviewWatchEnabled: true,
    recEnabled: true, photoLimit: 9, evidenceRequired: false,
    platformPhotoShow: true, coordFixEnabled: true, salesmanScope: 'task', usageAlertPct: 60,
    usageQuota: 1000000, // 2026-09-11 批 3：云调用月度额度参考值（100 万次/月）
    mpAlertTemplateId: '', // 2026-09-12：用量告警模板 ID（留空则回落到任务通知模板）
    adminNotifyPhones: '' // 2026-09-12：管理员信息收件人手机号（逗号分隔；留空=不发此类系统通知）
  };
  Object.keys(DEF_SETTINGS).forEach(k => { if (map[k] === undefined || map[k] === null) map[k] = DEF_SETTINGS[k]; });
  // ===== 2026-09-12 老板定：模板 ID 不在界面明文显示（避免被看到/误改误伤）=====
  // 口径与 AppSecret 一致：只回掩码 + 是否已配置；改的时候整段粘贴覆盖，留空＝不修改
  if (map.mpAlertTemplateId) {
    map.mpAlertTemplateIdSet = true;
    map.mpAlertTemplateIdMask = maskSecret(map.mpAlertTemplateId);
  } else {
    map.mpAlertTemplateIdSet = false;
    map.mpAlertTemplateIdMask = '';
  }
  delete map.mpAlertTemplateId; // 绝不回明文
  return { ok: true, settings: map };
}

// 敏感串掩码：形如 --DI4LbB…Nuz24A（保留头 8 尾 6，够核对又拿不全）
function maskSecret(s) {
  const t = String(s || '');
  if (t.length <= 16) return '****';
  return t.slice(0, 8) + '…' + t.slice(-6);
}

async function setSetting(event) {
  const { key } = event;
  // 2026-09-11 修复：下面要改写 value（取值规范化），原写法 `const { key, value } = event`
  // 解构出的是常量，一赋值就抛 "Assignment to constant variable"（老板点开关时踩到）→ 改为 let
  let value = event.value;
  if (!key) return { ok: false, code: 'BAD_ARG', msg: '缺少设置项 key' };
  // 仅允许写入已知设置项（防任意写入）
  const ALLOWED = ['locationCheck', 'locRefreshInterval', 'locKeyRefreshInterval', 'recordingDurationLimit', 'visitDurationLimit', 'expireArchiveDays', 'globalRefreshInterval', 'compareWindowDays', 'dailyVisitLimit', 'phoneVisibility', 'autoApproveFinish', 'mpConfig', 'taskRegionCode', 'mpKey', 'workStartHour', 'workEndHour', 'offDutyTier', 'trackKeepDays', 'welcomeConfig', 'locTrackEnabled', 'locLatestEnabled', 'locWorkTier', 'locPackUpload', 'locPackSec', 'locMoveThreshold', 'adminAutoRefresh', 'adminHiddenPause', 'tickIntervalMin', 'asrPollMin', 'reviewWatchEnabled', 'recEnabled', 'photoLimit', 'evidenceRequired', 'platformPhotoShow', 'coordFixEnabled', 'salesmanScope', 'usageAlertPct', 'usageQuota', 'mpAlertTemplateId', 'adminNotifyPhones', 'shareImages'];
  if (!ALLOWED.includes(key)) return { ok: false, code: 'BAD_KEY', msg: '未知设置项' };
  // ===== 2026-09-11 降频与开关类设置（老板定：应对云开发「调用次数」用尽）=====
  // 说明：统一在此预规范化并改写 value，后面的 `let v = value;` 自然拿到规范化结果；
  //      所有默认值 = 维持线上现有行为（locWorkTier 例外：默认 30S/120S 最省档，老板 2026-09-11 拍板）
  const BOOL_SET = ['locTrackEnabled', 'locLatestEnabled', 'locPackUpload', 'adminAutoRefresh', 'adminHiddenPause', 'reviewWatchEnabled', 'recEnabled', 'evidenceRequired', 'platformPhotoShow', 'coordFixEnabled'];
  if (BOOL_SET.includes(key)) value = !!value;
  const ENUM_SET = {
    locWorkTier: ['5_30', '15_60', '30_120'],  // 工作时段上报档位（拜访中/平时）
    locPackSec: [30, 60, 120],                 // 打包上报间隔（秒）
    photoLimit: [3, 6, 9, 15],                 // 现场照片档位
    tickIntervalMin: [10, 30, 60],             // 定时器频率（分钟）
    asrPollMin: [5, 15, 30],                   // 转写轮询频率（分钟）
    usageAlertPct: [60, 80],                   // 用量红线（百分比）
    salesmanScope: ['task', 'all']             // 业务员可见范围
  };
  const ENUM_DEF = { locWorkTier: '30_120', locPackSec: 60, photoLimit: 9, tickIntervalMin: 30, asrPollMin: 15, usageAlertPct: 60, salesmanScope: 'task' };
  if (ENUM_SET[key]) {
    const isNum = ['locPackSec', 'photoLimit', 'tickIntervalMin', 'asrPollMin', 'usageAlertPct'].includes(key);
    const val = isNum ? Number(value) : String(value);
    value = ENUM_SET[key].includes(val) ? val : ENUM_DEF[key];
  }
  if (key === 'locMoveThreshold') {
    // 移动超过 N 米才上报（0=不启用该阈值），钳制 0~200
    const n = Number(value);
    value = Number.isInteger(n) && n >= 0 && n <= 200 ? n : 20;
  }
  if (key === 'usageQuota') {
    // 2026-09-11 批 3：云调用月度额度（自建统计对照用）——1 万~1 亿，默认 100 万次/月
    const n = Math.round(Number(value) || 0);
    value = (n >= 10000 && n <= 100000000) ? n : 1000000;
  }
  if (key === 'mpAlertTemplateId') {
    // 2026-09-12：用量告警模板 ID（「实时交易提醒」模板，编号 47862）
    // ⚠️ 老板确认：开头那截 "--" 也是 ID 的一部分（不是页面装饰）→ 只去首尾空格，绝不动其它字符
    // ⚠️ 2026-09-12 老板定：界面不显示明文（防看到/误改）→ 留空＝保持原值不修改；传 __CLEAR__ ＝清空
    const raw = String(value == null ? '' : value).trim();
    if (raw === '__CLEAR__') {
      value = '';
    } else if (!raw) {
      const curRes = await db.collection('settings').where({ key }).limit(1).get();
      value = (curRes.data[0] && curRes.data[0].value) || '';
    } else {
      value = raw;
    }
  }
  if (key === 'adminNotifyPhones') {
    // 2026-09-12 老板定：**管理员信息收件人手机号** —— 系统/管理类通知（用量告警等）只发给这些号
    // （老板明确：这类信息不要发给朱小利的微信；也不改绑任何微信，纯靠这份配置）
    // 逗号/中文逗号/分号/空格分隔，只保留 11 位数字，最多 10 个
    value = String(value == null ? '' : value)
      .split(/[,，;\s]+/).map(s => s.trim()).filter(s => /^\d{11}$/.test(s)).slice(0, 10).join(',');
  }
  // locationCheck 规范化：enabled + threshold（0=关闭校验）
  let v = value;
  if (key === 'locationCheck') {
    // 口径：0 或不勾选=关闭校验；勾选 + 1~500 整数=按该值校验（超出钳制到 0~500）
    const th = Math.max(0, Math.min(500, parseInt(value.threshold, 10) || 0));
    const en = !!value.enabled && th >= 1 && th <= 500;
    v = { enabled: en, threshold: th };
  }
  if (key === 'welcomeConfig') {
    // 老板欢迎仪式（2026-09-10 老板定）：频率 daily/every/once、时长 2/3/5 秒、风格 gold/color
    v = {
      mode: ['daily', 'every', 'once'].includes(value && value.mode) ? value.mode : 'daily',
      duration: [2, 3, 5].includes(Number(value && value.duration)) ? Number(value.duration) : 3,
      style: (value && value.style) === 'color' ? 'color' : 'gold'
    };
  }
  if (key === 'locRefreshInterval') {
    // 正常页面距离刷新档位（2026-09-06 老板定）：仅 30/45/60 秒，其余回默认 30
    const n = Number(value);
    v = [30, 45, 60].includes(n) ? n : 30;
  }
  if (key === 'locKeyRefreshInterval') {
    // 重要定位页面刷新档位（2026-09-06 老板定）：仅 8/12/15/20 秒，其余回默认 15
    const n = Number(value);
    v = [8, 12, 15, 20].includes(n) ? n : 15;
  }
  if (key === 'recordingDurationLimit') {
    // 拜访录音时长上限（秒；2026-09-07 正式启用预留设置项）：仅 3/5/10 分钟，其余回默认 300（5 分钟）
    const n = Number(value);
    v = [180, 300, 600].includes(n) ? n : 300;
  }
  if (key === 'visitDurationLimit') {
    // 拜访时长上限（秒；2026-09-08 老板定，M1）：仅 30 分钟/1 小时/2 小时，其余回默认 3600（1 小时）
    const n = Number(value);
    v = [1800, 3600, 7200].includes(n) ? n : 3600;
  }
  if (key === 'workStartHour') {
    // 工作开始小时（2026-09-08 M2 时间分层）：0~23，默认 7
    const n = Number(value);
    v = Number.isInteger(n) && n >= 0 && n <= 23 ? n : 7;
  }
  if (key === 'workEndHour') {
    // 工作结束小时（2026-09-08 M2 时间分层）：0~23，默认 20
    const n = Number(value);
    v = Number.isInteger(n) && n >= 0 && n <= 23 ? n : 20;
  }
  if (key === 'offDutyTier') {
    // 非工作时段三档（2026-09-11 老板定：只保留较大的两档并新增最省档）：
    // 20S/120S（默认）/ 30S/180S / 60S/300S；旧的 5_30、10_60 不再提供，历史值一律归到默认档
    v = ['20_120', '30_180', '60_300'].includes(String(value)) ? String(value) : '20_120';
  }
  if (key === 'trackKeepDays') {
    // 轨迹保留天数（2026-09-08 M2）：1~365 整数，默认 30
    const n = Number(value);
    v = Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
  }
  if (key === 'expireArchiveDays') {
    // 过期任务自动归档档位（天；2026-09-08 老板定）：仅 2/3/5 天，其余回默认 3
    const n = Number(value);
    v = [2, 3, 5].includes(n) ? n : 3;
  }
  if (key === 'globalRefreshInterval') {
    // 后台全局数据刷新间隔（秒；2026-09-08 老板定）：仅 5/10/15/30/60 秒，其余回默认 15
    const n = Number(value);
    v = [5, 10, 15, 30, 60].includes(n) ? n : 15;
  }
  if (key === 'mpConfig') {
    // 服务号配置：AppID/AppSecret/模板 ID 留空 → 均保留旧值（后台已简化成只切换开关，防清空凭据）
    const old = (await getMpConfig()) || {};
    v = {
      appid: String((value && value.appid) || '').trim() || (old.appid || ''),
      appsecret: String((value && value.appsecret) || '').trim() || (old.appsecret || ''),
      templateId: String((value && value.templateId) || '').trim() || (old.templateId || ''),
      enabled: !!(value && value.enabled)
    };
  }
  if (key === 'taskRegionCode') {
    // 任务编号区域码：去空格转大写；留空回默认 JH05（金华永康）
    v = String(value || '').trim().toUpperCase() || 'JH05';
  }
  if (key === 'mpKey') {
    // 腾讯地图 Key（前端渲染+路线规划共用；留空回默认）
    v = String(value || '').trim() || 'SQWBZ-K326U-MU3VH-GWUHA-HGNES-S7F2D';
  }
  const exist = await db.collection('settings').where({ key }).get();
  if (exist.data.length) {
    await db.collection('settings').doc(exist.data[0]._id).update({ data: { value: v, updatedAt: Date.now() } });
  } else {
    await db.collection('settings').add({ data: { key, value: v, updatedAt: Date.now() } });
  }
  // mpConfig 不回传明文 AppSecret
  const outV = key === 'mpConfig'
    ? { appid: v.appid, appsecretSet: !!v.appsecret, templateId: v.templateId, enabled: v.enabled }
    : v;
  return { ok: true, key, value: outV };
}

// ===== 服务号 OpenID 绑定（业务员） =====
async function setMpOpenid(event) {
  const { userId, mpOpenid } = event;
  if (!userId) return { ok: false, code: 'BAD_ARG', msg: '缺少用户' };
  const uRes = await db.collection('users').doc(userId).get().catch(() => null);
  const u = uRes && uRes.data;
  // 2026-09-10 老板定：管理员（老板）也要绑服务号收注册通知——角色放开为 业务员/管理员/超级管理员
  if (!u || !['salesman', 'admin', 'super_admin'].includes(u.role)) return { ok: false, code: 'NOT_FOUND', msg: '用户不存在' };
  const val = String(mpOpenid || '').trim();
  await db.collection('users').doc(userId).update({
    data: { mpOpenid: val, mpBoundAt: val ? Date.now() : null }
  });
  return { ok: true, mpOpenid: val, msg: val ? '服务号 OpenID 已绑定' : '已解绑服务号 OpenID' };
}

// 测试发送：用已保存的服务号配置向指定 OpenID 发一条测试模板消息（诊断配置/字段/白名单）
async function testMpSend(event) {
  const openid = String(event.openid || '').trim();
  if (!openid) return { ok: false, code: 'BAD_ARG', msg: '请填写测试收件 OpenID' };
  const cfg = await getMpConfig();
  if (!cfg || !cfg.enabled || !cfg.appid || !cfg.appsecret || !cfg.templateId) {
    return { ok: false, code: 'MP_CFG', msg: '请先在系统设置保存并启用服务号配置' };
  }
  try {
    const token = await getMpAccessToken(cfg);
    const r = await mpRequest(`/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
      touser: openid,
      template_id: cfg.templateId,
      data: buildMpData({ name: '测试任务', purpose: 'activate', deadline: todayStr(), total: 1, type: 'new' })
    });
    if (r && r.errcode === 0) return { ok: true, sent: true, msgid: r.msgid, msg: '测试消息已发送，请查看该微信的"服务通知"' };
    return { ok: false, sent: false, code: 'MP_ERR', msg: `errcode=${r && r.errcode} ${(r && r.errmsg) || ''}` };
  } catch (e) {
    return { ok: false, sent: false, code: 'MP_ERR', msg: e.message || '发送失败' };
  }
}

// 本机 server.js 定时同步服务号 access_token 到云端（白名单只认本机 IP 时，云函数自己取不到 token）
async function mpTokenPush(event) {
  const { mpToken, mpExpiresAt } = event;
  const token = String(mpToken || '').trim();
  if (!token || token.length < 20) return { ok: false, code: 'BAD_ARG', msg: 'token 无效' };
  const expiresAt = Number(mpExpiresAt);
  if (!expiresAt || expiresAt <= Date.now() + 60000) return { ok: false, code: 'BAD_ARG', msg: '过期时间无效' };
  const data = { key: 'mpAccessToken', value: { token, expiresAt }, updatedAt: Date.now() };
  const exist = await db.collection('settings').where({ key: 'mpAccessToken' }).limit(1).get();
  if (exist.data.length) await db.collection('settings').doc(exist.data[0]._id).update({ data });
  else await db.collection('settings').add({ data });
  return { ok: true, msg: '服务号 token 已同步', expiresAt };
}

// 管理员清理某业务员的遗留「拜访中」及全部取消痕迹（老板 2026-09-04 定稿：取消不留痕 = 删除记录）
async function cancelOngoing(event) {
  const { salesmanId } = event;
  if (!salesmanId) return { ok: false, code: 'BAD_ARG', msg: '缺少业务员' };
  const smRes = await db.collection('users').doc(salesmanId).get().catch(() => null);
  const sm = smRes && smRes.data;
  if (!sm || sm.role !== 'salesman') return { ok: false, code: 'NOT_FOUND', msg: '业务员不存在' };
  const ongs = await fetchAll('visits', { salesmanId, status: 'ongoing' }, { _id: true });
  const cancels = await fetchAll('visits', { salesmanId, status: 'cancelled' }, { _id: true });
  const all = [...ongs, ...cancels];
  if (!all.length) return { ok: true, cancelled: 0, msg: '该业务员没有拜访中/取消记录' };
  const BATCH = 50;
  for (let i = 0; i < all.length; i += BATCH) {
    await Promise.all(all.slice(i, i + BATCH).map(o => db.collection('visits').doc(o._id).remove()));
  }
  return { ok: true, cancelled: all.length, msg: `已删除 ${all.length} 条记录（拜访中 ${ongs.length} 条 + 历史取消 ${cancels.length} 条），客户回到待回访` };
}

// 全库清除「已取消」痕迹（老板 2026-09-04 定稿：取消不留痕 = 删除记录；清理历史脏数据用）
async function purgeCancelled(event) {
  const cancels = await fetchAll('visits', { status: 'cancelled' }, { _id: true });
  if (!cancels.length) return { ok: true, deleted: 0, msg: '没有已取消记录' };
  const BATCH = 50;
  for (let i = 0; i < cancels.length; i += BATCH) {
    await Promise.all(cancels.slice(i, i + BATCH).map(o => db.collection('visits').doc(o._id).remove()));
  }
  return { ok: true, deleted: cancels.length, msg: `已删除 ${cancels.length} 条「已取消」记录` };
}

// ===== 坐标报错审核（2026-09-06 老板新口径：同意后不替换客户原坐标，仅将客户坐标状态标记为「待确定」，
// 业务员上报坐标暂存在 coord_fix_requests，后台点「待确定」弹窗查看） =====
async function listCoordFixes(event) {
  try { await db.createCollection('coord_fix_requests'); } catch (e) { /* 已存在 */ }
  // 指定客户：返回其全部状态申请（待审核/已审核/已拒绝，供「待确定」弹窗查看业务员上报坐标）
  if (event && event.customerId) {
    const res = await db.collection('coord_fix_requests')
      .where({ customerId: event.customerId, status: _.in(['pending', 'confirmed', 'rejected']), type: _.neq('field') })   // ⭐ 与"现场提报"分流
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    if (!res.data.length) return { ok: true, fixes: [] };
    const cRes = await db.collection('customers').doc(event.customerId).get().catch(() => null);
    const c = (cRes && cRes.data) || {};
    const uids = [...new Set(res.data.map(f => f.salesmanId))];
    const uRes = await db.collection('users').where({ _id: _.in(uids) }).get();
    const umap = {};
    uRes.data.forEach(u => { umap[u._id] = u; });
    return {
      ok: true,
      fixes: res.data.map(f => {
        const u = umap[f.salesmanId] || {};
        const dist = (c.lat && c.lng && f.newLat && f.newLng) ? Math.round(haversine(f.newLat, f.newLng, c.lat, c.lng)) : null;
        return {
          _id: f._id, customerId: f.customerId, customerName: c.name || '', customerType: c.customerType || '',
          salesmanName: u.name || '', note: f.note || '',
          photos: Array.isArray(f.photos) ? f.photos : [],
          oldLat: c.lat || null, oldLng: c.lng || null,
          newLat: f.newLat, newLng: f.newLng,
          distance: dist, createdAt: f.createdAt,
          status: f.status || 'pending', reviewedAt: f.reviewedAt || null, reviewedBy: f.reviewedBy || ''
        };
      })
    };
  }
  const res = await db.collection('coord_fix_requests')
    .where({ status: 'pending', type: _.neq('field') })   // ⭐ 与"现场提报"分流
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  if (!res.data.length) return { ok: true, fixes: [] };
  const cids = [...new Set(res.data.map(f => f.customerId))];
  const cRes = await db.collection('customers').where({ _id: _.in(cids) }).get();
  const cmap = {};
  cRes.data.forEach(c => { cmap[c._id] = c; });
  const uids = [...new Set(res.data.map(f => f.salesmanId))];
  const uRes = await db.collection('users').where({ _id: _.in(uids) }).get();
  const umap = {};
  uRes.data.forEach(u => { umap[u._id] = u; });
  return {
    ok: true,
    fixes: res.data.map(f => {
      const c = cmap[f.customerId] || {};
      const u = umap[f.salesmanId] || {};
      const dist = (c.lat && c.lng && f.newLat && f.newLng) ? Math.round(haversine(f.newLat, f.newLng, c.lat, c.lng)) : null;
      return {
        _id: f._id, customerId: f.customerId, customerName: c.name || '', customerType: c.customerType || '',
        salesmanName: u.name || '', note: f.note || '',
        photos: Array.isArray(f.photos) ? f.photos : [],
        oldLat: c.lat || null, oldLng: c.lng || null,
        newLat: f.newLat, newLng: f.newLng,
        distance: dist, createdAt: f.createdAt
      };
    })
  };
}

// ⭐ 2026-09-27 新增：**现场提报审核**（修正 008）—— 采纳即写进客户档案 `platManual`，然后标记这条记录。
//   入参：{ reportId, approve: true|false, byName? }
//   采纳落点：dish → platManual.dishes[]；fac → platManual.facs[]；flag → platManual.groupon / takeout
//   （手机端 buildD 读的正是 platManual.dishes/facs，采纳后刷新即生效）
async function reviewFieldReport(event) {
  const reportId = String((event && event.reportId) || '');
  const approve = event && event.approve === true;
  if (!reportId) return { ok: false, code: 'BAD_ARG', msg: '缺少记录 id' };
  const rRes = await db.collection('coord_fix_requests').doc(reportId).get().catch(() => null);
  if (!rRes || !rRes.data) return { ok: false, code: 'NOT_FOUND', msg: '记录不存在' };
  const r = rRes.data;
  if (r.type !== 'field') return { ok: false, code: 'BAD_ARG', msg: '这条不是现场提报' };
  if (r.status !== 'pending') return { ok: false, code: 'DONE', msg: '这条已经处理过了' };
  const now = Date.now();
  if (approve) {
    const cRes = await db.collection('customers').doc(r.customerId).get().catch(() => null);
    if (!cRes || !cRes.data) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
    const pm = Object.assign({}, cRes.data.platManual || {});
    const kind = r.kind || '';
    if (kind === 'dish') {
      const arr = Array.isArray(pm.dishes) ? pm.dishes.slice() : [];
      if (r.value && arr.indexOf(r.value) < 0) arr.push(r.value);
      pm.dishes = arr;
    } else if (kind === 'fac') {
      const arr = Array.isArray(pm.facs) ? pm.facs.slice() : [];
      if (r.value && arr.indexOf(r.value) < 0) arr.push(r.value);
      pm.facs = arr;
    } else if (kind === 'flag') {
      if (r.flagName === '团购') pm.groupon = !!r.flagTo;
      else if (r.flagName === '外卖') pm.takeout = !!r.flagTo;
    }
    pm.updatedAt = now;
    await db.collection('customers').doc(r.customerId).update({ data: { platManual: pm, updatedAt: now } });
  }
  await db.collection('coord_fix_requests').doc(reportId).update({
    data: { status: approve ? 'confirmed' : 'rejected', reviewedAt: now, reviewedBy: (event && event.byName) || 'admin' }
  });
  return { ok: true, approved: approve };
}

async function reviewCoordFix(event) {
  const { fixId, approve } = event;
  if (!fixId) return { ok: false, code: 'BAD_ARG', msg: '缺少申请' };
  try { await db.createCollection('coord_fix_requests'); } catch (e) { /* 已存在 */ }
  const fRes = await db.collection('coord_fix_requests').doc(fixId).get().catch(() => null);
  const f = fRes && fRes.data;
  if (!f) return { ok: false, code: 'NOT_FOUND', msg: '申请不存在' };
  if (f.status !== 'pending') return { ok: false, code: 'DONE', msg: '该申请已处理' };
  const now = Date.now();
  if (approve) {
    // ⭐ 2026-09-26 老板定（**推翻 2026-09-06 那句"同意不写回坐标、只标待定"**）：
    //   **同意 = 把业务员报的坐标真正写回客户档案**：
    //     · lat/lng ← 本申请里的 newLat/newLng（业务员在手机上标的位置）
    //     · coordSource = 'salesman' → 前台/后台显示「采集」
    //     · coord_status = 'ok'（坐标已确定；不再有"待定"这个中间态）
    //   —— 这也与 coordfix 云函数给业务员的回执一致："管理员审核后将更新客户坐标 ✓"
    if (f.newLat == null || f.newLng == null) {
      return { ok: false, code: 'NO_COORD', msg: '这条申请里没有坐标，无法写回（可先驳回）' };
    }
    await db.collection('customers').doc(f.customerId).update({
      data: {
        lat: f.newLat, lng: f.newLng,
        coord_status: 'ok',
        coordSource: 'salesman',
        coordUpdatedAt: now,
        coordFixReviewedAt: now,
        updatedAt: now            // 2026-09-27 补：增量同步（custSync）用
      }
    });
    await db.collection('coord_fix_requests').doc(fixId).update({
      data: { status: 'confirmed', reviewedAt: now, reviewedBy: (event._admin && event._admin.name) || '' }
    });
    return { ok: true, decision: 'confirmed', msg: '已审核通过：客户坐标已更新为业务员采集的坐标（来源标为「采集」）' };
  }
  await db.collection('coord_fix_requests').doc(fixId).update({
    data: { status: 'rejected', reviewedAt: now, reviewedBy: (event._admin && event._admin.name) || '' }
  });
  return { ok: true, decision: 'rejected', msg: '已拒绝，客户坐标不变（业务员可再次报错）' };
}

// ⭐ 2026-09-26 一次性：把存量“待定”（coord_status='pending_confirm'）的客户按**新规则**处理掉。
//   背景：旧逻辑下“同意”只标 pending_confirm、**不写坐标**；新规则是“同意即写回”。
//   做法：逐条找它的报错记录（status='confirmed' 的最新一条）→ 有 newLat/newLng 就写回客户档案
//         （coordSource='salesman'、coord_status='ok'）；找不到可用记录的，只把状态恢复成 'ok'（坐标不动）。
//   ✅ **幂等**：跑完就没有 pending_confirm 了，重复跑返回 0 条。
async function fixLegacyPendingCoords(event) {
  const rows = await fetchAll('customers', { coord_status: 'pending_confirm' },
    { _id: true, name: true });
  let fixed = 0, restored = 0, skipped = 0;
  const now = Date.now();
  for (const c of rows) {
    const fixes = await fetchAll('coord_fix_requests',
      { customerId: c._id, status: 'confirmed' }, { newLat: true, newLng: true, reviewedAt: true });
    // 取 reviewedAt 最新的一条（旧数据可能没有 reviewedAt，就取任意一条有坐标的）
    let pick = null;
    for (const f of fixes) {
      if (f.newLat == null || f.newLng == null) continue;
      if (!pick || (f.reviewedAt || 0) > (pick.reviewedAt || 0)) pick = f;
    }
    if (pick) {
      await db.collection('customers').doc(c._id).update({
        data: {
          lat: pick.newLat, lng: pick.newLng,
          coord_status: 'ok', coordSource: 'salesman',
          coordUpdatedAt: now, coordLegacyFixedAt: now,
          updatedAt: now            // 2026-09-27 补：增量同步（custSync）用
        }
      });
      fixed++;
    } else {
      // 没找到可用坐标 → 不瞎改，只把状态恢复成 ok（保持原坐标与来源）
      await db.collection('customers').doc(c._id).update({
        data: { coord_status: 'ok', coordLegacyFixedAt: now, updatedAt: now }   // 2026-09-27 补
      });
      restored++;
    }
    if (fixed + restored >= 500) { skipped = rows.length - fixed - restored; break; }   // 单次上限防超时
  }
  // 顺带（2026-09-26）：把**旧导入脚本写错的点评来源值 'plat' 修正为 'platform'**（幂等）——
  //   老板报障：刚导的 1600 家明明来自大众点评，却被显示成“商城”（因为旧脚本写的是 'plat'）。
  const badSrc = await fetchAll('customers', { coordSource: 'plat' }, { _id: true });
  for (const b of badSrc) {
    await db.collection('customers').doc(b._id).update({ data: { coordSource: 'platform', updatedAt: Date.now() } });   // 2026-09-27 补
  }
  // 顺带（2026-10-02）：把**手机端「加新店」历史写下的来源值 'field' 统一为新值 'newshop'**（幂等）——
  //   老板定：「加新店」现场录入的坐标，来源显示「新店」。tasks.newShopSubmit / updateNewShop 已改为写 'newshop'，
  //   这里把**改之前建的那几家**一并订正 —— 否则后台详情页/列表认不出 'field'，会显示成「未知」。
  //   ⚠️ 只动 coordSource 这一个字段，另加 updatedAt（本地缓存增量同步 custSync 靠它；
  //      不写 updatedAt 的话后台快照里的来源还是旧值，看起来像"改了没生效"）。
  //   ⚠️ 量很小（2026-10-02 实测库里仅 4 家），幂等、可重复跑。
  const badSrcField = await fetchAll('customers', { coordSource: 'field' }, { _id: true });
  for (const b of badSrcField) {
    await db.collection('customers').doc(b._id).update({ data: { coordSource: 'newshop', updatedAt: Date.now() } });
  }
  return {
    ok: true,
    msg: `存量处理完成：待定写回 ${fixed} 家｜仅恢复状态 ${restored} 家｜未处理 ${skipped} 家｜修正来源 plat→platform ${badSrc.length} 家｜修正来源 field→newshop ${badSrcField.length} 家`,
    found: rows.length, fixed, restored, skipped, platFixed: badSrc.length, fieldFixed: badSrcField.length
  };
}

// 测试数据重置（2026-09-07 老板要重新开始测试）：清全部业务数据，
// 保留客户档案/账号/设置/商城名单；客户状态归零（待回访）
async function resetTestData(event) {
  // 0) 先收集全部照片/录音云存储 fileID（2026-09-08 补：删数据库记录必须连带删云存储文件，否则残留在服务器）
  const fileIDs = new Set();
  const visitRows = await fetchAll('visits', {}, { photos: true, audio: true });
  visitRows.forEach(v => {
    (v.photos || []).forEach(p => { if (p && p.fileID) fileIDs.add(p.fileID); if (p && p.thumbID) fileIDs.add(p.thumbID); });
    if (v.audio && v.audio.fileID) fileIDs.add(v.audio.fileID);
  });
  const fixRows = await fetchAll('coord_fix_requests', {}, { photos: true });
  fixRows.forEach(f => {
    (f.photos || []).forEach(p => { if (p && p.fileID) fileIDs.add(p.fileID); if (p && p.thumbID) fileIDs.add(p.thumbID); });
  });
  // 1) 数据库文档清空（2026-09-08 老板定：只清业务员测试产出——任务/拜访/坐标报错；
  //    导入数据的批次 customer_batches/batch_members、比对认领清单 mall_claims 一律不清！）
  const colls = ['tasks', 'visits', 'coord_fix_requests'];
  const stats = {};
  for (const coll of colls) {
    try { await db.createCollection(coll); } catch (e) { /* 已存在 */ }
    const all = await fetchAll(coll, {}, { _id: true });
    const BATCH = 50;
    for (let i = 0; i < all.length; i += BATCH) {
      await Promise.all(all.slice(i, i + BATCH).map(d => db.collection(coll).doc(d._id).remove()));
    }
    stats[coll] = all.length;
  }
  // 2) 云存储文件删除（分批 ≤50；单个失败不阻断）
  const fidList = [...fileIDs].filter(Boolean);
  let deletedFiles = 0;
  for (let i = 0; i < fidList.length; i += 50) {
    try {
      const r = await cloud.deleteFile({ fileList: fidList.slice(i, i + 50) });
      (r.fileList || []).forEach(f => { if (f.status === 0) deletedFiles++; });
    } catch (e) { /* 该批失败继续下一批 */ }
  }
  stats.files_deleted = deletedFiles;
  // 3) 客户状态归零（档案保留）：reviewFlag=false；coord_status 按坐标有无重置 ok/pending；
  //    批次归属 batchIds **保留**（2026-09-08 老板定：重置不动导入数据的批次）
  // 2026-09-08 修 -601008：原串行逐家 update（247 家=247 次往返）必超 30s → 改 runPool 15 并发（坑 29）
  const cs = await fetchAll('customers', {}, { _id: true, lat: true, lng: true });
  await runPool(cs, 15, async (c) => {
    const hasCoord = !!(c.lat && c.lng);
    await db.collection('customers').doc(c._id).update({
      data: { reviewFlag: false, coord_status: hasCoord ? 'ok' : 'pending', updatedAt: Date.now() }   // 2026-09-27 补
    });
  });
  stats.customers_reset = cs.length;
  return {
    ok: true,
    stats,
    msg: `测试数据已重置：任务/拜访/报错/认领/批次已清空，照片与录音文件已删除 ${deletedFiles} 个（引用到 ${fidList.length} 个），客户状态归零（档案与设置保留）`
  };
}

// ===== 分批可续的数据清理（2026-09-12 新增，修 -601008 超时；老板：60 秒都不够）=====
// 思路：一次调用只清一小批就返回，前端拿返回的 st 原样回传再调下一轮，直到 done。
//      —— 跟「导入分片 100/片 + 断点续跑」是完全一样的套路。
// scope：
//   'test' = 重置业务数据（清 任务/拜访/报错/转写，保留客户档案与批次，客户状态归零）
//   'all'  = 全清（在上面基础上连 认领/批内成员/批次/客户档案 一起清空，用于换新数据结构重导）
// 云存储：清 visits 时先把 fileID 攒进 settings.__wipeFiles（清了记录就找不到文件了），
//        全部清完后再走 __files__ 阶段分批删，删完把暂存文档清掉。
// ⭐ 2026-09-27 补漏（老板要"换新数据结构重新导入 6 万家"前的检查发现）：
//   · `customer_remarks`（客户备注）原来**两个 scope 都不清** → 换数据后会留孤儿备注，现补上；
//   · `locations`（业务员位置轨迹）原来**"重置业务数据"不清**（半清不净）→ 现补上；
//   · `orders` / `order_items` **故意不清** —— 订单按 customerCode 关联，新数据编码一致即可复用；
//     真要"干净重来"再手工处理（清客户不会误删订单）。
const WIPE_STAGES = {
  test: ['tasks', 'coord_fix_requests', 'transcripts', 'visits', 'locations', 'customer_remarks', '__files__', '__reset_cust__'],
  all: ['tasks', 'coord_fix_requests', 'transcripts', 'mall_claims', 'batch_members', 'customer_batches', 'customers', 'visits', 'locations', 'customer_remarks', '__files__']
};
const WIPE_ROWS = 80;   // 每轮每个集合最多删 80 条文档（确保单次调用几秒内返回）
const WIPE_FIDS = 100;  // 每轮最多删 100 个云存储文件

async function wipeData(event) {
  const scope = event.scope === 'all' ? 'all' : 'test';
  const stages = WIPE_STAGES[scope];
  const st = Object.assign({ i: 0, stats: {}, files: 0, fids: 0 }, event.st || {});
  if (st.i >= stages.length) {
    st.i = 0;
    return { ok: true, done: true, st, msg: '清理完成' };
  }
  const stage = stages[st.i];

  // ---- 阶段：云存储文件（分批删，每轮 100 个）----
  if (stage === '__files__') {
    const doc = await db.collection('settings').doc('__wipeFiles').get().catch(() => null);
    const list = (doc && doc.data && doc.data.list) || [];
    if (!st.fids) st.fids = list.length;
    if (!list.length) {
      await db.collection('settings').doc('__wipeFiles').remove().catch(() => {});
      st.i++;
      return { ok: true, done: false, st, stage, msg: '云存储文件已全部删除' };
    }
    const take = list.slice(0, WIPE_FIDS);
    let del = 0;
    for (let i = 0; i < take.length; i += 50) {
      try {
        const r = await cloud.deleteFile({ fileList: take.slice(i, i + 50) });
        (r.fileList || []).forEach(f => { if (f.status === 0) del++; });
      } catch (e) { /* 该批失败不阻断 */ }
    }
    const rest = list.slice(take.length);
    await db.collection('settings').doc('__wipeFiles').set({ data: { list: rest } }).catch(() => {});
    st.files = (st.files || 0) + del;
    return { ok: true, done: false, st, stage, remain: rest.length, msg: `删除照片/录音文件 ${st.files}/${st.fids}…` };
  }

  // ---- 阶段：客户状态归零（test 模式专用；档案保留）----
  if (stage === '__reset_cust__') {
    const rc = await db.collection('customers').limit(WIPE_ROWS).get();
    const crows = rc.data || [];
    if (!crows.length) { st.i++; return { ok: true, done: false, st, stage, msg: '客户状态已全部归零' }; }
    await Promise.all(crows.map(c => db.collection('customers').doc(c._id).update({
      data: { reviewFlag: false, coord_status: (c.lat && c.lng) ? 'ok' : 'pending', updatedAt: Date.now() }   // 2026-09-27 补
    }).catch(() => {})));
    st.stats.customers_reset = (st.stats.customers_reset || 0) + crows.length;
    return { ok: true, done: false, st, stage, msg: `客户状态归零 ${st.stats.customers_reset} 家…` };
  }

  // ---- 阶段：普通集合（每轮 80 条）----
  try { await db.createCollection(stage); } catch (e) { /* 已存在 */ }
  const r = await db.collection(stage).limit(WIPE_ROWS).get();
  const rows = r.data || [];
  if (!rows.length) { st.i++; return { ok: true, done: false, st, stage, msg: `${stage} 已清空` }; }

  // visits：删记录前先把照片/录音 fileID 攒进暂存（删了记录就再也找不到文件了）
  if (stage === 'visits') {
    const ids = rows.map(d => d._id);
    const fresh = await db.collection('visits').where({ _id: _.in(ids) })
      .field({ photos: true, audio: true }).get().catch(() => null);
    const fids = [];
    ((fresh && fresh.data) || []).forEach(v => {
      (v.photos || []).forEach(p => { if (p && p.fileID) fids.push(p.fileID); if (p && p.thumbID) fids.push(p.thumbID); });
      if (v.audio && v.audio.fileID) fids.push(v.audio.fileID);
    });
    if (fids.length) {
      const doc = await db.collection('settings').doc('__wipeFiles').get().catch(() => null);
      const list = ((doc && doc.data && doc.data.list) || []).concat(fids);
      await db.collection('settings').doc('__wipeFiles').set({ data: { list } }).catch(() => {});
    }
  }

  await Promise.all(rows.map(d => db.collection(stage).doc(d._id).remove()));
  st.stats[stage] = (st.stats[stage] || 0) + rows.length;
  return { ok: true, done: false, st, stage, msg: `正在清理 ${stage}…已删 ${st.stats[stage]} 条` };
}

// ===================== 客户批次管理（2026-09-07 老板定稿，方案见交接文档 §7.12） =====================
const BATCH_COLLS = ['customer_batches', 'batch_members'];

// ⚠️ 2026-09-27 性能修复（-601008 超时的**主因**）：加进程内标记，同一云函数实例只真正建一次。
//   原写法每家客户都调本函数 → 每家白跑 2 次 createCollection 网络请求 → 300 家 = 600 次无效请求，
//   串行叠加在读写之前，直接把 30s 配额吃光（老板实测"只选了 300 多家"也超时）。
let _batchCollsReady = false;
async function ensureBatchColls() {
  if (_batchCollsReady) return;
  for (const c of BATCH_COLLS) {
    try { await db.createCollection(c); } catch (e) { /* 已存在 */ }
  }
  _batchCollsReady = true;
}

// 店名规范化（批次合并匹配用）：去公司后缀、全角转半角、去空格标点、小写
function normCustName(s) {
  let t = String(s || '').toLowerCase();
  ['有限责任公司', '有限公司', '股份有限公司', '个体工商户', '餐饮管理', '餐饮服务', '餐饮店', '饭店', '酒楼', '餐厅'].forEach(p => { t = t.split(p).join(''); });
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  return t.replace(/[\s，。、·—\-_/\\"'“”‘’'：:()（）【】\[\]]+/g, '');
}

// 匹配池条目预规范化（导入每片拉全量后一次性算好，避免匹配循环内对同一档案反复清洗字符串）
function normPoolEntry(p) {
  return {
    _id: p._id,
    name: String(p.name || '').trim(),
    nName: normCustName(p.name),
    phone: String(p.phone || '').trim(),
    address: String(p.address || '').trim(),
    nAddr: normAddr(p.address),
    region: String(p.region || '').trim()
  };
}

// 分级匹配（2026-09-07 老板定）：A=高置信自动/按设置，B=一律弹窗人工定；返回 {level, target, candidates} 或 null
// pool 条目必须经 normPoolEntry 预规范化（直接读 nName/nAddr）
function matchExistingCust(row, pool) {
  const nPhone = String(row.phone || '').trim();
  const nName = normCustName(row.name);
  const nAddr = normAddr(row.address);
  const nRegion = String(row.region || '').trim();
  const bCands = []; // B 级候选（电话相同店名异 / 无电话同名同区域）
  for (const p of pool) {
    if (nPhone && p.phone && nPhone === p.phone) {
      if (nName && nName === p.nName) return { level: 'A', target: p };
      if (nAddr && p.nAddr && nAddr === p.nAddr) return { level: 'A', target: p };
      if (!bCands.some(x => x._id === p._id)) bCands.push(p);
    } else if (!nPhone && nName && nName === p.nName && nRegion && nRegion === p.region) {
      if (!bCands.some(x => x._id === p._id)) bCands.push(p);
    }
  }
  if (bCands.length) return { level: 'B', target: bCands[0], candidates: bCands };
  return null;
}

// 并发分批执行（导入写库用：曾串行 100 条 × 2 次 add 共 200 次往返超时 -601008）
async function runPool(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// 批次自动命名：YYYY年M月D日第N批导入（按 autoNamePrefix 计数）
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
async function genBatchName() {
  await ensureBatchColls();
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const prefix = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  const cnt = await db.collection('customer_batches').where({ autoNamePrefix: prefix }).count();
  const n = cnt.total + 1;
  return { prefix, seq: n, name: `${prefix}第${CN_NUM[n - 1] || String(n)}批导入` };
}

// 客户入批（幂等）：batch_members 建纯名单关系（两层状态模型 2026-09-07：批次不持有状态）+ customers.batchIds 追加
async function addCustomerToBatch(customerId, batchId) {
  await ensureBatchColls();
  const c = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!c || !c.data) return false;
  const ex = await db.collection('batch_members').where({ batchId, customerId }).limit(1).get();
  if (!ex.data.length) {
    await db.collection('batch_members').add({ data: { batchId, customerId, createdAt: Date.now() } });
  }
  const ids = Array.isArray(c.data.batchIds) ? c.data.batchIds : [];
  if (!ids.includes(batchId)) {
    ids.push(batchId);
    await db.collection('customers').doc(customerId).update({ data: { batchIds: ids, updatedAt: Date.now() } });   // 2026-09-27 补：增量同步用
  }
  return true;
}

// 批次卡片列表 + 实时统计（两层状态模型：任务中/无任务；不存冗余，按全局推导内存分组）+ 未分批客户数
async function listCustomerBatches(event) {
  await ensureBatchColls();
  const batches = await fetchAll('customer_batches', {}, {});
  const members = await fetchAll('batch_members', {}, { batchId: true, customerId: true });
  // 全局任务中集合（published/reviewing 任务的客户；**已过期的不算**，2026-09-24 与 listCustomers 同口径）
  const inTaskSet = new Set();
  const tAll = await fetchAll('tasks', {}, { customerIds: true, status: true, deadline: true });
  const today0 = todayStr();
  tAll.forEach(t => {
    if (t.status !== 'published' && t.status !== 'reviewing') return;
    if (t.deadline && String(t.deadline) <= today0) return; // 过期任务不再算「任务中」
    (t.customerIds || []).forEach(id => inTaskSet.add(id));
  });
  const stat = {};
  // visited（历史已拜访过）：有完成拜访记录的客户集合
  const visitedSet = new Set();
  const vAll = await fetchAll('visits', {}, { customerId: true, status: true });
  vAll.forEach(v => { if (v.status === 'normal' || v.status === 'pending_review') visitedSet.add(v.customerId); });
  members.forEach(m => {
    if (!stat[m.batchId]) stat[m.batchId] = { in_task: 0, free: 0, visited: 0, total: 0 };
    if (inTaskSet.has(m.customerId)) stat[m.batchId].in_task++;
    else stat[m.batchId].free++;
    if (visitedSet.has(m.customerId)) stat[m.batchId].visited++;
    stat[m.batchId].total++;
  });
  // ⚠️ 2026-09-27 性能修复（-601008 超时）：**不再全量拉 customers**。
  //   原写法 `fetchAll('customers', {}, {_id,batchIds})` 在导入 6 万家后要 61 次串行请求（每次 1000 条），
  //   叠加 visits/tasks/batch_members 后直接冲破 30s → 「批次管理」整页报 -601008、看不到任何批次。
  //   改法：「入批客户集合」直接复用上面已经拉到的 batch_members（数量=入批客户数，远小于全库），
  //        全库总数改用 count()（一次请求），未分批数 = 全库总数 − 入批客户数。
  const memberIds = new Set(members.map(m => m.customerId));
  // ⭐ 2026-09-29 回收站：**客户总数不含已删客户**（老板定「进了回收站的客户，不再纳入客户总数」）
  //   ⚠️ 未分批数 = 客户总数 − 入批客户数 → **入批数也必须排除已删**，否则会算出偏小的未分批数
  //      （下面的 `aliveMemberIds` 就是干这个的；`Math.max(0,…)` 只是最后兜底，不该靠它）。
  let totalCustomers = 0;
  try { totalCustomers = (await db.collection('customers').where(NOT_DELETED).count()).total || 0; } catch (e) { totalCustomers = memberIds.size; }
  // ⭐ 2026-09-29 回收站：**入批客户里也要排除已删** —— 否则 `客户总数(不含已删) − 入批数(含已删)` 会把未分批数算小。
  //   按 _id 分批查（主键索引，很快）；已删客户**依旧留在 batch_members 里**（恢复后批次归属照旧）。
  const aliveMemberIds = new Set();
  {
    const _arr = [...memberIds];
    for (let i = 0; i < _arr.length; i += 100) {
      const part = await fetchAll('customers',
        _.and([{ _id: _.in(_arr.slice(i, i + 100)) }, NOT_DELETED]), { _id: true });
      part.forEach(c => aliveMemberIds.add(c._id));
    }
  }
  const unbatched = Math.max(0, totalCustomers - aliveMemberIds.size);
  // 全部批次汇总（2026-09-09 老板定：顶部工具卡统计区；客户级去重——客户可属多个批次，Σ 各批 stats 会重复计数）
  // 口径与批次卡一致：in_task=当前有 published/reviewing 任务的客户；free=非任务中；visited=有正常拜访记录的客户
  // ⭐ 2026-09-29：**汇总只算未删的**（已删客户不该出现在任何"客户数"里）
  const memberArr = [...aliveMemberIds];
  const summary = {
    total: memberArr.length,
    in_task: memberArr.filter(id => inTaskSet.has(id)).length,
    free: memberArr.filter(id => !inTaskSet.has(id)).length,
    visited: memberArr.filter(id => visitedSet.has(id)).length
  };
  batches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return {
    ok: true,
    batches: batches.map(b => ({ _id: b._id, name: b.name || '', subtitle: b.subtitle || '', createdAt: b.createdAt || 0, createdBy: b.createdBy || '', autoNamePrefix: b.autoNamePrefix || '', stats: stat[b._id] || { in_task: 0, free: 0, visited: 0, total: 0 } })),
    unbatched,
    summary
  };
}

// 批量把客户加入某批次（2026-09-07 老板定：未分批客户可补入已有批次；多对多纯名单）
async function addCustomersToBatch(event) {
  const { batchId, customerIds } = event;
  if (!batchId || !Array.isArray(customerIds) || !customerIds.length) return { ok: false, code: 'BAD_ARG', msg: '缺少批次或客户' };
  const b = await db.collection('customer_batches').doc(batchId).get().catch(() => null);
  if (!b || !b.data) return { ok: false, code: 'NOT_FOUND', msg: '批次不存在' };
  const uniq = [...new Set(customerIds)];
  let ok = 0;
  await runPool(uniq, 15, async id => {
    if (await addCustomerToBatch(id, batchId)) ok++;
  });
  return { ok: true, added: ok, msg: `已将 ${ok} 家客户加入批次「${b.data.name || ''}」` };
}

// 从批次移除客户（2026-09-07 老板定）：只移除名单关系，客户档案保留；有拜访记录则禁止
async function removeCustomerFromBatch(event) {
  const { batchId, customerId } = event;
  if (!batchId || !customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少参数' };
  const b = await db.collection('customer_batches').doc(batchId).get().catch(() => null);
  if (!b || !b.data) return { ok: false, code: 'NOT_FOUND', msg: '批次不存在' };
  const vis = await db.collection('visits').where({ customerId }).limit(1).get();
  if (vis.data.length) return { ok: false, code: 'HAS_VISIT', msg: '该客户有拜访记录，不能从批次中删除' };
  const mem = await db.collection('batch_members').where({ batchId, customerId }).limit(1).get();
  if (mem.data.length) await db.collection('batch_members').doc(mem.data[0]._id).remove();
  const c = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (c && c.data && Array.isArray(c.data.batchIds)) {
    await db.collection('customers').doc(customerId).update({ data: { batchIds: c.data.batchIds.filter(x => x !== batchId), updatedAt: Date.now() } });   // 2026-09-27 补：增量同步用
  }
  return { ok: true, msg: '已从批次中移除（客户档案保留）' };
}

// ⭐⭐ 2026-09-29 老板定：**改成「回收站」（软删）**，不再真删。
//   老板原话：「客户管理里面做个回收站功能，删除的客户先放在里面呗，以后再统一清理」
//           +「可以进回收站，但是不能彻底删除」
//           +「进了回收站的客户，不再纳入客户总数（订单数据等还是要纳入总额的），不再地图上显示」
//   做法：**只打标记，不删任何数据** ——
//     · `deleted:true` + `deletedAt` + `deletedBy`
//     · 列表 / 地图 / 客户总数 / 待商城建档 / 重点消息 **一律排除**
//     · **订单聚合刻意不排除**（订单按 customerCode 走，与客户是否在回收站无关）→ 总额不会凭空变小
//     · 恢复 = 去掉标记（关联的拜访 / 照片 / 备注 **原地不动，一条不丢**）
//   ⚠️ 与旧版的差别：**旧版查 visits/orders，有就拒删** —— 老板 2026-09-29 改为**都能进回收站**；
//      「有订单/拜访 → 不能**彻底**删除」的保护**留给以后的"统一清理"**（那时才需要查这两张表）。
//   ⭐⭐ 但**任务中的客户一条都不能删**（老板 2026-09-29 定，见下）。
async function deleteCustomers(event) {
  const ids = Array.isArray(event.customerIds) ? event.customerIds.filter(Boolean) : [];
  if (!ids.length) return { ok: false, code: 'BAD_ARG', msg: '没有选择客户' };
  const now = Date.now();
  const by = (event._admin && event._admin.name) || '管理员';

  // ⭐⭐ 2026-09-29 老板定：**任务中的客户不能被删除**
  //   老板原话：「删除任务中的客户就提示"XX客户正在任务中，不能删除"就行了。所以，任务中的客户不能被删除。」
  //   为什么必须拦（**一条拦截解决两个问题**）：
  //     ① 任务进度分母是 `tasks.customerIds`，手机端任务客户列表也要显示它 —— 删了 → **进度永远到不了 100%**；
  //     ② 若它正好在「拜访中」，还会卡住"同一任务只允许 1 家拜访中"的拦截 → **业务员开不了新拜访**。
  //   拦在这里，两个问题一起消失，而且**完全不用动任务数据**（比"删时从任务摘引用"干净得多）。
  //   口径与 listCustomers / custPageAgg 的"任务中"**完全一致**：published / reviewing **且未过期**。
  const _today = todayStr();
  const _liveTasks = await fetchAll('tasks', { status: _.in(['published', 'reviewing']) },
    { customerIds: true, name: true, taskNo: true, deadline: true });
  const _inTask = {};   // customerId -> { name, taskNo }（取第一个命中的任务）
  _liveTasks.forEach(t => {
    if (t.deadline && String(t.deadline) <= _today) return;   // 已过期 → 不算"任务中"
    (t.customerIds || []).forEach(id => {
      if (!_inTask[id]) _inTask[id] = { name: t.name || '', taskNo: t.taskNo || '' };
    });
  });

  const moved = [];
  const blocked = [];
  for (const id of ids) {
    const c = await db.collection('customers').doc(id).get().catch(() => null);
    if (!c || !c.data) { blocked.push({ id, name: '', reason: '客户不存在' }); continue; }
    const nm = c.data.name || c.data.nameRaw || '';
    // ① 任务中 → 拒删（老板 2026-09-29 定）
    if (_inTask[id]) {
      const t = _inTask[id];
      const tag = t.name ? ('（' + t.name + (t.taskNo ? ' · ' + t.taskNo : '') + '）') : '';
      blocked.push({ id, name: nm, reason: '正在任务中' + tag + '，不能删除' });
      continue;
    }
    if (c.data.deleted === true) { blocked.push({ id, name: nm, reason: '已在回收站' }); continue; }
    await db.collection('customers').doc(id).update({
      data: { deleted: true, deletedAt: now, deletedBy: by, updatedAt: now }
    });
    moved.push({ id, name: nm });
  }
  return {
    ok: true,
    soft: true,
    deleted: moved.length,
    deletedIds: moved.map(x => x.id),
    blocked,
    msg: blocked.length
      ? `已移入回收站 ${moved.length} 家（${blocked.length} 家未处理）`
      : `已移入回收站 ${moved.length} 家`
  };
}

// ⭐ 2026-09-29 新增：**回收站列表**（客户档案里 deleted:true 的那些）
//   入参：{ page, pageSize, q }（q = 店名/电话/地址 模糊；与「待商城建档」同一套界面习惯）
//   ⚠️ 只读，不动任何数据；回收站里的客户**不计入客户总数**（客户总数在 listCustomerBatches 里已排除）。
async function listDeletedCustomers(event) {
  const e0 = event || {};
  const page = Math.max(0, Number(e0.page) || 0);
  const size = Math.min(100, Math.max(5, Number(e0.pageSize) || 30));
  const q = String(e0.q || '').trim();
  let qy = db.collection('customers').where({ deleted: true });
  if (q) {
    const re = db.RegExp({ regexp: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
    qy = db.collection('customers').where(_.and([
      { deleted: true },
      _.or([{ name: re }, { nameRaw: re }, { phone: re }, { phone2: re }, { address: re }])
    ]));
  }
  const totalRes = await qy.count().catch(() => ({ total: 0 }));
  const res = await qy.orderBy('deletedAt', 'desc').skip(page * size).limit(size)
    .get().catch(silentCatch('adminapi·listDeletedCustomers', { data: [] }));
  const list = (res.data || []).map(c => ({
    id: c._id,
    name: c.name || c.nameRaw || '(未填店名)',
    nameRaw: c.nameRaw || '',
    phone: c.phone || c.phone2 || '',
    address: c.address || '',
    area: c.district || '',
    bizCircle: c.bizCircle || '',
    source: c.source || '',
    mallPending: c.mallPending === true,
    deletedAt: c.deletedAt || 0,
    deletedBy: c.deletedBy || '',
    createdAt: c.createdAt || 0
  }));
  return { ok: true, total: (totalRes && totalRes.total) || 0, page, pageSize: size, list };
}

// ⭐ 2026-09-29 新增：**从回收站恢复**（去掉 deleted 标记 —— 客户档案与关联数据一直都在，一条不丢）
//   入参：{ customerIds: [...] }   出参：{ ok, restored, restoredIds, msg }
async function restoreCustomers(event) {
  const ids = Array.isArray(event.customerIds) ? event.customerIds.filter(Boolean) : [];
  if (!ids.length) return { ok: false, code: 'BAD_ARG', msg: '没有选择客户' };
  const now = Date.now();
  const done = [];
  for (const id of ids) {
    const c = await db.collection('customers').doc(id).get().catch(() => null);
    if (!c || !c.data) continue;
    if (c.data.deleted !== true) continue;          // 本来就不在回收站 → 跳过
    await db.collection('customers').doc(id).update({
      data: { deleted: false, restoredAt: now, restoredBy: (event._admin && event._admin.name) || '管理员', updatedAt: now }
    });
    done.push(id);
  }
  return {
    ok: true,
    restored: done.length,
    restoredIds: done,
    msg: `已从回收站恢复 ${done.length} 家（回到客户列表，批次归属 / 拜访记录 / 照片都还在）`
  };
}

// 客户所在批次（档案弹窗用；两层状态模型：批次不持有状态，只列所在批次）
async function getCustomerBatchInfo(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  await ensureBatchColls();
  const members = await fetchAll('batch_members', { customerId }, { batchId: true });
  const bids = members.map(m => m.batchId);
  const res = bids.length ? await fetchAll('customer_batches', {}, {}) : [];
  const bmap = {};
  res.forEach(b => { bmap[b._id] = { name: b.name || '', subtitle: b.subtitle || '', createdAt: b.createdAt || 0 }; });
  return {
    ok: true,
    batches: members
      .map(m => ({ batchId: m.batchId, name: (bmap[m.batchId] || {}).name || '（已删除批次）', subtitle: (bmap[m.batchId] || {}).subtitle || '' }))
      .sort((a, b) => (bmap[b.batchId] || {}).createdAt - (bmap[a.batchId] || {}).createdAt)
  };
}

// 改名/改副标题（副标题=说明，老板可随时改）
async function renameCustomerBatch(event) {
  const { batchId, name, subtitle } = event;
  if (!batchId) return { ok: false, code: 'BAD_ARG', msg: '缺少批次' };
  const b = await db.collection('customer_batches').doc(batchId).get().catch(() => null);
  if (!b || !b.data) return { ok: false, code: 'NOT_FOUND', msg: '批次不存在' };
  const data = {};
  if (name !== undefined && String(name).trim()) data.name = String(name).trim();
  if (subtitle !== undefined) data.subtitle = String(subtitle).trim();
  if (!Object.keys(data).length) return { ok: false, code: 'BAD_ARG', msg: '没有要修改的内容' };
  await db.collection('customer_batches').doc(batchId).update({ data });
  return { ok: true, msg: '已保存' };
}

// 删除批次卡片 = 解散名单（2026-09-07 老板定）：客户档案/拜访/任务全保留，客户回「未分批」
async function deleteCustomerBatch(event) {
  const { batchId } = event;
  if (!batchId) return { ok: false, code: 'BAD_ARG', msg: '缺少批次' };
  const b = await db.collection('customer_batches').doc(batchId).get().catch(() => null);
  if (!b || !b.data) return { ok: false, code: 'NOT_FOUND', msg: '批次不存在' };
  const members = await fetchAll('batch_members', { batchId }, { _id: true, customerId: true });
  // 客户 batchIds 移除该批（曾逐条 doc get+update 串行 200 次往返超时 -601008）：
  // 一次拉全这批复制的 batchIds，内存过滤后并行回写
  const memberIds = [...new Set(members.map(m => m.customerId))];
  const custRows = await fetchAll('customers', { _id: _.in(memberIds) }, { _id: true, batchIds: true });
  await runPool(custRows, 15, async c => {
    if (Array.isArray(c.batchIds) && c.batchIds.includes(batchId)) {
      await db.collection('customers').doc(c._id).update({ data: { batchIds: c.batchIds.filter(x => x !== batchId), updatedAt: Date.now() } });   // 2026-09-27 补：增量同步用
    }
  });
  const BATCH = 50;
  for (let i = 0; i < members.length; i += BATCH) {
    await Promise.all(members.slice(i, i + BATCH).map(m => db.collection('batch_members').doc(m._id).remove()));
  }
  await db.collection('customer_batches').doc(batchId).remove();
  return { ok: true, released: members.length, msg: `批次已删除，${members.length} 家客户回到未分批（档案保留）` };
}

// ===== 一次性数据修复：补 mallCode（2026-09-27 老板定）=====
// 背景：导入脚本原正则只认「单字母+数字」，导致 **AA021 这类两个字母编号**提取失败 → mallCode 留空，
//   后台误判「未加商城」、订单（按 customerCode 匹配）也一直是空的。
// 规则：只处理 **mallCode 为空 且 mallKey 非空** 的客户（有 22 位商城系统 Key = 确实已加入商城）；
//   编号从 nameRaw（原值，形如「AA021 川F水饺店」）开头提取，支持 1~3 个字母。
// 安全：① 只补 mallCode 一个字段；② 提取不到就跳过（留人工核）；③ 幂等（已有编号的直接跳过）；
//   ④ 不传 apply 只预览不写库。
async function backfillMallCode(event) {
  const apply = !!(event && event.apply);
  const CODE_RE = /^([a-zA-Z]{1,3}\d{1,6})[\s　]+/;
  // ⚠️ 2026-09-27 修（本次实测踩到 -601008）：必须**同时**要求"字段存在"和"非空" ——
  //   只写 `{ mallKey: _.neq('') }` 时，MongoDB 语义下 `$ne:''` **会匹配"字段不存在"的文档**，
  //   于是把 6 万家没有 mallKey 字段的点评客户全圈了进来 → fetchAll 61 次串行 → 云函数超时。
  const rows = await fetchAll('customers',
    _.and([{ mallKey: _.exists(true) }, { mallKey: _.neq('') }]),
    { _id: true, name: true, nameRaw: true, mallCode: true, mallKey: true });
  const todo = [];
  rows.forEach((c) => {
    if (String(c.mallCode || '').trim()) return;              // 已有编号 → 跳过
    const t = String(c.nameRaw || c.name || '').trim();
    const m = t.match(CODE_RE);
    if (!m) return;                                           // 提取不到 → 跳过（留人工核）
    todo.push({ _id: c._id, code: m[1], name: t.slice(0, 32) });
  });
  if (!apply) return { ok: true, dryRun: true, scanned: rows.length, todo: todo.length, list: todo };
  let done = 0;
  for (const x of todo) {
    await db.collection('customers').doc(x._id).update({ data: { mallCode: x.code, updatedAt: Date.now() } });
    done++;
  }
  return { ok: true, scanned: rows.length, todo: todo.length, updated: done, list: todo };
}

// 手工建批：从全部客户勾选组成新批次（批内状态一律待回访）
async function createManualBatch(event) {
  const { name, subtitle, customerIds } = event;
  // 2026-09-27 修 -601008 超时：支持"先只建批次、客户随后分批入批"（前端每批 100 家循环调 addCustomersToBatch）。
  //   原因：一次把所有客户逐个写库（每家 4 次 DB 往返）几百家就撞 30s 云函数超时。
  const hasIds = Array.isArray(customerIds) && customerIds.length > 0;
  if (customerIds != null && !hasIds && !Array.isArray(customerIds)) return { ok: false, code: 'BAD_ARG', msg: '客户列表格式不对' };
  await ensureBatchColls();
  let batchName = String(name || '').trim();
  let autoPrefix = '';
  if (!batchName) {
    const gn = await genBatchName();
    batchName = gn.name;
    autoPrefix = gn.prefix;
  }
  const add = await db.collection('customer_batches').add({
    data: { name: batchName, subtitle: String(subtitle || '').trim(), autoNamePrefix: autoPrefix, createdAt: Date.now(), createdBy: event._admin && event._admin.name }
  });
  const uniq = [...new Set(hasIds ? customerIds : [])];
  let ok = 0;
  const BATCH = 50;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const slice = uniq.slice(i, i + BATCH);
    const res = await Promise.all(slice.map(id => addCustomerToBatch(id, add._id)));
    ok += res.filter(Boolean).length;
  }
  const msg = hasIds
    ? `已建批次「${batchName}」，${ok} 家客户入批（初始状态=待回访）`
    : `已建批次「${batchName}」（空批次，客户分批加入中…）`;
  return { ok: true, batchId: add._id, added: ok, empty: !hasIds, msg };
}

// 初始归档（一次性，分片续跑）：建「2026年9月1日第一批导入」，把未分批客户全量入批，
// 批内状态按现有全局状态映射（visited/in_task/todo）
async function archiveInitialBatch(event) {
  await ensureBatchColls();
  const offset = Math.max(0, parseInt(event.offset, 10) || 0);
  const SLICE = 100; // 每片 100 家，防 3 秒超时（前端循环调用直到 done）
  // 找/建归档批次
  let batch = (await db.collection('customer_batches').where({ autoNamePrefix: '2026年9月1日' }).limit(1).get()).data[0];
  if (!batch) {
    const add = await db.collection('customer_batches').add({
      data: { name: '2026年9月1日第一批导入', subtitle: '历史客户初始归档', autoNamePrefix: '2026年9月1日', createdAt: Date.now(), createdBy: event._admin && event._admin.name }
    });
    batch = { _id: add._id };
  }
  const bid = batch._id;
  // 未分批客户（batchIds 空）；两层状态模型：批次不持有状态，纯名单入批
  const all = await fetchAll('customers', {}, { _id: true, batchIds: true, phone: true });
  const todoList = all.filter(c => !Array.isArray(c.batchIds) || !c.batchIds.length);
  const slice = todoList.slice(offset, offset + SLICE);
  for (const c of slice) {
    await addCustomerToBatch(c._id, bid);
  }
  return { ok: true, offset: offset + slice.length, total: todoList.length, done: offset + slice.length >= todoList.length, msg: `归档进度 ${offset + slice.length}/${todoList.length}` };
}

// 按客户清空全部拜访记录（管理员：把客户恢复到「待拜访」，历史一并清空；留痕删除）
async function purgeCustomerVisits(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const cRes = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!cRes || !cRes.data) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  const visits = await fetchAll('visits', { customerId }, { _id: true });
  const BATCH = 50;
  for (let i = 0; i < visits.length; i += BATCH) {
    await Promise.all(visits.slice(i, i + BATCH).map(v => db.collection('visits').doc(v._id).remove()));
  }
  return { ok: true, deleted: visits.length, customerName: cRes.data.name, msg: `已删除 ${visits.length} 条拜访记录，客户回到待拜访` };
}

// ===== 智能排序（§7.11 老板定稿：仓库起点贪心 3 候选 + 腾讯 driving 验真距离） =====
async function getMpKey() {
  const res = await db.collection('settings').where({ key: 'mpKey' }).limit(1).get();
  const v = res.data[0] && res.data[0].value;
  return String(v || 'SQWBZ-K326U-MU3VH-GWUHA-HGNES-S7F2D').trim();
}

// 通用 HTTPS GET JSON（腾讯地图等公网接口；腾讯 WebService Key 配了 localhost 白名单 → 必须带 Referer）
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

async function smartSortDay(event) {
  const { customers, origin, mode } = event;
  if (!Array.isArray(customers) || !customers.length) return { ok: false, code: 'BAD_ARG', msg: '没有客户' };
  const dist = (a, b) => haversine(a.lat, a.lng, b.lat, b.lng);
  const hasCoord = customers.filter(c => c && c.lat && c.lng);
  const noCoord = customers.filter(c => !(c && c.lat && c.lng)); // 无坐标兜底排最后（本期回访均有坐标）
  // 手动模式（2026-09-06 老板定）：按前端给定点击顺序，起点=仓库或第一家（origin 由前端传）
  if (mode === 'manual' && Array.isArray(event.order) && event.order.length) {
    const map = {};
    customers.forEach(c => { map[c.id] = c; });
    const ordered = event.order.map(id => map[id]).filter(Boolean);
    customers.forEach(c => { if (event.order.indexOf(c.id) < 0) ordered.push(c); }); // 遗漏兜底
    const withCoord = ordered.filter(c => c && c.lat && c.lng);
    if (!withCoord.length) {
      return { ok: true, order: ordered.map(c => c.id), distanceMeters: 0, durationMin: 0, fallback: true, msg: '客户均无坐标，保持手动顺序' };
    }
    const start = (origin && origin.lat && origin.lng) ? origin : withCoord[0];
    const key = await getMpKey();
    const URL = 'https://apis.map.qq.com/ws/direction/v1/driving/';
    const from = `${start.lat},${start.lng}`;
    const to = `${withCoord[withCoord.length - 1].lat},${withCoord[withCoord.length - 1].lng}`;
    // 起点=第一家时，途经点不含第一家（起点与途经点重复会报错）
    const wpList = dist(start, withCoord[0]) < 1 ? withCoord.slice(1, -1) : withCoord.slice(0, -1);
    const wp = wpList.map(c => `${c.lat},${c.lng}`).join(';');
    let q = `?from=${from}&to=${to}&key=${encodeURIComponent(key)}&output=json`;
    if (wp) q += `&waypoints=${encodeURIComponent(wp)}`;
    try {
      const r = await httpGetJson(URL + q);
      if (r && r.status === 0 && r.result && r.result.routes && r.result.routes.length) {
        const route = r.result.routes[0];
        return {
          ok: true,
          order: ordered.map(c => c.id),
          distanceMeters: Math.round(route.distance || 0),
          durationMin: Math.max(1, Math.round((route.duration || 60) / 60)),
          polyline: route.polyline || null,
          fallback: false,
          msg: '手动顺序'
        };
      }
    } catch (e) { /* 失败走直线兜底 */ }
    // 直线兜底：按手动顺序连点（起点=仓库或第一家）
    let sum = 0;
    let prev = start;
    withCoord.forEach(c => { sum += dist(prev, c); prev = c; });
    const dm = Math.round(sum);
    return {
      ok: true,
      order: ordered.map(c => c.id),
      distanceMeters: dm,
      durationMin: Math.max(1, Math.round((dm / 1000 / 25) * 60)),
      fallback: true,
      msg: '手动顺序（路线接口失败，直线估算）'
    };
  }
  if (!origin || !origin.lat || !origin.lng) return { ok: false, code: 'BAD_ARG', msg: '缺少起点（仓库坐标）' };
  if (!hasCoord.length) {
    return { ok: true, order: customers.map(c => c.id), distanceMeters: 0, durationMin: 0, fallback: true, msg: '客户均无坐标，保持原顺序' };
  }
  // 第 1 层：贪心候选（起手店=离仓库最近的前 3 家）
  const byOrigin = [...hasCoord].sort((a, b) => dist(origin, a) - dist(origin, b));
  const startPool = byOrigin.slice(0, Math.min(3, byOrigin.length));
  const candidates = [];
  for (const first of startPool) {
    const order = [first];
    let cur = first;
    const pool = hasCoord.filter(c => c !== first);
    while (pool.length) {
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = dist(cur, pool[i]);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      cur = pool[bestIdx];
      order.push(cur);
      pool.splice(bestIdx, 1);
    }
    candidates.push(order);
  }
  // 第 2 层：腾讯 driving 验真（from=仓库, to=最后一家, waypoints=中间店；坐标 lat,lng 纬度在前）
  const key = await getMpKey();
  const URL = 'https://apis.map.qq.com/ws/direction/v1/driving/';
  let best = null;
  for (const order of candidates) {
    try {
      const from = `${origin.lat},${origin.lng}`;
      const to = `${order[order.length - 1].lat},${order[order.length - 1].lng}`;
      // 起点=第一家时，途经点不含第一家（起点与途经点重复会报错）
      const wpList = dist(origin, order[0]) < 1 ? order.slice(1, -1) : order.slice(0, -1);
      const wp = wpList.map(c => `${c.lat},${c.lng}`).join(';');
      let q = `?from=${from}&to=${to}&key=${encodeURIComponent(key)}&output=json`;
      if (wp) q += `&waypoints=${encodeURIComponent(wp)}`;
      const r = await httpGetJson(URL + q);
      if (r && r.status === 0 && r.result && r.result.routes && r.result.routes.length) {
        const route = r.result.routes[0];
        const dm = Math.round(route.distance || 0);
        const du = Math.max(1, Math.round((route.duration || 60) / 60));
        if (!best || dm < best.distanceMeters) {
          best = { order: order.map(c => c.id), distanceMeters: dm, durationMin: du, polyline: route.polyline || null };
        }
      }
    } catch (e) { /* 单候选失败继续下一个 */ }
  }
  if (!best) {
    // 全部失败：回退直线距离贪心第一候选
    const first = candidates[0];
    let sum = 0;
    for (let i = 0; i < first.length; i++) {
      const a = i === 0 ? origin : first[i - 1];
      sum += dist(a, first[i]);
    }
    const dm = Math.round(sum);
    return {
      ok: true,
      order: [...first.map(c => c.id), ...noCoord.map(c => c.id)],
      distanceMeters: dm,
      durationMin: Math.max(1, Math.round((dm / 1000 / 25) * 60)),
      fallback: true,
      msg: '路线接口调用失败，已按直线距离排序'
    };
  }
  return {
    ok: true,
    order: [...best.order, ...noCoord.map(c => c.id)],
    distanceMeters: best.distanceMeters,
    durationMin: best.durationMin,
    polyline: best.polyline || null, // 真实道路轨迹（差分压缩数组，前端解压；null=无轨迹走直线）
    fallback: false,
    msg: '智能排序完成'
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// 坐标距离（米）
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
