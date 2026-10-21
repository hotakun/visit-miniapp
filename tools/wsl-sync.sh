#!/usr/bin/env bash
# =============================================================================
# 聚火拜访 · WSL → D 盘 镜像同步脚本
# =============================================================================
# 用途：把 WSL 里的项目目录（miniprogram / docs）单向同步到 Windows 的镜像目录，
#       供「微信开发者工具」和「在 D 盘查看文档」使用。
#
# 用法（在 WSL 终端里）：
#   bash tools/wsl-sync.sh              # 同步 miniprogram + docs
#   bash tools/wsl-sync.sh --dry-run    # 只看会改什么，不真同步
#   bash tools/wsl-sync.sh --check      # 只检查两边差异，不同步
#
# 别名（建议加到 ~/.bashrc）：
#   alias sync-wx='bash ~/work/visit-miniapp/tools/wsl-sync.sh'
# =============================================================================

set -euo pipefail

# ---------- 配置 ----------
SRC_ROOT="${SRC_ROOT:-$HOME/work/visit-miniapp}"
DST_ROOT="${DST_ROOT:-/mnt/d/WFR/visit-miniapp-mirror}"

# 要同步的目录（相对路径）。
# ⚠️ miniprogram/ 是「微信开发者工具的项目根」—— 里面同时有：
#    project.config.json（miniprogramRoot=miniprogram/、cloudfunctionRoot=cloudfunctions/）
#    miniprogram/    ← 页面代码
#    cloudfunctions/ ← 11 个云函数（要在这里右键上传部署）
#    所以必须**整目录同步**，不能只同步里层。
SYNC_DIRS=(
  "miniprogram"     # 整个小程序项目根（含云函数）—— 微信开发者工具必须
  "docs"            # 在 D 盘看文档
)

# 排除项
EXCLUDES=(
  "--exclude=node_modules/"
  "--exclude=.git/"
  "--exclude=*.log"
  "--exclude=cache/"
  "--exclude=media/"
)

# ---------- 参数 ----------
DRY_RUN=""
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --check)   CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 看用法）" >&2
      exit 1
      ;;
  esac
done

# ---------- 预检 ----------
if [ ! -d "$SRC_ROOT" ]; then
  echo "❌ 源目录不存在：$SRC_ROOT" >&2
  echo "   如果你还没把项目迁到 WSL，这条脚本暂时用不上（第一步用 D 盘时不需要镜像）。" >&2
  exit 1
fi

if [ ! -d "/mnt/d" ]; then
  echo "❌ 没找到 D 盘挂载点 /mnt/d" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "❌ 没有 rsync，先装：sudo apt install -y rsync" >&2
  exit 1
fi

mkdir -p "$DST_ROOT"

# ---------- 执行 ----------
echo "源  : $SRC_ROOT"
echo "目标: $DST_ROOT"
echo "模式: $([ "$CHECK_ONLY" = 1 ] && echo '仅检查' || ([ -n "$DRY_RUN" ] && echo '试运行' || echo '实际同步'))"
echo "----------------------------------------------------------------"

TOTAL_CHANGED=0
for d in "${SYNC_DIRS[@]}"; do
  src="$SRC_ROOT/$d"
  dst="$DST_ROOT/$d"

  if [ ! -d "$src" ]; then
    echo "跳过 $d（源目录不存在）"
    continue
  fi

  mkdir -p "$dst"

  if [ "$CHECK_ONLY" = 1 ]; then
    # --dry-run + itemize 只列差异
    out=$(rsync -ain --delete "${EXCLUDES[@]}" "$src/" "$dst/" || true)
    n=$(printf '%s\n' "$out" | grep -c . || true)
    if [ "$n" -eq 0 ]; then
      echo "✅ $d 无差异"
    else
      echo "⚠️  $d 有 $n 项差异："
      printf '%s\n' "$out" | head -20 | sed 's/^/     /'
      [ "$n" -gt 20 ] && echo "     ...（还有 $((n-20)) 项）"
      TOTAL_CHANGED=$((TOTAL_CHANGED + n))
    fi
  else
    rsync -a --delete --itemize-changes $DRY_RUN "${EXCLUDES[@]}" "$src/" "$dst/"
  fi
done

echo "----------------------------------------------------------------"
if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$TOTAL_CHANGED" -eq 0 ]; then
    echo "✅ 镜像与源完全一致"
  else
    echo "⚠️  共 $TOTAL_CHANGED 项差异 —— 跑一次不带参数的 bash tools/wsl-sync.sh 即可同步"
  fi
elif [ -n "$DRY_RUN" ]; then
  echo "（以上是试运行结果，未实际修改）"
else
  echo "✅ 同步完成"
  echo ""
  echo "接下来："
  echo "  1. 微信开发者工具 → 打开 $DST_ROOT/miniprogram （这是项目根）"
  echo "  2. 上传云函数：在 $DST_ROOT/miniprogram/cloudfunctions/ 下右键「上传并部署」"
fi
