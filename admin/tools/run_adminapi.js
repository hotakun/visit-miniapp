// 调云函数（绕过开发者工具，走微信服务端 HTTP API）
// 用法（**在 cmd 里也能直接用，不用凑引号**）：
//   node admin\tools\run_adminapi.js <action>
//   node admin\tools\run_adminapi.js <action> <username> <password>
//   node admin\tools\run_adminapi.js <action> <任意 JSON>        （以 { 开头就当成 JSON 参数）
// 例：
//   node admin\tools\run_adminapi.js fixLegacyPendingCoords
//   node admin\tools\run_adminapi.js stats qingyan 123456
// 凭据来源：admin/config.json（appid / appsecret / envId，只读不打印）
//           账号密码默认 qingyan / 123456（可用第 2、3 个参数覆盖）
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const action = String(process.argv[2] || '').trim();
const a3 = String(process.argv[3] || '').trim();
const a4 = String(process.argv[4] || '').trim();
let extra = {};
if (a3.charAt(0) === '{') {
  try { extra = JSON.parse(a3); }
  catch (e) { console.log('❌ 第 2 个参数不是合法 JSON：' + e.message); process.exit(1); }
}
if (!action) {
  console.log('用法：node admin\\tools\\run_adminapi.js <action> [username] [password]');
  process.exit(1);
}
if (!cfg.appid || !cfg.appsecret || !cfg.envId) {
  console.log('❌ admin/config.json 缺 appid / appsecret / envId');
  process.exit(1);
}

(async () => {
  const tRes = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  const t = await tRes.json();
  if (!t.access_token) {
    console.log('❌ 取 access_token 失败：', t.errmsg || '', '(' + t.errcode + ')');
    if (t.errcode === 40164) console.log('   40164 = 本机公网 IP 不在白名单（去 mp 后台加白）');
    process.exit(1);
  }
  const body = Object.assign({ action, username: a4 ? a3 : (a3 && a3.charAt(0) !== '{' ? a3 : 'qingyan'), password: a4 || '123456' }, extra);
  const r = await (await fetch(`https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${t.access_token}&env=${cfg.envId}&name=adminapi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  if (r.errcode) {
    console.log('❌ 调用失败：', r.errmsg || '', '(' + r.errcode + ')');
    console.log('   （若报 NO_AUTH，说明账号密码不对；若报 -601008 是云函数超时）');
    process.exit(1);
  }
  let out = r.resp_data;
  try { out = JSON.parse(out); } catch (e) { /* 原样打印 */ }
  console.log('===== adminapi.' + action + ' 返回 =====');
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
})();
