# 聚火拜访开发机 · 重装方案（AI 开发环境）

> **适用机器**：HP Victus 16-r0xxx ／ Win11 ／ 32GB ／ C:454G · D:500G · E:1.9T
> **方案目标**：彻底清除 AI 工具造成的系统污染，并建立一套**不再被 AI 工具污染**的开发环境。
> **制定日期**：2026-10-21　**状态**：待执行（老板已确认：本地 PG 无需保留 / 火绒保留）

---

## 第 0 章 · 这台机器现在到底坏在哪（全部为实测证据）

### 0.1 系统被改动过的直接证据

| # | 证据 | 实测内容 | 危害 |
|---|---|---|---|
| E1 | **Codex 私自建了系统账户** | `CodexSandboxOffline`、`CodexSandboxOnline` 两个**启用状态**的本地用户 + `CodexSandboxUsers` 组（描述 = "Codex sandbox internal group (managed)"） | 🔴 高 |
| E2 | **SSH 私钥权限被改** | 私钥 `wfr_server` 上有 `CodexSandboxUsers` 的 `(M,DC)` 权限 | 🔴 高：该组成员可读取服务器私钥 |
| E3 | **Claude Desktop 装了系统服务** | `CoworkVMService` → `WindowsApps\Claude_1.5354.0.0_x64__pzs8sxrjxfjjc\app\resources\cowork-svc.exe` | 🟠 中 |
| E4 | **PostgreSQL 装了两套** | `C:\Program Files\PostgreSQL\17` 与 `\18` 并存，服务跑的是 18 | 🟠 中 |
| E5 | **`psql` 不在 PATH** | `Get-Command psql` 失败（只有 `C:\Program Files\PostgreSQL\18\bin\psql.exe`） | 🟠 中：AI 与排障都无法直接查库 |
| E6 | **7 个 AI CLI 全局包** | `@qingchencloud/openclaw-zh`(2.01GB)、`@openai/codex`(0.56GB)、`@anthropic-ai/claude-code`(0.22GB)、`deepseek-tui`、`reasonix`、`pnpm`、`npm` | 🟡 低但脏 |
| E7 | **沙箱在 Windows 侧崩 `0xC0000142`** | 沙箱模式跑 `pwsh` 一律崩溃；full-access 正常 | 🔴 高：AI 工具实际不可用 |
| E8 | **PEM 常驻** | `PEMHTTPD-x64`（EnterpriseDB 的 PG 管理工具 httpd）在跑 —— PG 17 时代残留 | 🟡 低 |
| E9 | **预览版系统** | Build 26300 属 Insider 预览通道 | 🟠 中：与 E7 叠加 |

### 0.2 根本原因（方案要解决的就是这条）

**在 Windows 上让每个 AI 工具用「受限账户 + 改 ACL」来模拟沙箱，这个模式本身是错的。**

证据链闭合：

```
AI 工具需要沙箱
  → Windows 没有便宜好用的沙箱原语（AppContainer 门槛高）
  → 各家自己造：建本地账户 + 改组 + 改文件 ACL      ← E1、E2、E3
  → 多个工具互相改，账户/组/ACL 叠加
  → 权限模型自相矛盾 → 沙箱初始化失败 → 0xC0000142  ← E7
```

> **结论：只重装、不清这个模式，几个月后必然复发。**
> 方案的核心不是「装什么」，而是**换一个层级做隔离**。

---

## 第 1 章 · 架构决策

> ⭐⭐ **总原则（老板 2026-10-21 定）**：**「只要好处，不因为一个需求把整体都改了」**。
> 老板 80% 做小程序开发、**已经熟悉现在的开发方式**，所以：
> **主项目留 D 盘不动，开发方式一个字不改**；WSL 只作为**局部增强**（安全隔离 + 云函数测试）。

### 决策 A：主项目留在 D 盘，开发方式保持原样 【最高优先级】

| 项 | 决定 |
|---|---|
| 项目位置 | **`D:\WFR\visit-miniapp`（不变）** |
| 日常开发 | **完全照现在的方式**：VS Code 打开 D 盘、开发者工具读 D 盘、`node server.js` 跑后台 |
| 镜像同步 | ❌ **不需要**（项目没迁 WSL，就没有同步这回事） |
| 学习成本 | **0**（和现在一模一样） |

> **为什么这么定**：小程序开发的核心工具（微信开发者工具、真机预览、云函数部署）**只能跑 Windows**。
> 把项目迁到 WSL 会多出「改完要同步 → 才能看效果」这一步，**对 80% 做小程序的人纯属增加麻烦**。

### 决策 B：WSL 只做「局部增强」，不接管项目

WSL 装上，但**只用于两件事**：

| 用途 | 怎么用 | 收益 |
|---|---|---|
| **① AI 工具安全隔离** | AI 工具在 Linux 用户/容器里跑 | 改不动 Windows 系统（这是重装的**主因**） |
| **② 云函数本地验证** | 把云函数临时复制进 WSL 跑一下 | 上传前就能抓语法/依赖错误 |

