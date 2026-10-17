// ============================================================================
// 三方对账工具（只读，绝不改任何数据）
//   用途：随时回答「云端 / 服务器 PG / 本地缓存，这三份一致吗？差多少？差在哪？」
//   起因：2026-10-17 老板报障「这里缺那里缺、修一个坑挖一个坑」
//         —— 根因是"没有人能一眼看出三方是否一致"，全靠肉眼发现界面空了。
//
// 用法（在项目根目录）：
//   node admin/tools/reconcile.js            只跑「① 总量 + ② 字段有值率」（几十秒）
//   node admin/tools/reconcile.js --full     再跑「③ 逐条抽样比对」（约 1 分钟）
//
// 三层各查什么：
//   ① 总量      ：缓存 count / PG count / 云端条数（云端不支持 count()，用分页数）
//   ② 字段有值率：同一批字段，在三份里各有多少条"有值"
//   ③ 逐条比对  ：从缓存随机取 N 家，去 PG / 云端查同一条，逐字段比"值是否相同"
//
// ⚠️ 只读：只发 GET / 只发 databasequery（查询），没有任何 update / add / delete。
// ⚠️ 跑在哪：你这台后台机（因为本地缓存文件在这台机器上）。
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CACHE = path.join(ROOT, 'admin', 'cache', 'map-points.json');
const FULL = process.argv.indexOf('--full') >= 0;

// ── 要比的字段：[短键(缓存), PG列名, 云端字段名, 中文名]
const FIELDS = [
  ['n', 'name', 'name', '店名'],
  ['ph', 'phone', 'phone', '电话'],
  ['ad', 'address', 'address', '地址'],
  ['d', 'district', 'district', '区域'],
  ['la', 'lat', 'lat', '纬度'],
  ['mc', 'code', 'mallCode', '客户编号'],
  ['mk', 'mall_key', 'mallKey', '商城Key'],
  ['ml', 'mall_level', 'mallLevel', '商城等级'],
  ['msrc', 'mall_source', 'mallSource', '商城来源'],
  ['mcat', 'mall_category', 'mallCategory', '商城分类'],
  ['sm', 'salesman', 'salesman', '签约业务员'],
];

const val = v => (v === null || v === undefined) ? '' : String(v).trim();
const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const rpad = (s, n) => { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; };

// 读配置（两份：本机后台配置 / PG 只读接口）
function readCfg(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
const cfg = readCfg(path.join(ROOT, 'admin', 'config.json')) || {};

async function token() {
  const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: cfg.appid, secret: cfg.appsecret, force_refresh: false })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('取 token 失败：' + (j.errmsg || j.errcode));
  return j.access_token;
}

