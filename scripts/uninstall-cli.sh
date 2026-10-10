#!/bin/sh
# Removes installed launcher links for this Omarkd checkout, not the app itself.
set -e
if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [install-directory]\n' "$0" >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/.." && pwd -P)
target_dir=${1:-}

cancel() {
  printf 'Uninstallation cancelled; no changes made.\n'
  exit 0
}

is_launcher_link() {
  [ -L "$1" ] || return 1
  link=$(readlink "$1") || return 1
  case "$link" in
    /*) ;;
    *) link="$(dirname "$1")/$link" ;;
  esac
  [ "${link##*/}" = omarkd ] || return 1
  link_dir=$(cd "$(dirname "$link")" 2>/dev/null && pwd -P) || return 1
  [ "$link_dir/omarkd" = "$root/bin/omarkd" ]
}

set --
if [ -n "$target_dir" ]; then
  case "$target_dir" in
    /*) ;;
    *) target_dir="$PWD/$target_dir" ;;
  esac
  candidate="$target_dir/omarkd"
  if ! is_launcher_link "$candidate"; then
    printf 'Refusing to remove %s: not a launcher symlink for this checkout.\n' "$candidate" >&2
    exit 1
  fi
  set -- "$candidate"
else
  # Split PATH on colons only; preserve spaces and disable wildcard expansion.
  old_ifs=$IFS
  IFS=:
  set -f
  for directory in "$HOME/.local/bin" /usr/local/bin $PATH; do
    IFS=$old_ifs
    [ -n "$directory" ] || directory=$PWD
    [ -d "$directory" ] || continue
    directory=$(cd "$directory" && pwd -P)
    candidate="$directory/omarkd"
    if is_launcher_link "$candidate"; then
      duplicate=false
      for found in "$@"; do
        [ "$found" != "$candidate" ] || duplicate=true
      done
      if ! "$duplicate"; then
        set -- "$@" "$candidate"
      fi
    fi
  done
  IFS=$old_ifs
  set +f
fi

if [ "$#" -eq 0 ]; then
  printf 'No installed launcher links for this checkout found in PATH, ~/.local/bin, or /usr/local/bin.\n'
  printf 'For a custom location outside PATH, pass its install directory.\n'
  exit 0
fi

printf '\nOmarkd CLI uninstallation preview\n'
printf 'Source launcher (kept): %s\n' "$root/bin/omarkd"
printf 'Remove these installed symlinks only:\n'
for candidate in "$@"; do
  printf '  %s -> %s\n' "$candidate" "$(readlink "$candidate")"
done
printf 'The app, checkout, Markdown files, install directories, and shell configuration will be kept.\n'
printf 'No sudo is used. Other files or launchers from other checkouts will not be removed.\n'

if command -v gum >/dev/null 2>&1; then
  gum confirm "Remove the listed Omarkd launcher links?" --default=false || cancel
else
  printf 'Proceed with uninstallation? [y/N] '
  IFS= read -r answer || cancel
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) cancel ;;
  esac
fi

for candidate in "$@"; do
  if ! is_launcher_link "$candidate"; then
    printf 'Refusing to remove changed destination: %s\n' "$candidate" >&2
    exit 1
  fi
done
for candidate in "$@"; do
  rm -- "$candidate"
  printf 'Removed: %s\n' "$candidate"
done
