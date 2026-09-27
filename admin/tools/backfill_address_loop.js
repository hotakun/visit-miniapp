// 一键：分批调用 adminapi.backfillAddressFromPlat，自动循环到全部处理完（带进度）
//
// 用法（在项目根目录）：
//   node admin\tools\backfill_address_loop.js --dry     ← 先干跑（不写库，只看会改多少家）
//   node admin\tools\backfill_address_loop.js           ← 真跑（写库）
//
// 为什么需要它：云函数一次性处理 2000+ 家会 **超时（-601008）**，
//   所以云函数侧按 { offset, limit } 分批，这里负责循环 + 显示进度。
// 凭据来源：admin/config.json（appid / appsecret / envId，只读不打印）
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const DRY = process.argv.indexOf('--dry') >= 0;
const LIMIT = 200;              // 每批 200 家（云函数侧上限 300）
const MAX_ROUNDS = 200;         // 防死循环

(async () => {
  const tRes = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  const t = await tRes.json();
  if (!t.access_token) {
    console.log('❌ 取 access_token 失败：', t.errmsg || '', '(' + t.errcode + ')');
    if (t.errcode === 40164) console.log('   40164 = 本机公网 IP 不在白名单（去 mp 后台加白）');
    process.exit(1);
  }

  console.log(`===== 开始${DRY ? '【干跑】' : '【真跑】'}：平台地址/电话回填 =====`);
  let offset = 0, round = 0;
  const sum = { processed: 0, fix: 0, addr: 0, phone: 0, noPlat: 0 };

  while (round < MAX_ROUNDS) {
    round++;
    const body = {
      action: 'backfillAddressFromPlat',
      username: 'qingyan', password: '123456',   // 与 run_adminapi.js 同一套默认凭据
      offset: offset, limit: LIMIT
    };
    if (DRY) body.dry = true;

    const r = await (await fetch(
      `https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=${t.access_token}&env=${cfg.envId}&name=adminapi`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    )).json();

    if (r.errcode) {
      console.log(`❌ 第 ${round} 批调用失败：`, r.errmsg || '', '(' + r.errcode + ')');
      if (r.errcode === -601008) console.log('   -601008 = 云函数超时（把 limit 调小些再试，或稍后重跑——本脚本可重复执行，已写过的不受影响）');
      process.exit(1);
    }
    let o = r.resp_data;
    try { o = JSON.parse(o); } catch (e) { /* 原样 */ }
    if (!o || !o.ok) { console.log('❌ 返回异常：', typeof o === 'string' ? o : JSON.stringify(o)); process.exit(1); }

    const fixedThis = o.fixed || 0;
    const willThis = o.willFix || 0;
    sum.processed += o.processed || 0;
    sum.fix += DRY ? willThis : fixedThis;
    sum.addr += (DRY ? o.addrWillFix : o.addrFixed) || 0;
    sum.phone += (DRY ? o.phoneWillFix : o.phoneFixed) || 0;
    sum.noPlat += o.noPlat || 0;

    console.log(`  第 ${String(round).padStart(2)} 批  offset=${String(o.offset).padStart(5)}  处理 ${String(o.processed).padStart(3)} 家` +
                `  ${DRY ? '将改 ' + willThis : '已改 ' + fixedThis} 家`);

    if (o.done) break;
    offset = o.nextOffset;
  }

  console.log('\n===== ' + (DRY ? '干跑完成（未写库）' : '全部完成') + ' =====');
  console.log(`累计处理 ${sum.processed} 家`);
  console.log(`${DRY ? '将改' : '已改'} ${sum.fix} 家（其中地址 ${sum.addr} 家 / 电话 ${sum.phone} 家）`);
  console.log(`无平台地址（未动）${sum.noPlat} 家`);
  if (DRY) console.log('\n确认数字没问题后，去掉 --dry 再跑一次就会真正写库。');
})();
