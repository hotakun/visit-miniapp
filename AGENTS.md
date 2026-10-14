# AGENTS.md — 聚火拜访（微信小程序 + Web 管理后台 + 微信云开发）

项目：客户回访 / 新客开发管理系统。业务员用微信小程序执行拜访任务，老板用 Web 后台（账号 `qingyan`）派单与看板。

**当前状态：已上线在跑**（老板日常在用，不再是"待部署"）。已落地：一期闭环 / 服务号通知 / 坐标报错审核 / 现场证据（拍照·录音）/ 任务历史与自动归档 / 手机地图 / 客户批次管理 / 老板手机端四页 / 语音转写 / **客户数据落地（读走自己的服务器 PG）** / 加新店闭环 / 客户回收站 / 消息中心 / 拜访记录（走服务器 PG）/ 商城待配对（全部人工确认）。
**规模**：客户 **约 17.8 万家**、云函数 **12 个**、小程序 **18 页**、后台 `admin.html` 单文件（CRLF，1.36 万行）。

**⚠️ 当前待办（2026-10-14）**：
1. ~~重传 `adminapi`~~ ✅ **已重传**（2026-10-14，老板操作）—— 批次变动信号 + `stable_token` + `mallCodeFromName` 兜底都已生效（验证：`backfillMallCode` 返回小写 `aa067`）。
2. ~~文员端 `server.js`~~ ✅ **已重新上传到云端分发**（2026-10-14，4 个文件全部核对过：`adminHtml` 9 片 / `ntMapJs` / `serverJs` / `storeJs`）—— 文员端点「立即更新」后**重启后台**即生效。
3. 观察项：云开发控制台的「**数据库请求**」降了多少、「**QPS**」那条 500 红线是否还被顶到（批成员同步改造的成绩单）。

## 📚 详细内容都在 docs/（本文只留「命令 + 硬规矩 + 索引」）

| 去哪找 | 里面有什么 |
|---|---|
| **`docs/坑清单.md`** | ⭐ **实测踩过的坑 / 只能肉眼发现的坑 / 某功能的详细方案 / 三起事故背景** —— 查细节一律来这里 |
| **`docs/AGENTS旧版细则-20261014.md`** | ⭐ **要查具体技术线索**（函数名 / 常量名 / 字段名 / 排障步骤 / 细节口径）**来这里** —— 本文精简前的原文细则（一字未改） |
| `项目交接-当前进度.md` | 未决事项 + 最近快照（更早的按月归档在 `docs/历史/`） |
| `docs/历史/开发计划-2026-08原始需求.md` | 最初的需求详述与开发计划（2026-08，**当时口径**，部分已被演进取代） |
| `服务器运维手册.md` | 服务器 / 计划任务 / 应急恢复 |
| `docs/历史/AGENTS-全文-20261014.md` | 本文切分前的**全文留底**（保底，一般不用翻） |

---

## Commands

> ⚠️ 本节命令一律 **Git Bash** 语法（`cd /d/WFR/...`、用 `&&` 串联）。**在 PowerShell 里跑必须改**：路径写盘符形式、分隔符用 `;`（PS 5.x 不认 `&&`）。给老板的命令**先想清楚他在哪个终端**，拿不准就给 Git Bash 版。

- 后台启动：双击 `admin/启动管理后台.bat`（**端口 18080**；8581 曾落进 Windows 保留端口段 8523~8622 被系统拒绝，故换端口）；或 `cd admin && PORT=18080 node server.js`。地址 **http://localhost:18080**
- 语法检查：`node --check <file>`；`admin.html` 内嵌 JS 要用 python 提取 `<script>` 段后再 `node --check`
- 壳程序编译：`csc -target:winexe -platform:x64 -win32icon:icon.ico -r:lib/Microsoft.Web.WebView2.Core.dll -r:lib/Microsoft.Web.WebView2.WinForms.dll`（Git Bash 用 `-` 前缀防 MSYS 转义）；改壳后关壳再复制 exe 到 `admin/`
- 打包：`python make_packages.py`（只在重要节点）
- 部署：开发者工具逐个右键云函数「上传并部署：云端安装依赖」；小程序改动必须重新上传
- ⚠️⚠️ **调云端一律走 `stable_token`，绝不用老接口 `/cgi-bin/token`（2026-10-13 真实事故）**：老接口会把 pgsync / 后台正在用的 token 顶掉 → **后台数据停止更新**。
  · 取法：`POST https://api.weixin.qq.com/cgi-bin/stable_token`，body `{grant_type:'client_credential',appid,secret,force_refresh:false}`（样板 `admin/tools/pgsync.js` 的 `token()`）
  · 应急恢复：服务器上 `schtasks /end /tn JuhuoPgSync` 再 `/run`；监控页看「距今多久」
