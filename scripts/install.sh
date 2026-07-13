#!/usr/bin/env bash
#
# brain installer / updater for Linux and macOS — the Unix counterpart of
# scripts/install.ps1.
#
# Installs the prerequisites for the mode you pick, clones (or updates) brain,
# prepares it, registers a global 'brain' command (start brain from any
# folder), and optionally starts it.
#
# Two modes:
#
#   docker      The full experience: lobby, grow-a-brain wizard, one isolated
#               FLUJO per brain, Ollama for local models. Needs Git and Docker
#               (Engine + Compose on Linux, Docker Desktop on macOS).
#
#   standalone  One brain, no Docker: same-origin proxy, live execution
#               animation, brain-stem tools. Needs Git and Node.js >= 20.
#
# Run directly:
#
#     bash scripts/install.sh
#
# or as a one-liner straight from GitHub:
#
#     curl -fsSL https://raw.githubusercontent.com/flujo-app/brain/main/scripts/install.sh | bash
#
# Prompts read from /dev/tty, so the one-liner stays interactive. With no
# terminal at all (CI, containers) the defaults apply. Environment overrides:
#
#     BRAIN_DIR       install folder                  (default: $HOME/brain)
#     BRAIN_MODE      docker | standalone             (default: docker)
#     BRAIN_BRANCH    git branch                      (default: main)
#     BRAIN_START     start brain after installing    1/true/yes or 0/false/no
#     BRAIN_SHORTCUT  desktop entry, Linux only       1/true/yes or 0/false/no

set -euo pipefail

REPO_URL='https://github.com/flujo-app/brain'
BRANCH="${BRAIN_BRANCH:-main}"
# vite 5 / tsx want a modern runtime; distro repos often ship older.
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=0
BIN_DIR="$HOME/.local/bin"
MANIFEST_DIR="$HOME/.local/share/brain-cli"

# --- output helpers (color only when stderr is a terminal) -------------------
if [ -t 2 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_TITLE=$'\033[35m'; C_END=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_WARN=''; C_TITLE=''; C_END=''
fi
step() { printf '\n%s==> %s%s\n' "$C_STEP" "$1" "$C_END" >&2; }
ok()   { printf '%s    %s%s\n'   "$C_OK"   "$1" "$C_END" >&2; }
warn() { printf '%s    %s%s\n'   "$C_WARN" "$1" "$C_END" >&2; }
die()  { printf '\n%sERROR: %s%s\n' "$C_WARN" "$1" "$C_END" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Prompt helpers that work when the script is piped into bash (curl | bash):
# stdin is the script itself there, so prompts must read from /dev/tty. With no
# tty at all the default answer is used.
ask() { # ask "question" "default" -> prints the answer
  local answer=''
  if [ -r /dev/tty ]; then
    printf '%s ' "$1" >&2
    IFS= read -r answer < /dev/tty || answer=''
  fi
  if [ -n "$answer" ]; then printf '%s' "$answer"; else printf '%s' "$2"; fi
}
ask_yn() { # ask_yn "question" -> 0 = yes (the default), 1 = no
  case "$(ask "$1 (Y/n)" y)" in
    [nN]|[nN][oO]) return 1 ;;
    *) return 0 ;;
  esac
}
# Interpret a BRAIN_* env flag: 0 = yes, 1 = no, 2 = unset/unrecognized.
flag() {
  case "${1:-}" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
    *) return 2 ;;
  esac
}

node_version_ok() {
  have node || return 1
  local v major minor
  v="$(node -v 2>/dev/null)" || return 1
  v="${v#v}"
  IFS=. read -r major minor _ <<EOF
$v
EOF
  [ "${major:-0}" -gt "$MIN_NODE_MAJOR" ] 2>/dev/null && return 0
  [ "${major:-0}" -eq "$MIN_NODE_MAJOR" ] 2>/dev/null && [ "${minor:-0}" -ge "$MIN_NODE_MINOR" ] 2>/dev/null
}

