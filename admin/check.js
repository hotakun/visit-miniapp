// 自检脚本：node check.js —— 验证「获取 token → 调云函数」整条链路
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

(async () => {
  console.log('===== 聚火拜访 · 后台链路自检 =====');
  if (!cfg.appsecret) { console.log('❌ config.json 未填 appsecret，请先到 mp 后台获取并填入'); process.exit(1); }

  // 1. 获取 access_token
  console.log('① 获取 access_token …');
  const tRes = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  const tj = await tRes.json();
  if (!tj.access_token) { console.log('❌ 失败：', tj.errmsg || tj.errcode, '（40164=IP 白名单拦截）'); process.exit(1); }
  console.log('✅ access_token 获取成功（有效期', tj.expires_in, '秒）');

  // 2. 调 ping 云函数
  console.log('② 调用云函数 ping …');
  const pRes = await fetch(`https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${tj.access_token}&env=${cfg.envId}&name=ping`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  const pj = await pRes.json();
  if (pj.errcode) { console.log('❌ 调用失败：', pj.errmsg, '(' + pj.errcode + ')'); process.exit(1); }
  console.log('✅ ping 返回：', pj.resp_data);

  // 3. 调 adminapi.login（qingyan / 123456）
  console.log('③ 登录自检（qingyan / 123456）…');
  const lRes = await fetch(`https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${tj.access_token}&env=${cfg.envId}&name=adminapi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', username: 'qingyan', password: '123456' })
  });
  const lj = await lRes.json();
  if (lj.errcode) { console.log('❌ 调用失败：', lj.errmsg, '(' + lj.errcode + ')'); process.exit(1); }
  let out = lj.resp_data;
  try { out = JSON.parse(out); } catch (e) {}
  if (out && out.ok) { console.log('✅ 管理员登录验证成功：', out.admin); }
  else { console.log('⚠️ 登录返回：', out, '（可能是 init 未跑或密码已改）'); }

  console.log('===== 自检结束 =====');
  console.log('全部 ✅ 则可以直接启动后台：双击 启动管理后台.bat → 浏览器 http://localhost:8080');
})();
