const api = require('../../utils/api');
const { SUBSCRIBE_TEMPLATE_ID } = require('../../utils/config');

// 每日鸡汤短语（随机显示，可随时增删替换；100 条）
const PHRASES = [
  '今天也加油，多走一家是一家 💪',
  '每一家店门背后，都是机会 ✨',
  '好状态就是最好的开场白 🔥',
  '走起来，路就顺了 🚶',
  '真诚敲门，用心沟通 🤝',
  '今天的汗水，明天的单子 💧',
  '先混脸熟，再谈成交 😄',
  '多拜访一家，就多一个可能 🚪',
  '别怕拒绝，那是筛选客户 ⚡',
  '你跑的每一公里，都算数 🛵',
  '好心态，好业绩 🌤',
  '微笑是免费的敲门砖 😊',
  '客户不是等来的，是走出来的 👣',
  '今天多努力一点，明天轻松一点 📈',
  '认真记录，客户都看在眼里 📝',
  '把每一次拜访都当第一次 🌱',
  '稳扎稳打，细水长流 🏔',
  '你的坚持，客户会记得 🕰',
  '出门早一点，机会多一点 ☀️',
  '用脚步丈量市场，用真诚打动客户 🗺',
  '累一点没关系，成长看得见 🌳',
  '今天也要元气满满地出发 🎒',
  '相信积累的力量，拜访不会白跑 💎',
  '天气不背锅，行动出结果 🌦',
  '一家店一家店，跑出自己的版图 🗺',
  '被拒一次，就离成交近一步 🎯',
  '心里有目标，脚下有方向 🧭',
  '拜访是体力活，更是用心活 ❤️',
  '今天流的汗，都是明天的底气 💪',
  '加油，把今天的客户都拿下！🏆',
  '店门开着，就是邀请你进去 🤗',
  '多问一句，就多懂一分 🎓',
  '客户记住你，生意就快了一半 🌟',
  '把路走熟，把脸混熟，把话聊熟 ☕',
  '每一个老板，都值得认真对待 🤝',
  '勤快的人，运气都不会太差 🍀',
  '今天比昨天多走一步，就是进步 📏',
  '别让昨天的遗憾，拖慢今天的脚步 ⏩',
  '订单是聊出来的，不是等出来的 💬',
  '你的专业，就是你的名片 🎖',
  '拜访路上，风景都是努力的样子 🌄',
  '先解决问题，再谈生意 🔧',
  '客户的一句"下次再来"，就是种子 🌾',
  '生意不在大小，在于开始 🚀',
  '别怕说错话，就怕不开口 🗣',
  '把客户的难处记心上，客户把你记心里 ❤️',
  '每天进步一点点，复利看得见 📊',
  '路上辛苦，回头都是故事 📖',
  '热情一点，门就开得大一点 🚪',
  '成交从信任开始，信任从见面开始 🤝',
  '没单子的时候，就去刷脸熟 😎',
  '你的耐心，正在攒一个大单 🧱',
  '时间花在哪，收获就在哪 ⏳',
  '拜访不积极，思想有问题 🤣',
  '老板见你笑，气氛就好了 😁',
  '把今天当作旺季来跑 🏃',
  '少一点犹豫，多一点行动 ⚡',
  '走遍大街小巷，才知生意冷暖 🏙',
  '客户夸你一句，胜过十张广告 📣',
  '脚踏实地，单子自来 🌍',
  '别把拒绝当结局，它只是开场 🎬',
  '每一条街，都有你的机会 🛣',
  '今天不跑客户，明天客户跑别人 😉',
  '用心服务，回头客自然来 🔄',
  '你的坚持，正在悄悄改变局面 🌊',
  '再小的店，也是大生意的开始 🏪',
  '面带笑容，走路带风 🌬',
  '客户的选择很多，你的真诚唯一 💎',
  '把拜访当朋友见面，轻松又有效 🍵',
  '今天多拜访，月底多收获 💰',
  '市场不会辜负勤快的人 📢',
  '别想太多，先出门再说 🚴',
  '单子大小不重要，开口最重要 🔑',
  '每一次沟通，都是积累 🔗',
  '老板的认可，是最大的动力 ⛽',
  '保持热爱，保持出发 🌻',
  '辛苦的脚印，终会变成订单 📦',
  '你认真做事的模样，客户看得见 👀',
  '早起的业务员，有单接 🌅',
  '一单接一单，细流汇成河 🌊',
  '别怕路远，怕的是不起步 🦶',
  '拜访像种地，勤浇水才有收成 🚿',
  '客户有需求，你有方案，正好相遇 🤝',
  '今天也要笑得像太阳一样 ☀️',
  '把每个"下次"都变成"这次" ✅',
  '你的能量，会传染给客户 🔋',
  '走慢一点没关系，别停下来 🐢',
  '生意的门，越敲越开 🚪',
  '记录好每一家，客户跑不掉 📒',
  '好话一句，生意三分 🍬',
  '让客户觉得你靠谱，就赢了一半 🧗',
  '平凡的一天，也能跑出不平凡的业绩 🌟',
  '出门就有 50% 的机会，在家只有 0 🎲',
  '客户的信任，一天天攒出来 🏦',
  '别让情绪，挡住了你的客户 😤',
  '拜访达人，都是练出来的 🥇',
  '今天的你，比昨天更专业 📚',
  '市场很大，你的努力要配得上它 🗺',
  '干就完了，单子在路上 🛣',
  '明天会感谢今天努力拜访的你 🌈'
];