printf '%sbrain Installer%s\n' "$C_TITLE" "$C_END" >&2
printf '%s===============%s\n' "$C_TITLE" "$C_END" >&2

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *) die "Unsupported platform '$OS'. Use scripts/install.ps1 on Windows." ;;
esac

have curl || die "curl is required to bootstrap the prerequisites. Install curl and re-run."

# sudo is only used for package-manager installs and (on Linux) the Docker
# daemon; everything else stays in $HOME.
SUDO=''
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then
    SUDO='sudo'
  else
    warn "Neither running as root nor is sudo available; prerequisite installs may fail."
  fi
fi

# Set to "$SUDO" when the daemon is only reachable as root (user not yet in the
# 'docker' group). Used for all install-time docker calls.
DOCKER_SUDO=''
docker_ok()      { docker info >/dev/null 2>&1; }
docker_sudo_ok() { [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; }
compose() {
  if $DOCKER_SUDO docker compose version >/dev/null 2>&1; then
    $DOCKER_SUDO docker compose "$@"
  elif have docker-compose; then
    $DOCKER_SUDO docker-compose "$@"
  else
    return 127
  fi
}

# ---------------------------------------------------------------------------
# 1. Gather all the user's choices up front, then run the install in one go.
# ---------------------------------------------------------------------------
MODE="${BRAIN_MODE:-}"
case "$MODE" in
  docker|standalone) ;;
  1) MODE=docker ;;
  2) MODE=standalone ;;
  '') ;;
  *) warn "Unknown BRAIN_MODE '$MODE' (expected 'docker' or 'standalone')."; MODE='' ;;
esac
if [ -z "$MODE" ]; then
  printf '\n%sHow do you want to run brain?%s\n' "$C_STEP" "$C_END" >&2
  printf '  [1] docker      - the full experience: lobby, grow-a-brain, one isolated FLUJO per brain (needs Docker)\n' >&2
  printf '  [2] standalone  - one brain, no Docker (needs Node.js >= %s)\n' "$MIN_NODE_MAJOR" >&2
  case "$(ask "Pick a mode (press Enter for: 1)" 1)" in
    2|standalone) MODE=standalone ;;
    *) MODE=docker ;;
  esac
fi
ok "Mode: $MODE"

INSTALL_DIR="${BRAIN_DIR:-}"
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$(ask "Where should brain be installed? (press Enter for: $HOME/brain)" "$HOME/brain")"
fi
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
ok "Installing into: $INSTALL_DIR"

MAKE_SHORTCUT=false
if [ "$OS" = Linux ]; then
  if flag "${BRAIN_SHORTCUT:-}"; then
    MAKE_SHORTCUT=true
  elif [ $? -eq 2 ]; then
    if ask_yn "Create a desktop entry for brain?"; then MAKE_SHORTCUT=true; fi
  fi
fi

START_AFTER=false
if flag "${BRAIN_START:-}"; then
  START_AFTER=true
elif [ $? -eq 2 ]; then
  if ask_yn "Start brain when the install finishes?"; then START_AFTER=true; fi
fi

# Record what was already on the system BEFORE we touch it, so the install
# manifest can note what a future uninstaller may safely remove.
PRE_GIT=$(have git && echo true || echo false)
PRE_DOCKER=$(have docker && echo true || echo false)
PRE_NODE=$(have node && echo true || echo false)

# ---------------------------------------------------------------------------
# 2. Install prerequisites.
# ---------------------------------------------------------------------------
PM=''
if [ "$OS" = Darwin ]; then
  PM='brew'
  have brew || warn "Homebrew was not found; it is needed if Git or other tools must be installed."
