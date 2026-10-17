#!/usr/bin/env bash
#
# AstroCode installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ahsannadir/astrocode/main/scripts/install.sh | bash
#
# Flags (also usable when piped, since prompts read from /dev/tty):
#   --version <v>     Install a specific version (default: latest)
#   --from-source     Skip the npm registry and build from a git clone
#   --dir <path>      Where a source build lives (default: ~/.astrocode/src)
#   --no-modify-path  Don't touch your shell profile
#   -h, --help        Show this help
#
set -euo pipefail

REPO="ahsannadir/astrocode"
PKG="astrocode"
BIN="astrocode"
MIN_NODE_MAJOR=18
MIN_NODE_MINOR=8
DEFAULT_SRC_DIR="${HOME}/.astrocode/src"

VERSION=""
FROM_SOURCE=0
SRC_DIR="${ASTROCODE_SRC_DIR:-$DEFAULT_SRC_DIR}"
MODIFY_PATH=1

# ---------------------------------------------------------------- presentation

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

info()  { printf '%s\n' "  ${DIM}$*${RESET}"; }
ok()    { printf '%s\n' "  ${GREEN}✓${RESET} $*"; }
warn()  { printf '%s\n' "  ${YELLOW}!${RESET} $*" >&2; }
step()  { printf '\n%s\n' "${BOLD}${CYAN}▸ $*${RESET}"; }
die()   { printf '\n%s\n' "${RED}✗ $*${RESET}" >&2; exit 1; }

# stdin is the script itself when piped, so interactive reads must come from the
# controlling terminal. Returns non-zero when there isn't one.
ask() {
  local prompt="$1" reply=""
  if [ -r /dev/tty ]; then
    printf '%s' "  $prompt " > /dev/tty
    read -r reply < /dev/tty || return 1
    printf '%s' "$reply"
    return 0
  fi
  return 1
}

confirm() {
  local prompt="$1" reply=""
  reply="$(ask "$prompt [y/N]")" || return 1
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

usage() {
  cat <<EOF
${BOLD}AstroCode installer${RESET}

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | bash

Options:
  --version <v>     Install a specific version (default: latest)
  --from-source     Skip the npm registry and build from a git clone
  --dir <path>      Where a source build lives (default: $DEFAULT_SRC_DIR)
  --no-modify-path  Don't touch your shell profile
  -h, --help        Show this help

Passing flags through a pipe:
  ... | bash -s -- --version 1.3.0
EOF
}

# ---------------------------------------------------------------------- args

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; [ -n "$VERSION" ] || die "--version needs a value"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --dir) SRC_DIR="${2:-}"; [ -n "$SRC_DIR" ] || die "--dir needs a value"; shift 2 ;;
    --dir=*) SRC_DIR="${1#*=}"; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ------------------------------------------------------------------- platform

OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$OS" in
  Darwin) PLATFORM="macOS ($ARCH)" ;;
  Linux)  PLATFORM="Linux ($ARCH)" ;;
  *)      PLATFORM="$OS ($ARCH)" ;;
esac

printf '\n%s\n' "${BOLD}AstroCode installer${RESET}"
info "platform: $PLATFORM"
[ -n "$VERSION" ] && info "version:  $VERSION" || info "version:  latest"
info "method:   $([ "$FROM_SOURCE" = 1 ] && echo 'source build' || echo 'npm registry, source fallback')"

# ----------------------------------------------------------------- node check

step "Checking Node.js"

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

if [ -z "$NODE_BIN" ]; then
  cat >&2 <<EOF

${RED}✗ Node.js was not found.${RESET}

  AstroCode runs on Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+. Install it first:

    macOS:  brew install node
    Linux:  https://nodejs.org/en/download  (or your distro's package manager)
    any:    curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22

  Then re-run this script.
EOF
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"

