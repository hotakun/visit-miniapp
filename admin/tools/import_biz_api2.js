// 走云开发 HTTP API 做「数据库批量导入」：建集合 → uploadfile → databasemigrateimport
// （2026-09-28；与 import_biz_via_api.js 同一套逻辑，换名是为了绕开本地工具链的一个限制）
// 用法：cd admin && node tools/import_biz_api2.js
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const FILE = path.join(__dirname, '..', '..', '_scratch', 'newshop_out', 'biz_index.jsonl');
const COLL = 'biz_index';
const CLOUD_PATH = 'imports/biz_index.jsonl';

(async () => {
  if (!cfg.appid || !cfg.appsecret || !cfg.envId) { console.log('❌ config.json 缺 appid/appsecret/envId'); return; }
  if (!fs.existsSync(FILE)) { console.log('❌ 先跑 node tools/export_biz_jsonl.js 生成 JSONL'); return; }

  const t = await (await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`)).json();
  if (!t.access_token) { console.log('❌ 取 token 失败：', t.errmsg || '', '(' + t.errcode + ')'); return; }
  const tk = t.access_token;
  const buf = fs.readFileSync(FILE);
  console.log('待导入文件：' + (buf.length / 1024 / 1024).toFixed(2) + ' MB');

  // ① 取云存储上传链接
  const up = await (await fetch(`https://api.weixin.qq.com/tcb/uploadfile?access_token=${tk}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: cfg.envId, path: CLOUD_PATH })
  })).json();
  console.log('① uploadfile → errcode=' + up.errcode + ' ' + (up.errmsg || ''));
  if (up.errcode) { console.log('❌ 取上传链接失败，终止'); return; }

  // ② 上传文件
  const form = new FormData();
  form.append('key', CLOUD_PATH);
  form.append('signature', up.authorization);
  form.append('x-cos-security-token', up.token);
  form.append('x-cos-meta-fileid', up.cos_file_id);
  form.append('file', new Blob([buf], { type: 'application/json' }), 'biz_index.jsonl');
  let upOk = false, upText = '';
  try {
    const r = await fetch(up.url, { method: 'POST', body: form });
    upText = await r.text();
    upOk = r.ok;
    console.log('② 上传 → HTTP ' + r.status + (upOk ? ' ✅' : ' ❌ ' + upText.slice(0, 300)));
  } catch (e) {
    console.log('② 上传异常：' + (e && e.message));
  }
  if (!upOk) { console.log('   上传没成功'); return; }

  // ③ 确保集合存在
  const cc = await (await fetch(`https://api.weixin.qq.com/tcb/databasecollectionadd?access_token=${tk}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: cfg.envId, collection_name: COLL })
  })).json();
  console.log('③ 建集合 → ' + JSON.stringify(cc));

  // ④ 数据库批量导入
  const im = await (await fetch(`https://api.weixin.qq.com/tcb/databasemigrateimport?access_token=${tk}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env: cfg.envId,
      collection_name: COLL,
      file_path: CLOUD_PATH,
      file_type: 1,
      stop_on_error: true,
      conflict_mode: 1
    })
  })).json();
  console.log('④ databasemigrateimport → ' + JSON.stringify(im, null, 2));
  if (im.errcode === 0) console.log('✅ 导入任务已提交（云端异步跑，几十秒后去控制台看条数）');
})();
