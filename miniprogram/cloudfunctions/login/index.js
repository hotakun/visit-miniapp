// 云函数 login：业务员微信登录 / 首次绑定
// 流程：未绑定 openid 的业务员首次登录选择自己的姓名完成绑定，之后微信自动识别
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { bindUserId } = event || {};

  const users = db.collection('users');
  const _ = db.command;

  // 0. 管理员识别（super_admin / admin）：管理员微信打开小程序 → 仅提示使用 Web 后台
  const adminRes = await users.where({ openid: OPENID, active: true, role: _.in(['super_admin', 'admin']) }).get();
  if (adminRes.data.length > 0) {
    const a = adminRes.data[0];
    await users.doc(a._id).update({ data: { lastLoginAt: Date.now() } });
    return { ok: true, isAdmin: true, user: publicUser(a) };
  }

  // 1. 业务员已绑定：直接返回
  const bound = await users.where({ openid: OPENID, active: true }).get();
  if (bound.data.length > 0) {
    const u = bound.data[0];
    await users.doc(u._id).update({ data: { lastLoginAt: Date.now() } });
    return { ok: true, user: publicUser(u) };
  }

  // 2. 未绑定 + 指定绑定人：校验并绑定
  if (bindUserId) {
    const target = await users.doc(bindUserId).get().catch(() => null);
    const t = target && target.data;
    if (!t) return { ok: false, code: 'USER_NOT_FOUND', msg: '人员不存在' };
    if (t.role !== 'salesman') return { ok: false, code: 'NOT_SALESMAN', msg: '该人员不是业务员' };
    if (t.openid && t.openid !== OPENID && !t.trial) return { ok: false, code: 'ALREADY_BOUND', msg: '该账号已被其他微信绑定' };
    // 游客体验账号（trial，2026-09-08 老板定）：允许任意微信绑定/覆盖——小程序审核/演示用
    await users.doc(bindUserId).update({ data: { openid: OPENID, lastLoginAt: Date.now() } });
    const u = await users.doc(bindUserId).get();
    return { ok: true, user: publicUser(u.data) };
  }

  // 3. 未绑定：返回可绑定业务员列表（仅未绑定且启用的；手机号打码保护隐私）；
  //    游客体验账号（trial）恒可绑并置顶（供审核/演示人员直接点击登录）
  const cand = await users.where({ role: 'salesman', active: true }).get();
  const list = cand.data
    .filter(x => !x.openid || x.trial)
    .map(x => ({ _id: x._id, name: x.name, phone: maskPhone(x.phone), trial: !!x.trial }))
    .sort((a, b) => (b.trial ? 1 : 0) - (a.trial ? 1 : 0));
  return { ok: false, code: 'NEED_BIND', salesmen: list, msg: '请选择你的姓名完成绑定' };
};

function maskPhone(p) {
  if (!p || p.length < 11) return p || '';
  return p.slice(0, 3) + '****' + p.slice(7);
}

function publicUser(u) {
  return { _id: u._id, name: u.name, phone: u.phone, role: u.role, trial: !!u.trial };
}
