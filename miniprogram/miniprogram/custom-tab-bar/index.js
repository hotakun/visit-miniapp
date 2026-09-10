// 自定义底部 Tab 栏（2026-09-10 老板拍板定稿：根治切页白闪——tab 页由框架常驻，切换时底部栏不再重绘）
// 口径：业务员 3 栏（任务 / 任务地图 / 我的）；老板 4 栏（首页 / 任务地图 / 战况 / 我的）。
// 「我的」页按老板要求保持原样式，不纳入 tab 体系 → 点击走 navigateTo；其余按钮走 switchTab（不销毁页面）。
const TABS_SALESMAN = [
  { key: 'home', ic: '🏠', label: '任务', path: '/pages/home/home', tab: true },
  { key: 'map', ic: '🗺', label: '任务地图', path: '/pages/map/map', tab: true },
  { key: 'mine', ic: '👤', label: '我的', path: '/pages/mine/mine', tab: false }
];
const TABS_BOSS = [
  { key: 'home', ic: '🏠', label: '首页', path: '/pages/home/home', tab: true },
  { key: 'map', ic: '🗺', label: '任务地图', path: '/pages/map/map', tab: true },
  { key: 'war', ic: '📡', label: '战况', path: '/pages/bossWar/bossWar', tab: true },
  { key: 'mine', ic: '👤', label: '我的', path: '/pages/mine/mine', tab: false }
];

Component({
  data: {
    selected: 0,
    tabs: TABS_SALESMAN
  },
  methods: {
    // 由各 tab 页 onShow 调用：this.getTabBar().setTab(索引, 是否老板模式)
    setTab(selected, bossMode) {
      this.setData({ tabs: bossMode ? TABS_BOSS : TABS_SALESMAN, selected });
    },
    onTap(e) {
      const i = Number(e.currentTarget.dataset.i);
      const t = this.data.tabs[i];
      if (!t) return;
      // 「我的」页：非 tab 页（老板定：该页保持原样式），走普通跳转
      if (!t.tab) { wx.navigateTo({ url: t.path }); return; }
      if (i === this.data.selected) return;
      wx.switchTab({ url: t.path });
    }
  }
});
