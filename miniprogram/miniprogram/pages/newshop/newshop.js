// pages/newshop/newshop.js —— 加新店（2026-09-28 新增）
// 业务员**现场**给还没在库里的店建档。口径：_scratch/加新店-演示.html ＋ 加新店-防重复-演示.html
// 老板 2026-09-28 拍板：① 电话**选填**（填了就按"同电话 = 铁证"拦；没填只做同名提示）
//                      ② 提交后**直接进客户列表** ＋ 后台备一份「现场录入 · 待商城建档」
//                      ③ 区域与商圈**都自动填**（可手改）④ **店面照必拍**（没照片不让提交）
//
// ⭐ 坐标（2026-09-29 v4，老板真机反馈 + 多轮演示稿讨论后定稿）——
//   核心：**三个来源各自独立存在，最后由业务员点「采用」决定用哪一个**：
//     📱 手机定位（蓝，/images/locdot_blue.png）   ——  精度差（几十米），设备没带时的退路
//     📡 北斗卫星（绿，/images/locdot_green.png）  ——  精度约 1 米，采点中会实时移动
//     ✎ 手动微调（红，/images/locdot_red.png）     ——  拖着对准门口，兜底矫正
//   规则（老板 2026-09-29 定）：
//     · 三个点**可以同屏**；**被采用的那个正常显示、略大，另外两个 50% 半透明**（alpha .45）
//     · 按钮**三行，每行"左采集 / 右采用"**，左右同色：
//         第1行 📱 手机定位  |  ✓ 采用手机
//         第2行 📡 北斗卫星  |  ✓ 采用卫星
//         第3行 ✎ 微调位置  |  ✓ 采用微调
//     · **"候选 → 采用"两段式**（北斗卫星与微调都是这个模型，别混）：
//         - 北斗卫星：采点中写 `pend*`（候选）→ 点「采用卫星」才落成 `gpsLat`
//         - 微调：拖动写 `tunCand*`（候选）→ 点「采用微调」才落成 `tunLat`
//       **采点中/微调中都绝不写最终坐标**。
//     · ⭐ 微调的特别之处（老板 2026-09-29 明确要求）：
//         **已经定下的 `tunLat` 在重新进入微调时"留在原地不动"**，动的只是 `tunCand*`（地图正中的红图钉）；
//         只有再点「✓ 采用微调」才把候选落定、红点才跳过去。
//     · 进采点 / 微调之前**先停另一个来源**；北斗卫星收敛时**震动**提醒。
//     · ⚠️ 微调中**绝不许 setData 地图中心**（否则视野被拉回、红点看着"跳回去"）。
//   提交给后台的是**被采用那个点**的坐标（lat/lng + 北斗卫星时的 wgsLat/wgsLng）
//
// ⭐ 录音（2026-09-28 晚）：现场证据的一部分，跟拜访页**同源口径** ——
//   ≤6 段、单条上限跟后台「拜访录音上限」档位走（180/300/600，**不写死**）、**合计 30 分钟硬封顶**、
//   每段可勾「转文字」（走 transcribe 云函数的 fileIDs 分支，跟「记事」一样**不依赖 visitId**）。
const api = require('../../utils/api');
const media = require('../../utils/media');
const WORDS = require('../../utils/newshop_words');
// ⭐ 自绘三级滚轮的行高（2026-10-02 老板定 34px）—— **必须与 newshop.wxss 里 .pk-i 的 height 一致**：
//   改一个就要改另一个，否则吸附会错位（行高变了、吸附还按老刻度算 → 永远对不齐）。
const PK_ROW = 34;
const { GpsCapture } = require('../../utils/gps/capture');

// 区域候选（与云函数 geoVote 的口径一致 —— 就是 biz_index 里的"行政区"，共 9 个）
const AREA_LIST = ['永康市', '金东区', '婺城区', '武义县', '浦江县', '磐安县', '兰溪市', '义乌市', '东阳市'];

// 服务与设施 9 组（第一组 = 外卖 / 团购；其余按语义归组，词都来自 words.json 的真实词频）
const FAC_GROUPS = [
  { key: 'flag', title: '🛵 外卖 / 团购', items: ['有外卖', '有团购'] },
  { key: 'order', title: '🍽 点餐与付款', items: ['可预点餐', '可自助点餐', '可自助结账', '可手机支付', '可现金付款', '可刷卡'] },
  { key: 'park', title: '🅿️ 停车', items: ['免费停车', '有停车场', '付费停车'] },
  { key: 'smoke', title: '🚬 吸烟', items: ['无烟餐厅', '吸烟区'] },
  { key: 'pet', title: '🐶 宠物', items: ['可带宠物', '宠物禁入', '可携带宠物'] },
  { key: 'kid', title: '👶 亲子', items: ['宝宝椅', '儿童游乐区'] },
  { key: 'room', title: '🎉 包间 / 宴会', items: ['有包间', '可包场', '宴会厅', '卡座', '沙发位', '等位区'] },
  { key: 'util', title: '🔌 店内设施', items: ['空调开放', '免费Wi-Fi', '充电宝', '充电线', '充电插座', '室内卫生间', '无障碍设施'] },
  { key: 'feature', title: '✨ 门店特色', items: ['明厨亮灶', '沿街', '特色主题餐厅', '小清新风格', '室内景观', '文化主题餐厅', '复古风格', '商场餐厅', '庭院餐厅', '深巷小店'] }
];

// ⚠️ 2026-09-29 老板改：**最多 3 段**（原来是 6）；并且**不要「转文字」功能**了
const MAX_SEG = 3;                 // 段数上限
const MAX_TOTAL_SEC = 30 * 60;     // 合计硬封顶 30 分钟

// 营业时间只选**整点**（老板 2026-09-29 定）→ 00:00 ~ 23:00 共 24 个
const HOUR_LIST = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00');

// 四个步骤的名字（底部「N/4」下面那行小字）
const STEP_NAMES = ['定位', '信息', '品类', '证据'];

// 招牌菜：自由输入 → 数组。用「、，；,;」和换行拆开，去空白、去重
//   （写进 customers.platManual.dishes，与「客户详情页 → 现场提报」同一个落点）
function splitDishes(raw) {
  return String(raw || '')
    .split(/[、，,；;\n\r]+/)
    .map(x => x.trim())
    .filter((x, i, a) => x && a.indexOf(x) === i);
}
// 三个点位的图标：**三张同款、只有颜色不同**
//   ⚠️ 2026-09-29 老板反馈「手机定位的蓝点太小、GPS 的点有点大」——根因是三张图参数不一致：
//      蓝点原来沿用项目自带的 locdot.png（实心圆占比小 + 白边粗 + 有浅色底），同尺寸下显得小。
//      现在三张都由 _scratch/make_dots.js 用同一套参数画（半径 16 + 白边 4 + 透明底），视觉一致。
//      ⚠️ 没去动项目原有的 locdot.png（可能别处还在用），另存为 locdot_blue.png。
const ICON = { phone: '/images/locdot_blue.png', gps: '/images/locdot_green.png', tune: '/images/locdot_red.png' };
const MARK = 22;                   // 三个点的标准边长（老板 2026-09-29 定：照红点再小一点点）
const MARK_BIG = 26;               // 被采用的那个点略大一圈，好认

