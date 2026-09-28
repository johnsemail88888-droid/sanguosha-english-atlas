// scripts/release-notes.mjs: the desktop release's notes — what changed since the previous
// warlords-build tag (first-parent subjects, ≤ 30 lines), how installed apps update, which file to
// download (the setup build first). Checked on a throwaway git repo like the release job's checkout.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script (no types)
import { MAX_LINES, assetNames, changeLines, commitLine, notesFor, previousTag, renderNotes } from '../../../scripts/release-notes.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/release-notes.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const dirs: string[] = [];
afterEach(() => {
  // (retries: a git process that outlived its command can still be writing into .git)
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('pieces', () => {
  it('the previous build is the highest warlords-build-N below this one', () => {
    expect(previousTag(['warlords-build-7', 'warlords-build-10', 'warlords-build-9', 'v1.1.1', 'warlords-build-x', ''], 11)).toBe('warlords-build-10');
    expect(previousTag(['warlords-build-7', 'warlords-build-12'], 11)).toBe('warlords-build-7');
    expect(previousTag(['v1.1.1'], 3)).toBeNull();
  });

  it('a line per commit: squash subjects as they are, a PR merge’s title, no branch merges, no @-pings', () => {
    expect(commitLine({ sha: '3291bbb0000', subject: 'warlords: server hardening (#16)', body: '' })).toBe('- warlords: server hardening (#16) (3291bbb)');
    expect(commitLine({ sha: '30644b6aaaa', subject: 'Merge pull request #11 from johnsemail88888-droid/claude/x', body: 'warlords: official online server\n\nmore' })).toBe(
      '- warlords: official online server (#11) (30644b6)',
    );
    expect(commitLine({ sha: 'a', subject: 'Merge pull request #3 from a/b', body: '' })).toBe('- Merge pull request #3 from a/b (a)');
    expect(commitLine({ sha: 'b', subject: "Merge branch 'worktree-x' into main", body: '' })).toBeNull();
    expect(commitLine({ sha: 'c', subject: 'thanks @someone', body: '' })).toBe('- thanks @​someone (c)');
    expect(commitLine({ sha: 'd', subject: '   ', body: '' })).toBeNull();
  });

  it('at most 30 lines: the newest 29 and 「…另外 N 条 / and N more」', () => {
    expect(MAX_LINES).toBe(30);
    const commits = Array.from({ length: 45 }, (_, i) => ({ sha: `c${i}`, subject: `change ${i}`, body: '' }));
    const lines = changeLines(commits);
    expect(lines).toHaveLength(30);
    expect(lines[0]).toBe('- change 0 (c0)');
    expect(lines[29]).toBe('- …另外 16 条 / and 16 more');
    expect(changeLines(commits.slice(0, 30))).toHaveLength(30);
  });

  it('the notes name the files the build makes (package.json artifactName), the setup build first and recommended', () => {
    const v = '0.1.42';
    const a = assetNames(v);
    const fill = (p: string, arch = ''): string => p.replace('${version}', v).replace('${arch}', arch);
    expect(a).toEqual({
      setup: fill(pkg.build.nsis.artifactName),
      portable: fill(pkg.build.portable.artifactName),
      macArm: fill(pkg.build.dmg.artifactName, 'arm64'),
      macIntel: fill(pkg.build.dmg.artifactName, 'x64'),
      appImage: fill(pkg.build.appImage.artifactName),
    });
    const md = renderNotes({ build: 42, lines: ['- a change (abc1234)'], prevTag: 'warlords-build-41' });
    expect(md).toContain('build 42（v0.1.42）');
    expect(md).toContain('（自 build 41 起 / since build 41）');
    expect(md).toContain('- a change (abc1234)');
    for (const f of Object.values(a)) expect(md).toContain(f as string);
    expect(md.indexOf(a.setup)).toBeLessThan(md.indexOf(a.portable)); // the setup build comes first
    expect(md).toMatch(/推荐安装版/);
    expect(md).toMatch(/update themselves/);
    expect(md).toMatch(/重启并更新/);
    // every copy from before the updater (0.1.0) needs this one last download — friends' too
    expect(md).toContain('「测试版 v0.1.0」（没有 build 号）的旧桌面版不会自动更新');
    expect(md).toMatch(/Beta v0\.1\.0.*cannot update itself/);
    expect(renderNotes({ build: 3 })).toContain('（无记录 / nothing recorded）');
  });
});

describe('on a repository (what the release job runs)', () => {
  function repo(): { dir: string; commit(msg: string, file?: string): void; tag(name: string): void; merge(branch: string, msg: string): void; run(args: string[]): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwl-notes-'));
    dirs.push(dir);
    // no auto maintenance / gc: git ≥ 2.46 runs it detached after a commit, still writing into .git
    // while afterEach deletes the repo (ENOTEMPTY on CI)
    const git = (args: string[]): string =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });
    git(['init', '-q']);
    git(['checkout', '-q', '-b', 'main']);
    let n = 0;
    return {
      dir,
      commit(msg, file = 'warlords/src/a.ts') {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), String(n++));
        git(['add', '-A']);
        git(['commit', '-q', '-m', msg]);
      },
      tag(name) {
        git(['tag', name]);
      },
      merge(branch, msg) {
        git(['merge', '-q', '--no-ff', branch, '-m', msg]);
      },
      run: (args) => void git(args),
    };
  }

  it('lists the first-parent subjects since the previous build tag, only the game’s', () => {
    const r = repo();
    r.commit('warlords: first playable (#1)');
    r.tag('warlords-build-7');
    r.commit('warlords: bows (#2)');
    r.commit('atlas: fix a typo', 'src/atlas.ts'); // the other app in the repo: not listed
    // a PR merged with a merge commit: its title, not its inner commits
    r.run(['checkout', '-q', '-b', 'feature']);
    r.commit('wip 1');
    r.commit('wip 2');
    r.run(['checkout', '-q', 'main']);
    r.merge('feature', 'Merge pull request #3 from someone/feature\n\nwarlords: horses');
    const md = notesFor({ dir: r.dir, build: 9 });
    const changes = md.slice(md.indexOf('### 这次更新'), md.indexOf('### 已经装了'));
    expect(changes).toContain('（自 build 7 起 / since build 7）');
    expect(changes).toMatch(/- warlords: horses \(#3\) \([0-9a-f]{7}\)\n- warlords: bows \(#2\) \([0-9a-f]{7}\)/);
    expect(changes).not.toContain('first playable');
    expect(changes).not.toContain('atlas');
    expect(changes).not.toContain('wip');
    // the CLI prints the same
    const out = execFileSync('node', [SCRIPT, '--build', '9', '--dir', r.dir], { encoding: 'utf8' });
    expect(out).toBe(md);
  });

  it('no build tag yet: the latest 30; a tag of a later build (a re-run) is not "previous"', () => {
    const r = repo();
    for (let i = 0; i < 35; i++) r.commit(`warlords: change ${i}`);
    const md = notesFor({ dir: r.dir, build: 1 });
    expect(md).not.toContain('自 build');
    expect(md).toContain('- warlords: change 34');
    expect(md).toContain('- …另外 2 条 / and 2 more');
    r.tag('warlords-build-5');
    expect(notesFor({ dir: r.dir, build: 5 })).not.toContain('自 build');
    expect(notesFor({ dir: r.dir, build: 6 })).toContain('（无记录 / nothing recorded）');
  });

  it('the CLI wants a build number', () => {
    expect(() => execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
