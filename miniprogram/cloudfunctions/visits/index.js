// 云函数 visits：提交拜访记录 / 客户拜访历史
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


// ⭐ 2026-10-07 老板定改名：「不愿改」→「已有供应商」、「联系不上」→「关门·休息中」
//   ⚠️ 三处必须**同时**改（漏一处就坏）：本文件 + 前端 pages/visit/visit.js 的 MALL/PRAISE + 后台 admin/admin.html 的 RESULT_PILL
const RESULT_ENUM_MALL = ['正常回访', '加入商城', '已下单', '需要样品', '已有供应商', '有抵触', '关门·休息中', '闭店·搬迁', '换老板了', '其他'];   // ⭐ 2026-10-11 老板定：加「换老板了」「正常回访」；当天再定顺序：**正常回访第 1、需要样品第 4**（与 visit.js 的 MALL 逐字一致）
const RESULT_ENUM_NEW = [...RESULT_ENUM_MALL, '已签约商城', '未签约'];

// ===== 2026-09-11 批 3：云调用用量自建统计（与 adminapi 写同一份 settings.usageCounter；攒批落库）=====
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
  const { action } = event || {};

  const me = await db.collection('users').where({ openid: OPENID }).get();
  // 2026-09-28：同一 openid 可能**同时绑「实习(trial)」与正式账号**（开发者点「以游客身份进入」）。
  //   默认正式优先（显式定序，消除 data[0] 的随机）；请求带 asTrial → trial 账号排最前。
  // ⭐⭐ 2026-09-28 晚修【重大错误】：**实习声明优先于 openid 认人**
  //   背景：开发者（范宇琨）的微信 openid 早就绑了**正式业务员账号**；而「实习体验入口」按老板口径
  //   **不绑定 openid**。原来只在「openid 查不到人」时才拿 trialId 核对 →
  //   他点实习进来时 openid 查到了正式账号 → **认成业务员**（老板报的正是这个）。
  //   现在：声明实习(asTrial) 且带 trialId → **先**拿 trialId 核对（role=salesman + trial=true），
  //   核对通过就直接用它，不再看 openid 绑的是谁。⚠️ 只信库里的数据。
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
  const meUser = me.data[0];
  // 老板模式（2026-09-10 老板定：管理员模式与老板模式合并——管理员（super_admin/admin）一律按老板处理，
  // 不再看 boss 白名单字段；手机号=15055492888 为老板本人，字段保留仅作历史兜底）
  // 2026-09-09 开发者范宇琨双身份：dev 白名单（13067737286）且请求带 boss 标志 → 按老板处理（写操作全虚拟）
  // ⭐ 2026-09-30：**老板兼业务员**（alsoSalesman）声明「以业务员身份进入」→ 按业务员认人（同 tasks 口径）
  const asSalesman = !!(event && (event.asSalesman === true || event.asSalesman === 'true')) && meUser.alsoSalesman === true;
  const isBoss = !asSalesman && (['super_admin', 'admin'].includes(meUser.role)
    || (meUser.phone === '13067737286' && event && event.boss === true));

  if (action === 'submit') return await submit(meUser, event, isBoss);
  if (action === 'start') return await start(meUser, event, isBoss);
  if (action === 'saveDraft') return await saveDraft(meUser, event, isBoss);
  if (action === 'reportLocation') return await reportLocation(meUser, event, isBoss);
  if (action === 'reportTrack') return await reportTrack(meUser, event, isBoss);
  if (action === 'cancel') return await cancelVisit(meUser, event, isBoss);
  if (action === 'history') return await history(meUser, event.customerId, isBoss);
  if (action === 'editSubmitted') return await editSubmitted(meUser, event, isBoss);   // ⭐ 2026-10-10：编辑已提交的拜访记录
  if (action === 'mystats') return await mystats(meUser, isBoss);
  if (action === 'saveTrText') return await saveTrText(meUser, event, isBoss);
  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' };
};

// 2026-09-11 老板定：转写文字可人工修订（改错别字）—— 存 visits.trEdited，history 优先返回人工版
async function saveTrText(user, e, isBoss) {
  const visitId = String(e.visitId || '');
  if (!visitId) return { ok: false, code: 'BAD_ARG', msg: '缺少拜访 ID' };
  const text = String(e.text == null ? '' : e.text).slice(0, 20000);
  const vr = await db.collection('visits').doc(visitId).get().catch(() => null);
  const v = vr && vr.data;
  if (!v) return { ok: false, code: 'NOT_FOUND', msg: '拜访记录不存在' };
  if (!isBoss && v.salesmanId !== user._id) return { ok: false, code: 'FORBIDDEN', msg: '只能修改自己的拜访记录' };
  if (isBoss) return { ok: true, boss: true, msg: '已保存 ✓（演示：未保存）' };
  await db.collection('visits').doc(visitId).update({
    data: { trEdited: { text, by: user.name || '', byId: user._id || '', at: Date.now() } }
  });
  return { ok: true, text, editedAt: Date.now(), msg: '已保存' };
}

