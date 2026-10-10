#!/bin/sh
# Installs the `omarkd` command by symlinking bin/omarkd onto PATH.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
target_dir=${1:-}
if [ -z "$target_dir" ]; then
  if [ -w /usr/local/bin ]; then
    target_dir=/usr/local/bin
  else
    target_dir="$HOME/.local/bin"
  fi
fi
mkdir -p "$target_dir"
ln -sf "$root/bin/omarkd" "$target_dir/omarkd"
echo "Installed: $target_dir/omarkd -> $root/bin/omarkd"
case ":$PATH:" in
  *":$target_dir:"*) ;;
  *) echo "Note: add $target_dir to your PATH." ;;
esac
