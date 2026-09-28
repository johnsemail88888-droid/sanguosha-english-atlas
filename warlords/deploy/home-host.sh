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
#   … | bash -s -- status    is everything up? (prints the share link and the two lines again)
#   … | bash -s -- rotate-key  a new access key: the old share link stops working (restarts the server)
#   … | bash -s -- stop      stop hosting (service, auto-update and Funnel off)
#   … | SGWL_HEADLESS=0 bash no server-hosted matches (rooms run in the host player's browser, as
#                            before); SGWL_HEADLESS=1 turns them back on (remembered in host.env)
#   … | SGWL_RELAY_KEY=off bash  no access key: anyone who has the address can play (remembered)
#   (auto-update: what the job every 5 minutes runs — it updates only to a commit GitHub's CI passed,
#    only while nobody plays; logs rotate at 5 MB)
#
# Access key: the machine's name is public (Certificate Transparency logs), so the server wants a
# key (RELAY_KEY, made on the first install, kept in ~/sanguo-warlords/host.env): friends join
# through the SHARE LINK https://<machine>.<tailnet>.ts.net/?k=<key> the summary prints.
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
#   forwarding · an end-to-end check of https://…/sgwl.json and wss://…/ws through public DNS ·
#   an auto-update job every 5 minutes (LaunchAgent com.sanguo-warlords.update / systemd timer).
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
# the auto-update (every UPDATE_INTERVAL seconds; see cmd_auto_update) runs this copy of the scripts
BIN_DIR="$INSTALL_DIR/bin"
UPDATE_LABEL=com.sanguo-warlords.update
UPDATE_PLIST="$HOME/Library/LaunchAgents/${UPDATE_LABEL}.plist"
UPDATE_LOG="$INSTALL_DIR/update.log"
UPDATE_INTERVAL=300
# its memory: one line per skip reason (logged at most once an hour), the last failed build, …
AU_STATE="$INSTALL_DIR/auto-update.state"
# a build under way (its commit): still there on the next run = that build failed
AU_BUILDING="$INSTALL_DIR/.building"
SKIP_LOG_EVERY=3600
FAILED_RETRY_AFTER=3600
# one install / update at a time (the auto-update skips while it is held; install waits for it)
LOCK_DIR="$INSTALL_DIR/.update.lock"
LOCK_HELD=0
# the game server's environment on a home machine: no PeerJS signalling, ≤ 4 relay rooms, a dropped
# host keeps its room 2 minutes (as long as its page tries to get it back); + RELAY_KEY
HOME_ENV=(NO_PEER=1 MAX_ROOMS=4 HOST_GRACE_MS=120000)
# Linux: the access key for the systemd service (an EnvironmentFile, mode 600)
SERVER_ENV="$INSTALL_DIR/server.env"
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

