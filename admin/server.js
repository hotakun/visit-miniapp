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

// ⭐⭐ 2026-10-10 老板定：**批次列表落盘缓存**（治「一天重启几十次就拉几十次」）
//   · 后台每次启动 / 进批次页都调 listCustomerBatches —— 它要拉"全部批次成员 + 全部任务"，
//     批次一大（9448 家）就是 1.2 万条，又慢又贵（还超时）。
//   · 做法和客户点缓存一样：结果落盘 admin/cache/batches.json，**5 分钟内（含重启）直接读文件**，
//     过期才回云端拉一次。写操作后前端会 POST /batches/refresh 主动作废。
const BATCHES_FILE = path.join(__dirname, 'cache', 'batches.json');
let _batchBusy = null;

// ⭐⭐ 2026-10-10 指针表模式：**批次数据优先从自己的服务器 PG 拿**（pgapi 的 /batches —— 免费、秒出、
//   一条 SQL 出全部数字）；拿不到 / 没配 → 自动回退云开发 listCustomerBatches（服务器挂了后台照样能开）。
//   两者输出 JSON **同构** → 落盘缓存与前端都不用区分来源。
async function fetchBatchesFromPg() {
  try {
    if (!cfg.pgApiUrl) return null;
    const url = String(cfg.pgApiUrl).replace(/\/+$/, '') + '/batches' +
      (cfg.pgApiToken ? ('?token=' + encodeURIComponent(cfg.pgApiToken)) : '');
    const r = await (await fetch(url)).json();
    if (r && r.ok) {
      // ⭐⭐ 2026-10-10 晚（老板实测踩到："加州阳光的批次我怎么看不到了？"）：
      //   **PG 与云端不同步时会"看到空批次"** —— 刚建/刚删批次后，pgsync 还没把 `customer_batches`
      //   表同步过来（每 5 分钟一轮；重传云函数那段时间它还在失败）→ PG 返回"**批次卡为空、可成员统计却有数**"
      //   → 这在数据上**自相矛盾**（不可能有成员却一个批次都没有）→ 被落盘缓存住 5 分钟 → 老板看到空列表。
      //   ✅ 自检：**批次卡为空但 total>0 → 这份数据不可信 → 回退云端**（云端永远是准的），且**不落盘**。
      if (!(r.batches || []).length && r.summary && Number(r.summary.total) > 0) {
        console.log('[batches] PG 批次卡为空但统计有数（同步滞后），回退云端');
        return null;
      }
      return r;
    }
    console.log('[batches] PG 没给数据，回退云开发：' + ((r && r.msg) || ''));
    return null;
  } catch (e) {
    console.warn('[batches] PG 只读 API 不可用，回退云开发：' + (e && e.message));
    return null;
  }
}

// ⚠️⚠️ 2026-10-10 修（**本功能的隐藏 bug，其实一直在静默失效**）：云开发回退必须有这两步 ——
//   ① **带凭据**（STORE_AUTH）：adminapi 要认证，原来不带 → 恒回 NO_AUTH → **落盘缓存从来没写进去过**
//      （老板"一天重启几十次就拉几十次"其实一直没被治好，前端每次都靠 getBatches 的兜底硬拉云端）；
//   ② **parse 字符串**：`callApi` 末尾是 `return JSON.stringify(out)` → 返回的是 **JSON 字符串**，
//      直接用会 `r.ok === undefined` → 同样写不进缓存，且响应体变成"双层字符串"（前端解析成 string）。
async function callCloudListBatches() {
  try {
    const raw = await callApi(Object.assign({ action: 'listCustomerBatches' }, STORE_AUTH));
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return r || { ok: false, msg: '拉取失败' };
  } catch (e) {
    console.warn('[batches] 云开发回退失败：' + (e && e.message));
    return { ok: false, msg: '拉取失败' };
  }
}

function batchesCached(req, res, forceCloud) {  const TTL = 5 * 60 * 1000;
  let hit = null;
  try {
    const st = fs.statSync(BATCHES_FILE);
    if (Date.now() - st.mtimeMs < TTL) hit = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8'));
  } catch (e) { /* 没缓存 / 文件坏了 → 回云端拉 */ }
  if (hit) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(Object.assign({}, hit, { cached: true })));
    return;
  }
  if (_batchBusy) {                                  // 并发合并：同时多处要，只拉一次
    _batchBusy.then(r => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); });
    return;
  }
  _batchBusy = (async () => {
    // ⭐ 2026-10-10：默认 **PG 优先**（零成本）；`forceCloud`（写后刷新那条路）**必须走云开发** ——
    //   "刚写完的批次要即时可见"，PG 有最多 5 分钟的同步滞后（见路由处说明）。
    if (!forceCloud) {
      const fromPg = await fetchBatchesFromPg();
      if (fromPg) return fromPg;
    }
    return await callCloudListBatches();   // ⚠️ 走这个（带凭据 + parse），别直接 callApi
  })().then(r => {
    if (r && r.ok) {
      try { fs.mkdirSync(path.dirname(BATCHES_FILE), { recursive: true }); fs.writeFileSync(BATCHES_FILE, JSON.stringify(r)); } catch (e) { /* 落盘失败不影响返回 */ }
    }
    _batchBusy = null;
    return r || { ok: false, msg: '拉取失败' };
  }).catch(() => { _batchBusy = null; return { ok: false, msg: '拉取失败' }; });
  _batchBusy.then(r => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); });
}
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

