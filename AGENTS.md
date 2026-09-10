# AGENTS.md — 聚火拜访（微信小程序 + Web 管理后台 + 微信云开发）

项目：客户回访/新客开发管理系统。业务员用微信小程序执行拜访任务，老板用 Web 后台（qingyan）派单与看板。当前：一期验收闭环 + 服务号通知 + 坐标报错审核 + 现场证据（拍照/录音）+ 任务历史/自动归档 + 手机地图页 + 客户批次管理均已开发完成，**待部署上线**。
**切换会话/换人接手前，必读 `D:\WFR\visit-miniapp\项目交接-当前进度.md`（未决事项+坑清单+口径字典），详细设计见 `开发计划.md`。**

## Commands

- 后台启动：双击 `admin/启动管理后台.bat`（**固定 8581**；8080 被 EnterpriseDB Apache 占用，8081 被 Windows 排除端口段占用）；或 `cd admin && PORT=8581 node server.js`；依赖 xlsx（`npm install`）；语音另需 `pip install edge-tts`
- 后台地址：**http://localhost:8581**
- 语法检查：`node --check <file>`（云函数/页面 JS 全量）；admin.html 内嵌 JS 必须用 python 提取 `<script>…</script>` 后 `node --check`（sed 在 CRLF 下不可靠）
- 壳程序编译（Git Bash 用 `-` 前缀防 MSYS 转义）：`csc -target:winexe -platform:x64 -win32icon:icon.ico -r:lib/Microsoft.Web.WebView2.Core.dll -r:lib/Microsoft.Web.WebView2.WinForms.dll`；exe 被占用时先关后台再复制
- 打包：`python make_packages.py`（packager/，重要节点才打，见 Conventions）
- 部署：开发者工具逐个右键云函数「上传并部署：云端安装依赖」；小程序改动必须重新上传（体验版/正式版）
- 语音缓存接口：`curl -X POST http://localhost:8581/tts -H "Content-Type: application/json" -d '{"name":"范宇琨","type":"review"}'`（type=coordfix 为坐标报错文案）
- 调后台接口（含中文一律 UTF-8 文件 + `curl --data-binary @file`，命令行中文必乱码）

## Architecture

- `miniprogram/miniprogram/` 小程序 8 页（home/task/customer/visit/tasks-all/mine/map/login）+ `utils/media.js`（照片缩略图 drawOnce/coverJpg、录音 createRecorder 平台分化）；app.js 配 envId `cloud1-d0gwlmbwp31181eb5` + 全局审核观察员（reviewWatcher）
- `miniprogram/cloudfunctions/` 云函数 10 个：init（COLLECTIONS 自愈）、login、tasks（list 过滤 archivedAt；detail 返回 locCheck/coordFixPending/taskNo/recordingDurationLimit/logs）、visits（start 任务内单开拦截、submit 收 photos≤3{fileID,thumbID}+audio、cancel 直接删除零痕迹、history）、subscribe、coordfix（note+photos≤3 兼容旧 string）、bindadmin、seed、adminapi（后台唯一入口：任务 CRUD/导入分片/商城比对/**本地比对配套 listMallLibrary+applyMallMatch（比对在浏览器跑，云端只拉库写决定）**/审批/坐标审核/服务号通知/autoArchiveExpired 自动归档/客户备注/purgeUnbatchedCustomers 清空未分批/resetTestData 连删云存储文件）
- `admin/`：admin.html 单文件前端（CRLF）+ server.js 本地代理（HTTP API 直连 + /mpTokenRefresh 服务号 token 每 108 分钟同步）+ tts_gen.py（云希男声）+ voice/ 缓存 + notify.wav（任务审核响铃）+ bengbao.wav（坐标报错响铃）。已无 Web Push。
- `packager/shell/`：无边框壳 Program.cs（WebView2）：普惠体 55 Regular 内嵌 TTF、CS_DROPSHADOW、自定义最大化不盖任务栏、退出确认弹窗；标题条图标=通知(铃铛显隐)/**刷新(铃铛左侧自绘 Panel 旋转动画，点击=当前页刷新+autoArchiveExpired+响铃检测)**/设置/全屏/最小化/关闭；标题条 Control 遍历必须 `foreach (Control b in right)`（Panel 强转 Button 会启动崩溃）。**2026-09-08 DPI 大修**：Main 第一行声明 PMv2（否则 WebView2 中途提升 DPI→最大化盖任务栏）；初始窗口=工作区 96%×92% 手动居中（CenterScreen 会偏右下角）；标题栏按 DpiX/96 放大；禁右键+禁 F5/Ctrl+R；改壳必须 csc 重编译+关壳复制 exe 到 admin/ 与 D:\JuHuoVisit\admin\ +重打文员包

