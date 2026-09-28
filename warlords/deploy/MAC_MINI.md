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
- **访问密钥**：机器名是公开的（写进了公开的证书透明日志），所以服务器要求密钥。安装时自动生成一次，存在 `~/sanguo-warlords/host.env`（只有本账户能读）。朋友要用**分享链接** `https://<机器名>.<tailnet>.ts.net/?k=<密钥>` 进入——安装、`update`、`status` 结束时的框里第一行就是它。不带密钥的网址能打开页面，但进不了联机（页面会提示「需要房主发的邀请链接（带密钥）」）。链接传出去了就运行 `rotate-key` 换一个（见「日常运维」）。
  - 分享链接**只出现在脚本的屏幕输出里**（你在 Bash 里看到的输出）；日志文件 `home-host.log` 里同一行写成 `?k=<key>`，所以日志可以放心转给别人。
  - 朋友用分享链接打开一次，密钥就记在他的浏览器里（地址栏里的 `?k=…` 会自己消失）。游戏大厅里显示的邀请链接把密钥遮成 `k=••••`，点「复制」/「分享」拿到的是完整链接；带密钥的邀请链接总是指向这台 Mac 的网址（即使房主是从 GitHub Pages 网页版开的房），密钥不会被发到别的网站。
  - 朋友的浏览器已经有一个能用的密钥时，打开一个带**别的**密钥的链接（旧链接、写错的链接），页面会先问服务器：新密钥对才换，不对就保留原来那个。
- 服务器 `~/sanguo-warlords/src/warlords/server/server.mjs` 监听 `127.0.0.1:8787`，由 launchd 常驻：崩溃自动重启，**登录后**自动启动（Mac 重启后靠第 4 步的自动登录），运行时阻止 Mac 睡眠。
- **每 5 分钟**检查一次更新：GitHub `main` 有新提交、**并且 GitHub 上它的 warlords-ci 通过了**、并且没人在玩，才更新并重启；否则什么都不做（原因每小时最多记一行到 `update.log`）。网页版（GitHub Pages）每次推送都会更新，这样 Mac 最多晚几分钟跟上，「服务器托管对局」不会因为版本不一致长时间退回浏览器托管。
- 「服务器托管对局」（headless）：对局在这台 Mac 上运行，而不是在房主的浏览器里——谁都看不到别人的隐藏身份（房主也看不到），房主离开也不散场。
- **已经装过的 Mac（装的是还没有访问密钥的旧版本）要用第 3 步那条命令（新下载的脚本）跑一次 `update`**（见「日常运维」的「马上更新」）。
  - 不跑的话：旧版本每天 05:07 的自动更新会自己把游戏换成新版本（之后仍然每天 05:07 一次，但只更新到 CI 通过的版本），**但不会开启访问密钥**——服务器一直谁都能连，也不会改成每 5 分钟一次。新版本的自动更新会每小时在 `update.log` / `home-host.log` 里记一行、并在 Mac 屏幕上弹一条通知：「访问密钥未开启：运行 update 生成分享链接」。
  - 这次 `update` 会：生成密钥（存进 `host.env`）；重写游戏服务的 LaunchAgent（带 `RELAY_KEY`、`NO_PEER=1`、`MAX_ROOMS=4`、`HOST_GRACE_MS=120000`）；把自动更新改成每 5 分钟一次；最后在屏幕上打印分享链接。
  - 更新完用 `curl -s http://127.0.0.1:8787/sgwl.json` 确认有 `"keyRequired":true` 和 `"headless":true`。
  - 这之后朋友以前的网址（不带 `k=`）不能联机了：把新的分享链接发给他们。

## 规则（必须遵守）

