// 云函数 coordfix：业务员位置报错上报（当前定位上传新坐标，后台审核修正）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { customerId, lat, lng, note = '', photos } = event || {};

  const me = await db.collection('users').where({ openid: OPENID }).get();
  // 2026-09-28：同一 openid 可能**同时绑「实习(trial)」与正式账号**（开发者点「以游客身份进入」）。
  //   默认正式优先（显式定序）；请求带 asTrial → trial 账号排最前（下面 me.data[0] 自动取它）。
  // ⭐⭐ 2026-09-28 晚修【重大错误】：**实习声明优先于 openid 认人**
  //   背景：开发者（范宇琨）的微信 openid 早就绑了**正式业务员账号**；而「实习体验入口」按老板口径
  //   **不绑定 openid**。原来只在「openid 查不到人」时才拿 trialId 核对 →
  //   他点实习进来时 openid 查到了正式账号 → **认成业务员**（老板报的正是这个）。
  //   现在：声明实习(asTrial) 且带 trialId → **先**拿 trialId 核对（role=salesman + trial=true），
  //   核对通过就直接用它，不再看 openid 绑的是谁。⚠️ 只信库里的数据。
  {
    const _asT = !!(event && (event.asTrial === true || event.asTrial === 'true'));
    const _tid = String((event && event.trialId) || '');
    let _picked = null;
    if (_asT && _tid) {
      const _one = await db.collection('users').doc(_tid).get().catch(() => null);
      const _u = _one && _one.data;
      if (_u && _u.role === 'salesman' && _u.trial === true) _picked = _u;
    }
    if (_picked) {
      me.data = [_picked];
    } else {
      const _l = me.data.slice();
      const _tr = _l.filter(x => x.trial);
      me.data = (_asT && _tr.length) ? _tr.concat(_l.filter(x => !x.trial)) : _l.sort((a, b) => (a.trial ? 1 : 0) - (b.trial ? 1 : 0));
    }
  }
  if (!me.data.length) return { ok: false, code: 'NO_AUTH', msg: '未登录' };
  // ⭐ 2026-10-07 补：**老板兼业务员**（users.alsoSalesman）声明「以业务员身份进入」→ 本次请求**按业务员认人**
  //   （口径与 tasks / visits / transcribe 完全一致；此前 coordfix **偏偏漏了这一条** →
  //    朱小利以业务员身份报坐标错 / 现场提报时仍被判成老板 → **虚拟写、不落库**，后台永远收不到。
  //    现象就是"我明明选了业务员身份，报错还是提交不上去"。）
  //   ⚠️ 只信库里的 alsoSalesman 标记：声明只能"降权"（老板→业务员），不可能提权。
  const asSalesman = !!(event && (event.asSalesman === true || event.asSalesman === 'true'))
    && me.data[0].alsoSalesman === true;
  // ⭐ 2026-09-27 新增：**现场提报**（招牌菜 / 设施 / 团购外卖点改 —— 修正 008 的提报审核链路）。
  //   action 缺省 = 'coord'（坐标报错，下面原逻辑一行不变）
  const action = String((event && event.action) || 'coord').trim();
  if (action === 'field') {
    const isBossF = !asSalesman && (['super_admin', 'admin'].includes(me.data[0].role)
      || (me.data[0].phone === '13067737286' && event && event.boss === true));
    return await submitField(me.data[0], event || {}, isBossF);
  }
  // 老板模式（2026-09-10 老板定：管理员模式与老板模式合并——管理员（super_admin/admin）一律按老板处理，
  // 不再看 boss 白名单字段；手机号=15055492888 为老板本人，字段保留仅作历史兜底）
  // 2026-09-09 开发者范宇琨双身份：dev 白名单（13067737286）且请求带 boss 标志 → 按老板处理（模拟提交）
  const isBoss = !asSalesman && (['super_admin', 'admin'].includes(me.data[0].role)
    || (me.data[0].phone === '13067737286' && event && event.boss === true));
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

  // 老板模式（2026-09-09 §7.13）：模拟提交成功，**不落库**（后台审核列表不可见）
  //   ⚠️ 必须放在下面"作废旧记录"之前 —— 老板模式连库都不该碰。
  if (isBoss) return { ok: true, boss: true, msg: '已提交，管理员审核后将更新客户坐标 ✓（演示：未保存）' };

  // ⭐ 2026-09-28 晚老板定：**允许重复提交**（原来"同客户已有 pending 就拒绝"的规则**已作废**）——
  //   再次提交时，把该客户**旧的 pending 记录全部作废**（status → 'superseded'），再写入新的。
  //   后台审核列表查的是 `{ status: 'pending' }` → 于是**只显示最后一次提交的那条**，
  //   天然做到"审核端以最后一次提交的数据为准"；旧记录仍留库（可追溯谁在哪天改过），不删除。
  //   ⚠️ **别改回"拒绝重复"** —— 老板原话："应该可以重复提交，审核端以最后一次提交的数据为准"。
  try {
    await db.collection('coord_fix_requests')
      .where({ customerId, status: 'pending' })
      .update({ data: { status: 'superseded', supersededAt: Date.now(), supersededBy: me.data[0]._id } });
  } catch (e) { /* 老数据/权限异常都不影响提交，忽略 */ }

  await db.collection('coord_fix_requests').add({
    data: {
      type: 'coord',                       // ⭐ 2026-09-27：记录打类型（后台按 type 分流：坐标报错 / 现场提报）
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

// ⭐ 2026-09-27 新增：**现场提报**（招牌菜 / 设施 / 团购外卖点改）→ 落 coord_fix_requests（type='field', pending）
//   入参：{ customerId, kind: 'dish'|'fac'|'flag', value?, flagName?, flagTo? }
//   规则（修正 008）：游客（trial）不能录；老板模式**模拟成功不落库**；同客户同类型同值**去重**。
async function submitField(user, event, isBoss) {
  const customerId = String(event.customerId || '');
  const kind = String(event.kind || '').trim();
  const value = String(event.value || '').trim().slice(0, 40);
  const flagName = String(event.flagName || '');
  const flagTo = event.flagTo === true;
  if (!customerId) return { ok: false, code: 'BAD_ARG', msg: '缺少客户' };
  if (kind !== 'dish' && kind !== 'fac' && kind !== 'flag') return { ok: false, code: 'BAD_ARG', msg: '提报类型不对' };
  if (kind === 'flag') {
    if (flagName !== '团购' && flagName !== '外卖') return { ok: false, code: 'BAD_ARG', msg: '标签不对' };
  } else if (!value) {
    return { ok: false, code: 'BAD_ARG', msg: '内容不能为空' };
  }
  if (user && user.trial === true) return { ok: false, code: 'FORBIDDEN', msg: '试用账号不能提报' };
  const cRes = await db.collection('customers').doc(customerId).get().catch(() => null);
  if (!cRes || !cRes.data) return { ok: false, code: 'CUST_NOT_FOUND', msg: '客户不存在' };
  if (isBoss) return { ok: true, boss: true, msg: '已提报 ✓（演示：未保存）' };
  const dedupVal = kind === 'flag' ? (flagName + (flagTo ? '_1' : '_0')) : value;
  const dup = await db.collection('coord_fix_requests')
    .where({ customerId: customerId, status: 'pending', type: 'field', kind: kind, value: dedupVal })
    .count().catch(() => ({ total: 0 }));
  if (dup.total > 0) return { ok: false, code: 'DUPLICATED', msg: '这条已经提过了，等管理员审核' };
  await db.collection('coord_fix_requests').add({
    data: {
      type: 'field',
      customerId: customerId,
      salesmanId: (user && user._id) || '',
      salesmanName: (user && user.name) || '',
      kind: kind,
      value: dedupVal,
      flagName: kind === 'flag' ? flagName : '',
      flagTo: kind === 'flag' ? flagTo : false,
      status: 'pending',
      createdAt: Date.now()
    }
  });
  return { ok: true, msg: '已提报 ✓ 管理员审核后生效' };
}
