// 管理后台本地代理（微信云开发 HTTP API 直连云函数）
// 原理：小程序 AppID+AppSecret 换 access_token → 调 tcb/invokecloudfunction 调 adminapi 云函数
// 需要：config.json 填 appid / appsecret / envId（都在小程序后台可取）
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const XLSX = require('xlsx');
const store = require('./store');   // 2026-09-27：本地缓存层（客户点缓存，见 _scratch/架构-本地缓存与同步方案.md）

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// ⚠️ 2026-09-27 踩过的坑：store 拉缓存时调的是 **adminapi**，而它**需要账号密码认证** ——
//   不带就返回「登录失效」，预热会**静默失败**（现象：/mapPoints 一直空 + warming:true）。
//   默认 qingyan/123456；不想写死可在 config.json 加 adminUser / adminPass 覆盖。
const STORE_AUTH = { username: cfg.adminUser || 'qingyan', password: cfg.adminPass || '123456' };
// 端口优先取命令行 --port=N，其次环境变量 PORT，最后默认 8080（壳程序用 --port 传，绕开环境变量传递坑）
const argPort = parseInt(((process.argv.find(a => a.indexOf('--port=') === 0) || '').split('=')[1]), 10);
const PREFERRED_PORT = argPort || parseInt(process.env.PORT) || 8080;
const NO_BROWSER = !!process.env.NO_BROWSER || process.argv.indexOf('--no-browser') >= 0;
if (!cfg.appid || !cfg.appsecret || !cfg.envId) {
  console.error('[初始化] config.json 未配置完整：需要 appid / appsecret / envId（见《管理后台-第一批上线指引.md》）');
  process.exit(1);
}

let tokenCache = { token: '', expireAt: 0 };
let tokenPending = null; // 并发去重：多个请求同时到达时只取一次 token

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token;
  if (tokenPending) return tokenPending;
  tokenPending = (async () => {
    // stable_token 接口：多实例/多次调用共享同一个有效 token，不会互相踢失效（2026-09-03 修 40001）
    const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: cfg.appid, secret: cfg.appsecret, force_refresh: false })
    });
    if (!r.ok) throw new Error('获取 access_token 失败：HTTP ' + r.status);
    const j = await r.json();
    if (!j.access_token) throw new Error('获取 access_token 失败：' + (j.errmsg || j.errcode) + '（若提示 40164，请到 mp 后台「开发设置-IP白名单」关闭白名单或加入本机公网 IP）');
    tokenCache = { token: j.access_token, expireAt: Date.now() + (j.expires_in - 600) * 1000 };
    return j.access_token;
  })();
  try {
    return await tokenPending;
  } finally {
    tokenPending = null;
  }
}

// ===== 从表格导入的任务状态（2026-09-25）=====
// ⚠️ 必须放**模块级** —— 原先我写在 startServer() 里，端口冲突重试时会重建、任务状态会丢。
const excelJobs = {};
let excelRunning = false;   // 同时只允许一个导入任务（两个进程会互踩输出目录）

