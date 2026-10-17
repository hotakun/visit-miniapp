#!/usr/bin/env node
/**
 * 聚火拜访 · 一键体检（2026-10-05）
 *
 * 用途：改完代码跑一次，替掉「语法检查 + 行尾核对 + JSON + WXML」这一串人工步骤。
 *   node _scratch/check.js           只体检（默认）
 *   node _scratch/check.js -v        同时列出每个被检查的文件
 *
 * 检查 6 项 + 2 组"跨文件对账"（全部只读，不改任何文件）：
 *   ① 全量 JS 语法        —— 所有 .js（云函数 12 个 + 小程序页面/utils + 后台的独立 js）
 *   ② admin.html 内嵌 JS  —— 提取 <script> 段后单独 node --check（它无法直接 check）
 *   ③ 行尾字节级          —— 按项目规矩分文件判定（CRLF 系 / .bat 必须 CRLF / 其余纯 LF）
 *   ④ JSON 语法           —— 所有 .json（app.json / 页面 .json / 云函数 config.json）
 *   ⑤ WXML 标签配对       —— view/text 开闭标签配平（WXML 禁 HTML 标签也一并查）
 *   ⑥ adminapi 的 ACTIONS 白名单 ↔ dispatch 对账（治「坑 32」）
 *   ⑦ ⭐ 拜访结果名一致性（2026-10-14 新增）—— 同一个结果名散在**物理隔离的四处**
 *        （小程序页面 / 云函数 / 话术 / 后台单文件），漏一处不报错、只能肉眼发现：
 *        · visit.js 的 MALL ↔ 云函数 RESULT_ENUM_MALL **逐字含顺序**一致
 *        · 每一项都要有**话术**（PRAISE）和**后台胶囊色**（RESULT_PILL）
 *        · task.js 的配色判定、admin.html 的绿系正则里出现的词，必须都在 MALL 里
 *        · 已废弃的旧名（已下单 / 关门·休息中）一律不许残留
 *   ⑧ ⭐ 前端 action 调用对账（2026-10-14 新增）—— admin.html 里 `api('xxx')` 调的每个 action
 *        都必须在 adminapi 的 ACTIONS 白名单里（admin.html 的 api() 一律 POST /api → 转发到 adminapi）。
 *        调了个不存在的 action = 按钮一点就报「未知 action」，只有点下去才知道。
 *   ⑨ ⭐ 页面跳转路径对账（2026-10-14 新增）—— 小程序里 wx.navigateTo / redirectTo / switchTab / reLaunch
 *        的 url 必须在 app.json 的 pages 里注册过；跳个没注册的页面 = 点了没反应，静态看不出来。
 *        ⚠️ 路径里**可以带连字符**（pages/tasks-all/tasks-all）—— 抓取正则别漏了 `-`（第一版就漏了、造成误报）。
 *   ⑩ ⭐ 两项「合规 / 事故」护栏（2026-10-14 新增）
 *        ① app.json 的 requiredPrivateInfos **只准地理位置类** —— 2026-10-02 踩过：加 `addPhoneCalendar`
 *           （那个字段只收地理位置类接口）会让**模拟器直接起不来**。
 *        ② 代码里**不许再用老接口 `/cgi-bin/token`** —— 它会顶掉 pgsync / 后台正用的 token
 *           （2026-10-13「后台数据停更 46 分钟」就是这么来的）。**2026-10-14 已把 5 处历史遗留
 *           全部改成 stable_token**（adminapi / login / server.js / admin/check.js / probe-env.js）
 *           → 从此 `KNOWN_LEGACY_TOKEN` 名单为**空**，任何新出现的老接口调用**直接报错拦住**。
 *   ⑪ ⭐ 本地缓存字段对账（2026-10-14 新增）—— 云函数 custMapPoints 下发**短键**客户点 → store.js 落盘
 *        （VERSION 控失效）→ admin.html 读短键。三处漂移都是**静默**的：多下发没人用（白拉）、
 *        前台读个不存在的短键（永远空白）、**字段清单变了却没把 VERSION +1**（老缓存不作废、读到缺字段的旧快照）。
 *   ⑫ ⭐ 商城字段链路对账（2026-10-14 新增）—— 商城 Excel → server.js 的 `MALL_HEADER_ALIAS`（中文表头→字段）
 *        → adminapi 的 `MALL_FIELD_PAIRS`（商城字段→库里落点）+ `STATIC_FIELDS`（导入写哪些）。
 *        **少一个字段 = 那条信息整条链路都传不到、而且不报错**（历史上 `mallCode` 就这么丢过 →
 *        直接导致「订单永远挂不上」）。另含一条护栏：**`lastOrderAt` 不许再加回来**（2026-10-07 移除）。
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
  'docs/历史/开发计划-2026-08原始需求.md',   // 2026-10-14 从根目录 git mv 进 docs/历史/（实测纯 CRLF=770 / 裸 LF=0）
  'miniprogram/miniprogram/pages/login/login.js',
  'miniprogram/miniprogram/pages/login/login.wxml',
  'miniprogram/miniprogram/pages/visit/visit.wxml',
  'miniprogram/miniprogram/pages/customer/customer.js',
  'miniprogram/miniprogram/pages/map/map.js'
]);
// ⚠️ 2026-10-14 实测：开发计划.md（现 docs/历史/开发计划-2026-08原始需求.md）**已是纯 CRLF（770 行 / 裸 LF 0）**
//   → 不再是「CRLF + 29 个裸 LF」的混合文件，不必再特殊处理；空集合保留备用（将来真出现混合文件往里加）。
const MIXED_FILES = new Set([]);

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
  let crlf = 0, bare = 0, extraCr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else bare++; }
    // ⭐ 2026-10-08 补数：连续 CR（\r\r）—— 行尾被**反复**转成 CRLF 的痕迹
    else if (buf[i] === 13 && i > 0 && buf[i - 1] === 13) extraCr++;
  }
  return { crlf, bare, extraCr };
}
function checkEol(rel, abs) {
  const buf = fs.readFileSync(abs);
  const { crlf, bare, extraCr } = countEol(buf);
  const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  checked.eol++;
  if (bom) fails.push(`行尾 ${rel}：带 BOM（项目约定无 BOM）`);
  // ⭐⭐ 2026-10-08 新增：行尾**连续 CR**（`\r\r…`）—— 原来只数 `\r\n` 与 `\n`，
  //   而 `\r\r\n` 里**含**一个 `\r\n` → "裸 LF=0"会把这种脏文件判成"合格"
  //   （`admin/admin.html` 曾积到**每行约 15 个 CR**，是老板肉眼发现的，体检却全绿）。
  //   修法：`b.replace(/\r/g,'').replace(/\n/g,'\r\n')`
  if (extraCr > 0) fails.push(`行尾 ${rel}：有 ${extraCr} 处连续 CR（\\r\\r…，行尾被反复转成 CRLF）；修法：去掉全部 CR 再统一补 \\r\\n`);
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
  if (!fs.existsSync(abs)) { fails.push('adminapi/index.js 不存在 → ACTIONS 白名单对账无法执行（按失败处理）'); return; }
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

// ---------- ⑦ 拜访结果名一致性（2026-10-14 新增；治「改名漏一处就坏」）----------
// 背景：同一个"拜访结果名"散在**物理隔离的四处** —— 小程序页面 / 云函数 / 话术 / 后台单文件，
//   微信架构上没法共享同一个源文件（不能跨端 require），只能靠这份体检兜住。
//   ⚠️ 2026-10-13 真实教训：「已下单」改名「促进下单」、新增「不方便」时，
//   漏掉的正是最隐蔽的两处（task.js 的配色判定 / admin.html 的绿系配色正则）——
//   漏了**不报错**，只是"颜色不对 / 判定失效"，只能靠肉眼发现。
const RESULT_OLD_NAMES = ['已下单', '关门·休息中'];   // 已废弃的旧名（残留 = 上次改名没改干净）
function arrOf(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
  if (!m) return null;
  return m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
function checkResultNames() {
  const rd = p => { const a = path.join(ROOT, p); return fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null; };
  const visitJs = rd('miniprogram/miniprogram/pages/visit/visit.js');
  const visitsFn = rd('miniprogram/cloudfunctions/visits/index.js');
  const taskJs = rd('miniprogram/miniprogram/pages/task/task.js');
  const adminHtml = rd('admin/admin.html');
  if (!visitJs || !visitsFn || !adminHtml) { fails.push('结果名一致性：缺文件 → 检查无法执行（按失败处理）'); return; }

  const mall = arrOf(visitJs, 'const MALL');
  const enumMall = arrOf(visitsFn, 'const RESULT_ENUM_MALL');
  if (!mall || !mall.length) { fails.push('结果名：visit.js 里找不到 const MALL 数组'); return; }
  if (!enumMall) { fails.push('结果名：visits/index.js 里找不到 const RESULT_ENUM_MALL 数组'); return; }
  let bad = 0;

  // ① 小程序 ↔ 云函数：逐字一致（含顺序）
  const same = mall.length === enumMall.length && mall.every((x, i) => x === enumMall[i]);
  if (!same) {
    bad++;
    fails.push(`结果名：visit.js 的 MALL 与云函数 RESULT_ENUM_MALL 不一致\n   小程序(${mall.length})：${mall.join(' / ')}\n   云函数(${enumMall.length})：${enumMall.join(' / ')}`);
  }

  // ② 每一项都要有话术（visit.js 的 PRAISE 键）—— 缺了提交后取不到话术
  const praiseBlk = (visitJs.match(/const PRAISE = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const praiseKeys = [...praiseBlk.matchAll(/'([^']+)':\s*\[/g)].map(x => x[1]);
  const noPraise = mall.filter(x => !praiseKeys.includes(x));
  if (noPraise.length) { bad++; fails.push(`结果名：这几项在 visit.js 的 PRAISE 里没有话术 → ${noPraise.join('、')}`); }

  // ③ 每一项都要有后台胶囊色（admin.html 的 RESULT_PILL 键）
  const pillBlk = (adminHtml.match(/const RESULT_PILL = \{([^}]*)\}/) || [])[1] || '';
  const pillKeys = [...pillBlk.matchAll(/'([^']+)':\s*'/g)].map(x => x[1]);
  const noPill = mall.filter(x => !pillKeys.includes(x));
  if (noPill.length) { bad++; fails.push(`结果名：这几项在 admin.html 的 RESULT_PILL 里没有颜色 → ${noPill.join('、')}`); }

  // ④ task.js 的配色判定里出现的词，必须都在 MALL 里（改名的残留会在这里露出来）
  if (taskJs) {
    const m = taskJs.match(/const resCls =([\s\S]{0,300})/);
    if (m) {
      const words = [...m[1].matchAll(/\/([^/]+)\//g)]
        .flatMap(x => x[1].split('|')).map(x => x.trim())
        .filter(x => x && /[\u4e00-\u9fa5]/.test(x));
      const stray = [...new Set(words)].filter(x => !mall.includes(x));
      if (stray.length) { bad++; fails.push(`结果名：task.js 的配色判定里出现 MALL 之外的词 → ${stray.join('、')}（多半是改名没改干净）`); }
    }
  }

  // ⑤ admin.html 的绿系配色正则里出现的词，必须都在 MALL 里
  const gm = adminHtml.match(/if \(\/([^/]*)\/\.test\(s\)\) return 'green'/);
  if (gm) {
    const stray = gm[1].split('|').map(x => x.trim()).filter(x => x && !mall.includes(x));
    if (stray.length) { bad++; fails.push(`结果名：admin.html 的绿系配色正则里出现 MALL 之外的词 → ${stray.join('、')}（改名没改干净）`); }
  }

  // ⑥ 废弃旧名不许残留（⚠️ 只查**清单类**的位置，不查注释 —— 注释里提旧名是正常的沿革记录）
  const lists = [mall, enumMall, praiseKeys, pillKeys].map(a => a.join('\u0001'));
  const left = RESULT_OLD_NAMES.filter(x => lists.some(s => s.includes(x)));
  if (left.length) { bad++; fails.push(`结果名：清单里还残留已废弃的旧名 → ${left.join('、')}`); }

  if (!bad) {
    okFiles.push(`  [res]  结果名一致性通过（${mall.length} 项：两边一致 / 有话术 / 有胶囊色 / 配色判定对齐）`);
    console.log(`  ✔ 拜访结果名：${mall.length} 项 —— 小程序 ↔ 云函数 ↔ 话术 ↔ 胶囊色 ↔ 任务卡配色 全部对齐`);
  }
}

// ---------- ⑧ 前端 action 调用对账（2026-10-14 新增；治「调了个不存在的 action」）----------
// 背景：后台 admin.html 的 api(action, extra) 一律 POST /api → server.js 转发到 **adminapi**。
//   所以 admin.html 里 `api('xxx')` 的每个 xxx 都必须是 adminapi 的 action（ACTIONS 白名单里）。
//   写错一个 = 那个按钮一点就报「未知 action」，而且**只有点下去才知道**（静态看不出来）。
function checkAdminActionCalls() {
  const htmlAbs = path.join(ROOT, 'admin/admin.html');
  const fnAbs = path.join(ROOT, 'miniprogram/cloudfunctions/adminapi/index.js');
  if (!fs.existsSync(htmlAbs) || !fs.existsSync(fnAbs)) { fails.push('action 调用对账：缺文件 → 检查无法执行（按失败处理）'); return; }
  const html = fs.readFileSync(htmlAbs, 'utf8');
  const s = fs.readFileSync(fnAbs, 'utf8');
  const m = s.match(/const ACTIONS = \[([\s\S]*?)\];/);
  if (!m) { fails.push('action 调用对账：adminapi 里找不到 ACTIONS 数组'); return; }
  const arr = m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

  // ⚠️⚠️ 2026-10-14 实测修正：**带 `_cfn` 的调用不是 adminapi 的 action** ——
  //   例：`api('import', { _cfn:'importdata', type, rows })`、`api('stats', { _cfn:'importdata' })`
  //   那是"调另一个云函数（importdata）"，action 名属于那个函数，不能拿 adminapi 白名单去判。
  //   （第一次写完这条检查时，把 import / stats 误报成"未知 action"，就是这个原因。）
  //   ⚠️ 否定后行断言：避免把 `callapi('…` / `xxxApi('…` 也算进来。
  const calls = [];
  for (const m of html.matchAll(/(?<![A-Za-z0-9_$.])api\('([A-Za-z0-9_]+)'/g)) {
    const tail = html.slice(m.index, m.index + 300);   // 看这次调用后面一小段
    if (/_cfn\s*:/.test(tail)) continue;               // 走别的云函数 → 不归 adminapi 白名单管
    calls.push(m[1]);
  }
  const uniq = [...new Set(calls)];
  const unknown = uniq.filter(a => !arr.includes(a) && !ACTIONS_EXTRA.has(a));
  if (unknown.length) {
    fails.push(`action 调用对账：admin.html 里调了 ACTIONS 白名单**没有**的 action → ${unknown.join(', ')}\n   ⚠️ 这些按钮一点就会报「未知 action」。修法：补进 adminapi 的 ACTIONS，或改掉调用`);
  } else {
    okFiles.push(`  [call] admin.html 调用的 ${calls.length} 个 action 都在白名单里`);
    console.log(`  ✔ 前端 action 调用：${calls.length} 个 —— 全部在 adminapi 的 ACTIONS 白名单里`);
  }
}

// ---------- ⑨ 页面跳转路径对账（2026-10-14 新增）----------
// 小程序里 wx.navigateTo / redirectTo / switchTab / reLaunch 的 url，必须在 app.json 的 pages 里注册过。
//   ⚠️ 跳一个没注册的页面 = 点了**没反应**（控制台报 not found），静态看不出来、只有用户点才发现。
//   ⚠️ 2026-10-14 教训：页面路径**可以含连字符**（`pages/tasks-all/tasks-all`）——
//      第一版抓取正则漏了 `-`，把 `/pages/tasks-all/tasks-all` 截成 `/pages/tasks` → 误报。
const NAV_FUNCS = ['navigateTo', 'redirectTo', 'switchTab', 'reLaunch'];
function checkPagePaths() {
  const appJsonAbs = path.join(ROOT, 'miniprogram/miniprogram/app.json');
  if (!fs.existsSync(appJsonAbs)) { fails.push('页面路径对账：找不到 app.json → 检查无法执行（按失败处理）'); return; }
  let pages = [];
  try { pages = JSON.parse(fs.readFileSync(appJsonAbs, 'utf8')).pages || []; }
  catch (e) { fails.push('页面路径对账：app.json 解析失败：' + e.message); return; }
  const pageSet = new Set(pages.map(p => '/' + String(p).replace(/^\//, '')));

  const dir = path.join(ROOT, 'miniprogram/miniprogram');
  const files = walk(dir).filter(f => /\.js$/i.test(f));
  const bad = [], seen = new Set();
  for (const abs of files) {
    const src = fs.readFileSync(abs, 'utf8');
    const relf = path.relative(ROOT, abs).replace(/\\/g, '/');
    for (const fn of NAV_FUNCS) {
      // 只扫"跳转调用对象里 url:" 的值；模板串里的 ${...} 会在 ? 或 $ 处停下
      // ⚠️ 路径字符类**必须含 `-`**（tasks-all 这类目录名），否则会截断误报
      const re = new RegExp(fn + '\\s*\\(\\s*\\{[^}]*?url\\s*:\\s*[`\'"]([^`\'"?#$]+)', 'g');
      let m;
      while ((m = re.exec(src))) {
        let p = m[1].trim().replace(/\/+$/, '');
        if (!p.startsWith('/pages/') || seen.has(p)) continue;
        seen.add(p);
        if (!pageSet.has(p)) bad.push(`${relf} → ${p}`);
      }
    }
  }
  if (bad.length) {
    fails.push(`页面路径对账：跳转的路径没在 app.json 的 pages 里注册 →\n   ${bad.join('\n   ')}\n   ⚠️ 点了会没反应（控制台报 not found）。修法：补进 app.json 的 pages，或改掉跳转路径`);
  } else if (seen.size) {
    okFiles.push(`  [nav]  ${seen.size} 个跳转路径都在 app.json 里`);
    console.log(`  ✔ 页面跳转路径：${seen.size} 个 —— 全部在 app.json 的 pages 里注册过`);
  }
}

// ---------- ⑩ 合规 / 事故护栏（2026-10-14 新增）----------
// ① app.json 的 requiredPrivateInfos 只准**地理位置类**接口：
//    ⚠️ 2026-10-02 真实事故：往里加 `addPhoneCalendar`（该字段只收地理位置类）→ **模拟器直接起不来**（已回退）。
//       日历要走公众平台更新「用户隐私保护指引」，不写在这里。
// ② 代码里**不许再用老接口 `/cgi-bin/token`**（2026-10-13 后台数据停更 46 分钟的真凶）：
//    ⚠️ 老接口与 stable_token **是同一套凭证、会互相踢** —— 脚本一调，pgsync / 后台正用的 token 立刻失效。
//    ⭐ 2026-10-14：**5 处历史遗留已全部改完**（云函数 adminapi/login + 后台 server.js + 后台自检脚本 2 个
//       → 一律改用 stable_token），`KNOWN_LEGACY_TOKEN` 名单清空。
//       → 此后**任何**新出现的老接口调用都**直接报错拦住**（不再有放行名单）。
const PRIVATE_INFO_ALLOW = new Set(['getLocation', 'onLocationChange', 'startLocationUpdate', 'startLocationUpdateBackground']);
const KNOWN_LEGACY_TOKEN = new Set([
  // ⭐ 2026-10-14：已清空 —— 原来登记的 5 处（admin/check.js / admin/probe-env.js / admin/server.js /
  //   cloudfunctions/adminapi / cloudfunctions/login）都改成 stable_token 了。
  //   以后再出现老接口调用，就是**真错**，不该再往这里加。
]);
function checkCompliance() {
  // ① 隐私接口白名单
  const appJsonAbs = path.join(ROOT, 'miniprogram/miniprogram/app.json');
  if (fs.existsSync(appJsonAbs)) {
    try {
      const j = JSON.parse(fs.readFileSync(appJsonAbs, 'utf8'));
      const arr = j.requiredPrivateInfos || [];
      const bad = arr.filter(x => !PRIVATE_INFO_ALLOW.has(x));
      if (bad.length) {
        fails.push(`隐私接口：app.json 的 requiredPrivateInfos 里有非地理位置类 → ${bad.join(', ')}\n   ⚠️ 2026-10-02 踩过：加日历类（addPhoneCalendar）会让**模拟器直接起不来**。日历要走公众平台更新「用户隐私保护指引」。`);
      } else {
        okFiles.push(`  [priv] requiredPrivateInfos 干净（${arr.length} 项，全是定位类）`);
        console.log(`  ✔ 隐私接口：requiredPrivateInfos ${arr.length} 项，全是地理位置类`);
      }
    } catch (e) { fails.push('隐私接口：app.json 解析失败：' + e.message); }
  }

  // ② 老接口 token（⚠️ 先剥注释 —— 注释里写"别用老接口"是正常的沿革记录）
  //   ⚠️⚠️ 跳过本文件自己：检测模式 `cgi-bin/token` 就写在本文件里，不跳过会**自己判自己违规**（实测踩到）。
  const SELF_REL = 'admin/tools/check.js';
  const dirs = [path.join(ROOT, 'admin'), path.join(ROOT, 'miniprogram/cloudfunctions')];
  const hits = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const abs of walk(d).filter(f => /\.js$/i.test(f))) {
      const r = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (r === SELF_REL) continue;                            // 跳过检测工具自己
      if (KNOWN_LEGACY_TOKEN.has(r)) continue;                 // 历史遗留：只登记，不拦
      const code = fs.readFileSync(abs, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')                      // 去块注释
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');                 // 去行注释（`[^:]` 保护 http:// 不误伤）
      if (/cgi-bin\/token/.test(code)) hits.push(r);
    }
  }
  if (hits.length) {
    fails.push(`老接口 token：这些文件里**代码**（非注释）又在调 /cgi-bin/token → ${hits.join(', ')}\n   ⚠️ 会把 pgsync / 后台的 token 顶掉（2026-10-13 后台停更 46 分钟就是这么来的）。改用 stable_token（样板见 admin/tools/pgsync.js 的 token()）。`);
  } else {
    okFiles.push(`  [token] 没有新增的老接口 token 调用（${KNOWN_LEGACY_TOKEN.size} 处历史遗留已登记）`);
    console.log(`  ✔ 老接口 token：没有新增调用（历史遗留 ${KNOWN_LEGACY_TOKEN.size} 处已登记在案）`);
  }

  // ⚠️ 历史遗留单独提示一次（不挡提交，但让人看得见）
  const still = [...KNOWN_LEGACY_TOKEN].filter(r => fs.existsSync(path.join(ROOT, r)));
  if (still.length) warns.push(`老接口 token 还有 ${still.length} 处历史遗留未改：${still.join(' / ')}（云函数用老接口拿 token 会顶掉 pgsync/后台的 token，建议以后换成 stable_token）`);
}

// ---------- ⑪ 本地缓存字段对账（2026-10-14 新增）----------
// 链路：云函数 custMapPoints 下发**短键**客户点 → store.js 落盘（VERSION 控失效）→ admin.html 读短键。
//   三处任一漂移都是**静默**的：① 多下发一个字段没人用（白拉流量）；② 前台读个不存在的短键（永远空白）；
//   ③ ⚠️ **字段清单改了却没把 store.js 的 VERSION +1** → 老缓存不作废 → 界面读到"缺字段的旧快照"。
//   ⚠️ ③ 没法规机械判（要记历史），所以退一步：**把字段清单当基线**，变了就提醒人去同步 VERSION。
const CACHE_FIELD_BASE = 21;   // custMapPoints 下发的短键个数（2026-10-14 实测；改字段要同步 store.js 的 VERSION）
const CACHE_KEYS = ['i', 'n', 'la', 'ln', 'c', 'd', 'b', 'ad', 'cs', 'cst', 'mc', 'mk', 'u', 'nr', 'ca', 'ct', 'ph', 'rm', 'bi', 'mj', 'so'];
function checkCacheFields() {
  const fnAbs = path.join(ROOT, 'miniprogram/cloudfunctions/adminapi/index.js');
  const htmlAbs = path.join(ROOT, 'admin/admin.html');
  const storeAbs = path.join(ROOT, 'admin/store.js');
  if (!fs.existsSync(fnAbs) || !fs.existsSync(htmlAbs)) { fails.push('缓存字段对账：缺文件 → 检查无法执行（按失败处理）'); return; }

  // ① 抓 custMapPoints 的返回对象里的短键
  const m = fs.readFileSync(fnAbs, 'utf8').match(/const points = rows\.map\(c => \(\{([\s\S]*?)\}\)\)/);
  if (!m) { fails.push('缓存字段对账：没抓到 custMapPoints 的返回对象（实现改了？） → 检查无法执行（按失败处理）'); return; }
  const keys = [...new Set([...m[1].matchAll(/(?:^|[\s,{])([a-z][a-zA-Z0-9_]*)\s*:/g)].map(x => x[1]))];

  // ② 前台有没有读过（扫整个 admin.html 的 `.xx`，不只 custLocalRow —— 别处也会用）
  const html = fs.readFileSync(htmlAbs, 'utf8');
  const notRead = keys.filter(k => !new RegExp('\\.' + k + '\\b').test(html));

  if (notRead.length) warns.push(`缓存字段：custMapPoints 下发了、但前台从没读过 → ${notRead.join(', ')}（要么白拉、要么前台字段名写错了）`);
  if (keys.length !== CACHE_FIELD_BASE) warns.push(`缓存字段：字段数从基线 ${CACHE_FIELD_BASE} 变成了 ${keys.length} —— 若确实改了字段清单，**记得把 store.js 的 VERSION +1**（否则老缓存不作废、界面会读到缺字段的旧快照）并同步前台读法`);
  const missing = CACHE_KEYS.filter(k => !keys.includes(k));
  if (missing.length) warns.push(`缓存字段：基线里有、代码里没了 → ${missing.join(', ')}（前台读它会永远空白）`);

  let ver = '?';
  if (fs.existsSync(storeAbs)) {
    const vm = fs.readFileSync(storeAbs, 'utf8').match(/const VERSION\s*=\s*(\d+)/);
    if (vm) ver = vm[1];
  }
  okFiles.push(`  [cache] custMapPoints 下发 ${keys.length} 个短键（基线 ${CACHE_FIELD_BASE}）· store VERSION=${ver}`);
  console.log(`  ✔ 本地缓存字段：custMapPoints 下发 ${keys.length} 个短键 · store.js 的 VERSION=${ver}${notRead.length ? '' : ' · 前台都读得到'}`);
}

// ---------- ⑫ 商城 14 字段链路对账（2026-10-14 新增）----------
// 链路：商城 Excel → server.js 的 MALL_HEADER_ALIAS（中文表头 → 字段名）→ adminapi 的
//   MALL_FIELD_PAIRS（商城字段 → 库里落点）+ STATIC_FIELDS（导入时写哪些）。
//   ⚠️ 少一个字段 = **那条信息整条链路都传不到，而且不报错** —— 历史上 `mallCode` 就这么丢过，
//      后果是「订单按 customerCode 匹配 → 没编号的店订单永远挂不上」。所以三处必须互相对得上。
const MALL_HEADER_EXPECT = 20;   // server.js 表头别名的条数基线（2026-10-18 实测：14 → 20）
//   2026-10-18 新增 6 条 —— 老板定「导入文件今后有两种（带经纬度列 / 不带），要自动分辨并适应」：
//   「经纬度」/「坐标」（一列 `28.907732,119.969215`，**纬度在前**）+「纬度」/「经度」/「纬度(lat)」/「经度(lng)」（分成两列）
//   ⚠️ 坐标**不是**商城合并字段（见下面 MALL_IMPORT_ONLY）—— 表头别名多了不代表 MALL_FIELD_PAIRS 要跟着加。
function checkMallFields() {
  const fnAbs = path.join(ROOT, 'miniprogram/cloudfunctions/adminapi/index.js');
  const srvAbs = path.join(ROOT, 'admin/server.js');
  if (!fs.existsSync(fnAbs) || !fs.existsSync(srvAbs)) { fails.push('商城字段对账：缺文件 → 检查无法执行（按失败处理）'); return; }
  const fn = fs.readFileSync(fnAbs, 'utf8');
  const srv = fs.readFileSync(srvAbs, 'utf8');

  // ① MALL_FIELD_PAIRS 的**左值**（= 商城侧字段名）
  //   ⚠️ 先去掉行注释：那段注释里也写着 ['lastOrderAt','lastOrderAt'] 的来历，不去掉会误抓。
  const pm = fn.match(/const MALL_FIELD_PAIRS = \[([\s\S]*?)\n\];/);
  if (!pm) { fails.push('商城字段对账：没抓到 MALL_FIELD_PAIRS（实现改了？） → 检查无法执行（按失败处理）'); return; }
  const pairsSrc = pm[1].replace(/^\s*\/\/.*$/gm, '');
  const mallSide = [...pairsSrc.matchAll(/\['([A-Za-z0-9_]+)'\s*,\s*'([A-Za-z0-9_]+)'\]/g)].map(x => x[1]);

  // ② server.js 的表头别名**值**（= 解析端能产出的商城字段）
  const hm = srv.match(/const MALL_HEADER_ALIAS = \{([\s\S]*?)\n\};/);
  const headerVals = hm ? [...hm[1].matchAll(/:\s*'([A-Za-z0-9_]+)'/g)].map(x => x[1]) : [];

  // ③ adminapi 导入侧 STATIC_FIELDS（导入时往客户档案写哪些商城字段）
  const sm = fn.match(/const STATIC_FIELDS = \[([^\]]*)\]/);
  const statics = sm ? [...sm[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(x => x[1]) : [];

  let bad = 0;
  // ⭐ 2026-10-18（老板定「导入文件有带经纬度列 / 不带，要自动分辨」）：
  //   `lat` / `lng` 是**只进商城库（`mall_customers`）**的字段，用途只有两个：
  //     ① 灌进服务器的 `mall_pending` 池子（挑/合并时能看出这家带没带坐标）；
  //     ② 「➕ 新建客户」时作为坐标（createMallCustomer —— 新店本来就要坐标，业务员才导航得到）。
  //   ⚠️ 它们**绝不合并进已有客户档案**：坐标红线是「现场采的才作数」，由 `MALL_NO_TOUCH` 代码级硬拦。
  //   → 所以它们**不该出现在 MALL_FIELD_PAIRS 里**，但出现在导入侧 STATIC_FIELDS 是**正常**的 → 这里放行。
  const MALL_IMPORT_ONLY = ['lat', 'lng'];
  const notParsed = mallSide.filter(f => !headerVals.includes(f));
  if (notParsed.length) { bad++; fails.push(`商城字段：MALL_FIELD_PAIRS 里的商城侧字段，在 server.js 的表头映射里没有 → ${notParsed.join(', ')}\n   ⚠️ 这些字段**导不进来**（解析端根本不产出它们），而且不报错`); }
  const noSource = statics.filter(f => !mallSide.includes(f) && !MALL_IMPORT_ONLY.includes(f));
  if (noSource.length) { bad++; fails.push(`商城字段：导入侧的 STATIC_FIELDS 里有 MALL_FIELD_PAIRS 之外的字段 → ${noSource.join(', ')}\n   ⚠️ 写了也没有来源（补进 MALL_FIELD_PAIRS，或从这里删掉）`); }
  // 反过来的护栏：坐标**不许**进 MALL_FIELD_PAIRS ——
  //   一旦加进去，`mallFieldsFrom()` 就会拿商城坐标去盖客户坐标（只能靠 MALL_NO_TOUCH 兜着），
  //   等于把「坐标以现场为准」从"结构上不可能"退化成"靠一道安全网挡着"。**别加。**
  const coordInPairs = mallSide.filter(f => MALL_IMPORT_ONLY.includes(f));
  if (coordInPairs.length) { bad++; fails.push(`商城字段：MALL_FIELD_PAIRS 里出现了坐标字段 → ${coordInPairs.join(', ')}\n   ⚠️ 坐标**只进商城库、绝不合并进客户档案**（现场采的才作数，老板 2026-09-29 定）—— 从这张表里删掉；\n      导入侧要写坐标，加进 check.js 的 MALL_IMPORT_ONLY 放行就够了`); }
  if (mallSide.includes('lastOrderAt')) { bad++; fails.push('商城字段：MALL_FIELD_PAIRS 里又出现了 `lastOrderAt` —— 2026-10-07 已移除（商城快照会盖掉 orders 表的真实日期），**别再加回来**'); }
  if (headerVals.length && headerVals.length !== MALL_HEADER_EXPECT) warns.push(`商城字段：server.js 的表头别名从基线 ${MALL_HEADER_EXPECT} 条变成了 ${headerVals.length} 条（若确实改了商城导出表头，记得同步 MALL_FIELD_PAIRS 与导入侧）`);

  if (!bad) {
    okFiles.push(`  [mall]  商城字段链路对账通过（商城侧 ${mallSide.length} 项 ↔ 表头映射 ${headerVals.length} 条 ↔ 导入侧 ${statics.length} 项，含导入专属 ${MALL_IMPORT_ONLY.join('/')}）`);
    console.log(`  ✔ 商城字段链路：商城侧 ${mallSide.length} 项 · 表头映射 ${headerVals.length} 条 · 导入侧 ${statics.length} 项（其中导入专属 ${MALL_IMPORT_ONLY.join('/')} 不进客户档案）—— 三处对得上`);
  }
}

// ---------- ⑬ 「剥编号」规则一致性（2026-10-14 新增）----------
// 为什么必须有它：客户编号（mallCode）是**订单匹配的钥匙**（orders.customerCode ↔ customers.mallCode）。
//   这条规则曾在**四处**各写一份（adminapi 的 mallFieldsFrom 里手写、backfillMallCode 里一份、
//   import_excel.py 的 split_code 一份、订单侧 build_orders 又一份），结果口径漂移过三次：
//   ① 只认「单字母+数字」→ `AA067` 这类两个字母的提取不到（2026-09-27 只补了数据没根治 → 2026-10-14 又冒出来）；
//   ② 含不含**全角空格**不一致；③ `backfillMallCode` 旧版**没转小写**（填成 `AA067`，而订单侧是小写 → 仍然对不上）。
//   现在统一：JS 侧只留 `mallCodeFromName()` 一处，Python 侧 `split_code` 与它同口径，且都转小写。
function checkMallCodeRule() {
  const fnAbs = path.join(ROOT, 'miniprogram/cloudfunctions/adminapi/index.js');
  const pyAbs = path.join(ROOT, 'admin/tools/import_excel.py');
  if (!fs.existsSync(fnAbs) || !fs.existsSync(pyAbs)) { fails.push('剥编号规则对账：缺文件 → 检查无法执行（按失败处理）'); return; }
  const fn = fs.readFileSync(fnAbs, 'utf8');
  const py = fs.readFileSync(pyAbs, 'utf8');
  let bad = 0;

  // ① adminapi 里只允许**一处**「剥编号」正则（都走 mallCodeFromName）
  //   ⚠️ 用**字面字符串**数（源码里是字面的 `\d`，用正则写 `\d` 会匹配"数字"而数不到）
  const NEEDLE = '[a-zA-Z]{1,3}\\d{1,6}';
  let fnHitCount = 0, _pos = 0;
  while ((_pos = fn.indexOf(NEEDLE, _pos)) >= 0) { fnHitCount++; _pos += NEEDLE.length; }
  if (fnHitCount !== 1) {
    bad++;
    fails.push(`剥编号规则：adminapi 里有 ${fnHitCount} 处「[a-zA-Z]{1,3}\\d{1,6}」正则（应只留 mallCodeFromName 一处，其余改调它）\n   ⚠️ 多份口径 = 编号提取结果可能不同 = **订单静默挂不上**（2026-10-14 老板报障 AA067 就是这么来的）`);
  }
  // ② 必须转小写（订单侧 split_code 转小写，客户侧不转就永远对不上）
  if (!/function mallCodeFromName[\s\S]{0,400}?toLowerCase\(\)/.test(fn)) {
    bad++;
    fails.push('剥编号规则：`mallCodeFromName()` 里没有 `toLowerCase()` —— 订单侧 `split_code` 是**转小写**的（`AA067` → `aa067`），客户侧不转会**永远匹配不上**');
  }
  // ③ 两侧都要支持**全角空格**
  const fnFull = fn.indexOf('[\\s　]+') >= 0 || fn.indexOf('[\\s\\u3000]+') >= 0;
  const pyFull = py.indexOf('[\\s\\u3000]+') >= 0 || py.indexOf('[\\s　]+') >= 0;
  if (!fnFull || !pyFull) {
    bad++;
    fails.push(`剥编号规则：全角空格支持不一致（adminapi=${fnFull ? '有' : '无'} / import_excel.py=${pyFull ? '有' : '无'}）—— 两处都必须是 [\\s　]+（店名里确实出现过全角空格）`);
  }

  if (!bad) {
    okFiles.push('  [code] 剥编号规则对账通过（adminapi 只一处 · 转小写 · 与 import_excel.py 同口径含全角空格）');
    console.log('  ✔ 剥编号规则：adminapi 只一处 · 转小写 · 与 import_excel.py 口径一致（含全角空格）');
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
// ===== 第 14 项：缓存失效「写类调用」对账（2026-10-14 事故后新增）=====
//   事故：客户详情页有"当天缓存"，而"提交拜访"没让缓存过期 → 返回详情页看不到刚写的记录（几家都一样）。
//   根治：把"改了客户/拜访 → 置 custNeedRefresh"**收到 `utils/api.js` 唯一入口**里统一判断，
//        不再靠"每个调用点自己记得"（原来就是靠记，实测漏了 5 处，连"提交"主路都漏）。
//   于是有两条必须盯死：
//     ① **不许绕过 api.js** 直接 `wx.cloud.callFunction`（绕过 = 那套缓存失效逻辑被跳过）
//     ② api.js 白名单里的 action，**云端必须真的存在**（写错名 = 该置标记时静默不置）
const CALLFN_EXTRA = ['miniprogram/miniprogram/app.js'];   // 直连只读取版本/审核状态（已登记放行）
function checkCustWriteWatch() {
  const apiAbs = path.join(ROOT, 'miniprogram/miniprogram/utils/api.js');
  if (!fs.existsSync(apiAbs)) { fails.push('写类调用对账：缺 utils/api.js → 检查无法执行（按失败处理）'); return; }
  const api = fs.readFileSync(apiAbs, 'utf8');
  let bad = 0;

  // ① 绕过唯一入口的地方
  const hits = [];
  const walk = d => {
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); return; }
      if (!/\.js$/.test(e.name)) return;
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (rel === 'miniprogram/miniprogram/utils/api.js') return;
      if (CALLFN_EXTRA.indexOf(rel) >= 0) return;
      if (fs.readFileSync(abs, 'utf8').indexOf('wx.cloud.callFunction') >= 0) hits.push(rel);
    });
  };
  walk(path.join(ROOT, 'miniprogram/miniprogram'));
  if (hits.length) {
    bad++;
    fails.push(`写类调用对账：这些文件**绕过了 utils/api.js** 直接 wx.cloud.callFunction → ${hits.join(', ')}\n   ⚠️ 绕过去 = "改客户/拜访后置 custNeedRefresh"那套逻辑被跳过 → 页面显示旧缓存（2026-10-14 事故）\n   修法：改用 api.call()；确实只读的，登记进 check.js 的 CALLFN_EXTRA`);
  }

  // ② 白名单里的 action 云端必须存在
  const blk = (api.match(/const CUST_WRITE = \{([\s\S]*?)\n\s*\};/) || [])[1] || '';
  if (!blk) { fails.push('写类调用对账：api.js 里找不到 CUST_WRITE 表 → 检查无法执行（按失败处理）'); return; }
  const pairs = [];
  blk.replace(/(\w+)\s*:\s*\[([^\]]*)\]/g, (m, fn, inner) => {
    (inner.match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, '')).forEach(a => pairs.push([fn, a]));
    return m;
  });
  if (!pairs.length) { fails.push('写类调用对账：CUST_WRITE 解析不到条目'); return; }
  const fns = {};
  ['visits', 'tasks'].forEach(fn => {
    const p = path.join(ROOT, `miniprogram/cloudfunctions/${fn}/index.js`);
    fns[fn] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  });
  const miss = [];
  pairs.forEach(([fn, act]) => {
    if (act === '*') return;
    if (!fns[fn]) { miss.push(fn + '.' + act + '(云函数文件缺失)'); return; }
    if (fns[fn].indexOf(`action === '${act}'`) < 0) miss.push(fn + '.' + act);
  });
  if (miss.length) {
    bad++;
    fails.push(`写类调用对账：api.js 白名单里的 action 云端不存在 → ${miss.join(', ')}\n   ⚠️ 写错名 = 该置标记时不置 = 页面显示旧缓存`);
  }
  if (!bad) console.log('  ✔ 写类调用对账：唯一入口没被绕过 · 白名单 action 云端都在（缓存失效不再靠人记）');
}

// ===== 第 15 项：客户变动信号「写类 action」对账（2026-10-15 老板实测后新增）=====
//   事故：后台/手机端改了店名 → 客户详情页显示新名，但**后台客户管理列表还是旧名**。
//   根因：同步器"有变动才跑"，而"会改客户的写点"里**只有删/恢复客户报了信号** → 整轮被跳过 → PG 不更新。
//   根治：把"会改 customers 的 action"收成**一张清单** `CUST_WRITE_ACTIONS`，在 adminapi 入口统一报信号。
//   必须盯死两条（否则改成"静默不报"，仍然只能肉眼发现）：
//     ① 清单里的每个名字**必须真的在 `ACTIONS` 里**（写错名 = 该报信号时不报）
//     ② 入口处**必须真的挂着**那句 `if (CUST_WRITE_ACTIONS.has(action)) …`（被误删就没人报了）
function checkCustWriteActions() {
  const abs = path.join(ROOT, 'miniprogram/cloudfunctions/adminapi/index.js');
  if (!fs.existsSync(abs)) { fails.push('客户变动信号对账：缺 adminapi/index.js → 检查无法执行（按失败处理）'); return; }
  const src = fs.readFileSync(abs, 'utf8');

  const mAct = src.match(/const ACTIONS = \[([\s\S]*?)\];/);
  if (!mAct) { fails.push('客户变动信号对账：抓不到 adminapi 的 ACTIONS → 检查无法执行（按失败处理）'); return; }
  const actions = new Set((mAct[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, '')));

  const mCw = src.match(/const CUST_WRITE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  if (!mCw) { fails.push('客户变动信号对账：抓不到 adminapi 的 CUST_WRITE_ACTIONS → 检查无法执行（按失败处理）'); return; }
  const cw = (mCw[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
  if (!cw.length) { fails.push('客户变动信号对账：CUST_WRITE_ACTIONS 解析不到条目'); return; }

  const missing = cw.filter(a => !actions.has(a));
  if (missing.length) {
    fails.push(`客户变动信号对账：CUST_WRITE_ACTIONS 里有 ${missing.length} 个名字不在 ACTIONS 白名单 → ${missing.join('、')}\n   ⚠️ 写错名 = 该报"客户变动"信号时不报 = 改了客户要等兜底才在后台/地图上看得见（2026-10-15 实测）\n   修法：改成 ACTIONS 里真实存在的 action 名，或把它从 CUST_WRITE_ACTIONS 删掉`);
    return;
  }
  if (src.indexOf('if (CUST_WRITE_ACTIONS.has(action))') < 0) {
    fails.push('客户变动信号对账：main 入口没有按 CUST_WRITE_ACTIONS 报信号 → 这张表形同虚设\n   修法：在鉴权通过后补回 `if (CUST_WRITE_ACTIONS.has(action)) { await touchCustDirty(); }`');
    return;
  }
  console.log(`  ✔ 客户变动信号对账：CUST_WRITE_ACTIONS ${cw.length} 个 · 全在 ACTIONS 里 · 入口已挂钩（改客户 ≤5 分钟反映）`);
}

checkResultNames();
checkAdminActionCalls();
checkPagePaths();
checkCompliance();
checkCacheFields();
checkMallFields();
checkMallCodeRule();
checkCustWriteWatch();
// ══════════════════════════════════════════════════════════════════════════════
// (15) 字段清单对账（2026-10-17 B 档新增）
//   背景：同一个"客户字段清单"以前要在 4 处各写一遍（pgapi 的 COLS_C / store 的两份 M 表 /
//         store 的 slim 瘦身 / 云函数两个白名单），**漏一处 = 那个字段静默消失、不报错**。
//         2026-10-17 老板报「导出里商城等级/来源/分类/签约业务员全空」就是漏在 slim 那处。
//   现在：store.js 已收敛成一张主表（CUST_FIELDS），这条检查负责"盯住其余几处"：
//     ① pgapi 的 COLS_C（PG 查哪些列）—— 必须与主表的 PG 列名**一一对应**
//     ② 云函数 custMapPoints / custSync 的字段白名单 —— 转成下划线后也应对得上（对不上只提醒）
//   ⚠️ 已知例外（不算漏）：
//     · `batch_ids` —— PG 侧由 `BI_JOIN`（batch_members 聚合）现算，不在 COLS_C 的列里
//     · 云函数侧有些字段"只给小程序用、不进后台缓存" → 反向差异只提醒、不判失败
// ══════════════════════════════════════════════════════════════════════════════
function checkFieldLists() {
  const rd = p => { const a = path.join(ROOT, p); return fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : ''; };

  // ① store.js 主表（CUST_FIELDS）里的 PG 列名
  const storeSrc = rd('admin/store.js');
  const i0 = storeSrc.indexOf('const CUST_FIELDS');
  const i1 = storeSrc.indexOf('const AGG_FIELDS');
  if (i0 < 0 || i1 < 0) { fails.push('字段清单对账：store.js 里找不到 CUST_FIELDS / AGG_FIELDS（B 档的主表被删了？）'); return; }
  const storeCols = new Set();
  for (const m of storeSrc.slice(i0, i1).matchAll(/\['[a-z0-9]+',\s*'([a-z0-9_]+)'/g)) storeCols.add(m[1]);
  // ⭐ 2026-10-18：AGG_FIELDS（oc/oa/lo/vc/lv/vs/vt）也是 store 要的 PG 列，
  //   而它们在 pgapi 里是 `ag.order_count AS oc` 这种**别名**（上面新加的 AS 扫描会抓到）——
  //   不把这边一起收进来，就会被误判成"pgapi 查了、store 没接"。
  const i2 = storeSrc.indexOf('const ALL_FIELDS');
  if (i2 > i1) {
    for (const m of storeSrc.slice(i1, i2).matchAll(/\['[a-z0-9]+',\s*'([a-z0-9_]+)'/g)) storeCols.add(m[1]);
  }

  // ② pgapi.js 的 COLS_C
  const pgSrc = rd('admin/tools/pgapi.js');
  const j0 = pgSrc.indexOf('const COLS_C');
  const j1 = pgSrc.indexOf('const BI_JOIN');
  if (j0 < 0 || j1 < 0) { fails.push('字段清单对账：pgapi.js 里找不到 COLS_C / BI_JOIN'); return; }
  const pgCols = new Set();
  for (const m of pgSrc.slice(j0, j1).matchAll(/c\.([a-z0-9_]+)/g)) pgCols.add(m[1]);
  // ⭐ 2026-10-18：`customer_subs`（副店/连锁）是**独立副表** JOIN 出来的，
  //   写法是 `COALESCE(csub.sub_accounts,'') AS sub_accounts` —— 不在 COLS_C 的 `c.` 列里。
  //   这里把 SELECT_CUST 里的 `AS xxx` 也收进 pgCols（否则会被误判成"store 要、pgapi 没查"）。
  const s0 = pgSrc.indexOf('const SELECT_CUST');
  if (s0 >= 0) {
    const s1 = pgSrc.indexOf(';', s0);
    for (const m of pgSrc.slice(s0, s1 > s0 ? s1 : s0 + 2000).matchAll(/\bAS\s+([a-z0-9_]+)/g)) pgCols.add(m[1]);
  }

  // ③ 双向比（`batch_ids` 由 JOIN 现算，两边都不出现 → 显式排除，别误判）
  const NOT_IN_COLS_C = new Set(['batch_ids']);   // ⚠️ pgapi 里它是 `COALESCE(m.bids,'') AS batch_ids` 现算的
  const onlyPg = [...pgCols].filter(c => !storeCols.has(c));
  const onlyStore = [...storeCols].filter(c => !pgCols.has(c) && !NOT_IN_COLS_C.has(c));
  if (onlyPg.length) fails.push('字段清单对账：**pgapi 查了、但 store.js 主表没接**（这些列白查了）→ ' + onlyPg.join(', '));
  if (onlyStore.length) fails.push('字段清单对账：**store.js 主表要、但 pgapi 没查**（这些字段会永远是空）→ ' + onlyStore.join(', '));

  // ④ 云函数白名单（驼峰 → 下划线）对比：对不上只提醒（可能有"只给小程序用"或"名字不同"的字段）
  const camel2snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  const apiSrc = rd('miniprogram/cloudfunctions/adminapi/index.js');
  const wl = fn => {
    const a = apiSrc.indexOf('async function ' + fn);
    if (a < 0) return null;
    const b = apiSrc.indexOf('\nasync function ', a + 10);
    const seg = apiSrc.slice(a, b > 0 ? b : a + 9000);
    const set = new Set();
    for (const m of seg.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)\s*:\s*true\b/g)) set.add(camel2snake(m[1]));
    return set;
  };
  const wlMp = wl('custMapPoints'), wlSy = wl('custSync');
  if (!wlMp || !wlSy) {
    warns.push('字段清单对账：没找到 custMapPoints / custSync 的白名单，跳过云函数侧比对');
  } else {
    // ⚠️ 这些是**已知的口径差异**（不算漏）：
    //   · batch_ids/photos/plat/... = 云端不存或只在别处
    //   · id → 云端叫 `_id`
    //   · ctype → 云端叫 `customerType`
    //   · coord_status → 云端叫 `coordStatus`
    //   · code → 云端叫 `mallCode`（客户编号）
    const EXTRA_CLOUD = new Set(['batch_ids', 'deleted', 'is_sub_account', 'main_account_id', 'sub_accounts',
      'plat', 'photos', 'customer_type', 'id', 'ctype', 'coord_status', 'code']);
    [['custMapPoints', wlMp], ['custSync', wlSy]].forEach(function (pair) {
      const nm = pair[0], set = pair[1];
      const miss = [...storeCols].filter(c => !EXTRA_CLOUD.has(c) && !set.has(c));
      if (miss.length) warns.push(`字段清单对账：store.js 主表有、但 ${nm} 白名单里没有（云端若不发这几个字段，它们会一直是空）→ ` + miss.slice(0, 8).join(', ') + (miss.length > 8 ? ' …' : ''));
    });
  }

  if (!onlyPg.length && !onlyStore.length) {
    console.log('  ✔ 字段清单对账：主表 ' + storeCols.size + ' 列 · pgapi 查 ' + pgCols.size + ' 列 · 两边完全对得上');
  }
}
checkFieldLists();

// ══════════════════════════════════════════════════════════════════════════════
// (16) 「改客户必写 updatedAt」护栏（2026-10-17 C4 新增）
//
//   为什么要有这条：同步器**按 `customers.updatedAt` 增量拉数据** ——
//   谁改了客户却没写 updatedAt，那条改动就**永远同步不到 PG / 后台缓存**，
//   而且**不报错、不提示**（2026-10-17 真实案例：给客户打 reviewFlag 时漏写，
//   visits/index.js:617，全库 39 个写点里唯一一处）。
//
//   判据分两种形态（与 _scratch/_audit_updatedat_v3.py 一致，实测校准过）：
//     A 字面量：`update({ data: { ... } })`        → 这个对象字面量里必须有 updatedAt
//     B 变量  ：`update({ data })` / `({ data: X })` → **X 在本函数体内**必须被赋过 updatedAt
//                （覆盖三种写法：`X.updatedAt =`、`X = { ...updatedAt... }`、
//                  `X = Object.assign(..., { updatedAt })`）
//
//   ⚠️ 前两版判据的教训（别退回去）：
//      · 行级（往后看 N 行）→ 假报多（赋值在更前面）
//      · 函数级（函数内任何地方有 updatedAt 就算有）→ 漏报（被同函数别处的 updatedAt 掩盖）
// ══════════════════════════════════════════════════════════════════════════════
function checkCustUpdatedAt() {
  const FNS = ['adminapi', 'tasks', 'visits'];
  const CALL = /collection\(\s*'customers'\s*\)[\s\S]{0,160}?\.(update|set)\s*\(\s*/g;
  const FNHEAD = /^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;
  let checked = 0;
  const bad = [];

  FNS.forEach(function (name) {
    const abs = path.join(ROOT, 'miniprogram/cloudfunctions/' + name + '/index.js');
    if (!fs.existsSync(abs)) { fails.push('改客户必写 updatedAt：缺 ' + name + '/index.js → 检查无法执行（按失败处理）'); return; }
    const src = fs.readFileSync(abs, 'utf8');

    // 顶层函数区间（用于找变量赋值的作用域）
    const heads = [];
    FNHEAD.lastIndex = 0;
    let hm;
    while ((hm = FNHEAD.exec(src)) !== null) heads.push({ at: hm.index, name: hm[1] });

    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(src)) !== null) {
      checked++;
      const callPos = m.index;
      // 该调用属于哪个函数
      let fstart = 0, fname = '(顶层)', fend = src.length;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].at <= callPos) { fstart = heads[i].at; fname = heads[i].name; fend = (heads[i + 1] ? heads[i + 1].at : src.length); }
      }
      const fnBody = src.slice(fstart, fend);
      const line = src.slice(0, callPos).split('\n').length;

      // 取 update( 之后的第一个 { ... }（配平）
      const braceAt = src.indexOf('{', m.index + m[0].length);
      let obj = null;
      if (braceAt >= 0 && braceAt - (m.index + m[0].length) <= 40) {
        let depth = 0;
        for (let j = braceAt; j < Math.min(src.length, braceAt + 4000); j++) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') { depth--; if (depth === 0) { obj = src.slice(braceAt, j + 1); break; } }
        }
      }
      const code = src.slice(m.index, Math.min(src.length, m.index + 80)).replace(/\s+/g, ' ');
      if (!obj) { bad.push({ name: name, fname: fname, line: line, why: '无法解析 update 的入参对象', code: code }); continue; }

      // A) 字面量：对象里直接有 updatedAt
      if (/\bupdatedAt\b/.test(obj)) continue;

      // B) 变量形态：从对象里取变量名（data / data: X）
      const vm = obj.match(/\bdata\s*(?::\s*([A-Za-z_][A-Za-z0-9_]*))?/);
      const v = vm ? (vm[1] || 'data') : null;
      if (!v) { bad.push({ name: name, fname: fname, line: line, why: '入参里找不到 data 变量', code: code }); continue; }
      const ve = v.replace(/[$]/g, '\\$');
      const hasAssign = new RegExp('\\b' + ve + '\\s*\\.\\s*updatedAt\\s*=').test(fnBody)                     // X.updatedAt =
        || new RegExp('(const|let|var)\\s+' + ve + '\\s*=\\s*\\{[\\s\\S]{0,1500}?updatedAt').test(fnBody)        // X = { ...updatedAt... }
        || new RegExp(ve + '\\s*=\\s*Object\\.assign\\([\\s\\S]{0,800}?updatedAt').test(fnBody)                  // X = Object.assign(...updatedAt)
        || new RegExp('Object\\.assign\\(\\s*' + ve + '\\s*,[\\s\\S]{0,800}?updatedAt').test(fnBody);            // Object.assign(X, ...updatedAt)
      if (!hasAssign) {
        bad.push({ name: name, fname: fname, line: line, why: '变量 `' + v + '` 在本函数内没有 updatedAt', code: code });
      }
    }
  });

  if (bad.length) {
    fails.push('改客户必写 updatedAt：下面这些写点没写 `updatedAt`，**那条改动永远同步不到 PG / 后台缓存**\n'
      + bad.map(b => '   · [' + b.name + '] ' + b.fname + '() 第 ' + b.line + ' 行 —— ' + b.why + '\n     ' + b.code).join('\n')
      + '\n   ⚠️ 改法：在 update 的 data 里加 `updatedAt: Date.now()`（同步器按它增量拉）');
    return;
  }
  console.log('  ✔ 改客户必写 updatedAt：' + checked + ' 个写点全部带上了（缺了同步不过去）');
}
checkCustUpdatedAt();

checkCustWriteActions();
console.log('─'.repeat(64));

if (VERBOSE && !fails.length) { console.log('明细：'); okFiles.forEach(l => console.log(l)); console.log('─'.repeat(64)); }

if (warns.length) { console.log('⚠️ 提醒：'); warns.forEach(w => console.log('  · ' + w)); }
if (fails.length) {
  console.log(`❌ 有 ${fails.length} 项没通过：`);
  fails.forEach((f, i) => console.log(`\n${i + 1}. ${f}`));
  console.log('');
  process.exit(1);
}
console.log('✅ 全部通过（语法 / 内嵌 JS / JSON / WXML / 行尾 / 结果名 / ACTIONS 对账 / action 调用 / 页面路径 / 护栏 / 缓存字段 / 商城字段 / 剥编号 / 写类调用对账 / 字段清单对账 / 客户变动信号对账）');
process.exit(0);
