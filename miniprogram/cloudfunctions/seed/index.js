// 云函数 seed：演示数据（一次性开发验证用，幂等）
// 预置：6 个客户（商城客户 3 + 新客户 3）+ 1 个已发布任务（丰炳全）+ 服务单提醒模板参数
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TEMPLATE_ID = 'tCQ_Xi5OaMQ9t9-UX9NeEZ4Tv4nHJ-L1PAEVWOdDhxs';

const CUSTOMERS = [
  // 商城客户
  { name: '正宗淮南牛肉汤西站店', customerType: 'mall', address: '永康市西城街道双飞路16-1号', lat: 28.9210, lng: 120.1536, phone: '15958422611', contactName: '朱来安', mallAddedAt: '2026-04-12', lastOrderAt: '2026-04-18', lastBrowseAt: '2026-07-21', remark: '喜欢 650 方盒大，白色优先', coord_status: 'ok' },
  { name: '贵州安顺快餐小炒李', customerType: 'mall', address: '永康市古山镇古后路148号', lat: 28.9155, lng: 120.1482, phone: '15925930748', contactName: '李老板', mallAddedAt: '2026-04-10', lastOrderAt: '2026-04-16', lastBrowseAt: '2026-07-19', remark: '每天用盒量约 200 个', coord_status: 'ok' },
  { name: '江西大众小炒王', customerType: 'mall', address: '永康市古山镇广源路121号', lat: 28.9180, lng: 120.1450, phone: '15979355201', contactName: '王老板', mallAddedAt: '2026-05-01', lastOrderAt: '2026-05-06', lastBrowseAt: '2026-07-22', remark: '价格敏感，可报阶梯价', coord_status: 'ok' },
  // 新客户
  { name: '老王砂锅店', customerType: 'new', address: '永康市东城街道长恬新村八街38号', lat: 28.9344, lng: 120.1601, phone: '', contactName: '', mallJoinedAt: null, joinedVia: null, remark: '老板表格导入 · 2026-07-20', coord_status: 'ok' },
  { name: '阿明烧烤', customerType: 'new', address: '永康市古山镇经纬东路185号旁', lat: 28.9202, lng: 120.1640, phone: '', contactName: '', mallJoinedAt: null, joinedVia: null, remark: '老板表格导入 · 2026-07-20', coord_status: 'ok' },
  { name: '小李面馆', customerType: 'new', address: '永康市古山镇飞腾路与金都路交叉口', lat: 28.9255, lng: 120.1555, phone: '', contactName: '', mallJoinedAt: null, joinedVia: null, remark: '业务员扫街发现 · 待确认', coord_status: 'ok' }
];

exports.main = async () => {
  const log = [];
  const custIds = [];

  // 1. 客户（按店名去重）
  for (const c of CUSTOMERS) {
    const exist = await db.collection('customers').where({ name: c.name }).count();
    if (exist.total === 0) {
      const add = await db.collection('customers').add({ data: { ...c, coord_status: c.coord_status || 'ok', status: 'active', createdAt: Date.now() } });
      custIds.push(add._id);
      log.push(`客户 ${c.name}: 新建`);
    } else {
      const got = await db.collection('customers').where({ name: c.name }).get();
      custIds.push(got.data[0]._id);
      log.push(`客户 ${c.name}: 已存在`);
    }
  }

  // 2. 业务员丰炳全
  const smRes = await db.collection('users').where({ name: '丰炳全' }).get();
  if (!smRes.data.length) { log.push('业务员丰炳全: 不存在，请先跑 init'); return { ok: false, log }; }
  const sm = smRes.data[0];

  // 2.5 业务员程绍君（新客开发任务用）
  const sm2Res = await db.collection('users').where({ name: '程绍君' }).get();
  const sm2 = sm2Res.data[0] || sm;

  // 3. 任务（按任务名去重）
  const taskName = '古山镇沉睡客户激活 · 第一批（演示）';
  const exist = await db.collection('tasks').where({ name: taskName }).count();
  if (exist.total === 0) {
    await db.collection('tasks').add({
      data: {
        name: taskName,
        salesmanId: sm._id,
        salesmanName: sm.name,
        customerIds: custIds,
        deadline: '2026-07-26',
        status: 'published',
        plannedDays: 3,
        dayPlan: [
          { day: 1, customerIds: custIds.slice(0, 2) },
          { day: 2, customerIds: custIds.slice(2, 4) },
          { day: 3, customerIds: custIds.slice(4, 6) }
        ],
        purpose: 'activate',
        sentAt: Date.now(),
        createdAt: Date.now()
      }
    });
    log.push(`任务 ${taskName}: 已创建（${custIds.length} 家客户，3 天排期）`);
  } else {
    log.push(`任务 ${taskName}: 已存在`);
  }

  // 3.5 新客开发任务（演示双目的 ✓）
  const newTaskName = '东城街道新客开发 · 第一批（演示）';
  const exist2 = await db.collection('tasks').where({ name: newTaskName }).count();
  const newCustIds = custIds.filter((_, i) => i >= 3); // 后 3 家是新客户
  if (exist2.total === 0) {
    await db.collection('tasks').add({
      data: {
        name: newTaskName,
        salesmanId: sm2._id,
        salesmanName: sm2.name,
        customerIds: newCustIds,
        deadline: '2026-07-28',
        status: 'published',
        plannedDays: 2,
        dayPlan: [
          { day: 1, customerIds: newCustIds.slice(0, 2) },
          { day: 2, customerIds: newCustIds.slice(2) }
        ],
        purpose: 'develop',
        sentAt: Date.now(),
        createdAt: Date.now()
      }
    });
    log.push(`任务 ${newTaskName}: 已创建（${newCustIds.length} 家新客户，目的=新客开发）`);
  } else {
    log.push(`任务 ${newTaskName}: 已存在`);
  }

  // 3.6 范宇琨（老板测试账号）演示任务：混合客户（2 商城 + 1 新客户）
  const fRes = await db.collection('users').where({ name: '范宇琨' }).get();
  if (fRes.data.length) {
    const fu = fRes.data[0];
    const fuTaskName = '东城街道回访示范 · 范宇琨（演示）';
    const fuExist = await db.collection('tasks').where({ name: fuTaskName }).count();
    const fuCustIds = [custIds[0], custIds[1], custIds[4]];
    if (fuExist.total === 0) {
      await db.collection('tasks').add({
        data: {
          name: fuTaskName,
          salesmanId: fu._id,
          salesmanName: fu.name,
          customerIds: fuCustIds,
          deadline: '2026-07-27',
          status: 'published',
          plannedDays: 2,
          dayPlan: [
            { day: 1, customerIds: fuCustIds.slice(0, 2) },
            { day: 2, customerIds: fuCustIds.slice(2) }
          ],
          purpose: 'activate',
          sentAt: Date.now(),
          createdAt: Date.now()
        }
      });
      log.push(`任务 ${fuTaskName}: 已创建（${fuCustIds.length} 家客户，测试账号）`);
    } else {
      log.push(`任务 ${fuTaskName}: 已存在`);
    }
  }

  return { ok: true, templateId: TEMPLATE_ID, log };
};