// ⭐ 2026-10-06 新增：把一张图片传到云存储，返回 fileID。
//   用途：后台客户详情页「门店照片」由管理员上传/更换（老板 2026-10-06 定）。
//   走**云开发 HTTP API**：/tcb/uploadfile 拿上传链接 → 把二进制 multipart 发给 COS → 用返回的 file_id。
//   ⚠️ 凭据就是 config.json 里那套（appid/appsecret/envId），与 add_index.js / run_adminapi.js 一致。
//   ⚠️ 用全局 fetch / FormData / Blob（Node 18+ 自带，本项目本来就用 fetch）。
async function uploadToCloud(cloudPath, buf) {
  const token = await getToken();
  const r = await fetch(`https://api.weixin.qq.com/tcb/uploadfile?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: cfg.envId, path: cloudPath })
  });
  const j = await r.json();
  if (!j || j.errcode) throw new Error('取上传链接失败：' + ((j && j.errmsg) || '') + '(' + ((j && j.errcode) || '?') + ')');
  const fd = new FormData();
  fd.append('key', cloudPath);
  fd.append('Signature', j.authorization);          // ⚠️ 整串签名放进 Signature 字段（云开发文档口径）
  fd.append('x-cos-security-token', j.token);
  fd.append('x-cos-meta-fileid', j.cos_file_id);
  fd.append('file', new Blob([buf]), cloudPath.split('/').pop());
  const up = await fetch(j.url, { method: 'POST', body: fd });
  if (!up.ok) throw new Error('传给云存储失败：HTTP ' + up.status);
  return j.file_id;
}

async function callApi(body) {
  const t0 = Date.now();
  const action = (body && body.action) || '?';
  // 2026-09-24：body._cfn 可指定云函数名（默认 adminapi）—— 客户数据导入走独立的 importdata
  //（导入是重活，要独立超时预算）。只在本机后台用，不影响其它调用。
  const fnName = (body && body._cfn) || 'adminapi';
  const token = await getToken();
  // 官方格式：POST body 整体直接作为云函数入参（不要包裹 {data:...}）
  const url = `https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${token}&env=${encodeURIComponent(cfg.envId)}&name=${encodeURIComponent(fnName)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('云函数调用失败：HTTP ' + r.status);
  const j = await r.json();
  if (j.errcode) throw new Error('云函数调用失败：' + j.errmsg + '(' + j.errcode + ')');
  // 官方返回：resp_data 为字符串（云函数返回的 buffer）
  let out = j.resp_data;
  if (typeof out === 'string') {
    try { out = JSON.parse(out); } catch (e) { /* 非 JSON 则原样透传 */ }
  }
  // 每次云函数调用打耗时日志（2026-09-09：老板报障重启后首屏 10 多秒，用日志定位慢的 action）
  console.log(`[api] ${fnName}/${action} ${Date.now() - t0}ms`);
  return JSON.stringify(out);
}

// ===== xls/xlsx 解析（客户名单导入） =====
const HEADER_ALIAS = {
  '客户单位': 'name', '店名': 'name', '客户名称': 'name', '商户名称': 'name',
  '区域': 'region', '地区': 'region',
  '地址': 'address',
  '地图经纬度': 'coord', '经纬度': 'coord', '坐标': 'coord', '地图坐标': 'coord',
  '电话': 'phone', '手机号': 'phone', '联系电话': 'phone', '联系方式': 'phone'
};

function parseXls(b64) {
  const wb = XLSX.read(b64, { type: 'base64' });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  if (!rows.length) return { ok: false, msg: '文件为空' };
  // 表头行：前 5 行里找包含「客户单位/地址」的行
  let headIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => String(c).includes('客户单位') || String(c).includes('地址'))) { headIdx = i; break; }
  }
  if (headIdx < 0) return { ok: false, msg: '未识别表头：需包含「客户单位」「地址」等列（表头须在前 5 行）' };
  const head = rows[headIdx].map(h => String(h).trim());
  const cols = head.map(h => HEADER_ALIAS[h] || null);
  const out = [];
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const item = { name: '', region: '', address: '', phone: '', phone2: '', lng: null, lat: null };
    cols.forEach((key, ci) => {
      if (!key) return;
      let v = r[ci];
      if (v == null) return;
      if (typeof v === 'number') v = String(Math.round(v)); // Excel 数字电话去掉 .0
      v = String(v).trim();
      if (!v) return;
      if (key === 'name') item.name = v;
      else if (key === 'region') item.region = v;
      else if (key === 'address') item.address = v;
      else if (key === 'phone') {
        // 多电话拆分：逗号/顿号/斜杠/空格；第一个主号，第二个备号
        const nums = v.split(/[,，、/;；\s]+/).map(s => s.replace(/\.0+$/, '').trim()).filter(s => /^\d{6,12}$/.test(s));
        if (nums.length) { item.phone = nums[0]; if (nums[1]) item.phone2 = nums[1]; }
      } else if (key === 'coord') {
        const m = v.match(/(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/);
        if (m) { item.lng = Number(m[1]); item.lat = Number(m[2]); }
      }
    });
    if (item.name) out.push(item);
  }
  return { ok: true, headers: head, total: out.length, rows: out, preview: out.slice(0, 5) };
}

// ===== 商城客户列表解析（第 1 行标题、第 2 行表头、日期为 Excel 序列号） =====
const MALL_HEADER_ALIAS = {
  '系统Key(勿改)': 'mallKey', '客户编码': 'mallCode', '客户名称': 'name',
  '地区': 'region', '公司地址': 'address', '联系人联系手机': 'phone',
  '添加时间': 'addedAt', '最后下单': 'lastOrderAt', '最后浏览商城': 'lastBrowseAt',
  '客户标签': 'tags', '客户分类': 'category', '业务负责人': 'salesman',
  '来源': 'source', '等级': 'level'
};

