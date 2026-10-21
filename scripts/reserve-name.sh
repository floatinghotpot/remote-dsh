#!/usr/bin/env bash
# 预留一个 npm 包名（占位 0.0.0，供 rdsh 的 DSH 插件 M4 用）。
#
# 用法: bash scripts/reserve-name.sh <name>
#   例: bash scripts/reserve-name.sh dsh-web-remote
#
# 逐个跑（不要一次循环三个）：npm 12 发布可能弹浏览器做 web auth，
# 每个名字单独跑一次，等浏览器认证完成后再跑下一个。
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: bash scripts/reserve-name.sh <name>" >&2
  exit 1
fi

D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT

cat > "$D/package.json" <<EOF
{
  "name": "$NAME",
  "version": "0.0.0",
  "description": "Reserved for remote-dsh (rdsh) — DSH plugin for remote access. Placeholder.",
  "license": "MIT"
}
EOF

cat > "$D/README.md" <<EOF
# $NAME

Reserved by the [remote-dsh](https://github.com/floatinghotpot/remote-dsh) project
for its DSH plugin (M4). Placeholder — not yet released.
EOF

echo "==> publishing $NAME (may open a browser for web auth; keep this terminal open)..."
(cd "$D" && npm publish)
echo "==> reserved $NAME"
