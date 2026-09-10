// admin/upload_dist.js
// 一键把本机后台包（admin.html + nt-map.js）上传到云端分发，
// 供文员端「设置 → 检查更新」拉取新版。
//
// 用法：双击 admin/上传后台到云端.bat ；或在本目录执行 node upload_dist.js
//
// 特点：
//   · 版本号自动从 admin.html 的 APP_VERSION 读取（不用手改，也不怕忘）
//   · 上传前先检测本地后台服务（8581）是否在跑，连不上会明确提示
//   · 上传后自动回查云端版本，核对是否与本地一致
//   · 凭据可用环境变量覆盖：ADMIN_USER / ADMIN_PWD / ADMIN_PORT
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.ADMIN_PORT || 8581;
const USER = process.env.ADMIN_USER || 'qingyan';
const PWD = process.env.ADMIN_PWD || '123456';
const CHUNK = 90000; // 必须与云函数 adminapi 的 DIST_CHUNK 一致

const dir = __dirname;
const htmlPath = path.join(dir, 'admin.html');
const mapPath = path.join(dir, 'nt-map.js');

if (!fs.existsSync(htmlPath)) { console.error('[X] 找不到 admin.html（本脚本需与它同目录）'); process.exit(1); }
const adminHtml = fs.readFileSync(htmlPath, 'utf8');

const mv = adminHtml.match(/const APP_VERSION\s*=\s*'([^']+)'/);
if (!mv) { console.error('[X] 未能从 admin.html 里读到 APP_VERSION，请检查该行是否被改动'); process.exit(1); }
const VERSION = mv[1];

let ntMapJs = '';
if (fs.existsSync(mapPath)) ntMapJs = fs.readFileSync(mapPath, 'utf8');
else console.log('[!] 未找到 nt-map.js，将跳过（不影响后台主体）');

function post(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('返回非 JSON: ' + out.slice(0, 160))); } });
    });
    req.setTimeout(timeoutMs || 20000, () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function uploadKind(kind, text) {
  const total = Math.ceil(text.length / CHUNK) || 1;
  console.log('  → ' + kind + '：' + text.length + ' 字符 / ' + total + ' 片');
  for (let p = 0; p < total; p++) {
    const content = text.slice(p * CHUNK, (p + 1) * CHUNK);
    const r = await post({ action: 'uploadAdminDist', kind, part: p, total, content, version: VERSION, username: USER, password: PWD });
    if (!r || !r.ok) throw new Error(kind + ' 第 ' + (p + 1) + '/' + total + ' 片失败：' + ((r && r.msg) || '未知错误'));
    process.stdout.write('     片 ' + (p + 1) + '/' + total + ' OK\n');
  }
}

(async () => {
  console.log('==============================================');
  console.log(' 上传后台到云端（版本 ' + VERSION + '）');
  console.log('==============================================');
  console.log(' 本地文件：admin.html ' + adminHtml.length + ' 字符' + (ntMapJs ? '，nt-map.js ' + ntMapJs.length + ' 字符' : ''));

  // ① 检测本地后台服务
  let meta;
  try {
    meta = await post({ action: 'getAdminDistMeta' }, 8000);
  } catch (e) {
    console.error('');
    console.error('[X] 连不上本地管理后台（127.0.0.1:' + PORT + '）：' + e.message);
    console.error('    请先双击「启动管理后台.bat」，等后台窗口起来后再运行本工具。');
    process.exit(1);
  }
  if (!meta || !meta.ok) {
    console.error('[X] 云端分发读取失败：' + ((meta && meta.msg) || '未知错误'));
    console.error('    若是「登录失效」，请把本脚本里的 ADMIN_USER / ADMIN_PWD 换成有效管理员账号。');
    process.exit(1);
  }
  console.log(' 云端当前版本：v' + (meta.version || '—'));
  if (meta.version === VERSION) {
    console.log('');
    console.log('[i] 云端已经是 v' + VERSION + '，内容相同也重新上传一遍（幂等，可放心执行）。');
  }

  // ② 分片上传
  console.log('');
  console.log(' 开始上传…');
  await uploadKind('adminHtml', adminHtml);
  if (ntMapJs) await uploadKind('ntMapJs', ntMapJs);

  // ③ 回查核对
  const after = await post({ action: 'getAdminDistMeta' }, 8000);
  console.log('');
  if (after && after.ok && after.version === VERSION) {
    console.log('[OK] 上传完成，云端版本已更新为 v' + after.version);
    console.log('     文员端：打开后台 → 设置页 → 检查更新 → 立即更新');
  } else {
    console.error('[X] 上传后核对失败：云端版本=' + ((after && after.version) || '—') + '，期望=' + VERSION);
    process.exit(1);
  }
})().catch(e => { console.error(''); console.error('[X] ' + e.message); process.exit(1); });
