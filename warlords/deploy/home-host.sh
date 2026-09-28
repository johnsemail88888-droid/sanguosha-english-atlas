#!/usr/bin/env bash
# 三国杀·枪火乱世 — host the official online server on your own computer at home:
# a Mac mini (macOS, Apple silicon or Intel) or a Linux box (Ubuntu / DGX OS, arm64 or x64).
#
# Once: install Tailscale and log in (https://tailscale.com/download — free). Then paste into
# Terminal as yourself (no sudo; on Linux it asks for your password when it needs it):
#
#   curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/home-host.sh | bash
#
#   … | bash -s -- update    pull the latest game, rebuild, restart (running it again does the same)
#   … | bash -s -- status    is everything up? (prints the two lines again)
#   … | bash -s -- stop      stop hosting (service, daily update and Funnel off)
#   … | SGWL_HEADLESS=0 bash no server-hosted matches (rooms run in the host player's browser, as
#                            before); SGWL_HEADLESS=1 turns them back on (remembered in host.env)
#   (auto-update: what the daily 05:07 job runs — skipped while anyone plays; logs rotate at 5 MB)
#
# What it does (safe to re-run — every step checks what is already there):
#   Node 22 (macOS: Homebrew node@22, else the official nodejs.org build in ~/sanguo-warlords/node;
#   Linux: install.sh's NodeSource / tarball steps) · the game into ~/sanguo-warlords (shallow git
#   clone, else a codeload tarball) · npm ci · vite build with this machine's Funnel address as the
#   build's official server · the server-hosted match worker (npm run build:headless: each room's
#   match runs on this machine, not in a player's browser; optional — a failed build only warns) ·
#   server/server.mjs on 127.0.0.1:8787 as a service that comes back after
#   a reboot (macOS: LaunchAgent com.sanguo-warlords.server, wrapped in `caffeinate -is` so the Mac
#   does not sleep while it hosts; Linux: systemd unit sgwl-home) · Tailscale Funnel: public
#   https://<machine>.<tailnet>.ts.net → 127.0.0.1:8787, WebSockets included, no router port
#   forwarding · an end-to-end check of https://…/sgwl.json and wss://…/ws through public DNS.
#
# No Tailscale account? Cloudflare's quick tunnel works without one, but its random
# https://<words>.trycloudflare.com address changes every time it restarts:
#   cloudflared tunnel --url http://localhost:8787
#
# Shares install.sh's functions (sourced with SGWL_LIB=1: Node, download, build, URL helpers).
# Tests source this file with SGWL_LIB=1 too (functions only, nothing runs):
#   tests/unit/deploy/home-host.test.ts
# Runs under macOS's /bin/bash 3.2: no bash-4 features (associative arrays, ${x,,}, mapfile …).
set -Eeuo pipefail

HH_REPO=johnsemail88888-droid/sanguosha-english-atlas
HH_BRANCH=${SGWL_BRANCH:-main}

# install.sh: next to this file (a checkout, the tests), else downloaded (curl … | bash)
hh_find_lib() {
  local src=${BASH_SOURCE[0]:-} dir tmp url
  if [[ -n $src && -f $src ]]; then
    dir=$(cd "$(dirname "$src")" && pwd)
    if [[ -f $dir/install.sh ]]; then
      echo "$dir/install.sh"
      return 0
    fi
  fi
  tmp=$(mktemp "${TMPDIR:-/tmp}/sgwl-install.XXXXXX")
  for url in "https://raw.githubusercontent.com/${HH_REPO}/${HH_BRANCH}/warlords/deploy/install.sh" \
    "https://cdn.jsdelivr.net/gh/${HH_REPO}@${HH_BRANCH}/warlords/deploy/install.sh"; do
    if curl -fsSL --retry 2 --max-time 60 "$url" -o "$tmp" 2>/dev/null && grep -q SGWL_LIB "$tmp"; then
      echo "$tmp"
      return 0
    fi
  done
  rm -f "$tmp"
  return 1
}

HH_LIB=$(hh_find_lib) || {
  printf '\033[1;31m[x]\033[0m %s\n' "无法下载 install.sh（网络？）/ could not download install.sh (network?)" >&2
  exit 1
}
HH_LIB_MODE=${SGWL_LIB:-0}
SGWL_LIB=1
# shellcheck source=install.sh
source "$HH_LIB"
SGWL_LIB=$HH_LIB_MODE

