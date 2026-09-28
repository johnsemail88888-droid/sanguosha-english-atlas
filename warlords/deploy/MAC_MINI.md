# 在 Mac mini 上部署官方联机服务器（给 Claude Code 的执行手册）

> **给 Mac mini 上的 Claude Code**：你在这台 Mac 上替主人把《三国杀·枪火乱世》的官方联机服务器装好并验证。先把整份手册读完，再按顺序做。标着「👤 主人」的步骤你做不了（要点界面、登录、输入密码），把原话转告主人，等他说「好了」再继续。每完成一步用一句话告诉主人进度。
>
> For Claude Code on the Mac mini: install and verify the game's official online server on this Mac. Read this whole file first, then follow the steps in order. Steps marked 👤 need the owner (GUI clicks, logins, passwords): tell them exactly what to do and wait.

**怎么拿到这份手册**（主人对 Mac 上的 Claude Code 说的话）：

> 用 Bash 运行 `curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/MAC_MINI.md`，完整读一遍输出，然后照着把游戏服务器部署到这台 Mac 上。

- 不要 `git clone` 这个仓库：没装 Xcode 命令行工具的 Mac 上，`git` 会弹出安装窗口卡住；安装脚本会自己下载游戏。
- 不要用 WebFetch 读：它返回的是摘要，会丢命令细节。

装好以后：

- 公网地址 `https://<机器名>.<tailnet>.ts.net/`（Tailscale Funnel：不用在路由器上开端口，不暴露家里的 IP）。
- 服务器 `~/sanguo-warlords/src/warlords/server/server.mjs` 监听 `127.0.0.1:8787`，由 launchd 常驻：崩溃自动重启，**登录后**自动启动（Mac 重启后靠第 4 步的自动登录），运行时阻止 Mac 睡眠。
- 每天 05:07 自动更新到 GitHub `main` 的最新版（有人在玩就跳过）。
- 「服务器托管对局」（headless）：对局在这台 Mac 上运行，而不是在房主的浏览器里——谁都看不到别人的隐藏身份（房主也看不到），房主离开也不散场。
  - **已经装过的 Mac 第一次拿到这个功能时，要用第 3 步那条命令（新下载的脚本）跑一次 `update`**（见「日常运维」的「马上更新」）。只等 05:07 的自动更新的话，第一次用的是本机旧的脚本副本，它不会构建托管对局，要到第二个没人玩的早上才开启。
  - 更新完用 `curl -s http://127.0.0.1:8787/sgwl.json` 确认有 `"headless":true`。

## 规则（必须遵守）

1. **不要用 sudo 运行安装脚本**，也不要以 root 运行。它必须以当前登录用户运行，因为 LaunchAgent 装在这个用户下。
2. 需要 `sudo`、「系统设置」或 Tailscale 网页后台的操作，一律交给 👤 主人。你的 Bash 输入不了密码。
3. 不要在路由器上做端口转发，不要关 macOS 防火墙。
4. 不要手改 `~/sanguo-warlords/src` 里的文件，更新会覆盖。要改就改 GitHub 上的仓库。
5. **这台 Mac 的任何账户里都不要开游戏桌面版（SanguoWarlords.app）**：它会占用 8787 端口。
6. 安装要 5–25 分钟（下载 Node、`npm ci`、构建）。**用 Bash 的 `run_in_background` 运行**，结束时你会收到通知，期间看日志。不要用前台命令死等，前台默认 2 分钟就会超时。
7. **同一时间只能有一个安装或更新在跑。** 重跑前确认上一个后台任务已经结束，并且 `pgrep -fl '[h]ome-host'` 没有输出（05:07 的自动更新也算）。
8. **安装、更新、重跑都会重启游戏服务**，正在玩的人会全部掉线。每次运行前先 `curl -s --max-time 2 http://127.0.0.1:8787/sgwl.json; echo`，满足下面任意一条就是有人在玩，先问主人：
   - `headlessHumans` 大于 0，或 `headlessPlaying` 大于 0（服务器托管的对局正在进行）；
   - `rooms` 大于 `headlessRooms`，或 `players` 大于 `headlessRooms`（没有 `headlessRooms` 字段时按 0 算）。

   每个空着的托管房间本身会占 1 个 `rooms` 和 1 个 `players`（那是服务器自己，不是玩家）；没人的托管房间 10 秒到 2 分钟内会自己关掉。
