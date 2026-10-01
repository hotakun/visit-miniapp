// 给 customers 集合建索引（走微信服务端 HTTP API：POST /tcb/updateindex）
// 用法：cd admin && node tools/add_index.js
// 凭据来自 admin/config.json（appid / appsecret / envId）—— 与 check.js 同一套，只读不打印。
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

// 2026-09-26：三层入口（城市/区域/商圈）+ 点评导入匹配 + 列表排序 需要的索引
const IDX = [
  { coll: 'customers', name: 'platShopUuid', keys: [{ name: 'platShopUuid', direction: '1' }] },  // ⭐ 导入每行按它查，刚需
  { coll: 'customers', name: 'city',         keys: [{ name: 'city',         direction: '1' }] },
  { coll: 'customers', name: 'district',     keys: [{ name: 'district',     direction: '1' }] },
  { coll: 'customers', name: 'bizCircle',    keys: [{ name: 'bizCircle',    direction: '1' }] },
  { coll: 'customers', name: 'createdAt',    keys: [{ name: 'createdAt',    direction: '-1' }] }, // 客户列表按它倒序翻页
  // ⭐ 2026-09-27 M2b：按页聚合（custPageAgg）要按 customerCode / customerId 查 → 没索引会全表扫
  { coll: 'orders', name: 'customerCode', keys: [{ name: 'customerCode', direction: '1' }] },
  { coll: 'visits', name: 'customerId',   keys: [{ name: 'customerId',   direction: '1' }] },
  // ⭐ 2026-09-28 新增：「加新店」的识别数据（biz_index）—— 云函数按 lat/lng 范围拉附近的点，
  //   没这个索引就会全表扫 7 万条（慢、且白费读次数）
  { coll: 'biz_index', name: 'lat_lng', keys: [{ name: 'lat', direction: '1' }, { name: 'lng', direction: '1' }] },
  // ⭐⭐ 2026-09-29 补上（老板报"50 米内店名电话一模一样，防重检测都毫无反应"）：
  //   防重的 dupCheck 查的是 **`customers` 的 lat + lng 两个范围条件** —— 而这个集合一直**没有坐标索引**，
  //   查询失败后又被 `.catch(() => ({ data: [] }))` 吞成"附近没有店"，所以怎么测都毫无反应。
  //   对照：区域/商圈识别查的是 `biz_index`，那个有 lat_lng，所以一直是准的 —— 两个症状正好对上。
  { coll: 'customers', name: 'lat_lng', keys: [{ name: 'lat', direction: '1' }, { name: 'lng', direction: '1' }] },
];

(async () => {
  if (!cfg.appid || !cfg.appsecret) { console.log('❌ config.json 里缺 appid / appsecret'); process.exit(1); }
  if (!cfg.envId) { console.log('❌ config.json 里缺 envId'); process.exit(1); }
  console.log('环境 envId = ' + cfg.envId);

  const tRes = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  const t = await tRes.json();
  if (!t.access_token) {
    console.log('❌ 取 access_token 失败：', t.errmsg || '', '(' + t.errcode + ')');
    if (t.errcode === 40164) console.log('   40164 = 调用来源 IP 不在白名单（去 mp 后台把本机公网 IP 加白）');
    process.exit(1);
  }
  console.log('✅ access_token 获取成功');

  for (const ix of IDX) {
    const body = { env: cfg.envId, collection_name: ix.coll || 'customers', create_indexes: [{ name: ix.name, keys: ix.keys }] };
    let r = {};
    try {
      const res = await fetch(`https://api.weixin.qq.com/tcb/updateindex?access_token=${t.access_token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      r = await res.json();
    } catch (e) {
      console.log('  ❌ 索引 ' + ix.name + '：请求异常 ' + ((e && e.message) || e));
      continue;
    }
    if (r.errcode === 0) console.log('  ✅ 索引 ' + ix.name + ' 已受理（云端开始构建，几秒~几分钟生效）');
    else console.log('  ⚠️ 索引 ' + ix.name + '：' + (r.errmsg || JSON.stringify(r)) + '（errcode=' + r.errcode + '）');
  }
  console.log('完成。可去 云开发控制台 → 数据库 → customers → 索引管理 看列表。');
})();
