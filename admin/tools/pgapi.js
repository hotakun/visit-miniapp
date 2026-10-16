// 聚火拜访 · 只读 API（2026-10-09）
// ---------------------------------------------------------------------------
// 跑在**你自己的服务器**上：后台从这里读客户数据 → 不再打云开发 → 账单归零。
// 用法：node pgapi.js      （默认端口 18081；配置读同目录的 pgapi.config.json）
// ⚠️ 只读：连的是 juhuo_ro（只有 SELECT 权限，就算口令泄露也改不了数据）
// ⚠️ PG 只在服务器本机被访问（listen 127.0.0.1），公网只暴露这个 18081 + 口令
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');   // ⚠️ 2026-10-15：改用连接池（原来单个 Client 不能并发 query，会卡死）

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
  'c.lat,c.lng,c.coord_source,c.coord_status,c.mall_key,c.mall_joined_at,c.remark,c.created_at,c.updated_at,' +
  // ⭐⭐ 2026-10-16（老板定「这 9 列 PG 里没有…同步器也要拉」）：补 8 列 ——
  //   ⚠️ 加进来之后**必须同步加 `admin/store.js` 的映射表 M**（否则字段被静默丢掉、缓存里没这个键 —— 老坑）。
  'c.region,c.salesman,c.mall_level,c.mall_source,c.mall_category,' +
  'c.last_order_at,c.last_browse_at,c.phone2';
const BI_JOIN = " LEFT JOIN (SELECT customer_id, string_agg(batch_id, ',' ORDER BY batch_id) AS bids FROM batch_members GROUP BY customer_id) m ON m.customer_id = c.id";
// ⭐ 2026-10-15（《订单本地方案》第 4 块）：客户聚合表（订单数/额/最近下单 + 拜访数/最近拜访/全局态/任务内状态）
//   由同步器 `pgsync.recalcCustAgg()` 算好写进去；这里只 JOIN 读出来（只读账号也能读 —— 已 GRANT SELECT）。
const AGG_JOIN = " LEFT JOIN cust_agg ag ON ag.id = c.id";
const SELECT_CUST = 'SELECT ' + COLS_C + ", COALESCE(m.bids,'') AS batch_ids, " +
  // ⭐⭐ 2026-10-15（《订单本地方案》第 4 块）：**把这 7 个聚合列一起回了** ——
  //   原来它们只有云端 `custPageAgg` 算得出来 → 前端每翻一页都要问云端；
  //   现在由同步器算好写进 PG 的 `cust_agg`，这里一次 JOIN 带出来，**彻底不问云端**。
  //   ⚠️ 短键名必须与 `store.js` / `admin.html` 读的**逐字一致**（oc/oa/lo/vc/lv/vs/vt），改一个就"改了看不到"。
  "ag.order_count AS oc, ag.order_amount_sum AS oa, ag.last_order_at AS lo, " +
  "ag.visit_count AS vc, ag.last_visit_at AS lv, ag.visit_state AS vs, ag.visit_status AS vt " +
  'FROM customers c' + BI_JOIN + AGG_JOIN;
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
// ⭐⭐ 2026-10-12 老板定：「关掉服务干完活再启动」+ 实测一片 2 万家 = **9.5MB / 12.7 秒** →
//   慢在**公网带宽**（不是数据库，聚合只要几十毫秒）。加 gzip：JSON 压完约 15%（9.5MB → 1.4MB），
//   每片降到 2~3 秒（总量 2 分钟 → 20 秒左右）。
//   ⚠️ 只给 /points 用（监控页 HTML 与别的接口一律不动）；Node 的 fetch 会自动解压 → **前端零改动**。
function outGz(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const gz = zlib.gzipSync(buf);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Encoding': 'gzip', 'Content-Length': gz.length });
  res.end(gz);
}