- 语音缓存：`curl -X POST http://localhost:18080/tts -H "Content-Type: application/json" -d '{"name":"范宇琨","type":"review"}'`
- 调后台接口：含中文一律用 UTF-8 文件 + `curl --data-binary @file`（命令行中文必乱码）
- ⭐⭐ **一键体检（改完代码必跑）**：`node admin/tools/check.js`（只读；**退出码 0 = 全过 / 1 = 有问题**；`-v` 列明细）
  · 它一次查 **12 项**：6 项基础（JS 语法 / `admin.html` 内嵌 JS / **行尾字节级** / JSON / WXML 配对 / adminapi 的 ACTIONS 白名单对账）+ **6 组跨文件对账**（拜访结果名一致性 / 前端 action 调用 / 页面跳转路径 / 隐私接口与老接口 token 护栏 / 本地缓存字段 / 商城字段链路）。
  · ⭐⭐⭐ **规矩：以后凡新增一处「同步点」（同一个清单要在两处各写一份），就必须顺手在 `check.js` 里加一条对账。** 加检查是一次性成本，漏改的代价是「不报错、只能肉眼发现」。
  · ⚠️ 加完检查必须**双向验证**：正常跑（应绿）→ **故意改坏**（必须报错）→ 恢复并**逐字节核对**。永远绿的检查等于没加。