# install.sh's settings, for a home machine
BRANCH=$HH_BRANCH
INSTALL_DIR=${SGWL_DIR:-$HOME/sanguo-warlords}
SRC_DIR="$INSTALL_DIR/src"
APP_DIR="$SRC_DIR/warlords"
APP_PORT=${SGWL_PORT:-8787}
STATE_FILE="$INSTALL_DIR/host.env"
LOG_FILE="$INSTALL_DIR/home-host.log"
SERVER_LOG="$INSTALL_DIR/server.log"
NODE_DIR="$INSTALL_DIR/node"
LABEL=com.sanguo-warlords.server
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UNIT=sgwl-home
# the daily update (05:07, skipped while anyone plays) runs this copy of the scripts
BIN_DIR="$INSTALL_DIR/bin"
UPDATE_LABEL=com.sanguo-warlords.update
UPDATE_PLIST="$HOME/Library/LaunchAgents/${UPDATE_LABEL}.plist"
UPDATE_LOG="$INSTALL_DIR/update.log"
UPDATE_HOUR=5
UPDATE_MINUTE=7
LOG_MAX_BYTES=5000000
HOST_OS=
SUDO=
TS=
DOMAIN=

# ── pure helpers (unit-tested) ──────────────────────────────────────────────

# host_os [UNAME_S] → macos | linux (status 1 for anything else)
host_os() {
  case ${1:-$(uname -s)} in
    Darwin) echo macos ;;
    Linux) echo linux ;;
    *) return 1 ;;
  esac
}

# node_dist_file SHASUMS_TEXT OS ARCH → the official Node build for this machine
# (macos arm64 → node-v22.x.y-darwin-arm64.tar.gz, linux x64 → node-v22.x.y-linux-x64.tar.xz)
node_dist_file() {
  local os=$2 arch=$3 ext='tar\.xz'
  if [[ $os == macos ]]; then
    os=darwin
    ext='tar\.gz'
  fi
  grep -oE "node-v[0-9.]+-${os}-${arch}\.${ext}" <<<"$1" | head -n1 || true
}

# xml_escape TEXT → TEXT safe inside a plist <string>
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# launchd_plist LABEL NODE_BIN APP_DIR PORT LOG [HEADLESS] → the LaunchAgent: server.mjs on
# 127.0.0.1:PORT, started at login and restarted if it stops; caffeinate -is keeps the Mac awake
# while it runs (the display may still sleep). HEADLESS 0: HEADLESS=0 (no server-hosted matches).
launchd_plist() {
  local label node dir log port=$4 extra=''
  if [[ ${6:-} == 0 ]]; then extra=$'\n\t\t<key>HEADLESS</key>\n\t\t<string>0</string>'; fi
  label=$(xml_escape "$1")
  node=$(xml_escape "$2")
  dir=$(xml_escape "$3")
  log=$(xml_escape "$5")
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 三国杀·枪火乱世 official server — written by warlords/deploy/home-host.sh -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/caffeinate</string>
		<string>-is</string>
		<string>${node}</string>
		<string>${dir}/server/server.mjs</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${dir}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NODE_ENV</key>
		<string>production</string>
		<key>HOST</key>
		<string>127.0.0.1</string>
		<key>PORT</key>
		<string>${port}</string>${extra}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
</dict>
</plist>
EOF
}

# ts_status_fields < `tailscale status --json` → "STATE DNSNAME HTTPS FUNNEL"
# e.g. "Running mac-mini.tail1234.ts.net 1 0" (DNS name without the final dot, '-' when unknown;
# HTTPS / FUNNEL = 1 when the tailnet already grants this machine HTTPS certificates / Funnel)
ts_status_fields() {
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j = {};
  try { j = JSON.parse(s) || {}; } catch {}
  const self = j.Self || {};
  const caps = new Set([...Object.keys(self.CapMap || {}), ...(Array.isArray(self.Capabilities) ? self.Capabilities : [])]);
  const dns = String(self.DNSName || "").replace(/\.$/, "");
  const https = caps.has("https") || (Array.isArray(j.CertDomains) && j.CertDomains.length > 0);
  console.log([j.BackendState || "Unknown", dns || "-", https ? 1 : 0, caps.has("funnel") ? 1 : 0].join(" "));
});'
}

# funnel_target SERVE_JSON HOST → what Funnel publishes at https://HOST/ (the proxy target of "/"
# on port 443), '' when Funnel is not on for it. SERVE_JSON = `tailscale funnel status --json`.
funnel_target() {
  # shellcheck disable=SC2016 # a JS template literal, not a shell expansion
  node -e '
let j = {};
try { j = JSON.parse(process.argv[1]) || {}; } catch {}
const hp = `${process.argv[2]}:443`;
const on = !!(j.AllowFunnel && j.AllowFunnel[hp]);
const h = j.Web && j.Web[hp] && j.Web[hp].Handlers && j.Web[hp].Handlers["/"];
console.log(on && h && h.Proxy ? h.Proxy : "");' "$1" "$2"
}