**不做的事**：
- ❌ 不把项目迁进 WSL
- ❌ 不搞镜像同步
- ❌ 不改变现有的 VS Code + 开发者工具工作流

### 决策 C：AI 工具一个 Linux 用户

| Linux 用户 | 给谁 | 权限 |
|---|---|---|
| `hotakun`（主） | 你自己、VS Code | sudo |
| `ai-harness` | DeepSeek Harness | 无 sudo |

即便某个 AI 工具行为异常，**它的权限边界是内核强制的**，不依赖任何配置的自觉。


---

---

## 第 1.5 章 · ⭐ 为什么「不全放 WSL」——基于实际工具链的判断

> 老板提问（2026-10-21）：「会开发一些小工具，这些工具都是在 WIN 环境下运行，全部放 WSL 是否值得？
> 优先考虑开发习惯，然后打通开发工具的流畅性，和满足开发工具的功能性。」

### 实测：你做的「小工具」到底是什么技术栈

| 工具 | 技术栈 | 能跑 Linux 吗 |
|---|---|---|
| **`JuHuoVisitAdmin.exe`**（后台壳程序） | **C# + WinForms + WebView2** | ❌ **绝对不能**——WinForms/WebView2 是 Windows 独有 API |
| `make_packages.py`（打包脚本） | Python 打 zip/bat | ⚠️ 脚本能跑，但**产物是给 Windows 的**（node-win-x64、CRLF bat） |
| 各类 `.bat`（启动后台 / 编译壳） | cmd 批处理 | ❌ **只能 Windows** |
| 云端 12 个云函数（6145+2727 行） | 纯 Node（wx-server-sdk） | ✅ 能 |
| 小程序页面（19 页，522 处 wx. API） | WXML/WXSS/JS | ⚠️ 只能微信开发者工具（Windows） |

**结论：核心那个「带界面的工具」100% 绑死 Windows，WSL 一点忙帮不上。**

### 三种方案对比

| 你的需求 | 全放 WSL | **混合（推荐）** | 全放 Windows |
|---|---|---|---|
| 开发习惯 | ❌ 全变 | ✅ **几乎不变** | ✅ 不变 |
| 小程序开发 | ❌ 要同步，多一步 | ✅ **直接开 D 盘** | ✅ 直接开 |
| **C# / WinForms 壳** | ❌ **根本编不了** | ✅ **Windows 侧照旧（csc）** | ✅ 一样 |
| **云函数本地验证** | ✅ 能 | ✅ **能** | ❌ 传上去才知道 |
| **AI 工具安全** | ✅ 最好 | ✅ **够了** | ❌ 就是现在的毛病 |
| Docker / PG | ✅ 能 | ✅ 能 | ⚠️ 要在 Windows 装 |

**WSL 真正不可替代的只有两个价值**：① 云函数预检 ② AI 工具隔离。
**其余全部 Windows 更合适。**

### 最终分工（这就是方案的全部）

| 你在干什么 | 在哪做 | 用什么 |
|---|---|---|
| 写小程序页面 / WXML | **Windows D 盘** | VS Code + 微信开发者工具 |
| 改云函数 | **Windows D 盘改** | ⭐ 上传前复制到 WSL 跑一下 |
| 编译 C# 壳程序 | **Windows** | `重新编译壳.bat`（csc） |
| 打包安装包 | **Windows** | `python make_packages.py` |
| 跑后台 server.js | **Windows** | `启动管理后台.bat` |
| 研究新东西 / 试毒 | **WSL `~/sandbox`** | 随便折腾 |

### 只新增两条命令，不改变任何现有习惯

```powershell
# ① 云函数上传前先本地验证（在 Windows PowerShell 里就能跑）
wsl -d Ubuntu -- bash /mnt/d/WFR/visit-miniapp/tools/check-fn.sh adminapi
wsl -d Ubuntu -- bash /mnt/d/WFR/visit-miniapp/tools/check-fn.sh all

# ② 想进实验区干活
wsl -d Ubuntu -e bash
```

**其他一切照旧**：双击 `.bat`、VS Code 开 D 盘、开发者工具照常。

### 功能性验证：云函数检查器实测通过

`tools/check-fn.sh` 已写好并**双向验证**：

| 验证项 | 结果 |
|---|---|
| 语法检查 | ✅ 通过 |
| 检查 `ping`（正常云函数） | ✅ 语法 OK → 依赖安装 OK → 模块加载 OK → main 可调用 |
| **故意造语法错误** | ✅ **正确报出 `SyntaxError: Unexpected token ';'` 并定位到行** |
| 不存在的函数名 | ✅ 正确报错 |
| 无参数 | ✅ 正确列出 12 个云函数 |

