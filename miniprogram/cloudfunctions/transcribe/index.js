// 云函数 transcribe：拜访录音 → 文字（腾讯云 ASR「录音文件识别」）
// 2026-09-11 M2a 新增（老板拍板方案 A：事后转写；按段勾选；用量可控）
//
// actions：
//   start  { visitId, segIndexes? }        为该次拜访勾选的录音段提交识别任务（写 transcripts + 调 CreateRecTask）
//   start  { fileIDs: [{fileID, duration}] }  直接按文件提交（调试/未来复用）
//   poll   { visitId? , transcriptIds?, all? } 查询处理中的任务结果；all=true（定时触发器用）扫全部
//   retry  { transcriptId }                重转某一段（失败段）
//   list   { visitId }                     查某次拜访的转写结果（业务员看自己的；老板可看全部）
//   usage  {}                              本月已转写分钟数 / 额度（管理员）
//
// M2c（2026-09-11）：无 OPENID 调用分两种 —— 定时触发器 → poll 走 pollAll；
// adminapi 转发（后台手动触发）→ 带管理员 username/password 且校验通过 → start/retry/list/usage 真实执行（e.real=true），
// 跳过“老板演示的虚拟成功”。云函数间调用不带 OPENID，故用账号密码鉴权（与 adminapi.verifyAdmin 同口径）。
//
// 配置：settings 集合 key='asrConfig' = { enabled, secretId, secretKey, monthlyQuotaMin }
// 口径：SourceType 0=音频URL（用云存储临时链接，需 5MB 以上也能走）；返回文本带句子时间戳 → 统一清洗成纯文本
// 老板模式：isBoss 一律虚拟成功（不写库、不消耗额度），与项目其他动作口径一致

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ASR_HOST = 'asr.tencentcloudapi.com';
const ASR_SERVICE = 'asr';
const ASR_VERSION = '2019-06-14';

// ---------- 基础工具 ----------
const todayStr = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
// 东八区当月 1 日 00:00 的时间戳（用量统计口径）
const monthStartTs = () => {
  const cn = new Date(Date.now() + 8 * 3600 * 1000);
  return Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), 1) - 8 * 3600 * 1000;
};
// 去掉腾讯云返回的句子级时间戳：[0:1.480,0:6.320] 文本 → 文本
const stripTs = (s) => String(s || '').replace(/\[\d+:\d+(?:\.\d+)?,\d+:\d+(?:\.\d+)?\]\s*/g, '').trim();

function httpsJson(host, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: '/', method: 'POST', headers, timeout: 30000 }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('响应不是 JSON：' + String(buf).slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求腾讯云超时')));
    req.write(bodyStr);
    req.end();
  });
}

// TC3-HMAC-SHA256 签名（与 M1 验证脚本同款实现，已实测可用）
function asrHeaders(action, payloadStr, secretId, secretKey) {
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const canonicalHeaders = 'content-type:' + ct + '\nhost:' + ASR_HOST + '\n';
  const signedHeaders = 'content-type;host';
  const hashedPayload = crypto.createHash('sha256').update(payloadStr).digest('hex');
  const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedPayload;
  const scope = date + '/' + ASR_SERVICE + '/tc3_request';
  const stringToSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + scope + '\n' +
    crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
  const kDate = hmac('TC3' + secretKey, date);
  const kService = hmac(kDate, ASR_SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    Authorization: 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    'Content-Type': ct, Host: ASR_HOST,
    'X-TC-Action': action, 'X-TC-Version': ASR_VERSION, 'X-TC-Timestamp': String(ts),
  };
}

async function asrCall(action, payload, cfg) {
  const bodyStr = JSON.stringify(payload);
  const headers = asrHeaders(action, bodyStr, cfg.secretId, cfg.secretKey);
  const resp = await httpsJson(ASR_HOST, headers, bodyStr);
  return (resp && resp.Response) || {};
}

async function getAsrConfig() {
  const r = await db.collection('settings').where({ key: 'asrConfig' }).get();
  const v = (r.data[0] && r.data[0].value) || {};
  return {
    enabled: v.enabled !== false,
    secretId: v.secretId || '',
    secretKey: v.secretKey || '',
    monthlyQuotaMin: Number(v.monthlyQuotaMin || 600),
  };
}

// 本月已转写分钟数
async function monthUsedMin() {
  const r = await db.collection('transcripts')
    .where({ status: 'done', doneAt: _.gte(monthStartTs()) })
    .field({ duration: true }).limit(1000).get();
  const sec = (r.data || []).reduce((s, x) => s + (Number(x.duration) || 0), 0);
  return Math.round(sec / 60);
}

