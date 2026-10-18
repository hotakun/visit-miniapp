// 菜品/招牌菜拆分：中英文逗号、顿号、分号、换行 → 去空格、去重
// ⭐ 2026-10-19 审计：custedit / newshop 各有一份完全相同的实现，统一到这里。
function splitDishes(raw) {
  return String(raw || '')
    .split(/[、，,；;\n\r]+/)
    .map(x => x.trim())
    .filter((x, i, a) => x && a.indexOf(x) === i);
}

module.exports = { splitDishes };
