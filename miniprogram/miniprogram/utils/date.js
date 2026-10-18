// 日期显示：时间戳 / ISO 字符串 → 「M月D日」；无效日期给占位
// ⭐ 2026-10-19 审计：myshops / newshops 各有一份完全相同的实现，统一到这里。
function dayCn(at) {
  if (!at) return '(未填日期)';
  const s = String(at).trim();
  let d;
  if (/^\d{10,}$/.test(s)) { const n = Number(s); d = new Date(n > 1e12 ? n : n * 1000); }
  else d = new Date(s.replace(/-/g, '/'));
  if (!d || isNaN(d.getTime())) return '(未填日期)';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

module.exports = { dayCn };