// ⭐ 2026-10-03 自由拜访：以**真实拜访记录**为准重算某张卡的 customerIds
//   —— 卡片上的「已拜访 N 家」= 这个数组的长度（**按客户去重**：同一家跑几次都算 1 家）。
//   ⚠️ 只统计**已提交**的拜访（status != ongoing）→ 取消拜访后记录被删，家数自然减少。
//   ⚠️ 客户后来被删进回收站时，列表页会自动跳过（这里不特殊处理，保证数据简单）。
async function _resyncFreeTrip(tripId) {
  if (!tripId) return;
  try {
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
  } catch (err) { /* 重算失败不影响拜访本身 */ }
}

// 拜访中：业务员进入拜访页（开始计时）即上报，后台可见"拜访中"状态
async function start(user, e, isBoss) {
  const { taskId, customerId } = e;
  // ⭐ 2026-10-03 自由拜访：归属哪张「自由拜访卡」（由 tasks/freeTripList 建卡得到；没有就为空）
  const freeTripId = String(e.freeTripId || '');
  // ⭐ 2026-10-02 老板定（选 A）：**支持「无任务拜访」（自由拜访）** ——
  //   场景：手机端「加新店」现场建的店**不属于任何任务**，建完要能立刻去拜访。
  //   规则：**taskId 为空 = 自由拜访** → 跳过"任务归属/状态/客户在任务里"三项校验，
  //        但仍然校验客户存在、且今天这家店没有别的拜访中（下面的 ong 检查，本来就与任务无关）。
  const freeVisit = !taskId;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  // ⚠️ 2026-10-04【对抗性检查补】归属卡要**验明正身**：
  //   原来直接拿 event.freeTripId 落库 → 业务员可以伪造别人的卡 id 把拜访"记到别人账上"。
  //   规则：卡必须存在、且**属于自己**；不合法就当作"无卡自由拜访"（不报错，别挡着业务员干活）。
  let tripId = '';
  if (freeTripId) {
    const tr = await db.collection('free_trips').doc(freeTripId).get().catch(() => null);
    const t = tr && (tr.data && (Array.isArray(tr.data) ? tr.data[0] : tr.data));
    if (t && t.salesmanId === user._id) tripId = freeTripId;
  }
  if (!freeVisit) {
    // ↓↓↓ 原有任务校验，一字未改 ↓↓↓
    const taskRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
    const task = taskRes && taskRes.data;
    if (!task || (task.salesmanId !== user._id && !isBoss)) return { ok: false, code: 'TASK_FORBIDDEN', msg: '任务不存在或不属于你' };
    if (!['published', 'reviewing'].includes(task.status)) return { ok: false, code: 'TASK_DONE', msg: '任务已结束，无法再拜访' };
    if (task.status === 'published' && task.deadline && String(task.deadline) <= todayStr()) return { ok: false, code: 'TASK_EXPIRED', msg: '任务已过期，请联系管理员延期' };
    if (!(task.customerIds || []).includes(customerId)) return { ok: false, code: 'CUST_NOT_IN_TASK', msg: '客户不在该任务中' };
  }
  // 老板模式（2026-09-09 §7.13）：不建拜访中记录、不发闹钟、不占单开名额——返回假 visitId 走本地演示流程
  if (isBoss) return { ok: true, already: 'new', visitId: 'boss_' + Date.now(), boss: true };

  const date = todayStr();
  // 任务内单开检查（2026-09-04 老板定）：放最前——任何客户（含已拜访的二次拜访）在他人拜访中时一律拦截
  // ⚠️ 2026-10-02：**只对任务内拜访生效** —— 自由拜访不占任务单开名额（它本就不属任何任务）
  if (!freeVisit) {
    const others = await db.collection('visits')
      .where({ taskId, status: 'ongoing', visitedAt: date, customerId: _.neq(customerId) })
      .limit(1).get();
    if (others.data.length) {
      const o = others.data[0];
      const cRes = await db.collection('customers').doc(o.customerId).get().catch(() => null);
      // ⭐ 2026-10-08 老板定：拦截弹窗要新增「切换到那家」/「取消上家拜访」两个按钮 →
      //   所以这里把**那家的完整信息**一起回给前端（切过去时要当成 curCustomer 用），
      //   并把它的 taskId 带回去（前端调 visits.cancel 要传 `{taskId, customerId}`）。
      const oc = (cRes && cRes.data) || {};
      return {
        ok: false,
        code: 'ONGOING_OTHERS',
        ongoingName: oc.name || '另一家',
        msg: `「${oc.name || '另一家'}」还未完成拜访，请先完成或取消`,
        ongoingCustomerId: o.customerId,
        ongoingTaskId: o.taskId || '',
        ongoingCustomer: {
          _id: o.customerId, taskId: o.taskId || '',
          name: oc.name || '', nameRaw: oc.nameRaw || '', phone: oc.phone || '',
          address: oc.address || '', lat: oc.lat || 0, lng: oc.lng || 0,
          customerType: oc.customerType || 'mall', freeTripId: oc.freeTripId || ''
        }
      };
    }
  }
  // 已有拜访中记录则忽略（已拜访客户二次拜访同样创建新拜访中记录——2026-09-06 老板定：
  // 删除原"已完成则不覆盖"分支，让二次拜访也走完整拜访中状态，蓝色提示体系/历史卡片/计时全部生效）
  const ong = await db.collection('visits').where({ customerId, visitedAt: date, status: 'ongoing' }).count();
  if (ong.total > 0) return { ok: true, already: 'ongoing' };
  // 拜访时长上限闹钟（2026-09-08 M1 老板定）：动态闹钟存两点，云端 10 分钟定时触发按时刻处理
  const vdRes = await db.collection('settings').where({ key: 'visitDurationLimit' }).limit(1).get();
  const vdVal = Number(vdRes.data[0] && vdRes.data[0].value) || 3600;
  const visitLimit = [1800, 3600, 7200].includes(vdVal) ? vdVal : 3600;
  const startedAt = Date.now();
  await db.collection('visits').add({
    data: {
      customerId, taskId: taskId || '', freeTripId: tripId, salesmanId: user._id, salesmanName: user.name,
      visitedAt: date, startedAt, status: 'ongoing', result: '', text: '', samples: '',
      remindAt: startedAt + (visitLimit - 300) * 1000,
      autoCancelAt: startedAt + visitLimit * 1000,
      draft: null, // 选结果即上报草稿（2026-09-08 M1），超时据此自动提交/自动取消
      createdAt: Date.now() // 2026-09-08 补：缺 createdAt 曾导致 ongoing 在历史排序中沉底
    }
  });
  return { ok: true, already: 'new' };
}