// Excel 日期序列号 → YYYY-MM-DD（1900 日期系统）
function serialToDate(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '';
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseMallXls(b64) {
  const wb = XLSX.read(b64, { type: 'base64' });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  if (!rows.length) return { ok: false, msg: '文件为空' };
  // 表头行：前 5 行里找包含「客户名称」「公司地址」的行
  let headIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].some(c => String(c).includes('客户名称') || String(c).includes('公司地址'))) { headIdx = i; break; }
  }
  if (headIdx < 0) return { ok: false, msg: '未识别表头：需包含「客户名称」「公司地址」等列' };
  const head = rows[headIdx].map(h => String(h).trim());
  const cols = head.map(h => MALL_HEADER_ALIAS[h] || null);
  const out = [];
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    // ⚠️ 这 14 个字段 = 后端 MALL_FIELD_PAIRS 的**商城侧字段** —— 少一个，那条信息就整条链路都传不到。
    //   2026-09-29 补 `mallCode`：表头映射里本来就有它，但 item 里漏了 → **客户编号一直被丢掉**；
    //   而**订单是按 customerCode 匹配的** → 没编号的店，订单永远挂不上。
    const item = { mallKey: '', mallCode: '', name: '', region: '', address: '', phone: '', addedAt: '', lastOrderAt: '', lastBrowseAt: '', tags: '', category: '', salesman: '', source: '', level: '' };
    cols.forEach((key, ci) => {
      if (!key) return;
      let v = r[ci];
      if (v == null) return;
      if (typeof v === 'number') {
        // 日期序列号列 → 转日期；其他数字列转整数字符串（如手机号）
        if (['addedAt', 'lastOrderAt', 'lastBrowseAt'].includes(key)) { item[key] = serialToDate(v); return; }
        v = String(Math.round(v));
      }
      v = String(v).trim();
      if (!v) return;
      if (key === 'phone') {
        const nums = v.split(/[,，、/;；\s]+/).map(s => s.replace(/\.0+$/, '').trim()).filter(s => /^\d{6,12}$/.test(s));
        if (nums.length) item.phone = nums[0];
      } else {
        item[key] = v;
      }
    });
    if (item.name) out.push(item);
  }
  return { ok: true, headers: head, total: out.length, rows: out, preview: out.slice(0, 5) };
}

// ===== 语音提醒（微软 edge-tts 免费接口 · 云希男声 · 每人缓存一份 mp3） =====
const TTS_VOICE = 'zh-CN-YunxiNeural';
const VOICE_DIR = path.join(__dirname, 'voice');

function ttsSynth(text, outFile) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      // 中文不走命令行参数（Windows 编码会乱码）：写入 UTF-8 临时文本文件，由 tts_gen.py 读取合成
      const tmpTxt = outFile + '.txt';
      fs.writeFileSync(tmpTxt, text, 'utf8');
      execFile('python', ['tts_gen.py', tmpTxt, outFile],
        { cwd: __dirname, timeout: 60000, windowsHide: true },
        (err) => {
          try { fs.unlinkSync(tmpTxt); } catch (e) { /* 忽略清理失败 */ }
          if (!err) return resolve();
          // edge-tts 微软服务偶发 NoAudioReceived：自动重试 3 次，间隔 1.5 秒
          if (n < 3) {
            console.log(`[语音] 合成失败（第 ${n} 次），1.5 秒后重试：${text}`);
            setTimeout(() => attempt(n + 1), 1500);
          } else {
            reject(err);
          }
        });
    };
    attempt(1);
  });
}

// 并发去重：同一语音文件同时被多个请求触发时只合成一次
const ttsPending = {};

async function ttsGetOrSynth(name, type) {
  const text = type === 'coordfix'
    ? `${name}提交了坐标报错，请及时审核。`
    : type === 'regReview'
      ? '有新的人员需要您审核。' // 2026-09-09 老板定：人员注册待审核男声提醒
      : `${name}提交了任务审核，请及时处理。`;
  const file = crypto.createHash('md5').update(name + '_' + type).digest('hex') + '.mp3';
  const full = path.join(VOICE_DIR, file);
  // 缓存有效判定：文件存在且非 0 字节（合成失败可能留下空文件，必须重试）
  if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    if (!ttsPending[file]) {
      ttsPending[file] = ttsSynth(text, full);
    }
    try {
      await ttsPending[file];
    } finally {
      delete ttsPending[file];
    }
  }
  return '/voice/' + file;
}

// ===== 服务号 access_token 同步（白名单只认本机 IP，云函数取不到 → 本机定时获取推送云端） =====
// 依赖：config.json 可选字段 mpAppId / mpAppSecret（与服务号一致）；后台登录后启动定时器，之后每 ~1.8 小时自动刷新
let mpSyncTimer = null;
let mpAdminCred = null; // 内存缓存管理员凭据（server 重启后，老板重新登录后台即恢复）

function mpGetServiceToken() {
  return new Promise((resolve, reject) => {
    const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(cfg.mpAppId) + '&secret=' + encodeURIComponent(cfg.mpAppSecret);
    const req = https.request(url, { method: 'GET' }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.access_token) resolve(j);
          else reject(new Error('服务号 token 获取失败：' + (j.errmsg || j.errcode)));
        } catch (e) { reject(new Error('服务号接口返回非 JSON：' + buf.slice(0, 120))); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('服务号接口超时')));
    req.on('error', reject);
    req.end();
  });
}