**它抓得到**：语法错误 / 依赖缺失 / 模块加载失败（云函数部署失败的大头）
**它抓不到**：业务逻辑错误（需要真实数据库 + OPENID，只能传上去测）


---

## 第 2 章 · 重装前必做

### 2.1 数据备份 —— ✅ **已完成**（2026-10-21）

备份全部放在 **`D:\WFR\备份-重装前\`**，共 157 个文件 / 344.7 MB。
**恢复步骤详见该目录下的 `README-恢复说明.md`**。

| # | 对象 | 状态 | 说明 |
|---|---|---|---|
| P1 | 本地 PostgreSQL | ✅ **无需备份** | 老板确认：没有需要保留的库，全新安装即可 |
| P2 | **SSH 私钥 `wfr_server`** | ✅ **已备份** | `D:\WFR\备份-重装前\wfr_server`（已实测能连服务器） |
| P3 | 云端凭证 | ✅ **无需备份** | `admin/config.json`、`SecretKey.csv` **本来就在 D 盘** |
| P4 | **Windows 专用驱动** | ⬜ **你要自己做** | **HP 官网下载 WiFi / 蓝牙驱动存到 D 盘或 U 盘**（重装后可能没网，这是唯一必须你亲自准备的） |
| P5 | 桌面文件 | ✅ **已备份** | 98 个文件 342MB（含金华聚火表格处理、分润系统文档、几个代码项目） |
| P6 | 浏览器书签 | ✅ **已备份** | Chrome 2.4 万字节 / Edge 17.7 万字节 |
| P7 | `.gitconfig` / `.npmrc` / `.wslconfig` | ✅ **已备份** | `config\` 目录 |
| P8 | DeepSeek Harness 配置与凭据 | ✅ **已备份** | `dsh-config\`（含 `.credentials.yaml`） |
| P9 | 项目代码 | ✅ **本来就在 D 盘** | 无需额外备份 |
| **P10** | ⭐⭐ **Reasonix Studio 配置** | ✅ **已备份**（2026-10-21） | `reasonix\` 目录：`.env`(9 个 Key) + `config.toml` + **49 个 memory md** + `global-workspace` 27 个文件 |

> ⚠️ **唯一还需要你做的：P4 下载 WiFi / 蓝牙驱动**。其他都已就位或本来就在 D 盘。

### 2.2 代码备份

**老板决定不做 git bundle 备份**（代码本来就在 D 盘，格式化 C 盘不受影响）。

### 2.3 环境快照

```powershell
winget export -o D:\WFR\备份-重装前\winget-apps.json
```


---

## 第 3 章 · 重装系统

| 项 | 选择 | 理由 |
|---|---|---|
| 版本 | **Win11 Professional 24H2/25H2 正式版** | ⚠️ **绝不用 26300 预览版**（E9） |
| 分区 | **只格式化 C:** | D 盘项目、E 盘游戏库原地保留 |
| 用户 | 只建 `Hotakun` | **不建任何 AI 相关账户**（防 E1 复发） |
| 账户类型 | **本地账户**（非 Microsoft 账户） | 减少后台同步，AI 工具更难挂靠 |

---

## 第 4 章 · 安装顺序（分两段：你自己做 → 我带你做）

> ⭐ **分工原则**：**驱动类、需要重启的、纯点击的** → 你自己做；
> **命令多、容易装错盘的、需要交叉验证的** → 我在场带你做。

---

## 【第一段】你自己完成（装完火绒就叫我进来）

| 步 | 内容 | 命令 / 操作 | ✅ 验收 |
|---|---|---|---|
| 1.1 | **重装系统** | 格式化 C 盘，装 Win11 正式版 | 见到桌面 |
| 1.2 | **NVIDIA 显卡驱动** | HP 官网或 NVIDIA 官网选 Victus 16-r0 | 设备管理器无黄色叹号 |
| 1.3 | **WiFi / 蓝牙驱动** | 官网下载的（见 P4） | 能上网 |
| 1.4 | **Windows Update** | 全部装完并重启（可能要重启多次） | 无待装项 |
| 1.5 | **火绒安全** | 官网安装（老板要求保留） | 右下角有火绒图标 |

> ✅ **做完这 5 步，通知我：「重装好了，按方案第 4 章来」**
>
> **为什么是这一刻**：系统干净、能上网、屏幕正常、驱动齐全 —— 正好是搭开发环境的最佳起点。
> **为什么不再早**：驱动没装好我干等；Windows Update 要重启多次我会断线。

---

## 【第二段】我带你做（每一步我都会看着）

> ⚠️ 以下步骤**不要自己先做**，尤其 2.2（WSL 装错盘要重来）。

### 阶段 2 · WSL 安装（⚠️ 最关键的一步）

| 步 | 内容 | 命令 | 验收 |
|---|---|---|---|
| 2.1 | 确认虚拟化已开 | `Get-CimInstance Win32_ComputerSystem \| Select HypervisorPresent` | True |
| 2.2 | **装 WSL 到 D 盘** | `wsl --install -d Ubuntu-24.04 --location "D:\WSL\Ubuntu"` | `wsl -d Ubuntu-24.04 -- echo ok` |
| 2.3 | 验证落盘位置 | `Get-ChildItem D:\WSL -Recurse -Filter *.vhdx` | 在 D:\WSL 下 |
| 2.4 | Windows Terminal | `winget install Microsoft.WindowsTerminal` | 能开 Ubuntu 标签页 |

> ⚠️ **2.2 必须带 `--location`**，否则 WSL 全装在 C 盘（几十 GB），事后要 export/import 搬移。

### 阶段 3 · WSL 内基础环境（在 Ubuntu 终端执行）

```bash
# 3.1 基础工具链
sudo apt update && sudo apt install -y build-essential curl git unzip ripgrep jq