// 草稿上报（2026-09-08 M1 老板定）：点选拜访结果/填备注时立即上报，
// 超时到点时云端据此双态处理：有草稿→自动提交；无草稿→自动取消
async function saveDraft(user, e, isBoss) {
  const { taskId, customerId, result, text, samples } = e;
  // ⭐ 2026-10-02：自由拜访（无任务）也允许提交 —— 只要求 customerId
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  // 结果枚举校验（2026-09-08 审查修复：防非法值经草稿→超时自动提交写库）
  const rr = String(result || '');
  // ⭐ 2026-10-11：草稿也支持多选（逗号串，最多 2 项）
  if (rr) {
    const dp = String(rr).split(',').map(s => s.trim()).filter(Boolean);
    if (dp.length > 2 || dp.some(p => !RESULT_ENUM_NEW.includes(p))) return { ok: false, code: 'BAD_RESULT', msg: '拜访结果不合法' };
  }
  if (isBoss) return { ok: true, msg: '草稿已保存' }; // 老板演示：不落库
  const date = todayStr();
  const ong = await db.collection('visits')
    .where({ customerId, taskId, visitedAt: date, status: 'ongoing', salesmanId: user._id })
    .get();
  if (!ong.data.length) return { ok: false, code: 'NO_ONGOING', msg: '没有进行中的拜访' };
  await db.collection('visits').doc(ong.data[0]._id).update({
    data: { draft: { result: String(result || ''), text: String(text || ''), samples: String(samples || ''), savedAt: Date.now() } }
  });
  return { ok: true, msg: '草稿已保存' };
}

