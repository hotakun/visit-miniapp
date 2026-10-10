const api = require('../../utils/api');
const loc = require('../../utils/loc');
const media = require('../../utils/media');

// 拜访结果标签（2026-09-13 老板定稿，见 _scratch/拜访页-设计定稿.md）
// 已签约商城的客户 → 8 个；未签约的客户（新客）→ 在此基础上多「已签约商城」「未签约」共 10 个
// ⭐ 2026-10-07 老板定改名：「不愿改」→「已有供应商」、「联系不上」→「关门·休息中」
//   ⚠️ 同步处（漏一处就坏）：云函数 cloudfunctions/visits 的 RESULT_ENUM_MALL + 下面的 PRAISE 话术键 + 后台 admin.html 的 RESULT_PILL
const MALL = ['加入商城', '需要样品', '已下单', '已有供应商', '有抵触', '关门·休息中', '闭店·搬迁', '其他'];
const NEW = [...MALL, '已签约商城', '未签约'];

// 提交成功话语库（按拜访结果分类，随机取一条，短句 ≤14 字）
// 正面=表扬活跃气氛 / 中性=激励 / 负面=温暖治愈打气
const PRAISE = {
  '加入商城': ['厉害！客户心动了 💪', '漂亮！这单有戏了 🔥', '好兆头！趁热打铁冲！🏃'],
  '需要样品': ['不错哦，有苗头了 ✨', '有想法了，趁热打铁！', '有戏！保持跟进就成啦！'],
  '已下单': ['太棒了！真金白银到手 🎉', '成交啦！这一趟值了！', '漂亮！业绩又添一笔 📈'],
  '已签约商城': ['恭喜！又拉进一位新客 🎊', '成功入圈，干得漂亮！', '新客到手，持续跟进哦 🚀'],
  '未签约': ['没事，先混个脸熟 😄', '这次没签下，门已经敲开了！', '留了印象就是收获，下次再来！'],
  '已有供应商': ['正常滴，先混个脸熟 😄', '没需求也留了印象，值！', '先结缘，后成交，慢慢来！'],
  '其他': ['记录在案，下次再战！', '辛苦了，稳稳拿下！', '跑一趟就有一趟的收获！'],
  '有抵触': ['没关系，慢慢来，下次更好 🌤', '别灰心，门总会打开的', '冷脸也是信息，你辛苦了！'],
  '关门·休息中': ['扑空不算白跑，下次逮住他 😉', '缘分未到，改天再来！', '人不在店也在，下次再约！'],
  '闭店·搬迁': ['情况记下了，你辛苦啦 🤗', '又排掉一个雷，功劳不小！', '信息已更新，别白跑啦！']
};

