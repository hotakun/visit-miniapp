// 聚火拜访 · 只读 API（2026-10-09）
// ---------------------------------------------------------------------------
// 跑在**你自己的服务器**上：后台从这里读客户数据 → 不再打云开发 → 账单归零。
// 用法：node pgapi.js      （默认端口 18081；配置读同目录的 pgapi.config.json）
// ⚠️ 只读：连的是 juhuo_ro（只有 SELECT 权限，就算口令泄露也改不了数据）
// ⚠️ PG 只在服务器本机被访问（listen 127.0.0.1），公网只暴露这个 18081 + 口令
const http = require('http');
const { Client } = require('pg');

let CFG = {};
try { CFG = require('./pgapi.config.json'); } catch (e) { console.error('[pgapi] 缺 pgapi.config.json'); process.exit(1); }
const PORT = CFG.port || 18081;
const TOKEN = CFG.token || '';
const COLS = 'id,name,name_raw,code,ctype,source,phone,address,city,district,biz_circle,lat,lng,coord_source,coord_status,mall_key,mall_joined_at,remark,batch_ids,created_at,updated_at';
// ⭐⭐ 2026-10-10 指针表模式：`customers.batch_ids` 列**已废弃**（云端已停写）——
//   批次归属的**唯一真相 = `batch_members` 表**。客户查询一律用下面这套「带 JOIN 的列」：
//   读取时把「该客户属于哪些批次」现算成逗号串，**输出字段名仍叫 batch_ids**
//   → 后台（store.js 的 bi / admin.html / 前端）一行都不用改，切换对上层透明。
const COLS_C = 'c.id,c.name,c.name_raw,c.code,c.ctype,c.source,c.phone,c.address,c.city,c.district,c.biz_circle,' +
  'c.lat,c.lng,c.coord_source,c.coord_status,c.mall_key,c.mall_joined_at,c.remark,c.created_at,c.updated_at';
const BI_JOIN = " LEFT JOIN (SELECT customer_id, string_agg(batch_id, ',' ORDER BY batch_id) AS bids FROM batch_members GROUP BY customer_id) m ON m.customer_id = c.id";
const SELECT_CUST = 'SELECT ' + COLS_C + ", COALESCE(m.bids,'') AS batch_ids FROM customers c" + BI_JOIN;
// 「任务中」客户集合的 SQL 片段（published/reviewing 且**未过期**；过期是实时算的，云端不改 status）
const TASK_ALIVE = "SELECT DISTINCT cid FROM tasks, LATERAL jsonb_array_elements_text(tasks.customer_ids) AS cid " +
  "WHERE tasks.status IN ('published','reviewing') AND jsonb_typeof(tasks.customer_ids) = 'array' " +
  "AND (tasks.deadline IS NULL OR tasks.deadline = '' OR tasks.deadline > $1)";