// 最新位置上报（2026-09-08 M1 老板定）：60 秒节流由端上控制；
// 移动阈值在云端判定（挑毛病 2 定稿）：工作时段（7:00~20:00，暂写死默认）正常写；
// 非工作时段移动 < 10 米不写（静止不写省写量）；force=true（点任务等主动行为）跳过阈值强制写
async function reportLocation(user, e, isBoss) {
  const la = Number(e.lat), ln = Number(e.lng);
  if (!isFinite(la) || !isFinite(ln) || !la || !ln) return { ok: false, code: 'BAD_ARG', msg: '坐标不合法' };
  if (isBoss) return { ok: true, dropped: true, boss: true }; // 老板演示：丢弃，防污染位置监控数据（2026-09-09 §7.13）
  const now = Date.now();
  const hour = new Date(now + 8 * 3600 * 1000).getUTCHours(); // 东八区小时
  const isWork = hour >= 7 && hour < 20;
  const ref = db.collection('salesman_locations').doc('latest_' + user._id);
  const old = await ref.get().catch(() => null);
  const od = old && old.data;
  if (!e.force && !isWork && od && od.lat) {
    const dist = haversine(Number(od.lat), Number(od.lng), la, ln);
    if (dist < 10) return { ok: true, skipped: true };
  }
  await ref.set({
    data: {
      type: 'latest', salesmanId: user._id, name: user.name || '',
      lat: la, lng: ln, accuracy: Number(e.accuracy) || 0,
      t: now, visitOngoing: !!e.visitOngoing, updatedAt: now
    }
  });
  return { ok: true };
}

// 轨迹片段写入（2026-09-08 M2）：端上按时间分层采样后打包上传，一条=一个片段文档
async function reportTrack(user, e, isBoss) {
  if (isBoss) return { ok: true, n: 0, dropped: true, boss: true }; // 老板演示：轨迹丢弃（2026-09-09 §7.13）
  const raw = Array.isArray(e.pts) ? e.pts : [];
  const base = raw
    .filter(p => p && isFinite(Number(p.lat)) && isFinite(Number(p.lng)))
    .slice(0, 120)
    .map(p => ({ lat: Number(p.lat), lng: Number(p.lng), acc: Number(p.acc) || 0, t: Number(p.t) || Date.now() }));
  // 防漂移（2026-09-08 M3 老板拍板，云端二道防线）：精度>150m 或 与前保留点速度>30m/s 的点剔除
  const pts = [];
  for (const p of base) {
    if (p.acc > 150) continue;
    const prev = pts[pts.length - 1];
    if (prev && p.t - prev.t > 0 && haversine(prev.lat, prev.lng, p.lat, p.lng) / ((p.t - prev.t) / 1000) > 30) continue;
    pts.push(p);
  }
  if (pts.length < 2) return { ok: true, n: 0, dropped: true, msg: '片段有效点不足（漂移过滤后），已丢弃' };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(e.day || '')) ? String(e.day) : todayStr();
  await db.collection('salesman_locations').add({
    data: {
      type: 'track', salesmanId: user._id, name: user.name || '',
      day, pts, createdAt: Date.now()
    }
  });
  return { ok: true, n: pts.length };
}

// 取消拜访（2026-09-04 老板定稿）：直接删除本次拜访记录，不留任何痕迹（像没来过一样）；客户仍为待回访；无需定位，任何地方可取消
async function cancelVisit(user, e, isBoss) {
  const { taskId, customerId } = e;
  // ⭐ 2026-10-02：自由拜访（无任务）也能取消 —— 只要求 customerId；任务校验仅在任务内拜访时做
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  if (taskId) {
    const taskRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
    const task = taskRes && taskRes.data;
    if (!task || (task.salesmanId !== user._id && !isBoss)) return { ok: false, code: 'TASK_FORBIDDEN', msg: '任务不存在或不属于你' };
  }
  if (isBoss) return { ok: true, boss: true, msg: '已取消本次拜访，该客户仍为待回访' }; // 老板演示：无记录可删，直接假成功
  const date = todayStr();
  const ong = await db.collection('visits')
    .where({ customerId, taskId: taskId || '', visitedAt: date, status: 'ongoing', salesmanId: user._id })
    .get();
  if (!ong.data.length) return { ok: false, code: 'NO_ONGOING', msg: '没有进行中的拜访，无需取消' };
  const doc = ong.data[0];
  await db.collection('visits').doc(doc._id).remove();
  // ⭐ 2026-10-03 自由拜访：取消 = 记录被删 → 卡片「已拜访 N 家」要跟着减少
  await _resyncFreeTrip(String(e.freeTripId || doc.freeTripId || ''));
  return { ok: true, visitId: doc._id, msg: '已取消本次拜访，该客户仍为待回访' };
}

