#!/usr/bin/env node
/**
 * 聚火拜访 · 一键体检（2026-10-05）
 *
 * 用途：改完代码跑一次，替掉「语法检查 + 行尾核对 + JSON + WXML」这一串人工步骤。
 *   node _scratch/check.js           只体检（默认）
 *   node _scratch/check.js -v        同时列出每个被检查的文件
 *
 * 检查 5 项（全部只读，不改任何文件）：
 *   ① 全量 JS 语法        —— 所有 .js（云函数 12 个 + 小程序页面/utils + 后台的独立 js）
 *   ② admin.html 内嵌 JS  —— 提取 <script> 段后单独 node --check（它无法直接 check）
 *   ③ 行尾字节级          —— 按项目规矩分文件判定（CRLF 系 / .bat 必须 CRLF / 其余纯 LF）
 *   ④ JSON 语法           —— 所有 .json（app.json / 页面 .json / 云函数 config.json）
 *   ⑤ WXML 标签配对       —— view/text 开闭标签配平（WXML 禁 HTML 标签也一并查）
 *
 * 退出码：0 = 全过；1 = 有失败项（供 CI / 提交前把关用）
 *
 * ⚠️ 行尾规则**以 AGENTS.md 为准**（本文件的 CRLF_FILES 若与 AGENTS.md 不一致，改这里）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');   // ⚠️ 本文件在 admin/tools/ → 上两级才是项目根
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

// ============ 配置：这些文件必须是纯 CRLF（其余 .js/.md/.wxml/.wxss 一律纯 LF）============
// 依据 AGENTS.md「行尾规矩」条（2026-09-29 全面复测）
const CRLF_FILES = new Set([
  'admin/admin.html',
  'admin/nt-map.js',
  '开发计划.md',
  'miniprogram/miniprogram/pages/login/login.js',
  'miniprogram/miniprogram/pages/login/login.wxml',
  'miniprogram/miniprogram/pages/visit/visit.wxml',
  'miniprogram/miniprogram/pages/customer/customer.js',
  'miniprogram/miniprogram/pages/map/map.js'
]);
// ⚠️ 开发计划.md 是「CRLF + 29 个裸 LF」的混合文件，不按纯 CRLF 判
const MIXED_FILES = new Set(['开发计划.md']);

// 跳过这些目录（不体检）
const SKIP_DIRS = new Set(['MapDownloader-2.0', 'design-demo','node_modules', '.git', 'voices', 'voice', 'cache', 'build', 'output', 'WebView2', 'TMP', '_scratch', 'versions', 'data', '销售数据']);

const fails = [];
const warns = [];
let checked = { js: 0, json: 0, wxml: 0, eol: 0, htmlJs: 0 };
const okFiles = [];

function skipDir(name) { return SKIP_DIRS.has(name) || name.endsWith('.WebView2'); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (skipDir(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

// ---------- ③ 行尾（字节级：按 Buffer 数 \r\n 与 \n）----------
function countEol(buf) {
  let crlf = 0, bare = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else bare++; }
  }
  return { crlf, bare };
}
function checkEol(rel, abs) {
  const buf = fs.readFileSync(abs);
  const { crlf, bare } = countEol(buf);
  const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  checked.eol++;
  if (bom) fails.push(`行尾 ${rel}：带 BOM（项目约定无 BOM）`);
  if (MIXED_FILES.has(rel)) {
    // 混合文件：只要求「主体是 CRLF」——有 CRLF 就行，不苛求裸 LF 数
    if (crlf === 0) fails.push(`行尾 ${rel}：应是 CRLF 为主的混合文件，实测 CRLF=0`);
    else okFiles.push(`  [混合] ${rel}  CRLF=${crlf} 裸LF=${bare}`);
    return;
  }
  const mustCrlf = CRLF_FILES.has(rel) || rel.toLowerCase().endsWith('.bat');
  if (mustCrlf && bare > 0) fails.push(`行尾 ${rel}：必须纯 CRLF，实测有 ${bare} 个裸 LF（CRLF=${crlf}）`);
  else if (mustCrlf) okFiles.push(`  [CRLF] ${rel}  CRLF=${crlf} 裸LF=0`);
  // ⚠️ 其余文件**不硬判** —— 本项目 `core.autocrlf=true`（git 存 LF、检出 CRLF），
  //   工作区里出现 CRLF 是**正常现象**；只有 AGENTS.md 明文规定的那几个（CRLF_FILES + .bat）才判错。
  //   混了行尾的只提醒，不挡提交。
  else if (crlf > 0 && bare > 0) warns.push(`行尾 ${rel}：混合（CRLF=${crlf} 裸LF=${bare}）`);
  else okFiles.push(`  [ok]   ${rel}  CRLF=${crlf} 裸LF=${bare}`);
}

// ---------- ① JS 语法 ----------
function checkJs(rel, abs) {
  checked.js++;
  try { execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' }); okFiles.push(`  [js]   ${rel}`); }
  catch (e) { fails.push(`JS 语法 ${rel}：\n${String(e.stderr || e.message).split('\n').slice(0, 4).join('\n')}`); }
}

// ---------- ④ JSON ----------
function checkJson(rel, abs) {
  checked.json++;
  try { JSON.parse(fs.readFileSync(abs, 'utf8')); okFiles.push(`  [json] ${rel}`); }
  catch (e) { fails.push(`JSON ${rel}：${e.message}`); }
}

// ---------- ② admin.html 内嵌 JS ----------
function checkAdminHtml(rel, abs) {
  const html = fs.readFileSync(abs, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) { warns.push(`${rel}：没提取到内嵌 <script>`); return; }
  const tmp = path.join(os.tmpdir(), 'juhuo_admin_inline_check.js');
  blocks.forEach((code, i) => {
    fs.writeFileSync(tmp, code, 'utf8');
    checked.htmlJs++;
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { fails.push(`${rel} 内嵌 JS 第 ${i + 1} 段语法错：\n${String(e.stderr || e.message).split('\n').slice(0, 5).join('\n')}`); }
  });
  try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  okFiles.push(`  [html] ${rel}  内嵌 script ${blocks.length} 段通过`);
  // 顺带查行尾（admin.html 必须纯 CRLF）
  checkEol(rel, abs);
}

// ---------- ⑤ WXML 配对 + 禁 HTML 标签 ----------
const VOID_TAGS = new Set(['image', 'input', 'import', 'include', 'wxs', 'icon', 'progress', 'slider', 'switch', 'textarea', 'canvas', 'map', 'video', 'audio', 'camera', 'live-player', 'live-pusher', 'open-data', 'web-view', 'ad', 'official-account', 'navigator', 'button', 'checkbox', 'radio', 'picker', 'picker-view', 'scroll-view', 'swiper', 'movable-view', 'cover-view', 'cover-image', 'rich-text', 'form', 'label', 'block']);
const HTML_TAGS = ['div', 'span', 'p', 'br', 'a', 'ul', 'li', 'table', 'tr', 'td', 'h1', 'h2', 'h3', 'img', 'section', 'header', 'footer', 'header'];
function checkWxml(rel, abs) {
  checked.wxml++;
  const raw = fs.readFileSync(abs, 'utf8');
  // ⚠️ 先剥掉 <!-- --> 注释：注释里常写「<br> 曾致白屏」这类说明文字，不该被当成真标签
  const src = raw.replace(/<!--[\s\S]*?-->/g, '');
  // ① 禁 HTML 标签（WXML 用 HTML 标签会白屏）
  const badHtml = [];
  for (const t of HTML_TAGS) {
    const re = new RegExp(`<\\s*${t}(\\s|>|/)`, 'i');
    if (re.test(src)) badHtml.push(t);
  }
  if (badHtml.length) fails.push(`WXML ${rel}：出现 HTML 标签 <${badHtml.join('> <')}>（WXML 只允许 view/text，HTML 标签会白屏）`);
  // ② 配对：只看自己写的组件标签（view/text 等），忽略自闭合与 void
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(src))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClose = m[4] === '/';
    if (selfClose || VOID_TAGS.has(tag)) continue;
    if (!closing) stack.push({ tag, idx: m.index });
    else {
      if (!stack.length) { fails.push(`WXML ${rel}：多出一个 </${tag}>`); return; }
      const top = stack.pop();
      if (top.tag !== tag) { fails.push(`WXML ${rel}：标签不配对 —— <${top.tag}> 被 </${tag}> 关闭`); return; }
    }
  }
  if (stack.length) fails.push(`WXML ${rel}：有 ${stack.length} 个标签没关闭（如 <${stack[stack.length - 1].tag}>）`);
  else okFiles.push(`  [wxml] ${rel}`);
}

// ---------- ⑥ adminapi 的 ACTIONS 白名单 vs dispatch 对账（治「坑 32」）----------
// 背景：adminapi 是后台唯一入口，靠 ACTIONS 白名单挡非法 action。历史上反复出现
//   「dispatch 里加了 action、忘了补 ACTIONS」→ 调用报「未知 action」（文档叫坑 32）。
//   ⚠️ 云函数运行时读不到自己的源码，所以这个对账放在这里（改完跑一次体检就能发现）。
//   ⚠️ 有 2 条是**故意**不在白名单里的（后台热更新拉分片用）—— 见 EXTRA，别当成漏。
const ACTIONS_EXTRA = new Set(['getAdminDistMeta', 'getAdminDistPart', 'xxx']);   // xxx = 注释里的哨兵
function checkActionsWhitelist() {
  const abs = path.join(ROOT, 'miniprogram/cloudfunctions/adminapi/index.js');
  if (!fs.existsSync(abs)) { warns.push('adminapi/index.js 不存在，跳过白名单对账'); return; }
  const s = fs.readFileSync(abs, 'utf8');
  const m = s.match(/const ACTIONS = \[([\s\S]*?)\];/);
  if (!m) { fails.push('adminapi：找不到 ACTIONS 数组'); return; }
  const arr = m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const disp = [...s.matchAll(/if \(action === '([A-Za-z0-9_]+)'\)/g)].map(x => x[1]);
  const uniq = [...new Set(disp)];
  const missing = uniq.filter(a => !arr.includes(a) && !ACTIONS_EXTRA.has(a));
  const dead = arr.filter(a => !uniq.includes(a));
  const dup = [...new Set(arr.filter((a, i) => arr.indexOf(a) !== i))];
  if (missing.length) fails.push(`adminapi：dispatch 里有、ACTIONS 白名单没有 → ${missing.join(', ')}\n   ⚠️ 这就是「坑 32」：调用会报「未知 action」。请补进 ACTIONS（若是有意放行，加进 check.js 的 ACTIONS_EXTRA）`);
  if (dead.length) fails.push(`adminapi：ACTIONS 白名单里有、dispatch 里没有（死名字）→ ${dead.join(', ')}`);
  if (dup.length) fails.push(`adminapi：ACTIONS 里重复 → ${dup.join(', ')}`);
  if (!missing.length && !dead.length && !dup.length) {
    okFiles.push(`  [acts] adminapi 白名单对账通过（ACTIONS ${arr.length} / dispatch ${uniq.length}，有意放行 ${ACTIONS_EXTRA.size} 条）`);
    console.log(`  ✔ adminapi ACTIONS 对账：白名单 ${arr.length} 个 · dispatch ${uniq.length} 个 · 有意放行 ${ACTIONS_EXTRA.size} 个（${[...ACTIONS_EXTRA].filter(x => x !== 'xxx').join('/')}）`);
  }
}

// ============ 主流程 ============
console.log('聚火拜访 · 一键体检（只读，不改任何文件）');
console.log('根目录：' + ROOT);
console.log('─'.repeat(64));

const files = walk(ROOT);
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/');

for (const abs of files) {
  const r = rel(abs);
  // 顺带：所有文本文件都查行尾（.bat/.js/.json/.wxml/.wxss/.md）
  if (/\.(js|json|wxml|wxss|md|bat|txt)$/i.test(r) && !/\.min\./i.test(r)) checkEol(r, abs);

  if (r === 'admin/admin.html') { checkAdminHtml(r, abs); continue; }   // ⚠️ html 单独走（它同时是内嵌 JS + 行尾）
  if (/\.js$/i.test(r)) { checkJs(r, abs); continue; }
  if (/\.json$/i.test(r)) { checkJson(r, abs); continue; }
  if (/\.wxml$/i.test(r)) { checkWxml(r, abs); continue; }
}

console.log(`检查了：JS ${checked.js} 个 · JSON ${checked.json} 个 · WXML ${checked.wxml} 个 · 行尾 ${checked.eol} 个 · admin.html 内嵌 JS ${checked.htmlJs} 段`);
checkActionsWhitelist();
console.log('─'.repeat(64));

if (VERBOSE && !fails.length) { console.log('明细：'); okFiles.forEach(l => console.log(l)); console.log('─'.repeat(64)); }

if (warns.length) { console.log('⚠️ 提醒：'); warns.forEach(w => console.log('  · ' + w)); }
if (fails.length) {
  console.log(`❌ 有 ${fails.length} 项没通过：`);
  fails.forEach((f, i) => console.log(`\n${i + 1}. ${f}`));
  console.log('');
  process.exit(1);
}
console.log('✅ 全部通过（语法 / 内嵌 JS / JSON / WXML / 行尾）');
process.exit(0);