(async () => {
  const t0 = Date.now();
  console.log('================ 三方对账（只读） ================');
  console.log('缓存文件: ' + CACHE);
  console.log('');

  // ══════════ ① 本地缓存 ══════════
  if (!fs.existsSync(CACHE)) { console.error('❌ 本地缓存不存在：' + CACHE + '（先打开后台让它预热）'); process.exit(1); }
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const cpoints = Array.isArray(cache.points) ? cache.points : [];
  const cacheStat = { v: cache.v, count: cpoints.length, syncedAt: cache.syncedAt, maxU: cache.maxU };
  const cacheHas = {};
  FIELDS.forEach(([k]) => { cacheHas[k] = 0; });
  cpoints.forEach(p => FIELDS.forEach(([k]) => { if (val(p[k])) cacheHas[k]++; }));

  // ══════════ ② PG（走只读接口 /points，分批） ══════════
  const pgBase = String(cfg.pgApiUrl || '').replace(/\/+$/, '');
  const pgTok = cfg.pgApiToken ? ('?token=' + encodeURIComponent(cfg.pgApiToken)) : '';
  let pgRows = [];
  let pgOk = false;
  if (pgBase) {
    try {
      let after = '';
      for (let i = 0; i < 200; i++) {
        const u = pgBase + '/points' + pgTok + (pgTok ? '&' : '?') + 'limit=20000' + (after ? ('&after=' + encodeURIComponent(after)) : '');
        const r = await (await fetch(u, { signal: AbortSignal.timeout(60000) })).json();
        if (!r || !r.ok || !Array.isArray(r.rows)) break;
        pgRows = pgRows.concat(r.rows);
        process.stdout.write('\r  拉 PG… ' + pgRows.length + ' 家');
        if (!r.hasMore || !r.rows.length) break;
        after = r.last || '';
      }
      process.stdout.write('\n');
      pgOk = pgRows.length > 0;
    } catch (e) { console.log('\n  ⚠️ PG 拉取失败：' + e.message); }
  }
  const pgHas = {};
  FIELDS.forEach(([, pgCol]) => { pgHas[pgCol] = 0; });
  pgRows.forEach(r => FIELDS.forEach(([, pgCol]) => { if (val(r[pgCol])) pgHas[pgCol]++; }));

  // ══════════ ③ 云端（抽样：分页取 2 批 × 1000） ══════════
  //   ⚠️ 这个 HTTP 接口不支持 count()（实测返回整条文档而不是总数）→ 只能分页数
  let cloudRows = [];
  let cloudOk = false;
  try {
    const at = await token();
    const q = async (query) => {
      const r = await fetch('https://api.weixin.qq.com/tcb/databasequery?access_token=' + at, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: cfg.envId, query })
      }).then(x => x.json());
      if (r.errcode) throw new Error(r.errmsg);
      return (r.data || []).map(s => JSON.parse(s));
    };
    // 抽样 2 页（足够看出"字段有值率"的结构性差异；全量太慢）
    let last = '';
    for (let i = 0; i < 2; i++) {
      const cond = last ? ("{_id: _.gt('" + last + "')}") : '{}';
      const rows = await q("db.collection('customers').where(" + cond + ").orderBy('_id','asc').limit(1000).get()");
      if (!rows.length) break;
      cloudRows = cloudRows.concat(rows);
      last = rows[rows.length - 1]._id;
    }
    cloudOk = cloudRows.length > 0;
  } catch (e) { console.log('  ⚠️ 云端抽样失败：' + e.message); }
  const cloudHas = {};
  FIELDS.forEach(([, , cl]) => { cloudHas[cl] = 0; });
  cloudRows.forEach(c => FIELDS.forEach(([, , cl]) => { if (val(c[cl])) cloudHas[cl]++; }));

  // ══════════ 输出 ① 总量 ══════════
  console.log('────────────────────────────────────────────────────────');
  console.log('① 总量');
  console.log('   本地缓存 : %s 家   （v%s，数据截至 %s）',
    rpad(cacheStat.count, 8), cacheStat.v, cacheStat.syncedAt ? new Date(cacheStat.syncedAt).toLocaleString('zh-CN') : '—');
  console.log('   服务器 PG: %s 家', rpad(pgOk ? pgRows.length : '拉取失败', 8));
  console.log('   云端     : %s 家（⚠️ 这是抽样 2×1000，不是总数；该接口不支持 count）', rpad(cloudOk ? cloudRows.length : '失败', 8));
  console.log('');

  // ══════════ 输出 ② 字段有值率 ══════════
  console.log('────────────────────────────────────────────────────────');
  console.log('② 字段有值数（缓存 vs PG 是全量；云端是抽样 %d 家，只看比例）', cloudRows.length);
  console.log('   %s %s %s %s %s', pad('字段', 14), rpad('缓存', 9), rpad('PG', 9), rpad('云端抽样', 10), rpad('差(PG-缓存)', 12));
  let diffCnt = 0;
  FIELDS.forEach(([ck, pgCol, clName, cn]) => {
    const a = cacheHas[ck], b = pgHas[pgCol], diff = (pgOk ? (b - a) : NaN);
    if (isFinite(diff) && Math.abs(diff) > Math.max(20, a * 0.005)) diffCnt++;
    console.log('   %s %s %s %s %s',
      pad(cn + '(' + ck + ')', 14), rpad(a, 9), rpad(pgOk ? b : '—', 9),
      rpad(cloudOk ? cloudHas[clName] : '—', 10),
      rpad(isFinite(diff) ? (diff > 0 ? '+' + diff : String(diff)) : '—', 12));
  });
  console.log('');
  if (diffCnt === 0 && pgOk) console.log('   ✅ 缓存与 PG 在这些字段上基本一致');
  else if (pgOk) console.log('   ⚠️ 有 %d 个字段缓存与 PG 差得较多（见上），说明缓存可能没刷新到最新', diffCnt);
  console.log('');

  // ══════════ 输出 ③ 逐条比对（--full） ══════════
  if (FULL && pgOk) {
    console.log('────────────────────────────────────────────────────────');
    console.log('③ 逐条抽样比对（从缓存随机取 200 家，去 PG 找同一条逐字段比）');
    const pgById = {};
    pgRows.forEach(r => { if (r.id) pgById[r.id] = r; });
    const sample = [];
    for (let i = 0; i < Math.min(200, cpoints.length); i++) {
      sample.push(cpoints[Math.floor(Math.random() * cpoints.length)]);
    }
    let found = 0, same = 0;
    const diffs = [];
    sample.forEach(p => {
      const r = pgById[p.i];
      if (!r) { diffs.push({ id: p.i, name: p.n, why: 'PG 里没有这条' }); return; }
      found++;
      let ok = true;
      const bad = [];
      FIELDS.forEach(([ck, pgCol, , cn]) => {
        const a = val(p[ck]), b = val(r[pgCol]);
        if (a !== b) { ok = false; bad.push(cn + ':「' + a + '」vs「' + b + '」'); }
      });
      if (ok) same++; else diffs.push({ id: p.i, name: p.n, why: bad.slice(0, 3).join(' / ') });
    });
    console.log('   抽了 %d 家：PG 找到 %d 家，其中 %d 家字段完全一致、%d 家有差异',
      sample.length, found, same, diffs.length);
    diffs.slice(0, 10).forEach(d => console.log('     · %s（%s）: %s', String(d.name).slice(0, 18), d.id, d.why));
    if (diffs.length > 10) console.log('     …还有 %d 条', diffs.length - 10);
    console.log('');
  }

  console.log('================ 完成，耗时 %d 秒（只读，未改任何数据） ================', Math.round((Date.now() - t0) / 1000));
})().catch(e => { console.error('❌ 对账失败：' + e.message); process.exit(1); });
