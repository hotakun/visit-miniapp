// ===== 新建任务·地图选店模块（§7.11） =====
// 从 admin.html 拆出（2026-09-06）。依赖主文件全局：custCache/curMode/nwStep/nwSalesman/api/esc/$/mapKey 及 DOM

// ---------- window.toggleNameDot 挂载 ----------
window.toggleNameDot = toggleNameDot;

// ---------- 电梯滚动监听（全局） ----------
window.addEventListener('scroll', elevatorOnScroll, { passive: true });
window.addEventListener('resize', () => { positionElevator(); renderRouteSvg(); });


// ===== 页面电梯圆标：↓ 到列表卡底 / ↑ 回地图卡顶（手动滚动自动感知） =====
// ---------- let elevatorDir + setElevator + elevatorClick + elevatorOnScroll ----------
let elevatorDir = 'down';
function setElevator(dir) {
  if (elevatorDir === dir) return;
  elevatorDir = dir;
  const el = $('wizElevator');
  if (el) { el.textContent = dir === 'down' ? '↓' : '↑'; el.classList.toggle('up', dir === 'up'); }
}
function elevatorClick() {
  if (nwStep !== 2) return;
  if (elevatorDir === 'down') {
    // 到页面文档最底端（覆盖列表下方的向导按钮条）
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  } else {
    // 回到第 2 步整卡顶端再上移 100px：天页签条+地图全露出，顶部留余量
    const w2 = $('wiz2');
    if (w2) {
      const y = w2.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }
}
function elevatorOnScroll() {
  if (nwStep !== 2) return;
  const mapCard = $('ntMap') ? $('ntMap').parentElement : null;
  const ev = $('wizElevator');
  if (!mapCard || !ev || ev.style.display === 'none') return;
  const r = mapCard.getBoundingClientRect();
  setElevator(r.bottom < 40 ? 'up' : 'down'); // 地图卡滚出视野 → ↑（回看地图）
}

// 圆标水平位置：整体位于地图大卡片右边缘之外 16px（right 是圆标右缘距视口右缘，需扣掉圆标自身宽度）
// ---------- positionElevator ----------
function positionElevator() {
  const mapCard = $('ntMap') ? $('ntMap').parentElement : null;
  const ev = $('wizElevator');
  if (!mapCard || !ev) return;
  const r = mapCard.getBoundingClientRect();
  const gap = ev.offsetWidth + 16 + 30; // 圆标宽 + 与卡片右缘的间距（16 + 30 外移）
  ev.style.right = Math.max(8, window.innerWidth - r.right - gap) + 'px';
}

// ---------- DAY_COLORS..ntDayMeta 变量区 ----------
const DAY_COLORS = ['#E5484D', '#2F80ED', '#18A058', '#7C3AED', '#F59E0B', '#0EA5E9', '#DB2777'];
const WAREHOUSE = { lat: 28.970802, lng: 120.154526 };
let ntCurDay = 1;
let ntMap = null, ntLayerVisited = null, ntLayerInTask = null, ntLayerLocked = null, ntLayerTodo = null, ntLayerDay = null;
let showSelNames = true;   // 左圆点：可选店名（默认亮）
let showDisNames = false;  // 右圆点：不可选店名（默认灭）
let mapLibLoaded = false;
let boxSel = null;
let ntDayMeta = {}; // {day: {distanceMeters, durationMin, fallback}}
let ntRoutes = {};   // {day: {pts:[[lat,lng]...], distanceMeters, fallback}} 规划后的真实道路轨迹（用于绿色导航线）
let ntRouteSvg = null, ntRoutePathGreen = null, ntRoutePathDash = null, ntRouteMaskRect = null, ntRouteMaskHoles = null; // SVG 自绘路线层（方案 C：绕开 GL 绘制）
let ntRouteTimer = null;  // 蚂蚁线动画计时器
let ntDashPhase = 0;      // 蚂蚁线相位 0..31
let ntStarLabel = null;   // 仓库金色五角星（仓库开关点亮时显示，DOM emoji ⭐）
let ntRouteStarLabel = null; // 路线起点五角星（有路线即显示，与仓库开关无关）

// ---------- dayColor + selOf + dayCount ----------
function dayColor(day) { return DAY_COLORS[(Number(day) - 1) % 7]; }
function selOf(day) { return custCache.filter(c => c._day === day).sort((a, b) => (a._seq || 99) - (b._seq || 99)); }
function dayCount() { return parseInt(document.querySelector('#ntDays .ctab.on').textContent, 10) || 1; }

// 可点选判定（两层状态模型 2026-09-07）：回访工作台「任务中」不可选；新客工作台全部可选
// ---------- custSelectable ----------
function custSelectable(c) { return curMode !== 'mall' || c.visitState !== 'in_task'; }

// 暂不可选：已被其他天选中（上层减淡显示，仅店名消失；切回所属天恢复）
// ---------- custTempLocked ----------
function custTempLocked(c) { return !!(c._day && c._day !== ntCurDay); }

// ---------- addToCurDay ----------
function addToCurDay(c) {
  if (c._day) return false;
  if (selOf(ntCurDay).length >= 15) { alert(`第 ${ntCurDay} 天已满 15 家，请切换其他天或先取消部分店铺`); return false; }
  const n = selOf(ntCurDay).length + 1; // 先取序号再赋 _day，避免把自身数进去（曾导致从 2 开始）
  c._day = ntCurDay;
  c._seq = n;
  return true;
}

// ---------- afterSelChange ----------
function afterSelChange() {
  renderDayTabs();
  renderCustSelect();
  renderMarkers();
}

// ---------- renderDayTabs ----------
function renderDayTabs() {
  const days = dayCount();
  if (ntCurDay > days) ntCurDay = days; // 天数被改小时归位，防止越界
  for (let d = days + 1; d <= 7; d++) delete ntDayMeta[d]; // 天数缩减后清掉消失天的规划数据
  $('ntDayTabs').innerHTML = Array.from({ length: days }, (_, i) => {
    const d = i + 1;
    const n = selOf(d).length;
    const on = d === ntCurDay;
    const c = dayColor(d);
    return `<div class="nt-daytab ${on ? 'on' : ''}" style="${on ? `background:${c};border-color:${c};color:#fff` : `color:${c};font-weight:500`}" onclick="switchMapDay(${d})">第${d}天 <span style="${n >= 15 ? 'color:#000' : ''}">[${n}]</span>${ntDayMeta[d] ? `<span class="nt-check" style="${ntDayMeta[d].planMode === 'manual' ? 'background:var(--blue)' : 'background:var(--green)'}">✓</span>` : ''}</div>`;
  }).join('');
}

// ---------- switchMapDay ----------
function switchMapDay(day) {
  ntCurDay = day;
  afterSelChange();
}

// ---------- renderCustSelect ----------
function renderCustSelect() {
  const kw = ($('ntSearch').value || '').trim();
  const STATE = { in_task: ['任务中', 'blue'] };
  const list = custCache.filter(c => !kw || c.name.includes(kw));
  // 分类排序（老板定）：已选置顶（按天+序号）→ 未选按状态：无任务在前、任务中垫底；同状态按名称
  const STATE_RANK = { free: 0, in_task: 1 };
  const sorted = [...list].sort((a, b) => {
    if (a._day && b._day) return (a._day - b._day) || ((a._seq || 0) - (b._seq || 0));
    if (a._day) return -1;
    if (b._day) return 1;
    const ra = STATE_RANK[a.visitState] !== undefined ? STATE_RANK[a.visitState] : 9;
    const rb = STATE_RANK[b.visitState] !== undefined ? STATE_RANK[b.visitState] : 9;
    if (ra !== rb) return ra - rb;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  });
  $('ntCusts').innerHTML = sorted.map(c => {
    if (curMode === 'mall') {
      const st = STATE[c.visitState] || null;
      const dis = c.visitState === 'in_task';
      const tag = c._day
        ? `<span class="pill" style="background:${dayColor(c._day)};color:#fff">第${c._day}天·${c._seq}</span>`
        : `<span class="pill ${st ? st[1] : 'gray'}">${st ? st[0] : '无任务'}</span>`;
      return `<div class="cust-row ${c._day ? 'on' : ''}${dis ? ' dis' : ''}" ${dis ? '' : `onclick="toggleCust('${c._id}')"`}>
        <span class="ck ${c._day ? 'on' : ''}${dis ? ' dis' : ''}">${c._day ? '✓' : ''}</span>
        <b class="sc-name">${esc(c.name)}</b>${tag}
        <span class="sc-addr">${esc(c.address || '')}</span>
        <span class="sc-meta">最近下单 <b>${esc(c.lastOrderAt || '—')}</b></span>
      </div>`;
    }
    const tag = c._day
      ? `<span class="pill" style="background:${dayColor(c._day)};color:#fff">第${c._day}天·${c._seq}</span>`
      : `<span class="pill ${c.customerType === 'new' ? 'blue' : 'orange'}">${c.customerType === 'new' ? '新客户' : '回访客户'}</span>`;
    return `<div class="cust-row ${c._day ? 'on' : ''}" onclick="toggleCust('${c._id}')">
      <span class="ck ${c._day ? 'on' : ''}">${c._day ? '✓' : ''}</span>
      <b class="sc-name">${esc(c.name)}</b>${tag}
      <span class="sc-addr">${esc(c.address || '')}</span>
    </div>`;
  }).join('') || '<div class="empty">客户库为空，请先导入客户</div>';
  $('selCount').textContent = '已选 ' + custCache.filter(c => c._day).length + ' 家';
}

// 某天店铺构成变化（增/删/重排）→ 该天规划数据失效，第三步显示「未规划」；绿色路线同步删除
// ---------- invalidateDayPlan ----------
function invalidateDayPlan(day) {
  delete ntDayMeta[day];
  delete ntRoutes[day];
  if (day === ntCurDay) renderRoute();
}

// ---------- clearCurDay（老板 2026-09-07 定：清空当天所有已选店铺，按钮在客户列表头部；无提示） ----------
function clearCurDay() {
  const d = ntCurDay;
  const list = selOf(d);
  if (!list.length) return;
  list.forEach(c => { c._day = null; c._seq = null; });
  invalidateDayPlan(d);
  renderDayTabs();
  renderCustSelect();
  renderMarkers();
  renderPlan();
}

// ---------- toggleCust ----------
function toggleCust(id) {
  const c = custCache.find(x => x._id === id);
  if (!c) return;
  if (curMode === 'mall' && c.visitState === 'in_task') return; // 全局任务中不可选（两层状态模型）
  if (c._day === ntCurDay) {
    c._day = null; c._seq = null;
    selOf(ntCurDay).forEach((x, i) => { x._seq = i + 1; });
    invalidateDayPlan(ntCurDay);
  } else if (!c._day) {
    if (!addToCurDay(c)) return;
    invalidateDayPlan(ntCurDay);
  } else {
    // 已属其他天：需先切到那天取消
    alert(`该店铺已排在第 ${c._day} 天，请先切到第 ${c._day} 天再取消`);
    return;
  }
  afterSelChange();
}

// ===== 腾讯地图：标记三态 + 店名标签 + Shift 框选 =====
// canvas 高分辨率圆点图标：80% 透明度 + 乳白描边（叠加时下层可见可辨）
// ---------- dotIcon ----------
function dotIcon(fill, stroke, num, fillAlpha, strokeAlpha) {
  const S = 120;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2);
  ctx.globalAlpha = fillAlpha != null ? fillAlpha : 0.8;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.globalAlpha = strokeAlpha != null ? strokeAlpha : 1;
  ctx.lineWidth = 7; // 1.2px（120px 画布 / 20px 显示比例）
  ctx.strokeStyle = stroke || '#FFF8F0'; // 默认乳白描边；不可选点用深灰描边
  ctx.stroke();
  if (num != null) { // 顺序号（选中当天时显示在圆点中心）
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 54px "PingFang SC","Microsoft YaHei",Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), S / 2, S / 2 + 2);
  }
  return c.toDataURL();
}

