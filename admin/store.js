// admin/store.js —— 本地缓存层（2026-09-27 新增）
//
// 依据：`_scratch/架构-本地缓存与同步方案.md`（§一 五条铁律 / §十 M1 详细设计）
//
// 用途：把云端「客户列表层」数据拉到**本地文件**，后台页面秒读；
//       地图拖动/缩放不再请求云端（这是"丝滑"的关键）。
//
// 铁律（架构文档 §一）：
//   ① 云端是唯一真相源，本地只是快照 —— 删了能重建，不影响正确性
//   ② 热数据（业务员实时位置）**不缓存**
//   ③ 缓存必须在界面显示 syncedAt，让人知道数据新旧
//
// ⚠️ 云函数调用由 server.js 通过 callApi 注入（token 在那边），本文件**不碰凭据**。

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const FILE = path.join(CACHE_DIR, 'map-points.json');
const VERSION = 8;              // ⭐ 2026-10-18：字段 +2（sub = 副店信息 / ch = 连锁门店）→ 旧缓存自动作废重拉。
                                // （上一版 = 7：2026-10-17 字段 +8 reg/sm/ml/msrc/mcat/clor/clbr/ph2）
const PAGE_LIMIT = 1000;        // 每片 1000 条（云函数单次返回上限 100KB，1000 条约 100KB 内）
const MAX_PAGES = 1000;         // 硬上限（100 万条），防死循环

// ══════════════════════════════════════════════════════════════════════════════
// ⭐⭐⭐ 2026-10-17（B 档整改）：**客户字段的唯一清单** —— 以后只改这一张表
//
//   以前这份清单要在【3 处】手工抄：
//     ① 全量刷新的 M 表（/points）
//     ② 增量同步的 M 表（/sync）
//     ③ 写盘瘦身的 slim（漏一个就被筛掉）
//   任一处漏写 = 那个字段**静默消失**、不报错。2026-10-17 老板报
//   「导出里商城等级/来源/分类/签约业务员全空」，就是 ③ 漏了那 8 项。
//
//   现在：三处**全部由下面两张表生成**，别再手写字段清单（`check.js` 有对账盯着）。
//   格式：[短键, PG列名, 缺省值, 中文名]
//     · 'keep' = 原样保留（缺就缺、不补）
//     · ''     = 缺了补空串
//     · 0      = 缺了补 0
// ══════════════════════════════════════════════════════════════════════════════
const CUST_FIELDS = [
  ['i',    'id',             'keep', '客户id'],
  ['n',    'name',           'keep', '店名'],
  ['la',   'lat',            'keep', '纬度'],
  ['ln',   'lng',            'keep', '经度'],
  ['c',    'city',           'keep', '城市'],
  ['d',    'district',       'keep', '区域'],
  ['b',    'biz_circle',     'keep', '商圈'],
  ['nr',   'name_raw',       '',     '店名原值'],
  ['ca',   'created_at',     0,      '建档时间'],
  ['ct',   'ctype',          '',     '客户线'],
  ['ph',   'phone',          '',     '电话'],
  ['rm',   'remark',         '',     '备注'],
  ['bi',   'batch_ids',      '',     '所属批次'],
  ['mj',   'mall_joined_at', '',     '注册商城时间'],
  ['ad',   'address',        '',     '地址'],
  ['cs',   'coord_source',   '',     '坐标来源'],
  ['cst',  'coord_status',   '',     '坐标状态'],
  ['mc',   'code',           '',     '客户编号'],
  ['mk',   'mall_key',       '',     '商城Key'],
  ['u',    'updated_at',     0,      '最后修改'],
  ['so',   'source',         '',     '来源'],
  ['reg',  'region',         '',     '区域原值'],
  ['sm',   'salesman',       '',     '签约业务员'],
  ['ml',   'mall_level',     '',     '商城等级'],
  ['msrc', 'mall_source',    '',     '商城来源'],
  ['mcat', 'mall_category',  '',     '商城分类'],
  ['clor', 'last_order_at',  '',     '商城最近下单'],
  ['clbr', 'last_browse_at', '',     '商城最近浏览'],
  ['ph2',  'phone2',         '',     '手机2'],
  // ⭐ 2026-10-18：主副店 / 连锁（老板定：同编号一条档案 + 副店信息；连锁互标）
  ['sub',  'sub_accounts',   '',     '副店信息'],
  ['ch',   'chain_names',    '',     '连锁门店']
];
// 只有 /points（全量）那条 SQL 会 JOIN 出这 7 列；/sync（增量）不返回 → 不进 M_SYNC
//   ⚠️ 缺省值 'keep'：**故意不补** —— 缺就留空，让前端知道"这个值是不知道"，而不是"就是 0 单"
//      （2026-10-15 D07 修正：补了默认值会让前端误判"已经有值"、不去云端补）
const AGG_FIELDS = [
  ['oc', 'oc', 'keep', '订单总数'],
  ['oa', 'oa', 'keep', '订单总额'],
  ['lo', 'lo', 'keep', '最近下单'],
  ['vc', 'vc', 'keep', '拜访次数'],
  ['lv', 'lv', 'keep', '最近拜访'],
  ['vs', 'vs', 'keep', '全局态'],
  ['vt', 'vt', 'keep', '任务内状态']
];
const ALL_FIELDS = CUST_FIELDS.concat(AGG_FIELDS);
// ——— 以下三份**全部由上面两张表生成**，别处不要再手写字段清单 ———
const M_POINTS = ALL_FIELDS.map(f => [f[0], f[1]]);      // /points 全量：[短键, PG列名]
const M_SYNC = CUST_FIELDS.map(f => [f[0], f[1]]);       // /sync 增量（不含聚合）

