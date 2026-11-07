#!/usr/bin/env bash
# One-line install on a Linux server or Mac:
#   curl -fsSL https://raw.githubusercontent.com/facc33176-rgb/earshot/main/install.sh | bash
set -e
DIR="${EARSHOT_DIR:-$HOME/earshot}"
command -v git >/dev/null || { echo "git is required (apt install git / brew install git)"; exit 1; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 20+ is required: https://nodejs.org  (Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs)"; exit 1
fi
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 https://github.com/facc33176-rgb/earshot.git "$DIR"; fi
cd "$DIR"
node tools/setup.cjs < /dev/tty
echo
if command -v pm2 >/dev/null; then pm2 start server/index.js --name earshot --update-env && pm2 save && echo "Running in the background with pm2. 已经在后台运行。";
else echo "Start it with:  cd $DIR && npm start      (or install pm2 to keep it running: npm i -g pm2)"; fi
