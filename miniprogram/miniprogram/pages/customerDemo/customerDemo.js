// 客户详情（演示）· 纯静态演示页（2026-09-13 老板要求）
// ---------------------------------------------------------------------------
// 定位：**给老板看效果的演示页**，数据写死（胡记牛骨头那套示例），
//      不连云端、不写库；交互（录入/点改/拍照/折叠）只改本页内存，退出重进即恢复。
// 配色：照 `_scratch/客户详情页-A-手机演示.html`（白卡 + 品牌橙 + 暖白底）。
// 入口：老板首页「今日战况」黑色卡片下面那个按钮。
// ---------------------------------------------------------------------------

// 现场照片示意（真机是业务员现场拍的实拍照片；这里用门店照片格演示）
const SHOT_DEMO = 'https://p0.meituan.net/poipicadd/5e2ffe6e3a39b03a8d3238dae7904fa8857724.jpg%40750w_1e_1l%7Cwatermark%3D0.webp';

const D = {
  name: '胡记牛骨头(永康东塔店)',
  addr: '浙江省金华市永康市新天大厦西(东塔路)',
  hours: '周一至周日 09:00-22:00',
  status: '正常营业',
  tel: '15257811518',
  contact: '胡老板',
  hasMall: true,
  listedYears: 6,                                  // 平台收录 6 年 → 店名旁淡红胶囊
  cat: '美食 · 东北菜',                             // 大中小类（去重后）
  rank: '东站美食热门榜 · 第1名',                    // 榜单信息（口碑卡内 + 品类行右侧）
  // 🏪 商城信息
  mallRows: [
    ['注册商城时间', '2025-08-14'],
    ['签约业务员', '快餐盒c聚火配送🔥'],
    ['最近下单', '8月24日（19 天前）'],
    ['最近浏览商城', '9月5日（7 天前）']
  ],
  photos: ['', '', ''],                            // 门店照片三格（空 = 可现场拍）
  // 📦 购买记录
  purchase: {
    total: '13 单',
    amount: '¥1,744',
    last: '8月24日（19 天前）',
    freq: [['500方盒小', 5], ['750方盒小', 3], ['1000圆碗小', 3], ['450圆碗', 2], ['750圆碗小', 2], ['1500圆碗小', 2]],
    lastItems: '450圆碗 ×1 ｜ 1000圆碗小 ×1 ｜ 本单 ¥154',
    note: '这家的节奏大概两三周补一次货，最近一单已经是 19 天前 —— 大概率该补了，先问碗盒够不够'
  },
  orders: [
    { d: '8月24日', a: 154, items: [['450圆碗', '透明×450套', '1 箱', 78], ['1000圆碗小', '透明×300套', '1 箱', 76]] },
    { d: '8月15日', a: 101, items: [['DS1大号汤勺', '透明×1000个', '1 箱', 45], ['500方盒小', '透明×300套', '1 箱', 56]] },
    { d: '8月13日', a: 129, items: [['P1调料盒连体', '透明×2000套', '1 箱', 73], ['500方盒小', '透明×300套', '1 箱', 56]] },
    { d: '7月24日', a: 238, items: [['500方盒小', '透明×300套', '2 箱', 112], ['750方盒小', '透明×300套', '1 箱', 69], ['500方盒大', '透明×300套', '1 箱', 57]] },
    { d: '7月14日', a: 222, items: [['750圆碗小', '透明×300套', '1 箱', 70], ['1000圆碗小', '透明×300套', '1 箱', 76], ['1500圆碗小', '透明×200套', '1 箱', 76]] },
    { d: '5月4日', a: 224, items: [['500方盒小', '透明×300套', '4 箱', 224]] },
    { d: '5月3日', a: 208, items: [['750方盒小', '透明×300套', '2 箱', 138], ['750圆碗小', '透明×300套', '1 箱', 70]] },
    { d: '4月10日', a: 72, items: [['1000方盒小', '透明×300套', '1 箱', 72]] }
  ],
  // 📊 平台口碑
  rate: '3.7',
  rateTxt: '11 条评价（2025年）· 分项齐全',
  bars: [['口味', '3.8', 76], ['环境', '3.7', 74], ['服务', '3.7', 74]],
  extra: [['人均消费', '¥46/人'], ['评论总数', '11 条（2025年）']],   // 「连锁情况」是单店 → 不显示
  dishes: ['胡记牛肉', '营养咸饭', '牛杂炒面', '小肚丝面', '养生牛尾汤'],
  // 🛎 服务与设施
  flags: [['团购', false], ['外卖', true]],          // 外卖默认已开
  fac: ['明厨亮灶', '花园餐厅', '沿街', '空调开放', '可预点餐', '宝宝椅', '免费停车', '可电话预定'],
  region: '城东路 · 永康市',
  // 客户坐标（2026-09-13：商圈与位置的小地图用）—— 真身来自客户表 lng/lat；**纬度在前**显示（项目口径）
  lat: 28.8892, lng: 120.05388,
  // 「我」的假位置（2026-09-13 老板定）：离客户约 **80 米**（斜向 56.6m + 56.6m，东北方向）—— 演示用，
  // 真身是业务员实时定位（wx.getLocation）；这里写死一个点位，不申请定位权限
  meLat: 28.8897082, meLng: 120.0544605,
  // 步行路线（2026-09-13 老板要：从蓝点画条路径到店）：[纬度, 经度] 依次是
  //   我 → 向西 → 向南 → 向西 → 向南进店（4 个拐点，走街区；纯演示，真机可用腾讯路线规划）
  route: [
    [28.8897082, 120.0544605],   // ① 我（蓝点）
    [28.8897082, 120.0542100],   // ② 沿街向西 ≈ 24 米
    [28.8895600, 120.0542100],   // ③ 向南 ≈ 16 米
    [28.8895600, 120.0538800],   // ④ 向西 ≈ 32 米
    [28.8892000, 120.0538800]    // ⑤ 向南进店（客户坐标）
  ],
  // 📝 管理员备注
  remarks: [
    { d: '09-05', t: '老板交代重点跟进：这家人流好、单价不低，先谈小额试单。' },
    { d: '08-28', t: '已加上老板微信（同手机号）。他说下月可能补 1000 圆碗，先别催单。' }
  ],
  // 🕑 拜访历史
  history: [
    { tag: '已下单', md: '8月30日 14:20', who: '快餐盒c聚火配送🔥', mins: '时长 26 分钟', txt: '带了两款样品，老板要了 3 箱试销，说下周看动销。', samp: '牛骨头 · 小份装 ×3', latest: true, open: false,
      /* 现场证据（演示）：一段拜访录音 + 它的转写文字 + 现场拍的 3 张餐盒照片
         —— 照片是包内的缩略小图（images/box-demo-*.jpg）；录音是模拟播放（真机里放真实文件） */
      rec: {
        dur: '02:14', playing: false, pct: 0,
        txt: '老板说这周先拿三箱试销，主要要 500 方盒小和 750 方盒小，价格再谈谈；另外他妹妹那家店也可以一起带两箱，下周一起送。'
      },
      shots: ['/images/box-demo-1.jpg', '/images/box-demo-2.jpg', '/images/box-demo-3.jpg'] },
    { tag: '已注册商城', md: '8月14日 10:05', who: '快餐盒c聚火配送🔥', mins: '时长 18 分钟', txt: '老板当场扫码注册，手机号已开通。', samp: '', latest: false, open: false }
  ]
};

