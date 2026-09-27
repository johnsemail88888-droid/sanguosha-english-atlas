#!/usr/bin/env bash
# 三国杀·枪火乱世 — official online server: one-command install / update / status.
#
# Paste into the cloud server's web console (Ubuntu 22.04/24.04 or Debian; Alibaba Cloud
# Linux 3 / CentOS Stream / Rocky 8+ via dnf also work):
#
#   curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/install.sh | sudo bash
#   (mirror) curl -fsSL https://cdn.jsdelivr.net/gh/johnsemail88888-droid/sanguosha-english-atlas@main/warlords/deploy/install.sh | sudo bash
#
#   … | sudo bash -s -- update     pull the latest game, rebuild, restart
#   … | sudo bash -s -- status     is everything running? (prints the two lines again)
#   … | sudo DOMAIN=game.example.com bash    use your own domain instead of <ip>.sslip.io
#
# What it does (safe to re-run — every step checks what is already there):
#   Node 22 (NodeSource, else the official / npmmirror binary tarball) · the game from GitHub
#   (shallow git clone, else a codeload tarball) · npm ci (npmmirror fallback) · vite build ·
#   systemd service `sgwl` = server/server.mjs on 127.0.0.1:8787 (game files + /ws relay +
#   /peerjs signalling) · Caddy as the HTTPS front (Let's Encrypt certificate for
#   https://<a-b-c-d>.sslip.io, derived from this server's public IPv4) · ports 80/443 in
#   ufw / firewalld when those are active. The cloud provider's own firewall ("security
#   group" / 防火墙) must allow TCP 80 and 443 — the installer checks and says so.
#
# Tests source this file with SGWL_LIB=1 (functions only, nothing runs):
#   tests/unit/deploy/install.test.ts
set -Eeuo pipefail

REPO_SLUG=johnsemail88888-droid/sanguosha-english-atlas
BRANCH=${SGWL_BRANCH:-main}
INSTALL_DIR=${SGWL_DIR:-/opt/sgwl}
APP_PORT=${SGWL_PORT:-8787}
NODE_MAJOR=22
SERVICE=sgwl
SERVICE_USER=sgwl
STATE_FILE=${SGWL_STATE:-/etc/sgwl.env}
LOG_FILE=${SGWL_LOG:-/var/log/sgwl-install.log}
CADDYFILE=${SGWL_CADDYFILE:-/etc/caddy/Caddyfile}
NPM_MIRROR=https://registry.npmmirror.com
CADDY_FALLBACK_VERSION=2.8.4

SRC_DIR="$INSTALL_DIR/src"
APP_DIR="$SRC_DIR/warlords"

# ── output ──────────────────────────────────────────────────────────────────
log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2
  exit 1
}

# ── pure helpers (unit-tested) ──────────────────────────────────────────────