- ⭐ **代码备份（三层）**：① 本地工作区 + git ② GitHub `hotakun/visit-miniapp` ③ 腾讯云服务器 `124.222.29.73` → `D:\WFR\visit-miniapp-备份\`
  · `git bundle create /tmp/visit-miniapp-<日期>.bundle --all` → `scp` 过去；**每次都要做"恢复演练"**（clone 出来看一眼关键文件在不在 → 再删）。**没演练过的备份不算备份**
  · 服务器 SSH 密钥 `C:\Users\Hotakun\AppData\Roaming\reasonix\global-workspace\.ssh\wfr_server`（账号 `Administrator`）；⚠️ 服务器**桌面**实际在 `D:\Users\Administrator\Desktop`；桌面上原有的 `Restart-Maps.bat`、`MAPQHD 快捷方式` **别删别改**

---

## Architecture

- **小程序**（`miniprogram/miniprogram/`）**18 页**（照 `app.json` 的 `pages`，别再照旧文档的"15 页"）：home / login / task / customer / visit / map / mine / tasks-all / bossWar / notes / notes-editor / newshop / myshops / newshops / freevisit / freevisit-map / **coordfix**（📍报错整屏取点页）/ **custedit**（更正信息）；公共层 `utils/api.js`（**云函数调用单入口 `api.call(name, data)`，别绕开**）、`utils/media.js`、`utils/notes.js`、`utils/gps/`。`app.js` 配 envId `cloud1-d0gwlmbwp31181eb5` + `APP_VERSION`。
- **云函数 12 个**（`miniprogram/cloudfunctions/`）：`adminapi`（**后台唯一入口**，130+ action）/ `tasks` / `visits` / `login` / `transcribe`（腾讯云 ASR 转写，带 `transcribePoll` 定时器每 5 分钟）/ `coordfix` / `importdata` / `init`（建集合自愈）/ `subscribe` / `bindadmin` / `ping` / `seed`。
- **后台**（`admin/`）：`admin.html` 单文件前端（**CRLF**，1.36 万行 = 13,680 行）+ `server.js` 本地代理（HTTP API 直连 + `/mpTokenRefresh`）+ **`store.js` 本地缓存层** + `nt-map.js` + `tts_gen.py`。
  - **`store.js`**：客户点缓存到 `admin/cache/map-points.json`，供地图与**客户管理页/批次总表**秒读；接口 `GET /mapPoints`、`POST /mapPoints/refresh`、`GET /mapPoints/status`、**`POST /mapPoints/patch`**（写后回写）。`VERSION` 控制字段版本（**当前 = 6**，改字段就要 +1，否则老缓存不作废）。**拉取要带后台账号密码**（`STORE_AUTH`）。
  - **方案 C：建店后自动刷缓存**：手机端建店 → 写 `settings.custDirtyAt` → 后台读缓存时 `store.checkDirty()` → 有变动就 `custSync` 拉增量 → 前端每 15 秒问 `/mapPoints/status`（几 KB，**绝不重拉 22MB**）→ 条数变了就地重绘。缓存的 `maxU` 是**同步水位**（别用本地时钟打点）。
- ⭐⭐ **L4「数据自主」**：**写仍走云开发（唯一真相源），只把"读大头"搬走**；手机端一行没改；**服务器挂了后台自动回退云开发**。
  · 链路：`业务员手机 ──写──> 云开发 ──同步器(每5分钟)──> 服务器 PG ──只读API(18081)──> 后台读`
  · 服务器 `124.222.29.73`：**PostgreSQL 18.6**（库 `juhuo`，**公网不开**）+ 两个用户（`juhuo_ro` 只读给 API / `juhuo_rw` 读写给同步器）+ 表 `customers`/`orders`/`sync_state`/`sync_cursor`/`deleted_ids`/批次相关 + **`pgapi.js`**（只读 API + 监控页）/ **`pgsync.js`**（同步器）。配置在 `admin/config.json` 的 `pgApiUrl`+`pgApiToken`。
  · **监控页** `http://124.222.29.73:18081/status?pw=juhuo`；服务器桌面另有 `服务器监控.html`。
  · **5 个计划任务**（`JuhuoPgApi` / `JuhuoPgSync` / `JuhuoNginx` / `JuhuoReboot3` / `JuhuoReboot18`，均 BootTrigger+SYSTEM）；**每天 3:00 / 18:00 自动重启**服务器。
  · ⭐⭐ **「有变动才跑」（2026-10-14 方案 D，老板定）** —— 同步器原来**每轮无条件跑 7 件事**（`pollDirty`/`custSync`/`batch_members`/`customer_batches`/`tasks`/`visited_customers`/`visits`/`mall_pending` ≈ 2100 次/天，绝大多数是"没人在用"的空转）。现在：
    `round()` 开头**先读一次 `pollDirty`**（1 次调用带回云端全部变动时间戳）→ **三个信号都没变 → 整轮只花这 1 次调用**，跳过其余全部；
    **兜底**：信号一直没变也每 **2 小时**无条件跑一轮（防某处漏写信号 → 静默不更新）；⚠️ 计时**只在"真正跑全套"时才重置** → 只要有人在用就一直重置、兜底根本轮不到。
    ✅ **写点已补齐**（2026-10-14，**需重传 `adminapi` 生效**）：`taskDirtyAt`（建/改/删/派/撤任务 6 处）+ `custDirtyAt`（删客户 / 恢复客户 2 处）→ 这些动作**即时反映**；兜底只当"漏信号的保险"。
    ⚠️ 改动**只在服务器上的 `admin/tools/pgsync.js`**（信号写点在云函数里，见下）。
  · ⭐ **批次成员同步（2026-10-14 改造，省掉一天约 160 万次读写）**：平时走 `_id` 游标**增量**（水位存 `sync_cursor` 表）→ 后台建/删批次、加/移成员时写 `settings.batchDirtyAt`（云端 `touchBatchDirty()`，**5 个写点**，3 秒防抖）→ 靠 `pollDirty` **顺带带回**（零额外调用）→ 同步器**只在信号变过时**全量对账（增量感知不到"删除"）+ 6 小时兜底。写库走**批量 upsert**。⚠️ **改了云函数写点必须重传 `adminapi`**。
  · ⚠️ **四个静默坑**：① 建表 SQL 必须 `SET client_encoding='UTF8'`；② `custSync` 返回字段名是 **`points`**；③ 手动重启 pgapi 要 `schtasks /end` 再 `/run`；④ **`sync_state.watermark` 是 `bigint`，存不了字符串 `_id`** —— 字符串游标要用 `sync_cursor`（详见 `docs/坑清单.md`）。
