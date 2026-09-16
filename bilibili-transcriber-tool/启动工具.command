#!/bin/zsh
cd "${0:A:h}" || exit 1
export PATH="$PWD/../.venv/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node start.mjs
if [[ $? -ne 0 ]]; then
  read '?启动失败，按回车关闭。'
fi
