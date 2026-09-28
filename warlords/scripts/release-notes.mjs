#!/usr/bin/env node
// The desktop release's notes (.github/workflows/warlords-desktop.yml), zh + en: what changed —
// the first-parent commit subjects on the built commit since the previous warlords-build-* tag
// (at most 30 lines) — how an installed app gets this build, and which file to download first.
//
//   node warlords/scripts/release-notes.mjs --build 42 [--ref <commit>] [--dir <repo>] > notes.md
//
// --build: this build's number (the workflow's run number: version 0.1.<build>, tag warlords-build-<build>).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TAG_PREFIX = 'warlords-build-';
export const MAX_LINES = 30;
/** the paths whose commits are the game's (the repo also holds the older atlas app) */
export const LOG_PATHS = ['warlords', '.github/workflows/warlords-desktop.yml'];

/** The newest warlords-build-N among `tags` with N < build (null: none). */
export function previousTag(tags, build) {
  let best = null;
  let bestN = -1;
  for (const tag of tags) {
    const m = new RegExp(`^${TAG_PREFIX}(\\d+)$`).exec(String(tag).trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (n < build && n > bestN) {
      best = m[0];
      bestN = n;
    }
  }
  return best;
}

/**
 * One line per commit: its subject — a GitHub merge commit's PR title (the body's first line) —
 * without branch merges; `@` mentions defused (no pings from release notes).
 */
export function commitLine(c) {
  let subject = String(c.subject || '').trim();
  const pr = /^Merge pull request #(\d+) from \S+/.exec(subject);
  if (pr) {
    const title = String(c.body || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l);
    subject = title ? `${title} (#${pr[1]})` : subject;
  } else if (/^Merge (branch|remote-tracking branch|commit) /.test(subject)) return null;
  if (!subject) return null;
  subject = subject.replace(/@(?=\w)/g, '@​');
  return `- ${subject}${c.sha ? ` (${String(c.sha).slice(0, 7)})` : ''}`;
}

/** At most MAX_LINES lines: the newest first, then 「…另外 N 条 / and N more」. */
export function changeLines(commits, max = MAX_LINES) {
  const lines = commits.map(commitLine).filter(Boolean);
  if (lines.length <= max) return lines;
  const shown = lines.slice(0, max - 1);
  shown.push(`- …另外 ${lines.length - shown.length} 条 / and ${lines.length - shown.length} more`);
  return shown;
}

/** permanent links (the release workflow also uploads each installer under a name without the version) */
export const STABLE_SETUP_URL = 'https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest/download/SanguoWarlords-Windows-setup.exe';

/** package.json build.*.artifactName, filled in */
export const assetNames = (version) => ({
  setup: `SanguoWarlords-${version}-Windows-setup.exe`,
  portable: `SanguoWarlords-${version}-Windows-portable.exe`,
  macArm: `SanguoWarlords-${version}-macOS-arm64.dmg`,
  macIntel: `SanguoWarlords-${version}-macOS-x64.dmg`,
  appImage: `SanguoWarlords-${version}-Linux.AppImage`,
});

/** The release body (Markdown). */
export function renderNotes({ build, version = `0.1.${build}`, lines = [], prevTag = null }) {
  const a = assetNames(version);
  const since = prevTag ? `（自 build ${prevTag.slice(TAG_PREFIX.length)} 起 / since build ${prevTag.slice(TAG_PREFIX.length)}）` : '';
  const changes = lines.length ? lines.join('\n') : '- （无记录 / nothing recorded）';
  return `## 三国杀·枪火乱世 桌面版 build ${build}（v${version}）

**Windows 一键安装（永远是最新版）/ Windows one-click install (always the newest):** ${STABLE_SETUP_URL}
下载后双击，不用点任何「下一步」，装完自动打开，以后自动更新。/ Double-click it: no pages to click through, the game opens when done and updates itself from then on.

### 这次更新 / What changed${since}
${changes}

### 已经装了桌面版？/ Already installed?
- **Windows 安装版、Linux AppImage：什么都不用做。** 游戏会在后台下载新版本，退出游戏时自动安装；标题页也会出现「重启并更新」。
- **Windows 便携版、macOS：** 标题页会提示「有新版本 build ${build} · 下载」，点一下就下载新文件，替换旧的即可。
- **标题页底部写着「测试版 v0.1.0」（没有 build 号）的旧桌面版不会自动更新**（自己的和朋友的都一样）：请按下面「第一次下载」重新下载一次（Windows 选安装版），以后就会自动更新。
- The Windows setup build and the Linux AppImage **update themselves**: the new build downloads in the background and installs when you quit (or click “Restart to update” on the title screen). The portable exe and the Mac app show “New version: build ${build} · Download” on the title screen.
- **An old copy whose title screen says “Beta v0.1.0” (no build number) cannot update itself** — yours or a friend's: download once more below (Windows: the setup build); from then on it updates by itself.

### 第一次下载，选哪个？
- **Windows（推荐安装版）：\`${a.setup}\`** —— 装一次，以后自动更新，不用再来这里下载。
  便携版 \`${a.portable}\` 免安装，但不能自动更新（有新版本时游戏会提示，一键下载新文件）。
  首次运行若提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」（未签名）；Windows 防火墙询问时勾选「专用网络」并点「允许」，否则同一 Wi-Fi 的朋友连不进你的局域网房间。
- **macOS：** Apple 芯片（M1/M2/M3/M4…，「关于本机」里芯片写 Apple M…）下载 \`${a.macArm}\`；Intel 处理器的 Mac 下载 \`${a.macIntel}\`。双击 dmg，把「SanguoWarlords」拖进「应用程序」文件夹，再从“应用程序”里打开。
  应用没有 Apple 开发者签名（只有本地签名），第一次打开会提示「无法验证开发者」/「Apple 无法验证…是否包含恶意软件」：点「完成」，然后打开「系统设置 → 隐私与安全性」，在底部找到 SanguoWarlords 点「仍要打开」并输入密码（macOS 14 及更早也可以在“应用程序”里按住 Control 点击应用 → 打开 → 打开）。之后双击即可。
  如果仍提示「已损坏，无法打开」：打开“终端”，运行 \`xattr -dr com.apple.quarantine "/Applications/SanguoWarlords.app"\`，再打开应用。
  不想装也可以直接用 Safari / Chrome 打开网页版。
- **Linux：** 下载 \`${a.appImage}\`，\`chmod +x\` 后运行（会自动更新）。

联机零设置：打开就连官方服务器；「邀请朋友一起玩」复制的链接，朋友点开就进同一个房间。桌面版还内置局域网服务器：菜单「游戏 → 局域网联机地址」。

### Which file? (English)
- **Windows — recommended: \`${a.setup}\`** (installs once, then updates itself). The portable \`${a.portable}\` needs no install but does not update itself (the game tells you when a new build is out and downloads it in one click). Unsigned: “Windows protected your PC” → More info → Run anyway; allow **private networks** at the firewall prompt so LAN friends can join.
- **macOS:** Apple silicon → \`${a.macArm}\`, Intel → \`${a.macIntel}\`. Drag SanguoWarlords into Applications. Not signed by an Apple Developer ID: the first open needs System Settings → Privacy & Security → “Open Anyway”. New builds are offered on the title screen (download the new dmg, replace the app).
- **Linux:** \`${a.appImage}\`, \`chmod +x\` it and run (updates itself).
- Online play needs no setup: the app connects to the official server, and “Invite friends” links open a page on the same server.
`;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/** The commits on `ref`'s first-parent line since `prevTag` (newest first; the last MAX_LINES + 1 without a tag). */
export function commitsSince(dir, ref, prevTag) {
  const range = prevTag ? [`${prevTag}..${ref}`] : ['-n', String(MAX_LINES + 1), ref];
  const out = git(dir, ['log', '--first-parent', '--format=%H%x1f%s%x1f%b%x1e', ...range, '--', ...LOG_PATHS]);
  return out
    .split('\x1e')
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha, subject, body] = rec.split('\x1f');
      return { sha: sha.trim(), subject: subject || '', body: body || '' };
    });
}

export function notesFor({ dir, build, ref = 'HEAD', version = `0.1.${build}` }) {
  const tags = git(dir, ['tag', '--list', `${TAG_PREFIX}*`, '--merged', ref]).split('\n');
  const prevTag = previousTag(tags, build);
  return renderNotes({ build, version, prevTag, lines: changeLines(commitsSince(dir, ref, prevTag)) });
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(build|ref|dir|version)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument ${argv[i]}`);
    o[m[1]] = m[2] ?? argv[++i];
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  const build = Number(o.build);
  if (!Number.isInteger(build) || build <= 0) {
    console.error('usage: release-notes.mjs --build <N> [--ref <commit>] [--dir <repo>] [--version <x.y.z>]');
    process.exit(2);
  }
  process.stdout.write(notesFor({ dir: o.dir || process.cwd(), build, ref: o.ref || 'HEAD', version: o.version || `0.1.${build}` }));
}
