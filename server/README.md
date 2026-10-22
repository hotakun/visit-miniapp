# server/ —— 服务器端常驻脚本（124.222.29.73）

这两个文件**跑在云服务器上**，不是本地后台的一部分。收进仓库是为了防止"服务器上改了、仓库里没有，
下次按仓库重新部署时把修复覆盖掉"（2026-10-22 就踩过：pgsync 的去重修复只存在于服务器）。

## 文件

| 文件 | 作用 | 服务器路径 | 计划任务 |
|---|---|---|---|
| `pgsync.js` | 把云端 CloudBase 数据同步进服务器 PostgreSQL（每 5 分钟一轮） | `D:\WFR\visit-miniapp\pgsync.js` | `JuhuoPgSync` |
| `pgapi.js` | 对 PG 的只读 HTTP 查询 API（`:18081`，`/points` `/batches` `/batchMembers` …） | `D:\WFR\visit-miniapp\pgapi.js` | `JuhuoPgApi` |

两个脚本都从**同目录的 `config.json`** 读微信凭据（appid / appsecret / envId）和 PG 连接参数，
那份 `config.json` **不在仓库里**（含密钥）。

## 部署方式

```powershell
# 1) 上传
scp -i C:\Users\Hotakun\.ssh\wfr_server server\pgsync.js Administrator@124.222.29.73:"D:/WFR/visit-miniapp/pgsync.js.new"
scp -i C:\Users\Hotakun\.ssh\wfr_server server\pgapi.js  Administrator@124.222.29.73:"D:/WFR/visit-miniapp/pgapi.js.new"

# 2) 在服务器上备份 + 替换 + 重启任务
#    备份命名统一用 .bak-YYYYMMDD
Move-Item D:\WFR\visit-miniapp\pgsync.js.new D:\WFR\visit-miniapp\pgsync.js -Force
Stop-ScheduledTask JuhuoPgSync; Start-ScheduledTask JuhuoPgSync
```

> ⚠️ 计划任务是用 `cmd /c node xxx.js >> xxx.log 2>&1` 起的，重启任务前先 `Stop-Process` 掉旧 node，
> 否则会留下两个进程同时同步。

## 2026-10-22 的修复（别回退）

**`pgsync.js`**

1. `upsert()` 按冲突键**先去重**：PostgreSQL 的 `INSERT ... ON CONFLICT DO UPDATE` 在**同一条语句出现重复键**时会整条失败
   （`cannot affect row a second time`）。原来 `batch_members` 每轮都抛这个错 → PG 的成员表**从来没更新过**。
2. `syncCustomerBatches()` **剔除已合并批次**：云端导出的是全部批次文档（含 `mergedInto`），
   原来全量重灌时不筛 → 已合并的批次会被"复活"进 PG。

**`pgapi.js`**

3. 新增 `/batchMembers?batchId=`：批次归属**只认 `batch_members`**。
   `customers.batchIds` 是冗余字段、批次变更时没人维护（实测本地缓存里永康只有 721 条、加州 200 条、已合并的胡库还留 78 条）。
