// 把 biz_index.json 转成「云开发控制台可导入」的 JSONL（每行一个 JSON 对象）
// ---------------------------------------------------------------------------
// 为什么不再走 importdata 云函数：2026-09-28 实测 —— 7 万条首导会
//   ① 单片 670 条×2 次操作 → 擦着云函数 30s 超时（-601008）
//   ② 4 片并发 120 个数据库操作 → 触发环境限流（EXCEED_RATELIMIT -501024）
// → 改用**控制台导入**（服务端批量，快、不限流、零代码）
//
// 用法：cd admin && node tools/export_biz_jsonl.js
// 产出：_scratch/newshop_out/biz_index.jsonl
//   ⚠️ **不带 _id**（让云开发自动生成）→ 所以导入前请确保集合是空的（集合里若已有数据，先清空再导）
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '_scratch', 'newshop_out', 'biz_index.json');
const OUT = path.join(__dirname, '..', '..', '_scratch', 'newshop_out', 'biz_index.jsonl');

if (!fs.existsSync(SRC)) { console.log('❌ 找不到源文件：' + SRC); process.exit(1); }
const arr = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const rows = arr
  .filter(p => p && p[0] && p[1])                       // 跳过 (0,0) 空坐标
  .map(p => ({ lat: p[0], lng: p[1], area: p[2] || '', biz: p[3] || '' }));

fs.writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const size = fs.statSync(OUT).size;
console.log('✅ 源 ' + arr.length + ' 条 → 有效 ' + rows.length + ' 条');
console.log('   已写 ' + OUT);
console.log('   大小 ' + (size / 1024 / 1024).toFixed(2) + ' MB（' + size + ' bytes）');
console.log('   样例：' + JSON.stringify(rows[0]));
