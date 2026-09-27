// 从大众点评移动站抓「店铺主图」(poipicadd 域) → 存到**后台本地** admin/media/plat/<shopuuid>/1.jpg
//
// ⚠️ 为什么这么慢：点评有反爬（verify.meituan.com「身份核实」）。2026-09-27 实测：
//    第一次单家请求成功（拿到 227KB 真实页面 + poipicadd 图），**连抓 10 家就被标记**。
//    所以本脚本**强制限速（默认 25 秒/家）**，且遇到核实页会**自动暂停 30 分钟再重试**。
//    471 家 ≈ 3.3 小时 —— 挂着跑就行；随时 Ctrl+C，下次 --resume 从断点续跑。
//
// 用法（在 admin 目录下）：
//   node tools/fetch_plat_photos.js --limit=1         # 先试 1 家（验证当前 IP 是否可用）
//   node tools/fetch_plat_photos.js --all --resume    # 全量 + 断点续跑
//   可选：--delay=25（秒/家） --blockwait=30（遇核实页暂停分钟数） --src=<xlsx 路径>
//
// 数据来源默认：TMP/拜访程序用表格/金华-永康-已匹配商城-带商城客户名-补齐同店.xlsx（471 家，带 url 列）
// 口径：只取 poipicadd 域（老文档「店铺主图」；排除 bdb 占位图 / wmproduct 外卖图）；每家**1 张**；<3KB 丢弃
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find(x => x.indexOf('--' + k + '=') === 0); return a ? a.split('=')[1] : d; };
const LIMIT = parseInt(argOf('limit', '0'), 10) || 0;          // 0 = 不限制
const ALL = argv.indexOf('--all') >= 0;
const RESUME = argv.indexOf('--resume') >= 0;
const DELAY = Math.max(5, parseInt(argOf('delay', '25'), 10)) * 1000;   // 每家的间隔（毫秒）
const BLOCKWAIT = Math.max(1, parseInt(argOf('blockwait', '30'), 10)) * 60 * 1000;  // 遇核实页暂停
const SRC = argOf('src', path.join(__dirname, '..', '..', 'TMP', '拜访程序用表格', '金华-永康-已匹配商城-带商城客户名-补齐同店.xlsx'));
const OUTDIR = path.join(__dirname, '..', 'media', 'plat');
const PROG = path.join(OUTDIR, '_progress.json');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log('[' + now() + '] ' + a.map(x => String(x)).join(' '));

function readRows() {
  const wb = XLSX.readFile(SRC);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

// 抓一家：成功 → { ok:true, bytes } ；被风控 → { blocked:true } ；其它失败 → { ok:false, why }
async function grabOne(row) {
  const url = String(row.url || '').trim();
  const uuid = String(row.shopuuid || '').trim();
  if (!url || !uuid) return { ok: false, why: 'no url/uuid' };
  const reqUrl = url.replace('www.dianping.com', 'm.dianping.com');
  const r = await fetch(reqUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Referer': 'https://m.dianping.com/' },
    redirect: 'follow'
  });
  const html = await r.text();
  if (/verify\.meituan\.com|安全验证|身份核实|captcha/i.test(r.url + html.slice(0, 3000))) return { blocked: true };
  const pics = [...new Set(html.match(/https?:\/\/[a-z0-9]+\.meituan\.net\/poipicadd\/[^"'\s\\)]+?\.(?:jpg|jpeg|png|webp)/gi) || [])];
  if (!pics.length) return { ok: false, why: 'no poipicadd img (len=' + html.length + ')' };
  const img = await fetch(pics[0], { headers: { 'User-Agent': UA, 'Referer': 'https://m.dianping.com/' } });
  if (!img.ok) return { ok: false, why: 'img http ' + img.status };
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length < 3000) return { ok: false, why: 'img too small (' + buf.length + 'B)' };
  const dir = path.join(OUTDIR, uuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.jpg'), buf);
  return { ok: true, bytes: buf.length };
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const prog = (RESUME && fs.existsSync(PROG)) ? JSON.parse(fs.readFileSync(PROG, 'utf8')) : { done: [], fail: [], blocked: 0 };
  const doneSet = new Set(prog.done || []);
  let rows = readRows();
  log('源表 %d 行 ｜ 输出 %s ｜ 限速 %ds/家 ｜ 遇核实页暂停 %d 分钟', rows.length, OUTDIR, DELAY / 1000, BLOCKWAIT / 60000);
  if (RESUME && doneSet.size) { rows = rows.filter(r => !doneSet.has(String(r.shopuuid || '').trim())); log('断点续跑：跳过已抓 %d 家，待跑 %d 家', doneSet.size, rows.length); }
  if (LIMIT) rows = rows.slice(0, LIMIT);
  log('本次处理 %d 家，预计约 %.1f 小时\n', rows.length, rows.length * DELAY / 3600000);

  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const uuid = String(row.shopuuid || '').trim();
    const name = String(row.name || row['店名'] || '').slice(0, 18);
    let res, tries = 0;
    for (;;) {
      try { res = await grabOne(row); } catch (e) { res = { ok: false, why: (e && e.message) || 'fetch err' }; }
      if (!res.blocked) break;
      tries++;
      prog.blocked = (prog.blocked || 0) + 1;
      fs.writeFileSync(PROG, JSON.stringify(prog, null, 1));
      log('⚠️ 被风控（身份核实页）—— 暂停 %d 分钟再试（第 %d 次）…', BLOCKWAIT / 60000, tries);
      if (tries >= 6) { log('❌ 连续 %d 次被拦，停止。建议：重启光猫换 IP 后再 --resume 续跑', tries); process.exit(2); }
      await sleep(BLOCKWAIT);
    }
    if (res.ok) {
      ok++; prog.done = (prog.done || []).concat([uuid]);
      log('[%d/%d] ✅ %s %s ｜ %d KB', i + 1, rows.length, uuid.slice(0, 8), name, Math.round(res.bytes / 1024));
    } else {
      fail++; prog.fail = (prog.fail || []).concat([{ uuid: uuid, name: name, why: res.why || '?' }]);
      log('[%d/%d] ✗ %s %s ｜ %s', i + 1, rows.length, uuid.slice(0, 8), name, res.why || '');
    }
    fs.writeFileSync(PROG, JSON.stringify(prog, null, 1));
    if (i < rows.length - 1) await sleep(DELAY + Math.random() * 5000);   // 限速 + 抖动
  }
  log('===== 完成：成功 %d ｜ 失败 %d ｜ 被拦次数 %d ｜ 进度文件 %s =====', ok, fail, prog.blocked || 0, PROG);
})();