// ---------- initMap ----------
function initMap() {
  if (ntMap) { renderMarkers(); return; }
  if (mapLibLoaded) { buildMap(); return; }
  mapLibLoaded = true;
  const s = document.createElement('script');
  s.src = 'https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(mapKey);
  s.onload = () => buildMap();
  s.onerror = () => { alert('腾讯地图加载失败：请检查 Key 与域名白名单配置'); };
  document.head.appendChild(s);
}

// ---------- buildMap ----------
function buildMap() {
  if (ntMap) return;
  const el = $('ntMap');
  el.style.position = 'relative';
  // PRO 精简方案：baseMap.features 要素裁剪（不依赖任何样式 ID 授权，任何 Key 均有效）
  // features 留 base(道路)+building3d(建筑)+label(文字标注：道路名与 POI 名捆绑，无细分开关)
  ntMap = new TMap.Map(el, {
    center: new TMap.LatLng(WAREHOUSE.lat, WAREHOUSE.lng),
    zoom: 12,
    pitch: 0,
    rotation: 0,
    baseMap: { type: 'vector', features: ['base', 'building3d', 'label'] }
  });
  // 控件定制（2026-09-08 老板定）：只留 3D 导航球；移除 +/− 缩放与比例尺（官方 API removeControl）
  try { ntMap.removeControl(TMap.constants.DEFAULT_CONTROL_ID.ZOOM); } catch (e) { /* 控件不存在则静默 */ }
  try { ntMap.removeControl(TMap.constants.DEFAULT_CONTROL_ID.SCALE); } catch (e) { /* 控件不存在则静默 */ }
  // ===== 圆点 5 层显示层级（老板 2026-09-05 定）：创建顺序即叠放顺序，后建者在上 =====
  // ⑤ 最底：已拜访（深灰蓝，不可点）
  ntLayerVisited = new TMap.MultiMarker({
    map: ntMap, zIndex: 10,
    styles: { dis: new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: dotIcon('#4B5563') }) },
    geometries: []
  });
  // ④ 任务中（深灰蓝，不可点）
  ntLayerInTask = new TMap.MultiMarker({
    map: ntMap, zIndex: 11,
    styles: { dis: new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: dotIcon('#4B5563') }) },
    geometries: []
  });
  // ③ 其他天已选（暂不可选：天彩色减淡，点击提示跨天）
  const dimStyles = {};
  for (let d = 1; d <= 7; d++) {
    dimStyles['dim' + d] = new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: dotIcon(dayColor(d), '#FFF8F0', undefined, 0.35, 0.6) });
  }
  ntLayerLocked = new TMap.MultiMarker({ map: ntMap, zIndex: 12, styles: dimStyles, geometries: [] });
  // ② 待回访可选（浅灰点+深灰描边，点击选入当天）
  ntLayerTodo = new TMap.MultiMarker({
    map: ntMap, zIndex: 13,
    styles: { gray: new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: dotIcon('#D7DBE0', '#6B7280') }) },
    geometries: []
  });
  // ① 最顶：当天已选（天彩色+白色顺序号，点击取消）
  ntLayerDay = new TMap.MultiMarker({ map: ntMap, zIndex: 14, styles: {}, geometries: [] });
  // ===== 路线自绘 SVG 层（方案 C 2026-09-06：绕开 GL Polyline 绘制，SVG dasharray 真实生效） =====
  // z-index 7：盖住地图画布，垫在店名(10)/⭐(11)/框选(12)之下；圆点画在画布内 → 用 mask 挖孔露出，维持「圆点在路线之上」层级
  const NS = 'http://www.w3.org/2000/svg';
  ntRouteSvg = document.createElementNS(NS, 'svg');
  ntRouteSvg.setAttribute('id', 'ntRouteSvg');
  ntRouteSvg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:7;display:none';
  const mk = document.createElementNS(NS, 'mask');
  mk.setAttribute('id', 'ntRouteMask');
  mk.setAttribute('maskUnits', 'userSpaceOnUse');
  ntRouteMaskRect = document.createElementNS(NS, 'rect');
  ntRouteMaskRect.setAttribute('fill', '#fff');
  ntRouteMaskHoles = document.createElementNS(NS, 'g');
  ntRouteMaskHoles.setAttribute('fill', '#000');
  mk.appendChild(ntRouteMaskRect);
  mk.appendChild(ntRouteMaskHoles);
  ntRoutePathGreen = document.createElementNS(NS, 'path');
  ntRoutePathGreen.setAttribute('fill', 'none');
  ntRoutePathGreen.setAttribute('stroke', '#16A34A');
  ntRoutePathGreen.setAttribute('stroke-width', '4');
  ntRoutePathGreen.setAttribute('stroke-linecap', 'round');
  ntRoutePathGreen.setAttribute('stroke-linejoin', 'round');
  ntRoutePathGreen.setAttribute('mask', 'url(#ntRouteMask)');
  ntRoutePathDash = document.createElementNS(NS, 'path');
  ntRoutePathDash.setAttribute('fill', 'none');
  ntRoutePathDash.setAttribute('stroke', '#FFFFFF');
  ntRoutePathDash.setAttribute('stroke-opacity', '0.5'); // 蚂蚁线白色 50% 透明（老板 2026-09-06 定）
  ntRoutePathDash.setAttribute('stroke-width', '3');
  ntRoutePathDash.setAttribute('stroke-linecap', 'round');
  ntRoutePathDash.setAttribute('stroke-linejoin', 'round');
  ntRoutePathDash.setAttribute('stroke-dasharray', '16 16');
  ntRoutePathDash.setAttribute('mask', 'url(#ntRouteMask)');
  ntRouteSvg.appendChild(mk);
  ntRouteSvg.appendChild(ntRoutePathGreen);
  ntRouteSvg.appendChild(ntRoutePathDash);
  el.appendChild(ntRouteSvg);
  // 店名标签：自绘 DOM 层（MultiLabel 开关不可靠，DOM 绝对可控）
  ntMap.on('bounds_changed', () => { if (nwStep === 2) { positionDomLabels(); scheduleRouteSvg(); } });
  // 地图标记点击：①②③ 各自绑定（④⑤不可点不绑定）
  ntLayerDay.on('click', (e) => { const id = e.geometry && e.geometry.id; if (id) toggleCust(id); });
  ntLayerTodo.on('click', (e) => { const id = e.geometry && e.geometry.id; if (id) toggleCust(id); });
  ntLayerLocked.on('click', (e) => { const id = e.geometry && e.geometry.id; if (id) toggleCust(id); });
  bindBoxSelect(el);
  renderMarkers();
}

