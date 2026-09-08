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

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
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

async function callApi(body) {
  const token = await getToken();
  // 官方格式：POST body 整体直接作为云函数入参（不要包裹 {data:...}）
  const url = `https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${token}&env=${encodeURIComponent(cfg.envId)}&name=adminapi`;
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
    const item = { mallKey: '', name: '', region: '', address: '', phone: '', addedAt: '', lastOrderAt: '', lastBrowseAt: '', tags: '', category: '', salesman: '', source: '', level: '' };
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
// 打开后台：优先 Edge/Chrome --app 无边框应用窗口（2026-09-06 老板定，打开即最大化），
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
  server.listen(port, () => {
    // 只认实际监听端口：先前失败端口遗留的 listening 回调会随第二次 listen 成功一起触发，必须忽略
    const actual = server.address() && server.address().port;
    if (actual !== port) return;
    console.log(`🔥 聚火拜访 · 管理后台已启动（微信云开发 HTTP API 直连）`);
    console.log(`   请在浏览器打开：http://localhost:${port}`);
    console.log(`   环境：${cfg.envId} · AppID：${cfg.appid}`);
    // 把实际端口写文件：无边框壳程序（JuHuoVisitAdmin.exe）读它加载页面
    try { fs.writeFileSync(path.join(__dirname, 'current-port.txt'), String(port)); } catch (e) { /* 写入失败不影响服务 */ }
    if (!NO_BROWSER) openBrowser(port);
  });
}
startServer(PREFERRED_PORT, 0);