Page({
  // 2026-09-11 老板要求：支持转发给同事好友（标题统一、点开进首页）
  onShareAppMessage() {
    return require('../../utils/share').cfg(); // 统一出口（utils/share.js）：path 带当前登录用户 _id → 记录推荐人
  },
  data: {
    c: null, resultList: MALL, result: '', text: '', samples: '', timerText: '00:00',
    // ⭐ 2026-10-07 老板定：本页**整条导航栏不显示**（visit.json → "navigationStyle":"custom"）→
    //   页面得自己按状态栏高度留白，否则作战条会顶到手机的时间/电量下面。值在 onLoad 里动态取。
    st: 20,
    distLive: '',   // ⭐ 作战条第三行「距店 XX 米」（一次性取位；拿不到就整行不显示）
    confirmShow: false, cancelShow: false, blocked: false, blockMsg: '',
    // ⭐ 2026-10-08 老板定：单开拦截弹窗新增「切换到那家」/「取消上家拜访」→ 这里存"那家"的信息
    ongoingName: '', ongoingId: '', ongoingTaskId: '', ongoingCust: null,
    switchTip: '',   // ⭐ 2026-10-08：「切换回上家」后那两句提示（两行，页内小卡显示）
    distText: '', durMins: 0, distShow: false, locRefreshing: false, locCooldown: 0, locSpinChar: '◐',
    // 超时（2026-09-08 M1）：上限前 5 分钟预警条
    timeoutWarn: false, timeoutLeftMin: 5,
    // 现场证据（2026-09-07 二期提前做）：照片双轨瓦片 + 录音状态机
    // 2026-09-11 M2b：录音改为【多段】—— ≤5 条 / 单条 ≤10 分钟 / 合计 30 分钟硬封顶；按段勾选转写
    pics: [], prepBusy: false, maxPics: 9, // 现场照片上限（2026-09-11 老板定：改为跟后台「照片上限」档位走，默认 9；onLoad 按配置覆盖）
    // ⭐ 2026-10-07 框式拍照：slots = 框位数组（{k, pic:null}=空框 / {k, pic, no}=已拍），由 _refreshSlots() 重排
    slots: [],
    recEnabled: true,      // 录音开关（2026-09-11：跟后台走；关闭后本页隐藏录音区，onLoad 覆盖）
    recs: [],              // 已录段：[{id, path, ext, sec, text, transcribe, up, fileID, trStatus}]
    recState: 'idle',      // idle | rec（同一时刻只录一段）
    curText: '00:00',      // 本次录制计时
    curSec: 0,
    recLeftText: '',       // 本次剩余可录（倒计时）
    recWarn: false,        // 剩 ≤30 秒：红字加大闪动
    recPlayId: '',         // 正在试听的段 id（互斥）
    recBusy: false,        // 转存/上传处理中
    recCountText: '0/6',   // 段数初值（2026-09-11：跟 maxSegs 对齐；实际由 _refreshRecMeta 重算）
    recTotalText: '00:00', // 合计时长
    recLimitMin: 5,        // 单条上限（分钟）初值；onLoad 会按后台档位覆盖（与 segMaxSec: 300 保持一致）
    segMaxSec: 300,        // 单条上限（秒）初值；onLoad 会按后台「拜访录音上限」档位覆盖（2026-09-11 老板定：跟后台走）
    totalMaxSec: 1800,     // 合计硬封顶（秒）= 30 分钟
    maxSegs: 6,            // 最多 6 段（2026-09-11 老板定：由 5 改为 6）
    trBusy: false,         // 「开始转录」进行中
    trMsg: '',             // 转录状态提示
    delRecShow: false,     // 删除单段：二次确认弹层
    delRecIdx: -1,
    // 2026-09-11 老板定：五个区块【全部】可折叠（点标题栏展开收起；独立展开）
    // ⭐ 2026-10-07 老板定（**最终**）：进页面**五个区块全部收起**（回到 09-13 的口径）。
    //   中途曾试过"默认展开拍照 + 结果"，老板看过后要求改回全收起 —— 别再来回改。
    foldPic: true,
    foldRec: true,
    foldSamp: true,
    foldText: true,
    foldRes: true,
    evDesc: ''
  },
  // ⭐⭐ 2026-10-08 老板定：**本页必须「提交拜访」或「取消拜访」才能离开** ——
  //   ① 页面上**不再留返回键**（原作战条左上角那个「‹」已删）；
  //   ② 系统返回 / iOS 右滑由 `wx.enableAlertBeforeUnload` **拦一道确认框**。
  //   ⚠️ 小程序**没有"彻底禁止返回"的能力**，官方只有这道确认框；用户在上面点"离开"仍能走。
  //   ⚠️ 离开前必须 `_unlockLeave()` 放行，否则"提交完自己也退不出去"（见 clearStart / goBackFromBlock）。
  _lockLeave() {
    if (wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: '请取消此弹窗，在页面下方选择“提交拜访”或“取消拜访”。' });
    }
  },
  _unlockLeave() {
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload(); } catch (e) { /* 静默 */ }
    }
  },

  // ⭐ 2026-10-07 作战条第三行：现场距店距离（**一次性**取位就够 —— 业务员站在店里看一眼）。
  //   ⚠️ 取不到 / 没授权 → **这一行不显示**，绝不弹提示（现场最烦弹窗）。
  _liveDist() {
    const c = this.data.c;
    if (!c || !c.lat || !c.lng) return;
    wx.getLocation({
      type: 'gcj02',
      success: (r) => {
        const d = Math.round(haversine(r.latitude, r.longitude, Number(c.lat), Number(c.lng)));
        // ⚠️ 超过 1 公里就显示公里：真机实测出现过「距店 93078 米」这种（在外地测试时常见），读着费劲
        const txt = !isFinite(d) ? ''
          : (d >= 1000 ? ('距店 ' + (d / 1000).toFixed(d >= 10000 ? 0 : 1) + ' 公里') : ('距店 ' + d + ' 米'));
        this.setData({ distLive: txt });
      },
      fail: () => { /* 静默：这一行干脆不显示 */ }
    });
  },

  onLoad(query) {
    // ⭐⭐ 2026-10-10 老板定（手机端）：「拜访记录」要能**再次编辑** —— 从客户详情页的拜访历史点「✎ 编辑」
    //   进来时带 `?editVisitId=xxx` → 本页进**编辑模式**：不 start / 不上锁 / 不跑计时，
    //   改为拉那条记录预填（照片/录音标 `up:true`，复用现有"已传跳过"上传逻辑），保存走 visits.editSubmitted。
    this._editId = String((query && query.editVisitId) || '');
    // ⭐ 2026-10-08 老板定：「切换到那家」跳过来后给一句提示（跨页提示只能靠 storage 传）
    //   ⚠️ 延后 500ms 再弹：让页面先渲染出来，否则 toast 会被页面初始化盖掉
    const _tip = wx.getStorageSync('visitSwitchTip');
    if (_tip) {
      wx.removeStorageSync('visitSwitchTip');
      // ⭐ 2026-10-08 老板定：这句要**两行**显示（已切回「XXX」 / 请正规结束拜访）——
      //   ⚠️ `wx.showToast` **不支持换行**（会被压成空格）→ 改用**页内小卡** `.swtip`（见 wxml/wxss），3 秒自动消失
      this.setData({ switchTip: _tip });
      this._tipTimer = setTimeout(() => this.setData({ switchTip: '' }), 3000);
    }
    const c = wx.getStorageSync('curCustomer');
    if (!c) { api.toast('客户信息丢失'); wx.navigateBack(); return; }
    const lim = media.recLimit(Number(c.recordingDurationLimit) || 300); // 单条上限（秒；≤600，iOS 已放开）
    // 拜访时长上限（2026-09-08 M1）：30 分钟/1 小时/2 小时，默认 1 小时
    const vlRaw = Number(c.visitDurationLimit);
    this.vLimit = [1800, 3600, 7200].includes(vlRaw) ? vlRaw : 3600;
    this._warned = false;
    this._timeoutDone = false;
    // 2026-09-11：现场证据与业务开关跟后台走（sysCfg 由 tasks.detail / mapData 写入全局）
    const _app = getApp();
    const _cfg = (_app && _app.globalData && _app.globalData.sysCfg) || {};
    const maxPics = [3, 6, 9, 15].includes(Number(_cfg.photoLimit)) ? Number(_cfg.photoLimit) : 9;
    // ⭐ 2026-10-07：导航栏整条不显示 → 自己按状态栏高度留白（**不写死**：各机型 20~54px 不等）
    const _wi = ((wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {});
    const _st = Number(_wi.statusBarHeight) || 20;
    this.recEnabled = _cfg.recEnabled === undefined ? true : !!_cfg.recEnabled;
    this.evidenceRequired = !!_cfg.evidenceRequired;
    this.setData({
      c,
      resultList: c.customerType === 'new' ? NEW : MALL,
      recLimitMin: Math.max(3, Math.round(lim / 60)),
      segMaxSec: lim,
      maxPics,                        // 照片上限（后台设置页可配 3/6/9/15，默认 9）
      st: _st,                        // 状态栏高度（导航栏没了，自己留白用）
      recEnabled: this.recEnabled     // 录音开关（关闭后本页隐藏录音区）
    });
    // ⭐ 2026-10-08：进页面就"上锁" —— 必须提交/取消才能离开（见 _lockLeave）
    //   ⚠️ 编辑模式**不上锁**（改资料，随时可走）、也不跑实时距离/计时
    if (!this._editId) {
      this._lockLeave();
      this._liveDist();   // ⭐ 2026-10-07：作战条上的「距店 XX 米」
    }
    // ⭐ 2026-10-07：拍照框式 —— 进页面先摆好 3 个虚线空框
    this._refreshSlots();
    // 录音器（页面级单例；串行录制，离开页面即停并丢弃，未提交不上传）
    this.recorder = media.createRecorder();
    this._recSecs = 0;
    this._recTicker = null;
    this._dead = false;
    // 开始拜访：云端校验（任务内单开：其他家还在拜访中会拦截）
    this._selfCust = c;   // ⭐ 2026-10-08：「切换到那家」会把 curCustomer 换掉 → 先把本家存住（取消完要回到本家）
    if (this._editId) this._loadEdit();   // ⭐ 编辑模式：不 start、不上锁、不计时（见 _loadEdit）
    else this._startSelf();
  },
  // 开始拜访（本家）：云端校验单开 → 被拦就弹拦截窗，否则起计时
  _startSelf() {
    const c = this._selfCust;
    api.call('visits', { action: 'start', taskId: c.taskId, customerId: c._id, freeTripId: c.freeTripId || '' }).then(res => {
      if (res && res.code === 'ONGOING_OTHERS') {
        // ⭐ 2026-10-08 老板定：除「知道了」，另加两个按钮 ——
        //   「切换到那家」= 把那家当 curCustomer 重进本页；「取消上家拜访」= 直接取消那家的拜访中。
        this.setData({
          blocked: true,
          blockMsg: '「' + (res.ongoingName || '另一家') + '」',
          ongoingName: res.ongoingName || '另一家',
          ongoingId: res.ongoingCustomerId || '',
          ongoingTaskId: res.ongoingTaskId || '',
          ongoingCust: res.ongoingCustomer || null
        });
        return;
      }
      this.setData({ blocked: false });
      this.beginTimer(c);
    }).catch(() => { this.beginTimer(c); });
  },
  // 「切换到那家」：把那家写成 curCustomer → redirectTo 重进本页（替换掉当前这家的页面栈）
  switchToOngoing() {
    const oc = this.data.ongoingCust;
    if (!oc || !oc._id) { api.toast('拿不到那家的信息，请返回重进'); return; }
    wx.setStorageSync('curCustomer', oc);
    // ⭐ 2026-10-08 老板定：切过去之后提示一句「已经切回 XXX，请正规结束拜访」
    //   ⚠️ 紧接着就 redirectTo 换页 → 这句必须**存进 storage 让新页面去弹**，否则刚弹出来就被换走了
    // ⭐ 2026-10-08：**只存店名**，两行提示语由目标页面自己拼（见 onLoad 的 switchTip）
    wx.setStorageSync('visitSwitchTip', this.data.ongoingName || '那一家');
    this._unlockLeave();
    wx.redirectTo({ url: '/pages/visit/visit' });
  },
  // 「取消上家拜访」：直接取消那家的拜访中 → 成功后**自动继续本家**（业务员不用再点一次）
  cancelOngoing() {
    const id = this.data.ongoingId;
    if (!id) { api.toast('拿不到那家的信息，请返回重进'); return; }
    wx.showLoading({ title: '取消中…', mask: true });
    api.call('visits', { action: 'cancel', taskId: this.data.ongoingTaskId || '', customerId: id }).then(r => {
      wx.hideLoading();
      if (!r || !r.ok) { api.toast((r && r.msg) || '取消失败，请稍后再试'); return; }
      this.setData({ blocked: false, ongoingCust: null, ongoingId: '', ongoingTaskId: '' });
      api.toast('已取消上家，继续本家拜访');
      this._startSelf();
    }).catch(e => {
      wx.hideLoading();
      console.error('[拜访] 取消上家失败', e);
      api.toast('取消失败，请稍后再试');
    });
  },
  // 单开拦截弹窗「知道了」：返回客户详情页
  goBackFromBlock() {
    // ⭐ 2026-10-08：单开拦截时本页压根没开始拜访 → 放行再走
    this._unlockLeave();
    wx.navigateBack();
  },
  // 计时基准时间持久化（2026-09-06 老板定）：进入拜访页记一次，切后台/页面重载回来继续沿用，
  // 只有取消拜访或提交成功才清除——显示与提交时长永远基于同一开始时间
  beginTimer(c) {
    const key = 'visitStart_' + c.taskId + '_' + c._id;
    let t0 = wx.getStorageSync(key);
    // 新鲜度校验：超过 24 小时的旧基准作废（防撤回/删除任务后重发，同 key 沿用很早以前的开始时间）
    if (!t0 || (Date.now() - t0) > 24 * 3600 * 1000) {
      t0 = Date.now();
      wx.setStorageSync(key, t0);
    }
    this.t0 = t0;
    this._startKey = key;
    getApp().globalData.visitOngoing = true; // 最新位置上报标记（2026-09-08 M1）
    loc.beacon(); // 状态信标：进入拜访中（2026-09-08 老板定：后台立即感知）
    // 后台定位（2026-09-08 M2）：仅拜访中开启，拒绝不阻断；首次提示一次
    loc.startForeground();
    loc.startBackground().then(ok => {
      if (ok && !wx.getStorageSync('bgLocTip')) {
        wx.setStorageSync('bgLocTip', 1);
        api.toast('拜访期间将后台记录位置轨迹');
      }
    });
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  },
  tick() {
    const s = Math.floor((Date.now() - this.t0) / 1000);
    this.setData({ timerText: String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') });
    // 超时预警与到点双态（2026-09-08 M1）
    if (!this.vLimit || this._timeoutDone) return;
    const left = this.vLimit - s;
    if (left <= 300 && left > 0 && !this._warned) {
      this._warned = true;
      const m = Math.ceil(left / 60);
      this.setData({ timeoutWarn: true, timeoutLeftMin: m });
      try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 震动失败忽略 */ }
    } else if (left > 0 && this._warned) {
      const m = Math.ceil(left / 60);
      if (m !== this.data.timeoutLeftMin) this.setData({ timeoutLeftMin: m });
    } else if (left <= 0) {
      this._timeoutDone = true;
      this.onTimeout();
    }
  },
  // 到点本地双态（云端 10 分钟定时触发兜底，幂等不重复）：
  // 已选结果 → 自动提交（跳过距离、无照片录音）；未选 → 自动取消
  async onTimeout() {
    if (this._timeoutBusy) return;
    this._timeoutBusy = true;
    clearInterval(this.timer);
    const c = this.data.c;
    try {
      if (this.data.result) {
        const durationSeconds = Math.floor((Date.now() - this.t0) / 1000);
        const res = await api.call('visits', {
          action: 'submit', taskId: c.taskId, customerId: c._id, freeTripId: c.freeTripId || '',
          result: this.data.result, text: this.data.text, samples: this.data.samples,
          durationSeconds, skipLoc: true
        });
        if (!res.ok) { api.toast(res.msg || '超时自动提交失败'); this._timeoutBusy = false; this.timer = setInterval(() => this.tick(), 1000); return; }
        this.clearStart();
        loc.beacon(); // 状态信标：拜访中→已回访（2026-09-08 老板定）
        api.toast('超时已自动提交 ✓');
        setTimeout(() => wx.navigateBack(), 900);
      } else {
        const res = await api.call('visits', { action: 'cancel', taskId: c.taskId, customerId: c._id });
        if (!res.ok) { api.toast(res.msg || '超时自动取消失败'); this._timeoutBusy = false; this.timer = setInterval(() => this.tick(), 1000); return; }
        this.clearStart();
        loc.beacon(); // 状态信标：拜访中→待回访（2026-09-08 老板定）
        api.toast('拜访超时，已自动取消');
        setTimeout(() => wx.navigateBack(), 900);
      }
    } catch (e) {
      this._timeoutBusy = false;
      this.timer = setInterval(() => this.tick(), 1000);
      api.toast('网络异常，稍后将由系统自动处理');
    }
  },
  // 草稿上报（防抖 1.2 秒）：点选结果/输入备注时上报，云端据此超时自动提交
  saveDraftSoon() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this.saveDraftNow(), 1200);
  },
  saveDraftNow() {
    const c = this.data.c;
    if (!c || !c.taskId) return;
    api.call('visits', {
      action: 'saveDraft', taskId: c.taskId, customerId: c._id,
      result: this.data.result, text: this.data.text, samples: this.data.samples
    }).catch(() => { /* 静默：下次再报 */ });
  },
  clearStart() {
    // ⭐ 2026-10-08：提交 / 取消 / 超时**离开前必须先放行** —— 否则页面那把"锁"会把自己也挡在门里
    this._unlockLeave();
    if (this._startKey) {
      wx.removeStorageSync(this._startKey);
      this._startKey = null;
    }
    getApp().globalData.visitOngoing = false; // 最新位置上报标记清除（2026-09-08 M1）
    loc.stopBackground(); // 后台定位严格关闭（2026-09-08 M2：提交/取消即停）
  },
  onUnload() {
    this._dead = true;
    clearInterval(this.timer);
    clearInterval(this._spinTimer);
    clearInterval(this._locTimer);
    clearInterval(this._cdTimer);
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
    // 审查修复：退出前立即补报一次草稿（防最后 1.2 秒内的输入丢失导致超时误判"未选结果"而取消）
    this.saveDraftNow();
    // 离开页面：录音/试听一律停掉丢弃（未提交不上传，符合取消/退出零残留口径）
    this._stopRecTicker();
    media.stopPath(); // 多段试听：停掉独立播放器
    if (this.recorder) {
      this.recorder.stopPlay();
      if (this.data.recState === 'rec') this.recorder.stop();
    }
  },
  // 折叠卡片（2026-09-11 老板定）：点标题栏展开/收起【五个区块】；独立展开、互不影响
  toggleFold(e) {
    const k = e.currentTarget.dataset.k;
    const map = { pic: 'foldPic', rec: 'foldRec', samp: 'foldSamp', text: 'foldText', res: 'foldRes' };
    const key = map[k];
    if (key) this.setData({ [key]: !this.data[key] });
  },
  // ===== 现场证据：照片（⭐ 2026-10-07 老板定：**改成"框式"**，与「门头照 / 加新店」同一套操作）=====
  // 口径：永远摆着 3 个虚线框（空框本身就是"点这儿拍"的提示），拍满一排**自动补出下一排**；
  //       到上限（3/6/9/15，跟后台档位走）就不再补。
  // ⚠️ 原来是「两个按钮（拍照 / 从相册选）+ 拍到就冒一张」，业务员不知道"该拍几张、拍完没有"。
  // ⭐ 重排规则：total = min(maxPics, max(3, ⌈(已拍 + 1) / 3⌉ × 3))
  //    已拍 0 → 3 空框 ｜ 已拍 3 → 3 图 + 3 空框 ｜ 已拍 8（上限 9）→ 8 图 + 1 空框 ｜ 已拍 9 → 9 图、无空框
  _refreshSlots() {
    const pics = this.data.pics, max = this.data.maxPics;
    const total = Math.min(max, Math.max(3, Math.ceil((pics.length + 1) / 3) * 3));
    const slots = [];
    for (let i = 0; i < total; i++) {
      slots.push(pics[i] ? { k: 's' + i, pic: pics[i], no: i + 1 } : { k: 's' + i, pic: null });
    }
    this.setData({ slots });
  },
  // 点虚线空框 = 拍一张：系统弹「拍照 / 从相册选」—— 与门头照一字不差，业务员不用学第二套
  async tapSlot() {
    if (this.data.prepBusy) return;
    if (this.data.pics.length >= this.data.maxPics) { api.toast('最多 ' + this.data.maxPics + ' 张现场照片'); return; }
    let files;
    try { files = await media.chooseImage(1, ['camera', 'album']); } catch (e) { return; }  // 取消 → 直接返回
    if (!files || !files.length) return;
    await this._addPics(files);
  },
  // 逐张处理（压缩成「原图 + 缩略图」双轨）后追加到列表
  async _addPics(files) {
    this.setData({ prepBusy: true });
    const pics = [...this.data.pics];
    let failed = 0;
    for (const f of files) {
      if (pics.length >= this.data.maxPics) break;
      try {
        const r = await media.prepPhoto(f.tempFilePath);
        pics.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), orig: r.orig.path, thumb: r.thumb.path, up: false });
      } catch (err) { failed++; }
    }
    this.setData({ pics, prepBusy: false });
    this._refreshSlots();   // ⭐ 拍完重排框（拍满一排自动补下一排）
    if (failed) api.toast(failed + ' 张处理失败，请重试');
  },
  delPhoto(e) {
    this.setData({ pics: this.data.pics.filter(p => p.id !== e.currentTarget.dataset.id) });
    this._refreshSlots();   // ⭐ 删完重排框（少一张就收回一排空框）
  },
  previewPhoto(e) {
    wx.previewImage({ urls: this.data.pics.map(p => p.orig), current: e.currentTarget.dataset.src });
  },

  // ===== 现场录音（2026-09-11 M2b：多段） =====
  // 口径（老板拍板）：≤5 条；单条 ≤10 分钟（由后台档位决定上限）；合计 30 分钟硬封顶（满了不让再录）
  // 微信 RecorderManager 是全局单例 → 串行录制；每段录完立即转存为持久路径再入列，不覆盖
  onRecTap() {
    if (this.data.recState === 'rec') this.stopRec(false);
    else this.startRec();
  },
  _recUsed() {
    return (this.data.recs || []).reduce((s, r) => s + (Number(r.sec) || 0), 0);
  },
  _refreshRecMeta(recs) {
    const total = (recs || []).reduce((s, r) => s + (Number(r.sec) || 0), 0);
    this.setData({ recCountText: (recs || []).length + '/' + this.data.maxSegs, recTotalText: media.fmtSec(total) });
  },
  startRec() {
    if (this.data.recState === 'rec' || this.data.recBusy) return;
    const recs = this.data.recs || [];
    if (recs.length >= this.data.maxSegs) { api.toast('最多 ' + this.data.maxSegs + ' 段录音'); return; }
    const leftTotal = this.data.totalMaxSec - this._recUsed();
    if (leftTotal <= 5) { api.toast('录音合计已达 30 分钟上限，不能再录'); return; }
    // 本次可录上限 = min(后台档位设置的单条上限, 剩余合计) —— 合计 30 分钟硬封顶在此生效
    // 2026-09-11 老板定：单条上限跟后台「拜访录音上限」档位走（后台一改，这里自动跟随；文案也动态显示）
    const segMax = media.recLimit(Number(this.data.c && this.data.c.recordingDurationLimit) || 300);
    const limit = Math.min(segMax, leftTotal);
    this._recLimit = limit;
    this._recSecs = 0;
    this.setData({ recState: 'rec', curText: '00:00', curSec: 0, recWarn: false, recLeftText: '剩余 ' + media.fmtSec(limit), trMsg: '' });
    this.recorder.start(limit, () => {}, (p, dur, auto) => this.onRecDone(p, dur, auto), m => { if (!this._dead) api.toast(m); });
    this._startRecTicker(limit);
  },
  _startRecTicker(limit) {
    clearInterval(this._recTicker);
    this._recTicker = setInterval(() => {
      if (this._dead) return;
      this._recSecs++;
      const left = Math.max(0, limit - this._recSecs);
      this.setData({
        curSec: this._recSecs,
        curText: media.fmtSec(this._recSecs),
        recLeftText: '剩余 ' + media.fmtSec(left),
        recWarn: left <= 30 // 剩 30 秒：红字 + 加大 + 闪动（样式见 wxss）
      });
      if (this._recSecs >= limit) this.recorder.stopAtLimit(); // 到本次上限自动停
    }, 1000);
  },
  _stopRecTicker() { clearInterval(this._recTicker); this._recTicker = null; },
  stopRec(byLimit) {
    this._stopRecTicker();
    if (byLimit) this.recorder.stopAtLimit(); else this.recorder.stop();
  },
  // 录完一段：立即转存为持久路径（saveFile 会移动临时文件 → 试听/上传必须用转存后的路径）
  async onRecDone(path, dur, auto) {
    if (this._recStopResolve) { const r = this._recStopResolve; this._recStopResolve = null; r(); }
    if (this._dead || !path) return;
    this._stopRecTicker();
    const secs = Math.max(1, Math.round(dur || this._recSecs));
    const ext = this.recorder.uploadExt; // iOS=.m4a / 安卓鸿蒙=.mp3（随段记录，防后续格式变化）
    this.setData({ recState: 'idle', recBusy: true, recWarn: false, curText: '00:00', recLeftText: '' });
    let up = path;
    try { const p = await this.recorder.getUploadPath(); if (p) up = p; } catch (e) { /* 转存失败：退回原路径 */ }
    if (this._dead) return;
    const recs = [...(this.data.recs || [])];
    recs.push({
      id: 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      path: up, ext, sec: secs, text: media.fmtSec(secs),
      transcribe: true, // 默认勾选转写（未勾选只留档不计费）
      up: false, fileID: '', trStatus: ''
    });
    this.setData({ recs, recBusy: false });
    this._refreshRecMeta(recs);
    if (auto) {
      const hitTotal = this._recUsed() >= this.data.totalMaxSec - 5;
      api.toast(hitTotal ? '录音合计已达 30 分钟，已自动停止' : '已达单条上限，录音已自动停止');
    }
  },
  // 试听某一段（共用一颗 InnerAudioContext → 同一时刻只播一条）
  playRec(e) {
    const id = e.currentTarget.dataset.id;
    const it = (this.data.recs || []).find(r => r.id === id);
    if (!it || !it.path) return;
    if (this.data.recPlayId === id) {
      media.stopPath();
      this.setData({ recPlayId: '' });
      return;
    }
    media.playPath(it.path, () => { if (!this._dead) this.setData({ recPlayId: '' }); });
    this.setData({ recPlayId: id });
  },
  // 删除某一段（老板定：二次确认，防误删）
  askDelRec(e) {
    const idx = Number(e.currentTarget.dataset.i);
    if (!(this.data.recs || [])[idx]) return;
    media.stopPath();
    this.setData({ delRecShow: true, delRecIdx: idx, recPlayId: '' });
  },
  hideDelRec() { this.setData({ delRecShow: false, delRecIdx: -1 }); },
  doDelRec() {
    const idx = this.data.delRecIdx;
    const recs = [...(this.data.recs || [])];
    this.setData({ delRecShow: false, delRecIdx: -1 });
    if (idx < 0 || !recs[idx]) return;
    recs.splice(idx, 1);
    this.setData({ recs });
    this._refreshRecMeta(recs);
    api.toast('已删除该段录音');
  },
  // 勾选 / 取消某段「参与转写」
  toggleRecTr(e) {
    const idx = Number(e.currentTarget.dataset.i);
    const recs = [...(this.data.recs || [])];
    if (!recs[idx]) return;
    recs[idx] = { ...recs[idx], transcribe: !recs[idx].transcribe };
    this.setData({ recs });
  },
  // 「开始转录」（老板定：按下 = 上传 + 转写勾选的段；可提前看结果）
  // 提交拜访时还会对「勾选但尚未提交转写」的段兜底一次
  async startTranscribe() {
    if (this.data.trBusy) return;
    if (this.data.recState === 'rec') { api.toast('请先停止录音'); return; }
    const recs = this.data.recs || [];
    if (!recs.length) { api.toast('还没有录音'); return; }
    if (!recs.filter(r => r.transcribe).length) { api.toast('没有勾选任何录音段'); return; }
    this.setData({ trBusy: true, trMsg: '上传录音中…' });
    try {
      const all = await this.uploadAudios();
      const fileIDs = all.filter(r => r.transcribe && r.fileID).map(r => ({ fileID: r.fileID, duration: r.sec }));
      if (!fileIDs.length) { this.setData({ trBusy: false, trMsg: '' }); api.toast('录音上传失败，请重试'); return; }
      this.setData({ trMsg: '提交识别…' });
      const res = await api.call('transcribe', {
        action: 'start',
        fileIDs,
        taskId: this.data.c.taskId,
        customerId: this.data.c._id
      });
      if (res && res.ok) {
        // 标记已提交的段（提交拜访时只对"未提交"的段兜底，不重复计费）
        const marked = (this.data.recs || []).map(r => (r.transcribe && r.fileID && !r.trStatus) ? { ...r, trStatus: 'processing' } : r);
        this.setData({ recs: marked, trBusy: false, trMsg: '已提交转写，等 1~3 分钟可在客户详情看文字' });
        api.toast('已提交转写', 'success'); // 2026-09-28 老板定：文案不带 ✓（success 图标已是勾）
      } else {
        this.setData({ trBusy: false, trMsg: '' });
        api.toast((res && res.msg) || '提交转写失败');
      }
    } catch (e) {
      this.setData({ trBusy: false, trMsg: '' });
      api.toast('提交转写失败，请重试');
    }
  },

  // 拜访记录页（重要定位页面）：按后台「重要页面刷新」档位刷定位（默认 15 秒，2026-09-06 老板定），
  // 写全局缓存供提交弹窗复用；进入页面启动、退出/切后台停止
  onShow() {
    this.locateNow();
    clearInterval(this._locTimer);
    const sec = (this.data.c && this.data.c.locKeyRefresh) || 15;
    this._locTimer = setInterval(() => this.locateNow(), sec * 1000);
  },
  onHide() {
    clearInterval(this._locTimer);
  },
  locateNow() {
    if (this.data.locRefreshing) return; // 收敛精确定位进行中：避免并发定位请求
    loc.getOne(8000).then(p => loc.setCache(p.lat, p.lng)).catch(() => { /* 静默 */ });
  },
  pickResult(e) { this.setData({ result: e.currentTarget.dataset.r }); this.saveDraftSoon(); },
  onText(e) { this.setData({ text: e.detail.value }); this.saveDraftSoon(); },
  onSamples(e) { this.setData({ samples: e.detail.value }); this.saveDraftSoon(); },

  // 第 1 步：点提交立即刷新一次定位，最多等 2 秒出结果再弹窗；2 秒未出也弹窗（用缓存值）；晚到的新鲜结果自动更新弹窗
  // ⭐⭐ 2026-10-10 编辑模式：拉那条拜访记录 → 预填（照片/录音转临时 URL 并标 up:true，保存时不重复上传）
  async _loadEdit() {
    wx.showLoading({ title: '加载记录…', mask: true });
    try {
      const res = await api.call('visits', { action: 'history', customerId: this.data.c._id });
      const v = ((res && res.visits) || []).find(x => x._id === this._editId);
      if (!v) { wx.hideLoading(); api.toast('没找到这条拜访记录'); wx.navigateBack(); return; }
      if (v.status === 'ongoing') { wx.hideLoading(); api.toast('这条还在拜访中，请回拜访页正常提交'); wx.navigateBack(); return; }
      // 照片：fileID → 临时 URL（显示用；up:true → 保存时不会重复传）
      let pics = [];
      const ph = (v.photos || []).filter(p => p && p.fileID).slice(0, 9);
      if (ph.length) {
        const ids = ph.map(p => p.fileID).concat(ph.map(p => p.thumbID).filter(Boolean));
        let urls = [];
        try { const r = await wx.cloud.getTempFileURL({ fileList: ids.slice(0, 30) }); urls = (r.fileList || []).map(x => x.tempFileURL); } catch (e) { /* 取图失败不影响 */ }
        const n = ph.length;
        pics = ph.map((p, i) => ({ id: 'e' + i, orig: urls[i] || '', thumb: urls[n + i] || urls[i] || '', up: true, fileID: p.fileID, thumbID: p.thumbID }));
      }
      // 录音：fileID → 临时 URL（up:true + trStatus done → 不重复传、不重复触发转写）
      let recs = [];
      const au = (v.audios || []).filter(a => a && a.fileID).slice(0, 6);
      if (au.length) {
        let urls2 = [];
        try { const r2 = await wx.cloud.getTempFileURL({ fileList: au.map(a => a.fileID) }); urls2 = (r2.fileList || []).map(x => x.tempFileURL); } catch (e) { /* 同上 */ }
        recs = au.map((a, i) => ({ id: 'er' + i, path: urls2[i] || '', ext: '.mp3', sec: Number(a.duration) || 0, text: a.text || '', transcribe: false, up: true, fileID: a.fileID, trStatus: 'done' }));
      }
      wx.hideLoading();
      this.setData({
        isEdit: true,
        result: v.result || '', text: v.text || '', samples: v.samples || '',
        pics: pics, recs: recs,
        pendingSeconds: Number(v.durationSeconds) || 0
      });
      this.t0 = 0;   // 编辑模式不计时
      this._refreshSlots();   // 摆好剩余空框（与已有照片呼应）
    } catch (e) {
      wx.hideLoading();
      console.error('[visit] 编辑模式加载失败', e);
      api.toast('加载失败，请返回重试');
      wx.navigateBack();
    }
  },
  // ⭐⭐ 2026-10-10 编辑模式：保存修改（只上传新增的照片/录音 → visits.editSubmitted）
  async _submitEdit() {
    this.submitting = true;
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      if ((this.data.pics || []).length || (this.data.recs || []).length) await this.uploadEvidence();
      const photos = this._evPhotos || (this.data.pics || []).map(p => ({ fileID: p.fileID, thumbID: p.thumbID })).filter(x => x.fileID);
      const audios = this._evAudios || (this.data.recs || []).filter(r => r.fileID).map(r => ({ fileID: r.fileID, duration: r.sec, transcribe: !!r.transcribe }));
      const res = await api.call('visits', {
        action: 'editSubmitted', visitId: this._editId,
        result: this.data.result, text: this.data.text, samples: this.data.samples,
        photos: photos, audios: audios
      });
      wx.hideLoading();
      this.submitting = false;
      if (!res || !res.ok) { api.toast((res && res.msg) || '保存失败，请重试'); return; }
      api.toast('已保存修改 ✓', 'success');
      wx.setStorageSync('custNeedRefresh', 1);   // ⭐ 让客户详情页返回时重拉（铁律：改完必须真的刷新）
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      wx.hideLoading();
      this.submitting = false;
      console.error('[visit] 编辑保存失败', e);
      api.toast('保存失败，请检查网络后重试');
    }
  },
  async submit() {
    if (this.submitting) return;
    if (!this.data.result) {
      api.toast('请先选择拜访结果');
      return;
    }
    // ⭐ 2026-10-10：编辑模式走独立轻量提交（无定位校验、无确认窗、不改任务进度）
    if (this._editId) return this._submitEdit();
    // 游客（实习账号）模拟提交（2026-09-08 老板定）：走完整流程但不写任何数据；
    // 清理云端 ongoing 防后台残留"拜访中"，提示「模拟提交成功」
    if (api.isTrialUser()) {
      this.submitting = true;
      try { await api.call('visits', { action: 'cancel', taskId: this.data.c.taskId, customerId: this.data.c._id }); } catch (e) { /* 静默 */ }
      this.clearStart();
      this.submitting = false;
      api.toast('模拟提交成功', 'success');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    const durationSeconds = Math.floor((Date.now() - this.t0) / 1000);
    const c = this.data.c;
    let locP = loc.getCached() || {};
    let distText = this.fmtDist(locP.lat, locP.lng, c);
    let applied = false; // 新鲜定位结果只应用一次
    const apply = (p) => {
      if (applied || !p) return;
      applied = true;
      loc.setCache(p.lat, p.lng);
      locP = { lat: p.lat, lng: p.lng };
      this.pendingLoc = locP;
      const nt = this.fmtDist(p.lat, p.lng, c);
      if (this.data.confirmShow && !this.data.locRefreshing) this.setData({ distText: nt });
      distText = nt;
    };
    // 立即刷新一次（防并发由 loc.getOne 单飞保证；失败静默用缓存值）
    const fresh = loc.getOne(2000).then(p => apply(p)).catch(() => {});
    // 最多等 2 秒：结果先到就带新距离弹窗，否则到点直接弹窗
    await Promise.race([fresh, new Promise(r => setTimeout(r, 2000))]);
    this.pendingLoc = locP;
    this.setData({
      confirmShow: true,
      distText,
      distShow: true, // 无坐标客户也显示距离行（显示 —）
      locRefreshing: false,
      locCooldown: 0,
      durMins: Math.max(1, Math.ceil(durationSeconds / 60)),
      pendingSeconds: durationSeconds,
      evDesc: this.evDesc()
    });
  },
  // 提交弹窗证据清单文案：📷 N 张 · 🎙️ N 段 合计 mm:ss（无证据返回空串不显示行）
  evDesc() {
    const n = this.data.pics.length;
    const recs = this.data.recs || [];
    if (!n && !recs.length) return '';
    const parts = [];
    if (n) parts.push('📷 ' + n + ' 张');
    if (recs.length) parts.push('🎙️ ' + recs.length + ' 段 ' + this.data.recTotalText);
    return parts.join(' · ');
  },
  // 距离文案：客户无坐标 → '—'
  fmtDist(lat, lng, c) {
    if (!lat || !lng || !c || !c.lat || !c.lng) return '—';
    const d = haversine(lat, lng, c.lat, c.lng);
    return '距客户 ' + (d < 1000 ? Math.round(d) + ' 米' : (d / 1000).toFixed(1) + ' 公里');
  },
  // 距离行左侧图标：可多次点击 → 收敛精确定位；成功刷新距离+恢复图标；失败保持原显示 + 6 秒倒计时冷却
  onLocRefresh() {
    if (this.data.locRefreshing || this.data.locCooldown > 0) return;
    this.setData({ locRefreshing: true });
    // 收敛约 3~6 秒：图标轮换字符转圈（JS 驱动，设备上 CSS 动画曾失效，勿用）
    const chars = ['◐', '◓', '◑', '◒'];
    this._spinIdx = 0;
    this._spinTimer = setInterval(() => {
      this._spinIdx = (this._spinIdx + 1) % 4;
      this.setData({ locSpinChar: chars[this._spinIdx] });
    }, 200);
    loc.calm().then(p => {
      loc.setCache(p.lat, p.lng);
      this.pendingLoc = { lat: p.lat, lng: p.lng };
      const nt = this.fmtDist(p.lat, p.lng, this.data.c);
      clearInterval(this._spinTimer);
      this.setData({ locRefreshing: false, distText: nt }); // 成功：图标恢复，可再点
    }).catch(() => {
      /* 不收敛：保持原显示；6 秒冷却倒计时（6→1 显示完恢复可点），避免连续刷定位 */
      clearInterval(this._spinTimer);
      this.setData({ locRefreshing: false, locCooldown: 6 });
      clearInterval(this._cdTimer);
      this._cdTimer = setInterval(() => {
        const v = this.data.locCooldown - 1;
        if (v <= 1) {
          clearInterval(this._cdTimer);
          this.setData({ locCooldown: 0 }); // 倒数到 1 即恢复
        } else {
          this.setData({ locCooldown: v });
        }
      }, 1000);
    });
  },
  hideConfirm() { this.setData({ confirmShow: false }); },

  // ===== 取消本次拜访（老板 2026-09-04 定：主动撤销，客户仍为待回访；无需定位） =====
  askCancel() { this.setData({ cancelShow: true }); },
  hideCancel() { this.setData({ cancelShow: false }); },
  async doCancel() {
    if (this.cancelling) return;
    this.cancelling = true;
    wx.showLoading({ title: '取消中…', mask: true });
    try {
      const res = await api.call('visits', { action: 'cancel', taskId: this.data.c.taskId, customerId: this.data.c._id });
      wx.hideLoading();
      this.cancelling = false;
      this.setData({ cancelShow: false });
      if (res.ok) {
        this.clearStart(); // 取消拜访：计时基准清除，下次进入重新计时
        loc.beacon(); // 状态信标：拜访中→待回访（2026-09-08 老板定）
        api.toast('已取消本次拜访');
        setTimeout(() => wx.navigateBack(), 900);
      } else {
        api.toast(res.msg || '取消失败');
      }
    } catch (e) {
      wx.hideLoading();
      this.cancelling = false;
      this.setData({ cancelShow: false });
      api.toast('取消失败，请重试');
    }
  },

  // 第 2 步：确认提交 —— 先上传现场证据（成功才落库；已传的自动复用，失败可重试），再提交拜访
  async confirmSubmit() {
    if (this.submitting) return;
    // 2026-09-11：后台「强制拍至少 1 张」开启时前端先拦一次（云端 visits.submit 同样校验）
    if (this.evidenceRequired && !this.data.pics.length) { api.toast('请至少拍 1 张现场照片'); return; }
    this.submitting = true;
    try {
      // 0) 录音若仍在进行：先自动停止，等文件就绪
      if (this.data.recState === 'rec') {
        await new Promise(ok => { this._recStopResolve = ok; this.stopRec(false); });
      }
      // 1) 现场证据上传（无证据直接跳过）
      const hasEv = this.data.pics.length > 0 || (this.data.recs || []).length > 0;
      if (hasEv) {
        wx.showLoading({ title: '上传现场证据…', mask: true });
        try {
          await this.uploadEvidence();
        } catch (e) {
          wx.hideLoading();
          this.submitting = false;
          api.toast('证据上传失败，请检查网络后重试');
          return;
        }
        wx.hideLoading();
      }
      // 2) 提交拜访
      wx.showLoading({ title: '提交中…' });
      const photos = this._evPhotos || [];
      const audios = this._evAudios || [];
      const audio = audios.length ? { fileID: audios[0].fileID, duration: audios[0].duration } : null;
      const res = await api.call('visits', {
        action: 'submit',
        taskId: this.data.c.taskId,
        customerId: this.data.c._id, freeTripId: this.data.c.freeTripId || '',
        result: this.data.result,
        text: this.data.text,
        samples: this.data.samples,
        durationSeconds: this.data.pendingSeconds,
        ...this.pendingLoc,
        photos,
        audios,
        audio
      });
      wx.hideLoading();
      this.submitting = false;
      this.setData({ confirmShow: false });
      if (res.ok) {
        this.clearStart(); // 提交成功：计时基准清除，下次进入重新计时
        loc.beacon(); // 状态信标：拜访中→已回访（2026-09-08 老板定）
        // 2026-09-11 M2b：转写兜底 —— 对「勾选但还没提交转写」的段触发（提前点过「开始转录」的段不重复计费）
        if (!res.boss && res.visitId) {
          const idx = (this.data.recs || [])
            .map((r, i) => (r.transcribe && !r.trStatus && r.fileID ? i : -1))
            .filter(i => i >= 0);
          if (idx.length) api.call('transcribe', { action: 'start', visitId: res.visitId, segIndexes: idx }).catch(() => {});
        }
        this._evPhotos = null; this._evAudios = null; this._evAudio = null;
        const pool = PRAISE[this.data.result] || ['辛苦啦！拜访已提交 ✓'];
        const line = pool[Math.floor(Math.random() * pool.length)];
        api.toast(line, 'success');
        // ⭐ 2026-10-02：回去的层数按场景区分 ——
        //   任务内拜访：回退两层（拜访记录页 → 客户详情页，原有行为）
        //   自由拜访（从「我的 → 我新加的店」来）：只回一层，回到那个列表
        setTimeout(() => wx.navigateBack(this.data.c.taskId ? { delta: 2 } : {}), 900);
      } else if (res.code === 'TOO_FAR') {
        // 证据已上传完成：重试自动复用（_evPhotos/_evAudios 保留），不重复传
        api.toast(`距客户 ${res.distance} 米，超限`);
      } else {
        api.toast(res.msg || '提交失败，请重试');
      }
    } catch (e) {
      wx.hideLoading();
      this.submitting = false;
      api.toast('提交失败，请确认云函数已部署');
    }
  },
  // 上传录音段（已传的跳过；返回最新列表）—— 未勾选转写的段也上传留档，只是不提交识别
  async uploadAudios() {
    const recs = [...(this.data.recs || [])];
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].up && recs[i].fileID) continue;
      if (!recs[i].path) continue;
      const fileID = await media.uploadFile(recs[i].path, recs[i].ext || this.recorder.uploadExt);
      recs[i] = { ...recs[i], up: true, fileID };
      this.setData({ recs });
    }
    return recs;
  },
  // 上传照片（原图+缩略图双轨）与录音段；逐张进行，已上传的跳过（断网重试不重复传）
  async uploadEvidence() {
    const pics = this.data.pics;
    for (let i = 0; i < pics.length; i++) {
      if (pics[i].up) continue;
      const fileID = await media.uploadFile(pics[i].orig, '.jpg');
      const thumbID = await media.uploadFile(pics[i].thumb, '.jpg');
      pics[i] = { ...pics[i], up: true, fileID, thumbID };
      this.setData({ pics });
    }
    this._evPhotos = pics.map(p => ({ fileID: p.fileID, thumbID: p.thumbID }));
    const recs = await this.uploadAudios();
    this._evAudios = recs.filter(r => r.fileID).map(r => ({ fileID: r.fileID, duration: r.sec, transcribe: !!r.transcribe }));
    this._evAudio = this._evAudios.length ? { fileID: this._evAudios[0].fileID, duration: this._evAudios[0].duration } : null;
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