// 老板专属鸡汤（2026-09-09 老板拍板：与业务员版完全分开；看全局/带团队/管生意口吻；第 11 句老板钦定「道路」不用「路」）
const BOSS_PHRASES = [
  '数据不会撒谎，进度条就是人心 📊',
  '你在看报表，员工在看你 👀',
  '盯过程的人，才有资格谈结果 🎯',
  '今天的轨迹，就是明天的回款 🛵',
  '好团队是盯出来的，不是等出来的 🔍',
  '老板的勤快，是替所有人兜底 🧱',
  '市场不会辜负天天看地图的人 🗺',
  '谁在跑、谁在歇，数据一清二楚 📡',
  '把流程管严，人情才好谈 ⚖️',
  '进度慢一点没关系，方向不能偏 🧭',
  '员工跑的是道路，你跑的是版图 🏙',
  '一家店的背后，是一个回头客 🤝',
  '复盘比抱怨值钱 💰',
  '今天不较真，月底就上火 🔥',
  '让干活的人被看见，团队才有劲 ⭐',
  '管理松一寸，市场丢一尺 📏',
  '老板的状态，就是团队的天花板 🏔',
  '客户记住的是聚火，不是你一个人 🏷',
  '盯紧待审核，别让流程卡壳 ⏳',
  '一个客户被服务好，十条街都传 🗣',
  '先看数据，再拍桌子 📋',
  '拜访数上不去，别的都别谈 🚦',
  '好的制度让懒人也动起来 ⚙️',
  '老板要的是确定性，不是惊喜 🎲',
  '每个业务员的今天，都写进你的账本 📒',
  '别替员工找借口，帮他们找方法 🛠',
  '市场的门，是脚步敲开的 🚪',
  '你今天定的标准，就是明天的结果 📐',
  '把重复的事管好，就是本事 🔁',
  '迟到的人最会讲理由，数据不会 ⏰',
  '生意是守出来的，也是盯出来的 🏰',
  '干得好要当场说，干不好要当面说 💬',
  '老板心里有数，员工脚下有路 🧮',
  '三分钟热度做不出回头客 ☕',
  '每个拜访点，都是你的棋子 ♟',
  '松一松，大家舒服；紧一紧，大家有肉 🍖',
  '好结果先奖，坏苗头早掐 🌱',
  '市场很大，你的版图要靠人跑出来 🌏',
  '别让一个懒人，凉了一群勤快人 ❄️',
  '报表冷冰冰，生意热腾腾 🔥',
  '员工看今天，老板看三个月 📅',
  '流程跑通了，人就好管了 🚦',
  '每一个红点，都是一次提醒 🔴',
  '客情是攒出来的，不是补出来的 🧧',
  '你盯得越细，返工就越少 🔬',
  '让多跑的人多赚，队伍才稳 ⚖️',
  '团队的成绩单，就是你的成绩单 🏆',
  '别跟情绪较劲，跟数据较劲 💪',
  '门店在变少，你的地盘不能变小 🗺',
  '聚火要旺，先让底下的人热起来 🔥'
];

// 把短语拆成文字与 emoji 两段（emoji 单独渲染，避免被文字灰色染色）
function splitEmoji(s) {
  const m = String(s).match(/^(.*?)([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\s]+)$/u);
  if (m && m[2].trim()) return { text: m[1].trim(), emoji: m[2].trim() };
  return { text: s, emoji: '' };
}