// ===== 店名标签：自绘 DOM 层（绝对可控的开关与配色） =====
// ---------- let domLabels ----------
let domLabels = {};

// ---------- clearDomLabels ----------
function clearDomLabels() {
  Object.values(domLabels).forEach(d => { if (d.parentNode) d.parentNode.removeChild(d); });
  domLabels = {};
}

// ---------- positionDomLabels ----------
function positionDomLabels() {
  if (!ntMap) return;
  Object.entries(domLabels).forEach(([id, d]) => {
    const c = custCache.find(x => x._id === id);
    if (!c || !c.lat || !c.lng) return;
    try {
      const p = ntMap.projectToContainer(new TMap.LatLng(c.lat, c.lng));
      d.style.left = p.getX() + 'px';
      d.style.top = (p.getY() - 34) + 'px';
    } catch (e) { /* 投影失败忽略 */ }
  });
  // 仓库星 ⭐：仅由仓库开关控制（2026-09-07 老板定）
  if (ntStarLabel && ntStarLabel.style.display !== 'none') {
    try {
      const p = ntMap.projectToContainer(new TMap.LatLng(WAREHOUSE.lat, WAREHOUSE.lng));
      ntStarLabel.style.left = p.getX() + 'px';
      ntStarLabel.style.top = p.getY() + 'px';
    } catch (e) { /* 投影失败忽略 */ }
  }
  // 路线起点星 ⭐：有路线即显示在 pts[0]，与仓库开关无关
  if (ntRouteStarLabel && ntRouteStarLabel.style.display !== 'none') {
    const route = ntRoutes[ntCurDay];
    if (route && route.pts && route.pts.length) {
      try {
        const p = ntMap.projectToContainer(new TMap.LatLng(route.pts[0][0], route.pts[0][1]));
        ntRouteStarLabel.style.left = p.getX() + 'px';
        ntRouteStarLabel.style.top = p.getY() + 'px';
      } catch (e) { /* 投影失败忽略 */ }
    }
  }
}