1. **不要用 sudo 运行安装脚本**，也不要以 root 运行。它必须以当前登录用户运行，因为 LaunchAgent 装在这个用户下。
2. 需要 `sudo`、「系统设置」或 Tailscale 网页后台的操作，一律交给 👤 主人。你的 Bash 输入不了密码。
3. 不要在路由器上做端口转发，不要关 macOS 防火墙。
4. 不要手改 `~/sanguo-warlords/src` 里的文件，更新会覆盖。要改就改 GitHub 上的仓库。
5. **这台 Mac 的任何账户里都不要开游戏桌面版（SanguoWarlords.app）**：它会占用 8787 端口。
6. 安装要 5–25 分钟（下载 Node、`npm ci`、构建）。**用 Bash 的 `run_in_background` 运行**，结束时你会收到通知，期间看日志。不要用前台命令死等，前台默认 2 分钟就会超时。
7. **同一时间只能有一个安装或更新在跑。** 重跑前确认上一个后台任务已经结束。每 5 分钟的自动更新也算：脚本之间用锁 `~/sanguo-warlords/.update.lock` 互相等待（安装/更新会等正在构建的自动更新结束，最多 45 分钟，输出里会说「另一个安装/更新正在进行」），所以你不用手动停它；但不要同时开两个你自己的安装。`pgrep -fl '[h]ome-host'` 能看到正在跑的。
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
2. **Machines** 页：找到这台 Mac → 右侧「…」→ **Disable key expiry**。不做的话，默认 180 天后这台机器掉线，公网地址会悄悄失效。（没关的话，安装和 `status` 会打印一行黄字「Tailscale 密钥会在 … 过期」提醒。）
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
- 第一次安装时生成访问密钥（以后一直沿用，存在 `~/sanguo-warlords/host.env`）。
- 把游戏下载到 `~/sanguo-warlords/src` 并构建（网页文件预压缩成 `.br` / `.gz`；上一版的脚本文件保留 3 天，开着旧页面的人不会在开局时报错）。
- 注册 launchd 服务（环境变量里带密钥，plist 只有本账户能读），开启 Funnel，带密钥从公网验证，并确认不带密钥的连接会被拒绝。
- 注册每 5 分钟一次的自动更新。

**运行中途**可能出现：

| 输出里出现 | 处理 |
|---|---|
| 一个 `https://login.tailscale.com/...` 链接（脚本停在这里等，最多 15 分钟） | **立刻**把链接原样发给 👤 主人：用浏览器打开 → 点 **Enable**。**不要重新运行**：主人点完，脚本会自己继续，下一行会是 `Funnel: https://… → 127.0.0.1:8787`。 |

**结束后**，按退出码判断：

| 结果 | 含义 | 处理 |
|---|---|---|
| `SGWL_EXIT=0`，并且有 `朋友可以访问了 / reachable from the internet` | 成功 | 记下框里的**分享链接**（`分享链接 SHARE LINK:` 那一行，带 `?k=`）和下面两行（游戏网址、中继地址），进入第 4 步。 |
| `SGWL_EXIT=0`，但有 `[!] 公网暂时还访问不到 https://…` | 服务和 Funnel 已装好，只是公网 DNS 还没生效 | 进入第 4 步；第 5 步的 `status` 会再验证公网。 |
| `SGWL_EXIT=2`（最后一段是黄字说明） | 需要主人操作 | 看下表，主人做完后，重跑同一条命令。 |
| 其他非 0（`[x] …` 或 `[!] 第 N 行出错`） | 出错 | 看下表；表里没有的，把日志的最后 30 行（下面这条命令的输出）原样给主人，请他转给云端的 Claude：`tail -n 30 ~/sanguo-warlords/home-host.log \| perl -pe 's/\e\[[0-9;]*m//g; s/([?&]k=)[A-Za-z0-9_-]+/$1<key>/g'`。日志里的密钥已经遮住了（`?k=<key>`）；**不要转发屏幕输出**，那里的分享链接带着真密钥。 |

注意：**那个框（分享链接 / 游戏网址 / 中继地址）失败时也会打印**，框后面还有几行「让这台 Mac 一直在线」的提示，所以不能只凭框判断成功。

