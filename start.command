#!/bin/bash
# macOS: double-click to start Earshot. 苹果电脑：双击启动。
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Please install Node.js first: https://nodejs.org  请先安装 Node.js"; read -r; exit 1; fi
[ -f .env ] || node tools/setup.cjs
(sleep 1.5; open "http://localhost:$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d ' ' || echo 8787)") &
node server/index.js