// 2026-09-11 M2c：后台（管理端）调用校验 —— 云函数间调用不带 OPENID，改用管理员账号+密码（与 adminapi.verifyAdmin 同款口径）
async function verifyAdminPass(e) {
  const username = String(e.username || '').trim();
  const password = String(e.password || '');
  if (!username || !password) return null;
  const h = crypto.createHash('sha256').update(password).digest('hex');
  const r = await db.collection('users')
    .where({ username, role: _.in(['super_admin', 'admin']), active: true }).limit(3).get();
  return (r.data || []).find(x => x.passwordHash && x.passwordHash === h) || null;
}

// ---------- 主流程 ----------
exports.main = async (event) => {
  const e = event || {};
  const { OPENID } = cloud.getWXContext();
  const action = e.action || 'poll';

  // 定时触发器调用：无 OPENID → 只允许 poll(all)
  // 后台管理端调用（2026-09-11 M2c）：adminapi 转发过来也没有 OPENID → 走管理员账号密码校验，标记 real 真实执行
  if (!OPENID) {
    if (action === 'poll') return await pollAll();
    const adm = await verifyAdminPass(e);
    if (adm) {
      const eReal = Object.assign({}, e, { real: true });
      if (action === 'start') return await start(adm, true, eReal);
      if (action === 'retry') return await retryOne(adm, true, eReal);
      if (action === 'list') return await listByVisit(adm, true, e);
      if (action === 'usage') return await usage(true);
    }
    return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  }

  const meRes = await db.collection('users').where({ openid: OPENID }).get();
  const me = meRes.data[0];
  if (!me) return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  const isBoss = ['super_admin', 'admin'].includes(me.role);
  if (me.trial) return { ok: false, code: 'TRIAL_FORBIDDEN', msg: '游客不能使用该功能' };

  if (action === 'start') return await start(me, isBoss, e);
  if (action === 'poll') return await pollMine(me, isBoss, e);
  if (action === 'retry') return await retryOne(me, isBoss, e);
  if (action === 'list') return await listByVisit(me, isBoss, e);
  if (action === 'usage') return await usage(isBoss);

  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' };
};

// 提交识别任务
async function start(me, isBoss, e) {
  const cfg = await getAsrConfig();
  if (!cfg.enabled) return { ok: false, code: 'ASR_OFF', msg: '语音转文字未启用' };
  if (!cfg.secretId || !cfg.secretKey) return { ok: false, code: 'ASR_CFG', msg: '语音转文字未配置密钥' };

  // 收集待转写段
  let segs = [];      // [{segIndex, fileID, duration}]
  let visit = null;
  if (e.visitId) {
    const vr = await db.collection('visits').doc(String(e.visitId)).get().catch(() => null);
    visit = vr && vr.data;
    if (!visit) return { ok: false, code: 'VISIT_NOT_FOUND', msg: '拜访记录不存在' };
    if (!isBoss && visit.salesmanId !== me._id) return { ok: false, code: 'FORBIDDEN', msg: '无权操作该拜访' };
    const audios = Array.isArray(visit.audios) && visit.audios.length
      ? visit.audios
      : (visit.audio && visit.audio.fileID ? [visit.audio] : []);
    const pick = Array.isArray(e.segIndexes) && e.segIndexes.length ? e.segIndexes.map(Number) : null;
    audios.forEach((a, i) => {
      if (!a || !a.fileID) return;
      if (a.transcribe === false) return;               // 未勾选：不转写
      if (pick && !pick.includes(i)) return;            // 指定段
      segs.push({ segIndex: i, fileID: a.fileID, duration: Number(a.duration) || 0 });
    });
  } else if (Array.isArray(e.fileIDs)) {
    e.fileIDs.forEach((a, i) => {
      if (a && a.fileID) segs.push({ segIndex: i, fileID: a.fileID, duration: Number(a.duration) || 0 });
    });
  }
  if (!segs.length) return { ok: false, code: 'NO_AUDIO', msg: '没有需要转写的录音' };
  if (segs.length > 8) segs = segs.slice(0, 8);

  // 老板模式：虚拟成功（后台管理端触发时 e.real=true → 跳过此分支，走真实执行）
  if (isBoss && !e.real) return { ok: true, boss: true, msg: '已提交转写（演示：未保存）', segs: segs.length };

  // 额度检查
  const usedMin = await monthUsedMin();
  const needMin = Math.ceil(segs.reduce((s, x) => s + (x.duration || 0), 0) / 60);
  if (usedMin + needMin > cfg.monthlyQuotaMin) {
    return { ok: false, code: 'QUOTA', msg: `本月转写额度不足（已用 ${usedMin} 分钟 / 上限 ${cfg.monthlyQuotaMin} 分钟）` };
  }

  // 取云存储临时链接（腾讯云会来抓这个 URL）
  const fileList = segs.map(s => s.fileID);
  const urlRes = await cloud.getTempFileURL({ fileList }).catch(() => null);
  const urlMap = {};
  ((urlRes && urlRes.fileList) || []).forEach(f => { if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL; });

  const out = [];
  for (const s of segs) {
    const url = urlMap[s.fileID];
    if (!url) { out.push({ segIndex: s.segIndex, ok: false, msg: '无法获取录音下载链接' }); continue; }
    try {
      const resp = await asrCall('CreateRecTask', {
        EngineModelType: '16k_zh',
        ChannelNum: 1,
        ResTextFormat: 0,
        SourceType: 0,      // 0 = 音频 URL
        Url: url,
      }, cfg);
      const data = resp.Data || {};
      if (!data.TaskId) {
        out.push({ segIndex: s.segIndex, ok: false, msg: resp.Error ? (resp.Error.Code + ' ' + resp.Error.Message) : '提交失败' });
        continue;
      }
      const rec = {
        // 2026-09-11 M2b：提交前「开始转录」（fileIDs 路径）还没有 visitId → 先存 taskId/customerId 上下文，
        // 提交拜访时由 visits.submit 按 fileID 回填 visitId（历史卡与后台据此可见）
        visitId: e.visitId || '',
        taskId: (visit && visit.taskId) || e.taskId || '',
        customerId: (visit && visit.customerId) || e.customerId || '',
        salesmanId: (visit && visit.salesmanId) || me._id, salesmanName: (visit && visit.salesmanName) || me.name,
        segIndex: s.segIndex, audioFileID: s.fileID, duration: Math.round(s.duration || 0),
        status: 'processing', asrTaskId: data.TaskId, text: '', errorMsg: '',
        requestedAt: Date.now(), updatedAt: Date.now(), doneAt: 0, byOpenid: OPENIDsafe(me),
      };
      const add = await db.collection('transcripts').add({ data: rec });
      out.push({ segIndex: s.segIndex, ok: true, transcriptId: add._id, status: 'processing' });
    } catch (err) {
      out.push({ segIndex: s.segIndex, ok: false, msg: err.message || String(err) });
    }
  }
  return { ok: true, segs: out, usedMin, quotaMin: cfg.monthlyQuotaMin };
}