// 2026-09-11 降频：开关类设置「一次读全表 + 实例内 60 秒缓存」
// 用途：submit 的照片上限/录音开关/强制拍照，coordfix 的报错开关等，避免每次调用都读 settings
let _swCache = null, _swCacheAt = 0;
async function getSwitchCfg() {
  if (_swCache && Date.now() - _swCacheAt < 60000) return _swCache;
  const r = await db.collection('settings').limit(100).get().catch(silentCatch('visits·getSwitchCfg', { data: [] }));
  const m = {};
  (r.data || []).forEach(s => { m[s.key] = s.value; });
  const recRaw = Number(m.recordingDurationLimit) || 300;
  _swCache = {
    photoLimit: [3, 6, 9, 15].includes(Number(m.photoLimit)) ? Number(m.photoLimit) : 9,
    recEnabled: m.recEnabled === undefined ? true : !!m.recEnabled,
    evidenceRequired: !!m.evidenceRequired,
    coordFixEnabled: m.coordFixEnabled === undefined ? true : !!m.coordFixEnabled,
    segLimitSec: [180, 300, 600].includes(recRaw) ? recRaw : 300
  };
  _swCacheAt = Date.now();
  return _swCache;
}

async function submit(user, e, isBoss) {
  // 游客（实习账号）硬拦（2026-09-08 老板定：游客不能提交数据；前端提示+云端兜底双层）
  if (user.trial) return { ok: false, code: 'TRIAL_FORBIDDEN', msg: '游客不能提交数据' };
  const { taskId, customerId, result, text = '', samples = '', durationSeconds = 0, lat, lng, photos, audio, audios } = e;

  // 1. 任务归属校验（⭐ 2026-10-02：**自由拜访没有任务 → 整段跳过**）
  let task = null;
  if (taskId) {
    const taskRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
    task = taskRes && taskRes.data;
    if (!task || (task.salesmanId !== user._id && !isBoss)) return { ok: false, code: 'TASK_FORBIDDEN', msg: '任务不存在或不属于你' };
    if (!['published', 'reviewing'].includes(task.status)) return { ok: false, code: 'TASK_DONE', msg: '任务已结束，无法再拜访' };
    if (task.status === 'published' && task.deadline && String(task.deadline) <= todayStr()) return { ok: false, code: 'TASK_EXPIRED', msg: '任务已过期，请联系管理员延期' };
  }
  // ⭐ 2026-10-02：**自由拜访没有任务 → 跳过"客户在任务里"这条校验**
  if (taskId && !(task.customerIds || []).includes(customerId)) return { ok: false, code: 'CUST_NOT_IN_TASK', msg: '客户不在该任务中' };

  // 2. 客户类型与结果集校验
  const cRes = await db.collection('customers').doc(customerId).get().catch(() => null);
  const customer = cRes && cRes.data;
  if (!customer) return { ok: false, code: 'CUST_NOT_FOUND', msg: '客户不存在' };
  const allowed = customer.customerType === 'new' ? RESULT_ENUM_NEW : RESULT_ENUM_MALL;
  // ⭐ 2026-10-11 老板定：结果**可多选（最多 2 个）** → 存成逗号串（如「换老板了,正常回访」，同样兼容老的单值）
  const resParts = String(result || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!resParts.length || resParts.length > 2) return { ok: false, code: 'BAD_RESULT', msg: '拜访结果不合法' };
  if (resParts.some(p => !allowed.includes(p))) return { ok: false, code: 'BAD_RESULT', msg: '拜访结果不合法' };

  // 3. 现场证据校验（2026-09-11 降频：上限与开关统一走 getSwitchCfg —— 一次读全表 + 60 秒缓存）
  //    照片：上限跟后台「照片上限」档位（3/6/9/15，默认 9）
  //    录音：≤6 段；单条上限跟后台「拜访录音上限」档位（180/300/600，兜底 300）；合计 ≤1800 秒=30 分钟硬封顶
  //      transcribe=false = 只留档不转文字；兼容旧字段 audio（单条）→ 自动并入 audios
  const sw = await getSwitchCfg();
  let ph = [];
  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || photos.length > sw.photoLimit) return { ok: false, code: 'BAD_PHOTOS', msg: '照片数量不合法（最多 ' + sw.photoLimit + ' 张）' };
    ph = photos.filter(p => p && typeof p.fileID === 'string' && p.fileID && typeof p.thumbID === 'string' && p.thumbID);
    if (ph.length !== photos.length) return { ok: false, code: 'BAD_PHOTOS', msg: '照片数据不完整，请重新拍摄' };
  }
  // 强制拍照（后台开关，默认关）：开启后必须至少 1 张
  if (sw.evidenceRequired && !ph.length) return { ok: false, code: 'NEED_PHOTO', msg: '请至少拍 1 张现场照片后再提交' };
  let au = [];
  const rawAudios = Array.isArray(audios) && audios.length ? audios : ((audio && audio.fileID) ? [audio] : []);
  // 现场录音开关（后台设置页可关，默认开）
  if (!sw.recEnabled && rawAudios.length) return { ok: false, code: 'AUDIO_DISABLED', msg: '后台已关闭现场录音，本次录音未提交' };
  if (rawAudios.length > 6) return { ok: false, code: 'BAD_AUDIO', msg: '录音最多 6 条' };
  // 单条上限跟后台档位（与手机端同源）
  const segLimitSec = sw.segLimitSec;
  let totalAudioSec = 0;
  for (const a of rawAudios) {
    if (!a || typeof a.fileID !== 'string' || !a.fileID) return { ok: false, code: 'BAD_AUDIO', msg: '录音数据不完整，请重新录制' };
    const rawSec = Math.round(Number(a.duration) || 0);
    if (rawSec > segLimitSec) return { ok: false, code: 'BAD_AUDIO', msg: '单条录音不能超过 ' + Math.round(segLimitSec / 60) + ' 分钟' };
    const dur = Math.max(1, rawSec || 1);
    totalAudioSec += dur;
    au.push({ fileID: a.fileID, duration: dur, transcribe: a.transcribe !== false });
  }
  if (totalAudioSec > 1800) return { ok: false, code: 'BAD_AUDIO', msg: '本次录音合计不能超过 30 分钟，请删除不需要的录音' };

  // 老板模式（2026-09-09 §7.13）：校验全走、只算不写——假成功返回，不落任何库
  if (isBoss) return { ok: true, boss: true, visitId: 'boss_' + Date.now(), msg: '已提交 ✓（演示：未保存）' };

  // 4. 当日可多次拜访（2026-09-03 老板拍板）：允许二次回访并再次提交结果，
  //    每次提交独立成一条拜访记录（历史完整留痕）；任务进度按客户家数去重，多次拜访不重复计数
  const date = todayStr();

  // 5. 定位校验（客户缺坐标自动跳过；定位失败拦截提交；超阈值拦截；后台可关）
  //    skipLoc（2026-09-08 M1）：仅"已超时"的自动提交允许跳过距离校验——必须 ongoing 存在且 autoCancelAt 已到
  let skipLoc = false;
  if (e.skipLoc) {
    const ongChk = await db.collection('visits')
      .where({ customerId, taskId: taskId || '', visitedAt: date, status: 'ongoing', salesmanId: user._id })
      .get();
    const o = ongChk.data[0];
    if (!o || !o.autoCancelAt || Number(o.autoCancelAt) > Date.now()) {
      return { ok: false, code: 'BAD_ARG', msg: '未到超时，不可跳过定位校验' };
    }
    if (!o.draft || !o.draft.result) {
      return { ok: false, code: 'BAD_ARG', msg: '未选择拜访结果，不能自动提交' };
    }
    skipLoc = true;
  }
  const setRes = await db.collection('settings').where({ key: 'locationCheck' }).get();
  const locCfg = setRes.data[0] ? setRes.data[0].value : { enabled: true, threshold: 100 };
  let distance = null;
  let status = 'normal';
  if (!skipLoc && locCfg.enabled && customer.lat && customer.lng) {
    if (lat && lng) {
      distance = haversine(lat, lng, customer.lat, customer.lng);
      if (distance > locCfg.threshold) {
        return { ok: false, code: 'TOO_FAR', msg: `距离客户约 ${Math.round(distance)} 米，超过阈值 ${locCfg.threshold} 米，请到店后提交`, distance: Math.round(distance) };
      }
    } else {
      // 定位失败往往代表无网络/网络差：直接拦截，提示无法提交
      return { ok: false, code: 'LOC_FAIL', msg: '定位失败，无法校验距离，请检查网络与定位后重新提交' };
    }
  }

  // 6. 写入（有"拜访中"记录则升级为完成，避免同日双记录）
  // ⚠️ 2026-10-04【对抗性检查补】submit 也要验归属卡（同 start，别让拜访记到别人卡上）
  let subTripId = '';
  if (e.freeTripId) {
    const tr = await db.collection('free_trips').doc(String(e.freeTripId)).get().catch(() => null);
    const t = tr && (tr.data && (Array.isArray(tr.data) ? tr.data[0] : tr.data));
    if (t && t.salesmanId === user._id) subTripId = String(e.freeTripId);
  }
  const doc = {
    taskId: taskId || '', freeTripId: subTripId, customerId, salesmanId: user._id, salesmanName: user.name,
    visitedAt: date, result, text, samples,
    durationSeconds, submitLat: lat || null, submitLng: lng || null,
    distanceToCustomer: distance ? Math.round(distance) : null,
    // 2026-09-11 M2a：多段录音存 audios（[{fileID,duration,transcribe}]）；audio 仍写第一段，兼容旧读取端
    photos: ph, audios: au, audio: au.length ? { fileID: au[0].fileID, duration: au[0].duration } : null,
    status,
    finishedAt: Date.now(),
    createdAt: Date.now()
  };
  const ong = await db.collection('visits').where({ customerId, visitedAt: date, status: 'ongoing' }).get();
  if (ong.data.length) {
    await db.collection('visits').doc(ong.data[0]._id).update({ data: doc });
    doc._id = ong.data[0]._id;
  } else {
    const add = await db.collection('visits').add({ data: doc });
    doc._id = add._id;
  }

  // ⭐ 2026-10-03 自由拜访：拜访成功 → 把客户加进该卡的 customerIds（去重，见 _resyncFreeTrip）
  await _resyncFreeTrip(doc.freeTripId);

  // 2026-09-11 M2b：把「提交前已点过『开始转录』」的转写记录回填 visitId
  // （按 fileID 精确匹配，不误关联别的拜访；失败不影响提交，后台仍可按客户查看）
  if (au.length) {
    try {
      const trs = await db.collection('transcripts')
        .where({ audioFileID: _.in(au.map(a => a.fileID)) }).limit(50).get();
      for (const t of (trs.data || [])) {
        if (t.visitId === doc._id) continue;
        await db.collection('transcripts').doc(t._id).update({
          data: {
            visitId: doc._id, taskId: taskId || '', customerId,
            salesmanId: user._id, salesmanName: user.name, updatedAt: Date.now()
          },
        });
      }
    } catch (err) { /* 回填失败不影响提交 */ }
  }

  if (result === '闭店·搬迁') {
    await db.collection('customers').doc(customerId).update({ data: { reviewFlag: true } });
  }

  // 7. 任务流程档案留痕（2026-09-08 老板定：单次拜访提交也记录进后台流程档案）
  // ⭐ 2026-10-02：**自由拜访没有任务 → 无需留痕，整段跳过**
  try {
    if (taskId) {
      const t2 = await db.collection('tasks').doc(taskId).get();
      const tlogs = Array.isArray(t2.data.logs) ? t2.data.logs : [];
      tlogs.push({
        at: Date.now(), by: user.name || '业务员', role: 'salesman', type: 'visit',
        detail: { customerId, name: customer.name || '', result, text: String(text || '').slice(0, 30) }
      });
      await db.collection('tasks').doc(taskId).update({ data: { logs: tlogs } });
    }
  } catch (e) { /* 日志失败不阻断拜访提交 */ }

  return { ok: true, visitId: doc._id, msg: '已提交 ✓' };
}