# 3.2 Node.js 24 LTS（与云函数运行时一致）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# 3.3 Python + 项目依赖
sudo apt install -y python3 python3-pip python3-venv
pip3 install --break-system-packages edge_tts openpyxl pandas xlrd

# 3.4 FFmpeg（录音转码）
sudo apt install -y ffmpeg
```

| ✅ 验收 | 命令 | 期望 |
|---|---|---|
| Node | `node -v` | `v24.x` |
| Python | `python3 -c "import edge_tts;print('ok')"` | `ok` |
| FFmpeg | `ffmpeg -version` | 有版本号 |

> ⚠️ **Windows 侧不再装 Node / Python**。两套环境并存正是混乱来源之一。

### 阶段 4 · Docker Engine（WSL 内原生）

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # 免 sudo
newgrp docker
docker run --rm hello-world
```

| ✅ 验收 | 期望 |
|---|---|
| `docker run --rm hello-world` | 输出 "Hello from Docker!" |
| 任务管理器 | **没有** "Docker Desktop" 进程 |

### 阶段 5 · PostgreSQL（容器化，替代 E4 / E5 / E8）

```bash
docker run -d --name pg18 \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD='强密码' \
  -v pgdata:/var/lib/postgresql/data \
  --restart unless-stopped \
  postgres:18

sudo apt install -y postgresql-client
psql --version
```

| ✅ 验收 | 期望 |
|---|---|
| `psql -h 127.0.0.1 -U postgres -c '\l'` | 列出库 |
| `docker ps` | pg18 在跑 |

> ⚠️ **Windows 上不再装 PostgreSQL**。两套实例（E4）+ 常驻 PEM（E8）一并消失。
> ⚠️ 生产库在服务器 `124.222.29.73`，**与本地无关，不受影响**。

### 阶段 6 · Windows 侧工具

| 步 | 程序 | 安装方式 | 说明 |
|---|---|---|---|
| 6.1 | **VS Code** | `winget install Microsoft.VisualStudioCode` | 详细步骤见 6.1a |
| 6.2 | **Git for Windows** | `winget install Git.Git` | 提供 Git Bash；⚠️ 配 `core.autocrlf=true` |
| 6.3 | **微信开发者工具** | 官网下载（winget 没有） | **硬约束：只能 Windows** |
| 6.4 | **Inno Setup 6** | `winget install JRSoftware.InnoSetup` | 老板在用 |
| 6.5 | **7-Zip** | `winget install 7zip.7zip` | 解压 |
| 6.6 | **记录服务基线** | `Get-Service \| % Name \| sort > D:\WFR\备份-重装前\services-baseline.txt` | ⚠️ **关键基线** |

#### 6.1a VS Code 装完必做（⭐ 老板最常用）

装完 VS Code **只装 3 个 Python 扩展**，不要多装：

```powershell
code --install-extension ms-python.python
code --install-extension ms-python.vscode-pylance
code --install-extension charliermarsh.ruff
```

| 扩展 | 作用 | ⚠️ |
|---|---|---|
| `ms-python.python` | 核心：识别解释器、运行、调试 | **装一份就够** |
| `ms-python.vscode-pylance` | 类型检查、补全 | **装一份就够** |
| `charliermarsh.ruff` | 格式化 + lint（比 flake8/black 快） | 推荐 |

> ⚠️ **旧电脑的毛病：7 个 Python 扩展，其中 3 组是重复的两版本共存**
> （`ms-python.python` 有 2026.4.0 + 2026.8.0、pylance 有两版、python-envs 有两版）。
> **重装后只装 3 个，别装 `ms-python.vscode-python-envs`**（新版实验性，和 python 扩展重复）。

**⚠️ 回答常见问题：「VS Code 里还需要装 Python 吗？」**

| 概念 | 是什么 | 要不要装 |
|---|---|---|
| **VS Code 的 Python 扩展** | 编辑器插件（高亮/补全/调试） | ✅ **必须装** |
| **Python 解释器本体** | 真正执行代码的 `python.exe` | ❌ **不单独装**，交给 uv |