function OPENIDsafe(me) { return me && me.openid ? String(me.openid).slice(0, 12) + '…' : ''; }

// 查询自己相关（或指定）的处理中任务
async function pollMine(me, isBoss, e) {
  const cfg = await getAsrConfig();
  if (!cfg.enabled || !cfg.secretId || !cfg.secretKey) return { ok: false, code: 'ASR_OFF', msg: '语音转文字未启用' };

  let cond = { status: _.in(['processing', 'pending']) };
  if (Array.isArray(e.transcriptIds) && e.transcriptIds.length) {
    cond = { _id: _.in(e.transcriptIds.map(String)) };
  } else if (e.visitId) {
    cond.visitId = String(e.visitId);
  } else if (!isBoss) {
    cond.salesmanId = me._id;
  }
  const r = await db.collection('transcripts').where(cond).limit(20).get();
  const list = r.data || [];
  for (const t of list) await settleOne(t, cfg);
  const after = await db.collection('transcripts').where(
    Array.isArray(e.transcriptIds) && e.transcriptIds.length
      ? { _id: _.in(e.transcriptIds.map(String)) }
      : (e.visitId ? { visitId: String(e.visitId) } : { _id: _.in(list.map(x => x._id)) })
  ).limit(50).field({ segIndex: true, status: true, text: true, duration: true, errorMsg: true, asrTaskId: true, doneAt: true }).get();
  return { ok: true, list: after.data || [] };
}

// 定时触发器：扫全部处理中的任务（兜底）
async function pollAll() {
  const cfg = await getAsrConfig();
  if (!cfg.enabled || !cfg.secretId || !cfg.secretKey) return { ok: true, skipped: '未启用' };
  const r = await db.collection('transcripts')
    .where({ status: _.in(['processing', 'pending']) })
    .orderBy('requestedAt', 'asc').limit(20).get();
  const list = r.data || [];
  let done = 0, failed = 0;
  for (const t of list) {
    const st = await settleOne(t, cfg);
    if (st === 'done') done++;
    if (st === 'failed') failed++;
  }
  return { ok: true, scanned: list.length, done, failed };
}