// PG 行 → 缓存短键（全量/增量共用；只差传进来的字段清单）
function rowsToPoints(rows, map) {
  return (rows || []).map(function (row) {
    const o = {};
    map.forEach(function (p) { const v = row[p[1]]; o[p[0]] = (v === null || v === undefined) ? '' : v; });
    return o;
  });
}
// 写盘前"瘦身"：按主表逐项取 + 按缺省值规则补（'keep' 的项缺就真的不写这个键）
function slimPoints(points) {
  return (points || []).map(function (p) {
    const o = {};
    ALL_FIELDS.forEach(function (f) {
      const k = f[0], dv = f[2], v = p[k];
      if (dv === 'keep') { if (v !== undefined) o[k] = v; }
      else if (dv === 0) { o[k] = v || 0; }
      else { o[k] = v || ''; }
    });
    return o;
  });
}

let syncing = false;            // 是否正在拉取（前端显示进度用）
// ⭐ 2026-09-27 老板定：预热时前端要能看到「已准备 3.8万/6万」→ progress 里带上 total。
//   total 取「上一次缓存的条数」作参考（首次无缓存时为 0，前端就只显示已拉多少）。
let progress = { done: 0, total: 0, phase: '', cancel: false };

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
}

// 读缓存；格式不对/不存在 → null（调用方自己决定是否重拉）
// ⚠️⚠️ 2026-10-15 修（老板实测「更新地图数据」反复"60 秒超时"）：
//   **`read()` 原来每次都要"读整个 65MB 文件 + JSON.parse 成 ~18 万个对象"**（几百 MB 内存），
//   而它被调用 **17 处** —— 其中 `GET /mapPoints` 与 `status()` 是**前端每 15 秒就问一次**：
//   → 每 15 秒 parse 一次 65MB → **内存涨到 2.1GB、GC 追不上 → 事件循环卡死**
//   → 此时"拉全量"的 fetch 回调排不上队 → 表现成 **第一片 60 秒都不回来**
//     （而实测：同一条 SQL 只要 16ms、9MB 数据只要 2 秒、36 片共 18.7 秒/124MB）。
//   ✅ 修法：**内存里留最近一次读出来的对象**，`write()` 时同步更新它 —— 之后 `read()` 直接返回，
//      不再重复"读盘 + 解析"。（⚠️ 本项目的写法**只有后台这一个进程会写这个文件**，所以安全；
//      若以后有第二个进程写它，必须让这里的缓存失效。）
let _cache = null;          // 最近一次读出来的缓存对象（null = 还没读过）
function read() {
  // ⭐⭐ 2026-10-17 修（老板实测：导出里「商城等级/来源/分类/签约业务员」全空，而磁盘缓存明明有值）：
  //   **内存缓存也必须校验版本** —— 原来 `if (_cache) return _cache` 排在版本判断【之前】，
  //   于是"字段清单变了（VERSION +1）"时：磁盘上已经是新版本，但**进程内存里那份旧格式的永远不会作废**
  //   → 服务端一直把缺字段的旧快照发给前端（**页面刷新也没用，必须重启后台** —— 老板就是这么撞上的）。
  //   现在：内存里那份的 `v` 与当前 `VERSION` 不符 → 丢掉，回头重读磁盘。
  if (_cache && Number(_cache.v) === VERSION) return _cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || j.v !== VERSION || !Array.isArray(j.points)) return null;
    _cache = j;
    return j;
  } catch (e) { return null; }
}

// 原子写：先写 .tmp 再改名 —— 避免"写到一半进程被杀"留下半个坏文件
function write(obj) {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, FILE);
  _cache = obj;             // ⭐ 同步内存缓存（下次 read() 不必再读盘/解析）
}