case "$NODE_MAJOR" in '' | *[!0-9]*) die "could not parse Node version from '$NODE_VERSION'" ;; esac
case "$NODE_MINOR" in '' | *[!0-9]*) NODE_MINOR=0 ;; esac

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] ||
  { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node $NODE_VERSION is too old — AstroCode needs ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+."
fi
ok "node $NODE_VERSION at $NODE_BIN"
[ -n "$NPM_BIN" ] && ok "npm $("$NPM_BIN" -v 2>/dev/null)" || warn "npm not found — will fall back to a source build"

# ------------------------------------------------------------ npm/registry path

# Is the package actually on the registry yet? A project that hasn't been
# published should still install cleanly, so probe once and remember.
registry_has_pkg() {
  [ -n "$NPM_BIN" ] || return 1
  local spec="$PKG"
  [ -n "$VERSION" ] && spec="$PKG@$VERSION"
  "$NPM_BIN" view "$spec" version >/dev/null 2>&1
}

installed_bin_dir() {
  "$NPM_BIN" prefix -g 2>/dev/null
}

installed_via_npm() {
  local spec="$PKG"
  [ -n "$VERSION" ] && spec="$PKG@$VERSION"

  step "Installing $spec from the npm registry"

  if "$NPM_BIN" install -g "$spec" --no-fund --no-audit; then
    ok "installed $spec globally"
    return 0
  fi

  # A permissions error on a system Node is common and fixable; anything else
  # means the registry path is unusable, so hand off to the source build.
  local prefix
  prefix="$(installed_bin_dir || true)"
  if [ -n "$prefix" ] && [ ! -w "$prefix/lib/node_modules" ]; then
    warn "no write access to $prefix/lib/node_modules"
    if confirm "Re-run the install with sudo?"; then
      sudo "$NPM_BIN" install -g "$spec" --no-fund --no-audit &&
        { ok "installed $spec globally (via sudo)"; return 0; }
    fi
  fi

  warn "npm install failed"
  return 1
}

# ------------------------------------------------------------- source fallback

installed_from_source() {
  step "Building from source"

  command -v git >/dev/null 2>&1 || die "git is required for a source build — install git and re-run."

  if [ -d "$SRC_DIR/.git" ]; then
    info "updating existing checkout at $SRC_DIR"
    git -C "$SRC_DIR" fetch --depth 1 origin >/dev/null 2>&1 || true
    git -C "$SRC_DIR" checkout --quiet main 2>/dev/null || true
    git -C "$SRC_DIR" pull --ff-only --quiet 2>/dev/null || warn "could not fast-forward; building what's there"
  else
    info "cloning $REPO into $SRC_DIR"
    mkdir -p "$(dirname "$SRC_DIR")"
    rm -rf "$SRC_DIR"
    git clone --depth 1 "https://github.com/$REPO.git" "$SRC_DIR" >/dev/null 2>&1 ||
      die "git clone failed — check your network and that github.com/$REPO is reachable."
  fi

  ok "source at $SRC_DIR"

  step "Installing dependencies and compiling"
  ( cd "$SRC_DIR" && "$NPM_BIN" install --no-fund --no-audit >/dev/null 2>&1 ) ||
    die "dependency install failed (run 'npm install' in $SRC_DIR to see why)"
  ( cd "$SRC_DIR" && "$NPM_BIN" run build >/dev/null 2>&1 ) ||
    die "build failed (run 'npm run build' in $SRC_DIR to see why)"
  ok "built dist/index.js"

  step "Linking the '$BIN' command"
  if ( cd "$SRC_DIR" && "$NPM_BIN" link >/dev/null 2>&1 ); then
    ok "linked $BIN onto your PATH"
    return 0
  fi

  # No permission to write the global bin dir: drop a shim in a user-local dir
  # and tell the user how to put it on PATH.
  local shim_dir="$HOME/.local/bin"
  mkdir -p "$shim_dir"
  cat > "$shim_dir/$BIN" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$SRC_DIR/dist/index.js" "\$@"
EOF
  chmod +x "$shim_dir/$BIN"
  ok "wrote launcher to $shim_dir/$BIN"
  NEEDS_PATH="$shim_dir"
}

# ------------------------------------------------------------------ path hint

NEEDS_PATH=""
NPM_PREFIX=""

if [ "$FROM_SOURCE" = 0 ] && registry_has_pkg; then
  installed_via_npm || installed_from_source
else
  if [ "$FROM_SOURCE" = 0 ]; then
    warn "$PKG isn't on the npm registry yet — building from source instead"
    info "once it's published, this script installs from npm automatically"
  fi
  installed_from_source
fi

if [ -z "$NEEDS_PATH" ]; then
  NPM_PREFIX="$(installed_bin_dir || true)"
  if [ -n "$NPM_PREFIX" ]; then
    NPM_PREFIX="$NPM_PREFIX/bin"
  fi
else
  NPM_PREFIX="$NEEDS_PATH"
fi

# -------------------------------------------------------------- shell profile

if [ "$MODIFY_PATH" = 1 ] && [ -n "$NPM_PREFIX" ] && [ -d "$NPM_PREFIX" ]; then
  case ":$PATH:" in
    *":$NPM_PREFIX:"*) ;;
    *)
      PROFILE=""
      case "$(basename "${SHELL:-}")" in
        zsh)  PROFILE="$HOME/.zshrc" ;;
        bash) [ -f "$HOME/.bashrc" ] && PROFILE="$HOME/.bashrc" || PROFILE="$HOME/.bash_profile" ;;
        fish) PROFILE="$HOME/.config/fish/config.fish" ;;
      esac
      if [ -n "$PROFILE" ] && [ -w "$PROFILE" ] &&
        ! grep -qF "$NPM_PREFIX" "$PROFILE" 2>/dev/null; then
        printf '\n# added by the AstroCode installer\nexport PATH="%s:$PATH"\n' "$NPM_PREFIX" >> "$PROFILE"
        ok "added $NPM_PREFIX to PATH in $PROFILE"
        info "run 'source $PROFILE' or open a new terminal"
      fi
      ;;
  esac
fi

# ------------------------------------------------------------------- verify

step "Verifying"

RESOLVED=""
if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/$BIN" ]; then
  RESOLVED="$NPM_PREFIX/$BIN"
else
  RESOLVED="$(command -v "$BIN" || true)"
fi

if [ -n "$RESOLVED" ]; then
  REPORTED="$("$RESOLVED" --version 2>/dev/null | tr -d '\r' | head -1 || true)"
  ok "$BIN installed at $RESOLVED${REPORTED:+ (version $REPORTED)}"
else
  warn "installed, but '$BIN' isn't on your PATH yet"
  [ -n "$NPM_PREFIX" ] && info "add this to your shell profile:  export PATH=\"$NPM_PREFIX:\$PATH\""
fi

cat <<EOF

${BOLD}${GREEN}AstroCode is ready.${RESET}

  ${BOLD}astrocode${RESET}                        launch in the current directory
  ${BOLD}astrocode --demo${RESET}                 try it with no API key
  ${BOLD}astrocode --cwd ~/code/project${RESET}   point it at a project
  ${BOLD}astrocode serve${RESET}                  expose its tools as an MCP server

  Then type ${CYAN}/login${RESET} to connect a provider, and ${CYAN}/help${RESET} for commands.
  Docs: https://github.com/$REPO
EOF
