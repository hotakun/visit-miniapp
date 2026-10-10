-- ============================================================================
-- 聚火拜访 · PostgreSQL 初始化脚本（2026-10-09）
-- ----------------------------------------------------------------------------
-- 目的：为"后台只读镜像"建一个库 + 一个**只能 SELECT** 的用户。
--   · 库名    juhuo
--   · 只读用户 juhuo_ro（**没有** INSERT/UPDATE/DELETE 权限 —— 只读 API 就用它）
--   · 超级用户 postgres 的密码**不要写进这个文件**，执行时你自己输。
--
-- 【怎么执行】两条路，任选：
--   A) 服务器上开 PowerShell / cmd，切到本文件所在目录，跑：
--        & "D:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -f pg_init.sql
--      （会提示输入 postgres 密码 —— 就是安装时你自己设的那个）
--   B) 用 pgAdmin（就是你说的那个 pgAdmin4.exe）连上本机实例 →
--      Query Tool → 把下面内容**分两段**执行（pgAdmin 不认 \connect / \du 这种 psql 元命令）
--
-- ⚠️ 执行前**先改下面那一行密码**，别用示例值。
-- ⚠️ 这个脚本可以重复跑：已存在时会报 "already exists"，忽略即可（不影响）。
-- ============================================================================

-- ① 建库
-- ⚠️⚠️ 2026-10-09 修正（实测后加的）：这台服务器的系统区域是 **zh-CN**，PG 实例默认 locale 是
--   「Chinese (Simplified)_China.936」（**GBK**）。建库时若不显式指定 collation，库会**继承这套 GBK 排序规则**，
--   而我们的数据是 **UTF8** → 排序/比较会踩坑。
--   → 所以显式写 **LC_COLLATE 'C' LC_CTYPE 'C'**：**UTF8 存中文完全没问题** + **C 排序最快最稳、不挑语言**。
--   ⚠️ 本项目**从不按店名排序**（一律按时间 / 编号），所以 C 排序没有任何副作用。
CREATE DATABASE juhuo WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;

-- ② 建只读用户 —— ⚠️⚠️ 把 <在这里填一个强密码> 换成你自己的（建议 20 位以上：大小写+数字+符号）
CREATE ROLE juhuo_ro LOGIN PASSWORD '19740517Fyk#';

-- ③ 允许它连这个库
GRANT CONNECT ON DATABASE juhuo TO juhuo_ro;

-- ④ 切到 juhuo 库，给只读权限
--    【pgAdmin 用户注意】这行 (\connect) 是 psql 专用；pgAdmin 里请**手动切到 juhuo 库**再执行下面 4 行。
\connect juhuo

GRANT USAGE ON SCHEMA public TO juhuo_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO juhuo_ro;
-- 以后新建的表也自动给只读权限（同步器建表后不用再手工授权）
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO juhuo_ro;

-- ⑤ 核对：应看到 juhuo_ro 这个角色（pgAdmin 里这行可以跳过）
\du juhuo_ro
