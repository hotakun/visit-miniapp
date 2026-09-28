// 云函数 login：业务员微信登录 / 首次绑定
// 2026-09-09 老板拍板改版：正式业务员一律「注册申请 → 后台审核 → 通过后绑定 openid → 免登录进入首页」
// 2026-09-27 老板定：**恢复「游客体验入口」**（一键以 trial 游客身份进入；2026-09-10 曾移除）
// 流程：已绑定直接进；有申请=审核中/被拒绝状态；无申请=注册表单（附游客入口 trialId）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
// 2026-09-10 修复：users/_ 必须模块级——register() 是模块级函数，原先把 users/_ 定义在 exports.main 内部，
// 老板号注册通道引用它们时抛 ReferenceError: users is not defined → 手机端「提交失败，请重试」（老板注册必崩）
const users = db.collection('users');
const _ = db.command;

// 老板手机号（2026-09-09 老板定：谁用这个号码注册，谁就是老板——免审核直接通过、自动进老板模式）
const BOSS_PHONE = '15055492888';
// 开发者手机号（2026-09-09 开发者范宇琨定：只给他自己双身份测试入口——业务员/老板两按钮选择页，其他人零感知）
const DEV_PHONE = '13067737286';

// login 主流程（2026-09-10 容错加固：外层 exports.main 统一兜底，任何未预料异常都返回可读文案）
const mainInner = async (event) => {
  // 集合自愈（2026-09-09 老板报障修复：registrations 未建时 69 行查询抛 -502005
  // → login 整体失败，手机端提示"云函数调用失败"看不到登录页；init 未执行过的新环境必踩）
  try { await db.createCollection('registrations'); } catch (e) { /* 已存在等错误忽略 */ }
  const { OPENID } = cloud.getWXContext();
  const { bindUserId } = event || {};   // 2026-09-27 老板定：恢复「一键以游客身份进入」

  // 0. 管理员识别（super_admin / admin）：管理员微信打开小程序 → 直接进老板模式
  //    2026-09-10 老板定：管理员模式与老板模式合并，不再单独提示使用 Web 后台
  const adminRes = await users.where({ openid: OPENID, active: true, role: _.in(['super_admin', 'admin']) }).get();
  if (adminRes.data.length > 0) {
    const a = adminRes.data[0];
    await users.doc(a._id).update({ data: { lastLoginAt: Date.now() } });
    // 2026-09-10 老板定：管理员模式不再单独存在——管理员微信打开小程序直接进老板模式（与老板同一套页面与权限）
    return { ok: true, isAdmin: true, canBoss: true, boss: true, user: publicUser(a), welcome: await readWelcomeCfg() };
  }

  // 2. 游客体验入口（**2026-09-28 老板定：只读不绑定**）
  //    ⚠️ 原来这里是「绑定」：users.doc(bindUserId).update({ openid: OPENID }) —— 点一下游客入口就把
  //    当前微信 openid 写进 trial 账号，属于**自动绑定**（老板 2026-09-28 判为违规：无理、而且绑定后
  //    再也回不到注册页）。**这段写入已彻底去掉，勿再恢复。**
  //    现在只把那个 trial 账号的**资料读出来**返回给前端，一个字都不写库；前端只留一个本地 as_trial
  //    标记当"看数据的凭据"，退出即失效 —— 微信始终未被绑定，随时能回注册页。
  if (event && (event.asTrialVisit === true || event.asTrialVisit === 'true')) {
    const asTrialId = event.trialId || '';
    let t = null;
    if (asTrialId) {
      const one = await users.doc(asTrialId).get().catch(() => null);
      t = one && one.data;
    }
    if (!t) {   // 没传 / 传错 → 退一步取后台建的那个 trial 账号
      const tr = await users.where({ role: 'salesman', trial: true, active: true }).limit(1).get();
      t = tr.data[0] || null;
    }
    if (!t) return { ok: false, code: 'NO_TRIAL', msg: '游客入口暂不可用' };
    if (!t.trial) return { ok: false, code: 'NOT_TRIAL', msg: '该账号不是游客账号' };
    return { ok: true, user: publicUser(t), trial: true, bound: false };   // ← 注意：没有任何 update
  }

  // 2.5 退出游客 / 解绑（2026-09-28 老板定：底部「退出」→ 自动解绑并回登录页）
  //     把本 openid 从所有 trial 账号上摘掉。正式账号绝不动（正式账号走注册审核，不从这里解）。
  if (event && event.action === 'unbindTrial') {
    const r = await users.where({ openid: OPENID, trial: true }).update({ data: { openid: '' } });
    return { ok: true, updated: (r && r.stats && r.stats.updated) || 0 };
  }

  // 2.9 ⚠️ 旧的绑定入口已废弃（2026-09-28 老板定「必须去掉自动绑定」）
  //     老版本小程序还会传 bindUserId —— 这里**不再执行任何写入**，只提示前端升级。
  if (bindUserId) {
    return { ok: false, code: 'BIND_DEPRECATED', msg: '游客入口已改为「只看不绑」，请更新小程序' };
  }

  // 1. 业务员已绑定：直接返回（审核通过后 openid 已写入，免登录）
  const bound = await users.where({ openid: OPENID, active: true }).get();
  if (bound.data.length > 0) {
    // 2026-09-09 老板报障修复：同一 openid 可能同时命中「实习」与正式账号（实习可任意绑定）；
    // 正式业务员优先——多命中时非 trial 的排在前面。
    // 2026-09-28 修复：开发者点「以游客身份进入」时前端带 asTrial → 改为**实习(trial)优先**，
    //   否则他会被自己的正式号顶掉（进不去实习界面）；不带 asTrial 时行为完全不变（仍正式优先）。
    const asTrial = !!(event && (event.asTrial === true || event.asTrial === 'true'));
    const sorted = bound.data.slice().sort((a, b) => (a.trial ? 1 : 0) - (b.trial ? 1 : 0));
    const u = (asTrial && sorted.find(x => x.trial)) || sorted[0];
    await users.doc(u._id).update({ data: { lastLoginAt: Date.now() } });
    // 2026-09-10 老板定：管理员一律按老板处理（口径与 tasks/visits/coordfix 云函数一致）
    const boss = ['super_admin', 'admin'].includes(u.role);
    // 2026-09-09 开发者范宇琨双身份 → 2026-09-28 三身份（加「游客」）
    const dev = u.phone === DEV_PHONE;
    // 2026-09-28 老板定：dev 登录时一并下发 trialId（供「开发者三身份」页的「以游客身份进入」按钮使用）
    //   只在 dev 时查，普通业务员不产生额外开销；trialId 即后台建的那个 trial 游客账号
    let devTrialId = '';
    if (dev) {
      const tr = await users.where({ role: 'salesman', trial: true, active: true }).limit(1).get();
      devTrialId = tr.data[0] ? tr.data[0]._id : '';
    }
    // 2026-09-10 老板定：老板模式登录顺带下发「欢迎仪式」配置（每次登录一次查询，仅老板触发）
    // 2026-09-28 老板定：把「当前登录的是不是 trial 账号」一并告诉前端 ——
    //   底部栏「退出」靠它判断（这样**老绑定进来的游客**也能看到并能解绑退出）
    if (boss) return { ok: true, boss, dev, trialId: devTrialId, trial: !!u.trial, user: publicUser(u), welcome: await readWelcomeCfg() };
    return { ok: true, boss, dev, trialId: devTrialId, trial: !!u.trial, user: publicUser(u) };
  }

  // 3. 注册申请（2026-09-09 老板拍板：姓名+手机号 → 后台审核）
  if (event.action === 'register') return await register(OPENID, event);

  // 3.5 微信一键验证手机号（2026-09-09 老板定：getPhoneNumber 快速验证组件——
  //     微信向用户发验证码短信，确认后返回该微信绑定的真实手机号；前端自动填入注册表单）
  if (event.action === 'verifyPhone') return await verifyPhone(event);

  // 3.55 取消注册申请（2026-09-28 老板定：注册页「取消申请」按钮 → 撤回待审核申请）
  if (event.action === 'cancelReg') return await cancelReg(OPENID);

  // 3.6 欢迎仪式配置（2026-09-10 老板定：管理员从登录页手动进老板模式时拉取；老板自动进由下方返回携带）
  if (event.action === 'welcomeCfg') return await welcomeCfg();

  // 4. 未绑定：返回注册状态（审核中 / 被拒绝可重提 / 未注册）
  // 2026-09-09 反复核验加固：集合刚自愈创建后的首次查询可能仍有短暂延迟 → 查询失败按"无申请"降级，绝不阻断登录页
  let reg = { data: [] };
  try {
    reg = await db.collection('registrations').where({ openid: OPENID }).orderBy('createdAt', 'desc').limit(1).get();
  } catch (e) { /* 集合查询异常降级：按无注册申请处理，用户仍能看到注册表单 */ }
  const r = reg.data[0];
  if (r && r.status === 'pending') {
    return { ok: false, code: 'PENDING', msg: '申请已提交，等待管理员审核', createdAt: r.createdAt || 0 };
  }
  if (r && r.status === 'rejected') {
    return { ok: false, code: 'REJECTED', msg: '申请未通过，可重新申请', reason: r.reason || '', reviewedAt: r.reviewedAt || 0, canReapply: true };
  }
  // 游客入口信息（2026-09-27 老板定：恢复——返回 trialId，前端显示「游客体验入口」）
  const trialRes = await users.where({ role: 'salesman', trial: true, active: true }).limit(1).get();
  return { ok: false, code: 'NEED_REGISTER', msg: '请注册后等待审核', trialId: trialRes.data[0] ? trialRes.data[0]._id : '' };
};