// ⭐⭐ 2026-10-10 老板定：「拜访记录」要能**再次编辑** —— 客户详情页的拜访历史里点「✎ 编辑」，
//   回到拜访页（编辑模式）改内容后保存。**只允许改自己的**（别人的、老板看的都改不了）。
//   · 改：result / text / samples / photos / audios（**整组替换** —— 前端已处理"保留已有 fileID、只上传新增的"）
//   · **不改**：visitedAt / taskId / customerId / status（改完保持原状态，不重审）→ 留痕 editedAt/editedBy
//   · status==='ongoing'（还在拜访中）不走这里（那个用 submit）→ 直接拒
async function editSubmitted(user, event, isBoss) {
  const visitId = String((event && event.visitId) || '');
  if (!visitId) return { ok: false, code: 'BAD_ARG', msg: '缺少拜访记录' };
  if (user.trial) return { ok: false, code: 'TRIAL_FORBIDDEN', msg: '游客不能提交数据' };
  const vr = await db.collection('visits').doc(visitId).get().catch(() => null);
  const v = vr && vr.data;
  if (!v) return { ok: false, code: 'NOT_FOUND', msg: '拜访记录不存在' };
  if (v.salesmanId !== user._id) return { ok: false, code: 'FORBIDDEN', msg: '只能修改自己的拜访记录' };
  if (v.status === 'ongoing') return { ok: false, code: 'STATE', msg: '这条还在拜访中，请回拜访页正常提交' };
  const now = Date.now();
  const upd = {
    result: String(event.result || '').slice(0, 40),
    text: String(event.text || '').slice(0, 5000),
    samples: String(event.samples || '').slice(0, 500),
    editedAt: now, editedBy: user.name || '', updatedAt: now
  };
  if (Array.isArray(event.photos)) upd.photos = event.photos.slice(0, 15);
  if (Array.isArray(event.audios)) {
    upd.audios = event.audios.slice(0, 6);
    upd.audio = upd.audios.length ? { fileID: upd.audios[0].fileID, duration: upd.audios[0].duration } : null;
  }
  await db.collection('visits').doc(visitId).update({ data: upd });
  // 任务流程档案留痕（有 taskId 才记；失败不影响保存）
  try {
    if (v.taskId) {
      const tRes = await db.collection('tasks').doc(v.taskId).get().catch(() => null);
      if (tRes && tRes.data) {
        const tlogs = [...(Array.isArray(tRes.data.logs) ? tRes.data.logs : []), {
          at: now, by: user.name || '业务员', role: 'salesman', type: 'visitEdit',
          detail: { visitId: visitId, customerId: v.customerId || '', result: upd.result }
        }];
        await db.collection('tasks').doc(v.taskId).update({ data: { logs: tlogs } });
      }
    }
  } catch (e) { /* 留痕失败不影响保存 */ }
  return { ok: true, msg: '已保存修改' };
}

