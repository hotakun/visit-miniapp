// 云函数 bindadmin：超级管理员微信身份绑定
// 用法：老板在开发者工具中对该函数「云端测试」，参数 {"code":"JuhuoAdmin2026"}
//      运行一次 → 当前微信 OPENID 即绑定到超级管理员「卿燕」账号（幂等，可重复执行）
// 说明：能以管理者身份操作云开发控制台即是身份验证，开通码仅存于本地资料文件。
const cloud = require('wx-server-sdk');
// ⭐ 2026-10-15 加固（依《全项目审查》S02）：**开通码优先从环境变量读** ——
//   这样"换码不必改代码"、代码里也不再唯一持有它（配了 `BINDADMIN_CODE` 就用它，没配退回下面这个兜底）。
//   ⚠️ 这个函数**必须允许带 OPENID**（它要绑的就是"当前这个微信"），所以只能靠开通码 + "绑过就不让换"来保护。
const BIND_CODE_DEFAULT = 'JuhuoAdmin2026'; // ⚠️ 建议换成环境变量 BINDADMIN_CODE 并改掉这里的兜底
const BIND_CODE = process.env.BINDADMIN_CODE || BIND_CODE_DEFAULT;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const code = (event && event.code) || '';

  if (code !== BIND_CODE) {
    return { ok: false, code: 'BAD_CODE', msg: '开通码不正确' };
  }

  const admin = await db.collection('users').where({ role: 'super_admin' }).get();
  if (!admin.data.length) return { ok: false, code: 'NO_ADMIN', msg: '未找到超级管理员，请先运行 init' };

  const a = admin.data[0];
  if (a.openid && a.openid !== OPENID) {
    return { ok: false, code: 'OTHER_BOUND', msg: '超级管理员已被其他微信绑定，如需换绑请联系开发者' };
  }

  await db.collection('users').doc(a._id).update({
    data: { openid: OPENID, lastLoginAt: Date.now() }
  });
  return { ok: true, msg: `超级管理员「${a.name}」微信绑定成功 ✓（openid 已写入）` };
};