9. Tailscale 的命令行在 App Store 版里**不在 PATH 上**，一律用全路径：`/Applications/Tailscale.app/Contents/MacOS/Tailscale`（下文简写为 `$TS`，可以先 `TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale`）。

---

## 第 0 步：决定用哪个账户（👤 主人）

服务装在**当前登录的 macOS 用户**下，以后换账户就得在新账户里重装。推荐（不强制）：

- 在「系统设置 → 用户与群组」新建一个**非管理员**账户（例如 `sgwl`），只用来跑游戏服务器，不放个人资料；
- 用它**在 Mac 的桌面上登录**（或用屏幕共享），在这个账户的「终端」里运行 Claude Code，再做下面的步骤。**不要通过 SSH 运行**：launchd 的用户服务需要图形登录会话。

主人想用现在的账户也可以，直接继续。

## 第 1 步：检查（你来做，只读）

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
sw_vers; uname -m                                   # macOS 版本；arm64 = Apple 芯片
whoami; id -Gn | tr ' ' '\n' | grep -qx admin && echo 管理员账户 || echo 非管理员账户
launchctl print gui/$(id -u) >/dev/null 2>&1 && echo GUI-OK || echo "不在图形登录会话（SSH？）"
df -h ~ | tail -1                                   # 至少 3 GB 可用
route -n get default 2>/dev/null | grep interface   # 默认出口网卡
networksetup -listallhardwareports                  # 对照上一行：Wi-Fi 还是 Ethernet
pmset -g | grep -E ' sleep|autorestart|womp|disksleep'
lsof -nP -iTCP:8787 -sTCP:LISTEN                    # 本账户里谁占着 8787
curl -s --max-time 2 http://127.0.0.1:8787/sgwl.json; echo   # 别的账户里的游戏服务也能看到
ls -d /Applications/Tailscale.app 2>/dev/null && "$TS" status | head -5
"$TS" status --json 2>/dev/null | grep -m1 '"DNSName"'       # 本机现在的 Tailscale 名字
```

判断：

| 看到 | 处理 |
|---|---|
| 「不在图形登录会话」 | 👤 请主人在 Mac 桌面（或屏幕共享）上打开「终端」，在那里运行 Claude Code，从头再来。 |
| 默认网卡是 Wi-Fi | 建议 👤 主人插网线，延迟更稳。不插也能装，继续。 |
| 8787 有进程，`lsof` 的 COMMAND 是 `SanguoWarlords` / `Electron` | 👤 请主人退出游戏桌面版（所有账户里的都要退），然后再检查一次。 |
| `sgwl.json` 有回应，`lsof` 却看不到进程 | 另一个账户里开着桌面版或另一份服务器：👤 请主人去那个账户退出它。 |
| 8787 的 COMMAND 是 `node`，并且 `ps -o command= -p <PID>` 显示 `…/sanguo-warlords/src/warlords/server/server.mjs` | 已经装过了：先跑第 5 步的 `status`。全部正常就跳到第 4 步，否则（在没人玩的时候）重跑第 3 步。 |
| 没有 `/Applications/Tailscale.app` | 👤 请主人从 Mac App Store 安装 **Tailscale**（或者 https://tailscale.com/download 的独立版）。 |
| `status` 报错 / `Logged out` / `NeedsLogin` | 👤 请主人在**当前这个账户**里打开「应用程序 → Tailscale」，点菜单栏图标 → **Log in**。第一次会弹出「添加 VPN 配置」，点**允许**并输入密码。主人说好了以后，你再跑一次 `"$TS" status`，确认已经不是 `Logged out`。 |

## 第 2 步：Tailscale 设置（👤 主人，浏览器里，约 3 分钟）

请主人在 https://login.tailscale.com/admin 完成：

1. **DNS** 页（https://login.tailscale.com/admin/dns ）：打开 **HTTPS Certificates**（没开的话）。
2. **Machines** 页：找到这台 Mac → 右侧「…」→ **Disable key expiry**。不做的话，默认 180 天后这台机器掉线，公网地址会悄悄失效。
3. **建议改名**：同一个「…」→ **Edit machine name**，改成短名（例如 `sanguo`）。默认名常带主人的名字（例如 `zhangsans-mac-mini`），而它会出现在公网网址里、发给每个玩家，还会永久写进公开的证书透明日志。**必须在第 3 步安装前改**：装好以后再改，要重新安装，旧链接也会失效。改完你再跑一次第 1 步最后那条命令，确认新名字。

再请主人在 Mac 上处理 Tailscale 的两项设置：

4. 菜单栏 Tailscale 图标 → Settings：打开 **Launch at login**（登录时启动）。
5. **自动更新**：Tailscale 更新时会断网几秒，正在进行的对局会全部掉线。
   - **官网下载的独立版**：Tailscale → Settings 里有 **Automatically install updates**，关掉它。以后每月找个没人玩的时候手动更新。
   - **App Store 版**：它自己没有这个开关，更新由「App Store → 设置 → 自动更新」控制。那是全局开关，会影响所有 App Store 应用，关不关由主人决定。

Funnel 的授权第 3 步会处理：需要的时候，安装脚本会打印一个 `login.tailscale.com` 链接。

## 第 3 步：安装（你来做）

先确认规则 7、8（没有别的安装在跑，没人在玩）。然后用 **`run_in_background`** 运行（不要加 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/home-host.sh -o /tmp/sgwl-home-host.sh && caffeinate -i bash /tmp/sgwl-home-host.sh; echo "SGWL_EXIT=$?"
```

