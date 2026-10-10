// 更正信息（2026-10-10 老板定）：现场发现店名 / 老板换了 → 当场更正客户档案。
//   · 表单 = 「加新店」第 2 步的同款字段（见 custedit.wxml / 样式 @import newshop.wxss）
//   · **预填这家店现在的信息**（来源：tasks.custEditInfo），业务员选择性修改
//   · 保存 = tasks.correctCustomer，**直接生效**（老板拍板）+ 留痕（customer_corrections）
//   ⚠️ 入口 = 客户详情页店名卡里那块 44×44（原「快速记事」，2026-10-10 改为「更正信息」）
const api = require('../../utils/api');
const WORDS = require('../../utils/newshop_words');

// ⚠️ 与 pages/newshop/newshop.js 同源（复制而来）：改那边时记得同步这里
const AREA_LIST = ['永康市', '金东区', '婺城区', '武义县', '浦江县', '磐安县', '兰溪市', '义乌市', '东阳市'];
const HOUR_LIST = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00');

// 招牌菜：自由输入，「、，；」隔开 → 实时拆成数组（与 newshop 同款）
function splitDishes(raw) {
  return String(raw || '')
    .split(/[、，,；;\n\r]+/)
    .map(x => x.trim())
    .filter((x, i, a) => x && a.indexOf(x) === i);
}