# launchd_plist LABEL NODE_BIN APP_DIR PORT LOG [HEADLESS] [RELAY_KEY] → the LaunchAgent: server.mjs
# on 127.0.0.1:PORT, started at login and restarted if it stops; caffeinate -is keeps the Mac awake
# while it runs (the display may still sleep). Environment: HOME_ENV (no PeerJS, ≤ 4 rooms, a 2-minute
# host grace); HEADLESS 0: HEADLESS=0 (no server-hosted matches); RELAY_KEY: the access key (the file
# is written 600 — install_service).
launchd_plist() {
  local label node dir log port=$4 extra='' kv
  for kv in "${HOME_ENV[@]}"; do extra+=$'\n\t\t'"<key>${kv%%=*}</key>"$'\n\t\t'"<string>${kv#*=}</string>"; done
  if [[ ${6:-} == 0 ]]; then extra+=$'\n\t\t<key>HEADLESS</key>\n\t\t<string>0</string>'; fi
  if [[ -n ${7:-} && ${7:-} != off ]]; then extra+=$'\n\t\t<key>RELAY_KEY</key>\n\t\t'"<string>$(xml_escape "$7")</string>"; fi
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
# browser is open, a player is connected, a server-hosted room has players (headlessHumans), or a
# server-hosted match is under way (headlessPlaying — its only player may be reconnecting right now,
# and a restart would end that match). A server-hosted lobby nobody is in does not count (it ends by
# itself); in rooms / players it shows once each (headlessRooms: the server is its relay host).
game_busy() {
  local rooms players hrooms humans playing
  rooms=$(stat_field "$1" rooms)
  players=$(stat_field "$1" players)
  hrooms=$(stat_field "$1" headlessRooms)
  humans=$(stat_field "$1" headlessHumans)
  playing=$(stat_field "$1" headlessPlaying)
  ((humans > 0 || playing > 0 || rooms > hrooms || players > hrooms))
}

# stat_sha SGWL_JSON → the commit the running server was built from (/sgwl.json build.sha; '' unknown)
stat_sha() {
  sed -nE 's/.*"sha":"([0-9a-f]{40})".*/\1/p' <<<"$1" | head -n1 || true
}

# ts_key_expiry < `tailscale status --json` → when this machine's Tailscale key expires
# (Self.KeyExpiry, e.g. 2027-03-01T10:00:00Z); '' when key expiry is disabled
ts_key_expiry() {
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j = {};
  try { j = JSON.parse(s) || {}; } catch {}
  const e = String((j.Self || {}).KeyExpiry || "");
  console.log(/^\d{4}-\d\d-\d\dT/.test(e) && !e.startsWith("0001-") ? e : "");
});'
}

# update_decision HEAD BUILT RUNNING → what the auto-update does about GitHub's head commit HEAD,
# the commit the build on disk is (BUILT, '' unknown) and the one the server runs (RUNNING):
#   current  the build is the head and the server runs it
#   restart  the build is the head, the server still runs an older one (a restart that had to wait)
#   check    the head is another commit: ask GitHub whether its CI passed
update_decision() {
  if [[ -n $2 && $1 == "$2" ]]; then
    if [[ $3 != "$2" ]]; then echo restart; else echo current; fi
  else
    echo check
  fi
}

# ci_verdict RUNS_JSON [SHA] → success | pending | failure | none | unknown: what GitHub says of the
# warlords-ci runs of a commit (actions/workflows/warlords-ci.yml/runs?head_sha=…): one run that
# passed is enough; none finished yet = pending; all finished, none passed = failure; no run at all
# = none (the commit touched nothing the CI watches, or it was pushed seconds ago); bad JSON = unknown
ci_verdict() {
  node -e '
let j = null;
try { j = JSON.parse(process.argv[1]); } catch {}
const sha = process.argv[2] || "";
if (!j || !Array.isArray(j.workflow_runs)) { console.log("unknown"); process.exit(0); }
const runs = j.workflow_runs.filter((r) => r && (!sha || r.head_sha === sha));
if (runs.some((r) => r.status === "completed" && r.conclusion === "success")) console.log("success");
else if (runs.some((r) => r.status !== "completed")) console.log("pending");
else console.log(runs.length ? "failure" : "none");' "$1" "${2:-}"
}

# latest_green_sha RUNS_JSON → the commit of the newest warlords-ci run that passed ('' none)
latest_green_sha() {
  node -e '
let j = null;
try { j = JSON.parse(process.argv[1]); } catch {}
const runs = j && Array.isArray(j.workflow_runs) ? j.workflow_runs : [];
const r = runs.find((x) => x && x.status === "completed" && x.conclusion === "success" && /^[0-9a-f]{40}$/.test(String(x.head_sha)));
console.log(r ? r.head_sha : "");' "$1"
}

# now_s → the time in seconds (SGWL_NOW: tests)
now_s() {
  echo "${SGWL_NOW:-$(date +%s)}"
}

# au_get KEY / au_set KEY VALUE → the auto-update's memory (AU_STATE: one "KEY VALUE" line per key)
au_get() {
  sed -n "s/^$1 //p" "$AU_STATE" 2>/dev/null | head -n1 || true
}
au_set() {
  local tmp
  mkdir -p "$(dirname "$AU_STATE")"
  tmp="$AU_STATE.tmp.$$"
  { grep -v "^$1 " "$AU_STATE" 2>/dev/null || true; } >"$tmp"
  echo "$1 $2" >>"$tmp"
  mv "$tmp" "$AU_STATE"
}

