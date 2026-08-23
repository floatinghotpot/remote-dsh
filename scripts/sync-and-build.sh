#!/usr/bin/env bash
# sync-and-build.sh — 从 GitHub 拉取最新代码并本地构建，更新全局 rdsh
#
# 用法: ./scripts/sync-and-build.sh
# 前提: pnpm 已安装（npm i -g pnpm）；SSH 可访问 github.com
# 效果: git pull (SSH) → pnpm install → 构建 portal + 各包 → npm link 到全局 rdsh
# 注意: 不会重启正在运行的 hub/join 服务，需要手动重启（见输出提示）。
# 注意: npm link 会让全局 rdsh 指向本仓库构建（覆盖 npm 全局安装的 remote-dsh）。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "== [1/4] git pull (SSH) =="
git pull --ff-only

echo "== [2/4] pnpm install --frozen-lockfile =="
pnpm install --frozen-lockfile

echo "== [3/4] 构建（portal 先行，hub 依赖其产物）=="
pnpm --filter rdsh-portal build
pnpm -r --filter '!rdsh-portal' build

echo "== [4/4] npm link: 全局 rdsh 指向本地构建 =="
cd packages/cli
npm link

echo ""
echo "== 完成 =="
echo "git HEAD : $(git -C "$ROOT" rev-parse --short HEAD)"
echo "rdsh     : $(rdsh --version)"
echo ""
echo "提示: 如需让正在运行的 hub/join 使用新代码，请重启对应服务："
echo "  pkill -f 'rdsh hub serve' && rdsh hub serve ...   (或 rdsh hub service restart)"
echo "  pkill -f 'rdsh join'      && rdsh join <hub-url> ..."