Page({
  onShareAppMessage() { return require('../../utils/share').cfg(); },

  data: {
    // ===== 坐标：三个来源各自独立 + adopted 记录采用了哪个（⭐ 2026-09-29 v4）=====
    phoneLat: '', phoneLng: '', phoneAcc: '', phoneOn: false,      // 📱 手机定位
    gpsLat: '', gpsLng: '', gpsWgsLat: '', gpsWgsLng: '', gpsOn: false,  // 📡 北斗卫星（已采用）
    tunLat: '', tunLng: '', tunOn: false,                          // ✎ 微调（**已定下**的那个点）
    // 北斗卫星中的"候选"（**绝不写进 gpsLat/gpsLng**，点「采用卫星」才落）
    pendLat: '', pendLng: '', pendWgsLat: '', pendWgsLng: '', pendStable: false,
    // 微调拖动中的"候选"（= 地图中心；**绝不写进 tunLat**，点「采用微调」才落）
    // ⭐ 这样"已定下的微调点"在重新微调时会留在原地不动 —— 老板 2026-09-29 明确要求
    tunCandLat: '', tunCandLng: '', tunDist: '',
    gpsText: '', gpsSummary: '', capOn: false,
    adopted: '',                    // '' | 'phone' | 'gps' | 'tune'  ← 最终用哪个
    mode: 'idle',                   // idle | capturing | tuning
    markers: [],                    // 地图上的点（三个来源）
    mapLat: '', mapLng: '',         // 地图中心
    // 提交用：= 被采用那个点的坐标
    lat: '', lng: '', wgsLat: '', wgsLng: '', addr: '', locBusy: false,
    // ===== 步骤（⭐ 2026-09-29 重组为四步流程）=====
    step: 1, stepName: '定位',
    canNext: false,                    // 当前这一步能不能往下走（底部「下一步」的亮/灰）
    // ===== 表单 =====
    name: '', phone: '', address: '', contact: '', note: '',
    // ⭐ 2026-10-02 老板定：**最多两个电话** ——
    //   phone2 = 第二个号码（存 customers.phone2，与商城侧「联系人联系电话」同一字段）；
    //   phone2Open = 第二个输入框是否展开（默认收起，点电话行右侧的 ⊕ 才出现）
    phone2: '', phone2Open: false,
    areaList: AREA_LIST, area: '', areaIdx: 0,
    bizCircle: '', cands: [],
    // 营业时间：两个**整点下拉**（老板 2026-09-29 定；默认 08:00 — 21:00）
    hourList: HOUR_LIST, hour1: '08:00', hour2: '21:00', hourIdx1: 8, hourIdx2: 21,
    catRange: [[], [], []], catIdx: [0, 0, 0], catText: '', cat1: '', cat2: '', cat3: '',
    // ⭐ 自绘三级滚轮的状态（2026-10-02）：pkShow = 弹层显隐；pkTmp = 弹层内的临时选择（点"确定"才写回）；
    //   catTop = 三列各自的 scroll-top（吸附用，30px = 一行）
    pkShow: false, pkTmp: [0, 0, 0], catTop: [0, 0, 0],
    // ⚠️ 2026-10-02 拆成两个：**pkHi = "选框里现在高亮第几行"**（滚动中实时更新，**只影响显示**）；
    //   **pkTmp = "真正选中的索引"**（只在吸附/点击后更新，**只有它才牵动后两列重算**）。
    //   混用一个变量会让"中类换了、小类还没重算"→ 就是老板报的"小类不相符"。
    pkHi: [0, 0, 0],
    // 招牌菜：自由输入，「、，；」隔开 → 拆成数组（写 customers.platManual.dishes，与现场提报同落点）
    dishRaw: '', dishes: [],
    facGroups: FAC_GROUPS.map(g => ({ key: g.key, title: g.title, items: g.items.map(v => ({ v: v, on: false })) })), facSel: {},
    photos: ['', '', ''], photoIds: ['', '', ''], photoBusy: false,
    // ===== 录音（选填）=====
    recEnabled: true, recLimit: 300,                          // 后台设置（newShopCheck 带回来，不写死）
    recOn: false, curSec: 0, curText: '00:00',
    recs: [], recSecs: 0, recTotal: '00:00', playingId: '', recBusy: false,
    wish: '',
    // ===== 查重 =====
    // ⭐⭐ 2026-09-29 重要改动：**结果区改成常驻**（老板定的铁律：点了检测就必须有结果）
    //   以前 dupShow 初值是 false、"点了才显示" —— 一旦有任何一环没覆盖，就表现成"什么都不出来"。
    //   真凶是 onNameBlur：点按钮那一刻输入框失焦，把刚设上的 dupShow 又清回 false。
    //   现在：**第 2 步一进来就显示引导卡**，点了检测才换成结果卡 —— 结构上不可能空空如也。
    dupShow: true, dupBusy: false, dupChecked: false,
    checked: false, blk: null, same: null, sameIgnored: false,
    // ⭐ 2026-09-29：疑似重复（店名高度相似 / 电话近似）—— 只预警、不拦
    near: null,
    // ⚠️ 附近查询失败的原因（云端不再吞错，会带上来用红卡显示）
    dupErr: '',
    // ⭐ 引导提示：'' 无 / 'needInput' 还没填店名电话 / 'noCoord' 还没取坐标
    //   （初值就给 needInput —— 进第 2 步看到的是引导卡，不是空白）
    dupTip: 'needInput',
    // 🔴 2026-10-02 老板定：**"还没填好店名/电话"时，整块防重结果区都不显示**
    //   （原话「把新店第二步上面的蓝色提示框去掉」＋ 追问「刚进来要什么结果呢」）
    //   ⚠️ 光隐藏引导卡是不够的：条件链会掉到最后一个兜底分支 `wx:elif="{{dupShow}}"`
    //      （那个条件只有 dupShow，恒真）→ 刚进第 2 步就蹦出一张"没拿到结果"的框。
    //      所以**引导卡与兜底卡共用这个开关**，一起关掉才干净。
    //   改回 `true` 即恢复原行为（没填好时显示蓝色引导卡）。
    //   ⚠️ 「查询失败 / 铁证重复 / 同名 / 相似 / 查到结果」这 5 张卡**不受影响**，照常显示。
    showDupIdle: false,
    // 🔧 防重调试（2026-09-29 加 / ⭐ 2026-10-02 **已从界面移除**）
    //   ⚠️ 2026-10-02：`newshop.wxml` 里的调试面板（.dupdbg）**已删除**，wxss 里的死样式也清了 ——
    //      所以现在把下面的 `showDupDebug` 改成 `true` **不会**让面板回来
    //      （要恢复得从 git 历史取回那段 wxml）。
    //      保留 `showDupDebug` + `_dbg()` 只为让打点逻辑完整，且默认 early-return、零开销。
    //   dupDbgRuns = doDup 执行了几次；dupDbgEvts = 最近 4 个事件（用来判定 tap/blur 顺序）
    showDupDebug: false,
    dupDbgRuns: 0, dupDbgEvts: [],
    // ⚠️ 附近店多到 300 条上限（可能还有没扫到的）→ 结果区补一句提醒
    dupTruncated: false,
    // ===== 提交 =====
    busy: false, doneShow: false, doneName: '', doneId: '',
    mainTxt: '下一步 ›',              // 底部主按钮文案（第 4 步=「提交」；编辑模式=「保存」）
    // ===== 编辑模式（⭐ 2026-09-29：从「我的 → 我新加的店」点卡片进来，带 ?id=xxx）=====
    editMode: false, editId: ''
  },

  onLoad(options) {
    this._buildCat();
    this._goto(1, true);                 // 从第 1 步（定位）开始
    const id = (options && options.id) || '';
    if (id) {
      // ⭐ 编辑模式（老板 2026-09-29 定：点卡片进去能改，改完**直接生效**）
      this.setData({ editMode: true, editId: id });
      wx.setNavigationBarTitle({ title: '修改这家店' });
      this._loadForEdit(id);
    } else {
      // 新建：老板 2026-09-29 定，进页面**自动手机定位一次**（拿到只是"候选"，不自动采用）
      this.locateNow();
    }
  },

  // ===================== 🪜 四步导航（⭐ 2026-09-29 新增） =====================
  //   每一步都挡：没填完不让「下一步」；按钮的灰/亮由 canNext 控制。
  //   ⚠️ 只切显示、**不销毁**（wxml 用 hidden）—— 输入框内容、地图状态都不会丢。
  //   返回 null = 放行；返回字符串 = 拦截原因（toast 出去）。
  _blk(n) {
    const d = this.data;
    if (n >= 2) {                                      // 进第 2 步：必须已采用一个点位
      if (!d.adopted) return '还没定位置：先点一个「✓ 采用」（手机 / 卫星 / 微调 都行）';
      if (d.mode === 'capturing') return '还在采点：先点「⏹ 停止」';
      if (d.mode === 'tuning') return '微调还没落定：先点「✓ 采用微调」';
    }
    if (n >= 3) {   // 进第 3 步：店名 + 联系人 + 电话 + 地址
      // ⭐ 2026-10-02 老板定：**联系人和电话也改成必填**（原来只有店名 / 地址必填）——
      //   电话是查重的关键（同号 = 铁证），不填就查不准；联系人是后续跟进要用的。
      if (!String(d.name || '').trim()) return '请填店名';
      if (!String(d.contact || '').trim()) return '请填联系人（老板 / 店长怎么称呼）';
      if (!String(d.phone || '').trim()) return '请填电话（防重复建店靠它，填了才查得准）';
      if (!String(d.address || '').trim()) return '请填地址';
      if (d.blk) return '这家店已经在客户库里了，不用再建';
    }
    return null;                                       // 第 3、4 步没有别的必填
  },
  // 切换步骤（silent=true 只切不校验 —— 用于初始化、返回上一步）
  _goto(n, silent) {
    n = Math.max(1, Math.min(4, Number(n) || 1));
    if (!silent) {
      for (let k = this.data.step + 1; k <= n; k++) {  // 往前走就逐级校验
        const r = this._blk(k);
        if (r) { api.toast(r); return false; }
      }
    }
    this.setData({ step: n, stepName: STEP_NAMES[n - 1] || '' });
    this._refresh();
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
    return true;
  },
  prevStep() { this._goto(this.data.step - 1, true); },
  nextStep() {
    const d = this.data;
    if (d.step === 4) return this.submit();             // 最后一步的按钮 = 提交
    if (!d.canNext) { const r = this._blk(d.step + 1); if (r) api.toast(r); return; }
    this._goto(d.step + 1);
  },

  // ===================== ✏️ 编辑模式：预填已提交的店（⭐ 2026-09-29 新增） =====================
  //   老板定：从「我的 → 我新加的店」点卡片进来，能改内容，改完**直接生效**。
  //   坐标：把已存的位置挂到**微调**那一档并直接采用 —— 语义最贴（这是"已经定下来的点"），
  //         业务员照样能重新点手机定位 / 北斗采点 / 微调来换。
  async _loadForEdit(id) {
    wx.showLoading({ title: '加载中…', mask: true });
    try {
      const r = await api.call('tasks', { action: 'newShopDetail', id: id });
      if (!r || !r.ok) throw new Error((r && r.msg) || '加载失败');
      const s = r.shop || {};
      const set = {
        editMode: true, editId: id,
        name: s.name || '', phone: s.phone || '', address: s.address || '',
        phone2: s.phone2 || '', phone2Open: !!s.phone2,   // ⭐ 2026-10-02：带出第二个电话（有就自动展开输入框）
        contact: s.contactName || '', bizCircle: s.bizCircle || '',
        dishRaw: (s.dishes || []).join('、'), dishes: s.dishes || [],
        wish: s.mallWish || '', note: s.note || '',
        cat1: s.cat1 || '', cat2: s.cat2 || '', cat3: s.cat3 || '',
        catText: [s.cat1, s.cat2, s.cat3].filter(Boolean).join(' · '),
        lat: s.lat || '', lng: s.lng || '', wgsLat: s.wgsLat || '', wgsLng: s.wgsLng || '',
        tunLat: s.lat || '', tunLng: s.lng || '', tunOn: !!s.lat,
        adopted: s.lat ? 'tune' : '',
        mapLat: s.lat || '', mapLng: s.lng || ''
      };
      // 营业时间（存的是 "08:00-21:00"；对不上就保留默认值）
      const hm = String(s.hours || '').match(/^(\d{1,2}):00\s*-\s*(\d{1,2}):00$/);
      if (hm) {
        const i1 = Number(hm[1]), i2 = Number(hm[2]);
        if (HOUR_LIST[i1]) { set.hour1 = HOUR_LIST[i1]; set.hourIdx1 = i1; }
        if (HOUR_LIST[i2]) { set.hour2 = HOUR_LIST[i2]; set.hourIdx2 = i2; }
      }
      // 区域
      if (s.area) { set.area = s.area; set.areaIdx = Math.max(0, AREA_LIST.indexOf(s.area)); }
      // 服务与设施 → facSel + facGroups（**两处都要给**，否则胶囊不会点亮）
      const facSel = {};
      (s.fac || []).forEach(v => {
        const gi = FAC_GROUPS.findIndex(g => g.items.indexOf(v) >= 0);
        if (gi < 0) return;
        const k = FAC_GROUPS[gi].key;
        facSel[k] = facSel[k] || {};
        facSel[k][v] = 1;
      });
      set.facSel = facSel;
      set.facGroups = FAC_GROUPS.map(g => ({
        key: g.key, title: g.title,
        items: g.items.map(v => ({ v: v, on: !!(facSel[g.key] && facSel[g.key][v]) }))
      }));
      // 照片：库里存的是 fileID（cloud://…），小程序能直接当 src 显示
      const ph = (s.photos || []).slice(0, 3).map(x => x || '');
      while (ph.length < 3) ph.push('');
      set.photos = ph;
      const ids = (s.photos || []).slice(0, 3).map(x => x || '');
      while (ids.length < 3) ids.push('');
      set.photoIds = ids;
      // 录音：只留档（已去掉转写）→ 列出来能试听、能删
      set.recs = (s.audios || []).filter(a => a && a.fileID).map((a, i) => ({
        id: 'saved' + i, fileID: a.fileID, sec: a.duration || 0,
        secText: media.fmtSec(a.duration || 0), saved: true
      }));
      this.setData(set, () => { this._mks(); this._recSum(); this._refresh(); });
    } catch (e) {
      api.toast((e && e.message) || '加载失败');
      setTimeout(() => wx.navigateBack(), 900);
    }
    wx.hideLoading();
  },
  onUnload() {
    this._dead = true;
    this._stopRecTicker();                                   // ⚠️ 录音计时器必须清，否则离开页面还在跑
    try { if (this.cap) this.cap.destroy(); } catch (e) { /* 静默 */ }
    try { if (this.rec && this.data.recOn) this.rec.stop(); } catch (e) { /* 静默 */ }
    try { media.stopPath(); } catch (e) { /* 静默 */ }
  },

  // ===================== 🗺 地图上的三个点 =====================
  //   ⭐ 被采用的：正常大小、全色；另外两个：alpha .45（= 50% 半透明，一眼看清用了哪个）
  //   ⚠️ 微调中的"候选"**不画成 marker** —— 由地图正中的红图钉（页内 .cmap-pin）表示，
  //      这样"已定下的红点"能留在原地不动、候选在正中，两个点各司其职（老板 2026-09-29 要的）。
  _mks() {
    const d = this.data;
    const a = (k) => (d.adopted && d.adopted !== k) ? 0.45 : 1;
    const sz = (k) => (d.adopted === k ? MARK_BIG : MARK);   // 被采用的 26 / 其余 22
    const ms = [];
    if (d.phoneLat) ms.push({
      id: 1, latitude: Number(d.phoneLat), longitude: Number(d.phoneLng),
      iconPath: ICON.phone, width: sz('phone'), height: sz('phone'), alpha: a('phone'), anchor: { x: .5, y: .5 }
    });
    const gLat = d.mode === 'capturing' ? d.pendLat : d.gpsLat;
    const gLng = d.mode === 'capturing' ? d.pendLng : d.gpsLng;
    if (gLat) ms.push({
      id: 2, latitude: Number(gLat), longitude: Number(gLng),
      iconPath: ICON.gps, width: sz('gps'), height: sz('gps'), alpha: a('gps'), anchor: { x: .5, y: .5 }
    });
    // 微调点（**已定下的那个**）—— 微调中也照常显示，留在原地不动
    if (d.tunLat) ms.push({
      id: 3, latitude: Number(d.tunLat), longitude: Number(d.tunLng),
      iconPath: ICON.tune, width: sz('tune'), height: sz('tune'), alpha: a('tune'), anchor: { x: .5, y: .5 }
    });
    // ⚠️⚠️ 微调模式**绝对不许改地图中心**（2026-09-29 老板真机报的 bug）：
    //   用户拖地图 → 地图触发 regionchange → setData → 回调 _mks() →
    //   这里如果再设一次中心 → **地图被拉回去** → 红点看着"跳回"、用户怎么拖都白费。
    //   所以：**微调中只更新 markers，一个字的视野都不动**。
    const set = { markers: ms };
    if (d.mode !== 'tuning') {
      // 非微调：地图中心优先"采用的那个"，其次北斗卫星，再次手机（视野总停在有意义的地方）
      set.mapLat = d.lat || d.gpsLat || d.phoneLat || '';
      set.mapLng = d.lng || d.gpsLng || d.phoneLng || '';
    }
    this.setData(set);
  },

  // 取地图当前中心（兜底用）
  _center() {
    return new Promise((ok) => {
      try {
        const ctx = wx.createMapContext('gmap', this);
        ctx.getCenterLocation({ success: (r) => ok({ lat: r.latitude, lng: r.longitude }), fail: () => ok(null) });
      } catch (e) { ok(null); }
    });
  },

  // ===================== 📍 采用某个来源 =====================
  //   三个"采用"按钮都走这里；**同时把最终坐标、查重、区域识别一起更新**
  _adopt(src) {
    const d = this.data;
    let lat = '', lng = '', wgsLat = '', wgsLng = '';
    if (src === 'phone') { if (!d.phoneLat) return; lat = d.phoneLat; lng = d.phoneLng; }
    else if (src === 'gps') { if (!d.gpsLat) return; lat = d.gpsLat; lng = d.gpsLng; wgsLat = d.gpsWgsLat || ''; wgsLng = d.gpsWgsLng || ''; }
    else if (src === 'tune') { if (!d.tunLat) return; lat = d.tunLat; lng = d.tunLng; }
    else return;
    // ⭐ 采用任何来源都**先把微调模式收掉**（mode='idle'）——
    //   否则地图仍然"可拖"（enable-scroll 跟着 mode）、regionchange 继续生效，
    //   已采用的那个点会被下一次拖动改掉（老板 2026-09-29 报："点了采用微调，再动地图，确定的点又跟着跑"）。
    this.setData({ mode: 'idle', adopted: src, lat: lat, lng: lng, wgsLat: wgsLat, wgsLng: wgsLng,
      tunCandLat: '', tunCandLng: '' }, () => {
      this._mks();
      this._refresh();
    });
    try { wx.vibrateShort({ type: 'light' }); } catch (e) { /* 静默 */ }
    this.doDup(true);                 // ⭐ 静默跑一次：只自动填区域/商圈（撞车也会拦），但不弹结果卡
  },
  adoptPhone() { this._adopt('phone'); },
  adoptGps() { this._adopt('gps'); },
  // 「✓ 采用微调」：把**当前候选**（= 地图中心）落成 tunLat，再采用它
  async adoptTune() {
    const d = this.data;
    if (d.mode !== 'tuning') return;
    let lat = d.tunCandLat, lng = d.tunCandLng;
    if (!lat) {                                    // 没拖动过 / 事件没给 → 用地图中心兜底
      const c = await this._center();
      if (!c) return api.toast('还没取到地图中心：拖一下地图再点');
      lat = Number(c.lat).toFixed(6); lng = Number(c.lng).toFixed(6);
    }
    this.setData({ tunOn: true, tunLat: lat, tunLng: lng }, () => this._adopt('tune'));
  },

  // ===================== 📱 坐标 1：手机定位 =====================
  locateNow() {
    if (this.data.locBusy) return;
    if (this.data.mode === 'tuning') return api.toast('先退出微调，再重新定位');
    this.setData({ locBusy: true });
    wx.getLocation({
      type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 6000,
      success: (r) => {
        if (this._dead) return;
        this.setData({
          locBusy: false, phoneOn: true,
          phoneLat: Number(r.latitude).toFixed(6),
          phoneLng: Number(r.longitude).toFixed(6),
          phoneAcc: '约 ' + Math.round(r.accuracy || 0) + ' 米'
        }, () => this._mks());
      },
      fail: () => {
        if (this._dead) return;
        this.setData({ locBusy: false });
        api.toast('定位失败：请检查定位权限，或改用「📡 北斗卫星」');
      }
    });
  },

  // ===================== 📡 坐标 2：北斗卫星 采点 =====================
  //   ⚠️ 采点中**只写 pend\***（候选），**不碰 gpsLat/gpsLng** —— 必须点「✓ 采用卫星」才算数
  _ensureCap() {
    if (this.cap) return this.cap;
    this.cap = new GpsCapture({
      deviceNameKey: 'xinghewei',
      onStatus: (s) => { if (!this._dead) this.setData({ gpsText: s.text || '' }); },
      onProgress: (p) => {
        if (this._dead) return;
        const set = { gpsSummary: p.summary || '' };
        if (p.gcjLat) { set.pendLat = Number(p.gcjLat).toFixed(6); set.pendLng = Number(p.gcjLng).toFixed(6); }
        if (p.lat) { set.pendWgsLat = Number(p.lat).toFixed(6); set.pendWgsLng = Number(p.lng).toFixed(6); }
        const wasStable = this.data.pendStable;
        set.pendStable = !!p.stable;
        this.setData(set, () => this._mks());      // 绿点跟着"候选"实时移动（这本身就是进度反馈）
        // 刚收敛那一刻：**震一下** + 提示可以采用了（老板 2026-09-29 要的）
        if (p.stable && !wasStable) {
          try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 静默 */ }
          api.toast('已收敛 —— 可以点「✓ 采用卫星」了');
        }
      },
      onError: (e) => {
        if (this._dead) return;
        this.setData({ capOn: false, mode: 'idle' });
        api.toast((e && e.message) || '采点出错，请重试');
      },
      onLog: (m) => console.log('[GPS]', m)
    });
    return this.cap;
  },
  async startCapture() {
    if (this.data.capOn) return;
    if (this.data.mode === 'tuning') return api.toast('先退出微调，再采点');
    this._checkedStable = false;
    this.setData({
      capOn: true, mode: 'capturing', gpsText: '正在搜索设备…', gpsSummary: '',
      pendLat: '', pendLng: '', pendWgsLat: '', pendWgsLng: '', pendStable: false
    }, () => this._mks());
    try {
      await this._ensureCap().start();
    } catch (e) {
      this.setData({ capOn: false, mode: 'idle' });
      api.toast('采点失败：' + ((e && e.message) || '请检查定位功能与网络'));
    }
  },
  stopCapture() {
    try { if (this.cap) this.cap.stop(); } catch (e) { /* 静默 */ }
    if (this.data.capOn) this.setData({ capOn: false, mode: 'idle', gpsText: '已停止采点' }, () => this._mks());
  },
  // 「⏹ 停止」按钮
  tapCap() { if (this.data.mode === 'capturing') this.stopCapture(); else this.startCapture(); },
  // 「✓ 采用卫星」：把"候选"（pend*）落成 gpsLat/gpsLng，并采用它
  adoptGpsCapture() {
    const d = this.data;
    if (!d.pendLat) return api.toast('还没收到位置：把设备放店门口，等十几秒');
    if (!d.pendStable) api.toast('还没收敛（可能偏几米），已按当前值采用');
    this.stopCapture();
    this.setData({
      gpsOn: true, gpsLat: d.pendLat, gpsLng: d.pendLng,
      gpsWgsLat: d.pendWgsLat || '', gpsWgsLng: d.pendWgsLng || ''
    }, () => this._adopt('gps'));
  },
  // 「✓ 采用卫星」在**已经采过**（没在采）时的入口
  adoptGpsSaved() { this._adopt('gps'); },

  // ===================== ✎ 坐标 3：手动微调 =====================
  //   ⭐ 进微调**先停采点**（否则 GPS 回调会把拖好的位置又冲掉 —— 老板报过的 bug）
  //   ⭐⭐ 关键（老板 2026-09-29 明确要求）：
  //        **不覆盖已定下的 tunLat** —— 它留在原地不动；拖动只改 tunCand*（候选），
  //        直到点「✓ 采用微调」才把候选落定。
  startTune() {
    const d = this.data;
    // 视野要"对准"的那个点：已定下的微调点 > 北斗卫星 > 手机
    const base = d.tunLat ? { lat: d.tunLat, lng: d.tunLng }
      : d.gpsLat ? { lat: d.gpsLat, lng: d.gpsLng }
      : d.phoneLat ? { lat: d.phoneLat, lng: d.phoneLng } : null;
    if (!base) return api.toast('先取一个位置（手机定位 或 北斗卫星），再微调');
    this.stopCapture();
    this.setData({
      mode: 'tuning', tunOn: true, tunDist: '',
      tunCandLat: base.lat, tunCandLng: base.lng,   // 候选初始 = 视野对准的那个点
      mapLat: base.lat, mapLng: base.lng            // 显式把视野对过去（微调中 _mks 不再改中心）
    }, () => this._mks());
  },
  cancelTune() {
    // 退出微调、放弃**这次**调整（⚠️ 已定下的 tunLat 留着不动）
    this.setData({ mode: 'idle', tunCandLat: '', tunCandLng: '', tunDist: '' }, () => this._mks());
  },
  // 微调时拖动地图 → 只更新"候选"，**不动已定下的 tunLat**
  // ⚠️ 三条纪律（都是真机 / 客户详情页换来的）：
  //   ① 优先用事件自带的 e.detail.centerLocation（最及时）；
  //   ② 低版本基础库拿不到它 → 兜底调 mapCtx.getCenterLocation()；
  //   ③ **只写 tunCand\***，绝不 setData tunLat / lat / mapLat —— 否则已定点会被改掉、或视野被拉走。
  async onRegionChange(e) {
    if (this.data.mode !== 'tuning') return;
    if (e.type && e.type !== 'end') return;
    let c = (e.detail && e.detail.centerLocation) || null;
    if (!c) c = await this._center();            // 兜底：事件没给就用地图 API 取
    if (!c) return;
    if (this.data.mode !== 'tuning') return;     // 等异步期间可能已退出微调
    const lat = Number(c.latitude !== undefined ? c.latitude : c.lat).toFixed(6);
    const lng = Number(c.longitude !== undefined ? c.longitude : c.lng).toFixed(6);
    // "挪了多远"从**起点**算：起点 = 进微调时对准的那个点（tunLat 或 首次候选）
    const from = this.data.tunLat
      ? { lat: this.data.tunLat, lng: this.data.tunLng }
      : (this.data.tunCandLat ? { lat: this.data.tunCandLat, lng: this.data.tunCandLng } : { lat: lat, lng: lng });
    const dm = this._dist(from.lat, from.lng, lat, lng);
    // ⚠️ 只写候选；**也刻意不调 _mks()** —— markers 没变，调它反而有"视野被拉走"的风险
    this.setData({
      tunCandLat: lat, tunCandLng: lng,
      tunDist: dm < 1 ? '就是这里' : (dm < 1000 ? Math.round(dm) + ' 米' : (dm / 1000).toFixed(2) + ' 公里')
    });
  },
  // 两点距离（米，haversine）
  _dist(la1, ln1, la2, ln2) {
    const R = 6371000, rad = x => Number(x) * Math.PI / 180;
    const dLa = rad(la2) - rad(la1), dLn = rad(ln2) - rad(ln1);
    const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLn / 2) * Math.sin(dLn / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  },

  // ===================== 🔍 防重检测 + 区域识别（云端） =====================
  //   ⚠️ 老板 2026-09-29 定：**只由「🔍 防重检测」按钮触发**。
  //   ⭐ 结果区**常驻**（dupShow 恒为 true）：进第 2 步就是引导卡、点了检测才换成结果卡 ——
  //      结构上不可能"什么都不显示"。
  async doDup(silent) {
    // silent=true：**自动跑**的（进第 2 步 / 采用点位后）—— 只把区域/商圈/撞车结果收进来，
    //   ⚠️ **绝不显示任何结果卡**：那时业务员还没填店名，弹任何提示都会造成误会。
    const silentMode = !!silent;
    // 🔧 调试打点（老板 2026-09-29：不再靠猜，把真相显示到界面上）
    this._dbg(silentMode ? 'doDup(自动)' : 'doDup(手动)');
    if (this.data.showDupDebug) this.setData({ dupDbgRuns: (this.data.dupDbgRuns || 0) + 1 });   // ⭐ 面板隐藏时不必数
    const { lat, lng, name, phone, sameIgnored } = this.data;
    // ⚠️⚠️ 2026-09-29 修（"点了按钮什么反应都没有"的第二层原因）：
    //   进第 2 步时 `_adopt` 会自动跑一次静默检测；如果那次**还没回来**、而业务员已经填好
    //   并点了按钮 —— 原来的 `if (dupBusy) return;` 会**静默挡掉**这次点击（一点提示都没有）。
    //   现在分开处理：
    //     · 手动点（silentMode=false）：**允许打断/重跑**，不受自动那次影响
    //     · 自动跑（silentMode=true）：忙就直接跳过（它本来也不需要）
    if (this.data.dupBusy && silentMode) return;

    // ---- 前置条件不满足 ----
    // ⚠️⚠️ 2026-09-29 修（老板报"进第 2 步就看到红卡『附近没查成』"）：
    //   根因 = 自动跑的那次（silent）也设了 dupShow，而那时店名是空的 → 弹了红卡。
    //   现在：**silent 一律静默**；手动点按钮但没填 → **给引导提示，不报错**。
    if (!lat || !lng) {
      if (silentMode) return;
      this.setData({ dupShow: true, dupChecked: false, dupErr: '', dupTip: 'noCoord' });
      return;
    }
    if (!String(name || '').trim() && !String(phone || '').trim()) {
      if (silentMode) return;
      // 还没填 → **引导**（不是错误）：告诉业务员该怎么填、填完点哪个按钮
      this.setData({ dupShow: true, dupChecked: false, dupErr: '', dupTip: 'needInput' });
      return;
    }

    if (!silentMode) this.setData({ dupTip: '' });   // 手动点：先把引导卡收起来
    this.setData({ dupBusy: true });
    try {
      const r = await api.call('tasks', {
        action: 'newShopCheck', lat: Number(lat), lng: Number(lng), name, phone,
        excludeId: this.data.editId || ''      // ⚠️ 编辑模式：把自己排除，免得"改完点检测"报自己
      });
      if (!r || !r.ok) {
        if (silentMode) { this.setData({ dupBusy: false }); return; }
        this.setData({ dupBusy: false, dupShow: true, dupChecked: false, dupErr: (r && r.msg) || '检测失败' });
        return;
      }
      const set = {
        dupBusy: false, dupChecked: true,        // ⚠️ 必须复位，否则按钮永远停在「对比中…」
        dupShow: silentMode ? this.data.dupShow : true,
        dupTip: '',                              // 有结果了，引导卡收起来
        checked: true,
        cands: r.cands || [],
        blk: r.block || null,
        same: sameIgnored ? null : (r.sameName || null),
        // ⭐ 2026-09-29：疑似重复（店名高度相似 / 电话近似）—— **只预警、不拦**
        near: r.suspect || null,
        // ⚠️ 附近查询失败的原因（以前云端吞掉了 → "毫无反应"；现在带上来用红卡显示）
        dupErr: r.dupErr || '',
        // ⚠️ 附近店多到 300 条上限了（可能还有没扫到的）→ 结果区补一句提醒
        dupTruncated: !!r.dupTruncated
      };
      // 区域/商圈：**只填还空着的**（业务员手动改过就不覆盖）
      if (!this.data.area && r.area) set.area = r.area;
      if (!this.data.bizCircle && r.bizCircle) set.bizCircle = r.bizCircle;
      if (r.area) set.areaIdx = Math.max(0, AREA_LIST.indexOf(this.data.area || r.area));
      // 录音档位来自后台设置（新店页没有任务，只能从云端带回来）
      if (r.recLimit) set.recLimit = r.recLimit;
      if (r.recEnabled !== undefined) set.recEnabled = !!r.recEnabled;
      this.setData(set);
      this._refresh();
    } catch (e) {
      // ⚠️ 手动点的时候要看得见（只 toast 会一闪而过，在用户眼里就是"没反应"）；
      //    自动跑的时候静默（否则一进第 2 步就弹红卡）。
      if (!silentMode) {
        this.setData({ dupShow: true, dupChecked: false, dupErr: '检测请求失败：' + ((e && e.message) || '请重试') });
      }
    } finally {
      // ⚠️ 兜底 1：不管走哪条路（成功 / 返回错误 / 抛异常），dupBusy 都必须复位。
      //    2026-09-29 老板报"按了防重检测就一直显示对比中"——根因就是成功那条路漏了复位。
      if (this.data.dupBusy) this.setData({ dupBusy: false });

      // ⚠️⚠️ 兜底 2【老板 2026-09-29 定的铁律】：
      //   **手动点了一次检测，就必须有一张卡出来** —— 绿 / 黄 / 红总得有一个；
      //   什么都不出来 = 代码里有没覆盖到的分支。这里做最后一道保险：
      //   跑完发现「没有卡」或者「连 dupShow 都没设上」，就强制显示一张诊断卡。
      if (!silentMode) {
        const d = this.data;
        const hasCard = !!(d.dupTip || d.dupErr || d.blk || d.same || d.near || d.dupChecked);
        if (!d.dupShow || !hasCard) {
          this.setData({
            dupShow: true, dupChecked: false,
            dupErr: '检测已跑完，但没有拿到任何结果（兜底提示：说明有分支没覆盖，请把它发给管理员）'
          });
        }
      }
    }
  },

  // ===================== 🎙 录音（选填） =====================
  _recorder() {
    if (!this.rec) this.rec = media.createRecorder();
    return this.rec;
  },
  _recUsed() { return (this.data.recs || []).reduce((s, r) => s + (r.sec || 0), 0); },
  async toggleRec() {
    const d = this.data;
    if (d.recOn) { this._recorder().stop(); return; }              // 再点一下 = 停
    if (!d.recEnabled) return api.toast('后台已关闭录音');
    if ((d.recs || []).length >= MAX_SEG) return api.toast('最多录 ' + MAX_SEG + ' 段');
    const used = this._recUsed();
    if (used >= MAX_TOTAL_SEC) return api.toast('录音合计已到 30 分钟上限');
    const limit = Math.max(5, Math.min(d.recLimit || 300, MAX_TOTAL_SEC - used));   // 本次可录的最长秒数
    this._curLimit = limit;
    this.setData({ recOn: true, curSec: 0, curText: '00:00' });
    // ⚠️⚠️ 2026-09-29 修复（老板报"按下录音后正在录音的计时不动"）：
    //   utils/media.js 的 createRecorder **不会每秒回调** —— onStart 只是把内部 state 改成 'rec'，
    //   只有 onStop 才调一次回调。所以"每秒刷新计时"和"到上限自动停"必须**自己起定时器** ——
    //   照拜访页 visit.js 的 _recTicker 做法来（那边一直是这么干的，新店页当初漏了）。
    this._recSec = 0;
    clearInterval(this._recTicker);
    this._recTicker = setInterval(() => {
      if (this._dead || !this.data.recOn) return;
      this._recSec++;
      this.setData({ curSec: this._recSec, curText: media.fmtSec(this._recSec) });
      if (this._recSec >= limit) this._recorder().stopAtLimit();     // 到本次上限自动停
    }, 1000);
    this._recorder().start(
      limit,
      null,                                                          // 每秒回调交给上面的定时器
      (path, dur) => this._recDone(path, dur),                       // 录完
      (msg) => {                                                     // 录音失败
        this._stopRecTicker();
        this.setData({ recOn: false });
        api.toast(msg || '录音失败，请重试');
      }
    );
  },
  _stopRecTicker() { clearInterval(this._recTicker); this._recTicker = null; },
  async _recDone(path, dur) {
    this._stopRecTicker();                                           // ⚠️ 先停计时器，免得还在跑
    this.setData({ recOn: false });
    if (!path) { api.toast('没录到声音，请重试'); return; }
    const sec = Math.max(1, Math.round(dur || this.data.curSec || 0));
    this.setData({ recBusy: true });
    try {
      // ⚠️ saveFile 是**移动**（试听后 tmp 会失效）→ 上传前必须先转存拿持久路径
      const p = await this._recorder().getUploadPath();
      const fileID = await media.uploadFile(p, this._recorder().uploadExt);
      // ⚠️ 老板 2026-09-29：**不要转文字**了 —— 只留档（fileID + 秒数），不勾转写
      const recs = (this.data.recs || []).slice();
      recs.push({ id: 'r' + Date.now(), path: p, sec: sec, fileID: fileID, secText: media.fmtSec(sec) });
      this.setData({ recs: recs, recBusy: false, curSec: 0, curText: '00:00' });
      this._recSum();
    } catch (e) {
      this.setData({ recBusy: false });
      api.toast('录音上传失败，请重试');
    }
  },
  _recSum() {
    const used = this._recUsed();
    this.setData({ recSecs: used, recTotal: media.fmtSec(used) });
  },
  // 试听 / 停（共用一颗播放器 → 同一时刻只播一条）
  // ⚠️ 编辑模式（_loadForEdit）里的录音**只有云文件 ID、没有本机路径** → 先换临时链接再播
  async playRec(e) {
    const id = e.currentTarget.dataset.id;
    const r = (this.data.recs || []).find(x => x.id === id);
    if (!r) return;
    if (this.data.playingId === id) { media.stopPath(); this.setData({ playingId: '' }); return; }
    let src = r.path || '';
    if (!src && r.fileID) {
      try {
        const urls = await media.getTempURLs([r.fileID]);
        const u = (urls && urls[0]) || '';
        src = (typeof u === 'string') ? u : (u.tempFileURL || '');
      } catch (er) { src = ''; }
    }
    if (!src) return api.toast('这段录音读不出来（可能已过期）');
    this.setData({ playingId: id });
    media.playPath(src, () => this.setData({ playingId: '' }));
  },
  delRec(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.playingId === id) { try { media.stopPath(); } catch (er) { /* 静默 */ } }
    const recs = (this.data.recs || []).filter(x => x.id !== id);
    this.setData({ recs: recs, playingId: '' });
    this._recSum();
  },
  // ⚠️ 2026-09-29 老板要求去掉「录音转文字」→ 原 transcribe() 方法已整段删除（同步删掉 utils 里对应引用）

  // ===================== 表单 =====================
  onName(e) { this.setData({ name: e.detail.value }); this._refresh(); },
  // ⚠️⚠️ 2026-09-29 修【真凶】：老板报"点了防重检测什么都不出来（绿黄红都没有）"。
  //   根因就在原来这行 `dupShow: false` —— 点按钮那一刻，店名输入框会**失焦**，
  //   而移动端 blur 往往**晚于 tap** 触发 → doDup 刚把结果显示出来，紧接着就被这里清掉。
  //   现在：店名一改只把**结果收回成引导态**，⚠️ **绝不隐藏结果区**（结果区是常驻的）。
  onNameBlur() {
    this._dbg('blur(店名)');                        // 🔧 打点：验证是不是 blur 抢在 tap 后面
    if (!this.data.dupChecked) return;              // 还没查过 → 什么都不用做
    this.setData({
      dupChecked: false, blk: null, same: null, near: null, dupErr: '',
      dupTip: this.data.adopted ? 'needInput' : 'noCoord'
    });
  },
  onPhone(e) { this.setData({ phone: e.detail.value }); },
  // ⭐ 2026-10-02 老板定：**第二个电话（最多两个）** —— 电话行右侧浅灰 ⊕ / ✕
  onPhone2(e) { this.setData({ phone2: e.detail.value }); },
  addPhone2() { this.setData({ phone2Open: true }); },
  delPhone2() { this.setData({ phone2Open: false, phone2: '' }); },
  onAddress(e) { this.setData({ address: e.detail.value }); this._refresh(); },
  onContact(e) { this.setData({ contact: e.detail.value }); },
  // 营业时间：两个**整点** picker（老板 2026-09-29 定；默认 08:00 — 21:00）
  onHour1(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ hourIdx1: i, hour1: HOUR_LIST[i] || '08:00' });
  },
  onHour2(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ hourIdx2: i, hour2: HOUR_LIST[i] || '21:00' });
  },
  // 招牌菜：自由输入，「、，；」隔开 → 实时拆成数组（提交时写入）
  onDish(e) { this.setData({ dishRaw: e.detail.value, dishes: splitDishes(e.detail.value) }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  onArea(e) {
    const i = Number(e.detail.value);
    this.setData({ areaIdx: i, area: AREA_LIST[i] || '' });
  },
  onBiz(e) { this.setData({ bizCircle: e.detail.value }); },
  pickBiz(e) { this.setData({ bizCircle: e.currentTarget.dataset.biz || '' }); },
  // 「不是，继续建」：把同名 / 疑似两条一起收起来（sameIgnored 让它本次不再提示同名）
  ignoreSame() { this.setData({ same: null, near: null, sameIgnored: true }); },
  pickWish(e) { this.setData({ wish: e.currentTarget.dataset.v || '' }); },

  // 品类三级联动（大类 → 中类 → 小类；词表来自 words.json）
  _buildCat() {
    const cat = WORDS.cat || {};
    // ⭐ 2026-10-02：词表已按老板定稿的 5 大类重写（原「购物」大类在新表里本来就不存在），
    //   所以这里不再需要 SKIP_CAT 过滤 —— 直接取全部大类。
    const c1 = Object.keys(cat);
    const c2 = c1.length ? Object.keys(cat[c1[0]] || {}) : [];
    const c3 = (c1.length && c2.length) ? ((cat[c1[0]] || {})[c2[0]] || []) : [];
    this._cat = cat;
    this.setData({ catRange: [c1, c2, c3], catIdx: [0, 0, 0] });
  },
  // ===== 原生 picker 的三级联动（⭐ 2026-10-02 **恢复**：自绘滚轮「方案 A」放弃，改回 multiSelector）=====
  //   ⚠️ 下面那一整段 pk* 是方案 A 的遗留**死代码**（wxml 已不再引用它），留着不碍事；
  //     以后要清理，从 `pkOpen()` 删到 `_pkSnap()` 结束即可，其余代码不受影响。
  onCatCol(e) {
    const col = Number(e.detail.column), val = Number(e.detail.value);
    const cat = this._cat || {};
    const c1 = this.data.catRange[0];
    let c2 = this.data.catRange[1], c3 = this.data.catRange[2];
    const idx = (this.data.catIdx || [0, 0, 0]).slice();
    idx[col] = val;
    if (col === 0) {
      c2 = Object.keys(cat[c1[val]] || {});
      c3 = c2.length ? ((cat[c1[val]] || {})[c2[0]] || []) : [];
      idx[1] = 0; idx[2] = 0;
    } else if (col === 1) {
      c3 = ((cat[c1[idx[0]]] || {})[c2[val]] || []);
      idx[2] = 0;
    }
    // ⭐ 2026-10-03 老板定（**滚动即写**）：不依赖"确定"按钮，滚到哪就把值写进去。
    //   背景（老板报障）：4 家「加新店」建的店品类全是空 —— 微信原生 picker 的 `bindchange`
    //   **只在点右上角"确定"时才触发**，用户滚了滚轮但没点确定 → cat1/cat2/cat3 一直是初值 ''。
    //   现在滚动（bindcolumnchange）就同步写；点"确定"时 onCat 仍会再写一次（同值覆盖），互不冲突。
    this.setData({
      catRange: [c1, c2, c3], catIdx: idx,
      catText: [c1[idx[0]], c2[idx[1]], c3[idx[2]]].filter(Boolean).join(' · '),
      cat1: this._plainCat(c1[idx[0]]), cat2: c2[idx[1]] || '', cat3: c3[idx[2]] || ''
    });
  },
  // ⭐ 2026-10-02 老板定（选 A）：**滚轮里显示带图标，写进库的 cat1 不带图标** ——
  //   词表大类名形如「🍚 美食餐饮」，这里把开头的 emoji/符号剥掉再存。
  //   好处：后台客户列表、按品类筛选、以后的统计口径都是干净的中文。
  //   ⚠️ 用「码点数组 + 判首字符」而不是 u-flag 正则，避免个别老基础库不认。
  _plainCat(s) {
    const a = Array.from(String(s || ''));
    let i = 0;
    while (i < a.length && !/[\u4e00-\u9fa5A-Za-z0-9]/.test(a[i])) i++;
    return a.slice(i).join('').trim();
  },
  onCat(e) {
    const v = (e.detail.value || []).map(Number);
    const [c1, c2, c3] = this.data.catRange;
    this.setData({
      catIdx: v,
      // catText 只用于界面显示 → **保留图标**
      catText: [c1[v[0]], c2[v[1]], c3[v[2]]].filter(Boolean).join(' · '),
      // 三个存库值 → **大类去掉图标**（中类/小类本来就没有）
      cat1: this._plainCat(c1[v[0]]), cat2: c2[v[1]] || '', cat3: c3[v[2]] || ''
    });
  },

  // ===== ⭐ 自绘三级滚轮（2026-10-02「方案 A」**已弃用** —— 下面全是死代码）=====
  //   ⚠️ PK_ROW 必须与 wxss 的 .pk-i height 一致（当前 30px）
  //   存库字段**没变**：确定时才写 cat1 / cat2 / cat3（+ catText 只用于显示）
  pkOpen() {
    const idx = (this.data.catIdx || [0, 0, 0]).slice();
    this._tops = idx.map(v => v * PK_ROW);             // 实例变量：滚动中的实时位置（不 setData，免得卡）
    this.setData({ pkShow: true, pkTmp: idx.slice(), pkHi: idx.slice(), catTop: idx.map(v => v * PK_ROW) });
  },
  pkCancel() { this.setData({ pkShow: false }); },
  pkOk() {
    const v = (this.data.pkTmp || [0, 0, 0]).slice();
    const [c1, c2, c3] = this.data.catRange;
    this.setData({
      pkShow: false, catIdx: v,
      catText: [c1[v[0]], c2[v[1]], c3[v[2]]].filter(Boolean).join(' · '),
      cat1: this._plainCat(c1[v[0]]), cat2: c2[v[1]] || '', cat3: c3[v[2]] || ''
    });
  },
  // 滚动中只记位置，绝不 setData（否则每帧重渲染会卡）
  pkScroll(e) {
    const c = Number(e.currentTarget.dataset.col);
    if (!this._tops) this._tops = [0, 0, 0];
    this._tops[c] = Number(e.detail.scrollTop) || 0;
    // ⚠️ 这里**只更新 pkHi（高亮）**，绝不碰 pkTmp ——
    //   pkTmp 一变就会牵动"后两列重算"，滚动中频繁触发会让中类/小类错位。
    const gi = Math.max(0, Math.round(this._tops[c] / PK_ROW));
    const hi = this.data.pkHi || [0, 0, 0];
    if (hi[c] !== gi) {
      const nh = hi.slice(); nh[c] = gi;
      this.setData({ pkHi: nh });
    }
    // ⭐⭐ 2026-10-02 老板要"强烈吸附、绝不停在半行上"：
    //   在 scroll 事件里做「**停住检测**」—— **150ms 内没有新的 scrollTop 就认定停了** → 吸附。
    //   ⚠️ 只靠 touchend 不够：手指离开后惯性还会继续滚，滚动中会把我设的对齐值冲掉 → 停在半行。
    if (!this._snapT) this._snapT = [null, null, null];
    clearTimeout(this._snapT[c]);
    this._snapT[c] = setTimeout(() => this._pkSnap(c), 150);
  },
  // 手指离开 → 延时一下（等惯性滚完）再吸附
  pkEnd(e) {
    clearTimeout(this._pkT);
    this._pkT = setTimeout(() => this._pkSnap(Number(e.currentTarget.dataset.col)), 120);
  },
  // 点某一项 → 直接选中并滚到正中
  pkPick(e) {
    const c = Number(e.currentTarget.dataset.col), i = Number(e.currentTarget.dataset.i);
    if (!this._tops) this._tops = [0, 0, 0];
    this._tops[c] = i * PK_ROW;
    const ct = (this.data.catTop || [0, 0, 0]).slice();
    ct[c] = i * PK_ROW;
    this.setData({ catTop: ct });
    this._pkSnap(c);
  },
  noop() { },
  // 吸附到最近一行 + 联动后两列（**规则与原来的 onCatCol 完全一致**：改大类→重置中/小类；改中类→重置小类）
  _pkSnap(col) {
    const ct = (this.data.catTop || [0, 0, 0]).slice();
    const tmp = (this.data.pkTmp || [0, 0, 0]).slice();
    const raw = Number((this._tops || [0, 0, 0])[col]) || 0;
    const gi = Math.max(0, Math.round(raw / PK_ROW));
    // ⭐ 2026-10-02 老板要"像原生那样咯噔一下"：**每次换行轻震一次**
    //   （微信原生 picker 的那声"咯噔"就是短震动；小程序端放不了声音，只能震动。
    //    真机上有没有感觉，取决于系统"触感反馈"设置和机型。）
    if (gi !== (this.data.pkTmp || [])[col]) {
      try { wx.vibrateShort({ type: 'light' }); } catch (e) { /* 不支持就忽略 */ }
    }
    tmp[col] = gi;
    const set = { pkTmp: tmp, pkHi: tmp.slice() };   // ⚠️ 吸附后把"高亮"也对齐到这一行
    // ⚠️⚠️ 微信的坑：`scroll-top` 设成"与当前值相同"时**不生效**（不会真的滚过去）——
    //   强吸附必须精确落位，所以**先设 target+1、下一帧再设 target**，保证一定滚到位。
    const target = gi * PK_ROW;
    ct[col] = target + 1;
    set.catTop = ct.slice();
    const ct2 = ct.slice(); ct2[col] = target;
    setTimeout(() => this.setData({ catTop: ct2 }), 0);
    if (col < 2) {
      const cat = this._cat || {};
      const c1 = this.data.catRange[0];
      let c2 = this.data.catRange[1], c3 = this.data.catRange[2];
      if (col === 0) {
        c2 = Object.keys(cat[c1[gi]] || {});
        c3 = c2.length ? ((cat[c1[gi]] || {})[c2[0]] || []) : [];
        tmp[1] = 0; tmp[2] = 0; ct[1] = 0; ct[2] = 0;
      } else {
        c3 = ((cat[c1[tmp[0]]] || {})[c2[gi]] || []);
        tmp[2] = 0; ct[2] = 0;
      }
      this._tops[1] = ct[1]; this._tops[2] = ct[2];
      set.catRange = [c1, c2, c3]; set.catTop = ct.slice(); set.pkTmp = tmp;
    }
    this.setData(set);
  },

  // 服务与设施：多选胶囊（分组）
  toggleFac(e) {
    const g = e.currentTarget.dataset.g, v = e.currentTarget.dataset.v;
    const sel = Object.assign({}, this.data.facSel);
    const gs = Object.assign({}, sel[g] || {});
    if (gs[v]) delete gs[v]; else gs[v] = 1;
    sel[g] = gs;
    // ⚠️ 2026-09-29 老板报"服务与设施的胶囊一个也不能点选" —— 根因：
    //   老代码只对**字符串**型 item 更新 on，对**对象**型（{v, on}）直接 `return it`，
    //   而 data 里的 items 全是对象 → on 永远是 false → 点了胶囊不变色，看着像点不动。
    //   现在两种形态统一算出 on（提交用的 facSel 本来就是对的，所以数据没错、只是看不见）。
    const groups = this.data.facGroups.map(gr => {
      if (gr.key !== g) return gr;
      return Object.assign({}, gr, {
        items: gr.items.map(it => {
          const val = (typeof it === 'string') ? it : (it && it.v);
          return { v: val, on: !!gs[val] };
        })
      });
    });
    this.setData({ facSel: sel, facGroups: groups });
  },
  _facList() {
    const out = [];
    Object.keys(this.data.facSel || {}).forEach(g => {
      Object.keys(this.data.facSel[g] || {}).forEach(v => out.push(v));
    });
    return out;
  },

  // ===================== 拍照（店面照必拍） =====================
  shoot(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    wx.showActionSheet({
      itemList: ['拍照', '从相册选'],
      success: (r) => this._take(i, r.tapIndex === 0 ? 'camera' : 'album'),
      fail: () => { /* 取消 */ }
    });
  },
  async _take(i, src) {
    let files;
    try { files = await media.chooseImage(1, [src]); } catch (e) { return; }
    const f = (files || [])[0];
    if (!f || !f.tempFilePath) return;
    this.setData({ photoBusy: true });
    try {
      const r = await media.prepPhoto(f.tempFilePath);            // 压缩（原图 ≤1280/q70）
      const fileID = await media.uploadFile(r.orig.path, '.jpg'); // 直传云存储
      const photos = (this.data.photos || ['', '', '']).slice();
      const ids = (this.data.photoIds || ['', '', '']).slice();
      photos[i] = r.orig.path;      // 本机路径：当场预览用
      ids[i] = fileID;              // fileID：随提交入库
      this.setData({ photos, photoIds: ids, photoBusy: false });
      this._refresh();
    } catch (err) {
      this.setData({ photoBusy: false });
      api.toast('照片上传失败，请重试');
    }
  },

  // ===================== 🔧 防重调试（老板 2026-09-29）=====================
  //   起因：防重结果反复"什么都不显示"，而我只能靠读代码猜 —— 猜一次错一次。
  //   ⭐ 这个面板把内部状态**直接显示在界面上**，让老板自己看到真相，不用再信任我的推理。
  //   记录"最近 4 个事件"，用来判定 tap / blur / 输入的触发顺序。
  //   ⚠️ 只读展示，不影响任何业务逻辑；确认没问题后可以整块删掉。
  _dbg(evt) {
    // ⭐ 2026-09-29 老板定：面板已隐藏 → 打点一起停（省掉每次 setData；把 showDupDebug 改 true 即恢复）
    if (!this.data.showDupDebug) return;
    const t = new Date();
    const p2 = n => (n < 10 ? '0' + n : '' + n);
    const hm = p2(t.getHours()) + ':' + p2(t.getMinutes()) + ':' + p2(t.getSeconds());
    const evts = (this.data.dupDbgEvts || []).concat([hm + ' ' + evt]).slice(-4);
    this.setData({ dupDbgEvts: evts });
  },

  // ===================== 能不能往下走 / 提交 =====================
  // 底部：第 1~3 步看按钮亮/灰，第 4 步 = 「提交」（**编辑模式下叫「保存」**）
  _refresh() {
    const d = this.data;
    const base = !!(d.lat && d.adopted);
    const full = base && !!String(d.name || '').trim() && !!String(d.address || '').trim()
      && !!d.photos[0] && !d.blk;
    const ok = (d.step === 4) ? full : (this._blk(d.step + 1) === null);
    // ⭐ 编辑模式（从「我的 → 我新加的店」进来的）第 4 步按钮文案叫「保存」
    const mainTxt = (d.step === 4)
      ? (d.busy ? (d.editMode ? '保存中…' : '提交中…') : (d.editMode ? '保存' : '提交'))
      : '下一步 ›';
    const set = {};
    if (ok !== d.canNext) set.canNext = ok;
    if (mainTxt !== d.mainTxt) set.mainTxt = mainTxt;
    if (Object.keys(set).length) this.setData(set);
  },

  // ===================== 提交 =====================
  async submit() {
    if (this.data.busy) return;
    const d = this.data;
    if (!d.adopted) return api.toast('先取一个位置，再点对应的「✓ 采用」');
    if (d.mode === 'tuning') return api.toast('微调还没采用，先点「✓ 采用微调」');
    if (d.recOn) return api.toast('录音还在进行，先停一下');
    if (!d.name.trim()) return api.toast('请填店名');
    if (!d.address.trim()) return api.toast('请填地址');
    if (!d.photos[0]) return api.toast('店面照必拍：先拍一张门面照');
    if (d.blk) return api.toast('这家店已经在客户库里了');
    this.setData({ busy: true });
    try {
      const ids = (d.photoIds || []).filter(Boolean);
      // ⚠️ 不再带 text（已去掉转文字）
      const audios = (d.recs || []).filter(r => r.fileID).map(r => ({ fileID: r.fileID, duration: r.sec }));
      const r = await api.call('tasks', {
        // ⭐ 编辑模式走 updateNewShop（老板 2026-09-29 定：改完直接生效）；新建走 newShopSubmit
        action: d.editId ? 'updateNewShop' : 'newShopSubmit',
        id: d.editId || undefined,
        lat: Number(d.lat), lng: Number(d.lng),
        wgsLat: Number(d.wgsLat) || 0, wgsLng: Number(d.wgsLng) || 0,   // 只有北斗卫星才有 WGS-84 原值
        name: d.name.trim(), phone: String(d.phone || '').trim(), address: d.address.trim(),
        phone2: String(d.phone2 || '').trim(),     // ⭐ 2026-10-02：第二个电话（最多两个）→ customers.phone2
        contactName: d.contact, hours: (d.hour1 && d.hour2) ? (d.hour1 + '-' + d.hour2) : '',
        dishes: (d.dishes || []).slice(),        // ⭐ 招牌菜 → customers.platManual.dishes
        area: d.area, bizCircle: d.bizCircle,
        cat1: d.cat1, cat2: d.cat2, cat3: d.cat3,
        flags: this._flags(), fac: this._facList(),
        mallWish: d.wish, note: d.note,
        photos: ids, audios: audios
      });
      this.setData({ busy: false });
      if (!r || !r.ok) {
        if (r && r.code === 'DUP_PHONE') { this.setData({ blk: r.dup || null }); this._refresh(); }
        return api.toast((r && r.msg) || (d.editId ? '保存失败，请重试' : '提交失败，请重试'));
      }
      if (d.editId) {
        // 编辑模式：不弹"已提交"成功页，提示一下直接返回列表（列表 onShow 会自动刷新）
        api.toast('已保存 ✓');
        setTimeout(() => wx.navigateBack(), 700);
        return;
      }
      this.setData({ doneShow: true, doneName: d.name.trim(), doneId: r.customerId || '' });
    } catch (e) {
      this.setData({ busy: false });
      api.toast('提交失败，请检查网络后重试');
    }
  },
  // 第一组「外卖 / 团购」→ 提交成 flags 对象
  _flags() {
    const g = (this.data.facSel || {}).flag || {};
    return { 外卖: !!g['有外卖'], 团购: !!g['有团购'] };
  },

  goCustomer() {
    const id = this.data.doneId;
    if (!id) return wx.navigateBack();
    wx.redirectTo({ url: '/pages/customer/customer?id=' + id });
  },
  again() {
    this._stopRecTicker();                     // ⚠️ 换一家店：万一计时器还在跑，先清掉
    // ⭐「再录一家」永远回到**新建**模式（编辑模式那条路是 navigateBack，走不到这儿）
    this.setData({
      editMode: false, editId: '',
      doneShow: false, doneId: '', doneName: '',
      name: '', phone: '', address: '', contact: '', note: '',
      phone2: '', phone2Open: false,          // ⭐ 换一家店 → 第二个电话也清空（输入框默认收起）
      hour1: '08:00', hour2: '21:00', hourIdx1: 8, hourIdx2: 21,
      dishRaw: '', dishes: [],
      // ⚠️ 结果区是**常驻**的 —— 换一家店也只回到"引导态"，绝不把它藏起来
      dupShow: true, dupBusy: false, dupChecked: false, dupTip: 'needInput', dupErr: '',
      bizCircle: '', cands: [], area: '', areaIdx: 0,
      catText: '', cat1: '', cat2: '', cat3: '',
      facSel: {}, facGroups: FAC_GROUPS.map(g => ({ key: g.key, title: g.title, items: g.items.map(v => ({ v: v, on: false })) })),
      photos: ['', '', ''], photoIds: ['', '', ''],
      wish: '', checked: false, blk: null, same: null, near: null, sameIgnored: false,
      // 坐标：全部清空，然后重新自动手机定位一次（跟刚进页面一致）
      phoneLat: '', phoneLng: '', phoneAcc: '', phoneOn: false,
      gpsLat: '', gpsLng: '', gpsWgsLat: '', gpsWgsLng: '', gpsOn: false,
      tunLat: '', tunLng: '', tunOn: false,
      tunCandLat: '', tunCandLng: '', tunDist: '',
      pendLat: '', pendLng: '', pendWgsLat: '', pendWgsLng: '', pendStable: false,
      gpsText: '', gpsSummary: '', capOn: false, adopted: '', mode: 'idle',
      markers: [], mapLat: '', mapLng: '', lat: '', lng: '', wgsLat: '', wgsLng: '',
      recOn: false, curSec: 0, curText: '00:00', recs: [], recSecs: 0, recTotal: '00:00', playingId: '', recBusy: false
    });
    this._checkedStable = false;
    this._buildCat();
    this._goto(1, true);                    // 回到第 1 步
    this._refresh();
    this.locateNow();                       // 换一家店：重新自动定位一次
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  openDup() {
    const t = this.data.blk || this.data.same;
    if (!t || !t.id) return;
    wx.navigateTo({ url: '/pages/customer/customer?id=' + t.id });
  }
});
