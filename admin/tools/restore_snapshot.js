// 数据快照「回滚 / 比对」工具（配合 export_snapshot.js）
//
// 用途：大批导入（如杭州十几万条）出问题时，拿导入前的快照和**当前云端**比对：
//   · **新增** = 云端有、快照没有的 → 这批就是"导入进来的"
//   · **被改** = 两边都有、但内容不一样 → 被覆盖了（如杭州表把金华某家改了）
//   · **缺失** = 快照有、云端没有 → 被删了（少见）
// 然后按你的指示处置。
//
// ⚠️⚠️ 默认**只预览、一个字都不写**。要动手必须显式加开关，且建议先 --soft-delete-new 看效果。
//
// 用法：
//   node admin/tools/restore_snapshot.js --in <快照目录>                    # ① 只预览（默认，安全）
//   node admin/tools/restore_snapshot.js --in <dir> --soft-delete-new       # ② 新增客户"软删"（进回收站，可恢复）
//   node admin/tools/restore_snapshot.js --in <dir> --hard-delete-new       # ③ 真删新增客户（连带订单/明细/批次成员）
//   node admin/tools/restore_snapshot.js --in <dir> --restore-changed       # ④ 把"被改"的恢复成快照内容
//   可加 --only customers,orders 限定集合
//
// ⚠️ 大快照（customers 十几万条）吃内存，必要时：
//   node --max-old-space-size=4096 admin/tools/restore_snapshot.js --in <dir>
// ⚠️ ③ 是不可逆的（删云存储照片/录音更不可逆，本脚本**不碰云存储**）—— 想保守就用 ②。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const ENV = cfg.envId;
const PAGE = 1000;

const argv = process.argv.slice(2);
const getArg = k => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] || '') : ''; };
const has = k => argv.indexOf(k) >= 0;

const inDir = path.resolve(getArg('--in') || '');
const only = getArg('--only');
const colls = only ? only.split(',').map(s => s.trim()).filter(Boolean) : ['customers', 'orders', 'order_items'];
const DO_SOFT = has('--soft-delete-new');
const DO_HARD = has('--hard-delete-new');
const DO_RESTORE = has('--restore-changed');
const WRITE = DO_SOFT || DO_HARD || DO_RESTORE;

if (!inDir || !fs.existsSync(inDir)) { console.log('❌ 请用 --in <快照目录> 指定快照（export_snapshot.js 生成的那个目录）'); process.exit(1); }

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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: ENV, query })
  });
  return await r.json();
}
async function upd(tk, query) {
  const r = await fetch('https://api.weixin.qq.com/tcb/databaseupdate?access_token=' + tk, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: ENV, query })
  });
  return await r.json();
}
async function del(tk, query) {
  const r = await fetch('https://api.weixin.qq.com/tcb/databasedelete?access_token=' + tk, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: ENV, query })
  });
  return await r.json();
}

// 流式读 .jsonl → Map(_id → 原始行文本)，避免一次性 split 大文件
async function loadSnapshot(coll) {
  const fp = path.join(inDir, coll + '.jsonl');
  const map = new Map();
  if (!fs.existsSync(fp)) return map;
  const rl = readline.createInterface({ input: fs.createReadStream(fp, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && o._id) map.set(o._id, t); } catch (e) { /* 坏行跳过 */ }
  }
  return map;
}

// 拉云端当前（_id 游标分页），逐条回调，避免全量驻留
async function walkCloud(tk, coll, onRow) {
  let last = '';
  for (;;) {
    const where = last ? `{_id: _.gt("${last}")}` : '{}';
    const r = await q(tk, `db.collection("${coll}").where(${where}).orderBy("_id", "asc").limit(${PAGE}).get()`);
    if (r.errcode !== 0) throw new Error('拉取 ' + coll + ' 失败：' + JSON.stringify(r).slice(0, 160));
    const arr = r.data || [];
    for (const s of arr) await onRow(s);
    if (arr.length < PAGE) break;
    last = JSON.parse(arr[arr.length - 1])._id;
  }
}

function cityOf(seedLine) {
  try { const o = JSON.parse(seedLine); return o.city || '(无城市)'; } catch (e) { return '(解析失败)'; }
}