**因为 uv 会自动下载 Python**：`uv python install 3.12` → uv 装在自己缓存目录，
**不动 PATH、不建全局 site-packages** —— 这正是「不再乱」的关键。

#### 6.1b ⭐ Python 环境标准做法（重装后唯一正确姿势）

> ⚠️ **旧电脑的 Python 乱在 4 处（实测）**：
> ① 装了**两份 Python 3.14**（官方安装包 + Python Install Manager），包互不相通
> ② PATH 里塞了 **6 条** Python 路径
> ③ 还有第三份 Astral/CPython 3.12.13 + `uv.exe` 在 `AppData\Local\hermes\bin`（另一个 AI 工具带的）
> ④ **55 个包装在全局 site-packages**，没虚拟环境

##### 核心原则：**只装 uv，不装 Python 本体**

```powershell
# ① 装 uv（这是唯一的「安装 Python 相关」动作）
winget install --id=astral-sh.uv -e

# ② 验证
uv --version

# ③ 需要 Python 时让 uv 下载（不要用 python.org 安装包）
uv python install 3.12
uv python list
```

##### 每个项目独立环境

```powershell
cd D:\WFR\visit-miniapp
uv init                          # 建 pyproject.toml（已有就跳过）
uv add edge-tts openpyxl pandas xlrd   # 自动建 .venv + 装包
```

**临时跑脚本（不装任何东西）**：
```powershell
uv run --with edge-tts tts_gen.py
```

##### VS Code 怎么找到 .venv

在项目里建 `.vscode\settings.json`：
```json
{
  "python.defaultInterpreterPath": "${workspaceFolder}/.venv/Scripts/python.exe"
}
```

或者在 VS Code 里 `Ctrl+Shift+P` → `Python: Select Interpreter` → 选 `.venv` 那个。

##### 对比：现在 vs 重装后

| 项 | 现在（乱） | 重装后 |
|---|---|---|
| Python 安装份数 | **2 + 1 个 3.12** | **0**（uv 按需） |
| PATH 里 Python 条目 | **6 条** | **1 条**（uv） |
| VS Code Python 扩展 | **7 个，3 组重复** | **3 个，无重复** |
| 全局包 | **55 个** | **0 个** |
| 选解释器 | 靠猜 PATH | 项目里写死 |
| 装包速度 | pip | uv（快 10~100 倍） |

##### ⚠️ 已知待办：`server.js` 调用 Python 的路径

`admin/server.js` 里现在是：
```javascript
const py = process.platform === 'win32' ? 'python' : 'python3';
```
改用 uv 后要指向项目 `.venv`：
```javascript
const py = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
```
> ⚠️ **这条改动会影响后台语音功能，必须改完跑 `node admin/tools/check.js` 验证。**
> 改不改、什么时候改，等老板确认。

### 阶段 7 · 恢复备份 + 项目跑起来

| 步 | 内容 | 参考 |
|---|---|---|
| 7.1 | 恢复 SSH 私钥 + 收紧权限 + 验证连通 | `D:\WFR\备份-重装前\README-恢复说明.md` 2.1 |
| 7.2 | 恢复 `.gitconfig` / `.npmrc` | 同上 2.2 |
| 7.3 | 项目就位，启动后台 | `cd D:\WFR\visit-miniapp\admin && npm install && $env:PORT=18080; node server.js` |
| 7.4 | **跑体检** | `node admin/tools/check.js` → 必须全绿 |
| 7.5 | 浏览器打开 `http://localhost:18080` | 后台能登录 |

### 阶段 8 · 装 AI 工具（⭐ Reasonix 第一个装）

> ⚠️ **老板明确：Reasonix Studio 是主力开发工具，使用频率极高 —— 必须最先装、最先验。**

| 步 | 工具 | 装完必查 |
|---|---|---|
| **8.1** | ⭐ **Reasonix Studio** | **见下方专项验收** |
| 8.2 | **DeepSeek Harness** | 跑三查 |
| 8.3 | Claude Desktop | ⚠️ 查 `CoworkVMService` 是否复活（E3） |
| 8.4 | Yan Agent（beta） | 跑三查，风险最高放最后 |

#### 8.1 Reasonix Studio 专项验收（重点）

**它是主力工具，装完必须完整验收：**

| 检查项 | 怎么查 | 期望 |
|---|---|---|
| 能启动 | 双击打开 | 正常进主界面 |
| **API Key 生效** | 设置 → 模型，看能否选 deepseek-flash | 能选、能对话 |
| **4 个工作目录在** | 看左侧工作区 | `D:\WFR\visit-miniapp`、`D:\WFR02\...`、`D:\WFR03\...`、`D:\WFR04\...` |
| **项目记忆恢复** | 问一句「客户数据模型是什么」 | **能答出我们项目的口径**（说明 memory 恢复了） |
| 能读写项目 | 让它读 `admin/admin.html` | 能读到内容 |