# skip_log REASON MESSAGE → MESSAGE in the log, at most once an hour per REASON (the job runs every
# 5 minutes: the log gets one line when something starts holding updates back, not 12 an hour)
AU_HEADER_DONE=0
skip_log() {
  local now last
  now=$(now_s)
  last=$(au_get "skip:$1")
  if [[ $last =~ ^[0-9]+$ ]] && ((now - last < SKIP_LOG_EVERY)); then return 0; fi
  au_set "skip:$1" "$now"
  au_header
  log "$2"
}

# au_header: the auto-update's heading line — once, and only when it has something to say
au_header() {
  if [[ $AU_HEADER_DONE == 0 ]]; then
    AU_HEADER_DONE=1
    log "$(date '+%F %T') sgwl home-host.sh auto-update"
  fi
}

# recently_failed SHA → status 0 when a build of SHA failed less than FAILED_RETRY_AFTER ago
recently_failed() {
  local sha='' at=''
  read -r sha at <<<"$(au_get failed)" || true
  [[ -n $sha && $sha == "$1" && $at =~ ^[0-9]+$ ]] && (($(now_s) - at < FAILED_RETRY_AFTER))
}


# scripts_changed → status 0 when the source just fetched brings other copies of these scripts than
# the ones running (bin/ from the last update): they should do the build and restart — a first update
# after a script change would otherwise build the new version with the old steps
scripts_changed() {
  local self=${BASH_SOURCE[0]:-}
  [[ ${SGWL_REEXEC:-0} != 1 && -n $self && -f $self && -f $APP_DIR/deploy/home-host.sh && -f $APP_DIR/deploy/install.sh ]] || return 1
  ! cmp -s "$APP_DIR/deploy/home-host.sh" "$self" || ! cmp -s "$APP_DIR/deploy/install.sh" "$HH_LIB"
}

