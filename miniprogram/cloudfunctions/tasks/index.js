// 云函数 tasks：业务员任务列表 / 任务详情（含客户与拜访状态）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, taskId } = event || {};

  const me = await db.collection('users').where({ openid: OPENID }).get();
  if (!me.data.length) return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  const meDoc = me.data[0];
  // 老板模式（2026-09-09 §7.13 修订：仅 boss===true 的指定管理员账号启用老板页面，其余管理员不启用）
  // 2026-09-09 老板定：手机号=15055492888 即老板本人（注册时已打 boss 标，phone 兜底防字段缺失）
  // 2026-09-09 开发者范宇琨双身份：dev 白名单（13067737286）且请求带 boss 标志 → 按老板处理（全量只读+虚拟写）
  const isBoss = (['super_admin', 'admin'].includes(meDoc.role) && (meDoc.boss === true || meDoc.phone === '15055492888'))
    || (meDoc.phone === '13067737286' && event && event.boss === true);
  const salesmanId = meDoc._id;

  if (action === 'list') return await list(salesmanId, isBoss);
  if (action === 'detail') return await detail(salesmanId, taskId, isBoss);
  if (action === 'mapData') return await mapData(salesmanId, taskId, isBoss); // 2026-09-09 提速 B：地图轻量接口
  if (action === 'finish') return await finish(salesmanId, taskId, meDoc, isBoss);
  if (action === 'subStatus') return await subStatus(salesmanId, isBoss);
  if (action === 'reviewStatus') return await reviewStatus(salesmanId, isBoss);
  if (action === 'replanDay') return await replanDay(salesmanId, event, isBoss);
  if (action === 'bossBoard') return await bossBoard(salesmanId, isBoss);
  if (action === 'bossWar') return await bossWar(isBoss);
  if (action === 'bossTrack') return await bossTrack(isBoss, event); // 老板手机端：业务员今日轨迹
  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' };
};

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
    db.collection('users').where({ role: 'salesman', active: true, trial: _.neq(true) }).field({ _id: true }).get()
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
    db.collection('users').where({ role: 'salesman', active: true, trial: _.neq(true) }).field({ name: true, phone: true }).get(),
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

// 2026-09-09 提速（C 方案）：8 项系统配置一次并行取齐（原 detail 串行 8 次查询）
async function loadSettings() {
  const one = async key => {
    const r = await db.collection('settings').where({ key }).limit(1).get();
    return r.data[0] ? r.data[0].value : undefined;
  };
  const [lc, lr, lkr, rec, vd, ws, we, od] = await Promise.all([
    one('locationCheck'), one('locRefreshInterval'), one('locKeyRefreshInterval'),
    one('recordingDurationLimit'), one('visitDurationLimit'), one('workStartHour'),
    one('workEndHour'), one('offDutyTier')
  ]);
  const locCfg = lc || { enabled: true, threshold: 100 };
  const lrVal = Number(lr) || 30;
  const locRefresh = [30, 45, 60].includes(lrVal) ? lrVal : 30;
  const lkrVal = Number(lkr) || 15;
  const locKeyRefresh = [8, 12, 15, 20].includes(lkrVal) ? lkrVal : 15;
  const recVal = Number(rec) || 300;
  const recordingDurationLimit = [180, 300, 600].includes(recVal) ? recVal : 300;
  const vdVal = Number(vd) || 3600;
  const visitDurationLimit = [1800, 3600, 7200].includes(vdVal) ? vdVal : 3600;
  const workStartHour = Number.isInteger(Number(ws)) ? Number(ws) : 7;
  const workEndHour = Number.isInteger(Number(we)) ? Number(we) : 20;
  const offDutyTier = ['5_30', '10_60', '20_120', '30_180'].includes(String(od)) ? String(od) : '10_60';
  return { locCfg, locRefresh, locKeyRefresh, recordingDurationLimit, visitDurationLimit, workStartHour, workEndHour, offDutyTier };
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
    workStartHour: cfgP.workStartHour, workEndHour: cfgP.workEndHour, offDutyTier: cfgP.offDutyTier
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
    // 第 2 层：腾讯 driving 验真（from=我的位置；失败换下个候选）
    const key = await getMpKey();
    const URL = 'https://apis.map.qq.com/ws/direction/v1/driving/';
    let best = null;
    for (const ord of candidates) {
      try {
        const from = `${origin.lat},${origin.lng}`;
        const to = `${ord[ord.length - 1].lat},${ord[ord.length - 1].lng}`;
        const wpList = dist(origin, ord[0]) < 1 ? ord.slice(1, -1) : ord.slice(0, -1);
        const wp = wpList.map(c => `${c.lat},${c.lng}`).join(';');
        let q = `?from=${from}&to=${to}&key=${encodeURIComponent(key)}&output=json`;
        if (wp) q += `&waypoints=${encodeURIComponent(wp)}`;
        const r = await httpGetJson(URL + q);
        if (r && r.status === 0 && r.result && r.result.routes && r.result.routes.length) {
          const route = r.result.routes[0];
          const d = Math.round(route.distance || 0);
          if (!best || d < best.distanceMeters) {
            best = {
              order: ord.map(c => c._id),
              distanceMeters: d,
              durationMin: Math.max(1, Math.round((route.duration || 60) / 60)),
              polyline: route.polyline || null
            };
          }
        }
      } catch (e) { /* 单候选失败继续 */ }
    }
    if (best) {
      newOrder = best.order;
      dm = best.distanceMeters;
      durationMin = best.durationMin;
      pts = (Array.isArray(best.polyline) && best.polyline.length >= 4) ? decodePolyline(best.polyline) : null;
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

// 腾讯 WebService Key（后台可配；默认内置）
async function getMpKey() {
  const res = await db.collection('settings').where({ key: 'mpKey' }).limit(1).get();
  const v = res.data[0] && res.data[0].value;
  return String(v || 'SQWBZ-K326U-MU3VH-GWUHA-HGNES-S7F2D').trim();
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

// 直线兜底折线：起点=我的位置 → 按新序逐店（[lat,lng]，纬度在前）
function fallbackPts(start, ordered, ids) {
  const map = {};
  ordered.forEach(c => { map[c._id] = c; });
  const pts = [[start.lat, start.lng]];
  ids.forEach(id => { if (map[id]) pts.push([map[id].lat, map[id].lng]); });
  return pts.length >= 2 ? pts : null;
}

// 球面距离（米）——与 adminapi/前端口径一致
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
