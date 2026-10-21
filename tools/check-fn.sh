#!/usr/bin/env bash
# =============================================================================
# 云函数上传前本地验证（WSL 里跑，Windows 一行命令就能调用）
# =============================================================================
# 用途：在把云函数传到微信云端之前，先用 Linux 的 Node 跑一遍，
#       提前抓出「语法错误 / 依赖缺失 / 模块加载失败」这三类部署失败的大头。
#
# 从 Windows PowerShell 调用：
#   wsl -d Ubuntu -- bash /mnt/d/WFR/visit-miniapp/tools/check-fn.sh adminapi
#   wsl -d Ubuntu -- bash /mnt/d/WFR/visit-miniapp/tools/check-fn.sh all
#
# 从 WSL 里调用：
#   bash /mnt/d/WFR/visit-miniapp/tools/check-fn.sh adminapi
#
# ⚠️ 它**不改你的项目**：复制到 ~/sandbox 里跑，跑完留在那里。
# =============================================================================

set -uo pipefail

CF_ROOT="/mnt/d/WFR/visit-miniapp/miniprogram/cloudfunctions"
SANDBOX="$HOME/sandbox/fn-check"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "用法: bash check-fn.sh <云函数名> | all"
  echo ""
  echo "现有云函数："
  ls -1 "$CF_ROOT" | sed 's/^/  · /'
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ WSL 里没装 Node。先跑："
  echo "   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

echo "Node: $(node -v)"
echo "=================================================================="

check_one() {
  local name="$1"
  local src="$CF_ROOT/$name"
  local dst="$SANDBOX/$name"

  if [ ! -d "$src" ]; then
    echo "❌ [$name] 找不到这个云函数：$src"
    return 1
  fi

  echo ""
  echo "▶ 检查 $name"

  # 1) 语法检查（最快，不用装依赖）
  local failed=0
  for js in "$src"/*.js; do
    [ -f "$js" ] || continue
    if ! node --check "$js" 2>/tmp/_fncheck_err; then
      echo "  ❌ 语法错误：$(basename "$js")"
      sed 's/^/     /' /tmp/_fncheck_err
      failed=1
    else
      echo "  ✅ 语法 OK：$(basename "$js")"
    fi
  done
  [ "$failed" = 1 ] && return 1

  # 2) 复制到沙盒装依赖并尝试加载
  mkdir -p "$SANDBOX"
  rm -rf "$dst"
  cp -r "$src" "$dst"

  echo "  · 安装依赖（首次会慢一点）…"
  if ! ( cd "$dst" && npm install --silent --no-audit --no-fund >/tmp/_fncheck_npm 2>&1 ); then
    echo "  ❌ npm install 失败："
    tail -20 /tmp/_fncheck_npm | sed 's/^/     /'
    return 1
  fi
  echo "  ✅ 依赖安装 OK"

  # 3) 尝试 require（能抓出顶层代码报错、缺模块、SDK 版本问题）
  echo "  · 尝试加载模块…"
  if ( cd "$dst" && node -e "
      try {
        const m = require('./index.js');
        if (typeof m.main !== 'function' && typeof m !== 'function') {
          console.log('  ⚠️  加载成功，但没导出 main（可能不是标准云函数结构）');
        } else {
          console.log('  ✅ 模块加载成功，main 可调用');
        }
      } catch (e) {
        console.log('  ❌ 加载失败：' + e.message);
        process.exit(1);
      }
    " ); then
    echo "  ✅ [$name] 通过"
    return 0
  else
    echo "  ❌ [$name] 失败"
    return 1
  fi
}

PASS=0; FAIL=0; FAILED_LIST=""

if [ "$TARGET" = "all" ]; then
  for d in "$CF_ROOT"/*/; do
    name=$(basename "$d")
    [ -f "$d/index.js" ] || { echo "⏭  跳过 $name（没有 index.js）"; continue; }
    if check_one "$name"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED_LIST="$FAILED_LIST $name"; fi
  done
else
  if check_one "$TARGET"; then PASS=1; else FAIL=1; FAILED_LIST=" $TARGET"; fi
fi

echo ""
echo "=================================================================="
echo "结果：✅ 通过 $PASS 个，❌ 失败 $FAIL 个"
[ -n "$FAILED_LIST" ] && echo "失败的：$FAILED_LIST"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "⚠️ 有失败项 —— 上传到云端前先修掉，否则部署后会报错。"
  exit 1
fi

echo ""
echo "✅ 全部通过，可以上传到微信云开发了。"
echo ""
echo "提醒：这只验证了「语法/依赖/加载」，业务逻辑还是要传上去实测。"