# hand_over COMMAND → run the fetched version of this script for COMMAND (it skips the fetch)
hand_over() {
  log "新版本的安装脚本接手 / the new version's scripts take over"
  # (the commit fetched goes along; the lock stays: exec keeps this process)
  SGWL_TARGET_SHA=$FETCHED_SHA SGWL_REEXEC=1 exec bash "$APP_DIR/deploy/home-host.sh" "$1"
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

# update_plist LABEL SCRIPT INTERVAL_S PATH LOG → the LaunchAgent that runs `SCRIPT auto-update` every
# INTERVAL_S seconds (launchd never starts it twice at once; a run missed while the Mac slept comes
# when it wakes). The job itself decides whether there is anything to do (cmd_auto_update).
update_plist() {
  local label script path log
  label=$(xml_escape "$1")
  script=$(xml_escape "$2")
  path=$(xml_escape "$4")
  log=$(xml_escape "$5")
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 三国杀·枪火乱世 auto-update — written by warlords/deploy/home-host.sh -->
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
	<key>StartInterval</key>
	<integer>$3</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
</dict>
</plist>
EOF
}

# update_units SCRIPT USER INTERVAL_S PATH → sgwl-home-update.service, a line "---", sgwl-home-update.timer
# (2 minutes after boot, then INTERVAL_S after each run ended: never two at once)
update_units() {
  cat <<EOF
# 三国杀·枪火乱世 auto-update — written by warlords/deploy/home-host.sh
[Unit]
Description=Sanguo Warlords auto-update (a commit GitHub CI passed; skipped while anyone plays)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$2
Environment=PATH=$4
ExecStart=/bin/bash $1 auto-update
---
# 三国杀·枪火乱世 auto-update — written by warlords/deploy/home-host.sh
[Unit]
Description=Sanguo Warlords auto-update every $(($3 / 60)) minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=$3s
AccuracySec=30s

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
  warn_key_expiry
}

# warn_key_expiry: Tailscale logs a machine out when its key expires (180 days by default) — the
# public address then stops working without a word. Say so while key expiry is on.
warn_key_expiry() {
  local exp
  exp=$("$TS" status --json 2>/dev/null | ts_key_expiry || true)
  [[ -n $exp ]] || return 0
  warn "这台机器的 Tailscale 密钥会在 ${exp%%T*} 过期，到时公网地址会失效。请主人在 https://login.tailscale.com/admin/machines 点这台机器右侧「…」→ Disable key expiry。
  Tailscale's key for this machine expires on ${exp%%T*}, and then the public address stops working:
  https://login.tailscale.com/admin/machines → this machine's … → Disable key expiry."
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

# ── GitHub (the auto-update's questions) ────────────────────────────────────

# remote_head_sha → the commit at the head of the branch on GitHub (git ls-remote; else the API)
remote_head_sha() {
  local out=''
  if git_ok; then
    out=$(run_timeout 30 git ls-remote "https://github.com/${REPO_SLUG}.git" "refs/heads/${BRANCH}" 2>/dev/null | cut -f1 | head -n1 || true)
    if is_sha "$out"; then
      echo "$out"
      return 0
    fi
  fi
  out=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/${REPO_SLUG}/commits/${BRANCH}" 2>/dev/null || true)
  is_sha "$out" || return 1
  echo "$out"
}

# github_api URL → GitHub's JSON answer (unauthenticated: 60 requests an hour per address — the job
# asks at most 2–3 times per run). Status 2 when GitHub refuses for now (rate limit), 1 otherwise.
github_api() {
  local out code
  out=$(curl -sS --max-time 20 -H 'Accept: application/vnd.github+json' -w '\n%{http_code}' "$1" 2>/dev/null) || return 1
  code=$(printf '%s\n' "$out" | tail -n1)
  case $code in
    200) printf '%s\n' "$out" | sed '$d' ;;
    403 | 429) return 2 ;;
    *) return 1 ;;
  esac
}

ci_runs_url() {
  printf 'https://api.github.com/repos/%s/actions/workflows/warlords-ci.yml/runs?%s\n' "$REPO_SLUG" "$1"
}

# ── one install / update at a time ──────────────────────────────────────────

# acquire_lock [WAIT_S] → status 0 once this process holds LOCK_DIR (waiting up to WAIT_S for the
# holder; a lock whose process is gone is taken over; the process a hand-over exec'd keeps it)
acquire_lock() {
  local wait=${1:-0} waited=0 pid
  while :; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" >"$LOCK_DIR/pid"
      LOCK_HELD=1
      return 0
    fi
    pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [[ -z $pid ]]; then
      # (just created, its pid not written yet — or left empty by a crash)
      sleep 1
      pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    fi
    if [[ $pid == "$$" ]]; then
      LOCK_HELD=1
      return 0
    fi
    if [[ -z $pid ]] || ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      continue
    fi
    ((waited < wait)) || return 1
    if ((waited == 0)); then log "另一个安装/更新正在进行，等它结束（最多 $((wait / 60)) 分钟）/ another install or update is running — waiting for it (up to $((wait / 60)) min)"; fi
    sleep 5
    waited=$((waited + 5))
  done
}