| 退出时的说明 | 处理 |
|---|---|
| `Funnel 还没有开启…`（等了 15 分钟没人点 Enable） | 👤 请主人打开刚才的链接点 **Enable**，并确认第 2 步的 HTTPS Certificates 已开，然后重跑。 |
| `Tailscale 没有连接（状态 …）` | 👤 同第 1 步的登录处理，然后重跑。 |
| `[x] 端口 8787 已被另一个游戏服务占用…` | 某个已登录账户里开着桌面版（本账户的 `lsof` 看不到）：👤 请主人在所有账户里退出 SanguoWarlords.app，然后重跑。 |
| `[x] 游戏服务没有启动`（上面是 server.log 的最后 30 行） | 有 `EADDRINUSE`：8787 被别的程序占着，请主人退出它。否则把这 30 行原样给主人，请他转给云端 Claude（server.log 里没有密钥）。 |
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
D=$(sed -n 's/^DOMAIN=//p' ~/sanguo-warlords/host.env); K=$(sed -n 's/^RELAY_KEY=//p' ~/sanguo-warlords/host.env); N="$(sed -n 's/^NODE_BIN_DIR=//p' ~/sanguo-warlords/host.env)/node"
echo "$D"; SGWL_CHECK_KEY="$K" "$N" ~/sanguo-warlords/src/warlords/deploy/check.mjs "https://$D/" --public-dns; echo "exit=$?"
```

期望看到：

- `status` 的 `exit=0`。输出里有服务运行中、`访问密钥 access key: 开 on`、`Funnel: https://… → http://127.0.0.1:8787`、`公网 / internet: 正常 / OK`，最后打印那个框（分享链接 + 两行）。如果有黄字「Tailscale 密钥会在 … 过期」，把它记进第 6 步的未完成项（第 2 步的 Disable key expiry）。
- `sgwl.json` 里有 `"app":"sanguo-warlords"`、`"keyRequired":true` 和 `"headless":true`（「服务器托管对局」已启用），`"build"` 里是这次构建的提交号。如果是 `"headless":false`：`grep -n 服务器托管对局 ~/sanguo-warlords/home-host.log | tail -3` 看构建有没有失败；刚从旧版本更新上来的，用第 3 步的命令再跑一次 `update`（见「日常运维」）。`false` 时游戏照样能玩，只是房间在房主的浏览器里运行。`sgwl.json` 里**永远不会**出现密钥本身。
- `check.mjs` 的 `exit=0`，并且有 `✓ 不带密钥的连接被拒绝 / connections without the key are refused (401)`。（密钥通过环境变量 `SGWL_CHECK_KEY` 传给它，不放在命令行上：命令行本机所有账户都能用 `ps` 看到。）

最后请 👤 主人**用手机、关掉 Wi-Fi、用蜂窝网络**打开**分享链接**：能进标题页（地址栏里的 `?k=…` 会自己消失），点「联机」→「创建房间」能拿到房间码，就说明外网的朋友也能进。再用不带 `?k=` 的游戏网址试一次联机：应该提示「需要房主发的邀请链接（带密钥）」。

## 第 6 步：汇报

用中文告诉主人：

1. **分享链接**（框里第一行，带 `?k=`）：这是发给朋友的，**只私下发**，不要贴到公开的地方。链接传出去了，运行 `rotate-key` 换一个（旧链接立刻失效，要把新链接重新发给朋友）。
2. 游戏网址和中继地址（框里下面那两行，不含密钥），并提醒他把这两行**发给云端的 Claude**（开发这个游戏的那个会话）。它会把这个地址设成网页版和桌面版的默认服务器。云端 Claude 只需要这两行，不需要密钥。
3. 还没做完的项，例如：没插网线、FileVault 还开着或没开自动登录、没 Disable key expiry、Tailscale 自动更新还开着、机器名还是默认的。
4. 下面的日常用法。