**⚠️ 重装后第一件事：把 YOLO 模式关掉**

原配置是 `default_tool_approval_mode = "yolo"`（工具调用不询问直接执行）。
建议先改成：

```toml
[desktop]
default_tool_approval_mode = "ask"
```

观察 1~2 周稳定后再考虑改回。

#### 每装完一个 AI 工具，立刻跑这三条

```powershell
# ① 有没有多出本地账户（防 E1 复发）
Get-LocalUser | Where {$_.Description -match 'sandbox|agent|codex'} | Select Name,Enabled

# ② 有没有多出系统服务（防 E3 复发）
diff (Get-Service | Select -Expand Name | Sort-Object) (Get-Content D:\WFR\备份-重装前\services-baseline.txt)

# ③ 有没有动 SSH 私钥权限（防 E2 复发）
icacls "$env:USERPROFILE\.ssh\wfr_server"
```

## 第 5 章 · 项目落地配置（⭐ 和现在完全一样）

> ⭐⭐ **本章的核心：项目就留在 D 盘，开发方式一个字都不改。**
> 重装只是把工具重新装一遍，**工作流和现在一模一样**。

### 5.1 主项目：`D:\WFR\visit-miniapp`（不变）

重装后照原来的方式用：

```powershell
cd D:\WFR\visit-miniapp\admin
npm install
$env:PORT=18080; node server.js
```

- 浏览器开 `http://localhost:18080`
- **VS Code 直接打开 `D:\WFR\visit-miniapp`**（不用 WSL 模式）
- **微信开发者工具直接指向 `D:\WFR\visit-miniapp\miniprogram`**（不用镜像）

**就这样，没有第 2 步。**

### 5.2 行尾规则（照旧）

项目硬规矩：`admin.html` 是**纯 CRLF**，`.bat` 必须 CRLF。

```powershell
cd D:\WFR\visit-miniapp
node admin/tools/check.js      # 体检第 3 项字节级查行尾
```

> ⚠️ 每次改完 `admin.html` 都跑体检 —— 和现在完全一样。

### 5.3 WSL 里放什么（只是实验区，不碰主项目）

WSL 里建一个**空目录**当实验区，只干两件事：

```bash
mkdir -p ~/sandbox
```

#### 用途 ①：云函数本地验证（最有价值）

改完云函数**在上传前先本地跑一遍**，提前抓语法/依赖错误：

```bash
cd ~/sandbox
cp -r /mnt/d/WFR/visit-miniapp/miniprogram/cloudfunctions/adminapi .
cd adminapi
npm install
node -e "require('./index.js'); console.log('✅ 加载成功')"
```

> **收益**：`adminapi` 有 6145 行，现在改完只能传上去才知道对不对。
> 本地能抓到：**语法错误、依赖缺失、Node 版本不兼容**（这三类占云函数部署失败的大头）。
>
> ⚠️ 抓不到：业务逻辑错误（那需要真实数据库和 OPENID，还是得传上去测）。

#### 用途 ②：AI 工具的隔离区

要跑有风险的脚本/命令时，在 WSL 里跑，别在 Windows 上跑：

```bash
cd ~/sandbox
# 随便折腾，坏了 rm -rf ~/sandbox 重建
```

### 5.4 微信开发者工具（照旧）

**直接指向 `D:\WFR\visit-miniapp\miniprogram`**，不需要任何镜像/同步。

> 原方案里的「镜像同步」整套机制，**因为项目不迁 WSL，全部取消**。
> 同步脚本 `tools/wsl-sync.sh` 保留着，但**日常用不上**（除非你以后真的想把项目搬进 WSL）。



## 第 6 章 · 日常运维规矩（防复发）

### 6.1 每月一次环境体检（3 分钟）

存成 `check-env.ps1`：

```powershell
"=== 本地账户 ===";   Get-LocalUser | Select Name,Enabled,Description
"=== 异常服务 ===";   diff (Get-Service | % Name | sort) (gc E:\backup\services-baseline.txt)
"=== SSH 权限 ===";   icacls "$env:USERPROFILE\.ssh\wfr_server"
"=== 全局 npm ===";   npm ls -g --depth=0
"=== C盘空间 ===";    Get-PSDrive C | Select Used,Free
```

### 6.2 三条铁律

| # | 铁律 | 原因 |
|---|---|---|
| R1 | **AI 工具不许改系统账户/组**，一旦发现立即卸载 | E1 的代价是沙箱崩溃 |
| R2 | **程序尽可能装进 WSL / Docker，Windows 侧保持干净** | 减少 ACL 面 |
| R3 | **装任何 AI 工具前先 `Checkpoint-Computer`** | 有回退点 |

---

## 第 7 章 · 明确不装的（附理由）

