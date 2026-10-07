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

const PORT = process.env.ADMIN_PORT || 18080;
const USER = process.env.ADMIN_USER || 'qingyan';
const PWD = process.env.ADMIN_PWD || '123456';
const CHUNK = 90000; // 必须与云函数 adminapi 的 DIST_CHUNK 一致

const dir = __dirname;
const htmlPath = path.join(dir, 'admin.html');
const mapPath = path.join(dir, 'nt-map.js');
// ⭐ 2026-10-07 老板定「一劳永逸」：**后端文件也一起分发** ——
//   否则文员端会出现「新前端 + 旧后端」→ 前端调不到新接口 → **拉取数据全失败**（文员端实测踩过）。
//   ⚠️ 这两个文件文员端写盘后**需要重启后台**才生效（前端会提示）。
const backPath = path.join(dir, 'server.js');
const storePath = path.join(dir, 'store.js');

if (!fs.existsSync(htmlPath)) { console.error('[X] 找不到 admin.html（本脚本需与它同目录）'); process.exit(1); }
const adminHtml = fs.readFileSync(htmlPath, 'utf8');

const mv = adminHtml.match(/const APP_VERSION\s*=\s*'([^']+)'/);
if (!mv) { console.error('[X] 未能从 admin.html 里读到 APP_VERSION，请检查该行是否被改动'); process.exit(1); }
const VERSION = mv[1];

let ntMapJs = '';
if (fs.existsSync(mapPath)) ntMapJs = fs.readFileSync(mapPath, 'utf8');
else console.log('[!] 未找到 nt-map.js，将跳过（不影响后台主体）');

let serverJs = '';
if (fs.existsSync(backPath)) serverJs = fs.readFileSync(backPath, 'utf8');
else console.log('[!] 未找到 server.js，将跳过（文员端后端不会被更新）');
let storeJs = '';
if (fs.existsSync(storePath)) storeJs = fs.readFileSync(storePath, 'utf8');
else console.log('[!] 未找到 store.js，将跳过');

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
    let r = null, err = null;
    try {
      r = await post({ action: 'uploadAdminDist', kind, part: p, total, content, version: VERSION, username: USER, password: PWD });
    } catch (e) { err = e; }
    if (r && r.ok) { process.stdout.write('     片 ' + (p + 1) + '/' + total + ' OK\n'); continue; }
    // ⚠️ 2026-10-07 实测：会出现"**假失败**" —— 云端其实写进去了，但响应报错
    //   （自己踩到的是 INVALID_ENV / -501000：settings.adminDist 文档已 ~866KB，逼近云开发 1MB 单文档上限）。
    //   处置：**回查云端 meta**，该 kind 的片数若已到位就当作成功继续；否则才真报错。
    const m = await post({ action: 'getAdminDistMeta' }, 8000).catch(() => null);
    const got = m && m[kind + 'Parts'];
    if (got === total) {
      process.stdout.write('     片 ' + (p + 1) + '/' + total + ' ⚠️ 响应报错但云端已收到（回查=' + got + ' 片）→ 继续\n');
      continue;
    }
    throw new Error(kind + ' 第 ' + (p + 1) + '/' + total + ' 片失败：' + ((r && r.msg) || (err && err.message) || '未知错误'));
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
  // ⚠️ 2026-10-07：这里原来 meta 不 ok 就 `exit(1)` → 一旦**云端还没有分发文件**（首次上传、
  //   或换了存储方式）就**永远传不上去**（鸡生蛋）。而"能成功返回"本身就说明**后台在跑 + 账号密码对**，
  //   所以 meta 的业务性失败不该挡路 —— 只提示，继续传（真有问题后面分片上传会报错）。
  if (!meta || !meta.ok) {
    console.log('[i] 云端暂无分发文件：' + ((meta && meta.msg) || '（读取失败）'));
    console.log('    这是首次上传时的正常状态，继续上传即可。');
  }
  console.log(' 云端当前版本：v' + ((meta && meta.version) || '—'));
  if (meta.version === VERSION) {
    console.log('');
    console.log('[i] 云端已经是 v' + VERSION + '，内容相同也重新上传一遍（幂等，可放心执行）。');
  }

  // ② 分片上传
  console.log('');
  console.log(' 开始上传…');
  await uploadKind('adminHtml', adminHtml);
  if (ntMapJs) await uploadKind('ntMapJs', ntMapJs);
  // ⭐ 2026-10-07：后端文件也传（文员端「立即更新」会自动校验+备份+写盘；⚠️ 写完要重启后台才生效）
  // ⚠️ 2026-10-07 实测：后端文件的**原始文本**经 HTTP API 传输会被微信侧拒掉
  //   （INVALID_ENV / -501000；二分定位到 server.js 前 5000 字符内某处 —— 而 admin.html
  //    每片 88KB 却没事，所以是**内容**而非大小）。
  //   解法：**base64 后再传**（纯 ASCII，绕开该问题），下载侧再解回 utf8。
  //   体积 +33%，后端文件才 40KB 左右，完全无所谓。
  if (serverJs) await uploadKind('serverJs', Buffer.from(serverJs, 'utf8').toString('base64'));
  if (storeJs) await uploadKind('storeJs', Buffer.from(storeJs, 'utf8').toString('base64'));

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