function ensureStar(el, ref) {
  if (el) return el;
  const div = document.createElement('div');
  div.textContent = '⭐';
  div.style.cssText = 'position:absolute;z-index:11;transform:translate(-50%,-50%);font-size:20px;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.3);display:none';
  $('ntMap').appendChild(div);
  if (ref === 'route') ntRouteStarLabel = div;
  return div;
}

// 仓库星显隐：点亮开关→显示仓库⭐，取消→隐藏；
// 新规则（2026-09-07 老板定）：路线起点星 50 米范围内不再显示其他星星——仓库与路线起点相距 ≤50 米时隐藏仓库星
function updateStar() {
  if (!ntMap) return;
  ntStarLabel = ensureStar(ntStarLabel, 'warehouse');
  const route = ntRoutes[ntCurDay];
  let tooClose = false;
  if (route && route.pts && route.pts.length) {
    const d = metersBetween(WAREHOUSE.lat, WAREHOUSE.lng, route.pts[0][0], route.pts[0][1]);
    tooClose = d <= 50;
  }
  ntStarLabel.style.display = (ntUseWarehouse && !tooClose) ? '' : 'none';
  positionDomLabels();
}

// 两点球面距离（米）
function metersBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 路线起点星显隐：有路线→显示 pts[0]，无路线→隐藏（与仓库开关无关）
function updateRouteStar() {
  if (!ntMap) return;
  ntRouteStarLabel = ensureStar(ntRouteStarLabel, 'route');
  const route = ntRoutes[ntCurDay];
  const show = !!(route && route.pts && route.pts.length);
  ntRouteStarLabel.style.display = show ? '' : 'none';
  positionDomLabels();
}

