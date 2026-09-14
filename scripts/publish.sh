#!/usr/bin/env bash
# 按依赖顺序发布四个包：gateway → hub → (cli, web-remote)。
# 用法：bash scripts/publish.sh（在**交互终端**里跑，pnpm 会提示输入 2FA OTP）。
set -euo pipefail
cd "$(dirname "$0")/.."

for pkg in gateway hub cli web-remote; do
  echo ""
  echo "===== publishing ${pkg} ====="
  # 路径过滤（根包也叫 remote-dsh，不能用包名过滤）；
  # --no-git-checks 跳过工作区脏检查；--config.verify-deps-before-run=false 避免发布前偷偷 pnpm install。
  pnpm --filter "./packages/${pkg}" publish --no-git-checks --config.verify-deps-before-run=false
done

echo ""
echo "===== verify (latest) ====="
npm view rdsh-gateway version
npm view rdsh-hub version
npm view remote-dsh version
npm view dsh-web-remote version