（`caffeinate -i` 防止安装过程中 Mac 睡着。）

运行期间，每 1 分钟左右看一次后台任务的输出，或者看日志（去掉颜色码）：

```bash
tail -n 40 ~/sanguo-warlords/home-host.log | perl -pe 's/\e\[[0-9;]*m//g'
```

日志是追加写入的，只看最后一个 `sgwl home-host.sh install` 标题行之后的内容。如果 `home-host.log` 还不存在（脚本一开始下载 `install.sh` 就失败了），就看后台任务自己的输出。

脚本会自己完成这些：
- 安装 Node 22：已有 Node ≥22 就直接用；否则用 Homebrew；Homebrew 不可用或装不上（例如非管理员账户）时，装到 `~/sanguo-warlords/node`。
- 把游戏下载到 `~/sanguo-warlords/src` 并构建。
- 注册 launchd 服务，开启 Funnel，从公网验证。

**运行中途**可能出现：

| 输出里出现 | 处理 |
|---|---|
| 一个 `https://login.tailscale.com/...` 链接（脚本停在这里等，最多 15 分钟） | **立刻**把链接原样发给 👤 主人：用浏览器打开 → 点 **Enable**。**不要重新运行**：主人点完，脚本会自己继续，下一行会是 `Funnel: https://… → 127.0.0.1:8787`。 |

**结束后**，按退出码判断：

| 结果 | 含义 | 处理 |
|---|---|---|
| `SGWL_EXIT=0`，并且有 `朋友可以访问了 / reachable from the internet` | 成功 | 记下框里的两行（游戏网址、中继地址），进入第 4 步。 |
| `SGWL_EXIT=0`，但有 `[!] 公网暂时还访问不到 https://…` | 服务和 Funnel 已装好，只是公网 DNS 还没生效 | 进入第 4 步；第 5 步的 `status` 会再验证公网。 |
| `SGWL_EXIT=2`（最后一段是黄字说明） | 需要主人操作 | 看下表，主人做完后，重跑同一条命令。 |
| 其他非 0（`[x] …` 或 `[!] 第 N 行出错`） | 出错 | 看下表；表里没有的，把本次输出的最后 30 行原样给主人，请他转给云端的 Claude。 |

注意：**那个框（游戏网址 / 中继地址）失败时也会打印**，框后面还有几行「让这台 Mac 一直在线」的提示，所以不能只凭框判断成功。

| 退出时的说明 | 处理 |
|---|---|
| `Funnel 还没有开启…`（等了 15 分钟没人点 Enable） | 👤 请主人打开刚才的链接点 **Enable**，并确认第 2 步的 HTTPS Certificates 已开，然后重跑。 |
| `Tailscale 没有连接（状态 …）` | 👤 同第 1 步的登录处理，然后重跑。 |
| `[x] 端口 8787 已被另一个游戏服务占用…` | 某个已登录账户里开着桌面版（本账户的 `lsof` 看不到）：👤 请主人在所有账户里退出 SanguoWarlords.app，然后重跑。 |
| `[x] 游戏服务没有启动`（上面是 server.log 的最后 30 行） | 有 `EADDRINUSE`：8787 被别的程序占着，请主人退出它。否则把这 30 行原样给主人，请他转给云端 Claude。 |
| `请不要加 sudo` | 你加了 sudo：去掉以后重跑。 |
| Node / npm 下载失败、超时 | 网络问题：等一分钟重跑，已下载的部分会复用。 |