// 查询单条任务并落库；返回最终状态
async function settleOne(t, cfg) {
  // 2026-09-11 保险（老板拍板）：提交超过 30 分钟仍未出结果 → 直接判失败，防止僵尸任务被无限轮询（后台可手动重转）
  if (t.requestedAt && Date.now() - Number(t.requestedAt) > 30 * 60 * 1000) {
    await db.collection('transcripts').doc(t._id).update({
      data: { status: 'failed', errorMsg: '识别超时（超过 30 分钟未返回结果）', updatedAt: Date.now() },
    }).catch(() => {});
    return 'timeout';
  }
  try {
    const resp = await asrCall('DescribeTaskStatus', { TaskId: t.asrTaskId }, cfg);
    const d = resp.Data || {};
    if (d.Status === 2) {
      const text = stripTs(d.Result || '');
      await db.collection('transcripts').doc(t._id).update({
        data: { status: 'done', text, duration: Math.round(Number(d.AudioDuration) || t.duration || 0), doneAt: Date.now(), updatedAt: Date.now() },
      });
      return 'done';
    }
    if (d.Status === 3) {
      await db.collection('transcripts').doc(t._id).update({
        data: { status: 'failed', errorMsg: d.ErrorMsg || '识别失败', updatedAt: Date.now() },
      });
      return 'failed';
    }
    await db.collection('transcripts').doc(t._id).update({ data: { updatedAt: Date.now() } });
    return 'running';
  } catch (err) {
    await db.collection('transcripts').doc(t._id).update({
      data: { errorMsg: (err.message || String(err)).slice(0, 200), updatedAt: Date.now() },
    }).catch(() => {});
    return 'error';
  }
}

// 重转某一段
async function retryOne(me, isBoss, e) {
  const cfg = await getAsrConfig();
  if (!cfg.enabled || !cfg.secretId || !cfg.secretKey) return { ok: false, code: 'ASR_OFF', msg: '语音转文字未启用' };
  const tr = await db.collection('transcripts').doc(String(e.transcriptId || '')).get().catch(() => null);
  const t = tr && tr.data;
  if (!t) return { ok: false, code: 'NOT_FOUND', msg: '记录不存在' };
  if (!isBoss && t.salesmanId !== me._id) return { ok: false, code: 'FORBIDDEN', msg: '无权操作' };
  if (isBoss && !e.real) return { ok: true, boss: true, msg: '已重转（演示：未保存）' };

  const urlRes = await cloud.getTempFileURL({ fileList: [t.audioFileID] }).catch(() => null);
  const url = ((urlRes && urlRes.fileList) || [])[0] && urlRes.fileList[0].tempFileURL;
  if (!url) return { ok: false, code: 'NO_URL', msg: '无法获取录音下载链接' };
  const resp = await asrCall('CreateRecTask', {
    EngineModelType: '16k_zh', ChannelNum: 1, ResTextFormat: 0, SourceType: 0, Url: url,
  }, cfg);
  const taskId = (resp.Data || {}).TaskId;
  if (!taskId) return { ok: false, code: 'ASR_ERR', msg: resp.Error ? (resp.Error.Code + ' ' + resp.Error.Message) : '提交失败' };
  await db.collection('transcripts').doc(t._id).update({
    data: { status: 'processing', asrTaskId: taskId, text: '', errorMsg: '', requestedAt: Date.now(), updatedAt: Date.now() },
  });
  return { ok: true, transcriptId: t._id, status: 'processing' };
}

// 查某次拜访的转写结果
async function listByVisit(me, isBoss, e) {
  const visitId = String(e.visitId || '');
  if (!visitId) return { ok: false, code: 'BAD_ARG', msg: '缺少 visitId' };
  const vr = await db.collection('visits').doc(visitId).get().catch(() => null);
  const visit = vr && vr.data;
  if (!visit) return { ok: false, code: 'VISIT_NOT_FOUND', msg: '拜访记录不存在' };
  if (!isBoss && visit.salesmanId !== me._id) return { ok: false, code: 'FORBIDDEN', msg: '无权查看' };
  const r = await db.collection('transcripts').where({ visitId }).orderBy('segIndex', 'asc').limit(20).get();
  return { ok: true, list: (r.data || []).map(t => ({
    _id: t._id, segIndex: t.segIndex, status: t.status, text: t.text || '',
    duration: t.duration || 0, errorMsg: t.errorMsg || '', doneAt: t.doneAt || 0,
  })) };
}

// 本月用量
async function usage(isBoss) {
  if (!isBoss) return { ok: false, code: 'FORBIDDEN', msg: '仅管理员可用' };
  const cfg = await getAsrConfig();
  const used = await monthUsedMin();
  return { ok: true, usedMin: used, quotaMin: cfg.monthlyQuotaMin, remainMin: Math.max(0, cfg.monthlyQuotaMin - used), enabled: cfg.enabled };
}
