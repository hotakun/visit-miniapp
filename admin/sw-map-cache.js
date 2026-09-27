// 聚火拜访 · 地图 SDK 本地缓存（Service Worker）—— 2026-09-27 老板定："只缓存 SDK 本体"
//
// 背景（均为当天实测结论）：
//   TMap GL 属于**矢量地图**，它的瓦片 / 埋点 / key 校验等请求 URL **都带随机参数**
//   （例如 `cb=TMap._svcb.cbmujtaukh`）→ **缓存命中率恒为 0**，只会让缓存无限膨胀；
//   ⇒ 因此收窄为：**只缓存 SDK 本体那一个稳定 URL**。
//
// 收益：`https://map.qq.com/api/gljs?...` 体积约 **2.2MB**，URL 稳定 ⇒ **二次打开直接读本地，首屏明显更快**。
// 范围：除 SDK 本体外，**所有请求一律放行、不缓存**（绝不拦在地图请求的路径上，对地图行为零影响）。
// 安全：不读取、不改写、不外传任何内容；不涉及账号/密码/token。
// 关闭办法（任一）：
//   ① 控制台：navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))
//   ② 改下面 CACHE 的版本号（旧缓存会自动清掉）

const CACHE = 'jh-map-sdk-v1';
const PREFIX = 'jh-map-';                                        // 本 SW 管理的缓存前缀（升级时清旧版本）
const SDK_RE = /^https?:\/\/map\.qq\.com\/api\/gljs(\?|$)/i;     // 只认 SDK 本体
let HIT = 0, MISS = 0;                                           // 命中/未命中计数（可查询）

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      // 清掉本 SW 的旧版本缓存（含早期实验期的 jh-map-tiles-*）
      await Promise.all(keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k)));
    } catch (e) { /* 静默 */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url = '';
  try { url = req.url; } catch (e) { return; }
  if (!SDK_RE.test(url)) return;                                 // ★ 只管 SDK 本体，其余全部放行

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ① 优先读本地（ignoreVary：防腾讯响应头里的 Vary 导致"明明存了却读不到"）
    try {
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) { HIT++; return hit; }
      MISS++;
    } catch (e) { /* 读缓存失败 → 继续联网 */ }
    // ② 本地没有 → 联网，成功后写缓存
    try {
      const resp = await fetch(req);
      // ⚠️ SDK 是 <script> 跨域加载 → 响应类型是 opaque（status 恒为 0，读不到内容但**能存、能完整回放**）
      //    ⇒ 必须放行 opaque，否则永远存不进去（2026-09-27 实测踩到）。
      if (resp && (resp.status === 200 || resp.type === 'opaque')) {
        try { await cache.put(req, resp.clone()); } catch (e) { /* 超配额等：忽略，不影响本次返回 */ }
      }
      return resp;
    } catch (e) {
      // ③ 断网且本地没有 → 空响应兜底（不让页面抛未捕获异常）
      return new Response('', { status: 504, statusText: 'sdk-offline' });
    }
  })());
});

// 自查接口：页面/控制台发 {cmd:'stats'} 即可拿到命中情况
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.cmd === 'stats') {
    const reply = { cmd: 'stats', hit: HIT, miss: MISS };
    if (event.source) event.source.postMessage(reply);
    if (self.clients && self.clients.matchAll) self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage(reply)));
  }
});