## Conventions

- **新客户与回访客户严格各自独立开发**（列表列、弹窗、按钮、文案各一套，禁止共用模板）——老板定死的原则
- 口径：回访客户（不叫商城客户）；「激活增单/走访维护/活动推广」=回访工作台三目的（值 activate/maintain/promote）；新客=develop；「注册商城时间」；「签约业务员」；坐标状态 ok=正常 / pending=补标 / pending_confirm=待定；坐标显示**纬度在前**（数据存储不动）
- 任务编号：`区域码-8位混码` 如 `JH05-42379761`（settings.taskRegionCode 可配，混码不可逆查库）
- 截止日：开始日=任务第 1 天；**截止日当天 0 点起任务即截止**（全完成=已完成，否则=已过期）；延期按新日期恢复
- 拜访中单开：同一任务同一时刻只允许 1 家拜访中（start 拦截，含已拜访客户）；**取消拜访=直接删除记录不留痕**；不做自动作废
- 坐标报错审核：手机端「📍 报错」→ coord_fix_requests(pending) → 后台审核；**同意不写回坐标，coord_status=pending_confirm 待定**（后台暗红胶囊只读查看）
- 任务结束：autoApproveFinish 勾选=全完自动通过；不勾选=人工审核；**提前交始终人工审核**
- 定位校验：阈值 1~500 整数；0/不勾选=关闭；默认 100 米；定位失败=拦截提交；前端文案按设置阈值展示（locCheck）
- **照片显示铁律（30 元教训定稿，勿再用被否方案）**：缩略图单次 canvas 绘制**零分支零循环**（320×240 中心裁切+quality70 固定）；显示格宽高**固定像素写死**（拜访页 212×159rpx / 坐标弹窗 88×66px / 历史卡 84×63px）；mode scaleToFill；三格绝对一样大；裁切丢内容没关系、原图保留点开看。被否方案：min-width+absolute、aspectFill 裁切、widthFix、letterbox 白底、1:1 方形、padding-top 撑高
- 录音（2026-09-11 更新口径）：**最多 6 段**；单条上限**跟后台「拜访录音上限」档位走**（180/300/600 秒，**禁止写死**，后台一改前端与云函数同步跟随）；**合计 30 分钟硬封顶**；安卓/鸿蒙 mp3(16k/32kbps)，**iOS 用 aac(.m4a)**（另有封顶）；mp3 失败自动降级 aac；试听/上传前 saveFile 转存（saveFile 是移动，转存后必须回写路径）；obeyMuteSwitch=false；路径存闭包变量
- **录音必须传 `duration`（2026-09-11 真机坑，现象"录音 1 分钟就停"）**：`wx.getRecorderManager().start()` 的 `duration` **单位是毫秒、默认 60000** → 不传就被系统 1 分钟截停；必须传 `秒数 * 1000`（详见交接文档 §4 坑 27）
- **上传改动到云端**：双击 `admin/上传后台到云端.bat`（= `admin/upload_dist.js`，自动读 `APP_VERSION` → 分片调 `adminapi.uploadAdminDist` 写 `settings/admin_dist` → 回查核对）。文员端在后台设置页点「检查更新 → 立即更新」拉取
- **后台版本号 = 「检查更新」判据（2026-09-11 老板定，不是"纯展示"）**：改后台代码**必须 bump `admin.html` 的 `APP_VERSION` 并上传云端**，否则文员永远显示"已是最新"、更新不到；小程序 `app.js` 的 `APP_VERSION` 与之保持一致（当前统一 **0.9.11**）。⚠️ 本地版本高于云端时文员会看到"发现新版本 v<旧>"，**别点「立即更新」（会降级）**，直接重新上传
- 导入：**免费环境云函数 30s 超时，大导入必须前端分片 100 条/片+断点续跑**；自动建批只第一片锁定 batchId 防每片各建一批；decisions 必须传数组
- 商城比对三档：≥75 自动认领 / 45~74 进 mall_claims 待确认 / 忽略；比对认领/待确认认领**按批次卡操作**（batchId）
- **批次卡铁律**：一个批次全部信息只在一张卡内，绝不分开；批内状态生命周期=新入批待回访→发布拜访中→完成已回访→撤回退回；统计实时算；业务员端不显批次名
- **客户筛选与分辨是老板长期重点，涉及改动主动提醒优化**
- 任务历史：过期 N 天（2/3/5 默认 3）自动归档终态只读；logs 统一流水；sendTask 不重置 createdAt
- 通知：后台全局轮询（指纹增量渲染）+ 响铃→1.6s→云希语音→浮窗；任务审核=notify.wav、坐标报错=bengbao.wav；手机端审核观察员（有 reviewing 才轮询）
- 诊断数据用 adminapi（账号密码），别用云端测试测 tasks/visits（无 OPENID 必报 where undefined）
- admin.html 是 CRLF，edit_file 后必须还原 CRLF；**WXML 只用 view/text，禁止任何 HTML 标签（div/br 曾致白屏）**；bat 必须 CRLF；临时文件放 `_scratch/` 用完即删
- **工作协作习惯（长期）**：文员包只在重要节点或老板要求时打包；文档只记重要步骤，小修小改不记；但每次改动后仍需语法检查 + CRLF 还原

