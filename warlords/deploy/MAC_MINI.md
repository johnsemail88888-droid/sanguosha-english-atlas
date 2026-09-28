# 在 Mac mini 上部署官方联机服务器（给 Claude Code 的执行手册）

> **给 Mac mini 上的 Claude Code**：你在这台 Mac 上替主人把《三国杀·枪火乱世》的官方联机服务器装好并验证。按顺序执行下面的步骤。标着「👤 主人」的步骤你做不了（要点界面、登录、输入开机密码），把原话转告主人，等他说「好了」再继续。每完成一步都用一句话告诉主人进度。
>
> For Claude Code on the Mac mini: set up and verify the game's official online server on this Mac. Follow the steps in order. Steps marked 👤 need the owner (GUI clicks, logins, the login password) — tell them exactly what to do and wait.

装好以后是这样：

- 公网地址 `https://<机器名>.<tailnet>.ts.net/`（Tailscale Funnel，不用在路由器上开端口，也不暴露家里的 IP）。
- 服务器 `~/sanguo-warlords/src/warlords/server/server.mjs` 监听 `127.0.0.1:8787`，由 launchd 常驻（崩溃自动重启，开机自动启动，运行时阻止睡眠）。
- 每天 05:07 自动更新到 GitHub `main` 的最新版（有人在玩就跳过）。
- 服务器支持「服务器托管对局」（headless）后，对局在这台 Mac 上运行，而不是房主的浏览器里：更公平、房主离开也不散场。这个功能随更新自动到来，不需要额外操作。

## 规则（必须遵守）

1. **不要用 sudo 运行安装脚本**，也不要以 root 身份执行它。它必须以当前登录用户运行（LaunchAgent 装在这个用户下）。
2. 需要 `sudo` 或「系统设置」的操作一律交给 👤 主人：你的 Bash 不能输入密码。
3. 不要在路由器上做端口转发，不要关闭 macOS 防火墙，不要改 Tailscale 的 ACL 以外的网络设置。
4. 不要手改 `~/sanguo-warlords/src` 里的文件（更新会覆盖）。要改就改 GitHub 上的仓库。
5. **这台 Mac 上不要运行游戏桌面版（SanguoWarlords.app）**：它会抢占 8787 端口，Funnel 就会指向桌面版自带的服务器。
6. 安装脚本要跑 3–10 分钟（下载 Node、`npm ci`、构建）。**用后台方式运行**（Bash 的 `run_in_background`），然后隔一会儿看 `~/sanguo-warlords/home-host.log`，不要用会超时的前台命令死等。

---

## 第 0 步：先决定用哪个账户（👤 主人）

服务装在**当前登录的 macOS 用户**下。以后换账户就得在新账户里重装。推荐（但不强制）：

- 在「系统设置 → 用户与群组」新建一个**非管理员**账户（例如 `sgwl`），只用来跑游戏服务器，不放个人资料；
- 用这个账户登录，在它里面打开终端运行 Claude Code，再做下面的步骤。

主人如果就想用现在的账户，也可以，直接继续。

## 第 1 步：检查（你来做，只读）

逐条运行，把结果汇总给主人：

```bash
sw_vers; uname -m                     # macOS 版本；arm64 = Apple 芯片
whoami                                # 不能是 root
df -h ~ | tail -1                     # 至少 3 GB 可用
route -n get default 2>/dev/null | grep interface   # 默认出口网卡
networksetup -listallhardwareports    # 对照上一行：是 Wi-Fi 还是 Ethernet
pmset -g | grep -E ' sleep|autorestart|womp|disksleep'
lsof -nP -iTCP:8787 -sTCP:LISTEN      # 8787 端口有没有被占用
ls /Applications/Tailscale.app 2>/dev/null && /Applications/Tailscale.app/Contents/MacOS/Tailscale status | head -5
```

判断：

| 看到 | 处理 |
|---|---|
| 默认网卡是 Wi-Fi | 建议 👤 主人插网线（延迟更稳）。不插也能装，继续。 |
| 8787 被占用，进程名像 `SanguoWarlords` / `Electron` | 👤 请主人退出游戏桌面版（菜单栏 → 退出），再检查一次。 |
| 8787 被占用，进程是 `node … server/server.mjs`，路径在 `~/sanguo-warlords` | 已经装过了：直接跳到第 4 步（或者用第 3 步的 `update`）。 |
| 没有 `/Applications/Tailscale.app`，`command -v tailscale` 也找不到 | 👤 请主人从 Mac App Store 安装 **Tailscale**（或 https://tailscale.com/download ），打开它，点菜单栏图标登录。 |
| Tailscale 显示 `Logged out` / `NeedsLogin` / 没有连接 | 👤 请主人点菜单栏的 Tailscale 图标 → Log in / Connect。 |

