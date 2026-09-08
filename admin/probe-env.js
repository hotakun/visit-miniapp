// 环境探测脚本：node probe-env.js
// 用多种候选 env 写法逐个调用 ping 云函数，找出哪种写法能被免费环境识别
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

(async () => {
  console.log('===== 环境探测：测试 env 参数的不同写法 =====');
  const t = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  const tj = await t.json();
  if (!tj.access_token) { console.log('❌ token 获取失败：', tj.errmsg || tj.errcode); process.exit(1); }
  console.log('✅ access_token OK\n');

  // 候选：控制台显示 ID 的几种常见写法
  const base = cfg.envId; // cloud1-d0gwlmbwp31181eb5
  const candidates = [
    base,
    base.split('-')[0],                      // 仅 cloud1
    base.split('-').slice(1).join('-'),      // 去掉 cloud1-
    `wx-${base}`,                            // wx- 前缀
    base.toUpperCase(),
  ];
  const seen = new Set();
  for (const env of candidates) {
    if (seen.has(env)) continue;
    seen.add(env);
    try {
      const r = await fetch(`https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${tj.access_token}&env=${encodeURIComponent(env)}&name=ping`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      const j = await r.json();
      const ok = !j.errcode;
      console.log(`${ok ? '✅' : '❌'} env="${env}" → ${ok ? '成功：' + j.resp_data : j.errmsg + '(' + j.errcode + ')'}`);
      if (ok) {
        console.log('\n🎯 找到可用写法！请把它填入 admin/config.json 的 envId 字段：\n   ' + env);
        break;
      }
    } catch (e) {
      console.log(`❌ env="${env}" → 网络异常 ${e.message}`);
    }
  }
  console.log('\n如果全部失败：请把云开发控制台「环境设置」页完整截图发我（看环境ID/别名/旧ID），我再补候选写法。');
})();