Page({
  data: {
    d: D,
    // 卡片展开状态（默认：有备注有历史 → 只开这两张）
    // 地图标记（2026-09-13）：① 客户 = 橙针 + **常显店名气泡**  ② 「我」= 微信风格蓝点
    // 锚点规则：针图（针尖在底部）用默认 {x:0.5, y:1} 即可让针尖压在坐标上；
    //          蓝点是圆形，必须显式写 {x:0.5, y:0.5}，否则会整体偏上半个图标高
    markers: [
      {
        id: 1,
        latitude: D.lat,
        longitude: D.lng,
        iconPath: '/images/pin.png',
        width: 26,
        height: 34,
        anchor: { x: 0.5, y: 1 },      // 针尖对准客户坐标
        zIndex: 9,
        alpha: 0.6,                    // 2026-09-13 老板定：针 60% 半透明
                                       // ⚠️ 别设 0 —— alpha=0 时该 marker 的 callout 不显示
        callout: {
          content: D.name,             // 店名气泡
          display: 'ALWAYS',           // 常显（不用点）
          // 2026-09-13 老板定：名字卡 60% 半透明
          // ⚠️ 地图颜色只认 6/8 位十六进制，8 位后两位 = alpha（不支持 rgba()）；0.6×255=153=0x99
          color: '#1F243099',
          fontSize: 12,
          bgColor: '#FFFFFF99',
          borderColor: '#F5531C99',
          borderWidth: 1,
          borderRadius: 8,
          padding: 6,
          textAlign: 'center'
        }
      },
      {
        id: 2,
        latitude: D.meLat,
        longitude: D.meLng,
        iconPath: '/images/locdot.png',
        width: 26,
        height: 26,
        anchor: { x: 0.5, y: 0.5 }
      }
    ],
    // 步行路线（绿色箭头线；points 由 D.route 换算成 {latitude, longitude}）
    polyline: [{
      points: D.route.map(p => ({ latitude: p[0], longitude: p[1] })),
      color: '#16A34AFF',        // 项目绿 --green
      width: 5,
      arrowLine: true,           // 带方向箭头
      borderColor: '#FFFFFF',
      borderWidth: 2
    }],
    open: { mall: false, purchase: false, rate: false, serv: false, remark: true, hist: true },
    // 弹层
    addShow: false, addKind: '', addTitle: '', addPh: '', addVal: '',
    flagShow: false, flagName: '', flagTo: true,
    sheetShow: false,
    viewerShow: false, viewerUrl: ''
  },

  // ---------- 卡片折叠 ----------
  toggle(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    const open = Object.assign({}, this.data.open);
    open[k] = !open[k];
    this.setData({ open });
  },

  // ---------- 演示提示（真机才有真实动作的地方） ----------
  tip(e) {
    const t = (e.currentTarget.dataset.t) || '演示版：真机才有此功能';
    wx.showToast({ title: t, icon: 'none', duration: 1800 });
  },

  // ---------- 录入（菜品 / 设施）----------
  openAdd(e) {
    const kind = e.currentTarget.dataset.kind;
    const cfg = {
      dish: { title: '录入菜品', ph: '例如：招牌牛肉面' },
      fac: { title: '录入设施', ph: '例如：有停车场、可电话预定' }
    }[kind] || { title: '录入', ph: '' };
    this.setData({ addShow: true, addKind: kind, addTitle: cfg.title, addPh: cfg.ph, addVal: '' });
  },
  addInput(e) { this._addVal = e.detail.value; },
  addNo() { this.setData({ addShow: false }); },
  addYes() {
    const v = String(this._addVal || '').trim();
    const d = this.data.d;
    if (v) {
      if (this.data.addKind === 'dish') d.dishes = d.dishes.concat([v]);
      else if (this.data.addKind === 'fac') d.fac = d.fac.concat([v]);
      this.setData({ d });
      wx.showToast({ title: '已加入（演示：退出重进会恢复）', icon: 'none', duration: 1600 });
    }
    this.setData({ addShow: false });
  },

  // ---------- 团购 / 外卖：点了切「已开 / 未开」----------
  openFlag(e) {
    const name = e.currentTarget.dataset.name;
    const cur = !!e.currentTarget.dataset.on;
    this.setData({ flagShow: true, flagName: name, flagTo: !cur });
  },
  flagNo() { this.setData({ flagShow: false }); },
  flagYes() {
    const d = this.data.d;
    d.flags = d.flags.map(f => (f[0] === this.data.flagName ? [f[0], this.data.flagTo] : f));
    this.setData({ d, flagShow: false });
  },

  // ---------- 门店照片：空框点一下就地拍（演示：塞一张示例图）----------
  takePhoto(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    const d = this.data.d;
    const photos = d.photos.slice();
    photos[i] = SHOT_DEMO;
    d.photos = photos;
    this.setData({ d });
    wx.showToast({ title: '演示：真机会调起相机拍照', icon: 'none', duration: 1600 });
  },

  // ---------- 大图查看 ----------
  openPhoto(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    this.setData({ viewerShow: true, viewerUrl: url });
  },
  closePhoto() { this.setData({ viewerShow: false }); },

  // ---------- 购买记录：全屏抽屉 ----------
  openSheet() { this.setData({ sheetShow: true }); },
  closeSheet() { this.setData({ sheetShow: false }); },
  toggleOrder(e) {                                   // 抽屉里：点一单展开明细
    const i = Number(e.currentTarget.dataset.i);
    const d = this.data.d;
    d.orders = d.orders.map((o, k) => (k === i ? Object.assign({}, o, { open: !o.open }) : o));
    this.setData({ d });
  },
  toggleHist(e) {                                    // 历史卡：点一下展开/收起拜访记录
    const i = Number(e.currentTarget.dataset.i);
    const d = this.data.d;
    d.history = d.history.map((v, k) => (k === i ? Object.assign({}, v, { open: !v.open }) : v));
    this.setData({ d });
  },

  // ---------- 开始拜访（2026-09-13 老板定）----------
  // 直接进入**真的拜访页**（pages/visit/visit）；只是给它打上 demo 标记 → 拜访页不建档、
  // 不定位、不真上传，走到「提交」那一步只提示不写任何数据。
  goVisit() {
    wx.setStorageSync('curCustomer', {
      demo: 1,
      _id: 'demo-customer',
      taskId: 'demo-task',
      name: this.data.d.name,
      customerType: 'mall',
      phone: this.data.d.tel,
      contactName: this.data.d.contact,
      address: this.data.d.addr,
      lng: 120.05388, lat: 28.8892,
      visitDurationLimit: 3600,          // 拜访时长上限（演示：1 小时）
      recordingDurationLimit: 300        // 单条录音上限（演示：5 分钟）
    });
    wx.navigateTo({ url: '/pages/visit/visit' });
  },

  // ---------- 拜访录音：模拟播放（进度条走一遍；真机里放真实录音文件）----------
  playRec(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    const arr = this.data.d.history.slice();
    if (!arr[i] || !arr[i].rec) return;
    const rec = Object.assign({}, arr[i].rec);
    if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null; }
    if (rec.playing) {                       // 再点一下 = 暂停
      rec.playing = false;
      arr[i] = Object.assign({}, arr[i], { rec });
      this.setData({ 'd.history': arr });
      return;
    }
    rec.playing = true;
    arr[i] = Object.assign({}, arr[i], { rec });
    this.setData({ 'd.history': arr });
    this._recTimer = setInterval(() => {
      const h = this.data.d.history.slice();
      const r = Object.assign({}, h[i].rec);
      r.pct = Math.min((r.pct || 0) + 4, 100);
      if (r.pct >= 100) {
        clearInterval(this._recTimer); this._recTimer = null;
        r.playing = false; r.pct = 0;          // 放完复位
      }
      h[i] = Object.assign({}, h[i], { rec: r });
      this.setData({ 'd.history': h });
    }, 100);
  },
  onUnload() { if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null; } },

  // 阻止弹层内部点击冒泡到遮罩
  noop() {}
});