## 第 4 步：让 Mac 永远在线（👤 主人，要输入密码）

请主人**另开一个「终端」窗口**（不是 Claude Code 里）运行下面这条，并输入密码：

```bash
sudo pmset -a sleep 0 disksleep 0 womp 1 powernap 0 autorestart 1
```

- 如果当前是**非管理员账户**，sudo 会报 `is not in the sudoers file`。这时先运行 `su 管理员账户的短名`，输入那个管理员的密码，再运行上面那条。pmset 是整机设置，在哪个账户里运行都一样。

再请主人在「系统设置」里：

- **能源**（Energy）：打开「显示器关闭时防止自动进入睡眠」和「断电后自动启动」（如果有这两项）。
- **用户与群组 → 自动登录**：选这台服务器用的账户。服务是 LaunchAgent，Mac 重启后要有人登录才会启动，自动登录解决这个问题。
  - **FileVault 开着时不能自动登录**，断电重启后会停在解锁密码界面。要不要为此关掉 FileVault，由主人决定。专用的非管理员账户、没有个人资料时，关掉的风险很小。
- 可选：拔一次电源再插上，确认 Mac 能自己开机、自动登录，并且 5 分钟内游戏网址的 `/sgwl.json` 能打开。FileVault 开着时这个测试必然失败。

然后你检查一遍，并把结果写进第 6 步的汇报：

```bash
pmset -g | grep -E ' sleep|autorestart'
fdesetup status
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo 自动登录未开启
```

期望看到 `sleep 0` 和 `autorestart 1`。

## 第 5 步：验证（你来做）

`status` 在公网还不通时会重试 12 次（每次间隔 10 秒），可能要 2–9 分钟。这条 Bash 调用要加 `timeout: 600000`，或者放后台运行。

```bash
bash ~/sanguo-warlords/bin/home-host.sh status; echo "exit=$?"
```

```bash
curl -s --max-time 2 http://127.0.0.1:8787/sgwl.json; echo
D=$(sed -n 's/^DOMAIN=//p' ~/sanguo-warlords/host.env); N="$(sed -n 's/^NODE_BIN_DIR=//p' ~/sanguo-warlords/host.env)/node"
echo "$D"; "$N" ~/sanguo-warlords/src/warlords/deploy/check.mjs "https://$D/" --public-dns; echo "exit=$?"
```

期望看到：

- `status` 的 `exit=0`。输出里有服务运行中、`Funnel: https://… → http://127.0.0.1:8787`、`公网 / internet: 正常 / OK`，最后打印那两行。
- `sgwl.json` 里有 `"app":"sanguo-warlords"` 和 `"headless":true`（「服务器托管对局」已启用）。如果是 `"headless":false`：`grep -n 服务器托管对局 ~/sanguo-warlords/home-host.log | tail -3` 看构建有没有失败；刚从旧版本更新上来的，用第 3 步的命令再跑一次 `update`（见「日常运维」）。`false` 时游戏照样能玩，只是房间在房主的浏览器里运行。
- `check.mjs` 的 `exit=0`（两项检查都通过）。

最后请 👤 主人**用手机、关掉 Wi-Fi、用蜂窝网络**打开游戏网址：能进标题页，点「联机」→「创建房间」能拿到房间码，就说明外网的朋友也能进。

## 第 6 步：汇报

用中文告诉主人：

1. 游戏网址和中继地址（框里那两行），并提醒他把这两行**发给云端的 Claude**（开发这个游戏的那个会话）。它会把这个地址设成网页版和桌面版的默认服务器。
2. 还没做完的项，例如：没插网线、FileVault 还开着或没开自动登录、没 Disable key expiry、Tailscale 自动更新还开着、机器名还是默认的。
3. 下面的日常用法。

「访问密钥」功能上线之前，**只把链接私下发给朋友**，不要发到公开的地方。

---

## 日常运维（以后也按这个来）

所有命令都用 `bash` 调用（本机那份脚本副本可能没有执行权限）。更新前先按规则 8 确认没人在玩。

