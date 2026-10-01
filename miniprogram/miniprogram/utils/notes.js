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
const KEY = 'notes_v1';                                    // 全部记事（数组）存这个 storage key
const DIR = (wx.env.USER_DATA_PATH || '') + '/notes';      // 照片 / 录音的本机目录

function ensureDir() {
  try { fs.mkdirSync(DIR, true); } catch (e) { /* 已存在 */ }
}

// 读全部（永远返回数组）
function read() {
  try {
    const a = wx.getStorageSync(KEY);
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
// 写全部；返回是否成功（单 key 超 1MB 会抛 → 调用方提示"记的内容太多了"）
function write(list) {
  try { wx.setStorageSync(KEY, list); return true; }
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
  if (n) delFiles(n);
  write(list.filter(x => x.id !== id));
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
  KEY, DIR, all, byCustomer, countBy, get, draft, save, remove,
  fmtTime, saveLocal, delLocal, delFiles, qs
};
