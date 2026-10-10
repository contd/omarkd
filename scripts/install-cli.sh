#!/bin/sh
# Installs the `omarkd` command by symlinking bin/omarkd onto PATH.
set -e
if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [install-directory]\n' "$0" >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/.." && pwd)
target_dir=${1:-}
use_gum=false
if command -v gum >/dev/null 2>&1; then
  use_gum=true
fi

cancel() {
  printf 'Installation cancelled; no changes made.\n'
  exit 0
}

if [ -z "$target_dir" ]; then
  if "$use_gum"; then
    printf 'Choose where to install the Omarkd command:\n'
    choice=$(gum choose "$HOME/.local/bin (current user)" "/usr/local/bin (system-wide)" "Custom directory") || cancel
    case "$choice" in
      "$HOME/.local/bin (current user)") target_dir="$HOME/.local/bin" ;;
      "/usr/local/bin (system-wide)") target_dir=/usr/local/bin ;;
      "Custom directory")
        target_dir=$(gum input --placeholder "Absolute or relative install directory") || cancel
        [ -n "$target_dir" ] || cancel
        ;;
      *) printf 'Invalid install destination selection.\n' >&2; exit 1 ;;
    esac
  elif [ -w /usr/local/bin ]; then
    target_dir=/usr/local/bin
  else
    target_dir="$HOME/.local/bin"
  fi
fi
case "$target_dir" in
  /*) ;;
  *) target_dir="$PWD/$target_dir" ;;
esac
destination="$target_dir/omarkd"
if [ -d "$destination" ]; then
  printf 'Cannot replace a directory: %s\n' "$destination" >&2
  exit 1
fi

printf '\nOmarkd CLI installation preview\n'
printf 'Source launcher: %s\nInstall directory: %s\nCommand link: %s\n' "$root/bin/omarkd" "$target_dir" "$destination"
printf 'This creates the install directory if needed and links the command to this checkout.\n'
if [ -e "$destination" ] || [ -L "$destination" ]; then
  printf 'WARNING: the existing file or symlink at %s will be replaced.\n' "$destination"
fi
printf 'No app bundle is installed, no shell configuration is changed, and sudo is not used.\n'
case ":$PATH:" in
  *":$target_dir:"*) printf 'The install directory is already on PATH.\n' ;;
  *) printf 'You will need to add %s to your PATH.\n' "$target_dir" ;;
esac

if "$use_gum"; then
  gum confirm "Install the Omarkd command at $destination?" --default=false || cancel
else
  printf 'Proceed with installation? [y/N] '
  IFS= read -r answer || cancel
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) cancel ;;
  esac
fi

mkdir -p "$target_dir"
ln -sf "$root/bin/omarkd" "$destination"
printf 'Installed: %s -> %s\n' "$destination" "$root/bin/omarkd"
case ":$PATH:" in
  *":$target_dir:"*) ;;
  *) printf 'Note: add %s to your PATH.\n' "$target_dir" ;;
esac