| 要做的事 | 命令 |
|---|---|
| 看状态（顺便重新打印那两行；公网不通时要跑几分钟，加长超时） | `bash ~/sanguo-warlords/bin/home-host.sh status` |
| 马上更新到最新版，不等 05:07（会重启服务；放后台运行）。用新下载的脚本：本机 `bin/` 里的副本可能是旧的 | `curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/home-host.sh -o /tmp/sgwl-home-host.sh && caffeinate -i bash /tmp/sgwl-home-host.sh update; echo "SGWL_EXIT=$?"` |
| 停止当服务器（服务、自动更新、Funnel 全关） | `bash ~/sanguo-warlords/bin/home-host.sh stop` |
| 重新开始当服务器 | 重跑第 3 步 |
| 服务器日志 | `tail -n 100 ~/sanguo-warlords/server.log` |
| 自动更新日志 | `tail -n 50 ~/sanguo-warlords/update.log` |
| 安装/更新脚本日志 | `tail -n 50 ~/sanguo-warlords/home-host.log \| perl -pe 's/\e\[[0-9;]*m//g'` |
| 现在有没有人在玩 | `curl -s http://127.0.0.1:8787/sgwl.json`，按规则 8 判断（`headlessHumans`、`headlessPlaying`，以及 `rooms` / `players` 和 `headlessRooms` 比） |
| Funnel 指向哪里 | `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status` |

注意：表格里的 `\|` 是 Markdown 转义，实际命令里是普通的 `|`。

launchd 服务状态：

```bash
launchctl print "gui/$(id -u)/com.sanguo-warlords.server" | grep -E 'state =|pid ='
```

日志超过 5 MB 会自动轮转。

## 故障排查

| 现象 | 先查 | 处理 |
|---|---|---|
| 朋友打不开网址 | `status`；`$TS funnel status` | Funnel 没指向 8787：重跑第 3 步。Tailscale 掉线：👤 主人点菜单栏重新连接。机器 key 过期：👤 主人在后台 Disable key expiry 并重新登录。 |
| 网址能打开，但创建房间失败或连不上 | `curl -s http://127.0.0.1:8787/sgwl.json`；`tail -n 50 ~/sanguo-warlords/server.log` | 本机没响应：`launchctl kickstart -k "gui/$(id -u)/com.sanguo-warlords.server"`，30 秒后再查。 |
| 本机 8787 没响应，launchd 显示没在运行 | `tail -n 50 ~/sanguo-warlords/server.log` | `EADDRINUSE`（桌面版开着？）：👤 请主人退出它。否则重跑第 3 步。 |
| 更新后起不来 | `tail -n 80 ~/sanguo-warlords/home-host.log` | 把错误原文给主人，请他转给云端 Claude。临时恢复：重跑第 3 步。 |
| Mac 重启后服务没起来 | 这个账户有没有登录 | 👤 主人登录一次，或者开启自动登录（第 4 步）。 |
| 延迟高、卡顿 | 是不是 Wi-Fi；家里有没有人在大量上传 | 插网线；玩的时候避开大文件上传。游戏里按 Tab 能看到每个人的 ping。 |

## 附：装了些什么

| 位置 | 内容 |
|---|---|
| `~/sanguo-warlords/src/warlords` | 游戏源码和构建产物（`dist/` 是网页；`dist-headless/` 是服务器托管对局的房间程序，每个房间一个 worker 线程） |
| `~/sanguo-warlords/bin/home-host.sh` | 本机的脚本副本，自动更新用它 |
| `~/sanguo-warlords/host.env` | 安装状态（`DOMAIN`、`NODE_BIN_DIR`） |
| `~/sanguo-warlords/node` | 只在本机没有 Node ≥22 且 Homebrew 不可用或装不上时（例如非管理员账户）才有：私有的 Node 22 |
| `~/Library/LaunchAgents/com.sanguo-warlords.server.plist` | 游戏服务（KeepAlive，用 `caffeinate -is` 包着） |
| `~/Library/LaunchAgents/com.sanguo-warlords.update.plist` | 每天 05:07 的自动更新 |
| Tailscale Funnel | 公网 `https://<机器名>.<tailnet>.ts.net/` → `127.0.0.1:8787` |

完全卸载：

1. 运行 `bash ~/sanguo-warlords/bin/home-host.sh stop`。
2. 运行 `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status`，确认已经没有 Funnel。
3. 运行 `rm -rf ~/sanguo-warlords`。
4. 如果 `node@22` 是为这个服务器用 Homebrew 装的，运行 `brew uninstall node@22`。
5. 休眠、自动登录这些设置，由 👤 主人按需在「系统设置」里改回来。