release_lock() {
  if [[ $LOCK_HELD == 1 ]]; then
    rm -rf "$LOCK_DIR"
    LOCK_HELD=0
  fi
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
    # (it holds the access key: only this user reads it)
    (
      umask 077
      launchd_plist "$LABEL" "$node" "$APP_DIR" "$APP_PORT" "$SERVER_LOG" "$HEADLESS_SETTING" "$RELAY_KEY" >"$PLIST.tmp"
    )
    mv "$PLIST.tmp" "$PLIST"
    launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
      sleep 1
      launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
    fi
  else
    tmp=$(mktemp)
    # the key in an EnvironmentFile of our own (600): the unit itself is readable by anyone
    write_key_env "$SERVER_ENV" "$RELAY_KEY"
    systemd_unit "$node" "$APP_DIR" "$APP_PORT" "$(id -un)" home-host.sh "$HEADLESS_SETTING" "$SERVER_ENV" "${HOME_ENV[@]}" >"$tmp"
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

# check_public → status 0 once friends can reach the game (public DNS → Funnel → this machine),
# with the access key — and the relay must refuse a socket without it
check_public() {
  local url _i key=()
  url=$(game_url "$DOMAIN")
  [[ -f $APP_DIR/deploy/check.mjs ]] || return 1
  if [[ -n $RELAY_KEY && $RELAY_KEY != off ]]; then key=("--key=$RELAY_KEY"); fi
  log "检查（本机经 Tailscale）/ checking through Tailscale"
  node "$APP_DIR/deploy/check.mjs" "$url" ${key[@]+"${key[@]}"} || warn "经 Tailscale 访问失败 / not reachable through Tailscale"
  log "检查公网访问（朋友走的路：公网 DNS → Funnel）/ checking from the internet side (public DNS → Funnel)"
  # (the server-hosted match check ran above: no test room per retry)
  for _i in $(seq 1 12); do
    if node "$APP_DIR/deploy/check.mjs" "$url" --public-dns --no-headless ${key[@]+"${key[@]}"}; then return 0; fi
    sleep 10
  done
  return 1
}

# ── configuration ───────────────────────────────────────────────────────────
# save_state: host.env — it holds the access key, so only this user may read it (600)
save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  (
    umask 077
    cat >"$STATE_FILE.tmp" <<EOF
# written by warlords/deploy/home-host.sh
DOMAIN=$DOMAIN
SGWL_PORT=$APP_PORT
SGWL_BRANCH=$BRANCH
SGWL_HEADLESS=$HEADLESS_SETTING
RELAY_KEY=$RELAY_KEY
NODE_BIN_DIR=$(dirname "$(command -v node)")
EOF
  )
  chmod 600 "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# saved_relay_key → the access key an earlier run saved in host.env ('' none, 'off' turned off)
saved_relay_key() {
  sed -n 's/^RELAY_KEY=//p' "$STATE_FILE" 2>/dev/null | head -n1 || true
}

# load_key_setting: the access key for this install / update — SGWL_RELAY_KEY (a key / off), else
# host.env's, else a new one (the first install with this version: friends need the share link)
load_key_setting() {
  resolve_relay_key "$(saved_relay_key)"
  if [[ $RELAY_KEY_NEW == 1 ]]; then
    log "已生成访问密钥：从现在起朋友要用最后打印的「分享链接」进入 / made an access key: from now on friends join through the SHARE LINK printed at the end"
  elif [[ $RELAY_KEY == off ]]; then
    warn "访问密钥已关闭（SGWL_RELAY_KEY=off）：谁拿到网址都能玩 / access key off: anyone with the address can play"
  fi
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
  RELAY_KEY=$(saved_relay_key)
  [[ -n $DOMAIN ]]
}

# built_sha → the commit the build on disk is (APP_DIR/.sgwl-sha, written after a build; '' unknown)
built_sha() {
  local s
  s=$(cat "$APP_DIR/.sgwl-sha" 2>/dev/null || true)
  if is_sha "$s"; then echo "$s"; fi
}

# refresh_bin: the copy of these scripts the auto-update runs (renamed into place: a running copy is not disturbed)
refresh_bin() {
  [[ -f $APP_DIR/deploy/home-host.sh ]] || return 0
  mkdir -p "$BIN_DIR"
  cp "$APP_DIR/deploy/home-host.sh" "$BIN_DIR/home-host.sh.new" && mv "$BIN_DIR/home-host.sh.new" "$BIN_DIR/home-host.sh"
  cp "$APP_DIR/deploy/install.sh" "$BIN_DIR/install.sh.new" && mv "$BIN_DIR/install.sh.new" "$BIN_DIR/install.sh"
}

# the auto-update: a copy of these scripts (an update replaces the source tree under it) and a
# LaunchAgent / systemd timer that runs `home-host.sh auto-update` every UPDATE_INTERVAL seconds
install_updater() {
  local path
  if [[ ! -f $APP_DIR/deploy/home-host.sh ]]; then
    warn "这个版本还没有 home-host.sh，跳过自动更新 / no home-host.sh in this version: no auto-update"
    return 0
  fi
  refresh_bin
  path="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [[ $HOST_OS == macos ]]; then
    update_plist "$UPDATE_LABEL" "$BIN_DIR/home-host.sh" "$UPDATE_INTERVAL" "$path" "$UPDATE_LOG" >"$UPDATE_PLIST.tmp"
    mv "$UPDATE_PLIST.tmp" "$UPDATE_PLIST"
    launchctl bootout "gui/$UID/$UPDATE_LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$UID" "$UPDATE_PLIST" 2>/dev/null || launchctl load -w "$UPDATE_PLIST" 2>/dev/null || warn "自动更新没有启用 / could not schedule the auto-update"
  else
    local tmp
    tmp=$(mktemp)
    update_units "$BIN_DIR/home-host.sh" "$(id -un)" "$UPDATE_INTERVAL" "$path" >"$tmp"
    sed '/^---$/,$d' "$tmp" | $SUDO tee "/etc/systemd/system/${UNIT}-update.service" >/dev/null
    sed '1,/^---$/d' "$tmp" | $SUDO tee "/etc/systemd/system/${UNIT}-update.timer" >/dev/null
    rm -f "$tmp"
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable -q "${UNIT}-update.timer"
    $SUDO systemctl restart "${UNIT}-update.timer"
  fi
  log "每 $((UPDATE_INTERVAL / 60)) 分钟检查一次更新：只更新到 GitHub CI 通过的版本，有人在玩时不更新 / checks for updates every $((UPDATE_INTERVAL / 60)) minutes: only to a version GitHub's CI passed, never while anyone plays"
}

# restart the game server without sudo (the auto-update): launchd / systemd (Restart=always) start it again
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
  # (an auto-update building right now finishes first: two builds must not swap dist/ at once)
  acquire_lock 2700 || die "另一个安装/更新 45 分钟还没结束 / another install or update has been running for 45 minutes — see $LOG_FILE"
  load_headless_setting
  load_key_setting
  ensure_node
  ensure_tailscale
  # the key is saved before anything else can fail: the next run keeps it
  save_state
  stats=$(server_stats)
  if [[ -n $stats ]] && game_busy "$stats"; then
    warn "有人在玩（玩家 $(human_players "$stats")）：重启服务会让他们掉线 / $(human_players "$stats") player(s) connected: restarting the server drops them"
  fi
  if [[ ${SGWL_REEXEC:-0} != 1 ]]; then
    # the branch head, pinned (a source tarball says no commit by itself)
    FETCH_REF=$(remote_head_sha || true)
    fetch_source
  else
    FETCHED_SHA=${SGWL_TARGET_SHA:-$(git_head)}
  fi
  if scripts_changed; then hand_over "$1"; fi
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
  local ok=1 stats state dns _https _funnel target sha
  node_path_setup
  RELAY_KEY=$(saved_relay_key)
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
    if [[ $(stat_flag "$stats" keyRequired) == true ]]; then
      log "访问密钥 access key: 开 on（朋友用分享链接进入 / friends join through the share link）"
    else
      warn "访问密钥 access key: 关 off — 谁拿到网址都能玩 / anyone with the address can play"
    fi
    sha=$(stat_sha "$stats")
    log "版本 version: ${sha:0:12}${sha:+ · }每 $((UPDATE_INTERVAL / 60)) 分钟自动更新到 GitHub CI 通过的版本 / auto-updates every $((UPDATE_INTERVAL / 60)) min to what GitHub's CI passed"
  else
    warn "本机 127.0.0.1:${APP_PORT} 无响应 / no answer"
    ok=0
  fi
  TS=$(find_tailscale) || stop_here "$(tailscale_help "$HOST_OS")"
  read -r state dns _https _funnel <<<"$(ts_fields)"
  log "Tailscale: $state $dns"
  warn_key_expiry
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

# auto_restart SHA: the server still runs an older build than the one on disk (a restart that had
# to wait for the players) — restart it now, once per build (a server that cannot say which build it
# runs must not be restarted every 5 minutes)
auto_restart() {
  if [[ $(au_get restarted) == "$1" ]]; then
    skip_log restart-no-effect "重启后服务器仍报告旧版本 / after a restart the server still reports another build than ${1:0:12}"
    return 0
  fi
  au_set restarted "$1"
  au_header
  log "重启到已构建的新版本 / restarting into the build waiting on disk (${1:0:12})"
  service_kick || die "重启后游戏服务没有启动 / the game server did not come back after the restart"
  log "已更新 / updated (${1:0:12})"
}

# the job every 5 minutes: nothing while anyone plays; nothing unless GitHub's branch head is another
# commit than the one built here AND GitHub's warlords-ci passed for it (else the newest commit CI
# passed); then fetch, build, check again that nobody started playing, restart. Each reason to skip
# is logged at most once an hour; GitHub rate limits / no network skip the round.
cmd_auto_update() {
  local stats head built running decision runs rc verdict target
  rotate_logs
  node_path_setup
  load_state || die "尚未安装 / not installed yet"
  load_headless_setting
  acquire_lock 0 || {
    skip_log locked "另一个安装/更新正在进行，这一轮跳过 / another install or update is running — skipping this round"
    return 0
  }
  # a build marker left behind: that build failed (it died) — not again for an hour
  if [[ -f $AU_BUILDING ]]; then
    au_set failed "$(cat "$AU_BUILDING" 2>/dev/null || echo unknown) $(now_s)"
    rm -f "$AU_BUILDING"
  fi
  stats=$(server_stats)
  if [[ -z $stats ]]; then
    skip_log server-down "游戏服务没有响应（launchd / systemd 会重启它），这一轮不更新 / the game server does not answer (launchd / systemd restarts it) — no update this round"
    return 0
  fi
  if game_busy "$stats"; then
    skip_log busy "有人在玩（房间 $(stat_field "$stats" rooms)，玩家 $(human_players "$stats")，服务器托管 $(stat_field "$stats" headlessHumans)），不更新 / a game is on — no update"
    return 0
  fi
  if [[ ${SGWL_REEXEC:-0} == 1 ]]; then
    # the previous version's scripts decided and fetched; these build it
    FETCHED_SHA=${SGWL_TARGET_SHA:-$(git_head)}
  else
    head=$(remote_head_sha) || {
      skip_log offline "连不上 GitHub，这一轮跳过 / GitHub unreachable — skipping this round"
      return 0
    }
    built=$(built_sha)
    running=$(stat_sha "$stats")
    decision=$(update_decision "$head" "$built" "$running")
    if [[ $decision == current ]]; then return 0; fi
    if [[ $decision == restart ]]; then
      auto_restart "$built"
      return 0
    fi
    if recently_failed "$head"; then
      skip_log build-failed "${head:0:12} 的构建一小时内失败过，稍后再试 / building ${head:0:12} failed within the hour — trying again later"
      return 0
    fi
    if runs=$(github_api "$(ci_runs_url "head_sha=${head}&event=push&per_page=20")"); then rc=0; else rc=$?; fi
    if ((rc == 2)); then
      skip_log rate-limited "GitHub 暂时拒绝查询（频率限制），这一轮跳过 / GitHub refuses for now (rate limit) — skipping this round"
      return 0
    elif ((rc != 0)); then
      skip_log github "查不到 GitHub CI 的结果，这一轮跳过 / could not ask GitHub about CI — skipping this round"
      return 0
    fi
    verdict=$(ci_verdict "$runs" "$head")
    case $verdict in
      success) target=$head ;;
      pending)
        skip_log ci-pending "${head:0:12} 的 CI 还没跑完，等它通过 / CI for ${head:0:12} is still running — waiting for it to pass"
        return 0
        ;;
      failure)
        skip_log ci-failed "${head:0:12} 的 CI 没通过，不更新 / CI failed for ${head:0:12} — not updating"
        return 0
        ;;
      *)
        # no warlords-ci run for the head (it changed nothing the CI watches, or was pushed seconds
        # ago): the newest commit CI passed on the branch, if the build here is not that one already
        if runs=$(github_api "$(ci_runs_url "branch=${BRANCH}&event=push&status=success&per_page=1")"); then rc=0; else rc=$?; fi
        target=''
        if ((rc == 0)); then target=$(latest_green_sha "$runs"); fi
        if [[ -z $target || $target == "$built" ]] || recently_failed "$target"; then
          skip_log no-ci "${head:0:12} 没有 warlords-ci 的结果，已是 CI 通过的最新版 / no warlords-ci run for ${head:0:12}; the build here is the newest CI passed"
          return 0
        fi
        ;;
    esac
    au_header
    log "更新到 / updating to ${target:0:12}（GitHub CI ✓）"
    FETCH_REF=$target
    fetch_source
    # (a source tarball knows no commit by itself: it is the one asked for)
    if [[ -z $FETCHED_SHA ]]; then FETCHED_SHA=$target; fi
  fi
  if scripts_changed; then hand_over auto-update; fi
  au_header
  echo "${FETCHED_SHA:-unknown}" >"$AU_BUILDING"
  build_game
  rm -f "$AU_BUILDING"
  # the build takes minutes (npm ci: up to half an hour): someone may have started playing meanwhile.
  # The new page and room worker are already in place; the restart waits for a run nobody plays in.
  stats=$(server_stats)
  if [[ -n $stats ]] && game_busy "$stats"; then
    log "已构建，但有人开始玩了，重启推迟 / built, but a game started meanwhile — the restart waits until nobody plays"
    refresh_bin
    return 0
  fi
  au_set restarted "${FETCHED_SHA:-unknown}"
  service_kick || die "更新后游戏服务没有启动 / the game server did not come back after the update"
  refresh_bin
  log "已更新 / updated (${FETCHED_SHA:0:12})"
}