// ⭐⭐ 2026-10-17（老板定「补上，以后不会再卡」）：加 `force` —— token 被别处顶掉时能【强制重取】。
//   ⚠️ 原来只判"缓存过期才重取"，而"被别人顶掉"时缓存还没到期 → 一直拿坏 token（后台报 40001，
//      要等到缓存自然过期（最多 2 小时）才恢复 —— 老板 2026-10-17 点「客户详情」报 40001 就是这个）。
async function getToken(force) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token;
  if (tokenPending) return tokenPending;
  tokenPending = (async () => {
    // stable_token 接口：多实例/多次调用共享同一个有效 token，不会互相踢失效（2026-09-03 修 40001）
    const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: cfg.appid, secret: cfg.appsecret, force_refresh: !!force })
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

// ⭐⭐ 2026-10-17（老板定「补上，以后不会再卡」）：**token 失效必须自愈** —— 照 admin/tools/pgsync.js 那一套。
//   背景（当天真实报障）：老板点「客户详情」弹
//     「云函数调用失败：invalid credential, access_token is invalid or not latest …(40001)」。
//   真因：`server.js` 把 token 缓存在内存（2 小时、提前 10 分钟刷），**被别处顶掉/失效时缓存还没到期**
//     → 原来这里**直接抛错、不重取也不重试** → 后台一路 40001，**要等缓存自然过期（最多 2 小时）才恢复**。
//   现在：token 类错误（40001/40014/42001/42007/42008，或 errmsg 含 invalid credential / access_token /
//     not latest / expired）→ **清缓存 + 强制重取 + 自动重试一次**，一轮内自愈。
//   （⚠️ pgsync 早就这么做，`server.js` 一直没补 —— 这就是"服务器数据在跑、后台却调不动"的原因。）
const isTokenErr = (code, msg) => [40001, 40014, 42001, 42007, 42008].indexOf(Number(code)) >= 0 ||
  /invalid credential|access_token|not latest|expired/i.test(String(msg || ''));

