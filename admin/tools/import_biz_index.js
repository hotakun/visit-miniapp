// 「加新店」识别数据一次性导入：把 tasks/biz_index.json 写进云数据库集合 biz_index
// ---------------------------------------------------------------------------
// 为什么导入：69773 条 3.45MB 打进云函数包会让**每次部署都多传 3.45MB**，
//   而且以后扩城市（金华全域 / 杭州）必然超过云函数 10MB 上限 → 数据搬进数据库更合适。
//
// 用法（在 admin 目录下）：
//   cd admin && node tools/import_biz_index.js            # 正式导入
//   cd admin && node tools/import_biz_index.js --dry      # 只看分片，不调云端
//
// ⚠️ 前置条件：**importdata 云函数已重传**（含 biz_index 分支，否则报 BAD_TYPE）
// ⚠️ 幂等：文档 _id 由序号生成（b0、b1…）→ 重复跑不会翻倍
// 凭据：admin/config.json（appid / appsecret / envId）
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const SRC = path.join(__dirname, '..', '..', 'miniprogram', 'cloudfunctions', 'tasks', 'biz_index.json');
const SLICE_BYTES = 60000;     // 每片 ≈60KB（云函数入参上限 100KB —— 与修正 010 的口径一致）
const CONCURRENCY = 4;         // 4 片并发（与后台导入一致：全量导入时间砍到 1/4）
const DRY = process.argv.indexOf('--dry') >= 0;

async function getToken() {
  if (!cfg.appid || !cfg.appsecret || !cfg.envId) {
    console.log('❌ admin/config.json 缺 appid / appsecret / envId');
    process.exit(1);
  }
  const r = await (await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`)).json();
  if (!r.access_token) {
    console.log('❌ 取 access_token 失败：', r.errmsg || '', '(' + r.errcode + ')');
    if (r.errcode === 40164) console.log('   40164 = 本机公网 IP 不在白名单（去 mp 后台加白）');
    process.exit(1);
  }
  return r.access_token;
}

// 调 importdata 云函数导一片
async function importSlice(token, rows, tag) {
  const body = { action: 'import', type: 'biz_index', rows, username: 'qingyan', password: '123456' };
  const res = await fetch(`https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${token}&env=${cfg.envId}&name=importdata`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const r = await res.json();
  if (r.errcode) throw new Error((r.errmsg || '') + ' (' + r.errcode + ')');
  let out = r.resp_data;
  try { out = JSON.parse(out); } catch (e) { /* 原样 */ }
  if (!out || !out.ok) throw new Error('云函数返回：' + JSON.stringify(out).slice(0, 200));
  console.log('  第 ' + tag + ' 片 ✅ 新增 ' + out.inserted + ' / 更新 ' + out.updated + ' / 跳过 ' + out.skipped +
    (out.failedCount ? (' ⚠️ 失败 ' + out.failedCount) : '') + '  (' + out.ms + 'ms)');
  return out;
}

(async () => {
  if (!fs.existsSync(SRC)) { console.log('❌ 找不到源文件：' + SRC); process.exit(1); }
  const arr = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  console.log('源数据 ' + arr.length + ' 条');
  const rows = arr
    .filter(p => p && p[0] && p[1])                       // 跳过 (0,0) 空坐标
    .map((p, i) => ({ _id: 'b' + i, lat: p[0], lng: p[1], area: p[2] || '', biz: p[3] || '' }));
  console.log('有效 ' + rows.length + ' 条（已跳过空坐标）');

  // 按字节切片
  const slices = [];
  let cur = [], bytes = 0;
  for (const r of rows) {
    const b = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
    if (bytes + b > SLICE_BYTES && cur.length) { slices.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += b;
  }
  if (cur.length) slices.push(cur);
  console.log('→ 切成 ' + slices.length + ' 片（每片 ≤' + (SLICE_BYTES / 1024) + 'KB），' + CONCURRENCY + ' 片并发');

  if (DRY) { console.log('--dry：只算分片，不调云端。'); return; }

  const token = await getToken();
  console.log('✅ access_token 获取成功，开始导入…');
  const t0 = Date.now();
  let inserted = 0, updated = 0, skipped = 0, failed = 0;
  for (let i = 0; i < slices.length; i += CONCURRENCY) {
    const batch = slices.slice(i, i + CONCURRENCY);
    const outs = await Promise.all(batch.map((s, k) => importSlice(token, s, i + k + 1).catch(e => {
      console.log('  ❌ 第 ' + (i + k + 1) + ' 片失败：' + (e && e.message));
      return null;
    })));
    outs.forEach(o => {
      if (!o) { failed++; return; }
      inserted += o.inserted || 0; updated += o.updated || 0; skipped += o.skipped || 0;
      failed += o.failedCount || 0;
    });
  }
  console.log('===== 导入完成 =====');
  console.log('新增 ' + inserted + ' ｜ 更新 ' + updated + ' ｜ 跳过 ' + skipped + ' ｜ 失败 ' + failed +
    ' ｜ 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('下一步：cd admin && node tools/add_index.js（给 biz_index 建 lat+lng 索引）');
})();