# rotate-key: a new access key (a share link went too far). The server restarts with it: everyone
# playing drops, and every friend needs the new share link.
cmd_rotate_key() {
  local stats
  rotate_logs
  node_path_setup
  load_state || die "尚未安装，先运行安装命令 / not installed yet — run the install command first"
  load_headless_setting
  acquire_lock 2700 || die "另一个安装/更新还在进行 / another install or update is still running"
  stats=$(server_stats)
  if [[ -n $stats ]] && game_busy "$stats"; then
    warn "有人在玩（玩家 $(human_players "$stats")）：换密钥会重启服务，他们会掉线 / $(human_players "$stats") player(s) connected: the restart drops them"
  fi
  RELAY_KEY=$(gen_relay_key) || die "无法生成访问密钥 / could not generate an access key"
  save_state
  install_service
  warn "访问密钥已更换：旧的分享链接从现在起失效，把下面的新链接发给朋友 / the access key changed: old share links stop working now — send friends the new link below"
  print_summary
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
  # (a hand-over from the previous version's script: its output already goes to the log)
  if [[ ${SGWL_REEXEC:-0} != 1 ]]; then exec > >(tee -a "$LOG_FILE") 2>&1; fi
  trap 'on_error $LINENO' ERR
  trap release_lock EXIT
  # (the auto-update runs every 5 minutes: it writes its heading only when it has something to say)
  if [[ $cmd != auto-update ]]; then log "$(date '+%F %T') sgwl home-host.sh ${cmd} ($HOST_OS $(uname -m))"; fi
  case $cmd in
    install | update) cmd_install "$cmd" ;;
    status) cmd_status || exit 1 ;;
    rotate-key) cmd_rotate_key ;;
    stop) cmd_stop ;;
    auto-update) cmd_auto_update ;;
    *) die "用法 / usage: home-host.sh [install|update|status|rotate-key|stop|auto-update]" ;;
  esac
}

if [[ ${SGWL_LIB:-0} != 1 ]]; then
  main "$@"
fi

