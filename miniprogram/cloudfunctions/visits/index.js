// 云函数 visits：提交拜访记录 / 客户拜访历史
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RESULT_ENUM_MALL = ['极有意向', '有意向', '已下单', '无需求', '有抵触', '联系不上', '闭店·搬迁', '其他'];
const RESULT_ENUM_NEW = [...RESULT_ENUM_MALL, '已注册商城'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event || {};

  const me = await db.collection('users').where({ openid: OPENID }).get();
  if (!me.data.length) return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  const meUser = me.data[0];

  if (action === 'submit') return await submit(meUser, event);
  if (action === 'start') return await start(meUser, event);
  if (action === 'saveDraft') return await saveDraft(meUser, event);
  if (action === 'reportLocation') return await reportLocation(meUser, event);
  if (action === 'reportTrack') return await reportTrack(meUser, event);
  if (action === 'cancel') return await cancelVisit(meUser, event);
  if (action === 'history') return await history(meUser, event.customerId);
  if (action === 'mystats') return await mystats(meUser);
  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' };
};

// 拜访中：业务员进入拜访页（开始计时）即上报，后台可见"拜访中"状态
async function start(user, e) {
  const { taskId, customerId } = e;
  if (!taskId || !customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少任务或客户' };
  // 任务归属校验
  const taskRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const task = taskRes && taskRes.data;
  if (!task || task.salesmanId !== user._id) return { ok: false, code: 'TASK_FORBIDDEN', msg: '任务不存在或不属于你' };
  if (!['published', 'reviewing'].includes(task.status)) return { ok: false, code: 'TASK_DONE', msg: '任务已结束，无法再拜访' };
  if (task.status === 'published' && task.deadline && String(task.deadline) <= todayStr()) return { ok: false, code: 'TASK_EXPIRED', msg: '任务已过期，请联系管理员延期' };
  if (!(task.customerIds || []).includes(customerId)) return { ok: false, code: 'CUST_NOT_IN_TASK', msg: '客户不在该任务中' };

  const date = todayStr();
  // 任务内单开检查（2026-09-04 老板定）：放最前——任何客户（含已拜访的二次拜访）在他人拜访中时一律拦截
  const others = await db.collection('visits')
    .where({ taskId, status: 'ongoing', visitedAt: date, customerId: _.neq(customerId) })
    .limit(1).get();
  if (others.data.length) {
    const o = others.data[0];
    const cRes = await db.collection('customers').doc(o.customerId).get().catch(() => null);
    return {
      ok: false,
      code: 'ONGOING_OTHERS',
      msg: `「${(cRes && cRes.data && cRes.data.name) || '另一家'}」还未完成拜访，请先完成或取消`,
      ongoingCustomerId: o.customerId
    };
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
      customerId, taskId, salesmanId: user._id, salesmanName: user.name,
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
async function saveDraft(user, e) {
  const { taskId, customerId, result, text, samples } = e;
  if (!taskId || !customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少任务或客户' };
  // 结果枚举校验（2026-09-08 审查修复：防非法值经草稿→超时自动提交写库）
  const rr = String(result || '');
  if (rr && !RESULT_ENUM_NEW.includes(rr)) return { ok: false, code: 'BAD_RESULT', msg: '拜访结果不合法' };
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
async function reportLocation(user, e) {
  const la = Number(e.lat), ln = Number(e.lng);
  if (!isFinite(la) || !isFinite(ln) || !la || !ln) return { ok: false, code: 'BAD_ARG', msg: '坐标不合法' };
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
async function reportTrack(user, e) {
  const raw = Array.isArray(e.pts) ? e.pts : [];
  const pts = raw
    .filter(p => p && isFinite(Number(p.lat)) && isFinite(Number(p.lng)))
    .slice(0, 120)
    .map(p => ({ lat: Number(p.lat), lng: Number(p.lng), acc: Number(p.acc) || 0, t: Number(p.t) || Date.now() }));
  if (!pts.length) return { ok: false, code: 'BAD_ARG', msg: '没有有效轨迹点' };
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
async function cancelVisit(user, e) {
  const { taskId, customerId } = e;
  if (!taskId || !customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少任务或客户' };
  const taskRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const task = taskRes && taskRes.data;
  if (!task || task.salesmanId !== user._id) return { ok: false, code: 'TASK_FORBIDDEN', msg: '任务不存在或不属于你' };
  const date = todayStr();
  const ong = await db.collection('visits')
    .where({ customerId, taskId, visitedAt: date, status: 'ongoing', salesmanId: user._id })
    .get();
  if (!ong.data.length) return { ok: false, code: 'NO_ONGOING', msg: '没有进行中的拜访，无需取消' };
  const doc = ong.data[0];
  await db.collection('visits').doc(doc._id).remove();
  return { ok: true, visitId: doc._id, msg: '已取消本次拜访，该客户仍为待回访' };
}

async function submit(user, e) {
  // 游客（实习账号）硬拦（2026-09-08 老板定：游客不能提交数据；前端提示+云端兜底双层）
  if (user.trial) return { ok: false, code: 'TRIAL_FORBIDDEN', msg: '游客不能提交数据' };
  const { taskId, customerId, result, text = '', samples = '', durationSeconds = 0, lat, lng, photos, audio } = e;

  // 1. 任务归属校验
  const taskRes = await db.collection('tasks').doc(taskId).get().catch(() => null);
  const task = taskRes && taskRes.data;
  if (!task || task.salesmanId !== user._id) return { ok: false, code: 'TASK_FORBIDDEN', msg: '任务不存在或不属于你' };
  if (!['published', 'reviewing'].includes(task.status)) return { ok: false, code: 'TASK_DONE', msg: '任务已结束，无法再拜访' };
  if (task.status === 'published' && task.deadline && String(task.deadline) <= todayStr()) return { ok: false, code: 'TASK_EXPIRED', msg: '任务已过期，请联系管理员延期' };
  if (!(task.customerIds || []).includes(customerId)) return { ok: false, code: 'CUST_NOT_IN_TASK', msg: '客户不在该任务中' };

  // 2. 客户类型与结果集校验
  const cRes = await db.collection('customers').doc(customerId).get().catch(() => null);
  const customer = cRes && cRes.data;
  if (!customer) return { ok: false, code: 'CUST_NOT_FOUND', msg: '客户不存在' };
  const allowed = customer.customerType === 'new' ? RESULT_ENUM_NEW : RESULT_ENUM_MALL;
  if (!allowed.includes(result)) return { ok: false, code: 'BAD_RESULT', msg: '拜访结果不合法' };

  // 3. 现场证据校验（2026-09-07 拍照+录音提前做二期；照片上限 2026-09-08 老板改 3 张）：photos ≤3 条 {fileID, thumbID}；audio {fileID, duration}
  let ph = [];
  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || photos.length > 3) return { ok: false, code: 'BAD_PHOTOS', msg: '照片数量不合法（最多 3 张）' };
    ph = photos.filter(p => p && typeof p.fileID === 'string' && p.fileID && typeof p.thumbID === 'string' && p.thumbID);
    if (ph.length !== photos.length) return { ok: false, code: 'BAD_PHOTOS', msg: '照片数据不完整，请重新拍摄' };
  }
  let au = null;
  if (audio !== undefined && audio !== null) {
    if (!audio || typeof audio.fileID !== 'string' || !audio.fileID) return { ok: false, code: 'BAD_AUDIO', msg: '录音数据不完整，请重新录制' };
    au = { fileID: audio.fileID, duration: Math.max(1, Math.min(600, Math.round(Number(audio.duration) || 0))) };
  }

  // 4. 当日可多次拜访（2026-09-03 老板拍板）：允许二次回访并再次提交结果，
  //    每次提交独立成一条拜访记录（历史完整留痕）；任务进度按客户家数去重，多次拜访不重复计数
  const date = todayStr();

  // 5. 定位校验（客户缺坐标自动跳过；定位失败拦截提交；超阈值拦截；后台可关）
  //    skipLoc（2026-09-08 M1）：仅"已超时"的自动提交允许跳过距离校验——必须 ongoing 存在且 autoCancelAt 已到
  let skipLoc = false;
  if (e.skipLoc) {
    const ongChk = await db.collection('visits')
      .where({ customerId, taskId, visitedAt: date, status: 'ongoing', salesmanId: user._id })
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
  const doc = {
    taskId, customerId, salesmanId: user._id, salesmanName: user.name,
    visitedAt: date, result, text, samples,
    durationSeconds, submitLat: lat || null, submitLng: lng || null,
    distanceToCustomer: distance ? Math.round(distance) : null,
    photos: ph, audio: au,
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

  if (result === '闭店·搬迁') {
    await db.collection('customers').doc(customerId).update({ data: { reviewFlag: true } });
  }

  // 7. 任务流程档案留痕（2026-09-08 老板定：单次拜访提交也记录进后台流程档案）
  try {
    const t2 = await db.collection('tasks').doc(taskId).get();
    const tlogs = Array.isArray(t2.data.logs) ? t2.data.logs : [];
    tlogs.push({
      at: Date.now(), by: user.name || '业务员', role: 'salesman', type: 'visit',
      detail: { customerId, name: customer.name || '', result, text: String(text || '').slice(0, 30) }
    });
    await db.collection('tasks').doc(taskId).update({ data: { logs: tlogs } });
  } catch (e) { /* 日志失败不阻断拜访提交 */ }

  return { ok: true, visitId: doc._id, msg: '已提交 ✓' };
}

async function history(user, customerId) {
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
  return { ok: true, visits: rows.map(v => ({
    _id: v._id, visitedAt: v.visitedAt, result: v.result, text: v.text,
    samples: v.samples, status: v.status || '',
    durationSeconds: Number(v.durationSeconds) || 0,
    timeHM: fmtHM(v.finishedAt || v.createdAt || v.startedAt),
    salesmanName: v.salesmanName, distanceToCustomer: v.distanceToCustomer,
    photos: Array.isArray(v.photos) ? v.photos : [],
    audio: v.audio || null
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
async function mystats(user) {
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
