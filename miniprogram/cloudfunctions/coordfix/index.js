// 云函数 coordfix：业务员位置报错上报（当前定位上传新坐标，后台审核修正）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { customerId, lat, lng, note = '', photos } = event || {};

  const me = await db.collection('users').where({ openid: OPENID }).get();
  if (!me.data.length) return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  // 老板模式（2026-09-09 §7.13 修订：仅 boss===true 的指定管理员账号启用老板页面，报错走完校验后模拟提交）
  const isBoss = ['super_admin', 'admin'].includes(me.data[0].role) && me.data[0].boss === true;
  if (!customerId || !lat || !lng) return { ok: false, code: 'BAD_ARG', msg: '缺少坐标' };
  if (lat < 18 || lat > 54 || lng < 73 || lng > 135) return { ok: false, code: 'BAD_COORD', msg: '坐标范围异常' };
  const noteText = String(note || '').trim().slice(0, 100);
  // 现场照片（2026-09-08 真拍照启用）：{fileID, thumbID}[] ≤3（兼容旧 string[] 单字段）
  const photoList = Array.isArray(photos) ? photos.slice(0, 3).map(p => {
    if (typeof p === 'string' && p) return { fileID: p, thumbID: '' };
    if (p && typeof p.fileID === 'string' && p.fileID) return { fileID: p.fileID, thumbID: (typeof p.thumbID === 'string' && p.thumbID) ? p.thumbID : '' };
    return null;
  }).filter(Boolean) : [];

  const cRes = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!cRes || !cRes.data) return { ok: false, code: 'CUST_NOT_FOUND', msg: '客户不存在' };

  // 同客户 24 小时内重复上报去重
  const dup = await db.collection('coord_fix_requests')
    .where({ customerId, status: 'pending' })
    .count();
  if (dup.total > 0) return { ok: false, code: 'DUPLICATED', msg: '该客户已有待处理的报错申请，请勿重复提交' };

  // 老板模式（2026-09-09 §7.13）：模拟提交成功，不落库（后台审核列表不可见）
  if (isBoss) return { ok: true, boss: true, msg: '已提交，管理员审核后将更新客户坐标 ✓（演示：未保存）' };

  await db.collection('coord_fix_requests').add({
    data: {
      customerId,
      salesmanId: me.data[0]._id,
      newLat: lat,
      newLng: lng,
      note: noteText,
      photos: photoList,
      status: 'pending',
      createdAt: Date.now()
    }
  });
  return { ok: true, msg: '已提交，管理员审核后将更新客户坐标 ✓' };
};