## 第 2 步：Tailscale 设置（👤 主人，在浏览器里，约 3 分钟）

请主人在 https://login.tailscale.com/admin 完成：

1. **DNS** 页（https://login.tailscale.com/admin/dns ）：打开 **HTTPS Certificates**（没开的话）。
2. **Machines** 页：找到这台 Mac → 右侧「…」→ **Disable key expiry**。否则默认 180 天后这台机器掉线，公网地址会悄悄失效。
3. 可选：同一个「…」里 **Edit machine name**，起个短名字（例如 `sanguo`）。公网地址会变成 `https://sanguo.<tailnet>.ts.net/`。**要改就在安装前改**，装好后再改就要重新运行安装命令，发出去的旧链接也会失效。

再请主人在 Mac 上：Tailscale 菜单栏图标 → Settings：

4. 打开 **Launch at login**（开机自动启动）。
5. **关闭自动更新**（Automatically install updates）。Tailscale 更新时会断网几秒，正在进行的对局会全部掉线。以后每月找个没人玩的时候手动更新。

Funnel 的授权（ACL 里的 `funnel` 属性）第 3 步会自动处理：如果需要，脚本会打印一个 `login.tailscale.com` 链接。

## 第 3 步：安装（你来做）

后台运行（不要加 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/home-host.sh | bash
```

然后每 30–60 秒看一次进度：

```bash
tail -n 30 ~/sanguo-warlords/home-host.log
```

脚本会自己安装 Node 22（有 Homebrew 用 Homebrew，否则装到 `~/sanguo-warlords/node`），把游戏下载到 `~/sanguo-warlords/src`，构建，注册 launchd 服务，开启 Funnel，并从公网验证。**同一条命令可以放心重复运行**，每一步都会先检查是否已经做过。

可能遇到的中途停止（脚本会打印原因，然后退出）：

| 日志里出现 | 处理 |
|---|---|
| 一个 `https://login.tailscale.com/...` 链接，然后「Funnel 还没有开启」 | 把链接原样发给 👤 主人：用浏览器打开 → 点 **Enable**。主人说好了之后，**重新运行同一条安装命令**。 |
| 「Tailscale 没有连接（状态 …）」 | 👤 主人点菜单栏 Tailscale → Log in / Connect，然后重新运行。 |
| 「请不要加 sudo」 | 你加了 sudo：去掉后重新运行。 |
| Node / npm 下载失败、超时 | 网络问题：等一分钟重新运行同一条命令（已下载的部分会复用）。 |
| 「外网暂时打不开」/ 公网检查失败 | Funnel 的公网 DNS 刚生效时可能要等几分钟。5 分钟后运行第 5 步的 `status`。 |

成功时，日志末尾有一个框：

```
  游戏网址 Game:   https://<机器名>.<tailnet>.ts.net/
  中继地址 Relay:  wss://<机器名>.<tailnet>.ts.net/ws
  ↑ 把这两行发给 Claude
```

记下这两行。

## 第 4 步：让 Mac 永远在线（👤 主人，要输入开机密码）

请主人**另开一个「终端」窗口**（不是 Claude Code 里）运行下面这条，输入开机密码：

```bash
sudo pmset -a sleep 0 disksleep 0 womp 1 powernap 0 autorestart 1
```

再请主人在「系统设置」里确认：

- **能源**（Energy）：打开「显示器关闭时防止自动进入睡眠」和「断电后自动启动」（如果有这两项）。
- **用户与群组 → 自动登录**：选这台服务器用的账户。服务是 LaunchAgent，Mac 重启后要有人登录才会启动，自动登录解决这个问题。**macOS 开着 FileVault 时不能自动登录**。是否为此关闭 FileVault，由主人自己决定：专用的非管理员账户、没有个人资料时，关闭的风险很小。
- 可选：拔一次电源再插上，确认 Mac 能自己开机，5 分钟内 `https://<机器名>…/sgwl.json` 能打开。

然后你运行 `pmset -g | grep -E ' sleep|autorestart'` 确认：`sleep 0`、`autorestart 1`。

## 第 5 步：验证（你来做）

```bash
~/sanguo-warlords/bin/home-host.sh status
curl -s http://127.0.0.1:8787/sgwl.json; echo
node ~/sanguo-warlords/src/warlords/deploy/check.mjs https://<机器名>.<tailnet>.ts.net/ --public-dns
```