// 是否"今天拉的"（按自然日 —— 老板口径："当天第一次进系统就初始化，今天之内就用缓存"）
function isFreshToday(c) {
  if (!c || !c.syncedAt) return false;
  const a = new Date(c.syncedAt), b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function status() {
  const c = read();
  return {
    ok: true,
    exists: !!c,
    syncing: syncing,
    progress: progress,
    syncedAt: c ? c.syncedAt : 0,
    count: c ? c.points.length : 0,
    // ⭐⭐ 2026-10-15 加（依《全项目审查》D06 前半）：**给前端一个"内容指纹"** ——
    //   前端原来的保鲜轮询**只比 `count`**，于是"条数没变但内容变了"（改名 / 改坐标 / 改备注）永远发现不了，
    //   界面就一直显示旧的（正是"改完看不到"那一类）。`maxU` 是同步水位（最大的 updatedAt），
    //   内容一变它就会前进 → 配合 count 一起比，两种变化都能感知到。
    maxU: c ? (Number(c.maxU) || 0) : 0,
    // ⭐⭐ 2026-10-17（C3）：**统计列（那 7 列）的更新时间** —— 只有 `refreshAgg` 会写它。
    //   为什么要单独一个：补统计列时 syncedAt/maxU/count/version **全都不变**，
    //   前端靠这四个判据察觉不到"统计已更新"（要人工刷新页面才看到）。
    aggAt: c ? (Number(c.aggAt) || 0) : 0,
    fresh: isFreshToday(c),
    version: VERSION
  };
}

// 分片循环拉全量 → 写文件。callApi 由 server.js 注入（带 token）
// ⚠️ **cred 必须带**（username/password）—— adminapi 需要认证，不带会返回“登录失效”（2026-09-27 踩过）
// ⭐ 2026-10-12 老板要「能不能强行中断」→ 给 store 一个取消开关（server.js 的 /mapPoints/cancel 调它）
function cancelRefresh() {
  progress.cancel = true;
  progress.phase = '正在取消…';
  return true;
}

async function refresh(callApi, cred) {
  if (syncing) return { ok: false, msg: '正在拉取中，请稍候' };
  syncing = true;
  let expected = 0;
  try { const old = read(); if (old && Array.isArray(old.points)) expected = old.points.length; } catch (e) { /* 忽略 */ }
  progress = { done: 0, total: expected, phase: '开始', cancel: false };   // ⚠️ 每次开始都重置取消开关
  const auth = cred || {};
  const t0 = Date.now();
  try {
    // ⭐⭐ 2026-10-09（省钱的落脚点）：**优先从"自己的服务器只读 API"拿**（免费，不再打云开发）——
    //   拿不到 / 没配 / 出错 → **自动回退**下面的云开发分片拉取（服务器挂了后台照样能用）。
    //   配置项在 admin/config.json：pgApiUrl（如 http://124.222.29.73:18081）、pgApiToken。
    let points = [];
    let fromPg = false;    // ⭐ 2026-10-10：这次是不是从自己的服务器（PG）拿的 —— 决定要不要补批次归属
    let _pgc = {};
    try { _pgc = require('./config.json'); } catch (e) { /* 没配就走云开发 */ }
    if (_pgc.pgApiUrl) {
      try {
        // ⭐⭐ 2026-10-12 老板：「有没有连接上、数据有没有在传输、传输进度有没有、能不能强行中断，这些信息你都没有」
        //   → PG 这条路（平时走的就是它）原来**根本不报进度**，所以浮层一直是"正在连接你的服务器…"不动。
        progress.phase = '正在连接你的服务器…';
        const _t0 = Date.now();
        const _base = String(_pgc.pgApiUrl).replace(/\/+$/, '') + '/points' +
          (_pgc.pgApiToken ? ('?token=' + encodeURIComponent(_pgc.pgApiToken)) : '');
        // ⭐⭐ 2026-10-12 老板定（B 方案）：**分片拉取**，每片报一次进度。
        //   ⚠️ 2026-10-15 调小：20000 → **5000** ——
        //      实测单片 2 万条要 2.0~2.7 秒（服务器不慢），但"单片越大、一次失败代价越大"；
        //      5000 条/片 ≈ 0.5 秒，40 片串行也就 20 秒，而**任何一片失败只重试那一小片**。
        //      （起因：老板点「更新地图数据」撞上我重启 pgapi 的几秒 → 那一大片直接超时整轮失败。）
        const _jl = (_base.indexOf('?') >= 0 ? '&' : '?');
        let _after = '', _rows = [], _first = true;
        for (let _p = 0; _p < 80; _p++) {
          const _u = _base + _jl + 'limit=5000' + (_after ? ('&after=' + encodeURIComponent(_after)) : '');
          // ⚠️⚠️ 2026-10-15 修（老板实测「更新地图数据」**永久卡住 8 分钟**、之后谁点都拉不了）：
          //   **fetch 必须带超时** —— 原来这一句没有超时，一旦服务器不响应
          //   （`pgapi` 只用一个数据库连接，并发一撞就不响应 —— 见 AGENTS 记过的隐患），
          //   这个 await 会**永久挂住** → 下面的 `finally` 永远走不到 → `syncing` 标志**永不释放**
          //   → 之后谁点都只回「正在拉取中，请稍候」，页面看起来"死了"。
          //   现在：30 秒拿不到这一片就抛错 → 外层 catch 给出人话 → finally 释放 syncing（可重试）。
          // ⚠️⚠️ 2026-10-15 二次加固（老板那条网络实测"单片也要 30 秒+"，而我这边只要 2 秒）：
          //   ① 超时 30 → **60 秒**（给慢网络留一倍余量）；
          //   ② **每片失败自动重试 3 次**（网络抖一下就自己扛过去，不再"整轮失败"）。
          //   —— 分片已调到 5000 条/片（≈0.5 秒），所以"重试"的代价很小，不会拖很久。
          let _resp = null, _lastErr = null;
          for (let _try = 0; _try < 3; _try++) {
            try {
              _resp = await fetch(_u, { signal: AbortSignal.timeout(60000) });
              break;
            } catch (e) {
              _lastErr = e;
              progress.phase = '这一片没下来（第 ' + (_try + 1) + ' 次），正在重试…';
              await new Promise(r => setTimeout(r, 1200 * (_try + 1)));
            }
          }
          if (!_resp) throw new Error('有一片数据连试 3 次都没拿到（' + ((_lastErr && _lastErr.message) || '网络超时') + '）—— 请检查这台电脑到服务器的网络，或稍后再试');
          if (_first) { progress.phase = '已连上服务器，正在分片下载…'; _first = false; }
          const rr = await _resp.json();
          if (progress.cancel) { progress.phase = '已取消'; return { ok: false, msg: '你取消了这次拉取' }; }
          if (!rr || !rr.ok || !Array.isArray(rr.rows)) break;
          progress.total = rr.total || progress.total;
          _rows = _rows.concat(rr.rows);
          progress.done = _rows.length;
          progress.phase = '正在从服务器下载：已收 ' + _rows.length.toLocaleString() +
            (progress.total ? (' / ' + progress.total.toLocaleString() + ' 家') : ' 家');
          if (!rr.hasMore || !rr.rows.length) break;
          _after = rr.last || '';
        }
        const r = _rows.length ? { ok: true, rows: _rows } : null;
        if (r && r.ok && Array.isArray(r.rows) && r.rows.length) {
          // pgapi 返回的是 PG 的 snake_case 列名 → 转成前端一直用的简写字段（与 custMapPoints 下发的完全一致）
          // ⚠️⚠️ 2026-10-15：**这张表漏过字段**（就是下面那 7 个聚合列）——
          //   漏了之后：pgapi 明明返回了、这里却被丢掉 → 缓存里没这个键 →
          //   前端 `custFillPageAgg` 以为"缺"就**回云端按页补**（白花钱、而且显示不出来）。
          //   **以后往 pgapi 的 SELECT 里加字段，必须同步加这张表**。
          // ⭐⭐ 2026-10-17（B 档）：字段清单已收进文件顶部的主表（M_POINTS），这里不再手写
          points = rowsToPoints(r.rows, M_POINTS);
          console.log('[store] 从自己的服务器拿到 ' + points.length + ' 家（不走云开发）');
          progress.phase = '从服务器收到 ' + points.length + ' 家';
          fromPg = true;
        }
      } catch (e) {
        // ⭐⭐⭐ 2026-10-12 老板：「现在更新地图数据和立即拉取最新数据，全部都走服务器，
        //   服务器拉不了就提示，**任何情况下都不拉取云端**！」
        //   → 这里原来是"服务器不可用 → 回退云开发分片拉取"（一次 22MB × N 片，很花钱）
        //     —— **已删除，绝不回退**。
        console.warn('[store] 服务器只读 API 不可用（按设定：不回退云端）：' + (e && e.message));
        progress.phase = '失败：服务器拉不到（不回退云端）';
        throw new Error('服务器只读接口拉不到数据（按设定：任何情况下都不拉取云端）。请检查服务器是否在运行，或稍后再试。');
      }
    }
    if (progress.cancel) { progress.phase = '已取消'; return { ok: false, msg: '你取消了这次拉取' }; }
    if (!points.length) {
      // 没配 pgApiUrl、或服务器返回了空 —— 同样**不回退云端**，直接失败让人看见。
      progress.phase = '失败：没拿到数据（不回退云端）';
      throw new Error('没从服务器拿到客户数据（按设定：任何情况下都不拉取云端）。请检查 admin/config.json 里的 pgApiUrl 是否正确、服务器是否在运行。');
    }
    // ⚠️ 墓碑（2026-10-12）：下面这段原来是"云开发分片回退"（custMapPoints 分页拉全库）——
    //   按老板要求**已整段停用**，留个壳子免得以后又被加回来。
    if (false) for (let i = 0; i < MAX_PAGES; i++) {
      const res = JSON.parse(await callApi(Object.assign({ action: 'custMapPoints', cursor: cursor, limit: PAGE_LIMIT }, auth)));
      if (!res || !res.ok) throw new Error((res && res.msg) || '云函数返回异常');
      const got = res.points || [];
      points.push.apply(points, got);
      progress.done = points.length;
      progress.phase = '拉取中';
      if (!res.next || !got.length) break;
      cursor = res.next;
    }
    // ⭐⭐ 2026-10-10 指针表模式：**云开发回退路径的"批次归属"补齐** ——
    //   custMapPoints 已不再下发 bi（唯一真相 = batch_members）；这里拉完后调 exportBatchMembers
    //   把「谁在哪些批次」合并进来。**PG 路径不需要** —— 那边 pgapi 的 /points 里已 JOIN batch_members 现算。
    //   （这一步很轻：成员关系几万条，游标分页拉完几秒；且只在新电脑全量预热时才会跑到。）
    if (!fromPg && points.length) {
      try {
        const biMap = {};
        let bAfter = '';
        for (let i = 0; i < 200; i++) {
          const r = JSON.parse(await callApi(Object.assign({ action: 'exportBatchMembers', after: bAfter, limit: 1000 }, auth)));
          if (!r || !r.ok) break;
          (r.list || []).forEach(m => {
            if (!m || !m.c) return;
            biMap[m.c] = biMap[m.c] ? (biMap[m.c] + ',' + m.b) : String(m.b);
          });
          bAfter = r.last || '';
          if (!r.hasMore) break;
        }
        let filled = 0;
        points.forEach(p => { if (biMap[p.i]) { p.bi = biMap[p.i]; filled++; } });
        console.log('[store] 批次归属合并完成：' + Object.keys(biMap).length + ' 家客户有批次（命中 ' + filled + '）');
      } catch (e) {
        console.warn('[store] 批次归属合并失败（不影响其它字段）：' + (e && e.message));
      }
    }
    // 只留列表层需要的字段（压体积；详情走 getCustomerDetail 实时拉）
    // ⭐⭐ 2026-10-17（B 档）：**字段清单已收进文件顶部的主表**，这里只调用 slimPoints()。
    //   以前这段是手写的 —— 每加一个字段都要记得在这里也加一遍，漏了就"全量一跑字段就没了"
    //   （2026-10-17 老板报「导出里商城等级/来源/分类/签约业务员全空」正是漏在这里）。
    //   ⚠️ 保留的旧口径（都在主表的"缺省值"列里表达）：普通字段缺了补 '' 或 0；
    //      7 个聚合字段（oc/oa/lo/vc/lv/vs/vt）**故意不补** —— 缺就留空，
    //      让前端知道"这个值是不知道"，而不是"就是 0 单"（2026-10-15 D07 修正）。
    const slim = slimPoints(points);
    // ⭐ 2026-09-29【方案 C】记下"同步水位"maxU —— 增量同步（custSync 的 since）用它，
    //   比用本地时钟打点更可靠（本地时钟与云端不一定严丝合缝，会漏几秒）。
    let maxU = 0;
    slim.forEach(p => { if (Number(p.u) > maxU) maxU = Number(p.u); });
    write({ v: VERSION, syncedAt: Date.now(), maxU: maxU, count: slim.length, points: slim });
    progress.phase = '完成';
    console.log(`[store] 全量刷新完成：${slim.length} 家，耗时 ${Date.now() - t0}ms`);
    // ⭐ 2026-10-12 老板（用壳程序、看不到后台黑窗口）：「点更新数据到底是从哪拉的？」
    //   → 把"数据来源"放进返回，前端在弹窗里**直接显示给他看**（不用翻日志）。
    return { ok: true, count: slim.length, ms: Date.now() - t0, from: fromPg ? 'pg' : 'cloud' };
  } catch (e) {
    // ⚠️ 失败**不清空**旧缓存（架构文档：拉取失败也要能看到地图）
    progress.phase = '失败：' + (e && e.message ? e.message : e);
    console.error('[store] 全量刷新失败：', e && e.message);
    return { ok: false, msg: (e && e.message) || '拉取失败' };
  } finally {
    syncing = false;
  }
}

// ⭐⭐ 2026-10-15 老板定（「轻量补字段」）：**只把那 7 个聚合列补进现有缓存**（不重拉全量）。
//   为什么要它：为了看那几列（订单数/额/最近下单 + 拜访数/最近拜访/全局态/任务内状态），
//   原来每次都要重拉 **65MB 全量** —— 老板那条网络一慢就拉不动（实测他单片要 30 秒+，我这边 2 秒）。
//   这几列自己只有约 **1MB（gzip）** → 慢网几秒就下来。
//   ⚠️ 前提：缓存必须已存在（新电脑要先走一次 refresh() 灌全量 —— 由 server.js 的路由判断）。
//   ⚠️ **只改这 7 个键，其余字段一个字不碰**（同一个 `i` 就地覆盖）。
async function refreshAgg() {
  if (syncing) return { ok: false, msg: '正在拉取中，请稍候' };
  syncing = true;
  progress = { done: 0, total: 0, phase: '开始', cancel: false };
  try {
    const c = read();
    if (!c || !Array.isArray(c.points) || !c.points.length) {
      return { ok: false, msg: '本地缓存还没有（需要先做一次完整更新）', needFull: true };
    }
    let _pgc = {};
    try { _pgc = require('./config.json'); } catch (e) { /* 没配就报错 */ }
    if (!_pgc.pgApiUrl) return { ok: false, msg: '没配 pgApiUrl（按设定：不拉云端）' };
    const _base = String(_pgc.pgApiUrl).replace(/\/+$/, '') + '/aggAll' +
      (_pgc.pgApiToken ? ('?token=' + encodeURIComponent(_pgc.pgApiToken)) : '');
    const _jl = (_base.indexOf('?') >= 0 ? '&' : '?');

    let _after = '', _rows = [];
    for (let _p = 0; _p < 80; _p++) {
      const _u = _base + _jl + 'limit=20000' + (_after ? ('&after=' + encodeURIComponent(_after)) : '');
      // 与 refresh() 同款：60 秒超时 + 每片重试 3 次（这张表小、更快，但不能因为一片失败就整轮失败）
      let _resp = null, _lastErr = null;
      for (let _try = 0; _try < 3; _try++) {
        try { _resp = await fetch(_u, { signal: AbortSignal.timeout(60000) }); break; }
        catch (e) { _lastErr = e; progress.phase = '这一片没下来（第 ' + (_try + 1) + ' 次），正在重试…'; await new Promise(r => setTimeout(r, 1200 * (_try + 1))); }
      }
      if (!_resp) throw new Error('有一片没拿到（' + ((_lastErr && _lastErr.message) || '网络超时') + '）—— 请检查这台电脑到服务器的网络');
      const rr = await _resp.json();
      if (progress.cancel) { progress.phase = '已取消'; return { ok: false, msg: '你取消了这次更新' }; }
      if (!rr || !rr.ok || !Array.isArray(rr.rows)) break;
      progress.total = rr.total || progress.total;
      _rows = _rows.concat(rr.rows);
      progress.done = _rows.length;
      progress.phase = '正在补那几列：已收 ' + _rows.length.toLocaleString() +
        (progress.total ? (' / ' + progress.total.toLocaleString() + ' 家') : ' 家');
      if (!rr.hasMore || !rr.rows.length) break;
      _after = rr.last || '';
    }
    if (!_rows.length) return { ok: false, msg: '服务器没回这几列的数据' };

    // 就地补进缓存（只改这 7 个键）
    const byId = {};
    _rows.forEach(x => { if (x && x.id) byId[x.id] = x; });
    let hit = 0;
    c.points.forEach(p => {
      const a = byId[p.i];
      if (!a) return;
      p.oc = a.oc; p.oa = a.oa; p.lo = a.lo; p.vc = a.vc; p.lv = a.lv; p.vs = a.vs; p.vt = a.vt;
      hit++;
    });
    // ⚠️ syncedAt / maxU 一律不动（它们表示"上次全量同步"与"增量水位"，补几列不该动它们）
    // ⭐⭐ 2026-10-17（C3）：但**必须记一个 `aggAt`（统计列的更新时间）** ——
    //   否则补完这 7 列后：syncedAt / maxU / count / version 四个判据全都不变
    //   → 前端的保鲜轮询**完全察觉不到**"统计已经更新了"（要等人工刷新页面才看得到）。
    //   ⚠️ 为什么不用 maxU 来当这个信号：**maxU 是客户增量同步的水位**，
    //      把它推前会让增量同步"以为已经同步到那儿"，**反而漏掉中间的真实客户改动** —— 绝对不能碰。
    write({ v: VERSION, syncedAt: c.syncedAt, maxU: c.maxU || 0, count: c.points.length, points: c.points, aggAt: Date.now() });
    console.log('[store] 轻量补字段完成：' + hit + ' 家补上那 7 列（共收到 ' + _rows.length + ' 条）');
    return { ok: true, hit: hit, got: _rows.length, count: c.points.length, from: 'pg-agg' };
  } catch (e) {
    console.error('[store] 轻量补字段失败：', e && e.message);
    return { ok: false, msg: (e && e.message) || '补字段失败' };
  } finally {
    syncing = false;
  }
}

// ⭐ 2026-09-27 M3：**写后回写**（架构文档 §四）—— 前端改完（备注/坐标/字段/删除/建批次）把**那几条**
//   同步进本地缓存，不用等下次全量刷新。写路径不变：**永远先写云端，成功后才调这里**。
//   patches: [{ id, set: { 短键: 值 } }] ｜ removeIds: ['_id', ...]
function patch(patches, removeIds, adds) {
  const c = read();
  if (!c || !Array.isArray(c.points)) return { ok: false, msg: '本地缓存还不存在（没预热过）', patched: 0, removed: 0 };
  const byId = {};
  (patches || []).forEach(p => { if (p && p.id) byId[p.id] = p.set || {}; });
  const rm = {};
  (removeIds || []).forEach(id => { if (id) rm[id] = 1; });
  let patched = 0, removed = 0, added = 0;
  const points = [];
  const seen = {};
  c.points.forEach(p => {
    if (rm[p.i]) { removed++; return; }
    const set = byId[p.i];
    if (set) { Object.keys(set).forEach(k => { p[k] = set[k]; }); patched++; }
    seen[p.i] = 1;
    points.push(p);
  });
  // ⭐⭐ 2026-10-13 老板定（「发送到云端的同时，本地缓存中也应该放一份，这样才能在客户管理中马上看到」）：
  //   **支持"新增"** —— 商城待配对里的「新建」发送成功后，前端把新客户（缓存短键形态）传进来，
  //   直接插进缓存 → 客户管理里马上就有这条（否则只能等 pgsync 5 分钟）。
  //   ⚠️ 已存在（同 `i`）的不重复插，避免手滑重复发送插出两条。
  (adds || []).forEach(a => {
    if (!a || !a.i || seen[a.i]) return;
    points.push(a); seen[a.i] = 1; added++;
  });
  // syncedAt 保持不动（它表示“上次全量同步时间”，界面的「数据截至」用它）
  // ⭐⭐ 2026-10-15 修（依《全项目审查》D05）：**这里必须把 `maxU`（同步水位）一起带过去** ——
  //   原来漏了它，于是"任何一次 patch（改备注 / 改坐标 / 删客户 / 新增客户）之后水位就丢了"，
  //   `watermark()` 只能退回 `syncedAt - 5000` 这个**按本机时钟估算**的值；
  //   一旦这台机器的时钟比云端快，就会**漏掉那段窗口里发生的客户变动**（增量再也补不回来）。
  //   （`unbatch()` 一直是对的、保留着 maxU —— 这里就是对齐它。）
  write({ v: VERSION, syncedAt: c.syncedAt, maxU: c.maxU || 0, count: points.length, points: points });
  return { ok: true, patched: patched, removed: removed, added: added, count: points.length };
}

// ⭐⭐ 2026-10-10 指针表模式：**把某个批次从本地缓存的 bi 里整体摘掉**（删批完成后由 server.js 调用）——
//   前端拼 9448 条 patch 太重；一次请求、服务端内部过一遍数组即可（毫秒级）。
//   ⚠️ 保留 maxU（同步水位）：删批后增量同步仍要按老水位接着拉，别把水位丢了。
function unbatch(batchId) {
  const c = read();
  if (!c || !Array.isArray(c.points)) return { ok: false, msg: '本地缓存还不存在（没预热过）', patched: 0 };
  const bid = String(batchId || '');
  if (!bid) return { ok: false, msg: '缺少 batchId', patched: 0 };
  let patched = 0;
  c.points.forEach(p => {
    if (!p.bi) return;
    const arr = String(p.bi).split(',').filter(x => x);
    if (arr.indexOf(bid) < 0) return;
    p.bi = arr.filter(x => x !== bid).join(',');
    patched++;
  });
  write({ v: VERSION, syncedAt: c.syncedAt, maxU: c.maxU || 0, count: c.points.length, points: c.points });
  return { ok: true, patched: patched, count: c.points.length };
}

// ⭐⭐ 2026-09-29【方案 C】客户数据"变动检测 + 增量补"
//   背景：手机端「加新店」建了客户 → 后台看不到（客户管理页读的是**本地缓存快照**）。
//        老板实测：建了「菲菲杂粮煎饼」，后台「客户管理」里找不到。
//   做法：云端建店时写 settings.custDirtyAt；这里读缓存时顺手比一下，比缓存新就拉**增量**补上。
//   ⚠️ 全程**不阻塞**前端：由 server.js 在返回缓存**之后**异步调用，前端下次取就是新的。
let _dirtyBusy = false;
let _lastDirtyAt = 0;                    // 上次云端报的变动时间（避免重复处理同一个信号）

// 缓存里的"同步水位"：上次已经同步到哪个 updatedAt
function watermark(c) {
  if (!c) return 0;
  if (Number(c.maxU)) return Number(c.maxU);
  return Math.max(0, Number(c.syncedAt || 0) - 5000);   // 老缓存没 maxU：留 5 秒余量，宁可多拉几条
}

// 增量补：走 custSync（只拉 updatedAt > since 的），按 _id 覆盖 / 追加
async function syncIncremental(callApi, cred, since) {
  const c = read();
  if (!c || !Array.isArray(c.points)) return { ok: false, msg: '本地缓存还不存在' };
  const t0 = Date.now();
  const got = [];
  let cursor = '', maxU = since;
  for (let i = 0; i < 50; i++) {          // 最多 50 片 × 1000 条，防死循环
    const res = JSON.parse(await callApi(Object.assign(
      { action: 'custSync', since: since, cursor: cursor, limit: 1000 }, cred || {})));
    if (!res || !res.ok) throw new Error((res && res.msg) || '云函数返回异常');
    const arr = res.points || [];
    got.push.apply(got, arr);
    if (Number(res.maxUpdatedAt) > maxU) maxU = Number(res.maxUpdatedAt);
    if (!res.next || !arr.length) break;
    cursor = res.next;
  }
  // merge：云端返回的覆盖本地同名条；其余原样保留；云端多出来的**追加**（这正是"新建的店"）
  // ⭐⭐ 2026-10-15 修（依《全项目审查》D05）：**合并与写回之前先重读一次缓存** ——
  //   上面的 for 里有 `await callApi(...)`（可能持续几秒），**期间前端完全可能已经 patch 过**
  //   （改备注 / 改坐标 / 删客户，或"商城待配对"里「新建」插进来的新客户）。
  //   如果还拿"进函数那一刻的 `c.points`"当基底去合并，这些**本地已确认的改动就会被整块覆盖掉**
  //   （表现：刚改的又变回去了）。
  //   以重读到的 `base` 为基底，就只会把"云端这批增量"叠上去，**不会反向抹掉本地**。
  const cur = read();
  const base = (cur && Array.isArray(cur.points)) ? cur.points : c.points;
  const baseU = Math.max(Number(cur && cur.maxU) || 0, Number(maxU) || 0);   // 水位只前进、不回退
  const byId = {};
  got.forEach(p => { if (p && p.i) byId[p.i] = p; });
  const merged = [];
  const seen = {};
  base.forEach(p => {
    if (byId[p.i]) { merged.push(byId[p.i]); seen[p.i] = 1; } else { merged.push(p); }
  });
  got.forEach(p => { if (p && p.i && !seen[p.i]) merged.push(p); });
  // syncedAt 保持不动（界面「数据截至」显示的仍是上次全量时间）
  write({ v: VERSION, syncedAt: (cur && cur.syncedAt) || c.syncedAt, maxU: baseU, count: merged.length, points: merged });
  console.log(`[store] 增量补完成：云端 ${got.length} 条变动，缓存 ${base.length} → ${merged.length} 家，耗时 ${Date.now() - t0}ms`);
  return { ok: true, changed: got.length, count: merged.length };
}

// ⭐⭐⭐ 2026-10-12 老板定（B 方案）：「**问服务器，不问云端**」——
//   原来 checkDirty 每 15 秒问**云端** `custDirty`（一天 ~5,760 次/客户端，花钱）；
//   而**服务器上的 pgsync 本来就在同步云端增量**（它已经在花钱干这件事）→ 改成**只问服务器**：
//   后台每 15 秒问服务器 `/stat`（水位）→ 变了 → 从 `/sync` 拉增量 → 合并进本地缓存。
//   ⚠️ **后台侧 0 云端调用**；手机端建的店，服务器同步到之后 15 秒内就能看到（pgsync 默认 1 分钟一轮）。
//   ⚠️ 服务器拉不到 → 什么都不做（**绝不回退云端**，老板 2026-10-12 定）。
async function checkDirtyFromPg() {
  let cfg = {};
  try { cfg = require('./config.json'); } catch (e) { /* 没配就走不了 */ }
  if (!cfg.pgApiUrl) return { ok: false, msg: '没配 pgApiUrl（按设定：不拉云端）' };
  const base = String(cfg.pgApiUrl).replace(/\/+$/, '');
  const tok = cfg.pgApiToken ? ('?token=' + encodeURIComponent(cfg.pgApiToken)) : '';
  const jl = (tok ? '&' : '?');
  // ① 问水位（极轻，几字节）
  const st = await (await fetch(base + '/stat' + tok)).json();
  if (!st || !st.ok) return { ok: false, msg: '服务器没返回' };
  const wm = Number(st.watermark) || 0;
  if (!wm || wm <= _lastDirtyAt) return { ok: false, msg: '没有新变动' };
  _lastDirtyAt = wm;
  // ② 从服务器拉增量（since = 本地缓存水位）
  const c = read();
  if (!c || !Array.isArray(c.points)) return { ok: false, msg: '本地缓存还不存在' };
  const since = watermark(c);
  const t0 = Date.now();
  const sy = await (await fetch(base + '/sync' + tok + jl + 'since=' + encodeURIComponent(String(since)))).json();
  if (!sy || !sy.ok) return { ok: false, msg: '服务器拉增量失败' };
  // ⭐⭐ 2026-10-17（B 档）：字段清单已收进文件顶部的主表（M_SYNC = 客户字段、不含聚合列）
  const got = rowsToPoints(sy.rows, M_SYNC);
  // ③ 合并（与 syncIncremental 同一套：覆盖同 id / 其余保留 / 新增追加）
  const byId = {};
  got.forEach(p => { if (p && p.i) byId[p.i] = p; });
  const removed = {}; (sy.removed || []).forEach(x => { removed[x] = 1; });
  const merged = [];
  const seen = {};
  c.points.forEach(p => {
    if (removed[p.i]) return;                                  // 服务器说"这条删了" → 从缓存摘掉
    if (byId[p.i]) { merged.push(byId[p.i]); seen[p.i] = 1; } else { merged.push(p); }
  });
  got.forEach(p => { if (p && p.i && !seen[p.i]) merged.push(p); });
  let maxU = since;
  got.forEach(p => { const u = Number(p.u) || 0; if (u > maxU) maxU = u; });
  write({ v: VERSION, syncedAt: c.syncedAt, maxU: maxU, count: merged.length, points: merged });
  console.log('[store] 从服务器补增量：' + got.length + ' 条变动、' + (sy.removed || []).length + ' 条删除，缓存 ' +
    c.points.length + ' → ' + merged.length + ' 家，耗时 ' + (Date.now() - t0) + 'ms');
  return { ok: true, changed: got.length, count: merged.length };
}

// 检查云端有没有变动；有就拉增量补进缓存。返回 true = 这次补了数据（前端据此重取列表）
async function checkDirty(callApi, cred) {
  if (_dirtyBusy) return false;                        // 正在处理，别叠
  _dirtyBusy = true;
  try {
    const res = JSON.parse(await callApi(Object.assign({ action: 'custDirty' }, cred || {})));
    const at = (res && res.ok && Number(res.at)) || 0;
    if (!at || at <= _lastDirtyAt) return false;       // 没变动 / 同一个信号
    _lastDirtyAt = at;
    const since = watermark(read());
    if (at > since) {                                  // 云端比缓存的"水位"新 → 补
      const r = await syncIncremental(callApi, cred, since);
      return !!(r && r.ok);
    }
    return false;
  } catch (e) {
    console.error('[store] 变动检测失败（不影响使用）：', e && e.message);
    return false;
  } finally {
    _dirtyBusy = false;
  }
}

// ⭐⭐ 2026-10-08 老板定（省钱的根子）：**全量只拉一次，之后只补增量** ——
//   ⚠️ 原来：`isFreshToday` 只认"今天"→ **隔天就全量重拉**（7.5 万条 ≈ 7.5 万次数据库读 + 75MB 流量），
//      而且是**每台电脑各自拉一遍** → 老板实测"1 台十几块/天、2 台几十块"（成本 ∝ 台数）。
//   ⭐ 现在：**只有"真的没有缓存"（新电脑 / 首次 / 换目录）才全量**；
//      之后每天改成**增量兜底**（拿缓存里的水位 `maxU` 当 since，只拉 updatedAt 更新的那几十条）→ 日常成本降 99%+。
//   ⚠️ 前提：所有"写客户"的地方都要写 `updatedAt`（2026-09-27 已补齐 **21 处**写入点）。
//   ⚠️ **唯一漏网 = 删除**：`custSync` 排除了已删，所以"删除"不会通过增量传下来 → 前端删完必须自己调
//      `/mapPoints/patch` 的 removeIds 把它摘掉（`geoDeletePicked` 已做）。恢复则靠增量自然带回来。
//   ⚠️ 想强制全量重拉：删掉 `admin/cache/map-points.json`，或点后台的「🔄 更新地图数据」（仍走 `refresh`）。
function startAutoRefresh(callApi, cred) {
  const c = read();
  if (!c) {
    console.log('[store] 无本地缓存（新电脑 / 首次）→ 全量预热…');
    refresh(callApi, cred).catch(() => null);
    return;
  }
  if (isFreshToday(c)) {
    console.log(`[store] 今天已同步过（${c.points.length} 家），跳过`);
    return;
  }
  const since = watermark(c);
  console.log(`[store] 隔天 → 只补增量（水位 ${new Date(since).toLocaleString()}），不再全量重拉`);
  syncIncremental(callApi, cred, since)
    .then(r => { if (r && r.ok) console.log('[store] 增量兜底完成：' + JSON.stringify(r)); })
    .catch(() => null);
}

// ⭐ 2026-10-17（B 档）：多导出字段表与两个转换函数 ——
//   用途：① 对账/验证脚本可以直接调**真代码**（而不是在脚本里另抄一份逻辑）；
//         ② 以后写"导出客户"之类的功能，字段清单一处取（`CUST_FIELDS` 带中文名）。
module.exports = { read, write, status, refresh, refreshAgg, cancelRefresh, patch, unbatch, checkDirty, checkDirtyFromPg, syncIncremental, startAutoRefresh, isFreshToday, FILE, CACHE_DIR,
  CUST_FIELDS, AGG_FIELDS, ALL_FIELDS, M_POINTS, M_SYNC, rowsToPoints, slimPoints };
