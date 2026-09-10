// 管理后台 API（HTTP 访问服务入口）
// 鉴权：开发期使用账号+密码逐次校验（sha256 比对），上线前升级为 token 会话
// 模板：服务单提醒 tCQ_Xi5OaMQ9t9-UX9NeEZ4Tv4nHJ-L1PAEVWOdDhxs
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const TEMPLATE_ID = 'tCQ_Xi5OaMQ9t9-UX9NeEZ4Tv4nHJ-L1PAEVWOdDhxs';
// 老板手机号（2026-09-09 老板定：谁用这个号码注册谁就是老板；老板账号后台不可停用/不可关老板模式/不可删除）
const BOSS_PHONE = '15055492888';
// 服务号（公众号）模板消息：业务员关注服务号一次 → 永久免授权收新任务提醒（2026-09-04 老板定稿 §7.6）
const MP_API = 'https://api.weixin.qq.com';
const ACTIONS = ['login', 'listTasks', 'getTask', 'createTask', 'editTask', 'rescheduleTask', 'listLatestLocations', 'getDayTrack', 'getVisitTrack', 'uploadAdminDist', 'extendTask', 'reassignTask', 'withdrawTask', 'deleteTask', 'sendTask', 'listCustomers', 'importCustomers', 'importMallCustomers', 'runMallMatch', 'listMallLibrary', 'applyMallMatch', 'listMallClaims', 'resolveMallClaim', 'listCustomerVisits', 'reviewFinishRequest', 'getLastMallImport', 'listSalesmen', 'listAdmins', 'addSalesman', 'addAdmin', 'setUserActive', 'deleteUser', 'getSettings', 'setSetting', 'setMpOpenid', 'testMpSend', 'mpTokenPush', 'cancelOngoing', 'purgeCancelled', 'purgeCustomerVisits', 'listCoordFixes', 'reviewCoordFix', 'smartSortDay', 'resetTestData', 'listCustomerBatches', 'getCustomerBatchInfo', 'renameCustomerBatch', 'deleteCustomerBatch', 'createManualBatch', 'archiveInitialBatch', 'removeCustomerFromBatch', 'addCustomersToBatch', 'getTempFileURL', 'autoArchiveExpired', 'updateCustomerRemark', 'purgeUnbatchedCustomers', 'listRegistrations', 'reviewRegistration', 'setUserBoss', 'ping'];

exports.main = async (event) => {
  const action = (event && event.action) || 'login';

  // 定时触发器入口（2026-09-08 M1：拜访时长上限动态闹钟，每 10 分钟 cron 调一次，免管理员鉴权）
  if (event && (event.TriggerName || event.Type === 'Timer')) {
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
    if (action === 'importCustomers') return await importCustomers(event);
    if (action === 'importMallCustomers') return await importMallCustomers(event);
    if (action === 'runMallMatch') return await runMallMatch(event);
    if (action === 'listMallLibrary') return await listMallLibrary(event);
    if (action === 'applyMallMatch') return await applyMallMatch(event);
    if (action === 'listMallClaims') return await listMallClaims(event);
    if (action === 'resolveMallClaim') return await resolveMallClaim(event);
    if (action === 'listCustomerVisits') return await listCustomerVisits(event);
    if (action === 'reviewFinishRequest') return await reviewFinishRequest(event);
    if (action === 'getLastMallImport') return await getLastMallImport(event);
    if (action === 'listSalesmen') return await listSalesmen(event);
    if (action === 'listAdmins') return await listAdmins(event);
    if (action === 'setUserBoss') return await setUserBoss(event);
    if (action === 'addSalesman') return await addSalesman(event);
    if (action === 'addAdmin') return await addAdmin(event);
    if (action === 'setUserActive') return await setUserActive(event);
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
    if (action === 'smartSortDay') return await smartSortDay(event);
    if (action === 'resetTestData') return await resetTestData(event);
    if (action === 'listCustomerBatches') return await listCustomerBatches(event);
    if (action === 'getCustomerBatchInfo') return await getCustomerBatchInfo(event);
    if (action === 'renameCustomerBatch') return await renameCustomerBatch(event);
    if (action === 'deleteCustomerBatch') return await deleteCustomerBatch(event);
    if (action === 'createManualBatch') return await createManualBatch(event);
    if (action === 'archiveInitialBatch') return await archiveInitialBatch(event);
    if (action === 'removeCustomerFromBatch') return await removeCustomerFromBatch(event);
    if (action === 'addCustomersToBatch') return await addCustomersToBatch(event);
    if (action === 'getTempFileURL') return await getTempFileURL(event);
    if (action === 'autoArchiveExpired') return await autoArchiveExpired(event);
    if (action === 'updateCustomerRemark') return await updateCustomerRemark(event);
    if (action === 'purgeUnbatchedCustomers') return await purgeUnbatchedCustomers(event);
    if (action === 'ping') return { ok: true, pong: Date.now() };
    return { ok: true, pong: Date.now() };
  } catch (e) {
    return { ok: false, code: 'ERROR', msg: e.message || '服务异常' };
  }
};

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

