// 数据快照导出（给「大批导入前先留退路」用）
//
// 用途：像杭州这种十几万条的大批导入之前，先把 customers / orders / order_items 全量导一份到本地。
//       出事时用配套的 restore_snapshot.js 比对：**新增的删掉、被改的恢复回去**。
//
// 用法：
//   node admin/tools/export_snapshot.js                       # 默认导到 _scratch/snapshot-<时间戳>/
//   node admin/tools/export_snapshot.js --out D:\bak\hz1006   # 指定目录
//   node admin/tools/export_snapshot.js --only customers      # 只导某一（几）个集合，逗号分隔
//
// 产物：
//   <out>/customers.jsonl    ← **一行一条**（JSON Lines：每行本身就是一个完整 JSON 对象）
//   <out>/orders.jsonl          用 .jsonl 是为了**流式安全**：几十万条不会撑爆内存，中途断了已写的也不丢
//   <out>/order_items.jsonl
//   <out>/_meta.json         ← 导出时间 / envId / 各集合条数与体积（回滚脚本靠它对数）
//
// ⚠️ 分页用 **`_id` 游标**（orderBy('_id') + `_id > 上一批最后一条`）—— 服务端单次上限 1000 条（实测）。
// ⚠️ 本脚本**只读**，不改任何云端数据。
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const ENV = cfg.envId;
const PAGE = 1000;                                    // 实测服务端单次最多返回 1000 条
const ALL = ['customers', 'orders', 'order_items'];

const argv = process.argv.slice(2);
const getArg = k => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] || '') : ''; };
const only = getArg('--only');
const colls = only ? only.split(',').map(s => s.trim()).filter(Boolean) : ALL;
const bad = colls.filter(c => ALL.indexOf(c) < 0);
if (bad.length) { console.log('❌ 不认识的集合：' + bad.join(', ') + '（只支持 ' + ALL.join(' / ') + '）'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const d0 = new Date();
const stamp = '' + d0.getFullYear() + pad(d0.getMonth() + 1) + pad(d0.getDate()) + '-' + pad(d0.getHours()) + pad(d0.getMinutes()) + pad(d0.getSeconds());
const outDir = path.resolve(getArg('--out') || path.join(__dirname, '..', '..', '_scratch', 'snapshot-' + stamp));

async function getToken() {
  const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: cfg.appid, secret: cfg.appsecret, force_refresh: false })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('取 token 失败：' + (j.errmsg || j.errcode));
  return j.access_token;
}
async function q(tk, query) {
  const isCount = /\.count\(\)\s*$/.test(query);
  const r = await fetch(`https://api.weixin.qq.com/tcb/${isCount ? 'databasecount' : 'databasequery'}?access_token=` + tk, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: ENV, query })
  });
  return await r.json();
}

(async () => {
  if (!cfg.appid || !cfg.appsecret || !cfg.envId) { console.log('❌ admin/config.json 缺 appid / appsecret / envId'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  console.log('聚火拜访 · 数据快照导出（只读）');
  console.log('环境 envId = ' + ENV);
  console.log('输出目录   = ' + outDir);
  console.log('集合       = ' + colls.join(' / '));
  console.log('─'.repeat(64));

  const tk = await getToken();
  const meta = { exportedAt: new Date().toISOString(), envId: ENV, pageSize: PAGE, collections: {} };
  const tAll = Date.now();

  for (const coll of colls) {
    const fp = path.join(outDir, coll + '.jsonl');
    fs.writeFileSync(fp, '');
    const cnt = await q(tk, `db.collection("${coll}").count()`);
    const total = typeof cnt.count === 'number' ? cnt.count : -1;
    console.log('\n▶ ' + coll + '  （云端共 ' + total + ' 条）');

    let last = '', got = 0, bytes = 0, page = 0;
    const t0 = Date.now();
    for (;;) {
      const where = last ? `{_id: _.gt("${last}")}` : '{}';
      const r = await q(tk, `db.collection("${coll}").where(${where}).orderBy("_id", "asc").limit(${PAGE}).get()`);
      if (r.errcode !== 0) { console.log('  ❌ 第 ' + (page + 1) + ' 页失败：' + JSON.stringify(r).slice(0, 200)); break; }
      const arr = r.data || [];
      if (!arr.length) break;
      const chunk = arr.join('\n') + '\n';
      fs.appendFileSync(fp, chunk);
      bytes += Buffer.byteLength(chunk, 'utf8');
      got += arr.length;
      page++;
      last = JSON.parse(arr[arr.length - 1])._id;
      if (page % 10 === 0 || arr.length < PAGE) {
        console.log('    第 ' + String(page).padStart(3) + ' 页 → 累计 ' + String(got).padStart(6) + ' 条 / ' +
          (bytes / 1024 / 1024).toFixed(1) + ' MB');
      }
      if (arr.length < PAGE) break;
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = (total < 0) || (got === total);
    console.log('  ' + (ok ? '✅' : '⚠️ ') + ' ' + coll + ' 导出 ' + got + ' 条 / ' + (bytes / 1024 / 1024).toFixed(1) +
      ' MB ｜ ' + page + ' 页 ｜ ' + sec + 's' + (ok ? '' : '（与云端计数 ' + total + ' 不一致，请复查）'));
    meta.collections[coll] = { count: got, cloudCount: total, bytes: bytes, pages: page, seconds: Number(sec), file: coll + '.jsonl', matched: ok };
  }

  meta.secondsTotal = Number(((Date.now() - tAll) / 1000).toFixed(1));
  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify(meta, null, 2));
  console.log('\n' + '─'.repeat(64));
  console.log('✅ 完成，用时 ' + meta.secondsTotal + 's');
  console.log('   元信息：' + path.join(outDir, '_meta.json'));
  console.log('\n下一步：导入完如果发现问题，用回滚工具比对（**默认只预览、不写**）：');
  console.log('   node admin/tools/restore_snapshot.js --in "' + outDir + '"');
})().catch(e => { console.error('\n❌ 失败：' + (e && e.message ? e.message : e)); process.exitCode = 1; });