| 类别 | 不装 | 理由 |
|---|---|---|
| AI 工具 | Cursor、Trae CN、TRAE SOLO、ZCode、Vela、CC Switch、千问、豆包、元宝、ima、Qoder | 与保留的 4 个重复 |
| AI 运行时 | **Ollama**（2.79GB） | 本机跑小模型质量差，需要时用 API |
| npm 全局包 | `@qingchencloud`（2GB）、`@openai/codex`、`@anthropic-ai/claude-code`、`deepseek-tui` | 需要时再 `npm i -g` |
| 数据库 | **Windows 版 PostgreSQL 17 / 18**、PEM | 改用 Docker（解决 E4/E5/E8） |
| 容器 | **Docker Desktop** | 它自己就装一堆服务，违背 R2 |
| 开发 | Visual Studio 2022、Android Studio、.NET SDK 全家桶、Windows SDK | 项目用不到（`csc` 系统自带） |
| 设计 | AE、AI、LR、AU、ME、CorelDRAW、C4D、Blender、Topaz×2、Tuanjie | 老板自己取舍 |
| 安全 | **不卸载火绒** | 老板明确要求保留，防流氓软件 |

---

## 第 8 章 · 风险与回退

| 风险 | 概率 | 应对 |
|---|---|---|
| 微信开发者工具读不到 WSL 代码 | 高 | 5.4 镜像方案；**第一步用 D 盘则无此问题** |
| AI 工具不支持 Linux 用户隔离 | 中 | 退化为 Docker 容器（5.5 备注） |
| 重装后没网（WiFi 驱动缺） | 中 | **重装前**从 HP 官网下好驱动存 U 盘（P4） |
| 新系统不稳定 | 低 | 装完先跑 3 天再装 AI 工具 |
| 火绒与某 AI 工具冲突 | 低 | 火绒加白名单，不要卸载 |

**回退点**：每次装 AI 工具前 `Checkpoint-Computer -Description "before-X"`。

---

## 第 9 章 · 执行清单（可直接照做）

```
【准备（重装前）】
✅ 备份 SSH 私钥 / 桌面 / 配置 / 书签        → D:\WFR\备份-重装前\（已完成）
✅ 项目代码 / config.json / SecretKey.csv    → 本来就在 D 盘（无需操作）
□  下载 HP WiFi / 蓝牙驱动                   → U 盘或 D 盘  ← 只剩这一项要你亲手做

════════ 第一段：你自己做（做完叫我）════════

□  1.1  重装系统（格式化 C 盘，Win11 正式版）
□  1.2  NVIDIA 显卡驱动
□  1.3  WiFi / 蓝牙驱动
□  1.4  Windows Update 全部装完并重启
□  1.5  火绒安全

       ⬇️⬇️⬇️  到这里通知我：「重装好了，按方案第 4 章来」  ⬇️⬇️⬇️

════════ 第二段：我带你做 ════════

【WSL（只做实验区，不接管项目）】
□  2.1  确认虚拟化已开（HypervisorPresent = True）
□  2.2  WSL 装到 D 盘 ← ⚠️ 必须带 --location
□  2.3  验证 ext4.vhdx 在 D:\WSL 下
□  2.4  Windows Terminal
□  3.1  (WSL) build-essential / curl / git / ripgrep / jq / rsync
□  3.2  (WSL) Node.js 24 LTS
□  3.3  (WSL) Python + edge_tts / openpyxl / pandas / xlrd
□  3.4  (WSL) ffmpeg
□  4.1  (WSL) Docker Engine → hello-world 通过
□  5.1  (WSL) pg18 容器 → psql 可连

【Windows 侧工具（日常开发用）】
□  6.1  VS Code（日常就开 D 盘，不用 WSL 模式）
□  6.2  Git for Windows（core.autocrlf=true）
□  6.3  微信开发者工具 → 指向 D:\WFR\visit-miniapp\miniprogram
□  6.4  Inno Setup 6
□  6.5  7-Zip
□  6.6  记录 services-baseline.txt             ← 关键基线

【主项目跑起来（和现在一模一样）】
□  7.1  恢复 SSH 私钥 → 验证 ssh 能连服务器
□  7.2  恢复 .gitconfig / .npmrc
□  7.3  cd D:\WFR\visit-miniapp\admin  然后 npm install
□  7.4  node server.js（18080）→ 浏览器能登录
□  7.5  node admin/tools/check.js 全绿
□  7.6  微信开发者工具打开 miniprogram 能编译

【AI 工具（逐个，每装一个跑三查）】
□  8.1  ⭐ Reasonix Studio（主力工具，最先装）
        □ 启动正常
        □ API Key 生效（能选 deepseek-flash 并对话）
        □ 4 个工作目录在（WFR / WFR02 / WFR03 / WFR04）
        □ 项目记忆恢复（问「客户数据模型」能答对）
        □ 把 YOLO 改成 ask
□  8.2  DeepSeek Harness → 跑三查
□  8.3  观察 1~2 周，确认环境稳定
□  8.4  Claude Desktop → 查 CoworkVMService 是否复活
□  8.5  Yan Agent → 三查

❌ 没有「把项目迁到 WSL」这一步
❌ 没有「镜像同步」这一步
```

