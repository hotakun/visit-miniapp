// 云函数 login：业务员微信登录 / 首次绑定
// 2026-09-09 老板拍板改版：正式业务员一律「注册申请 → 后台审核 → 通过后绑定 openid → 免登录进入首页」
// 2026-09-10 老板定：实习（trial）角色永远不能绑定——原游客入口已移除，未注册微信永远看到注册表单
// 流程：已绑定直接进；有申请=审核中/被拒绝状态；无申请=注册表单
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 老板手机号（2026-09-09 老板定：谁用这个号码注册，谁就是老板——免审核直接通过、自动进老板模式）
const BOSS_PHONE = '15055492888';
// 开发者手机号（2026-09-09 开发者范宇琨定：只给他自己双身份测试入口——业务员/老板两按钮选择页，其他人零感知）
const DEV_PHONE = '13067737286';

exports.main = async (event) => {
  // 集合自愈（2026-09-09 老板报障修复：registrations 未建时 69 行查询抛 -502005
  // → login 整体失败，手机端提示"云函数调用失败"看不到登录页；init 未执行过的新环境必踩）
  try { await db.createCollection('registrations'); } catch (e) { /* 已存在等错误忽略 */ }
  const { OPENID } = cloud.getWXContext();

  const users = db.collection('users');
  const _ = db.command;

  // 0. 管理员识别（super_admin / admin）：管理员微信打开小程序 → 仅提示使用 Web 后台
  //    2026-09-09 老板定：只有 boss===true 的指定账号才显示「进入老板模式」入口
  const adminRes = await users.where({ openid: OPENID, active: true, role: _.in(['super_admin', 'admin']) }).get();
  if (adminRes.data.length > 0) {
    const a = adminRes.data[0];
    await users.doc(a._id).update({ data: { lastLoginAt: Date.now() } });
    // 2026-09-09 老板定：boss 白名单账号登录后直接进老板模式，不用再点「进入老板模式」按钮
    const boss = a.boss === true || a.phone === BOSS_PHONE;
    return { ok: true, isAdmin: true, canBoss: boss, boss, user: publicUser(a) };
  }

  // 1. 业务员已绑定：直接返回（审核通过后 openid 已写入，免登录）
  const bound = await users.where({ openid: OPENID, active: true }).get();
  if (bound.data.length > 0) {
    // 2026-09-09 老板报障修复：同一 openid 可能同时命中「实习」与正式账号（实习可任意绑定）；
    // 正式业务员优先——多命中时非 trial 的排在前面
    const u = bound.data.slice().sort((a, b) => (a.trial ? 1 : 0) - (b.trial ? 1 : 0))[0];
    await users.doc(u._id).update({ data: { lastLoginAt: Date.now() } });
    // 老板手机号兜底（口径与 tasks/visits 云函数一致：仅管理员角色认 boss）
    const boss = ['super_admin', 'admin'].includes(u.role) && (u.boss === true || u.phone === BOSS_PHONE);
    // 2026-09-09 开发者范宇琨双身份：dev 白名单返回 dev 标志 → 前端显示「业务员/老板」两按钮选择页
    const dev = u.phone === DEV_PHONE;
    // 2026-09-10 老板定：老板模式登录顺带下发「欢迎仪式」配置（每次登录一次查询，仅老板触发）
    if (boss) return { ok: true, boss, dev, user: publicUser(u), welcome: await readWelcomeCfg() };
    return { ok: true, boss, dev, user: publicUser(u) };
  }

  // 2. 【已移除，2026-09-10 老板定：实习角色永远不能绑定】原 bindUserId 游客绑定入口删除——
  //    未注册微信每次进来都是注册表单，随时可自己注册，不再被绑定成实习身份。
  //    兼容：旧前端若仍传 bindUserId，一律忽略并走下方注册状态流程。

  // 3. 注册申请（2026-09-09 老板拍板：姓名+手机号 → 后台审核）
  if (event.action === 'register') return await register(OPENID, event);

  // 3.5 微信一键验证手机号（2026-09-09 老板定：getPhoneNumber 快速验证组件——
  //     微信向用户发验证码短信，确认后返回该微信绑定的真实手机号；前端自动填入注册表单）
  if (event.action === 'verifyPhone') return await verifyPhone(event);

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
  // 游客入口信息（2026-09-10 老板定：实习角色永远不能绑定——不再返回 trialId，前端无游客入口）
  return { ok: false, code: 'NEED_REGISTER', msg: '请注册后等待审核' };
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
    // 谁用老板号注册谁就是老板。
    // 顺序刻意：先激活老板账号（成功拿到 bossId），再清理其它绑定——
    // 若先解绑后绑定，中间失败会让该微信失去全部身份（2026-09-09 专业审查修正）。
    const exist = await users.where({ phone: BOSS_PHONE }).get();
    let bossId;
    if (exist.data.length) {
      const doc = exist.data[0];
      bossId = doc._id;
      await users.doc(bossId).update({
        data: { openid: OPENID, name, role: 'admin', boss: true, active: true, lastLoginAt: Date.now() }
      });
    } else {
      const add = await users.add({
        data: {
          openid: OPENID, name, phone: BOSS_PHONE,
          role: 'admin', boss: true, active: true, trial: false,
          remark: '老板手机号注册（免审核）', createdAt: Date.now(), lastLoginAt: Date.now()
        }
      });
      bossId = add._id;
    }
    // 清理：本微信此前绑定的其它账号（含 trial/测试账号）一律解绑（老板账号自身排除）
    await users.where({ _id: _.neq(bossId), openid: OPENID }).update({ data: { openid: '' } });
    // 清理：该微信此前提交的普通注册申请若还在待审核，标记已升级（否则后台留下永挂的幽灵记录）
    try {
      await db.collection('registrations').where({ openid: OPENID, status: 'pending' }).update({
        data: { status: 'rejected', reason: '该微信已通过老板手机号注册，自动升级', reviewedAt: Date.now() }
      });
    } catch (e) { /* 集合异常不阻断老板激活 */ }
    const u = await users.doc(bossId).get();
    return { ok: true, boss: true, user: publicUser(u.data), welcome: await readWelcomeCfg(), msg: '老板身份已激活' };
  }

  let pend = { total: 0 };
  try {
    pend = await db.collection('registrations').where({ openid: OPENID, status: 'pending' }).count();
  } catch (e) { /* 集合异常降级：按无待审申请处理，允许提交 */ }
  if (pend.total > 0) return { ok: false, code: 'PENDING', msg: '申请已提交，请等待管理员审核' };
  await db.collection('registrations').add({
    data: {
      openid: OPENID, name, phone, status: 'pending', reason: '', createdAt: Date.now(),
      phoneVerified: !!e.phoneVerified // 2026-09-09 老板定：微信一键验证过的手机号打标，后台审核可见
    }
  });
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
  return { _id: u._id, name: u.name, phone: u.phone, role: u.role, trial: !!u.trial };
}
