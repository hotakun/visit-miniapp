// 服务号粉丝查找（找「卿🔥燕 聚火配送」这类昵称 → 拿 openid）
// 用法：node _scratch/find_mp_follower.js [关键字...]
//   例：node _scratch/find_mp_follower.js 卿 燕 聚火
//   （不传关键字 = 列出全部粉丝）
// 凭据：admin/config.json 的 mpAppId / mpAppSecret
//   ⚠️ 2026-10-10 实测：本地这份 AppSecret 是**旧**的（40125 invalid appsecret）——
//      老板在公众平台重置过，新 secret 在云端 settings.mpConfig 里（云端脱敏、读不出来）
//      → 用这个脚本前，先把 admin/config.json 的 mpAppSecret 更新成新值。
//   ⚠️ token 用 **stable_token** 接口取（不会把后台/云端的 token 顶掉）
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));   // = admin/config.json（本文件在 admin/tools/ 下）
const kw = process.argv.slice(2);

(async () => {
  // 1) token
  const tr = await (await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: cfg.mpAppId, secret: cfg.mpAppSecret, force_refresh: false })
  })).json();
  if (!tr.access_token) { console.log('❌ 取 token 失败：', tr.errcode, tr.errmsg); process.exit(1); }
  const tk = tr.access_token;
  console.log('✅ token OK（appid ' + String(cfg.mpAppId).slice(0, 10) + '…）');
  // 2) 粉丝 openid 列表（分页拉全）
  let next = '', all = [], total = 0;
  for (let i = 0; i < 50; i++) {
    const u = `https://api.weixin.qq.com/cgi-bin/user/get?access_token=${tk}` + (next ? `&next_openid=${encodeURIComponent(next)}` : '');
    const r = await (await fetch(u)).json();
    if (r.errcode) { console.log('❌ 列表失败：', r.errcode, r.errmsg); process.exit(1); }
    total = r.total || 0;
    ((r.data && r.data.openid) || []).forEach(o => all.push(o));
    next = r.next_openid || '';
    if (!next || all.length >= total) break;
  }
  console.log(`✅ 粉丝共 ${total} 个，取到 ${all.length} 个 openid`);
  // 3) 批量取昵称（每次最多 100）
  const users = [];
  for (let i = 0; i < all.length; i += 100) {
    const batch = all.slice(i, i + 100).map(o => ({ openid: o, lang: 'zh_CN' }));
    const r = await (await fetch(`https://api.weixin.qq.com/cgi-bin/user/info/batchget?access_token=${tk}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_list: batch })
    })).json();
    ((r && r.user_info_list) || []).forEach(u => users.push(u));
  }
  // 4) 匹配关键字（emoji 不用打 —— 用「卿」「燕」「聚火」这类词就能命中）
  const hit = kw.length ? users.filter(u => kw.some(k => String(u.nickname || '').includes(k) || String(u.remark || '').includes(k))) : users;
  console.log(`\n=== 匹配 ${hit.length} / ${users.length} 人 ===`);
  hit.forEach(u => {
    console.log(`- 「${u.nickname}」 openid=${u.openid} 关注=${new Date((u.subscribe_time || 0) * 1000).toLocaleString('zh-CN')}${u.remark ? ' 备注=' + u.remark : ''}`);
  });
  if (!hit.length && kw.length) {
    console.log('（没匹配到；下面列出全部粉丝的 openid + 关注时间 + 备注 + 标签）——');
    console.log('⚠️ 微信 2021-12 起 API 不再返回昵称（隐私政策）→ 想精确找到某人，最省事的是');
    console.log('   在服务号后台给她「修改备注」为「卿燕」（或打一个标签）→ 再跑本脚本即可匹配。');
    users.forEach((u, i) => console.log(`${i + 1}. openid=${u.openid}  关注=${new Date((u.subscribe_time || 0) * 1000).toLocaleString('zh-CN')}  备注=${u.remark || '（空）'}  标签=${(u.tagid_list || []).join(',') || '（无）'}`));
  }
})();
