// 云函数 init：初始化数据库（建集合 + 预置超级管理员卿燕 + 3 名业务员）
// 用法：上传部署后在云开发控制台手动运行一次（或开发者工具中右键"云端测试"）
// 幂等：按 username/phone 去重，可重复执行
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const COLLECTIONS = ['users', 'customers', 'tasks', 'visits', 'orders', 'import_batches', 'settings', 'coord_fix_requests', 'salesman_locations', 'mall_claims', 'mall_customers', 'customer_batches', 'batch_members'];

const SUPER_ADMIN = {
  username: 'qingyan',
  passwordHash: sha256('123456'), // ⚠️ 上线后请老板在后台改密码（或直接改此值后重新执行）
  name: '卿燕',
  phone: '',
  role: 'super_admin',
  active: true,
  createdAt: Date.now()
};

const SALESMEN = [
  { name: '丰炳全', phone: '13894080558' },
  { name: '程绍君', phone: '18867597219' },
  { name: '宋子军', phone: '18968090390' },
  { name: '范宇琨', phone: '13067737286', remark: '老板测试账号' }
];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return `${name}: 新建`;
  } catch (e) {
    return `${name}: 已存在`;
  }
}

exports.main = async () => {
  const log = [];

  // 1. 建集合
  for (const c of COLLECTIONS) {
    log.push(await ensureCollection(c));
  }

  // 2. 预置超级管理员（按 username 去重）
  const adminExist = await db.collection('users').where({ username: SUPER_ADMIN.username }).count();
  if (adminExist.total === 0) {
    await db.collection('users').add({ data: SUPER_ADMIN });
    log.push('管理员 卿燕（qingyan）: 已创建');
  } else {
    log.push('管理员 卿燕（qingyan）: 已存在，跳过');
  }

  // 3. 预置业务员（按手机号去重）
  for (const s of SALESMEN) {
    const exist = await db.collection('users').where({ phone: s.phone, role: 'salesman' }).count();
    if (exist.total === 0) {
      await db.collection('users').add({
        data: {
          openid: '', // 业务员首次登录小程序时自动绑定
          name: s.name,
          phone: s.phone,
          role: 'salesman',
          active: true,
          remark: s.remark || '',
          createdAt: Date.now()
        }
      });
      log.push(`业务员 ${s.name}（${s.phone}）: 已创建`);
    } else {
      log.push(`业务员 ${s.name}（${s.phone}）: 已存在，跳过`);
    }
  }

  // 4. 预置系统设置默认值（定位校验开启 500 米 / 比对窗口 30 天 / 每日拜访上限 0=不限（当日可多次拜访）/ 手机号任务内可见 / 录音 5 分钟 / 任务结束需管理员确认=false）
  const settings = [
    { key: 'locationCheck', value: { enabled: true, threshold: 500 } },
    { key: 'compareWindowDays', value: 30 },
    { key: 'dailyVisitLimit', value: 0 },
    { key: 'phoneVisibility', value: 'task' },
    { key: 'recordingDurationLimit', value: 300 },
    { key: 'needFinishReview', value: false }
  ];
  for (const s of settings) {
    const exist = await db.collection('settings').where({ key: s.key }).count();
    if (exist.total === 0) {
      await db.collection('settings').add({ data: { key: s.key, value: s.value, updatedAt: Date.now() } });
      log.push(`设置 ${s.key}: 已写入默认值`);
    } else {
      log.push(`设置 ${s.key}: 已存在，跳过`);
    }
  }

  return { ok: true, log };
};