// ---------- renderMarkers ----------
function renderMarkers() {
  if (!ntMap || !ntLayerDay) return;
  const withCoord = custCache.filter(c => c.lat && c.lng);
  const geo = c => ({ id: c._id, position: new TMap.LatLng(c.lat, c.lng) });
  // ⑤ 已拜访（最底）
  if (ntLayerVisited) {
    ntLayerVisited.setGeometries(withCoord.filter(c => c.visitState === 'visited' && !c._day).map(c => ({ ...geo(c), styleId: 'dis' })));
  }
  // ④ 任务中
  if (ntLayerInTask) {
    ntLayerInTask.setGeometries(withCoord.filter(c => c.visitState === 'in_task' && !c._day).map(c => ({ ...geo(c), styleId: 'dis' })));
  }
  // ③ 其他天已选（暂不可选：天彩色减淡）
  if (ntLayerLocked) {
    ntLayerLocked.setGeometries(withCoord.filter(custTempLocked).map(c => ({ ...geo(c), styleId: 'dim' + c._day })));
  }
  // ② 待回访可选未选
  if (ntLayerTodo) {
    ntLayerTodo.setGeometries(withCoord.filter(c => custSelectable(c) && !c._day).map(c => ({ ...geo(c), styleId: 'gray' })));
  }
  // ① 当天已选（最顶，天彩色+顺序号；序号变 → 样式动态重建）
  const daySeq = {};
  selOf(ntCurDay).forEach((c, i) => { daySeq[c._id] = i + 1; });
  if (ntLayerDay) {
    const styles = {};
    for (let s = 1; s <= 15; s++) {
      styles['full' + s] = new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: dotIcon(dayColor(ntCurDay), undefined, s) });
    }
    ntLayerDay.setStyles(styles);
    ntLayerDay.setGeometries(selOf(ntCurDay).filter(c => c.lat && c.lng).map(c => ({ ...geo(c), styleId: 'full' + (daySeq[c._id] || 1) })));
  }
  clearDomLabels();
  if (showSelNames || showDisNames) buildDomLabels();
  renderRoute(); // 绿色导航线随当前天/构成变化刷新
}

