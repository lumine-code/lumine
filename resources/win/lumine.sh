#!/bin/bash

# Use Electron's bundled Node runtime directly. Going through cmd.exe would
# parse the arguments again and loses paths containing spaces or shell syntax.
SCRIPT_PATH=$(readlink -f -- "$0") || exit 1
SCRIPT_DIR=$(dirname -- "$SCRIPT_PATH")
LUMINE_EXECUTABLE="$SCRIPT_DIR/../Lumine.exe"
WSL_LAUNCH=false
if command -v cygpath >/dev/null 2>&1; then
  windows_path() { cygpath -a -w -- "$1"; }
  LUMINE_LAUNCHER=$(cygpath -a -w -- "$SCRIPT_DIR/lumine.js") || exit 1
elif command -v wslpath >/dev/null 2>&1; then
  WSL_LAUNCH=true
  windows_path() { wslpath -w "$1"; }
  LUMINE_LAUNCHER=$(wslpath -w "$SCRIPT_DIR/lumine.js") || exit 1
else
  echo "Cannot convert paths to Windows paths (cygpath or wslpath is required)." >&2
  exit 1
fi

ARGS=()
OPTIONS=true
for argument in "$@"; do
  if [[ "$argument" == /* ]]; then
    argument=$(windows_path "$argument") || exit 1
  elif $OPTIONS; then
    case "$argument" in
      --) OPTIONS=false ;;
      --resource-path=/*|--log-file=/*|--user-data-dir=/*|--executed-from=/*|--link=/*|--unlink=/*)
        prefix=${argument%%=*}
        value=$(windows_path "${argument#*=}") || exit 1
        argument="$prefix=$value"
        ;;
      *)
        if [[ "$argument" != --* && "$argument" =~ ^(-[^rl]*[rl]=?)(/.*)$ ]]; then
          prefix=${BASH_REMATCH[1]}
          value=$(windows_path "${BASH_REMATCH[2]}") || exit 1
          argument="$prefix$value"
        fi
        ;;
    esac
  fi
  ARGS+=("$argument")
done

if $WSL_LAUNCH; then
  # WSL only exports named Linux variables to a Windows process through WSLENV.
  WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w" ELECTRON_RUN_AS_NODE=1 MSYS2_ARG_CONV_EXCL='*' "$LUMINE_EXECUTABLE" "$LUMINE_LAUNCHER" Lumine.exe "${ARGS[@]}"
else
  ELECTRON_RUN_AS_NODE=1 MSYS2_ARG_CONV_EXCL='*' "$LUMINE_EXECUTABLE" "$LUMINE_LAUNCHER" Lumine.exe "${ARGS[@]}"
fi