// ===== 运行情况监控页（2026-10-09 老板要的）=====
const STATUS_PW = 'juhuo';   // 监控页口令（简单口令；与 API 的 token 分开，两者互不影响）
function outHtml(res, code, body) {
  const head = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:-apple-system,"Microsoft YaHei",sans-serif;margin:0;padding:14px;background:#F4F6FA;color:#222}' +
    'h2{font-size:17px;margin:0 0 12px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;margin-bottom:13px}' +
    'th,td{padding:9px 12px;font-size:14px;text-align:left;border-bottom:1px solid #EEF1F6}th{background:#F8FAFD;font-weight:600;color:#555}' +
    'td:last-child{text-align:right;font-variant-numeric:tabular-nums}.ok{color:#12A150}.bad{color:#E5484D}.warn{color:#E8A33D}' +
    'input,button{font-size:16px;padding:10px;border-radius:8px;border:1px solid #D8DEE9}button{background:#F5531C;color:#fff;border:0;margin-left:8px}' +
    '.ft{color:#9AA3AF;font-size:12px;text-align:center;margin-top:4px}</style></head><body>';
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(head + body + '</body></html>');
}
function sh(cmd) {
  const { exec } = require('child_process');
  return new Promise(function (resolve) { exec(cmd, { timeout: 8000 }, function (e, so) { resolve(String(so || '').trim()); }); });
}
async function statusHtml() {
  const os = require('os');
  const um = Math.round(os.uptime() / 60);
  const up = um >= 1440 ? (Math.floor(um / 1440) + ' 天 ' + Math.floor((um % 1440) / 60) + ' 小时')
    : (um >= 60 ? (Math.floor(um / 60) + ' 小时 ' + (um % 60) + ' 分') : (um + ' 分钟'));
  const mem = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const tasks = await sh('tasklist /nh /fo csv');
  const cnt = function (n) { return (tasks.match(new RegExp('"' + n + '"', 'gi')) || []).length; };
  const ngx = cnt('nginx\\.exe'), nod = cnt('node\\.exe'), pgs = cnt('postgres\\.exe');
  const ys = function (b) { return b ? '🟢 在跑' : '🔴 没跑'; };
  let rows = '';
  try {
    const r = await q('SELECT count(*)::int AS n, max(updated_at) AS w FROM customers');
    const n = r.rows[0].n, w = Number(r.rows[0].w) || 0;
    const ago = w ? Math.round((Date.now() - w) / 60000) : -1;
    const cls = ago < 0 ? 'warn' : (ago <= 10 ? 'ok' : (ago <= 60 ? 'warn' : 'bad'));
    rows += '<tr><td>客户条数</td><td>' + n.toLocaleString() + '</td></tr>' +
      '<tr><td>数据截至</td><td>' + (w ? new Date(w).toLocaleString('zh-CN') : '—') + '</td></tr>' +
      '<tr><td>距今多久</td><td class="' + cls + '">' + (ago < 0 ? '未知' : (ago < 1 ? '刚刚' : ago + ' 分钟前')) +
      (ago > 10 ? '　⚠️ 同步可能停了' : '') + '</td></tr>';
  } catch (e) { rows += '<tr><td>数据库</td><td class="bad">读不出来</td></tr>'; }
  let disks = '';
  try {
    (await sh('wmic logicaldisk where DriveType=3 get DeviceID,FreeSpace,Size /format:csv')).split('\n').forEach(function (ln) {
      const p = ln.trim().split(',');
      if (p.length >= 4 && p[1]) {
        const free = Math.round(Number(p[2]) / 1073741824 * 10) / 10, tot = Math.round(Number(p[3]) / 1073741824 * 10) / 10;
        disks += '<tr><td>' + p[1] + ' 盘</td><td class="' + (free < 3 ? 'bad' : (free < 8 ? 'warn' : 'ok')) + '">剩 ' + free + ' / ' + tot + ' GB</td></tr>';
      }
    });
  } catch (e) { /* 忽略 */ }
  return '<h2>🔥 聚火拜访 · 服务器运行情况</h2>' +
    '<table><tr><th>服务</th><th>状态</th></tr>' +
    '<tr><td>PostgreSQL（数据库）</td><td class="' + (pgs ? 'ok' : 'bad') + '">' + ys(pgs) + '</td></tr>' +
    '<tr><td>nginx（地图服务 8080）</td><td class="' + (ngx ? 'ok' : 'bad') + '">' +
    '<button onclick="rstNgx()" style="font-size:12px;padding:4px 10px;margin-right:10px;vertical-align:middle">🔄 重启</button>' + ys(ngx) + '</td></tr>' +
    '<tr><td>pgapi（本页所在服务）</td><td class="ok">🟢 在跑</td></tr>' +
    '<tr><td>pgsync（同步器）</td><td class="' + (nod >= 2 ? 'ok' : 'bad') + '">' + ys(nod >= 2) + '</td></tr></table>' +
    '<table><tr><th>数据同步</th><th></th></tr>' + rows + '</table>' +
    '<table><tr><th>服务器</th><th></th></tr>' +
    '<tr><td>开机已运行</td><td>' + up + '</td></tr>' +
    '<tr><td>内存占用</td><td class="' + (mem > 90 ? 'bad' : (mem > 75 ? 'warn' : 'ok')) + '">' + mem + '%</td></tr>' +
    disks + '</table>' +
    '<div class="ft">每 30 秒自动刷新 · ' + new Date().toLocaleString('zh-CN') + '</div>' +
    '<script>function rstNgx(){if(!confirm("确定重启地图服务？约 3 秒，期间手机上看不了地图。"))return;' +
    'fetch("/restart-nginx?pw=' + STATUS_PW + '",{method:"POST"}).then(function(r){return r.json()})' +
    '.then(function(j){alert(j.msg||"已发送");location.reload()}).catch(function(){alert("请求失败，请重试")})}' +
    'setTimeout(function(){location.reload()},30000)</script>';
}