else
  if have apt-get; then PM='apt'
  elif have dnf;   then PM='dnf'
  elif have pacman; then PM='pacman'
  elif have zypper; then PM='zypper'
  elif have apk;    then PM='apk'
  elif have yum;    then PM='yum'
  else
    warn "No supported package manager found (apt/dnf/pacman/zypper/apk/yum)."
    warn "Install the prerequisites yourself, then re-run."
  fi
fi

APT_UPDATED=false
pm_install() {
  case "$PM" in
    apt)
      if [ "$APT_UPDATED" = false ]; then $SUDO apt-get update; APT_UPDATED=true; fi
      $SUDO apt-get install -y "$@" ;;
    dnf)    $SUDO dnf install -y "$@" ;;
    yum)    $SUDO yum install -y "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
    apk)    $SUDO apk add "$@" ;;
    brew)   brew install "$@" ;;
    *)      return 1 ;;
  esac
}

# Git (needed in both modes for the clone/update below)
if have git; then
  ok "Git already installed ($(command -v git))"
else
  step "Installing Git"
  pm_install git || die "Could not install Git. Install it manually and re-run."
fi

if [ "$MODE" = docker ]; then
  # ------------------------------- Docker -----------------------------------
  if have docker; then
    ok "Docker already installed ($(command -v docker))"
  elif [ "$OS" = Darwin ]; then
    warn "Docker Desktop was not found."
    if have brew && ask_yn "Install Docker Desktop via Homebrew (brew install --cask docker)?"; then
      step "Installing Docker Desktop"
      brew install --cask docker || die "Could not install Docker Desktop. Get it from https://www.docker.com/products/docker-desktop/ and re-run."
    else
      die "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ (or via 'brew install --cask docker'), start it once, then re-run."
    fi
  else
    warn "Docker was not found."
    if ask_yn "Install Docker Engine via the official script (get.docker.com)?"; then
      step "Installing Docker Engine (includes the Compose plugin)"
      curl -fsSL https://get.docker.com | $SUDO sh || die "Docker installation failed. See https://docs.docker.com/engine/install/ and re-run."
    else
      die "Install Docker Engine + the Compose plugin (https://docs.docker.com/engine/install/), then re-run."
    fi
  fi

  # The CLI existing is not enough - the daemon must be running and reachable.
  if ! docker_ok; then
    if [ "$OS" = Darwin ]; then
      step "Starting Docker Desktop"
      open -ga Docker 2>/dev/null || true
      warn "If this is Docker Desktop's first launch, accept its service agreement in the window that opened."
      ok "Waiting for the Docker engine (up to 3 minutes) ..."
      for _ in $(seq 1 36); do
        docker_ok && break
        sleep 5
      done
      docker_ok || die "The Docker engine did not become ready. Finish Docker Desktop's setup, then re-run this installer."
    else
      # Try to start the daemon first (fresh installs usually auto-start it).
      if ! docker_sudo_ok; then
        step "Starting the Docker daemon"
        $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
        sleep 3
      fi
      if docker_ok; then
        : # reachable without sudo after all
      elif docker_sudo_ok; then
        # Daemon runs, but this user cannot reach the socket yet.
        DOCKER_SUDO="$SUDO"
        warn "Your user is not in the 'docker' group, so docker currently needs sudo."
        if ask_yn "Add $USER to the 'docker' group? (takes effect after you log out and back in)"; then
          $SUDO usermod -aG docker "$USER" && ok "Added. After your next login, 'brain' works without sudo."
        else
          warn "Skipped. The 'brain' command will need the group membership (or sudo) to work."
        fi
      else
        die "The Docker daemon is not reachable. Start it (systemctl start docker) and re-run this installer."
      fi
    fi
  fi
  ok "Docker engine is running."
  compose version >/dev/null 2>&1 || die "Docker Compose was not found. Install the compose plugin (docker-compose-plugin) and re-run."