// 每人每天一条固定鸡汤：业务员 ID + 日期做确定性种子（同一天多次进入不换，跨天自动换，业务员之间各自不同）
function dailyPhrase(uid) {
  return phraseOf(PHRASES, uid);
}

// 老板每天一条固定鸡汤（2026-09-09 老板定：老板版与业务员版分开，用老板 ID 做种子）
function bossPhrase(uid) {
  return phraseOf(BOSS_PHRASES, uid);
}

// ===== 地图秒开预取（2026-09-09 提速 A 方案：首页停留时静默把地图摘要拉好存本地缓存）=====
const MAP_CACHE_KEY = 'map_cache';
const MAP_CACHE_TTL = 10 * 60 * 1000; // 缓存 10 分钟内有效（地图打开先渲染缓存，云端数据到达后静默更新）

function getMapCache() {
  try {
    const c = wx.getStorageSync(MAP_CACHE_KEY);
    if (c && c.at && Date.now() - Number(c.at) < MAP_CACHE_TTL && c.map) return c;
  } catch (e) { /* 静默 */ }
  return null;
}

function setMapCache(res) {
  try {
    wx.setStorageSync(MAP_CACHE_KEY, { at: Date.now(), map: res.map || null, tasks: res.tasks || null });
  } catch (e) { /* 静默 */ }
}

// 首页后台预取地图摘要（静默，失败不影响首页）
function prefetchMapData() {
  api.call('tasks', { action: 'mapData' }).then(setMapCache).catch(() => {});
}

// 通用取句：uid + 日期做确定性种子
function phraseOf(list, uid) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const day = d.toISOString().slice(0, 10);
  const seed = String(uid || '') + '|' + day;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return list[Math.abs(h) % list.length];
}

// 老板模式首页「今日战况」文案池（2026-09-11 老板定：B 组 + C 组组合，按日期轮换，每天给老板换一条）
// 说明：内容为激励式「战况」文案（街道取杭州真实路名），非真实统计数字
const BOSS_NEWS = [
  '延安路、庆春路两条街已扫通，今天新拓 14 家',
  '早上从中山北路扫到凤起路，新拓 7 家，越跑越顺',
  '今天扫过延安路和庆春路，新客 +11，还有 3 家在跟',
  '中山北路、建国北路都跑了一遍，今天新拓 12 家',
  '延安路、中山北路、庆春路扫完，一共新拓 15 家',
  '从古墩路一路扫到文一路，城西这块新拓 8 家',
  '早上从湖滨扫到武林，新拓 9 家，还想再跑两条街',
  '城西文一路一带跑通了，今天新拓 10 家，明天接着扫',
  '4 个人分头跑延安路和庆春路，今天新拓 12 家',
  '武林、湖滨两个商圈都跑到了，新拓 11 家，势头不错'
];
// 按「距 1970 的天数」取模轮换：同一天固定显示同一条，隔天自动换下一条（不存库、不请求）
function bossNewsOfDay() {
  const n = new Date();
  const dayNo = Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 86400000);
  const i = ((dayNo % BOSS_NEWS.length) + BOSS_NEWS.length) % BOSS_NEWS.length;
  return BOSS_NEWS[i];
}

