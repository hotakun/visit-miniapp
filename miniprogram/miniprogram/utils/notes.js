// utils/notes.js —— 「记事」本机数据层（2026-09-28 老板定：**只存本机**，不上云）
// ---------------------------------------------------------------------------
// 老板口径（_scratch/记事-演示.html + 2026-09-28 拍板）：
//   · 文字 / 照片 / 录音 **全部只存这台手机**；唯一上云的是「你点了转文字的那一段录音」。
//   · 照片与录音放在**用户文件目录**（wx.env.USER_DATA_PATH，上限约 200MB）。
//     ⚠️ 不能用 fs.saveFile —— 那是个「本地缓存文件」通道，总额只有 10MB，放几张照片就满。
//   · 卸载小程序 / 清理微信缓存 / 换手机 → 内容全部丢失（不上云的必然代价，老板已认可）。
//   · 「关联客户」只是**本机挂钩**：记事里存一个 customerId，客户页按它筛，不联网、不上云。
// ---------------------------------------------------------------------------

const fs = wx.getFileSystemManager();
const KEY = 'notes_v1';                                    // ⚠️ 旧键（全局共享；现在只用于"无损迁移"时读一次）
const KEY_LEGACY = 'notes_v1__legacy';                     // 迁移后老数据的**原始副本**（可回退）
const DIR = (wx.env.USER_DATA_PATH || '') + '/notes';      // 照片 / 录音的本机目录
// ⭐⭐ 2026-10-15（依《全项目审查》A01 + 老板口径「**记事是个人的，不要共享**」）：
//   **记事索引按登录人隔离** —— 原来所有微信共用 `notes_v1` 一个键 →
//   同一台手机上换了微信登录，**能看到别人的记事**（老板已明确这不是他想要的）。
//   ⚠️ 取不到身份时（没登录 / globalData 还没有 user）**退回旧键** ——
//      宁可退回共享，也绝不因为"取不到 uid"就让人**看不见自己的记事**。
function myKey() {
  let uid = '';
  try { const u = getApp().globalData.user; uid = (u && u._id) || ''; } catch (e) { /* 静默 */ }
  return uid ? (KEY + ':' + uid) : KEY;
}

function ensureDir() {
  try { fs.mkdirSync(DIR, true); } catch (e) { /* 已存在 */ }
}

