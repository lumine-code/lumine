#!/bin/bash

echoerr() { echo "$@" 1>&2; }

if [ "$(uname)" == 'Darwin' ]; then
  OS='Mac'
elif [ "$(expr substr $(uname -s) 1 5)" == 'Linux' ]; then
  OS='Linux'
else
  echoerr "Your platform ($(uname -a)) is not supported."
  exit 1
fi

LUMINE_BASE_NAME=$(basename "$0")
LUMINE_BASE_NAME=${LUMINE_BASE_NAME%.*}
CHANNEL=stable
# Capture the name of this script so that we can use it at runtime.
export LUMINE_BASE_NAME
export LUMINE_CHANNEL=$CHANNEL

# Only infer LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT when the caller has not
# set it explicitly. AppImages use this same script for terminal and desktop
# launches, so the embedded desktop file cannot always provide the distinction.
if [ -z "${LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT+x}" ]
then
  if [ -n "${APPIMAGE:-}" ] &&
     [ ! -t 0 ] && [ ! -t 1 ] && [ ! -t 2 ] &&
     { [ -z "${TERM:-}" ] || [ "${TERM:-}" = "dumb" ]; }
  then
    # A standalone AppImage launched without a terminal needs the user's login
    # shell environment, just like a launch through the desktop file.
    export LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT=false
  else
    export LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT=true
  fi
fi

LUMINE_ADD=false
LUMINE_NEW_WINDOW=false
WAIT=false
EXPECT_OUTPUT=false
LUMINE_FOREGROUND=false
LUMINE_TEST=false
LUMINE_HELP=false
LUMINE_VERSION=false
LUMINE_LIST=false
LUMINE_PACKAGE=false
LUMINE_PACKAGE_COMMAND=false
LUMINE_LOGGING=false
LUMINE_URI_HANDLER=false
EXIT_CODE_OVERRIDE=

# Inspect arguments without shifting them: the executable receives the original
# array, including empty arguments and literal names after --. Match the shared
# parser's option values and final boolean values rather than stopping at the
# first path as getopts does.
set_launcher_flag() {
  case "$1" in
    add|a) LUMINE_ADD="$2" ;;
    new-window|n) LUMINE_NEW_WINDOW="$2" ;;
    wait|w) WAIT="$2" ;;
    foreground|f|benchmark|benchmark-test) LUMINE_FOREGROUND="$2" ;;
    test|t) LUMINE_TEST="$2" ;;
    help|h) LUMINE_HELP="$2" ;;
    version|v) LUMINE_VERSION="$2" ;;
    list) LUMINE_LIST="$2" ;;
    package|p) LUMINE_PACKAGE="$2" ;;
    enable-electron-logging) LUMINE_LOGGING="$2" ;;
    uri-handler) LUMINE_URI_HANDLER="$2" ;;
  esac
}

