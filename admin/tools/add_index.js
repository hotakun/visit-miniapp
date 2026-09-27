// 给 customers 集合建索引（走微信服务端 HTTP API：POST /tcb/updateindex）
// 用法：cd admin && node tools/add_index.js
// 凭据来自 admin/config.json（appid / appsecret / envId）—— 与 check.js 同一套，只读不打印。
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

// 2026-09-26：三层入口（城市/区域/商圈）+ 点评导入匹配 + 列表排序 需要的索引
const IDX = [
  { name: 'platShopUuid', keys: [{ name: 'platShopUuid', direction: '1' }] },  // ⭐ 导入每行按它查，刚需
  { name: 'city',         keys: [{ name: 'city',         direction: '1' }] },
  { name: 'district',     keys: [{ name: 'district',     direction: '1' }] },
  { name: 'bizCircle',    keys: [{ name: 'bizCircle',    direction: '1' }] },
  { name: 'createdAt',    keys: [{ name: 'createdAt',    direction: '-1' }] }, // 客户列表按它倒序翻页
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
    const body = { env: cfg.envId, collection_name: 'customers', create_indexes: [ix] };
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