Page({
  // 2026-09-11 老板要求：支持转发给同事好友（标题统一、点开进首页）
  onShareAppMessage() {
    return {
      title: '聚火拜访 · 业务员拜访管理',
      path: '/pages/home/home',
      imageUrl: '/images/share.png'   // 分享封面（5:4，由 logo 生成）
    };
  },
  data: { user: null, tasks: [], showTasks: [], loading: true, todayTotal: 0, todayDone: 0, todayLeft: 0, todayPct: 0, showSubBanner: true, dateText: '', pepText: '', pepEmoji: '', logoUrl: '', cardMode: 'empty', bossMode: false, bossStats: null, bossNews: '', welShow: false },
  onShow() {
    const app = getApp();
    // 2026-09-10：自定义 Tab 栏选中态（首页=0；tab 页常驻后切页不再重建底部栏）
    try { const tb = this.getTabBar && this.getTabBar(); if (tb) tb.setTab(0, !!app.globalData.bossMode); } catch (e) { /* 低版本基础库忽略 */ }
    if (!this._revFn) {
      // 注册审核观察员：审核结果变化时静默刷新首页数据（15 秒被动感知）
      this._revFn = (list) => { if (this._shown) this.load(); };
      app.registerReviewListener(this._revFn);
    }
    this._shown = true;
    // 2026-09-10 老板定：启动云端身份复核——被后台「解绑/停用」的账号不再靠手机缓存直通
    // （每次小程序运行期间只复核一次；网络异常一律放行，绝不误伤）
    if (!this._verified) {
      this._verified = true;
      this._verifyIdentity();
    }
    const boss = app.globalData.bossMode; // 老板模式（2026-09-09 §7.13）
    const u = app.globalData.user;
    // 2026-09-09 开发者范宇琨双身份：dev 冷启动（没经过选择页）→ 强制回两按钮选择页；
    // dev_session=一次性放行（选择页按钮设置，进入后清除）；devAuthed=会话级放行（本次运行期内
    // TAB 来回切换不再弹回登录页；冷启动不恢复，重开小程序仍走选择页）
    if (app.globalData.isDev && !app.globalData.devAuthed && !wx.getStorageSync('dev_session')) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    wx.removeStorageSync('dev_session');
    if (boss) {
      const now = new Date(Date.now() + 8 * 3600 * 1000);
      const week = ['日', '一', '二', '三', '四', '五', '六'];
      const dateText = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 周${week[now.getUTCDay()]}`;
      // 2026-09-09 老板定：显示老板注册时填的名字（皇冠在 wxml 里拼）+ 老板专属鸡汤
      const bname = (u && u.name) || '老板';
      const bp = splitEmoji(bossPhrase(u && u._id ? u._id : 'boss'));
      this.setData({ bossMode: true, user: { name: bname }, dateText, pepText: bp.text, pepEmoji: bp.emoji, logoUrl: app.globalData.logoUrl, bossNews: bossNewsOfDay() });
      this.load();
      this.maybePlayWelcome(); // 2026-09-10 老板定：老板欢迎仪式（频率/时长/风格后台可配）
      return;
    }
    if (!u || u.role !== 'salesman') {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    const dateText = `今日计划 · ${now.getUTCMonth() + 1}月${now.getUTCDate()}日 周${week[now.getUTCDay()]}`;
    const pepText = dailyPhrase(u._id || 'guest');
    const pep = splitEmoji(pepText);
    this.setData({ user: u, bossMode: false, dateText, pepText: pep.text, pepEmoji: pep.emoji, logoUrl: getApp().globalData.logoUrl });
    this.load();
    this.checkSubStatus();
  },
  // 2026-09-10 老板定：云端身份复核——login 云函数说"无绑定/审核中/被拒绝"就清本地缓存踢回登录页；
  // 云端说"仍是业务员"则顺手刷新本地缓存（拿到最新身份）；网络异常/系统繁忙一律放行（离线可用）
  _verifyIdentity() {
    const app = getApp();
    api.call('login', {})
      .then(res => {
        if (res && res.ok && res.user && res.user.role === 'salesman') {
          // 云端确认仍是业务员 → 更新本地身份（后台改名/角色调整同步生效）
          app.setUser(res.user);
        } else if (res && res.code === 'NEED_REGISTER') {
          // 已被后台解绑 → 清身份回注册页
          this._kickToLogin('你的账号已解除绑定，请重新注册');
        } else if (res && res.code === 'PENDING') {
          this._kickToLogin(res.msg || '申请审核中，请等待管理员审核');
        } else if (res && res.code === 'REJECTED') {
          this._kickToLogin(res.msg || '申请未通过，请重新申请');
        }
        // 其余（ok 但非 salesman / SERVER_ERROR / 网络失败）：放行，沿用本地状态
      })
      .catch(() => { /* 云函数调用失败：放行（离线仍可用） */ });
  },
  _kickToLogin(msg) {
    getApp().clearUser(); // 清 user/boss_mode/welcome/devAuthed 及 storage
    wx.showToast({ title: msg, icon: 'none', duration: 2000 });
    setTimeout(() => wx.redirectTo({ url: '/pages/login/login' }), 800);
  },
  onHide() {
    this._shown = false;
    if (this._revFn) { getApp().unregisterReviewListener(this._revFn); this._revFn = null; }
    // 欢迎仪式进行中切走 → 停止并清理（防定时器泄漏）
    if (this._welTimer) { clearInterval(this._welTimer); this._welTimer = null; }
    if (this.data.welShow) this.setData({ welShow: false });
  },
  onUnload() {
    if (this._revFn) { getApp().unregisterReviewListener(this._revFn); this._revFn = null; }
    if (this._welTimer) { clearInterval(this._welTimer); this._welTimer = null; }
  },

  // ===== 老板欢迎仪式（2026-09-10 老板定：全屏礼花「👑 欢迎老板」；频率/时长/风格后台可配） =====
  maybePlayWelcome() {
    const app = getApp();
    // 手动进老板模式刚发起配置请求（welcomePending）→ 最多等 1 秒，超时用默认；拿到则用云端配置
    if (app.globalData.welcomePending && !app.globalData.welcome) {
      let waited = 0;
      const tick = () => {
        waited += 150;
        if (app.globalData.welcome || waited >= 1000) {
          this._welGo(app.globalData.welcome || null);
        } else {
          setTimeout(tick, 150);
        }
      };
      setTimeout(tick, 150);
      return;
    }
    this._welGo(app.globalData.welcome || null);
  },
  _welGo(rawCfg) {
    if (!this._shown) return; // 等待期间已离开首页 → 不播
    const r = rawCfg || {};
    // 前端归一（防异常数据：字段缺失用默认；mode 非法回 daily，避免三个判定全 false 导致每次进入都播）
    const cfg = {
      mode: ['daily', 'every', 'once'].includes(r.mode) ? r.mode : 'daily',
      duration: [2, 3, 5].includes(Number(r.duration)) ? Number(r.duration) : 3,
      style: r.style === 'color' ? 'color' : 'gold'
    };
    // 频率判定（本地 storage；东八区日期）：once=永远只播一次；daily=每天第一次；every=每次都播
    try {
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      const today = d.toISOString().slice(0, 10);
      if (cfg.mode === 'once' && wx.getStorageSync('wel_once')) return;
      if (cfg.mode === 'daily' && wx.getStorageSync('wel_date') === today) return;
      if (cfg.mode === 'once') wx.setStorageSync('wel_once', 1);
      if (cfg.mode === 'daily') wx.setStorageSync('wel_date', today);
    } catch (e) { /* 存储异常：按播放处理，不影响功能 */ }
    this.setData({ welShow: true }, () => {
      const q = wx.createSelectorQuery().in(this);
      q.select('#welcomeCv').fields({ node: true, size: true }).exec(res => {
        if (!res || !res[0] || !res[0].node) { this.setData({ welShow: false }); return; } // 节点异常静默取消
        this._startWelAnim(res[0].node, res[0].width, res[0].height, cfg);
      });
    });
  },
  _startWelAnim(canvas, cssW, cssH, cfg) {
    const dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = cssW, H = cssH;
    // 两套风格共用一套引擎（仅颜色数组不同）
    const COLORS = cfg.style === 'color'
      ? ['#FF4D4F', '#FFA940', '#FFD666', '#73D13D', '#40A9FF', '#B37FEB', '#FF85C0', '#FFFFFF']
      : ['#FFD700', '#FFC300', '#FFF3B0', '#FFFFFF', '#F5B301', '#FFE58F'];
    const N = 120;
    const parts = [];
    for (let i = 0; i < N; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 260 + Math.random() * 780;
      const ribbon = i % 2 === 0; // 彩带/纸屑各半
      parts.push({
        x: W / 2, y: H * 0.40,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 320,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.4,
        w: 5 + Math.random() * 4,
        h: ribbon ? 12 + Math.random() * 8 : 5 + Math.random() * 4,
        c: COLORS[i % COLORS.length],
        ph: Math.random() * Math.PI * 2
      });
    }
    const t0 = Date.now();
    const durMs = (cfg.duration || 3) * 1000;
    const fadeMs = 400;
    const G = 980, DRAG = 0.985, DT = 0.033;
    if (this._welTimer) { clearInterval(this._welTimer); this._welTimer = null; }
    this._welTimer = setInterval(() => {
      const t = Date.now() - t0;
      const totalMs = durMs + fadeMs;
      let alpha = 1;
      if (t > durMs) alpha = Math.max(0, 1 - (t - durMs) / fadeMs);
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(12,14,24,0.5)'; // 全屏遮罩
      ctx.fillRect(0, 0, W, H);
      // 「👑 欢迎老板」：前 500ms 放大入场 + 金色光晕
      const inK = Math.min(1, t / 500);
      const fontScale = 0.7 + 0.3 * (1 - Math.pow(1 - inK, 3));
      ctx.save();
      ctx.translate(W / 2, H * 0.30);
      ctx.scale(fontScale, fontScale);
      ctx.font = 'bold ' + Math.round(Math.min(W * 0.12, 64)) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(255,215,0,0.85)';
      ctx.shadowBlur = t < 600 ? 26 : 0; // 文字静止后取消光晕（shadowBlur 每帧重算开销大，低端机省渲染）
      ctx.fillStyle = '#FFE28A';
      ctx.fillText('👑 欢迎老板', 0, 0);
      ctx.restore();
      // 粒子物理：爆发段=重力+阻力；淡出段=缓速飘落
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (t < durMs) {
          p.vy += G * DT;
          p.vx *= DRAG; p.vy *= DRAG;
          p.x += p.vx * DT;
          p.y += p.vy * DT;
          p.rot += p.vr;
        } else {
          p.vy += G * 0.25 * DT;
          p.x += p.vx * DT * 0.4;
          p.y += p.vy * DT * 0.4;
          p.rot += p.vr * 0.5;
        }
        const sway = Math.sin(t / 260 + p.ph) * (p.h > 10 ? 10 : 3); // 彩带横向飘摆
        ctx.save();
        ctx.translate(p.x + sway, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (t >= totalMs) {
        clearInterval(this._welTimer);
        this._welTimer = null;
        this.setData({ welShow: false }); // 全部结束 → canvas 卸载，显示正常首页
      }
    }, 33);
  },
  // 订阅状态识别：有可用订阅凭证或已绑定服务号（长期通知）则隐藏订阅横幅；无则一直显示提醒
  async checkSubStatus() {
    try {
      const res = await api.call('tasks', { action: 'subStatus' });
      if (res.ok) this.setData({ showSubBanner: !res.hasSub && !res.mpBound });
    } catch (e) { /* 查询失败保持当前显示 */ }
  },
  async subscribe() {
    try {
      const r = await new Promise((resolve, reject) => {
        wx.requestSubscribeMessage({ tmplIds: [SUBSCRIBE_TEMPLATE_ID], success: resolve, fail: reject });
      });
      const token = r[SUBSCRIBE_TEMPLATE_ID];
      if (token === 'accept') {
        const res = await api.call('subscribe', { token });
        if (res.ok) {
          this.setData({ showSubBanner: false });
          api.toast('订阅成功 ✓ 有新任务会通知你');
        } else {
          api.toast(res.msg || '订阅保存失败');
        }
      } else {
        api.toast('未授权订阅（一次性订阅，每次授权可收一条）');
      }
    } catch (e) {
      api.toast('订阅失败，请重试');
    }
  },
  async load() {
    this.setData({ loading: true });
    try {
      // 老板模式（2026-09-09 §7.13）：bossBoard 一次返回统计+全量任务
      if (getApp().globalData.bossMode) {
        const res = await api.call('tasks', { action: 'bossBoard' });
        if (res.ok) {
          const fmtDeadline = s => {
            const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
            return m ? `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日` : (s || '—');
          };
          const tasks = (res.tasks || []).map(t => ({ ...t, deadline: fmtDeadline(t.deadline) }));
          this.setData({ tasks, showTasks: tasks, bossStats: res.stats || null });
          prefetchMapData(); // 2026-09-09 提速 A：静默预取地图摘要（进地图秒开）
        } else {
          api.toast(res.msg || '加载失败');
        }
        this.setData({ loading: false });
        return;
      }
      const res = await api.call('tasks', { action: 'list' });
      if (res.ok) {
        // 截止日期显示格式：YYYY-MM-DD → X月X日
        const fmtDeadline = s => {
          const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
          return m ? `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日` : (s || '—');
        };
        const tasks = (res.tasks || []).map(t => ({ ...t, deadline: fmtDeadline(t.deadline) }));
        // 首页只显示最近 5 个任务，更多在"全部任务"页查看
        this.setData({ tasks, showTasks: tasks.slice(0, 5) });
        // 有审核中任务：启动全局审核观察员（15 秒轮询等待审批结果；无则维持现状）
        if (tasks.some(t => t.status === 'reviewing')) getApp().startReviewWatcher();
        // 今日计划：各进行中任务"今天该拜访名单"合计（云函数按任务创建日=第1天推算）
        // 兜底：云端 tasks 旧版没有 todayTotal 字段时，退化为总家数口径（保证卡片不消失）
        const active = tasks.filter(t => t.status !== 'done');
        const hasTodayField = tasks.some(t => t.todayTotal !== undefined);
        const total = active.reduce((s, t) => s + (hasTodayField ? (t.todayTotal || 0) : (t.total || 0)), 0);
        const done = active.reduce((s, t) => s + (hasTodayField ? (t.todayDone || 0) : (t.visited || 0)), 0);
        const left = Math.max(0, total - done);
        const pct = total ? Math.round(done / total * 100) : 0;
        // 大卡四场景：今日有计划 / 有任务但今日无安排 / 任务全部结束 / 无任何任务
        let cardMode = 'empty';
        if (total > 0) cardMode = 'today';
        else if (active.length) cardMode = 'rest';
        else if (tasks.length) cardMode = 'allDone';
        this.setData({ todayTotal: total, todayDone: done, todayLeft: left, todayPct: pct, cardMode });
        if (cardMode === 'today') this.drawRing();
        prefetchMapData(); // 2026-09-09 提速 A：静默预取地图摘要（进地图秒开）
      } else {
        api.toast(res.msg || '加载失败');
      }
    } catch (e) {
      api.toast('任务加载失败，请确认已部署 tasks');
    }
    this.setData({ loading: false });
  },
  goTodayTask() {
    const t = this.data.tasks.find(x => x.status !== 'done') || this.data.tasks[0];
    if (!t) return;
    this.reportLocOnce(); // 2026-09-08 老板定：点击我的任务时获取一次定位并上报
    wx.navigateTo({ url: `/pages/task/task?taskId=${t._id}` });
  },
  // 点任务：获取一次定位并上报一次（不阻塞跳转；失败静默）
  reportLocOnce() {
    if (getApp().globalData.bossMode) return; // 老板演示：不上报定位（云端也丢弃）
    const loc = require('../../utils/loc');
    loc.startForeground();
    loc.getOne(8000).then(p => {
      if (!p || !p.lat) return;
      return api.call('visits', {
        action: 'reportLocation',
        lat: p.lat, lng: p.lng, accuracy: p.accuracy || 0,
        visitOngoing: !!(getApp().globalData.visitOngoing),
        force: true // 2026-09-08 老板定：点任务的上报不受工作时段/移动阈值限制，必须写
      }).catch(() => { /* 静默 */ });
    }).catch(() => { /* 静默 */ });
  },
  drawRing() {
    const pct = this.data.todayPct || 0;
    const ctx = wx.createCanvasContext('ringCanvas', this);
    const c = 36, r = 29;
    ctx.setLineWidth(7);
    ctx.setLineCap('round');
    ctx.setStrokeStyle('rgba(255,255,255,.3)');
    ctx.beginPath();
    ctx.arc(c, c, r, 0, 2 * Math.PI);
    ctx.stroke();
    const start = -Math.PI / 2;
    const end = start + 2 * Math.PI * pct / 100;
    if (pct > 0) {
      ctx.setStrokeStyle('#fff');
      ctx.beginPath();
      ctx.arc(c, c, r, start, end);
      ctx.stroke();
    }
    ctx.draw();
  },
  goTask(e) {
    this.reportLocOnce(); // 2026-09-08 老板定：点击任务时获取一次定位并上报
    wx.navigateTo({ url: `/pages/task/task?taskId=${e.currentTarget.dataset.id}` });
  },
  goAllTasks() { wx.navigateTo({ url: '/pages/tasks-all/tasks-all' }); },
  hideSubBanner() { this.setData({ showSubBanner: false }); },
  // LOGO 云端加载失败 → 回退本地图，避免白板
  onLogoError() {
    if (this.data.logoUrl !== '/images/logo.png') {
      this.setData({ logoUrl: '/images/logo.png' });
    }
  },
  tabMap() { wx.switchTab({ url: '/pages/map/map' }); }, // 2026-09-10：tab 页常驻，切页不再重建（消白闪）
  tabWar() { wx.switchTab({ url: '/pages/bossWar/bossWar' }); }, // 战况地图（2026-09-09 §7.13）
  tabMine() { wx.navigateTo({ url: '/pages/mine/mine' }); } // 「我的」不在 tab 体系（老板定：该页保持原样式）
});