async function callApi(body) {
  const t0 = Date.now();
  const action = (body && body.action) || '?';
  // 2026-09-24：body._cfn 可指定云函数名（默认 adminapi）—— 客户数据导入走独立的 importdata
  //（导入是重活，要独立超时预算）。只在本机后台用，不影响其它调用。
  const fnName = (body && body._cfn) || 'adminapi';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) tokenCache = { token: '', expireAt: 0 };   // ⭐ 先清缓存，再强制重取（第 2 次）
    const token = await getToken(attempt > 0);                  // 第 2 次：force = true
    // 官方格式：POST body 整体直接作为云函数入参（不要包裹 {data:...}）
    const url = `https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${token}&env=${encodeURIComponent(cfg.envId)}&name=${encodeURIComponent(fnName)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('云函数调用失败：HTTP ' + r.status);
    const j = await r.json();
    if (j.errcode) {
      if (attempt === 0 && isTokenErr(j.errcode, j.errmsg)) {
        console.warn('[api] token 失效（' + j.errcode + ' ' + j.errmsg + '）→ 强制重取后重试一次');
        continue;                                               // ⭐ 自愈：换新 token 再试一次
      }
      throw new Error('云函数调用失败：' + j.errmsg + '(' + j.errcode + ')');
    }
    // 官方返回：resp_data 为字符串（云函数返回的 buffer）
    let out = j.resp_data;
    if (typeof out === 'string') {
      try { out = JSON.parse(out); } catch (e) { /* 非 JSON 则原样透传 */ }
    }
    // 每次云函数调用打耗时日志（2026-09-09：老板报障重启后首屏 10 多秒，用日志定位慢的 action）
    console.log(`[api] ${fnName}/${action} ${Date.now() - t0}ms`);
    return JSON.stringify(out);
  }
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
  '来源': 'source', '等级': 'level',
  // ⭐⭐ 2026-10-18 老板定：导入文件今后有**两种**（带经纬度列 / 不带），要**自动分辨并适应**。
  //   · 「经纬度」一列（形如 `28.907732,119.969215` = **纬度,经度**，我们自己导出的就是这种）
  //   · 也有表把纬度、经度**分成两列** → 两种都认。
  //   ⚠️ 不带坐标的文件：这几列认不出来 → item 里 lat/lng 保持 null → 后续流程一律跳过（等于老行为）。
  '经纬度': 'coord', '坐标': 'coord', '纬度': 'lat', '经度': 'lng', '纬度(lat)': 'lat', '经度(lng)': 'lng'
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

// ⭐⭐ 2026-10-18 老板定：导入文件有**两种**（带经纬度列 / 不带），解析端要**自动适应**。
//   把「28.907732,119.969215」这种一列值拆成 { lat, lng }。
//   ⚠️ 两种写法都要吃：我们导出的格式是「**纬度,经度**」；但商城/腾讯地图习惯是「经度,纬度」。
//      靠数值判断：**>90 的一定是经度**（纬度不可能超过 90）→ 两种都能正确归类。
//   ⚠️ 解析不出来（空/只有一个数/超范围）→ 返回 null → 这条就没有坐标，后面流程一律跳过（= 老行为）。
function parseLatLng(s) {
  const parts = String(s == null ? '' : s).split(/[,，;；|]/).map(x => Number(String(x).trim()))
    .filter(x => isFinite(x) && x !== 0);      // 0 不是有效坐标
  if (parts.length < 2) return null;
  const a = parts[0], b = parts[1];
  let lat, lng;
  if (Math.abs(a) <= 90 && Math.abs(b) > 90) { lat = a; lng = b; }        // 纬度,经度
  else if (Math.abs(a) > 90 && Math.abs(b) <= 90) { lat = b; lng = a; }   // 经度,纬度
  else { lat = a; lng = b; }                                             // 都在范围内 → 按「纬度,经度」（我们自己导出的格式）
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: lat, lng: lng };
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
  // ⚠️ 2026-10-18 实测（老板那份 `未配对001-带经纬度.xlsx`）：**「经纬度」这一列的表头是空的**
  //   （Excel 里加列时没填表头，或者被删掉了）→ 按表头名认不出来 → 坐标全丢。
  //   ✅ 兜底：表头为空、且该列**前 5 个非空数据都形如「数字,数字」**（如 `28.84,120.09`）→ 当成经纬度列。
  //   ⚠️ 门槛收紧到"必须是两个带小数点的数字、逗号分隔"，不会把普通文本列误判成坐标。
  for (let ci = 0; ci < head.length; ci++) {
    if (head[ci]) continue;                                  // 有表头就不猜
    const vals = [];
    for (let ri = headIdx + 1; ri < rows.length && vals.length < 5; ri++) {
      const v = String((rows[ri] || [])[ci] == null ? '' : (rows[ri] || [])[ci]).trim();
      if (v) vals.push(v);
    }
    if (vals.length < 3) continue;                            // 数据太少不敢猜
    const isCoord = vals.every(v => /^-?\d{1,3}\.\d+\s*[,，]\s*-?\d{1,3}\.\d+$/.test(v));
    if (isCoord) head[ci] = '经纬度';
  }
  const cols = head.map(h => MALL_HEADER_ALIAS[h] || null);
  const out = [];
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    // ⚠️ 这 14 个字段 = 后端 MALL_FIELD_PAIRS 的**商城侧字段** —— 少一个，那条信息就整条链路都传不到。
    //   2026-09-29 补 `mallCode`：表头映射里本来就有它，但 item 里漏了 → **客户编号一直被丢掉**；
    //   而**订单是按 customerCode 匹配的** → 没编号的店，订单永远挂不上。
    const item = { mallKey: '', mallCode: '', name: '', region: '', address: '', phone: '', addedAt: '', lastOrderAt: '', lastBrowseAt: '', tags: '', category: '', salesman: '', source: '', level: '', lat: null, lng: null };
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
      } else if (key === 'coord') {
        // ⭐ 2026-10-18：「经纬度」一列（如 `28.907732,119.969215`）→ 拆成 lat/lng
        const ll = parseLatLng(v);
        if (ll) { item.lat = ll.lat; item.lng = ll.lng; }
      } else if (key === 'lat' || key === 'lng') {
        // 「纬度」「经度」各一列的情况 → 直接取数字（超出范围就丢）
        const n = Number(v);
        if (isFinite(n) && n !== 0 && Math.abs(n) <= (key === 'lat' ? 90 : 180)) item[key] = n;
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
    // ⚠️⚠️ 2026-10-14：改用 **stable_token**（原来是老接口 /cgi-bin/token）。
    //   这处是「服务号 token 定时同步」，**每 ~1.8 小时跑一次** —— 用老接口等于**周期性顶掉 pgsync 的 token**
    //   （2026-10-13 后台数据停更 46 分钟就是这么来的）。stable_token 多实例/多次调用共享同一个有效 token，不会互踢。
    //   ⚠️ 返回字段（access_token / expires_in）与老接口一致，下面 syncMpToken() 的逻辑不用动。
    const body = JSON.stringify({ grant_type: 'client_credential', appid: cfg.mpAppId, secret: cfg.mpAppSecret, force_refresh: false });
    const req = https.request('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
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
    req.write(body);
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
  // ⭐ 2026-10-11 老板定：「📝 拜访记录」两页改走轻量服务器（点「🔄 刷新」来这里拉，不花云开发的量）。
  //   前端打本地 GET /visitrec?kind=daily|day|shop&days=7[&day=YYYY-MM-DD] → 这里转发到 pgapi 的 /visitrec。
  //   ⚠️ 服务器拿不到就回 {ok:false}，**前端自己回退云开发**（与批次那套同一思路：服务器挂了后台照样能用）。
  // ⭐⭐ 2026-10-12 老板定：后台「待商城建档」页新增「新店」标签页 —— **数据走服务器**（不花云开发）。
  //   前端打本地 GET /newshops?days=3 → 转发到 pgapi 的 /newshops。
  //   ⚠️ 服务器拿不到就回 {ok:false}，前端**直说拉不到**（按老板设定：**不回退云端**）。
  // ⭐⭐ 2026-10-13 老板定：**待配对池**（老板和文员两台电脑共用）——
  //   前端打本地 `GET /mallPending`（列表）/ `POST /mallPending/mark`（标记）→ **转发到 pgapi**。
  //   ⚠️ 数据全在你自己的服务器上（PG 的 mall_pending），**不花云端一分钱**；
  //      服务器拿不到就直说（按老板设定：**不回退云端**）。
  //   ⚠️ 2026-10-13 教训：**在 pgapi 加了接口，忘了在 server.js 加转发** → 前端一直"服务器拉不到"。
  //      以后加"服务器侧接口"，**必须两处一起加**（pgapi 路由 + server.js 转发）。
  if (req.url.indexOf('/mallPending') === 0) {
    try {
      const u0 = new URL(req.url, 'http://localhost');
      const target = String(cfg.pgApiUrl || '').replace(/\/+$/, '') + u0.pathname + u0.search +
        (cfg.pgApiToken ? ((u0.search ? '&' : '?') + 'token=' + encodeURIComponent(cfg.pgApiToken)) : '');
      const r = await (await fetch(target, { method: req.method })).json();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      console.warn('[mallPending] 服务器不可用：' + (e && e.message));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, msg: '服务器不可用（按设定：不回退云端）' }));
    }
  }
  // ⭐⭐ 2026-10-17（C5）：**/syncNow 转发** —— 前端"导入 / 补完数据后让同步器立刻跑一轮"用的。
  //   ⚠️ 原来 admin.html 里早就有 `fetch('/syncNow')`（`syncThenRefresh`），
  //      但 **server.js 从来没转发过它** → 一直 404、被 `.catch(() => null)` 静默吞掉
  //      → 那个"导完立刻同步"的功能**从未真正生效**（每次都得干等同步器 5 分钟一轮）。
  //   ⚠️ pgapi 那边只写一个 `sync-now.flag` 文件（不拉数据、不阻塞）——
  //      真正的同步动作仍在 pgsync 自己的循环里，这里只是"叫它别等了、马上跑"。
  if (req.url.indexOf('/syncNow') === 0) {
    try {
      const target = String(cfg.pgApiUrl || '').replace(/\/+$/, '') + '/syncNow' +
        (cfg.pgApiToken ? ('?token=' + encodeURIComponent(cfg.pgApiToken)) : '');
      const r = await (await fetch(target, { method: 'POST' })).json();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      console.warn('[syncNow] 服务器不可用：' + (e && e.message));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, msg: '服务器不可用（按设定：不回退云端）' }));
    }
  }
  if (req.method === 'GET' && req.url.indexOf('/newshops') === 0) {
    try {
      const u0 = new URL(req.url, 'http://localhost');
      const target = String(cfg.pgApiUrl || '').replace(/\/+$/, '') + '/newshops' + u0.search +
        (cfg.pgApiToken ? ((u0.search ? '&' : '?') + 'token=' + encodeURIComponent(cfg.pgApiToken)) : '');
      const r = await (await fetch(target)).json();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      console.warn('[newshops] 服务器不可用：' + (e && e.message));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, msg: '服务器不可用（按设定：不回退云端）' }));
    }
  }
  if (req.method === 'GET' && req.url.indexOf('/visitrec') === 0) {
    try {
      const u0 = new URL(req.url, 'http://localhost');
      const target = String(cfg.pgApiUrl || '').replace(/\/+$/, '') + '/visitrec' + u0.search +
        (cfg.pgApiToken ? ((u0.search ? '&' : '?') + 'token=' + encodeURIComponent(cfg.pgApiToken)) : '');
      const r = await (await fetch(target)).json();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      console.warn('[visitrec] 服务器不可用（前端会回退云开发）：' + (e && e.message));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, msg: '服务器不可用' }));
    }
  }

// ⭐⭐⭐ 2026-10-12 老板最高红线：**改客户前必须留备案（可回退）**
//   老板原话：「绝对绝对不能自主添加和更改合并任何店铺信息，必须要操作员同意之后才能更改，而且必须留下备案，以便回退！！」
//   ① CHANGE_ACTIONS：哪些 action 会改客户档案（→ 改前存快照）
//   ② snapBeforeChange：改前按 id 调 getCustomerDetail 拿**全字段原值**
//   ③ writeChangeLog：追加写本地 `admin/cache/cust_change_log.jsonl`（❌ 不走云端，老板定的）
//   ④ changePayloadOf：这次"改了什么"（新值）
const CHANGE_ACTIONS = {
  updateCustomerFields: 1, updateCustomerCoords: 1, fixDupCustomers: 1,
  deleteCustomers: 1, restoreCustomers: 1, applyMallPair: 1, applyMallMatch: 1
  // ⚠️ 2026-10-15 老板定：**mergeCustomers 不进这张表** ——
  //   原话「这个不要备案，也就是合并就合并了，没有退回的道理，这个情况肯定是我们勘察确实了的！」
  //   （合并前是现场确认过"就是同一家"的，不需要像改字段那样留改前快照。）
};
function changeIdsOf(act, p) {
  const ids = [];
  const push = x => { if (x && typeof x === 'string') ids.push(x); };
  if (act === 'updateCustomerFields' || act === 'updateCustomerCoords') push(p.customerId);
  else if (act === 'fixDupCustomers') (p.rows || []).forEach(r => push(r && r.id));
  else if (act === 'deleteCustomers' || act === 'restoreCustomers') (p.ids || []).forEach(push);
  else if (act === 'applyMallPair') push(p.customerId);
  else if (act === 'applyMallMatch') (p.claims || []).forEach(c => push(c && c.customerId));
  // ⚠️ mergeCustomers 不在这里 —— 老板 2026-10-15 定：**合并不做备案**（现场勘察确认过，不退回）
  return ids;
}
function changePayloadOf(act, p) {
  if (act === 'updateCustomerFields') return { customerId: p.customerId, fields: p.fields };
  if (act === 'updateCustomerCoords') return { customerId: p.customerId, lat: p.lat, lng: p.lng };
  if (act === 'fixDupCustomers') return { rows: p.rows };
  if (act === 'deleteCustomers') return { ids: p.ids };
  if (act === 'restoreCustomers') return { ids: p.ids };
  if (act === 'applyMallPair') return { customerId: p.customerId, mallKey: p.mallKey };
  if (act === 'applyMallMatch') return { claims: p.claims, pendings: p.pendings };
  return null;
}
async function snapBeforeChange(act, p) {
  const ids = changeIdsOf(act, p).slice(0, 300);   // 单次最多快照 300 条（防手滑跑全库）
  const out = [];
  for (const id of ids) {
    try {
      const t = await callApi({ action: 'getCustomerDetail', username: p.username, password: p.password, customerId: id });
      const j = JSON.parse(t || '{}');
      out.push({ id: id, before: (j && (j.customer || j.data || j.detail)) || null });
    } catch (e) { out.push({ id: id, before: null, err: e.message }); }
  }
  return out;
}
const CHANGE_LOG_FILE = path.join(__dirname, 'cache', 'cust_change_log.jsonl');
function writeChangeLog(rec) {
  try {
    fs.mkdirSync(path.dirname(CHANGE_LOG_FILE), { recursive: true });
    fs.appendFileSync(CHANGE_LOG_FILE, JSON.stringify(rec) + '\n', 'utf8');
    console.log('[changelog] 已留档：' + rec.action + '（原值 ' + ((rec.before || []).length) + ' 条）');
  } catch (e) { console.warn('[changelog] 写入失败：', e.message); }
}

  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        // ⭐⭐⭐ 2026-10-12 老板最高红线（原话）：
        //   「绝对绝对不能自主添加和更改合并任何店铺信息，必须要操作员同意之后才能更改，
        //     而且**必须留下备案，以便回退**！！」
        //   落地：凡是**会改客户档案**的 action —— **改之前先把原值读出来、存进本地日志**，然后再转发。
        //   ⚠️ 只写**本地文件** `admin/cache/cust_change_log.jsonl`（老板定：**不走云端**，省云开发的量）。
        //   ⚠️ 快照失败**绝不挡住**正常操作（宁可少一条日志，也不能让老板改不动）。
        let text;
        const act = payload && payload.action;
        if (CHANGE_ACTIONS[act]) {
          let before = null;
          try { before = await snapBeforeChange(act, payload); } catch (e) { console.warn('[changelog] 快照失败（不影响操作）：', e.message); }
          text = await callApi(payload);
          try {
            let result = null;
            try { result = JSON.parse(text || '{}'); } catch (e) { /* 非 JSON 就不记结果 */ }
            writeChangeLog({
              at: Date.now(), action: act, by: payload.username || '', ip: (req.socket && req.socket.remoteAddress) || '',
              before: before, payload: changePayloadOf(act, payload), result: result
            });
          } catch (e2) { console.warn('[changelog] 写日志失败：', e2.message); }
        } else {
          text = await callApi(payload);
        }
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
      const fs2 = require('fs'), path2 = require('path');
      // ⚠️ 2026-10-07 新增：写**后端文件**（server.js / store.js）前的三道保险
      //   ① 语法校验（vm.Script）—— 新代码有语法错就**直接拒绝写入**，后台保持原样（绝不把后台写坏）
      //   ② 备份（.bak-<时间戳>）—— 万一新版跑不起来，手工改名回滚
      //   ③ 原子替换（写 .tmp → rename）—— 避免写到一半断电/中断留下半截文件
      const writeBackend = (file, content) => {
        try { new (require('vm').Script)(content, { filename: file }); }
        catch (e) { throw new Error('新版 ' + file + ' 语法不通过，已拒绝写入（后台保持原样）：' + e.message); }
        const full = path2.join(__dirname, file);
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
        if (fs2.existsSync(full)) { try { fs2.copyFileSync(full, full + '.bak-' + stamp); } catch (e) { /* 备份失败不挡更新 */ } }
        const tmp = full + '.tmp';
        fs2.writeFileSync(tmp, content, 'utf8');
        fs2.renameSync(tmp, full);
      };
      // ⭐⭐ 2026-10-15 修（依《全项目审查》D10）：**先把四个文件的内容全取回来，再动磁盘** ——
      //   原来的顺序是"先覆盖 admin.html / nt-map.js，**之后**才去下载并校验后端"：
      //   一旦后端那两片拉不到（或校验不过），前端**已经换成新版**了 → 立刻变成「**新前端 + 旧后端**」
      //   —— 正是 2026-10-07 踩过的那个坑（新前端调不到新接口，文员端拉数据全失败）。
      //   现在：任何一步 grab 失败都**还没写任何文件**（旧版完整保留）；四份都拿到了才依次落盘。
      //   ⚠️ 报告建议的"不可变 releaseId + manifest/hash + 切版本目录"是更大的改造，本次未做（记入待办）；
      //      这里先把"半更新"这个最要命的窗口关掉。
      const html = await grab('adminHtml', meta.adminHtmlParts);
      const ntmap = await grab('ntMapJs', meta.ntMapJsParts);
      const backend = [];
      const unb64 = s => Buffer.from(String(s || ''), 'base64').toString('utf8');
      // ⚠️ 后端文件在云端是 **base64** 存的（原因见 admin/upload_dist.js 里的说明），这里解回 utf8 再写
      //   ⚠️ 兼容：云端没传过这两个 kind 时（Parts 为 0）保持 null → 下面跳过，不动本地这两个文件
      const serverJsSrc = meta.serverJsParts > 0 ? unb64(await grab('serverJs', meta.serverJsParts)) : null;
      const storeJsSrc = meta.storeJsParts > 0 ? unb64(await grab('storeJs', meta.storeJsParts)) : null;
      // —— 到这里四份内容都在手里了，才开始落盘 ——
      require('fs').writeFileSync(require('path').join(__dirname, 'admin.html'), html, 'utf8');
      require('fs').writeFileSync(require('path').join(__dirname, 'nt-map.js'), ntmap, 'utf8');
      // ⭐ 2026-10-07 老板定「一劳永逸」：**后端文件也一起更新**（文员端不再出现"新前端 + 旧后端"）。
      //   ⚠️ 这两个文件**改完必须重启后台**才生效 —— 返回里带 needRestart，由前端提示用户。
      if (serverJsSrc !== null) { writeBackend('server.js', serverJsSrc); backend.push('server.js'); }
      if (storeJsSrc !== null) { writeBackend('store.js', storeJsSrc); backend.push('store.js'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: meta.version, backend: backend, needRestart: backend.length > 0 }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: e.message }));
    }
    return;
  }
  // ===== 2026-09-27 新增：客户点本地缓存（架构文档 §十 M1）=====
  // 前端地图不再直接请求云端，改读本地缓存；拖动/缩放 0 网络请求。
  // ⭐ 2026-10-12 省调用量 ③-d：后台问**自己的服务器**"云端有没有变化"（0 云端调用）——
  //   转发到 pgapi /stat 的 pollDirtyAt（服务器上的 pgsync 每分钟从云端同步它）。
  //   ⚠️ 服务器不可用 → 返回 ok:false，前端按"该叫就叫"处理（宁可多叫一次，也别漏提醒）。
  if (req.method === 'GET' && req.url.indexOf('/pollDirty') === 0) {
    (async () => {
      try {
        let cfg = {}; try { cfg = require('./config.json'); } catch (e) { cfg = {}; }
        if (!cfg.pgApiUrl) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, msg: '没配 pgApiUrl' }));
          return;
        }
        const base = String(cfg.pgApiUrl).replace(/\/+$/, '');
        const tok = cfg.pgApiToken ? ('?token=' + encodeURIComponent(cfg.pgApiToken)) : '';
        const j = await (await fetch(base + '/stat' + tok)).json();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: !!(j && j.ok),
          pollDirtyAt: Number(j && j.pollDirtyAt) || 0, custDirtyAt: Number(j && j.custDirtyAt) || 0 }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, msg: String((e && e.message) || e) }));
      }
    })();
    return;
  }
  if (req.method === 'GET' && req.url.indexOf('/mapPoints/status') === 0) {
    // ⭐⭐ 2026-10-15 修（依《全项目审查》D06 前半）：**status 也要顺手触发一次"查变动"** ——
    //   原来只有 `/mapPoints` 那条路才会调 `checkDirtyFromPg()`，而前端的**保鲜轮询问的是 `/status`**
    //   （每 15 秒一次，只拿几个数字）→ 结果就是"**没人打开过 /mapPoints 时，缓存永远不补增量**"。
    //   现在 status 也顺带查一次（异步、不等待、失败只吞）：
    //   查到了就补增量 → 下一步 status 返回的 `maxU`/`count` 就会变 → 前端据此重绘。
    //   ⚠️ 成本可控：`checkDirtyFromPg()` 内部有节流（`_lastDirtyAt`），没变动时只花一次极轻的 `/stat` 请求。
    //   ⚠️ 正在全量预热时跳过（预热本来就包含变动，别让两件事打架）。
    try {
      const c0 = store.read();
      if (c0 && store.isFreshToday(c0)) store.checkDirtyFromPg().catch(() => null);
    } catch (e) { /* 静默：查不动也不影响返回数字 */ }
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
  // ⭐⭐ 2026-10-15 老板定（「轻量补字段」）：**只补那 7 个聚合列**，不重拉 65MB 全量。
  //   背景：老板那条网络拉全量单片要 30 秒+（我这边 2 秒）→ 每次点「更新地图数据」都失败。
  //   这几列自己只有 ~1MB（gzip），慢网也几秒就下来。
  //   ⚠️ 没缓存（新电脑 / 首次）→ **自动退回全量** refresh()（否则没有基础数据可补）。
  if (req.method === 'POST' && req.url === '/mapPoints/refreshAgg') {
    (async () => {
      let r = await store.refreshAgg();
      if (r && r.needFull) r = await store.refresh(callApi, STORE_AUTH);   // 没缓存 → 走全量
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    })().catch(e => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: e.message })); });
    return;
  }
  // ⭐ 2026-10-12 老板要「能不能强行中断」→ 点进度浮层上的 ✕ 就调这里，让 store 放弃这次拉取
  if (req.method === 'POST' && req.url === '/mapPoints/cancel') {
    try { store.cancelRefresh(); } catch (e) { /* 没有也不报错 */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
      try { r = store.patch(reqBody.patches, reqBody.removeIds, reqBody.adds); }   // ⭐ 2026-10-13：adds = 商城待配对「新建」发成功后要插进缓存的新客户
      catch (e) { r = { ok: false, msg: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }
  // ⭐⭐ 2026-10-10 指针表模式：删批次后 **把该批次从本地缓存的 bi 里整体摘掉**（一次请求、服务端内部处理）——
  //   前端若拼 9448 条 patch 太重；这里服务端过一遍数组即可（毫秒级）。
  if (req.method === 'POST' && req.url === '/mapPoints/unbatch') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let reqBody = {};
      try { reqBody = JSON.parse(body || '{}'); } catch (e) { /* 空体当空对象 */ }
      let r;
      try { r = store.unbatch(String(reqBody.batchId || '')); }
      catch (e) { r = { ok: false, msg: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }
  // ⭐⭐ 2026-10-10 老板定：**批次列表也落盘缓存**（治「一天重启几十次就拉几十次」）
  //   · 后台每次启动 / 进批次页都会调 listCustomerBatches —— 那个接口要拉"全部批次成员 + 全部任务"，
  //     批次一大（9448 家）就是 1.2 万条，又慢又贵（还超时）。
  //   · 做法和客户点缓存一样：**结果落盘到 admin/cache/batches.json**，**5 分钟内（含重启）直接读文件**。
  //   · 写操作后前端会打 POST /batches/refresh 主动作废；平时 5 分钟自然过期。
  if (req.method === 'GET' && req.url.indexOf('/batches') === 0 && req.url !== '/batches/refresh') {
    batchesCached(req, res);
    return;
  }
  if (req.method === 'POST' && req.url.indexOf('/batches/refresh') === 0) {
    // ⭐⭐ 2026-10-10 指针表模式：写操作（建批 / 删批 / 改名）后前端调这里**主动作废**落盘缓存。
    //   `?src=cloud` = **强制走云开发**（不看 PG）—— 因为"刚写完"的批次必须**即时**可见：
    //   pgsync 同步到 PG 最多滞后 5 分钟，若这里还读 PG，老板建完批次回列表会**看不到新批次**！
    //   ✅ 平缓过渡：这条路上打一次云端（准、即时）；5 分钟后缓存过期 → 自然切回 PG（免费）。
    try { fs.unlinkSync(BATCHES_FILE); } catch (e) { /* 没文件就算了 */ }
    batchesCached(req, res, req.url.indexOf('src=cloud') >= 0);
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
    // ⭐⭐⭐ 2026-10-12 老板定（B 方案）：「问服务器，不问云端」——
    //   原来是 store.checkDirty(...) 问**云端** custDirty（一天 ~5,760 次/客户端，花钱）；
    //   现在改成 checkDirtyFromPg()：只问**自己的服务器**（它本来就在同步云端增量）→ 后台侧 0 云端调用。
    //   ⚠️ 服务器拉不到就什么都不做 —— **绝不回退云端**。
    if (!warming && c) store.checkDirtyFromPg().catch(() => null);
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
  // ⭐⭐ 2026-10-15 修（依《全项目审查》S05 —— **实测确认是真泄露，不是理论风险**）：
  //   原来只挡"逃出 admin 目录"（`!safe.startsWith(__dirname)`）→ **等于把整个 admin 目录公开**：
  //   · `GET /config.json`  → **HTTP 200**，明文返回云开发 `appsecret`、服务号 `mpAppSecret`、`pgApiToken`；
  //     ⚠️ 拿到 appsecret 就能**冒充后端直接调所有云函数**（含 adminapi 的全部管理动作）。
  //   · `GET /cache/map-points.json` → **HTTP 200、75MB**，全量客户数据（电话/地址/坐标）被整包下载。
  //   而 `server.listen(port)` 是**故意不绑 127.0.0.1** 的（文员端在另一台电脑，要靠局域网连这台）——
  //   所以**不能靠"没人访问"，只能靠白名单**：只放行"界面真正会请求的那几个"。
  const safe = path.normalize(path.join(__dirname, file));
  // ① 先挡目录穿越（用路径语义判断，不用字符串前缀 —— 前缀法会被 "adminXXX" 这类绕过）
  const rel = path.relative(__dirname, safe).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end('Forbidden'); return; }
  // ② 再走白名单：页面本体 / 自绘地图 / 地图缓存 SW / 根目录的图片图标 / media（店铺照片）/ voice（语音缓存）
  //   ⚠️ 以后新增"界面要直接读的本地文件"（如再拆一个 JS），**必须加到这里**，否则会 403。
  //   ⚠️ `sw-map-cache.js` 是页面上用 `serviceWorker.register('/sw-map-cache.js')` 注册的
  //      （见 admin.html 的「地图缓存」那段）—— 漏了它会让 SW 注册失败、地图缓存退化成"每次都联网"。
  const _okStatic = (r) =>
    r === 'admin.html' || r === 'nt-map.js' || r === 'sw-map-cache.js' ||
    /^[\w.-]+\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(r) ||
    r.startsWith('media/') || r.startsWith('voice/');
  if (!_okStatic(rel)) { res.writeHead(403); res.end('Forbidden'); return; }
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