else
  # ------------------------------- Node.js ----------------------------------
  # Distro repos are often too old, so apt/dnf/yum go through NodeSource;
  # pacman/apk/brew ship current versions.
  if node_version_ok; then
    ok "Node.js already installed ($(node -v), $(command -v node))"
  else
    if have node; then
      warn "Node.js $(node -v) is older than the required ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}; upgrading."
    fi
    step "Installing Node.js (includes npm)"
    case "$PM" in
      apt)
        curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO:+$SUDO -E} bash -
        $SUDO apt-get install -y nodejs
        ;;
      dnf|yum)
        curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
        pm_install nodejs
        ;;
      pacman) pm_install nodejs npm ;;
      apk)    pm_install nodejs npm ;;
      zypper) pm_install nodejs22 npm22 || pm_install nodejs npm ;;
      brew)
        if have node; then brew upgrade node || true; else brew install node; fi
        ;;
      *) die "Cannot install Node.js automatically. Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} and re-run." ;;
    esac
    node_version_ok || die "Node.js install finished but 'node' >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is not on PATH. Open a new terminal and re-run."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Clone or update the repository.
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  step "Existing brain clone found - updating ($BRANCH)"
  # Hard-reset instead of pull: npm installs rewrite package-lock.json, leaving
  # the tree dirty, so `git pull` aborts. This is an install/deploy copy, not a
  # dev checkout, so discarding tracked-file drift is safe; untracked
  # node_modules/dist and Docker volumes are unaffected.
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  step "Cloning brain into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Prepare the install (build images / install dependencies).
# ---------------------------------------------------------------------------
cd "$INSTALL_DIR"
if [ "$MODE" = docker ]; then
  # Pull the prebuilt images. The FLUJO base feeds the local flujo-browser
  # build (FLUJO + headless Chromium for the "browser" skill). Best effort:
  # anything missing is built or pulled on first `docker compose up`.
  step "Pulling prebuilt images (FLUJO, Ollama)"
  $DOCKER_SUDO docker pull ghcr.io/mario-andreschak/flujo:latest || warn "Could not pull the FLUJO base image; the flujo build will fetch it itself."
  compose pull ollama || warn "Could not pull the Ollama image; 'docker compose up' will."

  step "Building the images (docker compose build brain flujo)"
  compose build brain flujo || die "docker compose build failed."
  ok "Images ready."
else
  step "Installing npm dependencies (npm install)"
  # --include=dev: the vite/tsc build needs devDependencies, which npm prunes
  # when NODE_ENV=production.
  npm install --include=dev

  # Prefetch the manager's dependencies too; `npm run standalone` would do it
  # on first start, but doing it now makes that start much quicker.
  step "Installing manager dependencies (npm install --prefix manager)"
  npm install --prefix manager
  ok "Dependencies installed."
fi

# ---------------------------------------------------------------------------
# 5. Register the global 'brain' command.
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/brain"
if [ "$MODE" = docker ]; then
  cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# brain launcher (docker mode) - generated by install.sh
BRAIN_HOME="$INSTALL_DIR"
if [ ! -f "\$BRAIN_HOME/docker-compose.yml" ]; then
  echo "brain was not found at \$BRAIN_HOME. Please re-run the installer." >&2
  exit 1
fi
cd "\$BRAIN_HOME" || exit 1
echo "Starting brain (docker compose up -d) ..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d
else
  docker-compose up -d