// 2026-09-10 老板定：新人提交注册申请 → 服务号模板消息推送到老板/管理员微信（复用任务通知同一模板 kdgr7e7C-… 5词）
// 失败静默不影响注册结果；收件人=已绑 mpOpenid 的管理员（绑定入口：后台人员管理「服务号」列）
async function notifyAdminsNewReg(name, phone) {
  try {
    const cfgRes = await db.collection('settings').where({ key: 'mpConfig' }).limit(1).get();
    const cfg = cfgRes.data[0] && cfgRes.data[0].value;
    if (!cfg || !cfg.enabled || !cfg.appid || !cfg.appsecret || !cfg.templateId) return;
    const adm = await users.where({ role: _.in(['super_admin', 'admin']) }).get();
    const targets = adm.data.filter(a => a.mpOpenid).map(a => a.mpOpenid);
    if (!targets.length) return;
    // access_token：优先用老板电脑后台定时同步的云端缓存；过期现场取（可能受 IP 白名单限制，失败即放弃）
    let token = '';
    const tRes = await db.collection('settings').where({ key: 'mpAccessToken' }).limit(1).get();
    const tc = tRes.data[0] && tRes.data[0].value;
    if (tc && tc.token && Number(tc.expiresAt) > Date.now() + 300000) token = tc.token;
    if (!token) {
      const r = await mpRequest(`/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appid)}&secret=${encodeURIComponent(cfg.appsecret)}`, null, 'GET');
      if (!r || !r.access_token) return;
      token = r.access_token;
      const data = { key: 'mpAccessToken', value: { token, expiresAt: Date.now() + ((r.expires_in || 7200) - 300) * 1000 }, updatedAt: Date.now() };
      if (tRes.data[0]) await db.collection('settings').doc(tRes.data[0]._id).update({ data });
      else await db.collection('settings').add({ data });
    }
    const pad = n => String(n).padStart(2, '0');
    const now = new Date(Date.now() + 8 * 3600 * 1000); // 东八区
    const timeText = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
    const limit20 = s => String(s || '').slice(0, 20);
    const no = String(Date.now()).slice(-6); // 申请编号（character_string 只允许数字字母，用时间戳后 6 位）
    for (const openid of targets) {
      try {
        await mpRequest(`/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
          touser: openid,
          template_id: cfg.templateId,
          data: {
            character_string1: { value: no },           // 订单编号位 → 申请编号
            thing2: { value: limit20(name) },            // 服务人员位 → 申请人姓名
            thing6: { value: limit20(phone) },           // 服务用户位 → 申请手机号
            time5: { value: timeText },                  // 服务时间位 → 申请时间
            thing7: { value: '提交注册申请，请到后台审核' } // 地点位 → 提示
          }
        });
      } catch (e) { /* 单个收件人失败不影响其他 */ }
    }
  } catch (e) {
    console.error('注册通知发送异常', e);
  }
}

// 微信接口请求（云函数直连 api.weixin.qq.com；与 adminapi 同款精简版）
function mpRequest(pathWithQuery, body, method) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request('https://api.weixin.qq.com' + pathWithQuery, {
      method: method === 'GET' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('微信接口返回非 JSON：' + buf.slice(0, 120))); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('微信接口请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 顶层兜底（2026-09-10 容错加固）：任何未预料异常（集合故障/未知错误）都以可读文案返回，
// 手机端不再只看到「提交失败，请重试」，也不阻断注册表单展示
exports.main = async (event) => {
  try {
    return await mainInner(event);
  } catch (err) {
    console.error('login 云函数未捕获异常', err);
    return { ok: false, code: 'SERVER_ERROR', msg: '系统繁忙，请稍后重试' };
  }
};

// 注册申请（2026-09-09 老板拍板）：姓名+手机号；同一 openid 有 pending 不重复提交；拒绝后可重提
// 2026-09-09 老板定：手机号=15055492888 就是老板本人——免审核直接通过、账号打 boss 标、自动进老板模式
async function register(OPENID, e) {
  const name = String((e && e.name) || '').trim();
  const phone = String((e && e.phone) || '').trim();
  if (!name) return { ok: false, code: 'BAD_NAME', msg: '请填写姓名' };
  if (!/^1\d{10}$/.test(phone)) return { ok: false, code: 'BAD_PHONE', msg: '请填写正确的 11 位手机号' };

  // ===== 老板专属通道（免审核）=====
  if (phone === BOSS_PHONE) {
    try {
      // 谁用老板号注册谁就是老板。
      // 顺序刻意：先激活老板账号（成功拿到 bossId），再清理其它绑定——
      // 若先解绑后绑定，中间失败会让该微信失去全部身份（2026-09-09 专业审查修正）。
      let exist;
      try {
        exist = await users.where({ phone: BOSS_PHONE }).get();
      } catch (err) {
        return { ok: false, code: 'SERVER_ERROR', msg: '查询账号失败，请稍后重试' };
      }
      let bossId;
      if (exist.data.length) {
        const doc = exist.data[0];
        bossId = doc._id;
        try {
          await users.doc(bossId).update({
            data: { openid: OPENID, name, role: 'admin', boss: true, active: true, lastLoginAt: Date.now() }
          });
        } catch (err) {
          return { ok: false, code: 'SERVER_ERROR', msg: '激活老板身份失败，请稍后重试' };
        }
      } else {
        try {
          const add = await users.add({
            data: {
              openid: OPENID, name, phone: BOSS_PHONE,
              role: 'admin', boss: true, active: true, trial: false,
              remark: '老板手机号注册（免审核）', createdAt: Date.now(), lastLoginAt: Date.now()
            }
          });
          bossId = add._id;
        } catch (err) {
          return { ok: false, code: 'SERVER_ERROR', msg: '创建老板账号失败，请稍后重试' };
        }
      }
      // 清理：本微信此前绑定的其它账号（含 trial/测试账号）一律解绑（老板账号自身排除）
      try {
        await users.where({ _id: _.neq(bossId), openid: OPENID }).update({ data: { openid: '' } });
      } catch (err) { /* 清理失败不阻断老板激活（下次注册会再清） */ }
      // 清理：该微信此前提交的普通注册申请若还在待审核，标记已升级（否则后台留下永挂的幽灵记录）
      try {
        await db.collection('registrations').where({ openid: OPENID, status: 'pending' }).update({
          data: { status: 'rejected', reason: '该微信已通过老板手机号注册，自动升级', reviewedAt: Date.now() }
        });
      } catch (err) { /* 集合异常不阻断老板激活 */ }
      let u;
      try {
        u = await users.doc(bossId).get();
      } catch (err) {
        return { ok: false, code: 'SERVER_ERROR', msg: '读取老板账号失败，请稍后重试' };
      }
      return { ok: true, boss: true, user: publicUser(u.data), welcome: await readWelcomeCfg(), msg: '老板身份已激活' };
    } catch (err) {
      // 顶层兜底：任何未预料异常都以可读文案返回，手机端不再显示冷冰冰的「提交失败，请重试」
      console.error('register 老板通道异常', err);
      return { ok: false, code: 'SERVER_ERROR', msg: '系统繁忙，请稍后重试' };
    }
  }

  let pend = { total: 0 };
  try {
    pend = await db.collection('registrations').where({ openid: OPENID, status: 'pending' }).count();
  } catch (e) { /* 集合异常降级：按无待审申请处理，允许提交 */ }
  if (pend.total > 0) return { ok: false, code: 'PENDING', msg: '申请已提交，请等待管理员审核' };
  // 推荐人（2026-09-24）：分享链接带来的 users._id —— **必须校验真实存在**（防伪造）；
  // 查不到就静默忽略（只是不记推荐人，绝不阻断正常注册）
  let refFrom = '', refFromName = '';
  const refId = String((e && e.ref) || '').trim();
  if (refId) {
    try {
      const rf = await users.doc(refId).get();
      const ru = rf && rf.data;
      if (ru) { refFrom = ru._id || refId; refFromName = String(ru.name || ''); }
    } catch (err) { /* 传了不存在的 id：忽略 */ }
  }
  try {
    await db.collection('registrations').add({
      data: {
        openid: OPENID, name, phone, status: 'pending', reason: '', createdAt: Date.now(),
        phoneVerified: !!e.phoneVerified, // 2026-09-09 老板定：微信一键验证过的手机号打标，后台审核可见
        refFrom, refFromName, refAt: refFrom ? Date.now() : 0 // 2026-09-24 推荐人（谁分享的链接拉来的）
      }
    });
  } catch (err) {
    console.error('register 提交申请异常', err);
    return { ok: false, code: 'SERVER_ERROR', msg: '提交失败，请稍后重试' };
  }
  // 2026-09-10 老板定：新人申请 → 老板/管理员手机微信提醒（服务号模板消息；失败静默不阻断）
  await notifyAdminsNewReg(name, phone);
  return { ok: true, msg: '申请已提交，审核通过后重新打开小程序即可使用' };
}

// 微信一键验证手机号（2026-09-09 老板定：getPhoneNumber 快速验证组件，微信代发验证码短信）
async function verifyPhone(e) {
  const code = String((e && e.code) || '').trim();
  if (!code) return { ok: false, code: 'BAD_ARG', msg: '缺少验证码凭证' };
  try {
    const res = await cloud.openapi.phonenumber.getPhoneNumber({ code });
    const info = (res && res.phoneInfo) || {};
    const phone = String(info.purePhoneNumber || info.phoneNumber || '').trim();
    if (!phone) return { ok: false, code: 'NO_PHONE', msg: '未获取到手机号，请重试' };
    return { ok: true, phone };
  } catch (err) {
    return { ok: false, code: 'VERIFY_FAIL', msg: '验证失败，请重试（或手动输入手机号）' };
  }
}

// 取消注册申请（2026-09-28 老板定）：把本微信的**待审核申请**删掉
//   ⚠️ 只删 status='pending'，**不碰**已通过 / 已拒绝的记录（那些是历史留痕）。
//   前端「取消申请」按钮调用；失败也不阻塞 —— 照常返回 ok，让用户能干净退出。
async function cancelReg(openid) {
  try {
    const r = await db.collection('registrations').where({ openid, status: 'pending' }).remove();
    return { ok: true, removed: (r && r.stats && r.stats.removed) || 0 };
  } catch (e) {
    return { ok: true, removed: 0 };
  }
}

// 欢迎仪式配置（2026-09-10 老板定：后台设置页可配；默认 每天第一次 / 3 秒 / 金色）
const WELCOME_DEFAULT = { mode: 'daily', duration: 3, style: 'gold' };
async function readWelcomeCfg() {
  try {
    const r = await db.collection('settings').where({ key: 'welcomeConfig' }).limit(1).get();
    const v = r.data[0] && r.data[0].value;
    if (v && ['daily', 'every', 'once'].includes(v.mode)) {
      return {
        mode: v.mode,
        duration: [2, 3, 5].includes(Number(v.duration)) ? Number(v.duration) : 3,
        style: v.style === 'color' ? 'color' : 'gold'
      };
    }
  } catch (e) { /* 读取失败用默认 */ }
  return WELCOME_DEFAULT;
}
async function welcomeCfg() {
  return { ok: true, welcome: await readWelcomeCfg() };
}

function maskPhone(p) {
  if (!p || p.length < 11) return p || '';
  return p.slice(0, 3) + '****' + p.slice(7);
}

function publicUser(u) {
  // star：业务员星级（2026-09-24 老板定：**0.5 ~ 5 共 10 档**，步长 0.5 —— **新人进来默认半星**，没有"未评"）
  //       存量账号没有 star 字段 → 一律按 0.5（半星）兜底，保证每个人都有星级
  return { _id: u._id, name: u.name, phone: u.phone, role: u.role, trial: !!u.trial, star: Number(u.star || 0.5) };
}