LUMINE_ARGS=("$@")
for ((LUMINE_INDEX = 0; LUMINE_INDEX < ${#LUMINE_ARGS[@]}; LUMINE_INDEX++)); do
  LUMINE_ARGUMENT="${LUMINE_ARGS[LUMINE_INDEX]}"
  case "$LUMINE_ARGUMENT" in
    --) break ;;
    -psn_*) continue ;;
    --*)
      LUMINE_NAME="${LUMINE_ARGUMENT%%=*}"
      LUMINE_NAME="${LUMINE_NAME#--}"
      LUMINE_VALUE=true
      if [[ "$LUMINE_NAME" == no-* ]]; then
        case "${LUMINE_NAME#no-}" in
          add|new-window|wait|foreground|benchmark|benchmark-test|test|help|version|list|package|enable-electron-logging|uri-handler)
            set_launcher_flag "${LUMINE_NAME#no-}" false
            ;;
        esac
        continue
      fi
      if [[ "$LUMINE_ARGUMENT" == *=* ]] && [ "${LUMINE_ARGUMENT#*=}" = false ]; then
        LUMINE_VALUE=false
      fi
      case "$LUMINE_NAME" in
        install|uninstall|link|unlink) LUMINE_PACKAGE_COMMAND=true ;;
      esac
      case "$LUMINE_NAME" in
        log-file|resource-path|timeout|user-data-dir|install|uninstall|link|unlink|executed-from|pid|path-environment)
          if [[ "$LUMINE_ARGUMENT" != *=* ]] &&
             ((LUMINE_INDEX + 1 < ${#LUMINE_ARGS[@]})) &&
             [[ "${LUMINE_ARGS[LUMINE_INDEX + 1]}" != -* ]]; then
            ((LUMINE_INDEX++))
          fi
          ;;
        add|new-window|wait|foreground|benchmark|benchmark-test|test|help|version|list|package|enable-electron-logging|uri-handler)
          set_launcher_flag "$LUMINE_NAME" "$LUMINE_VALUE"
          ;;
      esac
      ;;
    -_|-) ;;
    -*)
      LUMINE_SHORT="${LUMINE_ARGUMENT#-}"
      for ((LUMINE_OFFSET = 0; LUMINE_OFFSET < ${#LUMINE_SHORT}; LUMINE_OFFSET++)); do
        LUMINE_FLAG="${LUMINE_SHORT:LUMINE_OFFSET:1}"
        case "$LUMINE_FLAG" in
          l|r)
            LUMINE_VALUE="${LUMINE_SHORT:LUMINE_OFFSET + 1}"
            LUMINE_VALUE="${LUMINE_VALUE#=}"
            if [ -z "$LUMINE_VALUE" ] && ((LUMINE_INDEX + 1 < ${#LUMINE_ARGS[@]})); then
              ((LUMINE_INDEX++))
            fi
            break
            ;;
          *) set_launcher_flag "$LUMINE_FLAG" true ;;
        esac
      done
      ;;
  esac
done

# Help/version and the retired package option exit before URI handling. All
# remaining editor options are discarded by the core's URI-only launch mode.
if [ "$LUMINE_URI_HANDLER" = true ] && [ "$LUMINE_HELP" = false ] &&
   [ "$LUMINE_VERSION" = false ] && [ "$LUMINE_PACKAGE" = false ]; then
  WAIT=false
  LUMINE_ADD=false
  LUMINE_NEW_WINDOW=false
  LUMINE_TEST=false
  LUMINE_LIST=false
  LUMINE_PACKAGE_COMMAND=false
fi

if [ "$LUMINE_FOREGROUND" = true ] || [ "$LUMINE_TEST" = true ] ||
   [ "$LUMINE_HELP" = true ] || [ "$LUMINE_VERSION" = true ] ||
   [ "$LUMINE_LIST" = true ] || [ "$LUMINE_PACKAGE" = true ] ||
   [ "$LUMINE_PACKAGE_COMMAND" = true ]; then
  EXPECT_OUTPUT=true
fi
if [ "$LUMINE_LOGGING" = true ]; then export ELECTRON_ENABLE_LOGGING=1; fi

if [ "$LUMINE_TEST" = true ] || [ "$LUMINE_HELP" = true ] ||
   [ "$LUMINE_VERSION" = true ] || [ "$LUMINE_LIST" = true ] ||
   [ "$LUMINE_PACKAGE" = true ] || [ "$LUMINE_PACKAGE_COMMAND" = true ]; then
  WAIT=false
fi

if [ "$LUMINE_ADD" = true ] && [ "$LUMINE_NEW_WINDOW" = true ] &&
   [ "$LUMINE_HELP" = false ] && [ "$LUMINE_VERSION" = false ]; then
  EXPECT_OUTPUT=true
  WAIT=false
  EXIT_CODE_OVERRIDE=1
fi

if [ $REDIRECT_STDERR ]; then
  exec 2> /dev/null
fi

# Keep a different $LUMINE_HOME for each release channel.
if [ -z "$LUMINE_HOME" ]
then
  LUMINE_HOME="$HOME/.${LUMINE_BASE_NAME}"
fi
export LUMINE_HOME

# The core seeds a missing config directory. Launcher output and wait state
# must not create it first, or a shell launch would skip the default files.
LUMINE_WAIT_DIRECTORY=
cleanup_wait() {
  if [ -n "$LUMINE_WAIT_DIRECTORY" ]; then
    exec 3>&-
    rm -f "$LUMINE_WAIT_DIRECTORY/wait"
    rmdir "$LUMINE_WAIT_DIRECTORY"
  fi
}
on_die() { exit 0; }
trap cleanup_wait EXIT
trap on_die SIGQUIT SIGTERM

if [ "$WAIT" = true ]; then
  LUMINE_WAIT_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/lumine-wait.XXXXXXXX") || exit 1
  mkfifo "$LUMINE_WAIT_DIRECTORY/wait" || exit 1
  # Keep both ends open before launching. A failed child can report its status
  # even if the parent has already exited, without blocking while opening it.
  exec 3<> "$LUMINE_WAIT_DIRECTORY/wait" || exit 1
fi

# With --wait, even a command whose output is attached must let the shell handle
# the editor's release signal while the application remains alive. A synchronous
# foreground child defers Bash traps until that entire application exits.
run_with_output() {
  if [ "$WAIT" = true ]; then
    (
      "$@" 3>&-
      LUMINE_EXIT=$?
      if [ "$LUMINE_EXIT" -ne 0 ]; then printf '%s\n' "$LUMINE_EXIT" >&3; fi
    ) <&0 &
  else
    "$@"
    LUMINE_EXIT=$?
    if [ "$LUMINE_EXIT" -eq 0 ] && [ -n "$EXIT_CODE_OVERRIDE" ]; then
      exit "$EXIT_CODE_OVERRIDE"
    fi
    exit "$LUMINE_EXIT"
  fi
}

if [ $OS == 'Mac' ]; then
  SCRIPT="$(realpath "$0")"
  LUMINE_APP="$(dirname "$(dirname "$(dirname "$SCRIPT")")")"

  # If this is a `lumine.sh` from a built version of Lumine, then `$LUMINE_APP`
  # should now be the path to the user's instance of Lumine.app.
  if [[ "$LUMINE_APP" == . || "$LUMINE_APP" != *".app" ]]; then
    # This is a `lumine.sh` that's in the source code of Lumine or has been
    # copied to a location outside of the app (instead of symlinked). We'll try
    # another tactic.
    unset LUMINE_APP
  else
    # We found the location of the Lumine.app that this script lives in.
    LUMINE_PATH="$(dirname "$LUMINE_APP")"
    LUMINE_APP_NAME="$(basename "$LUMINE_APP")"
  fi

  if [ -n "${LUMINE_APP_NAME}" ]; then
    # If LUMINE_APP_NAME is known, use it as the executable name
    LUMINE_EXECUTABLE_NAME="${LUMINE_APP_NAME%.*}"
  else
    LUMINE_EXECUTABLE_NAME="Lumine"
    LUMINE_APP_NAME="${LUMINE_EXECUTABLE_NAME}.app"
  fi

  if [ -z "${LUMINE_PATH}" ]; then
    # If LUMINE_PATH isn't set, check /Applications and then ~/Applications for
    # Lumine.app.
    if [ -x "/Applications/${LUMINE_APP_NAME}" ]; then
      LUMINE_PATH="/Applications"
    elif [ -x "$HOME/Applications/${LUMINE_APP_NAME}" ]; then
      LUMINE_PATH="$HOME/Applications"
    else
      # We still haven't found it. Let's try searching for it via
      # Spotlight.
      LUMINE_APP_SEARCH_RESULT="$(mdfind "kMDItemCFBundleIdentifier == 'io.github.lumine-code.${LUMINE_BASE_NAME}'" | grep -v ShipIt | head -1)"
      if [ ! -z "$LUMINE_APP_SEARCH_RESULT" ]; then
        LUMINE_PATH="$(dirname "$LUMINE_APP_SEARCH_RESULT")"
        LUMINE_APP_NAME="$(basename "$LUMINE_APP_SEARCH_RESULT")"
      fi
    fi
  fi

  LUMINE_EXECUTABLE="$LUMINE_PATH/$LUMINE_APP_NAME/Contents/MacOS/$LUMINE_EXECUTABLE_NAME"

  # Exit if Lumine can't be found.
  if [ ! -x "${LUMINE_EXECUTABLE}" ]; then
    echoerr "Cannot locate ${LUMINE_APP_NAME}; it is usually located in /Applications. Set the LUMINE_PATH environment variable to the directory containing ${LUMINE_APP_NAME}."
    exit 1
  fi

  if [ "$EXPECT_OUTPUT" = true ]; then
    run_with_output "$LUMINE_EXECUTABLE" --executed-from="$(pwd)" --pid=$$ "$@"
  else
    open -a "$LUMINE_PATH/$LUMINE_APP_NAME" -n -g --args --executed-from="$(pwd)" --pid=$$ --path-environment="$PATH" "$@" 3>&- || exit $?
  fi
elif [ $OS == 'Linux' ]; then

  # Set tmpdir only if it's unset.
  : ${TMPDIR:=/tmp}

  # We think that
  #
  # * `LUMINE_APP_NAME` will refer to the human-readable app name (“Lumine”)
  # * `LUMINE_EXECUTABLE_NAME` will refer to the executable we must run to launch
  #   it (`lumine`)

  LUMINE_EXECUTABLE_NAME=$LUMINE_BASE_NAME
  LUMINE_APP_NAME="Lumine"

  # If `LUMINE_PATH` is set by the user, we'll assume they know what they're
  # doing. Otherwise we should try to find it ourselves.
  if [ -z "${LUMINE_PATH}" ]; then
    # Attempt to infer the installation directory of Lumine from the location
    # of this script. When symlinked to a common location like
    # `/usr/local/bin`, this approach should find the true location of the
    # Lumine installation.
    if [ -L "$0" ]; then
      SCRIPT="$(readlink -f "$0")"
    else
      SCRIPT="$0"
    fi

    # The `lumine.sh` file lives one directory deeper than the root directory
    # that contains the `lumine` binary.
    LUMINE_APP="$(dirname "$(dirname "$SCRIPT")")"
    LUMINE_PATH="$(realpath "$LUMINE_APP")"

    if [ ! -f "$LUMINE_PATH/${LUMINE_EXECUTABLE_NAME}" ]; then
      # If that path doesn't contain a `lumine` executable, then it's not a
      # valid path. We'll try something else.
      unset LUMINE_APP
      unset LUMINE_PATH
    fi

    if [ -z "${LUMINE_PATH}" ]; then
      if [ -f "/opt/${LUMINE_APP_NAME}/${LUMINE_EXECUTABLE_NAME}" ]; then
        # Check the default installation directory for RPM and DEB
        # distributions.
        LUMINE_PATH="/opt/${LUMINE_APP_NAME}"
      elif [ -f "$TMPDIR/lumine-build/${LUMINE_APP_NAME}/${LUMINE_EXECUTABLE_NAME}" ]; then
        # This is where Lumine can be found during some CI build tasks.
        LUMINE_PATH="$TMPDIR/lumine-build/${LUMINE_APP_NAME}"
      else
        echoerr "Cannot locate ${LUMINE_APP_NAME}. Set the LUMINE_PATH environment variable to the directory containing the \`${LUMINE_BASE_NAME}\` executable."
        exit 1
      fi
    fi
  fi

  LUMINE_EXECUTABLE="$LUMINE_PATH/$LUMINE_EXECUTABLE_NAME"

  if [ ! -f "$LUMINE_EXECUTABLE" ] || [ ! -x "$LUMINE_EXECUTABLE" ]; then
    echoerr "Cannot execute ${LUMINE_EXECUTABLE}."
    exit 1
  fi

  if [ "$EXPECT_OUTPUT" = true ]; then
    run_with_output "$LUMINE_EXECUTABLE" --executed-from="$(pwd)" --pid=$$ --no-sandbox "$@"
  else
    LUMINE_OUTPUT_DIRECTORY=$(mktemp -d "$TMPDIR/lumine-output.XXXXXXXX") || exit 1
    (
      nohup "$LUMINE_EXECUTABLE" --executed-from="$(pwd)" --pid=$$ --no-sandbox "$@" 3>&- > "$LUMINE_OUTPUT_DIRECTORY/output" 2>&1
      LUMINE_EXIT=$?
      if [ "$LUMINE_EXIT" -ne 0 ]; then cat "$LUMINE_OUTPUT_DIRECTORY/output"; fi
      if [ "$LUMINE_EXIT" -ne 0 ] && [ "$WAIT" = true ]; then
        printf '%s\n' "$LUMINE_EXIT" >&3
      fi
      rm -f "$LUMINE_OUTPUT_DIRECTORY/output"
      rmdir "$LUMINE_OUTPUT_DIRECTORY"
      exit "$LUMINE_EXIT"
    ) &
  fi
fi

# If the wait flag is set, don't exit this process until Lumine kills it.
if [ "$WAIT" = true ]; then
  # Successful opens end through SIGTERM from the editor. A failed Linux
  # launch writes its status instead, so --wait cannot outlive a failed child.
  if IFS= read -r LUMINE_WAIT_EXIT <&3; then exit "$LUMINE_WAIT_EXIT"; fi
  exit 1
fi