(async () => {
  const tk = await getToken();
  console.log('聚火拜访 · 快照比对 / 回滚');
  console.log('快照目录 = ' + inDir);
  console.log('模式     = ' + (WRITE ? '【会写云端】' + (DO_SOFT ? ' 软删新增' : '') + (DO_HARD ? ' 真删新增' : '') + (DO_RESTORE ? ' 恢复被改' : '') : '【只预览，不写】'));
  console.log('─'.repeat(66));

  const report = {};
  for (const coll of colls) {
    const snap = await loadSnapshot(coll);
    if (!snap.size && !fs.existsSync(path.join(inDir, coll + '.jsonl'))) { console.log('\n▶ ' + coll + '：快照里没有这个集合，跳过'); continue; }

    const added = [], changed = [], missing = [];
    // ⚠️ 必须先记下条数 —— 下面 walkCloud 会把命中的从 snap 里 delete 掉（用来找"缺失"），
    //    事后再读 snap.size 就成了 0，界面会显示成"快照 0 条"，白白吓人一跳。
    const snapN = snap.size;
    let cloudN = 0;
    await walkCloud(tk, coll, (s) => {
      cloudN++;
      const o = JSON.parse(s);
      const old = snap.get(o._id);
      if (old === undefined) { added.push(s); return; }
      if (old !== s) changed.push({ id: o._id, now: s, old: old });
      snap.delete(o._id);                       // 剩下的就是"快照有、云端没有"的
    });
    for (const [id, line] of snap) missing.push(line);

    // 新增的按城市分布（只对 customers 有意义；其它集合就是纯计数）
    const byCity = {};
    added.forEach(l => { const c = cityOf(l); byCity[c] = (byCity[c] || 0) + 1; });
    const topCities = Object.keys(byCity).sort((a, b) => byCity[b] - byCity[a]).slice(0, 8)
      .map(c => c + ' ' + byCity[c]).join(' ｜ ');

    console.log('\n▶ ' + coll + '   快照 ' + snapN + ' ｜ 云端 ' + cloudN);
    console.log('   🆕 新增 ' + added.length + ' 条' + (added.length ? '   ← 这些是导入进来的' : ''));
    if (added.length) {
      console.log('      按城市：' + topCities);
      added.slice(0, 5).forEach(l => { const o = JSON.parse(l); console.log('        · ' + (o.name || o.orderNo || o._id) + '  码=' + (o.mallCode || o.customerCode || '-') + '  ' + (o.city || '')); });
    }
    console.log('   ✏️  被改 ' + changed.length + ' 条');
    if (changed.length) changed.slice(0, 5).forEach(x => { const o = JSON.parse(x.now); console.log('        · ' + (o.name || o.orderNo || x.id) + '  id=' + x.id); });
    console.log('   ❓ 缺失 ' + missing.length + ' 条（快照有、云端没有）');
    report[coll] = { added: added.map(JSON.parse), changed: changed.map(x => ({ id: x.id, now: JSON.parse(x.now), old: JSON.parse(x.old) })), missing: missing.map(JSON.parse) };
  }

  if (!WRITE) {
    console.log('\n' + '─'.repeat(66));
    console.log('以上只是预览。确认"新增的就该删"之后，选一种：');
    console.log('  保守（可恢复）： --soft-delete-new    → 新增客户进回收站，随时能恢复');
    console.log('  彻底（不可逆）： --hard-delete-new    → 真删新增客户，连带它们的订单/明细/批次成员');
    console.log('  改回原样：       --restore-changed    → 被覆盖的客户恢复成快照内容');
    return;
  }

  // ===== 下面才真正写 =====
  console.log('\n' + '─'.repeat(66));
  console.log('开始执行…');
  const now = Date.now();

  if ((DO_SOFT || DO_HARD) && report.customers && report.customers.added.length) {
    const ids = report.customers.added.map(o => o._id);
    const chunk = 200;
    if (DO_SOFT) {
      let okN = 0;
      for (let i = 0; i < ids.length; i += chunk) {
        const part = ids.slice(i, i + chunk).map(x => '"' + x + '"').join(',');
        const r = await upd(tk, `db.collection("customers").where({_id: _.in([${part}])}).update({data: {deleted: true, deletedAt: ${now}, deletedBy: "rollback:snapshot"}})`);
        okN += (r && r.modified) || 0;
      }
      console.log('✅ 新增客户已软删 ' + okN + ' 家（去「🏪 客户管理 → 🗑 回收站」可恢复）');
    } else {
      let okN = 0;
      for (let i = 0; i < ids.length; i += chunk) {
        const part = ids.slice(i, i + chunk).map(x => '"' + x + '"').join(',');
        const r = await del(tk, `db.collection("customers").where({_id: _.in([${part}])}).remove()`);
        okN += (r && r.deleted) || 0;
      }
      console.log('✅ 新增客户已真删 ' + okN + ' 家');
      // 连带：订单 / 明细（按"新增客户的编号"）、批次成员（按 customerId）
      const codes = report.customers.added.map(o => String(o.mallCode || '').trim()).filter(Boolean);
      if (codes.length && report.orders) {
        let d = 0;
        for (let i = 0; i < codes.length; i += chunk) {
          const part = codes.slice(i, i + chunk).map(x => '"' + x + '"').join(',');
          const r = await del(tk, `db.collection("orders").where({customerCode: _.in([${part}])}).remove()`);
          d += (r && r.deleted) || 0;
        }
        console.log('   · 连带订单 ' + d + ' 单');
      }
      if (report.order_items && report.order_items.added.length) {
        console.log('   · 明细按订单号关联 —— 建议导入前同时留一份 order_items 快照（本脚本已支持）');
      }
      let m = 0;
      for (let i = 0; i < ids.length; i += chunk) {
        const part = ids.slice(i, i + chunk).map(x => '"' + x + '"').join(',');
        const r = await del(tk, `db.collection("batch_members").where({customerId: _.in([${part}])}).remove()`);
        m += (r && r.deleted) || 0;
      }
      console.log('   · 连带批次成员 ' + m + ' 条');
      console.log('   ⚠️ 未碰云存储照片/录音，也未清 coord_fix_requests / customer_remarks / transcripts —— 需要的话单独说');
    }
  }

  if (DO_RESTORE && report.customers && report.customers.changed.length) {
    let okN = 0;
    for (const x of report.customers.changed) {
      const doc = Object.assign({}, x.old);
      delete doc._id;
      doc.updatedAt = now;
      const r = await upd(tk, `db.collection("customers").where({_id: "${x.id}"}).update({data: ${JSON.stringify(doc)}})`);
      if (r && r.errcode === 0) okN++;
    }
    console.log('✅ 被改的客户已恢复 ' + okN + ' / ' + report.customers.changed.length + ' 家');
  }

  console.log('\n完成。建议再做一次只读比对复查：');
  console.log('   node admin/tools/restore_snapshot.js --in "' + inDir + '"');
})().catch(e => { console.error('\n❌ 失败：' + (e && e.message ? e.message : e)); process.exitCode = 1; });