// ⚠️⚠️ 2026-10-15 修（老板实测「更新地图数据」**永久卡死 8 分钟**）：**原来只用一个 Client 连接** ——
//   而 `pg` 的单个 Client **不能并发 query**：同时来两个请求时，它会报
//   "client is already executing a query"，或者**这个连接干脆挂住不返回**。
//   AGENTS 里早记过这条隐患（日志有 `ECONNRESET` 和那句警告），今天真出事了：
//   后台分片拉缓存撞上别的查询 → 那个请求永久挂住 → 连累 `store.js` 的 fetch 也不返回 → 全局卡死。
//   ✅ 改用**连接池**：`pool.query()` 天生支持并发，谁也不会堵住谁。
//      （max=8 够用；connectionTimeoutMillis 保证"拿不到连接就尽快报错"，不无限等。）
const db = new Pool({ host: CFG.pgHost || '127.0.0.1', port: CFG.pgPort || 5432,
  database: CFG.pgDatabase || 'juhuo', user: CFG.pgUser, password: CFG.pgPassword,
  max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 });
db.on('error', (e) => { console.error('[pgapi] 连接池出错（不影响下次查询）', e.message); });
async function q(sql, params) {
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
    // ⭐⭐ 2026-10-15（老板定「轻量补字段」）：**只回"聚合那几列"** —— 后台点「更新地图数据」时用它。
    //   背景：为了看那几列（订单数/额/最近下单 + 拜访数/最近拜访/全局态/任务内状态），
    //   原来每次都要把 **65MB 的全量客户数据**重拉一遍；老板那条网络一慢就拉不动（实测他单片要 30 秒+，我这边 2 秒）。
    //   而这几列自己只有约 12MB（未压缩）/ ~1MB（gzip）→ **慢网也能几秒下来**。
    //   ⚠️ 只查 `cust_agg` 一张表、**没有任何 JOIN**（`id` 是主键，走索引）→ 非常快。
    //   ⚠️ 分片方式与 `/points` 一致（`limit` + `after` 游标）。
    if (u.pathname === '/aggAll') {
      const lim = Math.min(Math.max(Number(u.searchParams.get('limit') || 0) || 20000, 100), 50000);
      const after = String(u.searchParams.get('after') || '');
      const SEL = 'SELECT id, order_count AS oc, order_amount_sum AS oa, last_order_at AS lo, ' +
        'visit_count AS vc, last_visit_at AS lv, visit_state AS vs, visit_status AS vt FROM cust_agg';
      const tot = await q('SELECT count(*)::int AS n FROM cust_agg');
      const r = after
        ? await q(SEL + ' WHERE id > $1 ORDER BY id LIMIT $2', [after, lim])
        : await q(SEL + ' ORDER BY id LIMIT $1', [lim]);
      const last = r.rows.length ? r.rows[r.rows.length - 1].id : after;
      return outGz(res, 200, { ok: true, rows: r.rows, total: tot.rows[0].n, last: last, hasMore: r.rows.length >= lim, at: Date.now() });
    }
    // 全量客户点（地图用；首次给新电脑灌本地缓存也用它）
    if (u.pathname === '/points') {
      // ⭐⭐ 2026-10-12 老板定（B 方案）：**支持分片** ——
      //   原来一次性整包返回（178,755 家、几十 MB）：① 前端**看不到进度**（收完才知道）② 中途断了得重来。
      //   现在带 `limit` 就分片返回（**按 id 游标**，比 OFFSET 快得多），返回里带 `total`/`hasMore`/`last`，
      //   前端据此显示「已收 60,000 / 178,755 家」。**不传 limit = 老行为整包返回**（向后兼容）。
      const _lim = Number(u.searchParams.get('limit') || 0);
      if (_lim > 0) {
        const lim = Math.min(_lim, 50000);
        const after = String(u.searchParams.get('after') || '');
        const tot = await q('SELECT count(*)::int AS n FROM customers WHERE deleted = false');
        const total = tot.rows[0].n;
        const r = after
          ? await q(SELECT_CUST + ' WHERE c.deleted = false AND c.id > $1 ORDER BY c.id LIMIT $2', [after, lim])
          : await q(SELECT_CUST + ' WHERE c.deleted = false ORDER BY c.id LIMIT $1', [lim]);
        const last = r.rows.length ? r.rows[r.rows.length - 1].id : after;
        return outGz(res, 200, { ok: true, rows: r.rows, total: total, last: last, hasMore: r.rows.length >= lim, at: Date.now() });
      }
      const r = await q(SELECT_CUST + ' WHERE c.deleted = false');
      return outGz(res, 200, { ok: true, rows: r.rows, total: r.rows.length, hasMore: false, at: Date.now() });
    }
    // 增量：since = 上次水位（updated_at）；removed = 期间被删的 id（治"删了又复活"）
    if (u.pathname === '/sync') {
      const since = Number(u.searchParams.get('since') || 0);
      const r = await q(SELECT_CUST + ' WHERE c.updated_at > $1 ORDER BY c.updated_at', [since]);
      const d = await q('SELECT id FROM deleted_ids WHERE deleted_at > $1', [since]);
      return out(res, 200, { ok: true, rows: r.rows, removed: d.rows.map(x => x.id), at: Date.now() });
    }
    // 状态：条数 + 水位（后台用来判断"要不要更新"）
    // ⭐⭐ 2026-10-15（《订单本地方案》第 4 块）：**「立刻同步」** —— 后台导入订单后调它，
    //   让同步器**马上跑一轮**，不必等它自己的周期（导入完几秒就能看到那 6 列）。
    //   ⚠️ 实现：在磁盘上放一个**标记文件**（同步器每秒瞄一眼，有就立刻跑、并把标记删掉）。
    //      为什么不用数据库：本服务连的是**只读账号** `juhuo_ro`，写不了库；
    //      而它和同步器在**同一台机器**上，一个文件最省事也最可靠。
    if (u.pathname === '/syncNow') {
      try {
        fs.writeFileSync(path.join(__dirname, 'sync-now.flag'), String(Date.now()), 'utf8');
        return out(res, 200, { ok: true, msg: '已通知同步器立刻同步', at: Date.now() });
      } catch (e) {
        console.error('[pgapi] 写 sync-now.flag 失败', e && e.message);
        return out(res, 500, { ok: false, msg: '通知失败' });
      }
    }
    if (u.pathname === '/stat') {
      const r = await q('SELECT count(*)::int AS n, max(updated_at) AS w FROM customers');
      // ⭐ 2026-10-12 省调用量 ③：多带两个「变化时间戳」—— 后台据此决定"要不要叫云端"（问了不花钱）
      let pd = 0, cd = 0;
      try {
        const s = await q("SELECT name, watermark FROM sync_state WHERE name IN ('pollDirtyAt','custDirtyAt')");
        (s.rows || []).forEach(x => {
          if (x.name === 'pollDirtyAt') pd = Number(x.watermark) || 0;
          if (x.name === 'custDirtyAt') cd = Number(x.watermark) || 0;
        });
      } catch (e) { /* 表里还没有这两行 → 当 0 */ }
      return out(res, 200, { ok: true, count: r.rows[0].n, watermark: Number(r.rows[0].w) || 0,
        pollDirtyAt: pd, custDirtyAt: cd, at: Date.now() });
    }
    // ⭐ 2026-10-11 老板定：「📝 拜访记录」两页改走轻量服务器（点「🔄 刷新」来这里拉，不花云开发的量）。
    //   一个路由三个功能（kind 区分）：
    //     · daily（默认）近 N 天汇总：每天 拜访家数 / 去重客户数 / 去重业务员数
    //     · day=YYYY-MM-DD 某天明细（前端按业务员分组；顺带带客户名/编号）
    //     · shop 近 N 天新店（现场录入 source='field'）
    //   ⚠️ 后台 server.js 的 /visitrec 优先读这里；读不到 / 出错 → 自动回退云开发。
    if (u.pathname === '/visitrec') {
      const kind = u.searchParams.get('kind') || 'daily';
      const days = Math.min(Math.max(Number(u.searchParams.get('days')) || 7, 1), 31);
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const fromMs = new Date(today + 'T00:00:00+08:00').getTime() - (days - 1) * 86400000;
      const from = new Date(fromMs + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 'YYYY-MM-DD'（北京）
      // ⚠️ 2026-10-11 实测踩到：pgapi 的 q() 返回的是**原始结果对象**（不是数组）→ 直接塞进 JSON 会
      //   变成 {command,rowCount,rows,fields,...}，前端读 list 就废了。这里统一取 .rows。
      const R = async (sql, params) => { const rs = await q(sql, params); return Array.isArray(rs) ? rs : ((rs && rs.rows) || []); };
      if (kind === 'day') {
        const day = String(u.searchParams.get('day') || today).slice(0, 10);
        const rows = await R(
          'SELECT v.id, v.customer_id AS "customerId", v.salesman_id AS "salesmanId", v.salesman_name AS "salesmanName",' +
          ' v.result, v.status, v.duration, v.remark, v.samples, v.audios, v.photos, v.updated_at AS "at",' +
          // ⚠️ 字段名与云端 visitRecordsByDay **同构**（前端就不必区分数据来自哪儿）
          ' c.name AS "customerName", c.name_raw AS "nameRaw", c.code AS "mallCode"' +
          ' FROM visits v LEFT JOIN customers c ON c.id = v.customer_id' +
          " WHERE v.visited_at = $1 AND v.status IN ('normal','pending_review')" +
          ' ORDER BY v.updated_at ASC', [day]);
        return out(res, 200, { ok: true, from: 'pg', day: day, total: rows.length, rows: rows });
      }
      if (kind === 'shop') {
        const list = await R(
          "SELECT to_char(to_timestamp(created_at/1000) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day," +
          ' count(*)::int AS n' +
          // ⚠️ 2026-10-11 实测：原来这里还取 mall_pending（"待建档"家数），但 **PG 的 customers 表没有这一列**
          //   → 整条 SQL 报错、shop 分支直接"服务器出错了"。老板要的是"哪天新增了几家"，先只回 n。
          " FROM customers WHERE source = 'field' AND deleted IS NOT TRUE AND created_at >= $1" +
          ' GROUP BY 1 ORDER BY 1 DESC', [fromMs]);
        // ⚠️ 前端「每日新店」点进去要看**明细**（云端 newShopDays 是一次带回来的）→ 这里也带 rows，保持同构
        const rows2 = await R(
          "SELECT to_char(to_timestamp(created_at/1000) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day," +
          ' id AS "customerId", COALESCE(name, name_raw, \'\') AS "customerName",' +
          ' phone, address, code AS "mallCode", created_at AS "at"' +
          " FROM customers WHERE source = 'field' AND deleted IS NOT TRUE AND created_at >= $1" +
          ' ORDER BY created_at DESC', [fromMs]);
        const byDay = {};
        (rows2 || []).forEach(x => { (byDay[x.day] = byDay[x.day] || []).push(x); });
        (list || []).forEach(d => { d.rows = byDay[d.day] || []; d.pending = 0; });
        return out(res, 200, { ok: true, from: 'pg', list: list });
      }
      const list = await R(
        'SELECT visited_at AS day, count(*)::int AS visits,' +
        ' count(DISTINCT customer_id)::int AS customers, count(DISTINCT salesman_id)::int AS salesmen' +
        " FROM visits WHERE visited_at >= $1 AND status IN ('normal','pending_review')" +
        ' GROUP BY visited_at ORDER BY visited_at DESC', [from]);
      return out(res, 200, { ok: true, from: 'pg', list: list });
    }

    // ⭐⭐ 2026-10-10 指针表模式：批次页数据 —— 输出与云端 `listCustomerBatches` **同构**，
    //   后台 server.js 的 `/batches` 优先读这里（免费、秒出），读不到自动回退云开发。
    //   ⚠️ 所有统计一律从 batch_members 算（customers.batch_ids 已废弃）。
    // ⭐⭐ 2026-10-12 老板定：后台「待商城建档」页新增「新店」标签页 —— **数据走服务器**（不花云开发）。
    //   口径与手机端一致：**业务员在手机端「加新店」录的**（source='field'）+ 最近 N 天（默认 3）+ 没进回收站。
    // ⭐⭐ 2026-10-13 老板定：**待配对池** —— 老板和文员两台电脑共用的"商城导入待处理"清单。
    //   ⚠️ 数据全在服务器（PG 的 `mall_pending`），**不花云端一分钱**；这里只给"列表 + 标记状态"，
    //      真正的"写进云端客户档案"由前端调云函数（applyMallPair / createMallCustomer）完成。
    if (u.pathname === '/mallPending') {
      const st = String(u.searchParams.get('status') || '');
      // ⭐ 2026-10-13：多回 lat/lng —— 后台「新建」时补的坐标要能读回来（点「发送到云端」时用它建客户）
      const cols = 'mall_key,name,phone,address,region,mall_code,added_at,status,target_id,target_name,handled_by,handled_at,lat,lng';
      const r = st
        ? await q('SELECT ' + cols + ' FROM mall_pending WHERE status = $1 ORDER BY mall_key LIMIT 1000', [st])
        : await q('SELECT ' + cols + " FROM mall_pending ORDER BY (status = 'pending') DESC, mall_key LIMIT 2000");
      const c = await q('SELECT status, count(*)::int AS n FROM mall_pending GROUP BY status');
      const stat = {}; (c.rows || []).forEach(x => { stat[x.status] = x.n; });
      return out(res, 200, { ok: true, rows: r.rows || [], stat: stat, at: Date.now() });
    }
    // 标记一条（配对 / 新建 / 跳过）—— ⚠️ **只动这一张表的五列**，绝不碰 customers
    if (u.pathname === '/mallPending/mark' && req.method === 'POST') {
      const k = String(u.searchParams.get('mallKey') || '');
      const s = String(u.searchParams.get('status') || '');
      // ⭐⭐ 2026-10-13 修（老板报障「明明发送了 7 家，页面还显示「待发送」」）：
      //   白名单原先只有 pending/paired/created/skipped —— **漏了"发送之后"的两个状态**，
      //   于是前端发完写 `pushed` 被这里 400 拒掉 → **发送成功却记不上状态** →
      //   页面一直显示"已梳理·待发送"，再按一次就会**重复发送**（其中"新建类"会**重复建一条客户**）。
      if (!k || ['pending', 'paired', 'created', 'skipped', 'pushed', 'failed'].indexOf(s) < 0) return out(res, 400, { ok: false, msg: '参数不对' });
      // ⭐ 2026-10-13 老板：「输入的经纬度，是对导入的客户补充经纬度信息」→ 顺手把坐标也存进这一行
      const la = Number(u.searchParams.get('lat') || 0) || null;
      const ln = Number(u.searchParams.get('lng') || 0) || null;
      await q('UPDATE mall_pending SET status=$1, target_id=$2, target_name=$3, handled_by=$4, handled_at=$5, ' +
        'lat=COALESCE($7, lat), lng=COALESCE($8, lng) WHERE mall_key=$6',
        [s, String(u.searchParams.get('targetId') || ''), String(u.searchParams.get('targetName') || ''),
         String(u.searchParams.get('by') || ''), Date.now(), k, la, ln]);
      return out(res, 200, { ok: true });
    }
    if (u.pathname === '/newshops') {
      const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days') || 3)));
      const since = Date.now() - days * 86400000;
      const r = await q('SELECT id, name, name_raw, phone, address, district, biz_circle, lat, lng, created_at, ctype ' +
        "FROM customers WHERE source = 'field' AND created_at > $1 AND coalesce(deleted,false) = false " +
        // ⭐ 2026-10-15（依《全项目审查》D04）：排除名单**加上 tbl 过滤** —— `deleted_ids` 一张表同时存
        //   客户和拜访的墓碑（有 `tbl` 列），原来不区分表：虽然两边 id 都是随机串、实际不会撞，
        //   但语义上"用拜访的 id 去排客户的列表"是错的，顺手收紧。
        "AND id NOT IN (SELECT id FROM deleted_ids WHERE tbl = 'customers') " +
        'ORDER BY created_at DESC LIMIT 500', [since]);
      return out(res, 200, { ok: true, days: days, rows: (r.rows || []), at: Date.now() });
    }
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