function auth(req, u) {
  if (!TOKEN) return false;
  const t = req.headers['x-token'] || u.searchParams.get('token') || '';
  return t === TOKEN;
}
function out(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

let db = null;
async function q(sql, params) {
  if (!db) {
    db = new Client({ host: CFG.pgHost || '127.0.0.1', port: CFG.pgPort || 5432,
      database: CFG.pgDatabase || 'juhuo', user: CFG.pgUser, password: CFG.pgPassword });
    db.on('error', (e) => { console.error('[pgapi] 连接断了', e.message); db = null; });
    await db.connect();
  }
  return db.query(sql, params || []);
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') return out(res, 200, { ok: true, at: Date.now() });
  // ⭐ 2026-10-09：运行情况监控页（老板要的）—— http://<服务器>:18081/status?pw=juhuo
  //   用**简单口令**（和 API 的 token 分开）；只显示"运行状态"，不含任何客户数据；30 秒自动刷新。
  if (u.pathname === '/status') {
    if ((u.searchParams.get('pw') || '') !== STATUS_PW) return outHtml(res, 401,
      '<h2>需要口令</h2><form><input name="pw" type="password" placeholder="口令" autofocus>' +
      '<button>进入</button></form><p style="color:#888">提示：加了 ?pw=口令 就能直接进（可存书签）</p>');
    return outHtml(res, 200, await statusHtml());
  }
  // ⭐ 2026-10-09：单独重启「地图服务」（nginx）—— 老板要的（它有时会卡死）
  //   ⚠️ 这是**写操作**（杀进程再拉起）→ 只认监控页口令；且**必须 POST**
  //      （GET 会被浏览器预取 / 爬虫误触发，那就成"随机重启地图"了）。
  if (u.pathname === '/restart-nginx' && req.method === 'POST') {
    if ((u.searchParams.get('pw') || '') !== STATUS_PW) return out(res, 401, { ok: false, msg: '口令不对' });
    try {
      await sh('taskkill /f /im nginx.exe');
      await new Promise(function (r) { setTimeout(r, 1200); });
      await sh('cmd /c start "" /d C:\\nginx nginx.exe');   // ⚠️ 必须用 start（异步），否则 exec 会一直等
      await new Promise(function (r) { setTimeout(r, 1800); });
      const t = await sh('tasklist /nh /fo csv');
      const n = (t.match(/"nginx\.exe"/gi) || []).length;
      return out(res, 200, { ok: n > 0, msg: n > 0 ? ('地图服务已重启完成（' + n + ' 个进程）') : '重启后没检测到 nginx，请在服务器上手动打开 C:\\nginx\\nginx.exe' });
    } catch (e) {
      console.error('[pgapi] 重启 nginx 出错', e && e.message);
      return out(res, 500, { ok: false, msg: '重启失败，请在服务器上手动打开 C:\\nginx\\nginx.exe' });
    }
  }
  if (!auth(req, u)) return out(res, 401, { ok: false, msg: 'unauthorized' });
  try {
    // 全量客户点（地图用；首次给新电脑灌本地缓存也用它）
    if (u.pathname === '/points') {
      const r = await q(SELECT_CUST + ' WHERE c.deleted = false');
      return out(res, 200, { ok: true, rows: r.rows, at: Date.now() });
    }
    // 增量：since = 上次水位（updated_at）；removed = 期间被删的 id（治"删了又复活"）
    if (u.pathname === '/sync') {
      const since = Number(u.searchParams.get('since') || 0);
      const r = await q(SELECT_CUST + ' WHERE c.updated_at > $1 ORDER BY c.updated_at', [since]);
      const d = await q('SELECT id FROM deleted_ids WHERE deleted_at > $1', [since]);
      return out(res, 200, { ok: true, rows: r.rows, removed: d.rows.map(x => x.id), at: Date.now() });
    }
    // 状态：条数 + 水位（后台用来判断"要不要更新"）
    if (u.pathname === '/stat') {
      const r = await q('SELECT count(*)::int AS n, max(updated_at) AS w FROM customers');
      return out(res, 200, { ok: true, count: r.rows[0].n, watermark: Number(r.rows[0].w) || 0, at: Date.now() });
    }
    // ⭐⭐ 2026-10-10 指针表模式：批次页数据 —— 输出与云端 `listCustomerBatches` **同构**，
    //   后台 server.js 的 `/batches` 优先读这里（免费、秒出），读不到自动回退云开发。
    //   ⚠️ 所有统计一律从 batch_members 算（customers.batch_ids 已废弃）。
    if (u.pathname === '/batches') {
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 与云端 todayStr() 同口径
      // ① 批次卡 + 每批统计（total / in_task / visited）
      const bl = await q('SELECT id,name,subtitle,created_at,created_by,auto_name_prefix FROM customer_batches ORDER BY created_at DESC');
      const st = await q(
        'SELECT m.batch_id, count(*)::int AS total,' +
        ' count(*) FILTER (WHERE t.cid IS NOT NULL)::int AS in_task,' +
        ' count(*) FILTER (WHERE v.customer_id IS NOT NULL)::int AS visited' +
        ' FROM batch_members m' +
        ' LEFT JOIN (' + TASK_ALIVE + ') t ON t.cid = m.customer_id' +
        ' LEFT JOIN visited_customers v ON v.customer_id = m.customer_id' +
        ' GROUP BY m.batch_id', [today]);
      // ② 未分批数（排除回收站客户；归属以 batch_members 为唯一依据）
      const ub = await q('SELECT count(*)::int AS n FROM customers c WHERE c.deleted IS NOT TRUE' +
        ' AND NOT EXISTS (SELECT 1 FROM batch_members m WHERE m.customer_id = c.id)');
      // ③ 顶部汇总（客户级去重，与云端同口径）
      const sm = await q(
        'WITH tc AS (' + TASK_ALIVE + '), vc AS (SELECT customer_id FROM visited_customers)' +
        ' SELECT (SELECT count(DISTINCT customer_id)::int FROM batch_members) AS total,' +
        ' (SELECT count(DISTINCT m.customer_id)::int FROM batch_members m JOIN tc ON tc.cid = m.customer_id) AS in_task,' +
        ' (SELECT count(DISTINCT m.customer_id)::int FROM batch_members m JOIN vc ON vc.customer_id = m.customer_id) AS visited', [today]);
      const byId = {};
      st.rows.forEach(r => { byId[r.batch_id] = r; });
      const batches = bl.rows.map(b => {
        const s = byId[b.id] || {};
        const total = Number(s.total) || 0, inTask = Number(s.in_task) || 0, visited = Number(s.visited) || 0;
        return { _id: b.id, name: b.name || '', subtitle: b.subtitle || '', createdAt: Number(b.created_at) || 0,
          createdBy: b.created_by || '', autoNamePrefix: b.auto_name_prefix || '',
          stats: { in_task: inTask, free: Math.max(0, total - inTask), visited: visited, total: total } };
      });
      const S = sm.rows[0] || {};
      const sTot = Number(S.total) || 0, sTask = Number(S.in_task) || 0;
      return out(res, 200, { ok: true, batches: batches, unbatched: Number(ub.rows[0] && ub.rows[0].n) || 0,
        summary: { total: sTot, in_task: sTask, free: Math.max(0, sTot - sTask), visited: Number(S.visited) || 0 },
        at: Date.now(), from: 'pg' });
    }
    out(res, 404, { ok: false, msg: 'unknown path' });
  } catch (e) {
    console.error('[pgapi] 出错', e && e.message);          // ⚠️ 原始异常只进日志
    out(res, 500, { ok: false, msg: '服务器出错了，请稍后再试' });  // 给人看的永远是这句
  }
});
srv.listen(PORT, () => console.log('[pgapi] listening on ' + PORT));
