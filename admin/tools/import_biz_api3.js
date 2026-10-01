// 走云开发 HTTP API 做「数据库批量导入」（第 3 版：文件名改成 .json）
// ---------------------------------------------------------------------------
// 上一版失败原因：云开发导入**只认 .json / .csv 后缀**（-501007 invalid import filename），
//   我用了 .jsonl → 已把文件改名为 biz_index_import.json
//   （**内容仍是"每行一个 JSON 对象"**，这才是云开发 .json 导入要的格式）。
// 用法：cd admin && node tools/import_biz_api3.js
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const FILE = path.join(__dirname, '..', '..', '_scratch', 'newshop_out', 'biz_index_import.json');
const COLL = 'biz_index';
const CLOUD_PATH = 'imports/biz_index.json';   // ⚠️ 云存储里的文件名也必须 .json / .csv

(async () => {
  if (!cfg.appid || !cfg.appsecret || !cfg.envId) { console.log('❌ config.json 缺 appid/appsecret/envId'); return; }
  if (!fs.existsSync(FILE)) { console.log('❌ 找不到数据文件：' + FILE); return; }

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
  form.append('file', new Blob([buf], { type: 'application/json' }), 'biz_index.json');
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

  // ③ 确保集合存在（已存在会返回错误码，忽略）
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
      file_type: 1,          // 1 = JSON（每行一个对象）
      stop_on_error: true,
      conflict_mode: 1
    })
  })).json();
  console.log('④ databasemigrateimport → ' + JSON.stringify(im, null, 2));
  if (im.errcode === 0) {
    console.log('✅ 导入任务已提交（云端异步跑，几十秒后去「云开发控制台 → 数据库 → biz_index」看条数，应约 69729）');
    console.log('   ⚠️ 集合里原本若有数据，这次会再插一份 → 条数明显偏多就清空重导。');
  }
})();