- **壳程序**（`packager/shell/`）：无边框 WebView2 壳（普惠体 / DPI 声明 PMv2 / 禁右键禁 F5 / 自定义最大化）；标题条按钮遍历必须 `foreach (Control b in right)`。⚠️ `D:\JuHuoVisit\` **不是常驻目录**（那是 `install.bat` 的安装目标，平时不用它启动后台）。

---

## Conventions（硬规矩 —— 每次干活都要遵守）

- 🔴🔴🔴 **「店铺信息」绝不允许自行 添加 / 更改 / 合并（2026-10-12 老板两次严令，最高红线）**
  · 老板原话：① 「**客户判断以后你不能想当然的去动，这个责任不能交给你**」② 「**你绝对绝对不能自主添加和更改合并任何店铺信息，必须要操作员同意之后才能更改，而且必须留下备案，以便回退！！**」
  · **规矩**：① 一个字段都不许自主改；② 必须老板明确同意（**说清「改哪条 id / 改成什么 / 依据」**）；③ ⭐ 每次改动**留备案、可回退**；④ 判断类的事**一律不拍板**，只出「待确认清单」；⑤ **不确定就说不确定**。
  · 事故背景见 `docs/坑清单.md` 第十二节。
- 🔴🔴 **「页面身份只准从 URL 来」（2026-10-12 串档事故的根治铁律）**
  · ① 「当前是哪家店」**只读 URL 的 `?id=`**，没带就报错，**绝不从 storage 兜底**；② **凡跳客户详情页的入口必须带 `?id=`**（现有 5 处：`task.js`/`map.js`/`myshops.js`/`newshops.js`/`freevisit/freevisit.js`）—— **新加入口先问自己：带 id 了吗？不带 = 埋雷**；③ `storage.curCustomer` 只放辅助信息，**绝不当身份用**；④ 换了客户，旧的 `taskId` 一律不带。
- ⭐⭐ **「拜访页强行离开 = 有内容自动提交 / 全空自动取消」（2026-10-12）**：`visit.js` 的 `onUnload` 只在**没走过正常提交/取消**时接管（判据 `this._startKey` 还在）；有内容（结果/文字/样品/照片/录音任一非空）→ **自动 submit（结果空着也交，内容先保住）**；全空 → **自动 cancel**。⚠️ 编辑模式与游客**不碰**。⚠️ 连带坑：**「切换到那家」是 `redirectTo`、也会触发 `onUnload`**，它必须先 `clearStart()`。
- **双工作台（方案 D，2026-09-23）**：后台**保留** 🔥 回访 / 🌱 新客**两个入口与数据分区**，但**台内共用一套实现**；手机端**不按类型分叉**；**数据模型永远只有一套 `customers`**（+ `customerType`）。
- **口径字典**：回访客户（不叫商城客户）；「激活增单/走访维护/活动推广」=回访三目的（`activate`/`maintain`/`promote`）；新客=`develop`；「注册商城时间」；「签约业务员」；坐标状态 `ok`=正常 / `pending`=补标 / `pending_confirm`=待定；坐标显示**纬度在前**。
  · 🔴⚠️ **`customerType` 是「客户线」，不是「是否加入商城」的标记**（2026-10-14 我搞错过一次，已回退）：
    `customerType: 'mall'` = **回访线**、`'new'` = 新客线 —— ⚠️ **全库 17.87 万家都是 `mall`**（含十几万平台导入的老客户），
    后台那一列显示的是「**回访**」/「新客户」，与"加没加入商城"**无关**。
    ✅ **判「是否加入商城」只看 `mallKey` / `mallJoinedAt`**（后台原话：`c.mallJoinedAt || c.mallKey ? '已入商城' : '未入商城'`）。
    所以**别拿 `customerType === 'mall'` 去当"商城客户"**，也别为这个改 `customerType`（改了会把店显示成"新客户"）。
- **任务编号**：`区域码-8位混码` 如 `JH05-42379761`（混码不可逆查库）。**截止日**：开始日=第 1 天；**截止日当天 0 点起即截止**（全完=已完成，否则=已过期）。**单开**：同任务同时只允许 1 家拜访中（start 拦截）；**取消拜访=直接删除不留痕**。**坐标报错**：手机端报错 → 后台审核；**同意不写回坐标，改 `pending_confirm` 待定**。**定位校验**：阈值 1~500 整数，0/不勾=关闭，默认 100 米，失败拦截提交。
- **照片显示铁律（30 元教训定稿）**：缩略图 canvas 一次绘制、**零分支零循环**（320×240 中心裁切 + quality70）；显示格宽高**固定像素写死**（拜访页 **192×144rpx**、坐标弹窗 88×66px、历史卡 84×63px）；**上限默认 9，后台可配 3/6/9/15**（别写死）；mode `scaleToFill`；三格绝对一样大。**被否过的方案别再试**（min-width+absolute / aspectFill / widthFix / letterbox / 1:1 / padding 撑高）。
- **录音口径**：**最多 6 段**；单条上限**跟后台档位**（180/300/600 秒，**禁止写死**）；合计 **30 分钟**硬封顶；安卓 mp3(16k/32kbps)、**iOS 用 aac(.m4a)**；mp3 失败自动降级；试听/上传前 `saveFile` 转存（**转存后必须回写路径**）；`obeyMuteSwitch=false`。⚠️ **`rm.start()` 必须传 `duration`（毫秒）** —— 不传默认 60000，会被系统 1 分钟截停。
- **版本号提升必须经老板确认**：改完**先别动 `APP_VERSION`**，可以建议、**但必须等他点头**。⚠️ 机制：**后台 `admin.html` 的 `APP_VERSION` 是文员端「检查更新」的判据** —— 改了后台又想发给文员就**必须** bump；小程序 `app.js` 的版本号只用于显示。**当前 `0.9.20`**。
- **导入**：免费环境云函数入参 **100 KB 上限**，大导入必须**前端分片（按字节 60~70 KB/片）+ 断点续跑**；自动建批只第一片锁定 batchId；`decisions` 必须传数组。
- **商城侧字段：一张表说了算**：**唯一真相 = `adminapi` 的 `MALL_FIELD_PAIRS`**（`runMallMatch` / `applyMallMatch` / `refreshFromMall` 三条链路共用）。
  · 🔴🔴 **铁律：合并时店名一律以商城为准（2026-10-13）** —— 合并写 `name` 时**必须同时写 `nameRaw`**（落地：`mallFieldsFrom()` 末尾 `if (out.name) out.nameRaw = out.name;`）。因为列表/任务页读的是 `nameRaw || name`，只改一个就会「详情页新名、列表旧名」。**以后任何"会改店名"的链路都必须同步 `nameRaw`**。
  · ⚠️ **坐标绝不覆盖（`MALL_NO_TOUCH` 代码级硬拦）**：商城坐标是注册时填的，**业务员现场采的才是真到过那个点**。⚠️ **商城值为空 → 不覆盖**。
  · ⚠️ **建档口径**：「已加入商城」**只能由导入商城表比对决定**（那个手动「已建档」按钮已删）；`source:'field'` 的现场录入店**也要纳入比对池**。
  · ⚠️ **`mallCode`（客户编号）是订单匹配钥匙**（`orders.customerCode`）—— 链路各端都要有它。⚠️ **`lastOrderAt` 不许再加进 `MALL_FIELD_PAIRS`**（商城快照会盖掉 orders 的真实日期；体检有护栏）。详见 `docs/坑清单.md`。
- **批次 = 指针表（2026-10-10）**：**`batch_members` 是唯一记账**，`customers.batchIds` **已废弃、不许再写**；**删批 = 删成员条目 + 删卡，客户档案一个字不碰**。读「谁在哪些批次」一律查 `batch_members`（云端）或 PG 的 JOIN。⚠️ **新表建成后必须 `GRANT SELECT ... TO juhuo_ro`**（漏了 pgapi 直接 500）。**批次卡铁律**：一批次全部信息只在一张卡内，绝不分开。
- **建任务仍走批次**：`🏪 客户管理` 按 城市/区域/商圈 筛 → 勾选 → 「📦 建立批次」→ `📦 批次管理` 批次卡 → 选客户 + 选业务员 → 建任务。⚠️（**两个页签名 2026-09-26 互换过**：`🏪 客户管理` = 筛客户建批次；`📦 批次管理` = 批次卡派单。**内部标识 `#page-geo` / `#page-customers` 从未改**。）
- ⭐⭐ **客户删除 = 回收站（软删）**：只写 `deleted:true`+`deletedAt`+`deletedBy`，**数据一条不丢**（恢复=去掉标记，批次/拜访/照片原地不动）；**不进客户总数、不上地图**。⚠️ **「任务中的客户一条都不能删」**（否则进度永远到不了 100%，还可能卡住"单开"）。⚠️ **删除不会通过增量同步传给后台** → 前端删完要自己调 `/mapPoints/patch` 摘缓存。⚠️ MongoDB 的 `$ne:true` 能匹配"字段不存在"；⚠️ **聚合 `.match()` 不认 `_.neq()`，必须用原生 `$ne`**。
- ⭐ **防重检测**（`tasks.newShopCheck` / `dupCheck`）：三档 —— `block`（**电话同号=铁证·拦**）/ `sameName`（同名·提示）/ `suspect`（相似·只预警）。⚠️ 电话比较用 **`phoneKey()` 去区号**（剥区号正则不能写 `^0\d{2,3}`，会把 `021-62888888` 剥成 `2888888`；正确 `/^0(?:10|2\d|[3-9]\d{2})/`）。⚠️ 查附近**必须分批拉到 300 条**（`.limit(50)` 且无 `orderBy` = 命中哪 50 条不确定，曾是"站在店旁边却说没有"的根源）。
- **「游客」= `users.trial` 实习账号，不要自己造游客页**：免注册入口进真实首页，**只读不绑定**（云端一个字不写库）；`visits`/`tasks`/`transcribe`/`coordfix` **四处硬拦 `TRIAL_FORBIDDEN`**；不进统计与战况。⚠️ 实习态在 `utils/api.js` 必须同时补 `asTrial`/`asTrialVisit`/`trialId` **三个字段**（少一个就坏）；⚠️ `home.js` 的身份复核**对实习要直接 return**。
- **身份与通知收件人**：`13067737286` = **开发者本人**（系统里的业务员「范宇琨」，dev 白名单）；`15055492888` = 「**朱小利**」= **真老板**（`users.boss=true`）。**开发/运维类通知只发给后台设置项 `adminNotifyPhones`，不打扰朱小利**。
- **首页分享按钮**：必须是 `<button open-type="share">`（小程序没有"用代码拉起好友列表"的 API）；图标 `images/share-icon.png`；**定位与尺寸全部内联 style 写死 px**（别用 `rpx`、别用 `100%` 互定尺寸）。**分享封面**：`images/share.png`（500×400 JPEG）—— **换封面只换文件、不改 JS**。
- **地图标识口径**：**后台只显「聚火地图」**（右下角）；**手机端「两个共存」**（腾讯 logo+审图号**不能去掉**，合规；聚火 badge 挪**左上角**）。⚠️ 详细做法与 6 个坑见 `docs/坑清单.md` 第十节。
- **🔴 铁律：后台 TMap GL 的 `baseMap.features` 里 `building3d` 绝对不能动** —— 去掉/换成 `building2d` 会让**底图完全渲染不出来（整张地图全白）**。**正确**：`baseMap: [{ type:'vector', features:['base','building3d','label'] }]`。**结论：代码里标着「实测」「别动」的注释优先于官方文档 —— 实测 > 文档。**
- ⭐⭐⭐ **「改完之后必须真的刷新」（2026-10-10 老板三次点名）**：任何"改/删"成功后**必须先作废缓存、再刷新列表** —— 本项目就是 **`invalidateBatches()` → `loadBatches()`**（**顺序不能反**，只调后者=拿到 60 秒旧缓存）。判断口径：**"这个操作改了数据，界面靠什么显示它？那份数据有缓存吗？"**
- ⭐⭐⭐ **后台调云函数走【HTTP API】，超时只有 ~4~5 秒**（**不是文档里的 30 秒**）：实测 `deleteCustomerBatch` **300 家=3.6 秒 ✅ / 800 家=5.9 秒 ❌ `-601008`**。⚠️ **所有批量操作单轮耗时压在 3 秒内**（`deleteCustomerBatch` 每轮 200 家、`addBatchMembersBulk` 每片 200 个 id；经验值"一次 update 一家 ≈ 8~12 毫秒"）。⚠️ 报 `-601008` 但你直调很快 → 就是被这条路掐了，**别去对着 30 秒调参**。**批量参数要从小往大试**。
- ⭐⭐⭐ **腾讯地图两把 key 别搞混**：`mpKey`（`SQWBZ-…`）= Web 端 JS API，**服务端算路会被拒**（`status:111 签名验证失败`）；**服务端算路只能用 `mpWSKey`（`QAFBZ-…`，不需要 SN 签名）**。⚠️ 症状对照：**任务地图路线变成"虚线直连+直线估算" = 算路失败**，八成是 key 用错。
- ⭐⭐⭐ **「看数据先读本地，云端只做同步」（架构级铁律）**：后台凡「**看 / 挑 / 筛**」客户与批次的界面**一律先读本地缓存**（`admin/cache/map-points.json` + `custLocalList()` 本地过滤）；**云端只负责把数据同步下来**。⚠️ **危险信号**：给云端传 `batchId` 却要"整批客户完整档案" —— 批次上千家**必然超时**（曾表现为「客户库为空，请先导入客户」，老板排查一上午）。**判断口径一句话：看/挑 → 本地；同步 → 云端。**
- **客户筛选与分辨是老板长期重点**，涉及改动主动提醒优化。
- **推荐人 / 业务员星级**：推荐人 = 谁分享的链接把人拉进来就记谁（`utils/share.js` + `app.js` 的 `captureRef()`；**存量只能后台手工补录**）；星级 = `users.star` **0.5~5 步长 0.5**（新人默认半星），后台人员管理可点。⚠️ 新增 action **必须同步补 `ACTIONS` 白名单**（坑 32）。详见 `docs/坑清单.md` 第八节。
- **任务历史**：过期 N 天（2/3/5，默认 3）自动归档、终态只读。**通知**：后台全局轮询（指纹增量）+ 响铃→云希语音→浮窗。**诊断数据用 adminapi（账号密码）**，别用云端测试测 `tasks`/`visits`（无 OPENID 必报 where undefined）。
- **行尾规矩**：⭐ **权威清单在代码里** —— 判断某文件该 CRLF 还是 LF **一律以 `admin/tools/check.js` 的 `CRLF_FILES` 为准**（**改换行前先看它，别照记忆**）。要点：`admin.html` 是**纯 CRLF**；⚠️ **`edit_file` 写入 `admin.html` 会带进裸 LF** → 改完要**字节级再数一遍**（`s.replace(/(?<!\r)\n/g,'\r\n')`）并重跑内嵌 JS 检查；⚠️ **判定必须字节级**（`grep -c $'\r'` 在 Git Bash 下恒返回 0，会骗人）；`.bat` 必须 CRLF。⚠️ **不要用 `git diff --check` 判断行尾**（`core.autocrlf` 下每行都报 trailing whitespace）。详细历史见 `docs/坑清单.md` 第九节。
- **WXML 只用 `view`/`text`，禁止任何 HTML 标签**（`div`/`br` 曾致白屏）；临时文件放 `_scratch/`（**不要主动清理**，等老板通知清零）。
- ⭐ **「大列表一律弹窗 + 滚动」（2026-10-12 老板定，长期规矩）**：凡是「一点就出一大堆」的结果（重复客户检测 / 商城配对 / 导入预览 / 任何长清单）—— **一律弹独立窗口 + 滚动**（`width:980px; max-height:88vh; overflow-y:auto`）+ 右上角常驻「✕ 关闭」；**绝不直接铺在页面上**。页面只留**一行摘要**；没结果就一行绿字。
- **🔴 界面要简洁，不要冗余的"说明性装饰"（2026-09-24 老板点名）**：原话「**我发现你很喜欢搞些不够简洁的东西**」。判据：① 一格只留"必要信息 + 必要操作入口"；② 统计数字放专门的地方，别塞进每行；③ 说明性文字**不进表格**；④ 操作**优先用图标**；⑤ 加 UI 前先问「**删掉它，会不会影响老板做决定？不会就别加**」。
- ⚠️ **icon 用字符不要用 emoji**：要灰色/跟随主题色就用 `✎`(U+270E) 这类**文字符号**（`color` 生效），别用 `✏️`（emoji 是彩色的，`color` 无效）。

---

## 协作节奏（长期约定）

- **文员包**只在重要节点或老板要求时打；**文档只记重要步骤**，小修小改不记。
- **每次改动后仍必须**：`node admin/tools/check.js`（体检）+ 按文件类型核行尾（字节级）。
- **⚠️ 汇报要短、不重复**：同一结论只说一次（改完 → 验证 → 报告一次就结束）；只有出现**新信息**才说话。
- **⚠️ 不确定就说不确定**，绝不把"我猜的"说成"已确认的"（这是最高红线的一条）。