---

## 日常运维（以后也按这个来）

所有命令都用 `bash` 调用（本机那份脚本副本可能没有执行权限）。更新前先按规则 8 确认没人在玩。

| 要做的事 | 命令 |
|---|---|
| 看状态（顺便重新打印分享链接和那两行；公网不通时要跑几分钟，加长超时） | `bash ~/sanguo-warlords/bin/home-host.sh status` |
| 只要分享链接（不跑检查） | `D=$(sed -n 's/^DOMAIN=//p' ~/sanguo-warlords/host.env); K=$(sed -n 's/^RELAY_KEY=//p' ~/sanguo-warlords/host.env); echo "https://$D/?k=$K"` |
| **换访问密钥**（分享链接传到不该去的地方了）。会重启服务（正在玩的人掉线）；旧链接立刻失效，把新链接重新发给朋友 | `bash ~/sanguo-warlords/bin/home-host.sh rotate-key` |
| 马上更新到最新版，不等自动更新（会重启服务；放后台运行；不看 CI 结果）。用新下载的脚本：本机 `bin/` 里的副本可能是旧的 | `curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/home-host.sh -o /tmp/sgwl-home-host.sh && caffeinate -i bash /tmp/sgwl-home-host.sh update; echo "SGWL_EXIT=$?"` |
| 停止当服务器（服务、自动更新、Funnel 全关） | `bash ~/sanguo-warlords/bin/home-host.sh stop` |
| 重新开始当服务器 | 重跑第 3 步（密钥不变，分享链接照旧） |
| 服务器日志（每行带 UTC 时间；有人时每分钟一行 `[stats]`；每个连接/断开一行 `[relay] +` / `[relay] -`；从不写密钥） | `tail -n 100 ~/sanguo-warlords/server.log` |
| 自动更新日志（为什么没更新：有人在玩 / CI 还在跑 / CI 没过 / GitHub 限流 / 访问密钥未开启…，同一原因每小时最多一行） | `tail -n 50 ~/sanguo-warlords/update.log` |
| 安装/更新脚本日志（分享链接在这里写成 `?k=<key>`；要链接用 `status`） | `tail -n 50 ~/sanguo-warlords/home-host.log \| perl -pe 's/\e\[[0-9;]*m//g'` |
| 现在有没有人在玩 | `curl -s http://127.0.0.1:8787/sgwl.json`，按规则 8 判断（`headlessHumans`、`headlessPlaying`，以及 `rooms` / `players` 和 `headlessRooms` 比） |
| 现在跑的是哪个版本 | `curl -s http://127.0.0.1:8787/sgwl.json` 里的 `"build":{"compat":…,"sha":…}`（`sha` 是 GitHub 上的提交号） |
| Funnel 指向哪里 | `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status` |
| 不要访问密钥了（谁拿到网址都能玩；不推荐） | 用「马上更新」那条命令，把 `bash /tmp/sgwl-home-host.sh update` 换成 `SGWL_RELAY_KEY=off bash /tmp/sgwl-home-host.sh update`（会被记住；想恢复就 `rotate-key`） |

注意：表格里的 `\|` 是 Markdown 转义，实际命令里是普通的 `|`。

自动更新怎么决定（每 5 分钟一次，`~/Library/LaunchAgents/com.sanguo-warlords.update.plist` 的 `StartInterval 300`）：