fi || { echo "Could not start the stack. Is Docker running (and are you in the 'docker' group)?" >&2; exit 1; }
echo "brain:        http://localhost:8080"
echo "FLUJO editor: http://localhost:4200"
if command -v xdg-open >/dev/null 2>&1; then (xdg-open http://localhost:8080 >/dev/null 2>&1 &)
elif command -v open >/dev/null 2>&1; then (open http://localhost:8080 >/dev/null 2>&1 &)
fi
EOF
else
  cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# brain launcher (standalone mode) - generated by install.sh
BRAIN_HOME="$INSTALL_DIR"
if [ ! -f "\$BRAIN_HOME/package.json" ]; then
  echo "brain was not found at \$BRAIN_HOME. Please re-run the installer." >&2
  exit 1
fi
cd "\$BRAIN_HOME" || exit 1
echo "Starting brain (standalone) - it builds first, then serves http://localhost:8080"
if command -v xdg-open >/dev/null 2>&1; then (xdg-open http://localhost:8080 >/dev/null 2>&1 &)
elif command -v open >/dev/null 2>&1; then (open http://localhost:8080 >/dev/null 2>&1 &)
fi
exec npm run standalone -- "\$@"
EOF
fi
chmod +x "$LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    ok "'brain' command installed ($LAUNCHER)."
    ;;
  *)
    # Persist ~/.local/bin on PATH for future shells, once per rc file.
    RC_FILE="$HOME/.bashrc"
    case "${SHELL:-}" in */zsh) RC_FILE="$HOME/.zshrc" ;; esac
    if ! grep -qs 'Added by brain installer' "$RC_FILE"; then
      printf '\n# Added by brain installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC_FILE"
    fi
    export PATH="$BIN_DIR:$PATH"
    ok "'brain' command installed (added $BIN_DIR to your PATH via $RC_FILE)."
    warn "Open a new terminal (or 'source $RC_FILE') before using 'brain'."
    ;;
esac

# Desktop entry (Linux only; macOS users start brain with the 'brain' command).
if [ "$MAKE_SHORTCUT" = true ]; then
  APPS_DIR="$HOME/.local/share/applications"
  mkdir -p "$APPS_DIR"
  cat > "$APPS_DIR/brain.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=brain
Comment=Start brain
Exec=$LAUNCHER
Path=$INSTALL_DIR
Terminal=true
Categories=Development;
EOF
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  ok "Desktop entry created: $APPS_DIR/brain.desktop"
fi

# ---------------------------------------------------------------------------
# 6. Record what this install did, so a future uninstall can reverse it.
# ---------------------------------------------------------------------------
mkdir -p "$MANIFEST_DIR"
cat > "$MANIFEST_DIR/install-manifest.json" <<EOF
{
  "schema": 1,
  "platform": "$OS",
  "packageManager": "$PM",
  "installDir": "$INSTALL_DIR",
  "binDir": "$BIN_DIR",
  "mode": "$MODE",
  "branch": "$BRANCH",
  "repoUrl": "$REPO_URL",
  "desktopShortcut": $MAKE_SHORTCUT,
  "prerequisites": [
    { "command": "git",    "displayName": "Git",                    "preexisting": $PRE_GIT },
    { "command": "docker", "displayName": "Docker",                 "preexisting": $PRE_DOCKER },
    { "command": "node",   "displayName": "Node.js (includes npm)", "preexisting": $PRE_NODE }
  ]
}
EOF
ok "Install manifest written: $MANIFEST_DIR/install-manifest.json"

# ---------------------------------------------------------------------------
# 7. Done — start now or explain how to.
# ---------------------------------------------------------------------------
if [ "$START_AFTER" = true ]; then
  if [ "$MODE" = docker ] && [ -n "$DOCKER_SUDO" ]; then
    # The launcher runs plain 'docker'; with no group membership yet, start the
    # stack with sudo this one time.
    step "Starting brain (docker compose up -d, via sudo)"
    compose up -d || die "docker compose up failed."
    ok "brain:        http://localhost:8080"
    ok "FLUJO editor: http://localhost:4200"
  else
    step "Starting brain"
    exec "$LAUNCHER"
  fi
else
  printf '\n%sDone! Start brain from any folder by typing:%s\n' "$C_OK" "$C_END" >&2
  printf '%s    brain%s\n' "$C_OK" "$C_END" >&2
  printf '%s(in a new terminal). Then open http://localhost:8080%s\n' "$C_OK" "$C_END" >&2
fi