// 读全部（永远返回数组）
function read() {
  try {
    const k = myKey();
    let a = wx.getStorageSync(k);
    // ⭐ 无损迁移（**只会发生一次**）："我的键"还是空的、而"老全局键"里有数据 →
    //   把老数据**归给本机当前这个登录人**；老数据**原样留一份副本**（KEY_LEGACY）之后，**清空老键**。
    //   ⚠️ 为什么必须清空老键：否则同一台手机换个人登录时会**又迁移一次** —— 等于没隔离。
    //   ⚠️ 为什么留副本：报告明确要求"不能直接删、不能丢既有记事"；留副本 = **可一键回退**
    //      （把 KEY_LEGACY 的内容写回 notes_v1 即可）。
    if ((!Array.isArray(a) || !a.length) && k !== KEY) {
      try {
        const legacy = wx.getStorageSync(KEY);
        if (Array.isArray(legacy) && legacy.length) {
          wx.setStorageSync(k, legacy);
          if (!wx.getStorageSync(KEY_LEGACY)) wx.setStorageSync(KEY_LEGACY, legacy);
          wx.removeStorageSync(KEY);
          a = legacy;
        }
      } catch (e) { /* 迁移失败就当没有（下次再试），绝不因此报错挡住记事 */ }
    }
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
// 写全部；返回是否成功（单 key 超 1MB 会抛 → 调用方提示"记的内容太多了"）
function write(list) {
  try { wx.setStorageSync(myKey(), list); return true; }   // ⭐ 2026-10-15：按登录人隔离（见 myKey 注释）
  catch (e) { return false; }
}

function nid() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// 时间显示（列表用；与演示稿一致：今天 / 昨天 / 9月26日）
function fmtTime(at) {
  if (!at) return '';
  const d = new Date(at), now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= d0) return '今天 ' + hm;
  if (at >= d0 - 86400000) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

// 全部记事（新的在前）
function all() {
  return read().slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}
// 某客户的记事 / 条数（客户页「我的记事 · N 条」用）
function byCustomer(cid) { return all().filter(n => cid && n.customerId === cid); }
function countBy(cid) { return byCustomer(cid).length; }
function get(id) { return read().find(n => n.id === id) || null; }

// 新建草稿（编辑器用）—— 从客户进时自动带店名
function draft(o) {
  const o2 = o || {};
  return {
    id: nid(), at: Date.now(), updatedAt: 0,
    title: o2.customerName || '',          // 标题自动带店名（老板口径：带上了但可改）
    body: '',
    customerId: o2.customerId || '', customerName: o2.customerName || '',
    photos: [], audios: [],
    lat: o2.lat || 0, lng: o2.lng || 0, addr: o2.addr || '',
    remind: null                            // { at, text }
  };
}

// 保存（有则更新、无则新增）；返回保存后的对象，失败返回 null
function save(note) {
  const list = read();
  const i = list.findIndex(n => n.id === note.id);
  note.updatedAt = Date.now();
  if (i >= 0) list[i] = note; else { note.at = note.at || Date.now(); list.push(note); }
  return write(list) ? note : null;
}

// 删除（连同本机照片 / 录音文件一起清）
function remove(id) {
  const list = read();
  const n = list.find(x => x.id === id);
  // ⭐⭐ 2026-10-15 修（依《全项目审查》A01）：**先把索引写成功，才删文件** ——
  //   原来是"先删文件 → 再写索引 → **忽略写入失败** → 永远 return true"：
  //   本机存储满时 `write()` 会返回 false，但**文件已经删掉了** → 结果是
  //   **记录还在列表里、照片/录音却已损坏**，而界面还显示"删除成功"（假成功）。
  //   现在顺序反过来：写成功才删文件；写失败就**如实返回 false**，由调用方提示"删除失败，请重试"。
  const ok = write(list.filter(x => x.id !== id));
  if (!ok) return false;
  if (n) delFiles(n);
  return true;
}

// ===== 本机文件（用户文件目录，约 200MB 额度）=====
// 把临时文件（拍照 / 录音的产物）拷进用户目录 → 得到可长期使用的路径
function saveLocal(tempPath, ext) {
  if (!tempPath) return '';
  try {
    ensureDir();
    const dest = DIR + '/' + nid() + (ext || '.jpg');
    fs.copyFileSync(tempPath, dest);
    return dest;
  } catch (e) { return ''; }
}
function delLocal(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch (e) { /* 文件不在就算了 */ }
}
// 删一条记事带的全部文件
function delFiles(n) {
  ((n && n.photos) || []).forEach(p => delLocal(p && p.path));
  ((n && n.audios) || []).forEach(a => delLocal(a && a.path));
}

// 从 URL 参数取中文的安全解码（⭐ 2026-09-28 修 bug：客户页「快速记事」带店名过来时显示成 %E8%83%A1…）
//   · 微信 navigateTo 的 query **有时不自动解码**（机型/版本/开发者工具差异）→ 这里统一 decode 一次
//   · 已是中文的串再 decode 不会变；**没有 % 的串直接放过**（不会误伤）；万一 % 序列非法 → 原样返回
function qs(v) {
  const s = String(v == null ? '' : v);
  if (!s || s.indexOf('%') < 0) return s;
  try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch (e) { return s; }
}

module.exports = {
  KEY, myKey, DIR, all, byCustomer, countBy, get, draft, save, remove,
  fmtTime, saveLocal, delLocal, delFiles, qs
};