// 过期任务自动归档（2026-09-08 老板定：自然完成的进历史；过期达设置档位天数的自动归档终态）
// 档位 settings.expireArchiveDays：2/3/5 天（默认 3）；后台 15 秒轮询静默触发（幂等）
// ===== 拜访时长上限 · 动态闹钟（2026-09-08 M1 老板定） =====
// 每 10 分钟定时触发（cron 配置在云开发控制台，见部署说明）：
// ① remindAt 到点且未提醒 → 服务号提醒一次（标记 remindSentAt 防重复）
// ② autoCancelAt 到点 → 双态：有草稿结果→自动提交（跳过距离、无照片录音）；无→自动取消；均写任务 logs + 服务号告知
async function visitTimeoutTick() {
  const now = Date.now();
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
        await db.collection('tasks').doc(v.taskId).update({ data: { logs } });
        await notify().catch(() => {});
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
  if (!salesRes || !salesRes.data || salesRes.data.role !== 'salesman') {
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
  if (!sm || sm.role !== 'salesman' || sm.active === false) return { ok: false, code: 'BAD_SALESMAN', msg: '业务员不存在或已停用' };
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
  await ensureBatchColls();
  const { batchId } = event || {};
  const all = await fetchAll('customers', {}, {}); // 全量（含 batchIds；批次模式按成员过滤）
  let rows = all;
  if (batchId) {
    const members = await fetchAll('batch_members', { batchId }, { customerId: true });
    const set = new Set(members.map(m => m.customerId));
    rows = all.filter(c => set.has(c._id));
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const ids = rows.map(c => c._id);
  // 两层状态模型（2026-09-07 老板定稿）：全局状态=任务中/无任务（实时推导，跨批次统一）；
  // 任务内状态（待回访/拜访中/已回访）按客户当前所在任务推导（2026-09-08 弹窗显示用）。
  // 另附 visitCount（全局拜访次数）与 lastVisitAt（最近拜访日期）
  const stateMap = {};
  const taskMap = {};     // customerId -> 当前任务 taskId（published/reviewing 中任选一个）
  const lastVisitMap = {};
  const countMap = {};
  const today = todayStr();
  const vAll = await fetchAll('visits', {}, { customerId: true, taskId: true, status: true, visitedAt: true });
  vAll.forEach(v => {
    if (v.status !== 'normal' && v.status !== 'pending_review') return;
    countMap[v.customerId] = (countMap[v.customerId] || 0) + 1;
    if (!lastVisitMap[v.customerId] || String(v.visitedAt || '') > String(lastVisitMap[v.customerId])) {
      lastVisitMap[v.customerId] = v.visitedAt || '';
    }
  });
  const tAll = await fetchAll('tasks', {}, { customerIds: true, status: true });
  tAll.forEach(t => {
    if (t.status !== 'published' && t.status !== 'reviewing') return;
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
  // 坐标审核中标记
  const fixSet = {};
  if (ids.length) {
    const fx = await fetchAll('coord_fix_requests', {}, { customerId: true, status: true });
    fx.forEach(f => { if (f.status === 'pending') fixSet[f.customerId] = true; });
  }
  return {
    ok: true,
    customers: rows.map(c => ({
      _id: c._id, name: c.name, customerType: c.customerType, address: c.address,
      phone: c.phone, phone2: c.phone2 || '', lat: c.lat, lng: c.lng, coord_status: c.coord_status,
      mallJoinedAt: c.mallJoinedAt || null,
      lastOrderAt: c.lastOrderAt || '', lastBrowseAt: c.lastBrowseAt || '',
      mallSalesman: c.mallSalesman || '', mallLevel: c.mallLevel || '',
      status: c.status,
      region: c.region || '',
      batchIds: Array.isArray(c.batchIds) ? c.batchIds : [],
      remark: c.remark || '',
      coordFixPending: !!fixSet[c._id],
      visitState: stateMap[c._id] || 'free', // 全局状态：in_task 任务中 / free 无任务
      visitStatus: stateMap[c._id] === 'in_task' ? (taskDoneSet.has(c._id) ? 'visited' : (taskOngSet.has(c._id) ? 'ongoing' : 'pending')) : '', // 任务内三态（仅任务中）
      visitCount: countMap[c._id] || 0, // 全局拜访次数
      lastVisitAt: lastVisitMap[c._id] || ''
    }))
  };
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
  const pool = (await fetchAll('customers', {}, { _id: true, name: true, phone: true, address: true, region: true })).map(p => normPoolEntry(p));

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
        createdAt: now
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
  const STATIC_FIELDS = ['name', 'region', 'address', 'phone', 'tags', 'category', 'salesman', 'source', 'level'];
  const toAdd = [];
  const toUpdate = [];
  customers.forEach(c => {
    const key = String(c.mallKey || '').trim();
    const doc = {
      mallKey: key, name: String(c.name || '').trim(), region: String(c.region || '').trim(),
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

// 独立比对认领（2026-09-08 批次化：batchId 存在=仅比对/认领该批次成员；缺省=全量回访客户）
async function runMallMatch(event) {
  const { fileName, batchId } = event || {};
  const now = Date.now();
  try { await db.createCollection('mall_customers'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('mall_claims'); } catch (e) { /* 已存在 */ }
  try { await db.createCollection('import_batches'); } catch (e) { /* 已存在 */ }

  // 回访客户与商城库比对（电话→名称→地址，三档）；批次模式只取该批次成员
  let visitCusts;
  if (batchId) {
    const members = await fetchAll('batch_members', { batchId }, { customerId: true });
    const ids = members.map(m => m.customerId);
    visitCusts = ids.length ? await fetchAll('customers', { _id: _.in(ids), customerType: 'mall' }, { phone: true, phone2: true, name: true, address: true, mallKey: true, lastOrderAt: true, lastBrowseAt: true, mallJoinedAt: true, mallSource: true, mallLevel: true, mallSalesman: true }) : [];
  } else {
    visitCusts = await fetchAll('customers', { customerType: 'mall' }, { phone: true, phone2: true, name: true, address: true, mallKey: true, lastOrderAt: true, lastBrowseAt: true, mallJoinedAt: true, mallSource: true, mallLevel: true, mallSalesman: true });
  }
  const mallAll = await fetchAll('mall_customers', {}, { phone: true, name: true, address: true, mallKey: true, addedAt: true, lastOrderAt: true, lastBrowseAt: true, source: true, level: true, salesman: true });
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
      autoUpdates.push({
        v,
        data: {
          mallKey: m.mallKey,
          mallJoinedAt: m.addedAt || '',
          lastOrderAt: m.lastOrderAt || '',
          lastBrowseAt: m.lastBrowseAt || '',
          mallSource: m.source || '',
          mallLevel: m.level || '',
          mallSalesman: m.salesman || '',
          mallMatchScore: best.score,
          mallMatchedAt: now
        }
      });
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
  // 认领写入策略：未认领→全量写入；同一 mallKey→仅动态字段刷新（静态字段 diff 才写）；换人→全量更新
  const MALL_STATIC = ['mallKey', 'mallJoinedAt', 'mallSource', 'mallLevel', 'mallSalesman'];
  const BATCH = 50;
  for (let i = 0; i < autoUpdates.length; i += BATCH) {
    await Promise.all(autoUpdates.slice(i, i + BATCH).map(async ({ v, data }) => {
      const oldMallKey = v.mallKey || '';
      if (!oldMallKey) {
        await db.collection('customers').doc(v._id).update({ data });
        return;
      }
      if (oldMallKey === data.mallKey) {
        const upd = {};
        if (String(v.lastOrderAt || '') !== data.lastOrderAt) upd.lastOrderAt = data.lastOrderAt;
        if (String(v.lastBrowseAt || '') !== data.lastBrowseAt) upd.lastBrowseAt = data.lastBrowseAt;
        MALL_STATIC.forEach(f => { if (String(v[f] || '') !== String(data[f] || '')) upd[f] = data[f]; });
        if (Object.keys(upd).length) {
          if (upd.lastOrderAt || upd.lastBrowseAt) dynamicRefreshed++;
          await db.collection('customers').doc(v._id).update({ data: upd });
        }
      } else {
        staticChangedCnt++;
        await db.collection('customers').doc(v._id).update({ data });
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
  const malls = await fetchAll('mall_customers', {}, { phone: true, name: true, address: true, mallKey: true, addedAt: true, lastOrderAt: true, lastBrowseAt: true, source: true, level: true, salesman: true });
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
    const custRows = await fetchAll('customers', { _id: _.in(ids) }, { mallKey: true, lastOrderAt: true, lastBrowseAt: true, mallJoinedAt: true, mallSource: true, mallLevel: true, mallSalesman: true });
    const cMap = {};
    custRows.forEach(c => { cMap[c._id] = c; });
    const MALL_STATIC = ['mallKey', 'mallJoinedAt', 'mallSource', 'mallLevel', 'mallSalesman'];
    await runPool(claimList, 15, async ({ customerId, mall, score }) => {
      const v = cMap[customerId];
      if (!v) return;
      const data = {
        mallKey: mall.mallKey,
        mallJoinedAt: mall.addedAt || '',
        lastOrderAt: mall.lastOrderAt || '',
        lastBrowseAt: mall.lastBrowseAt || '',
        mallSource: mall.source || '',
        mallLevel: mall.level || '',
        mallSalesman: mall.salesman || '',
        mallMatchScore: Number(score) || 0,
        mallMatchedAt: now
      };
      autoMatched++;
      const oldMallKey = v.mallKey || '';
      if (!oldMallKey) { await db.collection('customers').doc(customerId).update({ data }); return; }
      if (oldMallKey === data.mallKey) {
        const upd = {};
        if (String(v.lastOrderAt || '') !== data.lastOrderAt) upd.lastOrderAt = data.lastOrderAt;
        if (String(v.lastBrowseAt || '') !== data.lastBrowseAt) upd.lastBrowseAt = data.lastBrowseAt;
        MALL_STATIC.forEach(f => { if (String(v[f] || '') !== String(data[f] || '')) upd[f] = data[f]; });
        if (Object.keys(upd).length) {
          if (upd.lastOrderAt || upd.lastBrowseAt) dynamicRefreshed++;
          await db.collection('customers').doc(customerId).update({ data: upd });
        }
      } else {
        staticChangedCnt++;
        await db.collection('customers').doc(customerId).update({ data });
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
      audio: v.audio || null
    }))
  };
}

// 客户备注（2026-09-08 老板定：后台客户详情弹窗编辑，业务员手机端「管理员备注」卡显示；≤500 字）
async function updateCustomerRemark(event) {
  const { customerId } = event;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  const remark = String(event.remark || '').trim().slice(0, 500);
  const c = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!c || !c.data) return { ok: false, code: 'NOT_FOUND', msg: '客户不存在' };
  await db.collection('customers').doc(customerId).update({ data: { remark } });
  return { ok: true, remark, msg: remark ? '备注已保存，业务员手机端可见 ✓' : '备注已清空' };
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
  const res = await db.collection('users').where({ role: 'salesman' }).orderBy('createdAt', 'asc').get();
  // 进行中/审核中的业务员（有任务不可再被选；done 后可重新派发）
  const tRes = await db.collection('tasks').where({ status: _.in(['published', 'reviewing']) }).field({ salesmanId: true }).limit(100).get();
  const busy = {};
  tRes.data.forEach(t => { busy[t.salesmanId] = true; });
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
      hasTask: !!busy[s._id], active: s.active !== false,
      bound: !!s.openid,
      trial: !!s.trial,
      mpBound: !!(s.mpOpenid),
      mpOpenidMask: s.mpOpenid ? String(s.mpOpenid).slice(0, 8) + '…' + String(s.mpOpenid).slice(-6) : '',
      lastLoginAt: s.lastLoginAt || 0,
      loc: locMap[s._id] || null,
      todayCount: todayMap[s._id] || 0
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
      phone: a.phone || '', lastLoginAt: a.lastLoginAt || 0
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

// ===== 注册审核（2026-09-09 老板拍板：登录改「注册→后台审核→通过后免登进入」） =====
// 待审核申请 + 最近 20 条已处理（通过/拒绝）留痕
async function listRegistrations(event) {
  const pend = await db.collection('registrations').where({ status: 'pending' }).orderBy('createdAt', 'desc').limit(100).get();
  const done = await db.collection('registrations').where({ status: _.in(['approved', 'rejected']) }).orderBy('reviewedAt', 'desc').limit(20).get();
  const fmt = r => ({
    _id: r._id, name: r.name || '', phone: r.phone || '', status: r.status,
    reason: r.reason || '', createdAt: r.createdAt || 0, reviewedAt: r.reviewedAt || 0,
    phoneVerified: !!r.phoneVerified, // 2026-09-09 老板定：微信一键验证标记，后台审核可见
    openidMask: r.openid ? String(r.openid).slice(0, 8) + '…' + String(r.openid).slice(-4) : ''
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
  if (act === 'reject') {
    await rRef.update({ data: { status: 'rejected', reason: String(reason || '').slice(0, 100), reviewedAt: Date.now() } });
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
  await rRef.update({ data: { status: 'approved', reviewedAt: Date.now(), userId: boundId } });
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
  return { ok: true, settings: map };
}

async function setSetting(event) {
  const { key, value } = event;
  if (!key) return { ok: false, code: 'BAD_ARG', msg: '缺少设置项 key' };
  // 仅允许写入已知设置项（防任意写入）
  const ALLOWED = ['locationCheck', 'locRefreshInterval', 'locKeyRefreshInterval', 'recordingDurationLimit', 'visitDurationLimit', 'expireArchiveDays', 'globalRefreshInterval', 'compareWindowDays', 'dailyVisitLimit', 'phoneVisibility', 'autoApproveFinish', 'mpConfig', 'taskRegionCode', 'mpKey', 'workStartHour', 'workEndHour', 'offDutyTier', 'trackKeepDays', 'welcomeConfig'];
  if (!ALLOWED.includes(key)) return { ok: false, code: 'BAD_KEY', msg: '未知设置项' };
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
    // 非工作时段四档（2026-09-08 M2）：5S/30S / 10S/60S / 20S/120S / 30S/180S，默认 10_60
    v = ['5_30', '10_60', '20_120', '30_180'].includes(String(value)) ? String(value) : '10_60';
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
  if (!u || u.role !== 'salesman') return { ok: false, code: 'NOT_FOUND', msg: '业务员不存在' };
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
      .where({ customerId: event.customerId, status: _.in(['pending', 'confirmed', 'rejected']) })
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
    .where({ status: 'pending' })
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
    // 同意（2026-09-06 老板新口径）：**不写回客户坐标**——客户原坐标保持不变，
    // 仅将客户坐标状态标记为「待确定」；业务员上报坐标暂存在本申请记录里，后台点「待确定」弹窗查看
    await db.collection('customers').doc(f.customerId).update({
      data: { coord_status: 'pending_confirm', coordFixReviewedAt: now }
    });
    await db.collection('coord_fix_requests').doc(fixId).update({
      data: { status: 'confirmed', reviewedAt: now, reviewedBy: (event._admin && event._admin.name) || '' }
    });
    return { ok: true, decision: 'confirmed', msg: '已审核：客户坐标标记为「待确定」，原坐标保持不变' };
  }
  await db.collection('coord_fix_requests').doc(fixId).update({
    data: { status: 'rejected', reviewedAt: now, reviewedBy: (event._admin && event._admin.name) || '' }
  });
  return { ok: true, decision: 'rejected', msg: '已拒绝，客户坐标不变（业务员可再次报错）' };
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
      data: { reviewFlag: false, coord_status: hasCoord ? 'ok' : 'pending' }
    });
  });
  stats.customers_reset = cs.length;
  return {
    ok: true,
    stats,
    msg: `测试数据已重置：任务/拜访/报错/认领/批次已清空，照片与录音文件已删除 ${deletedFiles} 个（引用到 ${fidList.length} 个），客户状态归零（档案与设置保留）`
  };
}

// ===================== 客户批次管理（2026-09-07 老板定稿，方案见交接文档 §7.12） =====================
const BATCH_COLLS = ['customer_batches', 'batch_members'];

async function ensureBatchColls() {
  for (const c of BATCH_COLLS) {
    try { await db.createCollection(c); } catch (e) { /* 已存在 */ }
  }
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
    await db.collection('customers').doc(customerId).update({ data: { batchIds: ids } });
  }
  return true;
}

// 批次卡片列表 + 实时统计（两层状态模型：任务中/无任务；不存冗余，按全局推导内存分组）+ 未分批客户数
async function listCustomerBatches(event) {
  await ensureBatchColls();
  const batches = await fetchAll('customer_batches', {}, {});
  const members = await fetchAll('batch_members', {}, { batchId: true, customerId: true });
  // 全局任务中集合（published/reviewing 任务的客户）
  const inTaskSet = new Set();
  const tAll = await fetchAll('tasks', {}, { customerIds: true, status: true });
  tAll.forEach(t => {
    if (t.status !== 'published' && t.status !== 'reviewing') return;
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
  const all = await fetchAll('customers', {}, { _id: true, batchIds: true });
  const batched = all.filter(c => Array.isArray(c.batchIds) && c.batchIds.length);
  const unbatched = all.length - batched.length;
  // 全部批次汇总（2026-09-09 老板定：顶部工具卡统计区；客户级去重——客户可属多个批次，Σ 各批 stats 会重复计数）
  // 口径与批次卡一致：in_task=当前有 published/reviewing 任务的客户；free=非任务中；visited=有正常拜访记录的客户
  const summary = {
    total: batched.length,
    in_task: batched.filter(c => inTaskSet.has(c._id)).length,
    free: batched.filter(c => !inTaskSet.has(c._id)).length,
    visited: batched.filter(c => visitedSet.has(c._id)).length
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
    await db.collection('customers').doc(customerId).update({ data: { batchIds: c.data.batchIds.filter(x => x !== batchId) } });
  }
  return { ok: true, msg: '已从批次中移除（客户档案保留）' };
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
      await db.collection('customers').doc(c._id).update({ data: { batchIds: c.batchIds.filter(x => x !== batchId) } });
    }
  });
  const BATCH = 50;
  for (let i = 0; i < members.length; i += BATCH) {
    await Promise.all(members.slice(i, i + BATCH).map(m => db.collection('batch_members').doc(m._id).remove()));
  }
  await db.collection('customer_batches').doc(batchId).remove();
  return { ok: true, released: members.length, msg: `批次已删除，${members.length} 家客户回到未分批（档案保留）` };
}

// 手工建批：从全部客户勾选组成新批次（批内状态一律待回访）
async function createManualBatch(event) {
  const { name, subtitle, customerIds } = event;
  if (!Array.isArray(customerIds) || !customerIds.length) return { ok: false, code: 'BAD_ARG', msg: '请至少勾选一家客户' };
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
  const uniq = [...new Set(customerIds)];
  let ok = 0;
  const BATCH = 50;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const slice = uniq.slice(i, i + BATCH);
    const res = await Promise.all(slice.map(id => addCustomerToBatch(id, add._id)));
    ok += res.filter(Boolean).length;
  }
  return { ok: true, batchId: add._id, added: ok, msg: `已建批次「${batchName}」，${ok} 家客户入批（初始状态=待回访）` };
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