---

## 第 10 章 · 已确认的决策记录

| # | 问题 | 老板决定 | 日期 |
|---|---|---|---|
| Q1 | 本地 PG 要保留吗 | **不保留，全新安装** | 2026-10-21 |
| Q2 | 代码放 WSL 还是 D 盘 | ⭐ **就留 D 盘，不迁 WSL**（老板最终定：只要好处，不改现有开发方式） | 2026-10-21 |
| Q3 | 火绒留不留 | **保留**（防流氓软件） | 2026-10-21 |
| Q4 | 方案存文档 | **是**，即本文档 | 2026-10-21 |
| Q5 | 重装范围 | **C 盘全部格式化重装**；资料大多在 D 盘 | 2026-10-21 |
| Q6 | 执行前是否做备份 | **老板说不必做全套**；但**实际已完成 C 盘关键项备份**到 `D:\WFR\备份-重装前\` | 2026-10-21 |
| Q7 | AI 工具进场时机 | **装完显卡驱动 + WiFi 驱动 + Windows Update + 火绒之后**再叫我进来 | 2026-10-21 |
| Q8 | 项目要不要迁 WSL | ⭐ **不迁**。80% 做小程序，开发者工具只能 Windows，迁了要多一层同步，**纯增负担** | 2026-10-21 |
| Q9 | WSL 还要不要装 | ✅ **要装**，但只做「AI 工具隔离 + 云函数本地测试」两件事 | 2026-10-21 |
| **Q10** | ⭐ **Reasonix Studio 的优先级** | **主力工具，使用频率极高 → 必须第一个装、第一个验收**（原方案排在最后，已纠正） | 2026-10-21 |
| Q11 | 要不要备份 Reasonix 配置 | ✅ **全部备份**（老板说"备份备份，都备份"） | 2026-10-21 |

### Q6 说明：备份已实际完成（比原计划更全）

虽然老板说不用专门备份，但检查发现 **C 盘确实有几样东西值得留下**，已全部复制到 `D:\WFR\备份-重装前\`（157 个文件 / 344.7 MB）：

| 备份项 | 为什么值得留 |
|---|---|
| **SSH 私钥 `wfr_server`** | 在 C 盘的 `%APPDATA%` 下，丢了要重配服务器密钥（**已实测能连服务器**） |
| **桌面（98 个文件 342MB）** | 金华聚火表格处理、分润系统文档、backend/frontend 等代码项目 —— **这些只在桌面，丢了就没了** |
| **浏览器书签** | Chrome / Edge |
| **`.gitconfig` / `.npmrc` / `.wslconfig`** | 配一次挺麻烦 |
| **DeepSeek Harness 配置与凭据** | `.credentials.yaml` 等 |
| ⭐ **Reasonix Studio 配置** | **含 9 个 API Key、49 个业务口径 memory、4 个工作目录记录** —— 主力工具，见 `备份-重装前\reasonix\README-恢复说明.md` |
| **其他 AI 工具配置** | Codex / Claude / DeepSeek 的配置（`ai-tools\`） |

> ✅ **恢复步骤见 `D:\WFR\备份-重装前\README-恢复说明.md`**，按顺序复制回去即可，含 SSH 权限收紧命令。
>
> ⚠️ **唯一还需要你亲手做的**：去 HP 官网下载 **WiFi / 蓝牙驱动**存到 D 盘或 U 盘 —— 重装后可能没网，下不了驱动。


### Q2 补充说明：WSL 到底用来干什么（最终口径）

> ⭐ **老板 2026-10-21 最终确认**：「只要好处，不因为一个需求把整体都改了」+「80% 做小程序，熟悉现在的开发方式」。

**所以：WSL 装上，但不接管主项目。**

| 事项 | 结论 |
|---|---|
| 主项目位置 | ✅ **D:\WFR\visit-miniapp，不变** |
| VS Code 打开方式 | ✅ **直接打开 D 盘，不用 WSL 模式** |
| 微信开发者工具 | ✅ **直接指向 D:\WFR\visit-miniapp\miniprogram，不需要镜像** |
| 镜像同步 | ❌ **不需要**（项目没迁 WSL，就没这回事） |
| WSL 的用途 | ✅ **仅两件事**：① AI 工具安全隔离 ② 云函数上传前本地验证 |

**WSL 装在哪**：D:\WSL\Ubuntu\ext4.vhdx（装的时候必须带 --location，否则默认占 C 盘）。

**一句话**：重装后你的小程序开发方式**和现在一模一样**，一点没变；额外多出来的只有「AI 工具伤不到系统」和「云函数能先本地跑一下」这两个好处。
