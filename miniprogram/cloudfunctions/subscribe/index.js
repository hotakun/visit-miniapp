// 云函数 subscribe：保存业务员订阅消息授权（一次性订阅 token）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { token } = event || {};
  if (!token) return { ok: false, msg: '缺少 token' };

  const me = await db.collection('users').where({ openid: OPENID }).get();
  if (!me.data.length) return { ok: false, code: 'NO_AUTH', msg: '未登录' };

  const u = me.data[0];
  const exist = await db.collection('settings').where({ key: `subToken_${u._id}` }).count();
  const data = { key: `subToken_${u._id}`, value: { token, name: u.name, updatedAt: Date.now() } };
  if (exist.total) {
    await db.collection('settings').where({ key: `subToken_${u._id}` }).update({ data });
  } else {
    await db.collection('settings').add({ data });
  }
  return { ok: true, msg: '订阅授权已保存 ✓' };
};