# is_ipv4 1.2.3.4 → status 0
is_ipv4() {
  local ip=$1 IFS=. part
  [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  # shellcheck disable=SC2086 # split on dots on purpose
  set -- $ip
  for part in "$@"; do
    ((10#$part <= 255)) || return 1
  done
}

# is_public_ipv4 IP → status 0 unless private / loopback / link-local / CGNAT / unspecified
is_public_ipv4() {
  local ip=$1 a b
  is_ipv4 "$ip" || return 1
  IFS=. read -r a b _ _ <<<"$ip"
  a=$((10#$a))
  b=$((10#$b))
  ((a == 0 || a == 10 || a == 127 || a >= 224)) && return 1
  ((a == 100 && b >= 64 && b <= 127)) && return 1
  ((a == 169 && b == 254)) && return 1
  ((a == 172 && b >= 16 && b <= 31)) && return 1
  ((a == 192 && b == 168)) && return 1
  return 0
}

# extract_ipv4 "当前 IP：47.242.1.2  来自于：…" → 47.242.1.2 (the first IPv4 in the text)
extract_ipv4() {
  grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' <<<"$1" | head -n1 || true
}

# sslip_host 47.242.1.2 → 47-242-1-2.sslip.io (a public DNS name for an IP, so Let's Encrypt can issue a certificate)
sslip_host() {
  is_ipv4 "$1" || return 1
  printf '%s.sslip.io\n' "${1//./-}"
}

# game_url DOMAIN / relay_url DOMAIN — the two lines the player sends back
game_url() { printf 'https://%s/\n' "$1"; }
relay_url() { printf 'wss://%s/ws\n' "$1"; }

# valid_domain NAME → status 0 for a plausible DNS name (what goes into the Caddyfile)
valid_domain() {
  [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]
}

# caddyfile DOMAIN PORT → Caddy config: HTTPS for DOMAIN, everything proxied to the game server.
# The WebSocket endpoints (/ws relay, /peerjs signalling) get a plain proxy (Caddy passes the
# Upgrade through by itself); pages and assets are compressed.
caddyfile() {
  local domain=$1 port=$2
  cat <<EOF
# 三国杀·枪火乱世 official server — written by warlords/deploy/install.sh (re-running it rewrites this file)
${domain} {
	@sockets path /ws /ws/* /peerjs /peerjs/*
	handle @sockets {
		reverse_proxy 127.0.0.1:${port}
	}
	handle {
		encode zstd gzip
		reverse_proxy 127.0.0.1:${port}
	}
}
EOF
}

# write_caddyfile PATH DOMAIN PORT → status 0 if PATH changed
write_caddyfile() {
  local path=$1 tmp
  tmp=$(mktemp)
  caddyfile "$2" "$3" >"$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  mkdir -p "$(dirname "$path")"
  install -m 0644 "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

# systemd_unit NODE_BIN APP_DIR PORT USER → the sgwl.service unit
systemd_unit() {
  local node=$1 dir=$2 port=$3 user=$4
  cat <<EOF
# 三国杀·枪火乱世 official server — written by warlords/deploy/install.sh
[Unit]
Description=Sanguo Warlords game server (web + WebSocket relay + PeerJS signalling)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${dir}
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=${port}
ExecStart=${node} ${dir}/server/server.mjs
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
}

# ── system ──────────────────────────────────────────────────────────────────
PKG=

detect_pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG=apt
  elif command -v dnf >/dev/null 2>&1; then
    PKG=dnf
  elif command -v yum >/dev/null 2>&1; then
    PKG=yum
  else
    die "不支持的系统（需要 apt 或 dnf）/ Unsupported OS: need apt (Ubuntu/Debian) or dnf (Alibaba Cloud Linux / CentOS 8+)"
  fi
}

pkg_install() {
  case $PKG in
    apt) DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y -q "$@" ;;
    dnf | yum) "$PKG" install -y -q "$@" ;;
  esac
}

APT_UPDATED=0
apt_update() {
  [[ $PKG == apt && $APT_UPDATED == 0 ]] || return 0
  DEBIAN_FRONTEND=noninteractive apt-get update -q || warn "apt-get update 有错误，继续 / apt-get update reported errors, continuing"
  APT_UPDATED=1
}

install_base() {
  log "安装基础工具 / base packages (curl git tar xz)"
  apt_update
  case $PKG in
    apt) pkg_install ca-certificates curl git tar xz-utils gnupg ;;
    *) pkg_install ca-certificates curl git tar xz ;;
  esac
}

# 1 GB machines run out of memory during npm ci / the build without swap
ensure_swap() {
  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  if ((mem_kb >= 1900000)) || [[ -n $(swapon --noheadings --show 2>/dev/null || true) ]]; then return 0; fi
  log "内存较小，添加 2 GB 交换空间 / adding 2 GB swap (small RAM)"
  local f=/swapfile-sgwl
  if [[ ! -f $f ]]; then
    fallocate -l 2G "$f" 2>/dev/null || dd if=/dev/zero of="$f" bs=1M count=2048 status=none || {
      warn "无法创建交换文件 / could not create a swap file"
      return 0
    }
    chmod 600 "$f"
    mkswap "$f" >/dev/null || return 0
  fi
  swapon "$f" 2>/dev/null || {
    warn "无法启用交换空间（容器/OpenVZ？）/ swapon failed (container?)"
    return 0
  }
  grep -q "^$f " /etc/fstab 2>/dev/null || echo "$f none swap sw 0 0" >>/etc/fstab
}

node_major() {
  command -v node >/dev/null 2>&1 || {
    echo 0
    return
  }
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/;t;s/.*/0/'
}

node_arch() {
  case $(uname -m) in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) return 1 ;;
  esac
}

install_node_nodesource() {
  local setup
  setup=$(mktemp)
  case $PKG in
    apt)
      curl -fsSL --max-time 60 "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup" &&
        bash "$setup" &&
        pkg_install nodejs
      ;;
    *)
      curl -fsSL --max-time 60 "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup" &&
        bash "$setup" &&
        pkg_install nodejs
      ;;
  esac
  rm -f "$setup"
  (($(node_major) >= NODE_MAJOR))
}

# the official build, from nodejs.org or its China mirror (npmmirror), checksum-verified
install_node_tarball() {
  local arch base file tmp
  arch=$(node_arch) || die "不支持的 CPU 架构 / unsupported CPU: $(uname -m)"
  tmp=$(mktemp -d)
  for base in "$NPM_MIRROR/-/binary/node/latest-v${NODE_MAJOR}.x" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; do
    log "下载 Node.js / downloading Node.js from ${base%%/-/*}"
    curl -fsSL --max-time 30 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || continue
    file=$(grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n1)
    [[ -n $file ]] || continue
    curl -fL --retry 2 --max-time 600 "$base/$file" -o "$tmp/$file" || continue
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || {
      warn "校验失败 / checksum mismatch: $file"
      continue
    }
    rm -rf /usr/local/lib/nodejs
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1
    ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
    ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
    ln -sf /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
    hash -r
    rm -rf "$tmp"
    (($(node_major) >= NODE_MAJOR)) && return 0
  done
  rm -rf "$tmp"
  return 1
}

install_node() {
  if (($(node_major) >= NODE_MAJOR)); then
    log "Node.js $(node -v) 已安装 / already installed"
    return
  fi
  log "安装 Node.js ${NODE_MAJOR} / installing Node.js ${NODE_MAJOR}"
  install_node_nodesource || {
    warn "NodeSource 不可用，改用二进制包 / NodeSource unavailable, using the binary tarball"
    install_node_tarball || die "Node.js 安装失败 / could not install Node.js"
  }
  log "Node.js $(node -v)"
}

# ── the game ────────────────────────────────────────────────────────────────
fetch_tarball() {
  local tmp
  tmp=$(mktemp -d)
  log "下载源码包 / downloading the source tarball (codeload.github.com)"
  curl -fL --retry 3 --max-time 900 "https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}" -o "$tmp/src.tgz" || {
    rm -rf "$tmp"
    return 1
  }
  mkdir -p "$tmp/src"
  tar -xzf "$tmp/src.tgz" -C "$tmp/src" --strip-components=1 || {
    rm -rf "$tmp"
    return 1
  }
  [[ -f $tmp/src/warlords/package.json ]] || {
    rm -rf "$tmp"
    return 1
  }
  # keep the installed node_modules: npm ci decides whether they are still right
  if [[ -d $APP_DIR/node_modules ]]; then mv "$APP_DIR/node_modules" "$tmp/src/warlords/node_modules"; fi
  rm -rf "$SRC_DIR"
  mkdir -p "$INSTALL_DIR"
  mv "$tmp/src" "$SRC_DIR"
  rm -rf "$tmp"
}

fetch_source() {
  mkdir -p "$INSTALL_DIR"
  if [[ -d $SRC_DIR/.git ]]; then
    log "更新源码 / updating the source (git)"
    if timeout 600 git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" && git -C "$SRC_DIR" reset -q --hard FETCH_HEAD; then
      return 0
    fi
    warn "git 更新失败，改用源码包 / git update failed, using the tarball"
    fetch_tarball || die "无法下载游戏源码 / could not download the game"
    return 0
  fi
  if [[ -f $APP_DIR/package.json ]]; then
    # an earlier tarball install: fetch it again
    fetch_tarball || die "无法下载游戏源码 / could not download the game"
    return 0
  fi
  local tmp="$INSTALL_DIR/src.tmp"
  rm -rf "$tmp"
  log "下载游戏 / cloning the game (github.com, shallow)"
  if timeout 900 git clone -q --depth 1 --branch "$BRANCH" --filter=blob:none --sparse "https://github.com/${REPO_SLUG}.git" "$tmp" &&
    git -C "$tmp" sparse-checkout set warlords; then
    mv "$tmp" "$SRC_DIR"
    return 0
  fi
  rm -rf "$tmp"
  if timeout 900 git clone -q --depth 1 --branch "$BRANCH" "https://github.com/${REPO_SLUG}.git" "$tmp"; then
    mv "$tmp" "$SRC_DIR"
    return 0
  fi
  rm -rf "$tmp"
  warn "git clone 失败，改用源码包 / git clone failed, using the tarball"
  fetch_tarball || die "无法下载游戏源码（github.com 不通？）/ could not download the game (is github.com reachable?)"
}

build_game() {
  cd "$APP_DIR"
  # no desktop-app / browser binaries on a server
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
  local lock_sha stamp=node_modules/.sgwl-lock.sha256
  lock_sha=$(sha256sum package-lock.json | cut -d' ' -f1)
  if [[ -f $stamp && $(cat "$stamp") == "$lock_sha" && -d node_modules/vite ]]; then
    log "依赖未变化 / dependencies unchanged"
  else
    log "安装依赖 / npm ci"
    if ! timeout 1200 npm ci --no-audit --no-fund; then
      warn "npm 官方源失败，改用国内镜像 / npm registry failed, using $NPM_MIRROR"
      timeout 1800 npm ci --no-audit --no-fund --registry="$NPM_MIRROR" || die "npm ci 失败 / npm ci failed"
    fi
    echo "$lock_sha" >"$stamp"
  fi
  # vite only: the type check (tsc -b) belongs to development and needs ~1 GB RAM on its own
  log "构建游戏 / building the game (vite build)"
  NODE_OPTIONS=--max-old-space-size=1536 node node_modules/vite/bin/vite.js build --logLevel warn || die "构建失败 / build failed"
  [[ -f dist/index.html ]] || die "构建失败：没有 dist/index.html / build produced no dist/index.html"
}

install_service() {
  local node nologin
  node=$(command -v node)
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    nologin=$(command -v nologin || echo /bin/false)
    useradd --system --no-create-home --shell "$nologin" "$SERVICE_USER"
  fi
  systemd_unit "$node" "$APP_DIR" "$APP_PORT" "$SERVICE_USER" >"/etc/systemd/system/${SERVICE}.service"
  systemctl daemon-reload
  systemctl enable -q "$SERVICE"
  systemctl restart "$SERVICE"
  log "等待游戏服务启动 / waiting for the game server"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/sgwl.json" >/dev/null 2>&1; then
      log "游戏服务已运行 / game server is up (127.0.0.1:${APP_PORT})"
      return 0
    fi
    sleep 1
  done
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "游戏服务没有启动 / the game server did not start (see the log above)"
}

# ── HTTPS front (Caddy) ─────────────────────────────────────────────────────
caddy_arch() {
  case $(uname -m) in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) return 1 ;;
  esac
}

install_caddy_binary() {
  local arch tmp
  arch=$(caddy_arch) || die "不支持的 CPU 架构 / unsupported CPU: $(uname -m)"
  tmp=$(mktemp -d)
  log "下载 Caddy 二进制 / downloading the Caddy binary"
  if ! curl -fL --retry 2 --max-time 300 "https://caddyserver.com/api/download?os=linux&arch=${arch}" -o "$tmp/caddy"; then
    if ! curl -fL --retry 2 --max-time 300 "https://github.com/caddyserver/caddy/releases/download/v${CADDY_FALLBACK_VERSION}/caddy_${CADDY_FALLBACK_VERSION}_linux_${arch}.tar.gz" -o "$tmp/caddy.tgz" ||
      ! tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy; then
      rm -rf "$tmp"
      return 1
    fi
  fi
  install -m 0755 "$tmp/caddy" /usr/bin/caddy
  rm -rf "$tmp"
  getent group caddy >/dev/null || groupadd --system caddy
  id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell "$(command -v nologin || echo /bin/false)" caddy
  mkdir -p /etc/caddy
  cat >/etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    log "Caddy $(caddy version 2>/dev/null | cut -d' ' -f1) 已安装 / already installed"
    return
  fi
  log "安装 Caddy（HTTPS）/ installing Caddy (HTTPS)"
  case $PKG in
    apt)
      pkg_install debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1 || true
      if curl -fsSL --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg &&
        curl -fsSL --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list; then
        APT_UPDATED=0
        apt_update
        pkg_install caddy || true
      fi
      ;;
    *)
      { pkg_install 'dnf-command(copr)' && dnf -y -q copr enable @caddy/caddy && pkg_install caddy; } || true
      ;;
  esac
  command -v caddy >/dev/null 2>&1 || install_caddy_binary || die "Caddy 安装失败 / could not install Caddy"
}

configure_caddy() {
  local busy
  busy=$(ss -Hltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v caddy || true)
  [[ -z $busy ]] || warn "80/443 端口已被其他程序占用 / ports 80/443 are used by another program:
$busy"
  if write_caddyfile "$CADDYFILE" "$DOMAIN" "$APP_PORT"; then
    log "Caddy 配置已写入 / wrote $CADDYFILE for $DOMAIN"
  fi
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || {
    caddy validate --config "$CADDYFILE" --adapter caddyfile || true
    die "Caddy 配置无效 / invalid Caddy config"
  }
  systemctl enable -q caddy
  if systemctl is-active -q caddy; then systemctl reload caddy || systemctl restart caddy; else systemctl restart caddy; fi
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    log "ufw: 放行 80/443 / allowing 80, 443"
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null || true
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    log "firewalld: 放行 80/443 / allowing http, https"
    firewall-cmd -q --permanent --add-service=http --add-service=https
    firewall-cmd -q --reload
  fi
}

# the public HTTPS endpoint answers (certificate issued, provider firewall open)
https_ok() {
  local body
  body=$(curl -fsS --max-time 8 "https://$1/sgwl.json" 2>/dev/null) || return 1
  [[ $body == *sanguo-warlords* ]]
}

wait_https() {
  log "申请 HTTPS 证书并检查外网访问（最多约 2 分钟）/ getting the HTTPS certificate (up to ~2 min)"
  for _ in $(seq 1 24); do
    if https_ok "$DOMAIN"; then return 0; fi
    sleep 5
  done
  return 1
}

# ── configuration ───────────────────────────────────────────────────────────
load_state() {
  if [[ -f $STATE_FILE ]]; then
    local saved_domain
    saved_domain=$(sed -n 's/^DOMAIN=//p' "$STATE_FILE" | head -n1)
    DOMAIN=${DOMAIN:-$saved_domain}
  fi
}

save_state() {
  cat >"$STATE_FILE" <<EOF
# written by warlords/deploy/install.sh
DOMAIN=$DOMAIN
SGWL_DIR=$INSTALL_DIR
SGWL_PORT=$APP_PORT
SGWL_BRANCH=$BRANCH
EOF
}

# the server's public IPv4: IP-echo services (global + China), then the cloud metadata APIs
detect_public_ip() {
  local url out ip
  if [[ -n ${SGWL_IP:-} ]]; then
    echo "$SGWL_IP"
    return
  fi
  for url in https://api.ipify.org https://ipv4.icanhazip.com https://4.ipw.cn https://myip.ipip.net https://ifconfig.me/ip \
    http://100.100.100.200/latest/meta-data/eipv4 http://metadata.tencentyun.com/latest/meta-data/public-ipv4; do
    out=$(curl -4 -fsS --max-time 6 "$url" 2>/dev/null || true)
    ip=$(extract_ipv4 "$out")
    if [[ -n $ip ]] && is_public_ipv4 "$ip"; then
      echo "$ip"
      return
    fi
  done
  return 1
}

resolve_domain() {
  load_state
  if [[ -n ${DOMAIN:-} ]]; then
    valid_domain "$DOMAIN" || die "DOMAIN 无效 / invalid DOMAIN: $DOMAIN"
    return
  fi
  local ip
  ip=$(detect_public_ip) || die "无法检测公网 IP，请指定：DOMAIN=你的域名 或 SGWL_IP=公网IP / cannot detect the public IP — set DOMAIN=… or SGWL_IP=…"
  DOMAIN=$(sslip_host "$ip")
  log "公网 IP / public IP: $ip → $DOMAIN"
}

print_summary() {
  local game relay
  game=$(game_url "$DOMAIN")
  relay=$(relay_url "$DOMAIN")
  printf '\n\033[1;33m%s\033[0m\n' '=================================================================='
  printf '\033[1m  %s\033[0m\n\n' '三国杀·枪火乱世 · 官方联机服务器 / official online server'
  printf '\033[1;36m  游戏网址 Game:   %s\033[0m\n' "$game"
  printf '\033[1;36m  中继地址 Relay:  %s\033[0m\n\n' "$relay"
  printf '\033[1;32m  %s\033[0m\n' '↑ 把这两行发给 Claude  (send these two lines to Claude)'
  printf '\033[1;33m%s\033[0m\n\n' '=================================================================='
}

print_firewall_help() {
  warn "外网暂时打不开 https://$DOMAIN/ 。请到云服务器控制台 →「防火墙 / 安全组」放行 TCP 80 和 443，然后运行：
      curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/warlords/deploy/install.sh | sudo bash -s -- status
  The game is running, but https://$DOMAIN/ is not reachable from outside yet: allow TCP 80 and 443 in the
  provider's firewall / security group, then run the status command above."
}

# ── commands ────────────────────────────────────────────────────────────────
cmd_install() {
  detect_pkg
  install_base
  resolve_domain
  ensure_swap
  install_node
  fetch_source
  build_game
  install_service
  install_caddy
  open_firewall
  configure_caddy
  save_state
  if wait_https; then
    log "外网 HTTPS 正常 / HTTPS reachable"
  else
    print_firewall_help
  fi
  print_summary
}

cmd_update() {
  [[ -f $STATE_FILE || -d $APP_DIR ]] || die "尚未安装，请先运行不带参数的安装命令 / not installed yet — run the installer without arguments first"
  detect_pkg
  resolve_domain
  install_node
  fetch_source
  build_game
  install_service
  if command -v caddy >/dev/null 2>&1; then configure_caddy; fi
  save_state
  log "已更新到最新版本 / updated to the latest version"
  print_summary
}

cmd_status() {
  load_state
  local ok=1 stats
  if systemctl is-active -q "$SERVICE"; then log "游戏服务 sgwl: 运行中 / running"; else
    warn "游戏服务 sgwl 未运行 / not running"
    ok=0
  fi
  if systemctl is-active -q caddy; then log "Caddy (HTTPS): 运行中 / running"; else
    warn "Caddy 未运行 / not running"
    ok=0
  fi
  stats=$(curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/sgwl.json" 2>/dev/null || true)
  if [[ -n $stats ]]; then log "本机 / local: $stats"; else
    warn "本机 127.0.0.1:${APP_PORT} 无响应 / no answer"
    ok=0
  fi
  if [[ -z ${DOMAIN:-} ]]; then
    warn "未找到安装记录 $STATE_FILE / no install record"
    return 1
  fi
  if https_ok "$DOMAIN"; then log "外网 / public: https://$DOMAIN/ 正常 / OK"; else
    print_firewall_help
    ok=0
  fi
  print_summary
  ((ok == 1))
}

on_error() {
  warn "第 $1 行出错。请把本窗口最后 30 行（或 $LOG_FILE）发给 Claude。/ Failed at line $1 — send the last 30 lines (or $LOG_FILE) to Claude."
}

main() {
  local cmd=${1:-install}
  # the script itself may be arriving on stdin (curl | bash): nothing below may read it
  exec </dev/null
  [[ $EUID -eq 0 ]] || die "请用 root 运行（命令前加 sudo）/ run as root (prefix the command with sudo)"
  command -v systemctl >/dev/null 2>&1 || die "需要 systemd / systemd is required"
  mkdir -p "$(dirname "$LOG_FILE")"
  exec > >(tee -a "$LOG_FILE") 2>&1
  trap 'on_error $LINENO' ERR
  log "$(date '+%F %T') sgwl install.sh ${cmd}"
  case $cmd in
    install) cmd_install ;;
    update) cmd_update ;;
    status) cmd_status || exit 1 ;;
    *) die "用法 / usage: install.sh [install|update|status]" ;;
  esac
}

if [[ ${SGWL_LIB:-0} != 1 ]]; then
  main "$@"
fi
