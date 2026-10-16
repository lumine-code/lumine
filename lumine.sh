#!/bin/bash

echoerr() { echo "$@" 1>&2; }

if [ "$(uname)" == Darwin ]; then
  OS=Mac
elif [[ "$(uname -s)" == Linux* ]]; then
  OS=Linux
else
  echoerr "Your platform ($(uname -a)) is not supported."
  exit 1
fi

LUMINE_BASE_NAME=$(basename "$0")
LUMINE_BASE_NAME=${LUMINE_BASE_NAME%.*}
export LUMINE_BASE_NAME
export LUMINE_CHANNEL=stable

# Desktop AppImages need the login shell environment; a terminal launch already
# has it. Keep an explicit caller preference on either route.
if [ -z "${LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT+x}" ]; then
  if [ -n "${APPIMAGE:-}" ] &&
     [ ! -t 0 ] && [ ! -t 1 ] && [ ! -t 2 ] &&
     { [ -z "${TERM:-}" ] || [ "${TERM:-}" = dumb ]; }; then
    export LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT=false
  else
    export LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT=true
  fi
fi

if [ -n "${REDIRECT_STDERR:-}" ]; then exec 2>/dev/null; fi

# Core owns creation and default config seeding, including on a first launch.
if [ -z "${LUMINE_HOME:-}" ]; then LUMINE_HOME="$HOME/.${LUMINE_BASE_NAME}"; fi
export LUMINE_HOME

SCRIPT=$(realpath "$0") || exit 1

if [ "$OS" == Mac ]; then
  LUMINE_APP="$(dirname "$(dirname "$(dirname "$SCRIPT")")")"
  if [[ "$LUMINE_APP" == *.app ]]; then
    LUMINE_PATH=$(dirname "$LUMINE_APP")
    LUMINE_APP_NAME=$(basename "$LUMINE_APP")
  else
    LUMINE_APP_NAME=Lumine.app
  fi
  if [ -z "${LUMINE_PATH:-}" ]; then
    if [ -x "/Applications/$LUMINE_APP_NAME" ]; then
      LUMINE_PATH=/Applications
    elif [ -x "$HOME/Applications/$LUMINE_APP_NAME" ]; then
      LUMINE_PATH="$HOME/Applications"
    else
      LUMINE_APP_SEARCH_RESULT=$(mdfind "kMDItemCFBundleIdentifier == 'io.github.lumine-code.${LUMINE_BASE_NAME}'" | grep -v ShipIt | head -1)
      if [ -n "$LUMINE_APP_SEARCH_RESULT" ]; then
        LUMINE_PATH=$(dirname "$LUMINE_APP_SEARCH_RESULT")
        LUMINE_APP_NAME=$(basename "$LUMINE_APP_SEARCH_RESULT")
      fi
    fi
  fi

  LUMINE_EXECUTABLE_NAME=${LUMINE_APP_NAME%.*}
  LUMINE_EXECUTABLE="$LUMINE_PATH/$LUMINE_APP_NAME/Contents/MacOS/$LUMINE_EXECUTABLE_NAME"
  LUMINE_HELPER="$LUMINE_PATH/$LUMINE_APP_NAME/Contents/Resources/lumine.js"
else
  LUMINE_EXECUTABLE_NAME=$LUMINE_BASE_NAME
  if [ -z "${LUMINE_PATH:-}" ]; then
    LUMINE_PATH=$(realpath "$(dirname "$(dirname "$SCRIPT")")")
    if [ ! -f "$LUMINE_PATH/$LUMINE_EXECUTABLE_NAME" ]; then
      if [ -f "/opt/Lumine/$LUMINE_EXECUTABLE_NAME" ]; then
        LUMINE_PATH=/opt/Lumine
      elif [ -f "${TMPDIR:-/tmp}/lumine-build/Lumine/$LUMINE_EXECUTABLE_NAME" ]; then
        LUMINE_PATH="${TMPDIR:-/tmp}/lumine-build/Lumine"
      else
        echoerr "Cannot locate Lumine. Set LUMINE_PATH to the directory containing the executable."
        exit 1
      fi
    fi
  fi
  LUMINE_EXECUTABLE="$LUMINE_PATH/$LUMINE_EXECUTABLE_NAME"
  LUMINE_HELPER="$LUMINE_PATH/resources/lumine.js"
fi

if [ ! -f "$LUMINE_EXECUTABLE" ] || [ ! -x "$LUMINE_EXECUTABLE" ]; then
  echoerr "Cannot execute $LUMINE_EXECUTABLE."
  exit 1
fi

# A source checkout uses the same helper as the packaged application.
if [ -f "$(dirname "$SCRIPT")/resources/lumine.js" ]; then
  LUMINE_HELPER="$(dirname "$SCRIPT")/resources/lumine.js"
fi
if [ ! -f "$LUMINE_HELPER" ]; then
  echoerr "Cannot locate the Lumine launcher helper: $LUMINE_HELPER."
  exit 1
fi

LUMINE_EXECUTABLE=$(realpath "$LUMINE_EXECUTABLE") || exit 1
LUMINE_HELPER=$(realpath "$LUMINE_HELPER") || exit 1
if [ "$OS" == Linux ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$LUMINE_EXECUTABLE" "$LUMINE_HELPER" "$LUMINE_EXECUTABLE" --no-sandbox "$@"
else
  ELECTRON_RUN_AS_NODE=1 exec "$LUMINE_EXECUTABLE" "$LUMINE_HELPER" "$LUMINE_EXECUTABLE" "$@"
fi