// ===== 绿色导航路线：真实道路轨迹 + 蚂蚁线流动（老板 2026-09-06 定稿） =====
// 腾讯 driving polyline 差分解压：[lat0, lng0, dlat1, dlng1...]，差分单位 1e-6 度
function decodePolyline(pl) {
  const pts = [];
  if (!Array.isArray(pl) || pl.length < 2) return pts;
  let lat = pl[0], lng = pl[1];
  pts.push([lat, lng]);
  for (let i = 2; i + 1 < pl.length; i += 2) {
    lat += pl[i] / 1e6;
    lng += pl[i + 1] / 1e6;
    pts.push([lat, lng]);
  }
  return pts;
}
// 停止蚂蚁线动画
function stopRouteAnim() {
  if (ntRouteTimer) { clearInterval(ntRouteTimer); ntRouteTimer = null; }
}
// 方案 C：SVG 自绘路线。经纬度 → 容器像素 → path d（地图拖动/缩放时由 bounds_changed 触发重算）
let projPending = false;
function scheduleRouteSvg() { // rAF 合并高频重投影
  if (projPending) return;
  projPending = true;
  requestAnimationFrame(() => { projPending = false; renderRouteSvg(); });
}
function renderRouteSvg() {
  if (!ntMap || !ntRouteSvg) return;
  const route = ntRoutes[ntCurDay];
  if (!route || !route.pts || route.pts.length < 2) {
    ntRouteSvg.style.display = 'none';
    ntRoutePathGreen.setAttribute('d', '');
    ntRoutePathDash.setAttribute('d', '');
    return;
  }
  let d = '';
  try {
    route.pts.forEach((p, i) => {
      const pt = ntMap.projectToContainer(new TMap.LatLng(p[0], p[1]));
      const x = pt.getX(), y = pt.getY();
      if (!isFinite(x) || !isFinite(y)) throw new Error('bad projection');
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
  } catch (e) { ntRouteSvg.style.display = 'none'; return; }
  ntRoutePathGreen.setAttribute('d', d);
  ntRoutePathDash.setAttribute('d', d);
  ntRoutePathDash.setAttribute('stroke-dashoffset', -ntDashPhase);
  // mask 挖孔：所有圆点位置把路线抠掉，圆点（画布内 z10~14）视觉上压在路线之上
  if (ntRouteMaskRect) {
    const el = $('ntMap');
    const w = el.clientWidth || 0, h = el.clientHeight || 0;
    if (w < 2 || h < 2) { ntRouteSvg.style.display = 'none'; return; } // 容器隐藏中（第 3 步）：不重画，回第 2 步时 renderRoute 会重算
    ntRouteMaskRect.setAttribute('width', w);
    ntRouteMaskRect.setAttribute('height', h);
  }
  if (ntRouteMaskHoles) {
    ntRouteMaskHoles.innerHTML = '';
    custCache.forEach(c => {
      if (!c.lat || !c.lng) return;
      try {
        const pt = ntMap.projectToContainer(new TMap.LatLng(c.lat, c.lng));
        const cir = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        cir.setAttribute('cx', pt.getX().toFixed(1));
        cir.setAttribute('cy', pt.getY().toFixed(1));
        cir.setAttribute('r', '13');
        ntRouteMaskHoles.appendChild(cir);
      } catch (e) { /* 投影失败跳过 */ }
    });
  }
  ntRouteSvg.style.display = '';
}
// 绘制/清除当前天的绿色路线（SVG 自绘：绿实线 + 白蚂蚁虚线 + ⭐ 起点 + 底部里程标签）
function renderRoute() {
  if (!ntMap) return;
  const label = $('ntRouteLabel');
  const route = ntRoutes[ntCurDay];
  if (!route || !route.pts || route.pts.length < 2) {
    stopRouteAnim();
    if (ntRouteSvg) ntRouteSvg.style.display = 'none';
    if (ntRoutePathGreen) ntRoutePathGreen.setAttribute('d', '');
    if (ntRoutePathDash) ntRoutePathDash.setAttribute('d', '');
    updateStar();      // 仓库星：仅跟开关走
    updateRouteStar(); // 路线起点星：无路线隐藏
    if (label) label.style.display = 'none';
    return;
  }
  renderRouteSvg();
  // 白蚂蚁线流动：SVG dashoffset 每 150ms 推进 2px（≈13px/s 舒缓行走感，老板已确认的节奏）
  if (!ntRouteTimer) {
    ntRouteTimer = setInterval(() => {
      if (!ntRoutePathDash) { stopRouteAnim(); return; }
      const cur = ntRoutes[ntCurDay]; // 实时读当前天轨迹（切天后自动换线）
      if (!cur || !cur.pts || cur.pts.length < 2) { stopRouteAnim(); return; }
      ntDashPhase = (ntDashPhase + 2) % 32;
      ntRoutePathDash.setAttribute('stroke-dashoffset', -ntDashPhase);
    }, 150);
  }
  // 两颗星独立：仓库星（跟开关）+ 路线起点星（跟路线），可同时出现
  updateStar();
  updateRouteStar();
  // 底部居中里程标签：绿色细字
  if (label) {
    label.style.display = '';
    label.textContent = `第 ${ntCurDay} 天全程 ${(route.distanceMeters / 1000).toFixed(1)} 公里${route.fallback ? '（直线估算）' : ''}`;
  }
}

// 重建 DOM 店名标签（双圆点控制：可选/不可选各自独立显隐；暂不可选与真不可选同归右圆点；不可选点弱化：无底色只文字灰）
// ---------- buildDomLabels ----------
function buildDomLabels() {  if (!ntMap) return;
  const el = $('ntMap');
  custCache.filter(c => {
    if (!c.lat || !c.lng) return false;
    const selLike = custSelectable(c) && !custTempLocked(c); // 真正可选（当前天维度）
    return selLike ? showSelNames : showDisNames;
  }).forEach(c => {
    const d = document.createElement('div');
    const selLike = custSelectable(c) && !custTempLocked(c);
    d.className = 'map-domlabel' + (selLike ? '' : ' dis');
    d.textContent = c.name;
    d.style.color = c._day ? dayColor(c._day) : '#4B5563';
    if (selLike) d.style.background = 'rgba(255,255,255,.5)'; // 仅可选店名的文字底色 50% 透明
    el.appendChild(d);
    domLabels[c._id] = d;
  });
  positionDomLabels();
}

// 双圆点开关：sel=可选店名 / dis=不可选店名
// ---------- toggleNameDot ----------
function toggleNameDot(k) {
  if (k === 'sel') showSelNames = !showSelNames;
  else if (k === 'dis') showDisNames = !showDisNames;
  const dSel = $('ntDotSel');
  const dDis = $('ntDotDis');
  if (dSel) dSel.classList.toggle('on', showSelNames);
  if (dDis) dDis.classList.toggle('on', showDisNames);
  clearDomLabels();
  if (showSelNames || showDisNames) buildDomLabels();
}

// ---------- bindBoxSelect ----------
function bindBoxSelect(el) {
  let sx = 0, sy = 0;
  // 透明遮罩：Shift 按下瞬间盖住地图，拦截后续 mousemove
  const shield = document.createElement('div');
  shield.style.cssText = 'position:absolute;inset:0;z-index:11;display:none;background:transparent';
  el.appendChild(shield);
  // 捕获阶段拦截：在事件到达地图 canvas 之前 stopPropagation，地图收不到 mousedown 就不会开始拖拽
  el.addEventListener('mousedown', e => {
    if (!e.shiftKey || !ntMap || boxSel) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    shield.style.display = 'block';
    const r = el.getBoundingClientRect();
    sx = e.clientX - r.left; sy = e.clientY - r.top;
    boxSel = document.createElement('div');
    boxSel.style.cssText = 'position:absolute;border:1.5px dashed #F5531C;background:rgba(245,83,28,.12);z-index:12;pointer-events:none';
    boxSel.style.left = sx + 'px'; boxSel.style.top = sy + 'px';
    el.appendChild(boxSel);
  }, true); // ← capture 阶段
  window.addEventListener('mousemove', e => {
    if (!boxSel) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    boxSel.style.left = Math.min(sx, x) + 'px';
    boxSel.style.top = Math.min(sy, y) + 'px';
    boxSel.style.width = Math.abs(x - sx) + 'px';
    boxSel.style.height = Math.abs(y - sy) + 'px';
  });
  window.addEventListener('mouseup', e => {
    if (!boxSel || !ntMap) return;
    shield.style.display = 'none';
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const w = Math.abs(x - sx), h = Math.abs(y - sy);
    if (boxSel.parentNode) boxSel.parentNode.removeChild(boxSel);
    boxSel = null;
    if (w < 8 || h < 8) return; // 太小视为点击
    try {
      const p1 = ntMap.unprojectFromContainer(new TMap.Point(Math.min(sx, x), Math.min(sy, y)));
      const p2 = ntMap.unprojectFromContainer(new TMap.Point(Math.max(sx, x), Math.max(sy, y)));
      const latMin = Math.min(p1.getLat(), p2.getLat());
      const latMax = Math.max(p1.getLat(), p2.getLat());
      const lngMin = Math.min(p1.getLng(), p2.getLng());
      const lngMax = Math.max(p1.getLng(), p2.getLng());
      const hits = custCache.filter(c => !c._day && c.lat && c.lng && custSelectable(c) && !custTempLocked(c) &&
        c.lat >= latMin && c.lat <= latMax && c.lng >= lngMin && c.lng <= lngMax);
      let added = 0;
      hits.forEach(c => { if (selOf(ntCurDay).length < 15 && addToCurDay(c)) added++; });
      if (added) invalidateDayPlan(ntCurDay);
      if (hits.length && !added && selOf(ntCurDay).length >= 15) alert(`第 ${ntCurDay} 天已满 15 家，请切换其他天`);
      afterSelChange();
    } catch (err) { /* 框选坐标换算失败静默 */ }
  });
}

// ===== 轻提示：无按钮，2 秒自动缩回 =====
// ---------- showToast ----------
function showToast(msg) {
  let t = $('ntToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ntToast';
    t.style.cssText = 'position:fixed;top:80px;left:50%;transform:translate(-50%,0);background:rgba(17,24,39,.92);color:#fff;padding:10px 22px;border-radius:10px;font-size:13.5px;font-weight:700;z-index:999;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.25)';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  t.style.transform = 'translate(-50%,0)';
  clearTimeout(t._h);
  t._h = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translate(-50%,-10px) scale(.96)';
  }, 2000);
}

// ===== 智能规划（§7.11 单天版：第二步对当前选中的天排序，起点可仓库/第一家） =====
// 起点开关（2026-09-06 老板定）：默认仓库；关闭后第一家店铺为起点。对智能/手动规划统一生效
let ntUseWarehouse = true;
function toggleWarehouseStart() {
  ntUseWarehouse = !ntUseWarehouse;
  const dot = $('ntDotWarehouse');
  if (dot) dot.classList.toggle('on', ntUseWarehouse);
  invalidateDayPlan(ntCurDay); // 起点变了：当前天已规划的路线作废（2026-09-07 老板定）
  renderDayTabs();             // 天页签 ✓ 徽章同步消失
  showToast(ntUseWarehouse ? '起点：仓库（重新点规划生效）' : '起点：第一家店铺（重新点规划生效）');
  updateStar(); // 仓库⭐ 立即出现/消失（2026-09-07 老板定）
}
// 当前起点（仓库或点选顺序第一家；第一家无坐标时回退仓库）
function planOrigin(list) {
  if (ntUseWarehouse) return WAREHOUSE;
  const first = list && list[0];
  if (first && first.lat && first.lng) return { lat: first.lat, lng: first.lng };
  return WAREHOUSE;
}
// 路线 pts 兜底：起点=第一家时不重复前缀起点（第一家本身就是 pts 首点）；
// 注意 pts 统一为 [lat,lng] 数组（起点对象必须转数组，否则 SVG 画线/⭐ 定位取 [0]/[1] 会拿到 undefined）
function fallbackPts(start, ordered) {
  const coordPts = ordered.filter(c => c.lat && c.lng).map(c => [c.lat, c.lng]);
  const startIsFirst = ordered.length && ordered[0].lat && ordered[0].lng &&
    Math.abs(start.lat - ordered[0].lat) < 0.000001 && Math.abs(start.lng - ordered[0].lng) < 0.000001;
  return startIsFirst ? coordPts : [[start.lat, start.lng], ...coordPts];
}
// ---------- smartSortCurDay ----------
let planBusy = 0; // 2026-09-09 防连点：智能/手动规划 15 秒窗口锁
async function smartSortCurDay() {
  if (Date.now() - planBusy < 15000) return;
  planBusy = Date.now();
  const d = ntCurDay;
  const list = selOf(d);
  if (!list.length) { showToast('第 ' + d + ' 天还没有选中店铺，无法规划'); return; }
  if (list.length === 1) {
    ntDayMeta[d] = { distanceMeters: 0, durationMin: 0, fallback: false, planMode: 'smart' };
    renderDayTabs();
    renderCustSelect();
    showToast('第 ' + d + ' 天只有 1 家店铺，无需规划');
    return;
  }
  const btn = $('ntSortCapsule');
  if (!btn) return;
  btn.textContent = '⏳ 智能中…';
  try {
    const start = planOrigin(list);
    const res = await api('smartSortDay', {
      origin: start,
      customers: list.map(c => ({ id: c._id, lat: c.lat, lng: c.lng, name: c.name }))
    });
    if (res.ok && Array.isArray(res.order)) {
      const map = {};
      list.forEach(c => { map[c._id] = c; });
      res.order.forEach((id, i) => { if (map[id]) map[id]._seq = i + 1; });
      list.forEach(c => { if (!c._seq) c._seq = 99; });
      list.sort((a, b) => a._seq - b._seq).forEach((c, i) => { c._seq = i + 1; });
      ntDayMeta[d] = { distanceMeters: res.distanceMeters || 0, durationMin: res.durationMin || 0, fallback: !!res.fallback, planMode: 'smart' };
      // 保存轨迹供绿色导航线（真实道路折线；无 polyline 时用直线段兜底）
      const ordered = list.sort((a, b) => a._seq - b._seq);
      ntRoutes[d] = {
        pts: res.polyline ? decodePolyline(res.polyline) : fallbackPts(start, ordered),
        distanceMeters: res.distanceMeters || 0,
        fallback: !!res.fallback
      };
      renderDayTabs();
      renderCustSelect();
      renderMarkers();
      renderPlan();
      showToast('第 ' + d + ' 天已智能规划完毕，绿色路线已就位');
    } else {
      alert('智能规划失败：' + ((res && res.error) || '云端返回异常'));
    }
  } catch (e) {
    alert('智能规划失败：' + ((e && e.message) || e));
  }
  btn.innerHTML = '<span class="plan-ic up">➤</span>智能';
}

// ---------- manualPlanCurDay（2026-09-06 老板定：按鼠标点选顺序规划；框选批量加入的垫后） ----------
async function manualPlanCurDay() {
  if (Date.now() - planBusy < 15000) return;
  planBusy = Date.now();
  const d = ntCurDay;
  const list = selOf(d); // selOf 已按 _seq（=点选顺序）排序，框选批量加入的序号靠后
  if (!list.length) { showToast('第 ' + d + ' 天还没有选中店铺，无法规划'); return; }
  if (list.length === 1) {
    ntDayMeta[d] = { distanceMeters: 0, durationMin: 0, fallback: false, planMode: 'manual' };
    renderDayTabs();
    renderCustSelect();
    showToast('第 ' + d + ' 天只有 1 家店铺，无需规划');
    return;
  }
  const btn = $('ntManualCapsule');
  if (!btn) return;
  btn.textContent = '⏳ 手动中…';
  try {
    const start = planOrigin(list);
    const res = await api('smartSortDay', {
      mode: 'manual',
      order: list.map(c => c._id),
      origin: start,
      customers: list.map(c => ({ id: c._id, lat: c.lat, lng: c.lng, name: c.name }))
    });
    if (res.ok && Array.isArray(res.order)) {
      const map = {};
      list.forEach(c => { map[c._id] = c; });
      res.order.forEach((id, i) => { if (map[id]) map[id]._seq = i + 1; });
      list.forEach(c => { if (!c._seq) c._seq = 99; });
      list.sort((a, b) => a._seq - b._seq).forEach((c, i) => { c._seq = i + 1; });
      ntDayMeta[d] = { distanceMeters: res.distanceMeters || 0, durationMin: res.durationMin || 0, fallback: !!res.fallback, planMode: 'manual' };
      const ordered = list.sort((a, b) => a._seq - b._seq);
      ntRoutes[d] = {
        pts: res.polyline ? decodePolyline(res.polyline) : fallbackPts(start, ordered),
        distanceMeters: res.distanceMeters || 0,
        fallback: !!res.fallback
      };
      renderDayTabs();
      renderCustSelect();
      renderMarkers();
      renderPlan();
      showToast('第 ' + d + ' 天已按点选顺序规划完毕，绿色路线已就位');
    } else {
      alert('手动规划失败：' + ((res && res.error) || '云端返回异常'));
    }
  } catch (e) {
    alert('手动规划失败：' + ((e && e.message) || e));
  }
  btn.innerHTML = '<span class="plan-ic b flip">✎</span>手动';
}

// ===== 天数修正（老板 2026-09-06 定：天数与初始设置不同必须修正，否则不能存草稿/发送） =====
// 设置第 1 步天数选择器为 n 天并重算截止日期
function setDayCount(n) {
  n = Math.min(7, Math.max(1, n));
  document.querySelectorAll('#ntDays .ctab').forEach((t, i) => t.classList.toggle('on', i === n - 1));
  recalcDeadline();
}
// 第 2 步「＋」胶囊：增加一天（最多 7 天）
function addTaskDay() {
  const cur = dayCount();
  if (cur >= 7) { showToast('最多只能安排 7 天'); return; }
  setDayCount(cur + 1);
  renderDayTabs();
  showToast('已增加为 ' + (cur + 1) + ' 天（记得去第 3 步修正天数）');
}
// 实际有店的天数
function usedDayCount() {
  return new Set(custCache.filter(c => c._day).map(c => c._day)).size;
}
// 是否需要修正：当前选择器天数 ≠ 初始天数，或 实际有店天数 ≠ 当前选择器天数
function needsFixDays() {
  return dayCount() !== initTaskDays || usedDayCount() !== dayCount();
}
// 第 3 步「🔧 修正任务天数」：去掉空天、紧凑重排、同步选择器/初始天数/截止日期/规划数据
function fixTaskDays() {
  const used = [...new Set(custCache.filter(c => c._day).map(c => c._day))].sort((a, b) => a - b);
  if (!used.length) { showToast('还没有选中任何店铺'); return; }
  const actual = used.length;
  const map = {};
  used.forEach((d, i) => { map[d] = i + 1; });
  // 店内顺序不动，只改所属天号
  custCache.forEach(c => { if (c._day) c._day = map[c._day]; });
  // 规划数据跟随天号迁移
  const meta2 = {};
  Object.keys(ntDayMeta).forEach(k => {
    const nd = map[Number(k)];
    if (nd) meta2[nd] = ntDayMeta[k];
  });
  ntDayMeta = meta2;
  // 绿色路线跟随天号迁移
  const routes2 = {};
  Object.keys(ntRoutes).forEach(k => {
    const nd = map[Number(k)];
    if (nd) routes2[nd] = ntRoutes[k];
  });
  ntRoutes = routes2;
  // 天数选择器与初始基准同步为实际天数
  setDayCount(actual);
  initTaskDays = actual;
  // 当前选中天归位（可能超出新天数）
  if (ntCurDay > actual) ntCurDay = actual;
  renderDayTabs();
  renderPlan();
  renderRoute(); // 天号迁移后地图路线同步（回第 2 步时立即正确）
  if (nwStep === 3) renderCustSelect(); // 列表序号胶囊同步
  showToast('任务已修正为 ' + actual + ' 天（空天已去除，截止日期已重算）');
}
window.fixTaskDays = fixTaskDays;
window.addTaskDay = addTaskDay;

// ---------- renderPlan ----------
function renderPlan() {
  const days = dayCount();
  const total = custCache.filter(c => c._day).length;
  $('sumTotal').textContent = total + ' 家';
  $('sumDays').textContent = days + ' 天';
  $('sumSm').textContent = nwSalesman ? `${nwSalesman.name}（${nwSalesman.phone}）` : '—';
  $('sumDl').textContent = $('ntDeadline').value.trim() || '—';
  $('planPreview').innerHTML = `<div style="display:grid;grid-template-columns:repeat(${Math.min(days, 4)},1fr);gap:12px">` +
    Array.from({ length: days }, (_, i) => {
      const d = i + 1;
      const list = selOf(d);
      const meta = ntDayMeta[d];
      // 0 店：不显示任何底部行；有店未规划：显示「未规划」；有店已规划：显示公里数
      const metaLine = !list.length ? '' : (meta
        ? `<div style="font-size:11px;color:${meta.fallback ? '#B97A0B' : 'var(--green)'};font-weight:700;margin-top:6px">🚗 ${(meta.distanceMeters / 1000).toFixed(1)} 公里${meta.fallback ? '（直线估算）' : ''}</div>`
        : `<div style="font-size:11px;color:#9AA1AB;font-weight:600;margin-top:6px">未规划</div>`);
      return `<div class="dcol"><div class="dh" style="color:${dayColor(d)}">第 ${d} 天 <b style="color:var(--ink)">${list.length} 家</b></div>` +
        list.map(c => `<div class="dchip">${c._seq}. ${esc(c.name)}</div>`).join('') + metaLine + '</div>';
    }).join('') + '</div>';
}