## Notes

- 2026-09-04~06：一期验收闭环；服务号通知全链路（模板 kdgr7e7C…、token 108 分钟同步）；任务编号 JH05-混码；拜访中单开+取消删除；坐标报错审核+语音通知；地图选店三步向导+绿色蚂蚁线路线（方案 C=SVG 自绘层，nt-map.js）；定位体系大改（双档位刷新+高精度收敛加权质心）；坐标审核改「待定」口径；端口换 8581
- 2026-09-07：登录页记住我（只填充不自动登录）+全细体+按钮字重 400；拜访目的三选（服务号文案映射需重传）；天页签 ✓ 角标按规划方式变色；壳程序大改（普惠体/阴影/自定义最大化/退出确认）；客户批次管理方案定稿 §7.12
- 2026-09-08（明细见交接文档 §3.8/§3.9/§4 坑 25~27）：现场证据上线（拍照≤3 张+录音三档可设+提交才上传+取消零残留）；任务历史板块（当前/历史 Tab、自动归档、只读）；坐标修正拍照；**照片显示铁律定稿**（见 Conventions）；试听修复（闭包+obeyMuteSwitch+saveFile 转存）；历史卡录音播放控件；resetTestData 升级（连删云存储文件）；文员包已重打（12.98MB）
- 2026-09-08 后最新：**手机地图页**（独立自取任务、天页签、绿色路线 dayPlan[].route、下一家引导条+导航+去拜访，home 底部「🗺 地图」进入）；**导入分片 100/片+断点续跑**（-601008 超时教训）；**批次管理开发完成待部署**（批次卡/未分批清空/比对认领下沉批次卡）；客户备注卡；登录预填+记住我默认勾选；壳程序刷新图标；手动刷新=当前页刷新+autoArchiveExpired+响铃检测；后台照片点击=页内 photoOvl 弹窗（勿用 window.open，浏览器会当下载）
- 2026-09-08 晚间（明细见交接文档 §3.11/坑 28/29）：**导入 -601008 修复**（fetchAll 1000、importCustomers 两遍处理+15 并发写库、占位批内去重）；**弹窗死循环修复**（decisions 带 index+全局转片内+累积不清空）；删除批次/加客户并行化；**比对认领本地化**（listMallLibrary+applyMallMatch，前端本地比对+预览总览+应用认领，任何电脑可用）；**壳程序 DPI 大修**（PMv2 声明/工作区 96%×92% 手动居中/标题栏 uiScale/禁右键禁 F5/登录 sessionStorage 会话恢复）；任务行加高；文员包已重打
- 部署待办（按序）：**重传云函数 adminapi/visits/tasks/coordfix/init → 上传小程序体验版 → 后台 Ctrl+F5 → 真机验证**（照片三格/试听/录音控件/坐标拍照/历史任务 Tab/归档/重置清理/地图页/导入分片/批次卡比对认领）
- 待办：上线前清单（改名「聚火拜访」/头像/qingyan 密码）；服务号两个新模板老板已选未添加；iPhone 录音 aac 与地图页真机验证未完成；定位系列优化待真机反馈；正式版提审
- backlog：AI 日报评分（§7.10，智谱 key 已有）→ 导出+报表 → 操作档案（§7.8）→ 重复客户体检
- 详见 `项目交接-当前进度.md` §3.3 部署队列、§4 坑清单、§5 口径字典、§7.12 批次方案