- `status` 应该显示：服务运行中、`Funnel: https://… → 127.0.0.1:8787`、「公网 / internet: 正常 / OK」，最后打印那两行。
- `sgwl.json` 里有 `"app":"sanguo-warlords"`。出现 `"headless":true` 就说明「服务器托管对局」已经启用（这个功能合并到 `main` 之前不会出现，属于正常情况）。
- `check.mjs` 两项检查都通过（exit 0）。

最后请 👤 主人**用手机、关掉 Wi-Fi 用蜂窝网络**打开游戏网址：能进标题页，点「联机」→「创建房间」能拿到房间码，就说明外网朋友也能进。

## 第 6 步：汇报

用中文告诉主人：

1. 游戏网址和中继地址（第 3 步那两行），并提醒他把这两行**发给云端的 Claude**（开发这个游戏的那个会话），它会把这个地址设成网页版和桌面版的默认服务器。
2. 哪些步骤还没做（比如没插网线、没开自动登录、没关 Tailscale 自动更新、没 Disable key expiry）。
3. 日常用法（下一节）。

在「访问密钥」功能上线之前，**只把链接私下发给朋友**，不要发到公开的地方。

---

## 日常运维（你以后也按这个来）

| 要做的事 | 命令 |
|---|---|
| 看状态（顺便重新打印那两行） | `~/sanguo-warlords/bin/home-host.sh status` |
| 马上更新到最新版（不等 05:07；**有人在玩时别运行**，会重启服务） | `~/sanguo-warlords/bin/home-host.sh update`（后台运行，看 `home-host.log`） |
| 停止当服务器（服务、自动更新、Funnel 全关） | `~/sanguo-warlords/bin/home-host.sh stop` |
| 重新开始当服务器 | 再运行第 3 步的安装命令 |
| 服务器日志 | `tail -n 100 ~/sanguo-warlords/server.log` |
| 自动更新日志 | `tail -n 50 ~/sanguo-warlords/update.log` |
| 安装/更新脚本日志 | `tail -n 50 ~/sanguo-warlords/home-host.log` |
| 现在有没有人在玩 | `curl -s http://127.0.0.1:8787/sgwl.json`（看 `rooms` / `players`，有 headless 后还有 `headlessHumans`） |
| 服务状态（launchd） | `launchctl print gui/$UID/com.sanguo-warlords.server \| grep -E 'state\|pid'` |

日志超过 5 MB 会自动轮转。

## 故障排查

| 现象 | 先查 | 处理 |
|---|---|---|
| 朋友打不开网址 | `status`；`tailscale funnel status` | Funnel 没指向 8787 → 重新运行安装命令。Tailscale 掉线 → 👤 主人点菜单栏重新连接。机器 key 过期 → 👤 主人在后台 Disable key expiry 并重新登录。 |
| 网址能开，创建房间失败/连不上 | `curl -s http://127.0.0.1:8787/sgwl.json`；`tail server.log` | 本机没响应 → `launchctl kickstart -k gui/$UID/com.sanguo-warlords.server`，30 秒后再查。 |
| 本机 8787 没响应，launchd 显示不在运行 | `tail -n 50 ~/sanguo-warlords/server.log` | 端口被占（桌面版？）→ 👤 退出桌面版。否则重新运行安装命令。 |
| 更新后起不来 | `tail -n 80 ~/sanguo-warlords/home-host.log` | 把错误原文发给主人，让他转给云端 Claude。临时恢复：重新运行安装命令。 |
| Mac 重启后服务没起来 | 有没有登录这个用户 | 👤 主人登录一次，或开启自动登录（第 4 步）。 |
| 延迟高 / 卡顿 | 是否 Wi-Fi；家里是否有人在大量上传 | 插网线；同一时间避免大文件上传。游戏里按 Tab 可以看每个人的 ping。 |

## 附：装了些什么

| 位置 | 内容 |
|---|---|
| `~/sanguo-warlords/src/warlords` | 游戏源码与构建产物（`dist/` 网页，`dist-headless/` 服务器托管对局，以后会有） |
| `~/sanguo-warlords/bin/home-host.sh` | 本机脚本副本（自动更新用它） |
| `~/sanguo-warlords/host.env` | 安装状态（域名、Node 路径） |
| `~/sanguo-warlords/node` | 仅当没有 Homebrew 时：私有的 Node 22 |
| `~/Library/LaunchAgents/com.sanguo-warlords.server.plist` | 游戏服务（KeepAlive，`caffeinate -is` 包裹） |
| `~/Library/LaunchAgents/com.sanguo-warlords.update.plist` | 每天 05:07 的自动更新 |
| Tailscale Funnel | 公网 `https://<机器名>.<tailnet>.ts.net/` → `127.0.0.1:8787` |

完全卸载：`~/sanguo-warlords/bin/home-host.sh stop`，然后 `rm -rf ~/sanguo-warlords`。