async function syncMpToken() {
  if (!cfg.mpAppId || !cfg.mpAppSecret) return { ok: false, msg: 'config.json 未配置服务号 mpAppId/mpAppSecret' };
  if (!mpAdminCred) return { ok: false, msg: '尚未登录后台（token 同步需管理员凭据）' };
  const j = await mpGetServiceToken();
  const expiresAt = Date.now() + (j.expires_in - 600) * 1000; // 提前 10 分钟过期，保证安全余量
  const push = JSON.parse(await callApi({
    action: 'mpTokenPush',
    username: mpAdminCred.username,
    password: mpAdminCred.password,
    mpToken: j.access_token,
    mpExpiresAt: expiresAt
  }));
  if (!push.ok) throw new Error('云端同步失败：' + (push.msg || ''));
  console.log('[服务号] access_token 已同步云端（有效期至 ' + new Date(expiresAt + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' 东八区）');
  return { ok: true };
}

function startMpTimer(cred) {
  mpAdminCred = cred;
  if (mpSyncTimer) clearInterval(mpSyncTimer);
  // 首次立即同步 + 每 108 分钟（token 7200s=2h，留 12 分钟余量）自动刷新
  syncMpToken().then(r => { if (!r.ok) console.log('[服务号] 首次同步未执行：' + r.msg); }).catch(e => console.log('[服务号] 首次同步失败：' + e.message));
  mpSyncTimer = setInterval(() => {
    syncMpToken().catch(e => console.log('[服务号] 定时同步失败：' + e.message));
  }, 108 * 60 * 1000);
}

const server = http.createServer(async (req, res) => {
  // 语音合成缓存：按业务员名字每人一份 mp3（首次合成，之后直接播放本地文件）
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { name, type } = JSON.parse(body || '{}');
        if (!name) throw new Error('缺少业务员姓名');
        const url = await ttsGetOrSynth(name, type === 'coordfix' ? 'coordfix' : 'review');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '语音合成失败：' + e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/parseMallXls') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { fileBase64 } = JSON.parse(body || '{}');
        if (!fileBase64) throw new Error('未收到文件内容');
        const r = parseMallXls(fileBase64);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '文件解析失败：' + e.message }));
      }
    });
    return;
  }
  // ===== 弹 Windows 文件夹选择框（2026-09-25）=====
  // 「销售订单 / 订单明细」的"选目录"用 —— 后台和浏览器在同一台机器，所以能弹出**真正的**系统选目录框。
  // 为什么必须这样：浏览器出于安全**拿不到目录的硬盘路径**，而 2135 个明细文件也不可能逐个上传。
  // 所以由后台弹框拿到路径，再**直接读盘**，完全不经过浏览器。
  if (req.method === 'POST' && req.url === '/pickFolder') {
    execFile('powershell', ['-NoProfile', '-STA', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "$d.Description='请选择文件夹';" +
      "$d.ShowNewFolderButton=$false;" +
      "if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}"
    ], { timeout: 10 * 60 * 1000, windowsHide: true }, (err, stdout) => {
      if (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '选目录失败：' + err.message }));
        return;
      }
      const p = String(stdout || '').trim();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: p }));
    });
    return;
  }
  // ===== 从表格导入（2026-09-25 老板定：「导入信息」页不再要求你去找 .json 分片）=====
  // 流程：跑本地合并脚本（admin/tools/import_excel.py，与之前那套**完全同一份已验证规则**）
  //       → 生成分片 JSON → 逐片调云函数 importdata 入库 → 回报进度。
  // 整跑要几分钟，所以做成「任务 + 轮询」：POST 启动拿到 jobId，再用 GET 查进度（不受请求超时限制）。
  if (req.method === 'POST' && req.url === '/importExcel') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const opt = JSON.parse(body || '{}');
        const id = excelImportStart(opt || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job: id }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '启动失败：' + e.message }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url.indexOf('/importExcel/progress') === 0) {
    const q = req.url.split('?')[1] || '';
    const id = decodeURIComponent((q.split('id=')[1] || '').split('&')[0]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(excelImportProgress(id)));
    return;
  }
  // ===== 收前端选好的表格文件（base64）→ 落成临时文件 → 交给同一个任务跑（2026-09-25）=====
  // 「商城客户 / 大众点评」这类单个表格走这里；目录类的走 /pickFolder + 直接读盘。
  if (req.method === 'POST' && req.url === '/importExcel/upload') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const opt = JSON.parse(body || '{}');
        if (opt.fileBase64 && opt.fileName) {
          const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jh-src-'));
          const p = path.join(dir, path.basename(String(opt.fileName)));
          fs.writeFileSync(p, Buffer.from(String(opt.fileBase64), 'base64'));
          if (opt.task === 'mall') opt.fMall = p;
          else if (opt.task === 'plat') opt.fPlat = p;
          else if (opt.task === 'order') opt.fOrder = p;
          delete opt.fileBase64; delete opt.fileName;
        }
        const id = excelImportStart(opt || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job: id }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '启动失败：' + e.message }));
      }
    });
    return;
  }
  // ⭐ 2026-10-06 新增：后台客户详情页「门店照片」上传（管理员传图 / 换图）
  //   入参 { customerId, kind, dataUrl }
  //     · dataUrl = 前端 canvas 导出的 `data:image/jpeg;base64,...`
  //     · kind = 'photo'（主图，前端已压到最长边 1600 / q0.85）｜ 'thumb'（320×240 缩略图 / q0.7）
  //   ⚠️ 本接口**只负责"传上去、给回 fileID"**，不写库 ——
  //      前端在**点「💾 保存」时才逐个调它**（老板 2026-10-06 定：与其它字段一致、可反悔），
  //      全部传完再由 adminapi.setCustPhotos 一次性写 `customers.photos`。
  if (req.method === 'POST' && req.url === '/custPhoto') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        const opt = JSON.parse(body || '{}');
        const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(String(opt.dataUrl || ''));
        if (!m) throw new Error('图片内容不对（只收 data:image/...;base64）');
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length) throw new Error('图片是空的');
        if (buf.length > 8 * 1024 * 1024) throw new Error('单张超过 8MB，请换小一点的图');
        const ext = /^png$/i.test(m[1]) ? 'png' : (/^webp$/i.test(m[1]) ? 'webp' : 'jpg');
        const kind = (opt.kind === 'thumb') ? 'thumb' : 'photo';
        // 路径按客户分目录，文件名带时间戳+随机 → 换图不会互相覆盖
        const cid = String(opt.customerId || 'misc').replace(/[^a-zA-Z0-9_-]/g, '');
        const cloudPath = 'custPhoto/' + cid + '/' + kind + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        const fileID = await uploadToCloud(cloudPath, buf);
        reply(200, { ok: true, fileID: fileID, bytes: buf.length });
      } catch (e) {
        reply(502, { ok: false, msg: '上传失败：' + ((e && e.message) || e) });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/parseXls') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { fileBase64 } = JSON.parse(body || '{}');
        if (!fileBase64) throw new Error('未收到文件内容');
        const r = parseXls(fileBase64);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '文件解析失败：' + e.message }));
      }
    });
    return;
  }
  // 服务号 token 同步触发：后台登录成功后自动调用（验证凭据 → 立即同步 → 启动定时器）
  if (req.method === 'POST' && req.url === '/mpTokenRefresh') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body || '{}');
        if (!username || !password) throw new Error('缺少管理员凭据');
        // login 是唯一免鉴权接口，用它对凭据做一次验证
        const lg = JSON.parse(await callApi({ action: 'login', username, password }));
        if (!lg.ok) throw new Error(lg.msg || '凭据无效');
        startMpTimer({ username, password });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: '服务号 token 已同步，之后每 108 分钟自动刷新' }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const text = await callApi(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(text);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '调用管理后台 API 失败：' + e.message }));
      }
    });
    return;
  }
  // 后台文件分发（2026-09-08 老板定：文员点刷新自动对齐版本号；老板手动上传后才更新）
  if (req.method === 'POST' && req.url === '/admin-dist/check') {
    try {
      const meta = await callApi({ action: 'getAdminDistMeta' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(meta);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/admin-dist/apply') {
    try {
      const meta = JSON.parse(await callApi({ action: 'getAdminDistMeta' }));
      if (!meta.ok) throw new Error(meta.msg || '云端暂无分发文件');
      const grab = async (kind, parts) => {
        let out = '';
        for (let p = 0; p < parts; p++) {
          const r = JSON.parse(await callApi({ action: 'getAdminDistPart', kind, part: p }));
          if (!r.ok) throw new Error('分片获取失败：' + r.msg);
          out += r.content;
        }
        return out;
      };
      const html = await grab('adminHtml', meta.adminHtmlParts);
      const ntmap = await grab('ntMapJs', meta.ntMapJsParts);
      require('fs').writeFileSync(require('path').join(__dirname, 'admin.html'), html, 'utf8');
      require('fs').writeFileSync(require('path').join(__dirname, 'nt-map.js'), ntmap, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: meta.version }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: e.message }));
    }
    return;
  }
  // ===== 2026-09-27 新增：客户点本地缓存（架构文档 §十 M1）=====
  // 前端地图不再直接请求云端，改读本地缓存；拖动/缩放 0 网络请求。
  if (req.method === 'GET' && req.url.indexOf('/mapPoints/status') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(store.status()));
    return;
  }
  if (req.method === 'POST' && req.url === '/mapPoints/refresh') {
    (async () => {
      const r = await store.refresh(callApi, STORE_AUTH);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    })().catch(e => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: e.message })); });
    return;
  }
  // ⭐ 2026-09-27 M3：写后回写 —— 前端改完（备注/坐标/字段/删除/建批次）把那几条同步进本地缓存
  if (req.method === 'POST' && req.url === '/mapPoints/patch') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let reqBody = {};
      try { reqBody = JSON.parse(body || '{}'); } catch (e) { /* 空体当空对象 */ }
      let r;
      try { r = store.patch(reqBody.patches, reqBody.removeIds); }
      catch (e) { r = { ok: false, msg: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }
  if (req.method === 'GET' && req.url.indexOf('/mapPoints') === 0) {
    const c = store.read();
    // 没有 / 不是今天的 → 触发一次后台预热（不等它），同时把现有数据先给前端
    const warming = !store.isFreshToday(c);
    if (warming) store.refresh(callApi, STORE_AUTH).catch(() => null);
    // ⭐⭐ 2026-09-29【方案 C】顺手查"云端客户有没有变动"（手机端建店 / 后台改数据都会写这个信号）：
    //   有变动就在后台**补增量进缓存** → 下次取就是新的 —— 老板不用再手动点「🔄 更新地图数据」。
    //   ⚠️ 异步、**不等待**、失败只 log：本次响应仍返回现有缓存（前端靠 count 变化感知到更新）。
    //   ⚠️ 正在预热(warming)时不查 —— 全量拉取本来就包含变动，避免两件事打架。
    if (!warming && c) store.checkDirty(callApi, STORE_AUTH).catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    // ⭐ 2026-09-27：一并把预热进度带给前端（老板要看到「已准备 3.8万/6万」）
    const prog = (store.status() || {}).progress || { done: 0, total: 0, phase: '' };
    res.end(JSON.stringify(c
      ? { ok: true, syncedAt: c.syncedAt, count: c.points.length, points: c.points, warming: warming, progress: prog }
      : { ok: true, syncedAt: 0, count: 0, points: [], warming: true, progress: prog }));
    return;
  }

  // ⭐ 2026-09-27：**地图本地缓存用的 Service Worker**（浏览器只允许同源注册，必须由后台提供）
  if (req.method === 'GET' && req.url.split('?')[0] === '/sw-map-cache.js') {
    try {
      const body = fs.readFileSync(path.join(__dirname, 'sw-map-cache.js'));
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('sw-map-cache.js not found');
    }
    return;
  }

  // ⭐ 2026-09-27：**平台图索引**（前端据此判断"这家有没有平台图" —— 没有就不渲染 <img>，避免控制台一堆 404）。
  //   ⚠️ 必须放在下面 /media/ 静态路由**之前**（否则静态路由会去找 media/plat/_index 文件 → 404）。
  if (req.method === 'GET' && req.url.indexOf('/media/plat/_index') === 0) {
    let uuids = [];
    try {
      uuids = fs.readdirSync(path.join(__dirname, 'media', 'plat'))
        .filter(n => /^[A-Za-z0-9_-]{4,}$/.test(n));   // 只认目录名（跳过 _progress.json 之类）
    } catch (e) { uuids = []; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, count: uuids.length, uuids: uuids }));
    return;
  }

  // ===== ⭐ 2026-09-27：本地媒体文件（店铺照片等）=====
  //   背景：老板定「照片以后台本地保存为主」（省云端存储费）—— 平台图抓下来就存在 admin/media/plat/<platShopUuid>/1.jpg，
  //   后台客户详情页直接用 /media/... 读本地文件显示（业务员要看的才另行走"按需上云"）。
  if (req.method === 'GET' && req.url.indexOf('/media/') === 0) {
    const rel = (() => { try { return decodeURIComponent(req.url.slice('/media/'.length).split('?')[0]); } catch (e) { return ''; } })();
    const mediaRoot = path.join(__dirname, 'media');
    const safe = path.normalize(path.join(mediaRoot, rel));
    if (!safe.startsWith(mediaRoot)) { res.writeHead(403); res.end(); return; }
    fs.readFile(safe, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(safe).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' });
      res.end(data);
    });
    return;
  }

  const raw = req.url.split('?')[0]; // 剥掉 query（如 nt-map.js?v=0906 防缓存版本号）
  const file = raw === '/' ? 'admin.html' : (() => { try { return decodeURIComponent(raw.slice(1)); } catch (e) { return raw.slice(1); } })();
  const safe = path.normalize(path.join(__dirname, file));
  if (!safe.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(safe, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }[path.extname(safe)] || 'application/octet-stream';
    // 开发期一律不缓存（防止改完代码浏览器还用旧版，导致"改了没生效"的排查成本）
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ===== 从表格导入的实现（2026-09-25 老板定）=====
// ⚠️ 这三个函数必须在**模块级**（不能放进 startServer）—— 路由写在 createServer 的回调里，
//    属模块作用域；若把函数放在 startServer() 内，路由执行时看不到它们，
//    会报 `excelImportStart is not defined`（2026-09-25 老板试导订单时踩到过）。
// 老板的操作只剩一步：选好表格/目录 → 点导入。后台做三件事：
//   ① 跑本地合并脚本（与之前那份**完全同一套已验证规则**，不重写、零映射风险）
//   ② 拿到分片 JSON  ③ 逐片调云函数 importdata 入库（复用 callApi 通道）
// 用「任务表 + 轮询」回报进度，避免一个 HTTP 请求干等几分钟被超时掐断。
function excelImportProgress(id) {
  const j = excelJobs[String(id || '')];
  if (!j) return { ok: false, msg: '任务不存在（后台可能重启过）' };
  return { ok: true, pct: j.pct, text: j.text, state: j.state, report: j.report || '' };
}

function excelImportStart(opt) {
  if (excelRunning) throw new Error('已有一个导入任务在跑，请等它结束再点');
  const id = 'imp' + Date.now().toString(36);
  excelJobs[id] = { pct: 0, text: '准备中…', state: 'run', report: '' };
  excelRunning = true;
  runExcelImport(excelJobs[id], opt || {})
    .catch(e => { excelJobs[id].state = 'fail'; excelJobs[id].text = '失败：' + ((e && e.message) || e); })
    .finally(() => { excelRunning = false; });
  return id;
}

async function runExcelImport(job, opt) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const script = path.join(__dirname, 'tools', 'import_excel.py');
  if (!fs.existsSync(script)) throw new Error('找不到合并脚本：' + script + '（需要 Python 环境）');

  // ① 跑 Python 合并脚本
  const TASK_CN = { mall: '商城客户', plat: '大众点评画像', order: '销售订单', item: '订单明细', all: '全部' };
  const task = String(opt.task || 'all');
  job.pct = 3; job.text = '正在读取' + (TASK_CN[task] || task) + '表格并合并…（几千行，要等一会）';
  const partDir = opt.out || fs.mkdtempSync(path.join(require('os').tmpdir(), 'jh-imp-'));
  try { fs.mkdirSync(partDir, { recursive: true }); } catch (e) { /* 已存在 */ }

  // 2026-09-25：把「跑哪一类 + 各自的源路径」通过环境变量交给脚本（脚本只跑这一类）
  const env = Object.assign({}, process.env, {
    JH_SRC: opt.src || '', JH_OUT: partDir, JH_TASK: task, PYTHONIOENCODING: 'utf-8'
  });
  if (opt.fMall) env.JH_F_MALL = opt.fMall;      // 商城客户表
  if (opt.fPlat) env.JH_F_PLAT = opt.fPlat;      // 大众点评表
  if (opt.fOrder) env.JH_F_ORDER = opt.fOrder;   // 销售订单表
  if (opt.dItems) env.JH_D_ITEMS = opt.dItems;   // 订单明细目录

  await new Promise((resolve, reject) => {
    const child = execFile(py, [script], {
      env: env,
      maxBuffer: 64 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (stdout) job.report = (job.report + String(stdout)).slice(-6000);
      if (err) return reject(new Error(String(stderr || err.message || '').slice(-900)));
      resolve();
    });
    if (child.stdout) child.stdout.on('data', d => {
      const last = String(d).trim().split('\n').filter(Boolean).pop();
      if (last) { job.pct = 12; job.text = '解析中：' + last; }
    });
    if (child.stderr) child.stderr.on('data', d => { job.report = (job.report + String(d)).slice(-6000); });
  });

  // ② 读分片，逐片调 importdata 入库
  const files = fs.readdirSync(partDir).filter(f => /\.json$/i.test(f) && f.charAt(0) !== '_').sort();
  if (!files.length) throw new Error('脚本没产出分片（表格目录或文件名可能不对，见下方报告）');
  let done = 0, ins = 0, upd = 0, skip = 0;
  // ⭐ 2026-09-26 老板定：**大众点评导入走 fill 模式**（字段级取优：匹配上只补空位、匹配不上新建客户）
  //    其它导入仍是 overwrite（非空字段照写、空值不写）。
  const mode = opt.task === 'plat' ? 'fill' : '';
  // ⭐ 2026-09-26 提速（老板定：金华一个市就是 1401 片，原来**顺序**一片一片调云函数要 2~5 小时）：
  //    改成 **4 片并发**（云函数内部本来就是 30 并发写库，4 片 = 120 路；免费环境也扛得住）。
  //    失败不再立刻中止（累计 5 片才放弃）：单片失败多半是偶发超时，**重跑幂等、不会翻倍**。
  // ⚠️⚠️ 2026-10-07 杭州实测（109015 家 → 2896 片）：CONC=4 时**前 8 片全报 -601008（云函数调用失败）、
  //    0 片成功**；但把同一片**单独调**是好的（1.4s、859ms 入库 38 家）→ 判定为**并发被限流**，不是分片/索引问题。
  //    故：① 并发 **4 → 2**；② 失败**不再中止整跑**（见下面 while 条件），跑完再由用户点一次补跑失败的片。
  const CONC = 2;
  const failed = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const f = files[cursor++];
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(partDir, f), 'utf8'));
        // ⚠️ 2026-09-25 关键修复：importdata 的 verifyAdmin 要求**入参里带账号密码**，
        //    否则返回 NO_AUTH、一片都写不进去（"脚本成功却导不进去"的真因）。
        //    凭据由前端启动任务时传进来（见 admin.html 的 startOneImport），这里原样转发。
        const text = await callApi({
          action: 'import', _cfn: 'importdata', type: obj.type || 'customers', rows: obj.rows || [],
          mode: mode,
          username: opt.username || '', password: opt.password || ''
        });
        const r = JSON.parse(text || '{}');
        if (!r || !r.ok) throw new Error('入库失败：' + String((r && r.msg) || text || '').slice(0, 160));
        ins += r.inserted || 0; upd += r.updated || 0; skip += r.skipped || 0;
      } catch (e) {
        failed.push({ f: f, err: String((e && e.message) || e).slice(0, 160) });
      }
      done++;
      job.pct = 12 + Math.round(done / files.length * 86);
      job.text = '入库中 ' + done + '/' + files.length + '：' + f
        + '（新增 ' + ins + '、更新 ' + upd + (skip ? '、无变化 ' + skip : '')
        + (failed.length ? '、失败 ' + failed.length : '') + '）';
    }
  };
  await Promise.all(new Array(Math.min(CONC, files.length || 1)).fill(0).map(worker));
  if (failed.length) {
    throw new Error('有 ' + failed.length + ' 片入库失败（已成功 ' + Math.max(0, done - failed.length) + ' 片）：'
      + failed.slice(0, 3).map(x => x.f + '→' + x.err).join('；')
      + '。⚠️ 直接再点一次导入即可 —— 同一条数据导两次不会翻倍（幂等），已成功的片会自动算作"更新/无变化"。');
  }
  job.pct = 100; job.state = 'done';
  job.text = '✅ 完成：' + files.length + ' 片入库，新增 ' + ins + ' 条、更新 ' + upd + ' 条'
    + (skip ? '、无变化 ' + skip + ' 条' : '');
}
// 都没有才退回系统默认浏览器
function openBrowser(port) {
  const url = `http://localhost:${port}`;
  const exe = [
    (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env['ProgramFiles'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env['LOCALAPPDATA'] || '') + '\\Google\\Chrome\\Application\\chrome.exe'
  ].find(p => p.length > 5 && fs.existsSync(p));
  try {
    if (exe) {
      execFile(exe, ['--app=' + url, '--start-maximized', '--no-first-run', '--no-default-browser-check']);
    } else {
      execFile('cmd', ['/c', 'start', '', url]);
    }
  } catch (e) { /* 自动开浏览器失败不影响服务 */ }
}

// 端口自愈（2026-09-06 老板定稿）：首选端口被占/被 Windows 保留段吞掉时自动顺延下一个端口，
// 启动成功后自动打开浏览器（NO_BROWSER=1 跳过，供测试）；分发到任何电脑双击即可用
function startServer(port, attempts) {
  server.once('error', (err) => {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempts < 30) {
      console.log(`   [port] ${port} not usable (${err.code}), trying ${port + 1} ...`);
      startServer(port + 1, attempts + 1);
    } else {
      console.error(`[ERROR] admin server failed to start: ${err.code} ${err.message}`);
      process.exit(1);
    }
  });
  // ===== 从表格导入的实现已移到**模块级**（见文件上方，紧跟 createServer 之后）=====
  // ⚠️ 不能在 startServer 里定义：路由写在 createServer 回调中（属模块作用域），看不到这里的局部函数，
  //    会报 `excelImportStart is not defined`（2026-09-25 试导订单时踩到）。excelJobs / excelRunning 也在模块级。

  server.listen(port, () => {
    // 只认实际监听端口：先前失败端口遗留的 listening 回调会随第二次 listen 成功一起触发，必须忽略
    const actual = server.address() && server.address().port;
    if (actual !== port) return;
    console.log(`🔥 聚火拜访 · 管理后台已启动（微信云开发 HTTP API 直连）`);
    console.log(`   请在浏览器打开：http://localhost:${port}`);
    console.log(`   环境：${cfg.envId} · AppID：${cfg.appid}`);
    // 把实际端口写文件：无边框壳程序（JuHuoVisitAdmin.exe）读它加载页面
    try { fs.writeFileSync(path.join(__dirname, 'current-port.txt'), String(port)); } catch (e) { /* 写入失败不影响服务 */ }
    // 启动预热（2026-09-09 老板报障：重启后首次进任务页卡片 10 多秒才出 = 云函数冷启动；
    // 启动即取 access_token + 先调一次云函数，让容器热起来，登录后首屏不再等冷启动）
    getToken()
      .then(() => callApi({ action: 'getSettings' }).catch(() => {}))
      .catch(() => {});
    // 2026-09-27：客户点缓存预热（当天没拉过就**后台静默拉**；不阻塞服务启动）
    store.startAutoRefresh(callApi, STORE_AUTH);
    if (!NO_BROWSER) openBrowser(port);
  });
}
startServer(PREFERRED_PORT, 0);