0. 服务器没开访问密钥、`host.env` 里也没有 `RELAY_KEY=` 这一行（从旧版本装上来、还没跑过 `update`）→ 每小时记一行并在 Mac 上弹通知「访问密钥未开启：运行 update 生成分享链接」。自动更新**不会**自己生成密钥（朋友手里的旧网址会突然失效）。
1. 有人在玩（规则 8 的条件）→ 这一轮什么都不做。
2. 问 GitHub `main` 最新的提交；和本机构建的一样 → 什么都不做（如果之前构建好但因为有人在玩没重启，这时补一次重启）。
3. 不一样 → 问 GitHub 这个提交的 `warlords-ci` 结果：通过 → 下载**这个提交**、构建、再确认没人在玩、重启；还在跑 → 等下一轮；没通过 → 不更新；这个提交没有 warlords-ci（只改了别的目录）→ 用最近一个 CI 通过的提交。
4. 连不上 GitHub、被限流（每小时 60 次，没登录的查询）→ 这一轮跳过。构建失败的提交一小时内不再试。

launchd 服务状态：

```bash
launchctl print "gui/$(id -u)/com.sanguo-warlords.server" | grep -E 'state =|pid ='
```

日志超过 5 MB 会自动轮转。`~/sanguo-warlords` 目录是 700、日志文件是 600：本机别的账户读不到（`host.env` 和 LaunchAgent 里有密钥）。

## 故障排查

| 现象 | 先查 | 处理 |
|---|---|---|
| 朋友打不开网址 | `status`；`$TS funnel status` | Funnel 没指向 8787：重跑第 3 步。Tailscale 掉线：👤 主人点菜单栏重新连接。机器 key 过期：👤 主人在后台 Disable key expiry 并重新登录。 |
| 朋友看到「需要房主发的邀请链接（带密钥）」 | `grep '\[auth\]' ~/sanguo-warlords/server.log \| tail -5`（`key-required` = 没带密钥，`bad-key` = 旧密钥） | 把**分享链接**（`status` 或上表「只要分享链接」）发给他，让他用这个链接打开一次（密钥会记在他的浏览器里）。换过密钥（`rotate-key`）以后，所有人都要新链接。 |
| 网址能打开，但创建房间失败或连不上 | `curl -s http://127.0.0.1:8787/sgwl.json`；`tail -n 50 ~/sanguo-warlords/server.log` | 本机没响应：`launchctl kickstart -k "gui/$(id -u)/com.sanguo-warlords.server"`，30 秒后再查。日志里有 `more than 8 sockets` / `rooms a minute`：同一个公网地址连接太多或开房太频繁（家里 8 个人以上共用一个网络时会碰到），过一分钟再试。 |
| 房主看到「服务器房间已满，请稍后再试」 | `sgwl.json` 的 `rooms` | 正常：这台 Mac 最多同时开 4 个房间（`MAX_ROOMS=4`）。等别的房间结束再开。 |
| 房主看到「你这边已经开着房间了，请先关掉一个再创建」 | `grep 'already holds' ~/sanguo-warlords/server.log \| tail -3` | 正常：同一个公网地址（一家人共用一个网络也算一个）最多同时开 2 个房间，服务器托管的也算，免得一个人占满 4 个房间。关掉一个再开。 |
| 房主看到「服务器关闭了这个房间（空闲太久或开得太久）」 | `grep 'ended' ~/sanguo-warlords/server.log \| tail -5` | 正常，不是故障：房间 15 分钟没有任何玩家之间的对局流量（例如房主一个人在大厅等），或者已经开了 24 小时，中转服务器就关掉它，这个房间号 10 分钟内不能再用。正在进行的对局不会因为开得久被关。让房主重新创建房间，把新的邀请链接发出去。 |
| 朋友换过密钥后还是提示「需要房主发的邀请链接（带密钥）」 | 他打开的是不是 `rotate-key` 之后的新分享链接 | 让他用新链接打开一次：页面向服务器确认新密钥是对的，就换掉浏览器里的旧密钥。 |
| 首次进游戏加载慢（美术文件） | 玩家浏览器控制台（F12）有没有 `[assets] CDN … did not answer` / `not used any more` | 构建时 `VITE_ASSET_CDN` 指向 jsDelivr 上固定提交的 `warlords/public/`，模型和贴图从那里下载；jsDelivr 连不上时页面自动改从本机下载（更慢，但能玩）。不需要处理。只想用本机：在「马上更新」那条命令前加 `SGWL_ASSET_CDN=off`（只管这一次构建，下一次自动更新又会用 CDN）。 |
| GitHub 上已经合并了新版本，这台 Mac 还没更新 | `tail -n 20 ~/sanguo-warlords/update.log` | 看原因：「有人在玩」→ 等没人时自动更新；「CI 还没跑完」→ 等几分钟；「CI 没通过」→ 等修复；「GitHub 拒绝查询」→ 下一小时自动恢复。急用就用「马上更新」那条命令（不看 CI）。 |
| 本机 8787 没响应，launchd 显示没在运行 | `tail -n 50 ~/sanguo-warlords/server.log` | `EADDRINUSE`（桌面版开着？）：👤 请主人退出它。否则重跑第 3 步。 |
| 更新后起不来 | `tail -n 30 ~/sanguo-warlords/home-host.log \| perl -pe 's/([?&]k=)[A-Za-z0-9_-]+/$1<key>/g'` | 把这 30 行原样给主人，请他转给云端 Claude（密钥已遮住）。临时恢复：重跑第 3 步。 |
| Mac 重启后服务没起来 | 这个账户有没有登录 | 👤 主人登录一次，或者开启自动登录（第 4 步）。 |
| 延迟高、卡顿 | 是不是 Wi-Fi；家里有没有人在大量上传 | 插网线；玩的时候避开大文件上传。游戏里按 Tab 能看到每个人的 ping。 |