Page({
  data: {
    cid: '', busy: false,
    name: '', contact: '', phone: '', phone2: '', phone2Open: false,
    address: '', hourList: HOUR_LIST, hour1: '08:00', hour2: '21:00', hourIdx1: 8, hourIdx2: 21,
    areaList: AREA_LIST, area: '', areaIdx: 0, bizCircle: '',
    catRange: [[], [], []], catIdx: [0, 0, 0], catText: '', cat1: '', cat2: '', cat3: '',
    dishRaw: '', dishes: []
  },
  onShareAppMessage() { return require('../../utils/share').cfg(); },
  onLoad(options) {
    const cid = String((options && options.customerId) || '').trim();
    this.setData({ cid: cid });
    this._buildCat();
    this._load(cid);
  },
  // 拉这家店现在的信息 → 预填（⚠️ 拉不到就用空表单，让业务员自己填）
  async _load(cid) {
    if (!cid) { wx.showToast({ title: '缺少客户信息', icon: 'none' }); return; }
    wx.showLoading({ title: '加载中…', mask: true });
    let s = null;
    try {
      const r = await api.call('tasks', { action: 'custEditInfo', customerId: cid });
      if (r && r.ok) s = r.cust || {};
      else throw new Error((r && r.msg) || '加载失败');
    } catch (e) {
      console.error('[custedit] 加载失败', e);
      wx.hideLoading();
      wx.showToast({ title: '加载失败，请返回重进一次', icon: 'none' });
      return;
    }
    wx.hideLoading();
    // 营业时间：存的是 "08:00-21:00"（对不上就用默认值）
    let h1 = 8, h2 = 21;
    const hm = String((s && s.hours) || '').match(/^(\d{1,2}):00\s*-\s*(\d{1,2}):00$/);
    if (hm) { h1 = Math.min(23, Math.max(0, parseInt(hm[1], 10))); h2 = Math.min(23, Math.max(0, parseInt(hm[2], 10))); }
    const ai = Math.max(0, AREA_LIST.indexOf(String((s && s.area) || '')));
    const c1 = (s && s.cat1) || '', c2 = (s && s.cat2) || '', c3 = (s && s.cat3) || '';
    this.setData({
      name: (s && s.name) || '', contact: (s && s.contactName) || '',
      phone: (s && s.phone) || '', phone2: (s && s.phone2) || '', phone2Open: !!(s && s.phone2),
      address: (s && s.address) || '',
      hour1: HOUR_LIST[h1], hour2: HOUR_LIST[h2], hourIdx1: h1, hourIdx2: h2,
      area: AREA_LIST[ai] || '', areaIdx: ai, bizCircle: (s && s.bizCircle) || '',
      cat1: c1, cat2: c2, cat3: c3,
      catText: [c1, c2, c3].filter(Boolean).join(' · '),
      dishRaw: ((s && s.dishes) || []).join('、'), dishes: (s && s.dishes) || []
    });
    // 品类 picker 定位到现有值（找不到就停在第 0 项）
    this._syncCatIdx(c1, c2, c3);
  },
  // ---------- 输入 handler（与 newshop 一致）----------
  onName(e) { this.setData({ name: e.detail.value }); },
  onContact(e) { this.setData({ contact: e.detail.value }); },
  onPhone(e) { this.setData({ phone: e.detail.value }); },
  onPhone2(e) { this.setData({ phone2: e.detail.value }); },
  addPhone2() { this.setData({ phone2Open: true }); },
  delPhone2() { this.setData({ phone2Open: false, phone2: '' }); },
  onAddress(e) { this.setData({ address: e.detail.value }); },
  onHour1(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ hourIdx1: i, hour1: HOUR_LIST[i] || '08:00' });
  },
  onHour2(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({ hourIdx2: i, hour2: HOUR_LIST[i] || '21:00' });
  },
  onArea(e) {
    const i = Number(e.detail.value);
    this.setData({ areaIdx: i, area: AREA_LIST[i] || '' });
  },
  onBiz(e) { this.setData({ bizCircle: e.detail.value }); },
  onDish(e) { this.setData({ dishRaw: e.detail.value, dishes: splitDishes(e.detail.value) }); },

  // ---------- 品类三级联动（与 newshop 同款：滚动即写）----------
  _buildCat() {
    const cat = WORDS.cat || {};
    const c1 = Object.keys(cat);
    const c2 = c1.length ? Object.keys(cat[c1[0]] || {}) : [];
    const c3 = (c1.length && c2.length) ? ((cat[c1[0]] || {})[c2[0]] || []) : [];
    this._cat = cat;
    this.setData({ catRange: [c1, c2, c3], catIdx: [0, 0, 0] });
  },
  // 把已存的 cat1/2/3 定位到 picker 索引（⚠️ cat1 存的是**去图标**的，见 _plainCat）
  _syncCatIdx(c1, c2, c3) {
    const cat = this._cat || {};
    const k1 = Object.keys(cat);
    const i1 = k1.findIndex(x => this._plainCat(x) === c1);
    if (i1 < 0) return;
    const k2 = Object.keys(cat[k1[i1]] || {});
    const i2 = Math.max(0, k2.indexOf(c2));
    const arr3 = (cat[k1[i1]] || {})[k2[i2]] || [];
    const i3 = Math.max(0, arr3.indexOf(c3));
    this.setData({ catRange: [k1, k2, arr3], catIdx: [i1, i2, i3] });
  },
  _plainCat(s) {
    const a = Array.from(String(s || ''));
    let i = 0;
    while (i < a.length && !/[\u4e00-\u9fa5A-Za-z0-9]/.test(a[i])) i++;
    return a.slice(i).join('').trim();
  },
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
    // 滚动即写（与 newshop 一致：原生 picker 不点"确定"也给值）
    this.setData({
      catRange: [c1, c2, c3], catIdx: idx,
      catText: [c1[idx[0]], c2[idx[1]], c3[idx[2]]].filter(Boolean).join(' · '),
      cat1: this._plainCat(c1[idx[0]]), cat2: c2[idx[1]] || '', cat3: c3[idx[2]] || ''
    });
  },
  onCat(e) {
    const v = (e.detail.value || []).map(Number);
    const [c1, c2, c3] = this.data.catRange;
    this.setData({
      catIdx: v,
      catText: [c1[v[0]], c2[v[1]], c3[v[2]]].filter(Boolean).join(' · '),
      cat1: this._plainCat(c1[v[0]]), cat2: c2[v[1]] || '', cat3: c3[v[2]] || ''
    });
  },

  // ---------- 保存更正（直接生效）----------
  async save() {
    const d = this.data;
    if (d.busy) return;
    const name = String(d.name || '').trim();
    const contact = String(d.contact || '').trim();
    const phone = String(d.phone || '').trim();
    const address = String(d.address || '').trim();
    if (!name) return wx.showToast({ title: '请填店名', icon: 'none' });
    if (!contact) return wx.showToast({ title: '请填联系人', icon: 'none' });
    if (!phone) return wx.showToast({ title: '请填电话', icon: 'none' });
    if (!address) return wx.showToast({ title: '请填地址', icon: 'none' });
    const ok = await new Promise(res => wx.showModal({
      title: '确认更正',
      content: '保存后这家店的信息会立即更新（会记下是你改的）。',
      confirmText: '保存', cancelText: '再想想',
      success: r => res(!!r.confirm), fail: () => res(false)
    }));
    if (!ok) return;
    this.setData({ busy: true });
    let r = null;
    try {
      r = await api.call('tasks', {
        action: 'correctCustomer',
        customerId: d.cid,
        name: name,
        contactName: contact,
        phone: phone,
        phone2: String(d.phone2 || '').trim(),
        address: address,
        hours: d.hour1 + '-' + d.hour2,
        area: d.area,
        bizCircle: String(d.bizCircle || '').trim(),
        cat1: d.cat1, cat2: d.cat2, cat3: d.cat3,
        dishes: d.dishes
      });
    } catch (e) {
      console.error('[custedit] 保存异常', e);
      r = null;
    }
    if (!r || !r.ok) {
      wx.showToast({ title: (r && r.msg) || '保存失败，请稍后再试', icon: 'none' });   // 云端 msg 是人话
      this.setData({ busy: false });
      return;
    }
    wx.showToast({ title: '已更正 ✓', icon: 'success' });
    // ⭐ 项目铁律「改完之后必须真的刷新」：通知上一页（客户详情）重拉 → 再返回
    setTimeout(() => {
      try {
        const pages = getCurrentPages();
        const prev = pages[pages.length - 2];
        if (prev && typeof prev.onCorrectDone === 'function') prev.onCorrectDone();
      } catch (e) { /* 静默 */ }
      wx.navigateBack();
    }, 1100);
  }
});