async function history(user, customerId, isBoss) {
  const res = await db.collection('visits')
    .where({ customerId })
    .limit(100)
    .get();
  // 排序（2026-09-08 老板反馈修复）：拜访中(ongoing)强制置顶（多条按开始时间倒序）；
  // 其余按 createdAt 倒序。此前按 createdAt 排序导致无该字段的 ongoing 沉底
  const rows = res.data.slice().sort((x, y) => {
    const xo = x.status === 'ongoing' ? 0 : 1;
    const yo = y.status === 'ongoing' ? 0 : 1;
    if (xo !== yo) return xo - yo;
    return ((y.createdAt || y.startedAt || 0)) - ((x.createdAt || x.startedAt || 0));
  });
  // 2026-09-11 M2b-小步：批量带上「语音转写」状态与文字（一次查询，只针对有录音的拜访）
  const withAudio = rows.filter(v => (Array.isArray(v.audios) && v.audios.length) || (v.audio && v.audio.fileID));
  const trMap = {};
  withAudio.forEach(v => { trMap[v._id] = { total: 0, done: 0, failed: 0, running: 0, segs: [] }; });
  for (let i = 0; i < withAudio.length; i += 50) {
    const chunk = withAudio.slice(i, i + 50).map(v => v._id);
    const tr = await db.collection('transcripts').where({ visitId: _.in(chunk) })
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
  // 2026-09-11 老板定：转写文字可人工修订 → trEdited 优先，否则用识别的拼接文字
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
  return { ok: true, visits: rows.map(v => ({
    _id: v._id, visitedAt: v.visitedAt, result: v.result, text: v.text,
    samples: v.samples, status: v.status || '',
    durationSeconds: Number(v.durationSeconds) || 0,
    timeHM: fmtHM(v.finishedAt || v.createdAt || v.startedAt),
    salesmanName: v.salesmanName, distanceToCustomer: v.distanceToCustomer,
    photos: Array.isArray(v.photos) ? v.photos : [],
    // 2026-09-11 M2a：多段录音下发（audios：[{fileID,duration,transcribe}]）；audio 保留为第一段，兼容旧前端
    audios: Array.isArray(v.audios) && v.audios.length ? v.audios : (v.audio ? [v.audio] : []),
    audio: v.audio || null,
    // 2026-09-11 M2b：语音转写 { status, segCount, edited, text }；无录音或未转写为 null（文字已支持人工修订）
    transcribe: trOf(v)
  })) };
}

// 毫秒时间戳 → 东八区 24 小时制 HH:mm（拜访提交时间，显示在历史卡片日期后）
function fmtHM(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 「我的」页统计：本月拜访次数 / 本月拜访客户家数（去重）/ 累计次数 / 任务完成率
async function mystats(user, isBoss) {
  if (isBoss) return { ok: true, monthCount: 0, monthCust: 0, totalCount: 0, taskRate: 0 }; // 老板演示：无个人统计
  const list = [];
  let skip = 0;
  const PAGE = 100;
  while (true) {
    const r = await db.collection('visits')
      .where({ salesmanId: user._id, status: _.in(['normal', 'pending_review']) })
      .field({ visitedAt: true, customerId: true })
      .skip(skip).limit(PAGE).get();
    list.push(...r.data);
    if (r.data.length < PAGE) break;
    skip += PAGE;
  }
  const ym = todayStr().slice(0, 7);
  const monthSet = new Set();
  let monthCount = 0;
  list.forEach(v => {
    if ((v.visitedAt || '').startsWith(ym)) {
      monthCount++;
      monthSet.add(v.customerId);
    }
  });
  const tAll = await db.collection('tasks').where({ salesmanId: user._id }).field({ status: true }).limit(100).get();
  const doneN = tAll.data.filter(t => t.status === 'done').length;
  const taskRate = tAll.data.length ? Math.round(doneN / tAll.data.length * 100) : 0;
  return { ok: true, monthCount, monthCust: monthSet.size, totalCount: list.length, taskRate };
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function todayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