# funnel_points_here TARGET PORT → status 0 if TARGET is this machine's game server
funnel_points_here() {
  [[ $1 =~ ^(https?://)?(127\.0\.0\.1|localhost):$2/?$ ]]
}

# stat_field SGWL_JSON KEY → the number KEY has in /sgwl.json ({"rooms":2,"players":5,…}); 0 when absent
stat_field() {
  local n
  n=$(sed -nE "s/.*\"$2\":[[:space:]]*([0-9]+).*/\1/p" <<<"$1" | head -n1)
  echo "${n:-0}"
}

# stat_flag SGWL_JSON KEY → true | false (the boolean KEY in /sgwl.json; false when absent)
stat_flag() {
  if grep -qE "\"$2\":[[:space:]]*true" <<<"$1"; then echo true; else echo false; fi
}

# human_players SGWL_JSON → people connected: the relay's sockets minus the server-hosted rooms'
# own host sockets (one per room — the server itself, not a player)
human_players() {
  local n
  n=$(($(stat_field "$1" players) - $(stat_field "$1" headlessRooms)))
  echo $((n > 0 ? n : 0))
}

# game_busy SGWL_JSON → status 0 while anyone plays (no update then): a room hosted in a player's
# browser is open, a player is connected, or a server-hosted room has players (headlessHumans).
# A server-hosted room nobody is in does not count (it ends by itself); in rooms / players it shows
# once each (headlessRooms: the server is its relay host).
game_busy() {
  local rooms players hrooms humans
  rooms=$(stat_field "$1" rooms)
  players=$(stat_field "$1" players)
  hrooms=$(stat_field "$1" headlessRooms)
  humans=$(stat_field "$1" headlessHumans)
  ((humans > 0 || rooms > hrooms || players > hrooms))
}

# rotate_log FILE MAX_BYTES → FILE bigger than MAX_BYTES becomes FILE.1 (the one before is dropped)
# and FILE starts empty; copy + truncate, so a process that has FILE open keeps writing to it
rotate_log() {
  local f=$1 max=$2 size
  [[ -f $f ]] || return 0
  size=$(wc -c <"$f" | tr -d ' ')
  ((size > max)) || return 0
  cp "$f" "$f.1"
  : >"$f"
}

# pmset_ok `pmset -g` → status 0 if the Mac never sleeps by itself and starts after a power failure
pmset_ok() {
  local sleep restart
  sleep=$(awk '$1 == "sleep" {print $2; exit}' <<<"$1")
  restart=$(awk '$1 == "autorestart" {print $2; exit}' <<<"$1")
  [[ $sleep == 0 && $restart == 1 ]]
}

PMSET_CMD='sudo pmset -a sleep 0 autorestart 1 womp 1'

# update_plist LABEL SCRIPT HOUR MINUTE PATH LOG → the LaunchAgent that runs `SCRIPT auto-update`
# every day at HOUR:MINUTE (launchd runs a missed one when the Mac wakes)
update_plist() {
  local label script path log
  label=$(xml_escape "$1")
  script=$(xml_escape "$2")
  path=$(xml_escape "$5")
  log=$(xml_escape "$6")
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 三国杀·枪火乱世 daily update — written by warlords/deploy/home-host.sh -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${script}</string>
		<string>auto-update</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${path}</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>$3</integer>
		<key>Minute</key>
		<integer>$4</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
</dict>
</plist>
EOF
}

# update_units SCRIPT USER HOUR MINUTE PATH → sgwl-home-update.service, a line "---", sgwl-home-update.timer
update_units() {
  cat <<EOF
# 三国杀·枪火乱世 daily update — written by warlords/deploy/home-host.sh
[Unit]
Description=Sanguo Warlords daily update (skipped while a room is open)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$2
Environment=PATH=$5
ExecStart=/bin/bash $1 auto-update
---
# 三国杀·枪火乱世 daily update — written by warlords/deploy/home-host.sh
[Unit]
Description=Sanguo Warlords daily update at $(printf '%02d:%02d' "$3" "$4")

[Timer]
OnCalendar=*-*-* $(printf '%02d:%02d' "$3" "$4"):00
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

# tailscale_help OS → how to install Tailscale and log in (printed when it is missing)
tailscale_help() {
  if [[ $1 == macos ]]; then
    cat <<'EOF'
需要先安装 Tailscale 并登录（免费，只需一次）/ Install Tailscale and log in once (free):
  1. 下载安装 / install:  https://tailscale.com/download/mac
     （或 / or:  brew install --cask tailscale-app）
  2. 打开「应用程序 → Tailscale」，点菜单栏的 Tailscale 图标 → Log in，用 Google / Apple / GitHub 账号登录
     Open Applications → Tailscale, click its menu-bar icon → Log in (Google / Apple / GitHub account)
  3. 再粘贴运行同一条命令 / then paste the same command again
EOF
  else
    cat <<'EOF'
需要先安装 Tailscale 并登录（免费，只需一次）/ Install Tailscale and log in once (free):
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up          ← 用浏览器打开它打印的链接登录 / open the link it prints to log in
然后再粘贴运行同一条命令 / then paste the same command again
EOF
  fi
}

# ── system ──────────────────────────────────────────────────────────────────

# stop_here MESSAGE — a clean stop that needs the user (not a crash: no "failed at line" note)
stop_here() {
  printf '\n\033[1;33m%s\033[0m\n\n' "$*"
  exit 2
}

# Node the service and the build use: our own copy, Homebrew's keg-only node@22, then PATH
node_path_setup() {
  local d saved
  # the Node an earlier run found (the daily update starts with launchd's / systemd's bare PATH)
  saved=$(sed -n 's/^NODE_BIN_DIR=//p' "$STATE_FILE" 2>/dev/null | head -n1 || true)
  for d in "$saved" /usr/local/opt/node@22/bin /opt/homebrew/opt/node@22/bin "$NODE_DIR/bin"; do
    if [[ -n $d && -x $d/node ]]; then PATH="$d:$PATH"; fi
  done
  export PATH
  hash -r
}

# the official build from nodejs.org (npmmirror as the fallback) into ~/sanguo-warlords/node — no sudo
install_node_private() {
  local arch base file tmp want
  arch=$(node_arch) || die "不支持的 CPU / unsupported CPU: $(uname -m)"
  tmp=$(mktemp -d)
  for base in "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" "$NPM_MIRROR/-/binary/node/latest-v${NODE_MAJOR}.x"; do
    log "下载 Node.js / downloading Node.js (${base%%/latest*})"
    curl -fsSL --max-time 30 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || continue
    file=$(node_dist_file "$(cat "$tmp/SHASUMS256.txt")" "$HOST_OS" "$arch")
    [[ -n $file ]] || continue
    curl -fL --retry 2 --max-time 600 "$base/$file" -o "$tmp/$file" || continue
    want=$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)
    if [[ $(sha256_of "$tmp/$file") != "$want" ]]; then
      warn "校验失败 / checksum mismatch: $file"
      continue
    fi
    rm -rf "$NODE_DIR.new"
    mkdir -p "$NODE_DIR.new"
    tar -xzf "$tmp/$file" -C "$NODE_DIR.new" --strip-components=1 2>/dev/null || tar -xJf "$tmp/$file" -C "$NODE_DIR.new" --strip-components=1
    rm -rf "$NODE_DIR"
    mv "$NODE_DIR.new" "$NODE_DIR"
    rm -rf "$tmp"
    node_path_setup
    (($(node_major) >= NODE_MAJOR)) && return 0
  done
  rm -rf "$tmp"
  return 1
}

find_brew() {
  local b
  for b in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -n $b && -x $b ]]; then
      echo "$b"
      return 0
    fi
  done
  return 1
}

ensure_node() {
  node_path_setup
  if (($(node_major) >= NODE_MAJOR)); then
    log "Node.js $(node -v) 已安装 / already installed"
    return
  fi
  log "安装 Node.js ${NODE_MAJOR} / installing Node.js ${NODE_MAJOR}"
  if [[ $HOST_OS == macos ]]; then
    local brew
    if brew=$(find_brew) && HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 "$brew" install node@22; then
      node_path_setup
    fi
    if (($(node_major) < NODE_MAJOR)); then
      install_node_private || die "Node.js 安装失败 / could not install Node.js"
    fi
  else
    # install.sh's own steps (NodeSource, else the binary tarball), as root
    # shellcheck disable=SC2016 # $1 expands in the inner bash
    $SUDO env SGWL_LIB=1 bash -c 'set -Eeuo pipefail; source "$1"; detect_pkg; install_base; install_node' sgwl "$HH_LIB" ||
      die "Node.js 安装失败 / could not install Node.js"
    node_path_setup
  fi
  (($(node_major) >= NODE_MAJOR)) || die "Node.js 安装失败 / could not install Node.js"
  log "Node.js $(node -v)"
}

# ── Tailscale ───────────────────────────────────────────────────────────────
find_tailscale() {
  local c
  for c in "${TAILSCALE:-}" "$(command -v tailscale 2>/dev/null || true)" /Applications/Tailscale.app/Contents/MacOS/Tailscale \
    /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /usr/bin/tailscale; do
    if [[ -n $c && -x $c ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# changing Tailscale's settings needs root on Linux (tailscaled), not on macOS (the app)
ts_admin() {
  if [[ $HOST_OS == linux ]]; then $SUDO "$TS" "$@"; else "$TS" "$@"; fi
}

ts_fields() {
  "$TS" status --json 2>/dev/null | ts_status_fields || true
}

ensure_tailscale() {
  TS=$(find_tailscale) || stop_here "$(tailscale_help "$HOST_OS")"
  local state dns _https _funnel
  read -r state dns _https _funnel <<<"$(ts_fields)"
  if [[ $state != Running && $HOST_OS == linux ]]; then
    log "Tailscale 登录 / logging in to Tailscale — 打开下面的链接 / open the link below"
    if [[ $state == NeedsLogin ]]; then run_timeout 900 $SUDO "$TS" login || true; else run_timeout 300 $SUDO "$TS" up || true; fi
    read -r state dns _https _funnel <<<"$(ts_fields)"
  fi
  if [[ $state != Running ]]; then
    if [[ $HOST_OS == macos ]]; then
      stop_here "Tailscale 没有连接（状态 $state）。打开 Tailscale（菜单栏图标）→ Log in / Connect，然后再运行同一条命令。
Tailscale is not connected (state $state): click the Tailscale menu-bar icon → Log in / Connect, then run the same command again."
    fi
    stop_here "Tailscale 没有连接（状态 $state）/ not connected — run: sudo tailscale up   then run the same command again"
  fi
  [[ $dns != - ]] || die "Tailscale 没有给出本机域名 / Tailscale reports no DNS name for this machine"
  DOMAIN=$dns
  log "Tailscale: $DOMAIN"
}

enable_funnel() {
  local target
  target=$(funnel_target "$("$TS" funnel status --json 2>/dev/null || echo '{}')" "$DOMAIN")
  if funnel_points_here "$target" "$APP_PORT"; then
    log "Tailscale Funnel 已开启 / already on: https://$DOMAIN/ → 127.0.0.1:$APP_PORT"
    return 0
  fi
  [[ -z $target ]] || warn "Funnel 原来指向 $target，改为游戏服务 / Funnel pointed at $target — switching it to the game server"
  log "开启 Tailscale Funnel（公网 HTTPS）/ turning on Tailscale Funnel (public HTTPS)"
  printf '\033[1;36m%s\033[0m\n' "  如果下面出现 login.tailscale.com 的链接：用浏览器打开 → 点 Enable，本脚本会自动继续。
  If a login.tailscale.com link appears below: open it in a browser → Enable; this script then carries on."
  # (the binary, not ts_admin: timeout / perl exec a program, not a shell function)
  if [[ $HOST_OS == linux ]]; then
    run_timeout 900 $SUDO "$TS" funnel --bg "$APP_PORT" || true
  else
    run_timeout 900 "$TS" funnel --bg "$APP_PORT" || true
  fi
  target=$(funnel_target "$("$TS" funnel status --json 2>/dev/null || echo '{}')" "$DOMAIN")
  if ! funnel_points_here "$target" "$APP_PORT"; then
    stop_here "Funnel 还没有开启。打开上面打印的链接启用它（或在 https://login.tailscale.com/admin/dns 打开 HTTPS Certificates，
并在 https://login.tailscale.com/admin/acls 的 nodeAttrs 里允许 funnel），然后再运行同一条命令。
Funnel is not on yet: open the link printed above to enable it (or turn on HTTPS Certificates at
https://login.tailscale.com/admin/dns and allow \"funnel\" in the nodeAttrs of https://login.tailscale.com/admin/acls),
then run the same command again."
  fi
  log "Funnel: https://$DOMAIN/ → 127.0.0.1:$APP_PORT"
}

# ── the service ─────────────────────────────────────────────────────────────
local_ok() {
  local body
  body=$(curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/sgwl.json" 2>/dev/null) || return 1
  [[ $body == *sanguo-warlords* ]]
}

launchd_loaded() {
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1
}

service_stop() {
  if [[ $HOST_OS == macos ]]; then
    launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
    local _i
    for _i in 1 2 3 4 5 6 7 8 9 10; do
      launchd_loaded || break
      sleep 0.5
    done
  else
    $SUDO systemctl stop "$UNIT" >/dev/null 2>&1 || true
  fi
}

service_running() {
  if [[ $HOST_OS == macos ]]; then
    # grep without -q reads everything: no SIGPIPE for launchctl under pipefail
    launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep 'state = running' >/dev/null
  else
    systemctl is-active -q "$UNIT"
  fi
}

install_service() {
  local node tmp
  node=$(command -v node)
  service_stop
  if local_ok; then
    die "端口 ${APP_PORT} 已被另一个游戏服务占用（桌面版游戏开着？先退出它）/ port ${APP_PORT} is already used by another game server (is the desktop app open? quit it) — or rerun with SGWL_PORT=8788"
  fi
  if [[ $HOST_OS == macos ]]; then
    mkdir -p "$(dirname "$PLIST")"
    launchd_plist "$LABEL" "$node" "$APP_DIR" "$APP_PORT" "$SERVER_LOG" "$HEADLESS_SETTING" >"$PLIST.tmp"
    mv "$PLIST.tmp" "$PLIST"
    launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
      sleep 1
      launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
    fi
  else
    tmp=$(mktemp)
    systemd_unit "$node" "$APP_DIR" "$APP_PORT" "$(id -un)" home-host.sh "$HEADLESS_SETTING" >"$tmp"
    $SUDO install -m 0644 "$tmp" "/etc/systemd/system/${UNIT}.service"
    rm -f "$tmp"
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable -q "$UNIT"
    $SUDO systemctl restart "$UNIT"
  fi
  log "等待游戏服务启动 / waiting for the game server"
  local _i
  for _i in $(seq 1 30); do
    if local_ok; then
      log "游戏服务已运行 / game server is up (127.0.0.1:${APP_PORT})"
      return 0
    fi
    sleep 1
  done
  if [[ $HOST_OS == macos ]]; then tail -n 30 "$SERVER_LOG" 2>/dev/null || true; else journalctl -u "$UNIT" -n 30 --no-pager 2>/dev/null || true; fi
  die "游戏服务没有启动 / the game server did not start (see the log above)"
}

# ── checks ──────────────────────────────────────────────────────────────────
check_build_points_here() {
  if grep -qF "wss://$DOMAIN/ws" "$APP_DIR"/dist/assets/*.js 2>/dev/null; then
    log "游戏页面的官方服务器 = 本机 / the page's official server is this machine (wss://$DOMAIN/ws)"
  else
    warn "构建里没有找到 wss://$DOMAIN/ws / the build does not mention wss://$DOMAIN/ws"
  fi
}

# check_public → status 0 once friends can reach the game (public DNS → Funnel → this machine)
check_public() {
  local url _i
  url=$(game_url "$DOMAIN")
  [[ -f $APP_DIR/deploy/check.mjs ]] || return 1
  log "检查（本机经 Tailscale）/ checking through Tailscale"
  node "$APP_DIR/deploy/check.mjs" "$url" || warn "经 Tailscale 访问失败 / not reachable through Tailscale"
  log "检查公网访问（朋友走的路：公网 DNS → Funnel）/ checking from the internet side (public DNS → Funnel)"
  # (the server-hosted match check ran above: no test room per retry)
  for _i in $(seq 1 12); do
    if node "$APP_DIR/deploy/check.mjs" "$url" --public-dns --no-headless; then return 0; fi
    sleep 10
  done
  return 1
}

# ── configuration ───────────────────────────────────────────────────────────
save_state() {
  cat >"$STATE_FILE" <<EOF
# written by warlords/deploy/home-host.sh
DOMAIN=$DOMAIN
SGWL_PORT=$APP_PORT
SGWL_BRANCH=$BRANCH
SGWL_HEADLESS=$HEADLESS_SETTING
NODE_BIN_DIR=$(dirname "$(command -v node)")
EOF
}

# SGWL_HEADLESS from the environment, else what an earlier run saved
load_headless_setting() {
  if [[ -z $HEADLESS_SETTING ]]; then
    HEADLESS_SETTING=$(sed -n 's/^SGWL_HEADLESS=//p' "$STATE_FILE" 2>/dev/null | head -n1 || true)
  fi
}

# server_stats → /sgwl.json of the running game server ('' when it does not answer)
server_stats() {
  curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/sgwl.json" 2>/dev/null || true
}

load_state() {
  [[ -f $STATE_FILE ]] || return 1
  DOMAIN=$(sed -n 's/^DOMAIN=//p' "$STATE_FILE" | head -n1)
  [[ -n $DOMAIN ]]
}

# refresh_bin: the copy of these scripts the daily update runs (renamed into place: a running copy is not disturbed)
refresh_bin() {
  [[ -f $APP_DIR/deploy/home-host.sh ]] || return 0
  mkdir -p "$BIN_DIR"
  cp "$APP_DIR/deploy/home-host.sh" "$BIN_DIR/home-host.sh.new" && mv "$BIN_DIR/home-host.sh.new" "$BIN_DIR/home-host.sh"
  cp "$APP_DIR/deploy/install.sh" "$BIN_DIR/install.sh.new" && mv "$BIN_DIR/install.sh.new" "$BIN_DIR/install.sh"
}

# the daily update: a copy of these scripts (an update replaces the source tree under it) and a
# LaunchAgent / systemd timer that runs `home-host.sh auto-update` at 05:07
install_updater() {
  local path
  if [[ ! -f $APP_DIR/deploy/home-host.sh ]]; then
    warn "这个版本还没有 home-host.sh，跳过每日自动更新 / no home-host.sh in this version: no daily update"
    return 0
  fi
  refresh_bin
  path="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [[ $HOST_OS == macos ]]; then
    update_plist "$UPDATE_LABEL" "$BIN_DIR/home-host.sh" "$UPDATE_HOUR" "$UPDATE_MINUTE" "$path" "$UPDATE_LOG" >"$UPDATE_PLIST.tmp"
    mv "$UPDATE_PLIST.tmp" "$UPDATE_PLIST"
    launchctl bootout "gui/$UID/$UPDATE_LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$UID" "$UPDATE_PLIST" 2>/dev/null || launchctl load -w "$UPDATE_PLIST" 2>/dev/null || warn "每日更新没有启用 / could not schedule the daily update"
  else
    local tmp
    tmp=$(mktemp)
    update_units "$BIN_DIR/home-host.sh" "$(id -un)" "$UPDATE_HOUR" "$UPDATE_MINUTE" "$path" >"$tmp"
    sed '/^---$/,$d' "$tmp" | $SUDO tee "/etc/systemd/system/${UNIT}-update.service" >/dev/null
    sed '1,/^---$/d' "$tmp" | $SUDO tee "/etc/systemd/system/${UNIT}-update.timer" >/dev/null
    rm -f "$tmp"
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable -q --now "${UNIT}-update.timer"
  fi
  log "每日 $(printf '%02d:%02d' "$UPDATE_HOUR" "$UPDATE_MINUTE") 自动更新（有人在玩时跳过）/ daily update at $(printf '%02d:%02d' "$UPDATE_HOUR" "$UPDATE_MINUTE") (skipped while anyone plays)"
}

# restart the game server without sudo (the daily update): launchd / systemd (Restart=always) start it again
service_kick() {
  if [[ $HOST_OS == macos ]]; then
    launchctl kickstart -k "gui/$UID/$LABEL"
  else
    local pid
    pid=$(systemctl show -p MainPID --value "$UNIT")
    if [[ -n $pid && $pid != 0 ]]; then kill "$pid"; fi
  fi
  local _i
  sleep 2
  for _i in $(seq 1 30); do
    if local_ok; then return 0; fi
    sleep 1
  done
  return 1
}

rotate_logs() {
  rotate_log "$SERVER_LOG" "$LOG_MAX_BYTES"
  rotate_log "$UPDATE_LOG" "$LOG_MAX_BYTES"
  rotate_log "$LOG_FILE" "$LOG_MAX_BYTES"
}

print_awake_tips() {
  if [[ $HOST_OS == macos ]]; then
    if ! pmset_ok "$(pmset -g 2>/dev/null || true)"; then
      printf '\033[1;33m  %s\033[0m\n    %s\n\n' '让 Mac 永不睡眠、停电恢复后自动开机，请运行这一条（要输入开机密码）/ never sleep + start after a power failure — run once (asks for your password):' "$PMSET_CMD"
    fi
    cat <<'EOF'
  让这台 Mac 一直在线 / keep this Mac online:
    · 游戏服务运行时，caffeinate 也会阻止 Mac 睡眠（显示器可以关）/ the service keeps the Mac awake (the display may sleep)
    · 重启后登录一次（或在「用户与群组」开启自动登录），游戏服务和 Tailscale 会自动启动
      after a restart, log in once (or turn on automatic login): the game server and Tailscale start by themselves
EOF
  else
    cat <<'EOF'
  让这台机器一直在线 / keep this machine online: 服务开机自动启动 / the service starts at boot.
    桌面版 Ubuntu 若会自动休眠 / if the desktop suspends by itself:
    sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
EOF
  fi
}

# ── commands ────────────────────────────────────────────────────────────────
cmd_install() {
  local stats
  rotate_logs
  load_headless_setting
  ensure_node
  ensure_tailscale
  stats=$(server_stats)
  if [[ -n $stats ]] && game_busy "$stats"; then
    warn "有人在玩（玩家 $(human_players "$stats")）：重启服务会让他们掉线 / $(human_players "$stats") player(s) connected: restarting the server drops them"
  fi
  fetch_source
  build_game
  check_build_points_here
  install_service
  enable_funnel
  save_state
  install_updater
  if check_public; then
    log "朋友可以访问了 / reachable from the internet"
  else
    warn "公网暂时还访问不到 https://$DOMAIN/ 。Funnel 刚开启时公网 DNS 可能要等几分钟：过 5 分钟运行
      curl -fsSL https://raw.githubusercontent.com/${HH_REPO}/main/warlords/deploy/home-host.sh | bash -s -- status
  https://$DOMAIN/ is not reachable from the internet yet — a new Funnel name can take a few minutes to
  appear in public DNS. Run the status command above in 5 minutes."
  fi
  print_summary
  print_awake_tips
}

cmd_status() {
  local ok=1 stats state dns _https _funnel target
  node_path_setup
  if service_running; then log "游戏服务 / game server: 运行中 / running"; else
    warn "游戏服务未运行 / game server is not running"
    ok=0
  fi
  stats=$(server_stats)
  if [[ -n $stats ]]; then
    log "房间 rooms: $(stat_field "$stats" rooms) · 玩家 players: $(human_players "$stats")"
    if [[ $(stat_flag "$stats" headless) == true ]]; then
      log "服务器托管对局 headless: 开 on · 房间 rooms: $(stat_field "$stats" headlessRooms) · 玩家 players: $(stat_field "$stats" headlessHumans)"
    else
      log "服务器托管对局 headless: 关 off（房间由房主的浏览器运行 / rooms run in the host player's browser）"
    fi
  else
    warn "本机 127.0.0.1:${APP_PORT} 无响应 / no answer"
    ok=0
  fi
  TS=$(find_tailscale) || stop_here "$(tailscale_help "$HOST_OS")"
  read -r state dns _https _funnel <<<"$(ts_fields)"
  log "Tailscale: $state $dns"
  DOMAIN=$dns
  [[ $DOMAIN != - ]] || DOMAIN=$(sed -n 's/^DOMAIN=//p' "$STATE_FILE" 2>/dev/null | head -n1)
  [[ -n $DOMAIN ]] || die "未找到本机的 Tailscale 域名 / no Tailscale name for this machine"
  target=$(funnel_target "$("$TS" funnel status --json 2>/dev/null || echo '{}')" "$DOMAIN")
  if funnel_points_here "$target" "$APP_PORT"; then log "Funnel: https://$DOMAIN/ → $target"; else
    warn "Funnel 没有指向游戏服务 / Funnel is not pointing at the game server (${target:-off}) — 重新运行安装命令 / run the install command again"
    ok=0
  fi
  if [[ -f $APP_DIR/deploy/check.mjs ]] && check_public; then log "公网 / internet: 正常 / OK"; else ok=0; fi
  print_summary
  ((ok == 1))
}

# the daily job: skip while anyone plays; otherwise pull, rebuild, restart
cmd_auto_update() {
  local stats
  rotate_logs
  node_path_setup
  load_state || die "尚未安装 / not installed yet"
  stats=$(server_stats)
  if [[ -n $stats ]] && game_busy "$stats"; then
    log "有人在玩（房间 $(stat_field "$stats" rooms)，玩家 $(human_players "$stats")，服务器托管 $(stat_field "$stats" headlessHumans)），今天不更新 / a game is on — no update today"
    return 0
  fi
  fetch_source
  build_game
  service_kick || die "更新后游戏服务没有启动 / the game server did not come back after the update"
  refresh_bin
  log "已更新 / updated"
}

cmd_stop() {
  service_stop
  if [[ $HOST_OS == macos ]]; then
    launchctl bootout "gui/$UID/$UPDATE_LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST" "$UPDATE_PLIST"
  else
    $SUDO systemctl disable -q "$UNIT" >/dev/null 2>&1 || true
    $SUDO systemctl disable -q --now "${UNIT}-update.timer" >/dev/null 2>&1 || true
  fi
  log "游戏服务已停止 / game server stopped"
  if TS=$(find_tailscale); then
    ts_admin funnel --https=443 off >/dev/null 2>&1 || true
    log "Tailscale Funnel 已关闭 / Funnel off"
  fi
  log "重新开始：再运行安装命令 / to host again, run the install command again"
}

main() {
  local cmd=${1:-install}
  # the script itself may be arriving on stdin (curl | bash): nothing below may read it
  exec </dev/null
  HOST_OS=$(host_os "$(uname -s)") || die "只支持 macOS 和 Linux / macOS or Linux only (this is $(uname -s))"
  if [[ $HOST_OS == macos ]]; then
    [[ $EUID -ne 0 ]] || die "请不要加 sudo，用你自己的账号运行 / run it as yourself, without sudo"
  else
    command -v systemctl >/dev/null 2>&1 || die "需要 systemd / systemd is required"
    if [[ $EUID -ne 0 ]]; then SUDO=sudo; fi
  fi
  mkdir -p "$INSTALL_DIR"
  exec > >(tee -a "$LOG_FILE") 2>&1
  trap 'on_error $LINENO' ERR
  log "$(date '+%F %T') sgwl home-host.sh ${cmd} ($HOST_OS $(uname -m))"
  case $cmd in
    install | update) cmd_install ;;
    status) cmd_status || exit 1 ;;
    stop) cmd_stop ;;
    auto-update) cmd_auto_update ;;
    *) die "用法 / usage: home-host.sh [install|update|status|stop|auto-update]" ;;
  esac
}

if [[ ${SGWL_LIB:-0} != 1 ]]; then
  main "$@"
fi
