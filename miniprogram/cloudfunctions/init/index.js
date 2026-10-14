// 云函数 init：初始化数据库（建集合 + 预置超级管理员卿燕 + 3 名业务员）
// 用法：上传部署后在云开发控制台手动运行一次（或开发者工具中右键"云端测试"）
// 幂等：按 username/phone 去重，可重复执行
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const COLLECTIONS = ['users', 'customers', 'tasks', 'visits', 'orders', 'order_items', 'import_batches', 'settings', 'coord_fix_requests', 'salesman_locations', 'mall_claims', 'mall_customers', 'customer_batches', 'batch_members', 'registrations', 'transcripts', 'customer_remarks', 'biz_index', 'free_trips', 'free_trip_logs', 'customer_corrections', 'visit_deleted'];   // ⭐ 2026-10-15 加 visit_deleted（拜访「删除名单」，只给服务器同步器用；业务上仍不留痕）   // ⭐ 2026-10-10 加 customer_corrections（「更正信息」留痕）；⭐ 2026-10-03 加 free_trips（自由拜访卡，独立集合、不绑任务）；biz_index = 「加新店」的区域/商圈识别数据（2026-09-28）

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
  { name: '范宇琨', phone: '13067737286', remark: '开发者本人（测试账号；不是老板——真正的老板是朱小利 15055492888）' }
];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return `${name}: 新建`;
  } catch (e) {
    return `${name}: 已存在`;
  }
}

// ⭐⭐ 2026-10-15 加固（依《全项目审查》S02）：**`init` 原来不做任何鉴权** —— 任何能调云函数的微信用户
//   都能让它"建集合 + 预置超管/业务员"（虽然幂等、不会重置已有账号，但"能写业务库的入口"不该敞开）。
//   门禁（满足任一条即放行，两条都属于"运维侧"）：
//     ① **传对运维口令** —— 环境变量 `INIT_GUARD`（可选，想更严就配一个）；
//     ② **没有 OPENID** —— 平台定时器与 HTTP API（如 `node admin/tools/run_adminapi.js`）都没有，
//        而**小程序/客户端调用一定有 OPENID**（微信侧决定，伪造不了）。
//   ⚠️ 没配 `INIT_GUARD` 也照样能用：用 HTTP API 跑即可（`run_adminapi.js` 那套）。
//      ⚠️ 但**开发者工具里"云端测试"会带 OPENID** → 那种跑法在没配口令时会被拒（这是有意的）。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const guard = process.env.INIT_GUARD || '';
  const okGuard = !!guard && !!event && event.guard === guard;
  if (OPENID && !okGuard) {
    return { ok: false, code: 'NO_AUTH', msg: '无权执行 init（请在控制台/HTTP API 侧运行，或提供运维口令）' };
  }
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