## 附：装了些什么

| 位置 | 内容 |
|---|---|
| `~/sanguo-warlords/src/warlords` | 游戏源码和构建产物（`dist/` 是网页，带预压缩的 `.br` / `.gz`；`dist-headless/` 是服务器托管对局的房间程序，每个房间一个 worker 线程；`.sgwl-sha` 是这次构建的提交号） |
| `~/sanguo-warlords/bin/home-host.sh` | 本机的脚本副本，自动更新用它 |
| `~/sanguo-warlords/host.env` | 安装状态（`DOMAIN`、`RELAY_KEY` 访问密钥、`NODE_BIN_DIR`），权限 600（整个 `~/sanguo-warlords` 是 700） |
| `~/sanguo-warlords/home-host.log`、`update.log`、`server.log` | 日志，权限 600；`home-host.log` 里的密钥写成 `k=<key>` |
| `~/sanguo-warlords/auto-update.state` | 自动更新的记录（每种跳过原因上次记日志的时间、上次失败的构建） |
| `~/sanguo-warlords/.update.lock` | 安装/更新正在进行时才有的锁（进程没了会自动接管） |
| `~/sanguo-warlords/node` | 只在本机没有 Node ≥22 且 Homebrew 不可用或装不上时（例如非管理员账户）才有：私有的 Node 22 |
| `~/Library/LaunchAgents/com.sanguo-warlords.server.plist` | 游戏服务（KeepAlive，用 `caffeinate -is` 包着；环境变量 `RELAY_KEY`、`NO_PEER=1`、`MAX_ROOMS=4`、`HOST_GRACE_MS=120000`），权限 600 |
| `~/Library/LaunchAgents/com.sanguo-warlords.update.plist` | 每 5 分钟一次的自动更新（`StartInterval 300`） |
| Tailscale Funnel | 公网 `https://<机器名>.<tailnet>.ts.net/` → `127.0.0.1:8787` |

完全卸载：

1. 运行 `bash ~/sanguo-warlords/bin/home-host.sh stop`。
2. 运行 `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status`，确认已经没有 Funnel。
3. 运行 `rm -rf ~/sanguo-warlords`。
4. 如果 `node@22` 是为这个服务器用 Homebrew 装的，运行 `brew uninstall node@22`。
5. 休眠、自动登录这些设置，由 👤 主人按需在「系统设置」里改回来。
