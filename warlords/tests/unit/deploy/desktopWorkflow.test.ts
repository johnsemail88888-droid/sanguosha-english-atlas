// .github/workflows/warlords-desktop.yml: every main push that changes the app publishes a
// release players' apps update from — version 0.1.<run> (strictly increasing), tag
// warlords-build-<run>, electron-updater's metadata next to the installers, the official server
// built in; a manual run can be a dry run. Parsed as YAML (no actionlint here) and checked for the
// properties the updater (electron/updater.cjs) relies on.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// js-yaml: electron-updater's (and electron-builder's) YAML parser
const yaml = require('js-yaml') as { load(s: string): unknown };
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WF_DIR = path.join(REPO_ROOT, '.github/workflows');
const text = fs.readFileSync(path.join(WF_DIR, 'warlords-desktop.yml'), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  shell?: string;
}
interface Job {
  needs?: string | string[];
  'runs-on': string;
  strategy?: { matrix: { include: Record<string, string>[] } };
  steps: Step[];
}
const wf = yaml.load(text) as {
  on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: { inputs: { publish: { type: string; default: unknown } } } };
  concurrency: { group: string; 'cancel-in-progress': string };
  env: Record<string, string>;
  permissions: Record<string, string>;
  jobs: { build: Job; release: Job };
};
const U = require(path.resolve(__dirname, '../../../electron/updater.cjs')) as { TAG_PREFIX: string };

/** A glob of the push filter matches `file` (just ** and *). */
function matches(glob: string, file: string): boolean {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  return re.test(file);
}
const triggers = (file: string): boolean => wf.on.push.paths.some((p) => matches(p, file));

describe('when a release happens', () => {
  it('every push to main that changes the app — not docs or tests', () => {
    expect(wf.on.push.branches).toEqual(['main']);
    for (const f of [
      'warlords/src/ui/app.ts',
      'warlords/src/sim/combat.ts',
      'warlords/electron/main.cjs',
      'warlords/public/assets/heroes/caocao.webp',
      'warlords/server/server.mjs',
      'warlords/index.html',
      'warlords/package.json',
      'warlords/package-lock.json',
      'warlords/vite.config.ts',
      'warlords/vite.headless.config.ts',
      'warlords/build-res/icon.png',
      '.github/workflows/warlords-desktop.yml',
    ])
      expect(triggers(f), f).toBe(true);
    for (const f of ['warlords/README.md', 'warlords/docs/GAME_SPEC.md', 'warlords/tests/unit/ui/official.test.ts', 'warlords/deploy/MAC_MINI.md', 'CLAUDE.md', 'src/atlas.ts', 'warlords/assets-src/manifest.json'])
      expect(triggers(f), f).toBe(false);
    // no tag trigger any more: the version comes from the run number
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
  });

  it('new art committed by the assets workflow (a GITHUB_TOKEN push starts no workflow) is released explicitly', () => {
    const assets = fs.readFileSync(path.join(WF_DIR, 'warlords-assets.yml'), 'utf8');
    expect(assets).toContain('gh workflow run warlords-desktop.yml --ref "${GITHUB_REF_NAME}"');
    expect(assets).toMatch(/actions: write/);
  });

  it('only main publishes: a manual run of main publishes by default, publish=false or any other branch is a dry run', () => {
    expect(wf.on.workflow_dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: true });
    const publish = wf.jobs.release.steps.find((s) => s.name?.startsWith('Publish'))!;
    expect(publish.if).toBe("env.PUBLISH == 'true'");
    expect(wf.jobs.release.steps.find((s) => s.if === "env.PUBLISH != 'true'")?.uses).toMatch(/^actions\/upload-artifact@/);
    const main = 'refs/heads/main';
    const branch = 'refs/heads/claude/some-feature';
    const PUBLISH = (ctx: Ctx): unknown => evalExpr(wf.env.PUBLISH, ctx);
    expect(PUBLISH(ctx({ event: 'push', ref: main }))).toBe(true);
    expect(PUBLISH(ctx({ event: 'workflow_dispatch', ref: main, publish: true }))).toBe(true);
    expect(PUBLISH(ctx({ event: 'workflow_dispatch', ref: main, publish: false }))).toBe(false);
    // the review's finding: `gh workflow run warlords-desktop.yml --ref <branch>` (publish defaults to on)
    // must never make unmerged code the release every setup build / AppImage installs
    expect(PUBLISH(ctx({ event: 'workflow_dispatch', ref: branch, publish: true }))).toBe(false);
    expect(PUBLISH(ctx({ event: 'workflow_dispatch', ref: branch, publish: false }))).toBe(false);
    expect(PUBLISH(ctx({ event: 'workflow_dispatch', ref: 'refs/tags/warlords-v1', publish: true }))).toBe(false);
  });

  it('one release build at a time, a newer push cancels the older; dry runs (any branch) never cancel a release; a re-run cancels nothing', () => {
    const group = (c: Ctx): unknown => evalExpr(wf.concurrency.group, c);
    const cancel = (c: Ctx): unknown => evalExpr(String(wf.concurrency['cancel-in-progress']), c);
    const main = 'refs/heads/main';
    const branch = 'refs/heads/claude/some-feature';
    expect(group(ctx({ event: 'push', ref: main }))).toBe('warlords-desktop-release');
    expect(group(ctx({ event: 'workflow_dispatch', ref: main, publish: true }))).toBe('warlords-desktop-release');
    expect(group(ctx({ event: 'workflow_dispatch', ref: main, publish: false }))).toBe('warlords-desktop-dry-refs/heads/main');
    expect(group(ctx({ event: 'workflow_dispatch', ref: branch, publish: true }))).toBe(`warlords-desktop-dry-${branch}`);
    // the release group is exactly the runs that publish
    for (const c of [ctx({ event: 'push', ref: main }), ctx({ event: 'workflow_dispatch', ref: branch, publish: true }), ctx({ event: 'workflow_dispatch', ref: main, publish: false })])
      expect(group(c) === 'warlords-desktop-release').toBe(evalExpr(wf.env.PUBLISH, c) === true);
    expect(cancel(ctx({ event: 'push', ref: main }))).toBe(true);
    // "Re-run" of an older run (attempt 2) must not cancel the newer release that is building
    expect(cancel(ctx({ event: 'push', ref: main, attempt: '2' }))).toBe(false);
  });
});

/** The context of a workflow run, as far as the expressions above read it. */
interface Ctx {
  github: { ref: string; event_name: string; run_attempt: string };
  inputs: { publish?: boolean };
}
function ctx(o: { event: string; ref: string; publish?: boolean; attempt?: string }): Ctx {
  return { github: { ref: o.ref, event_name: o.event, run_attempt: o.attempt ?? '1' }, inputs: o.event === 'workflow_dispatch' ? { publish: o.publish } : {} };
}
/**
 * A `${{ … }}` of this workflow, evaluated: GitHub's expression language restricted to what these
 * use (context reads, string literals, == / != / ! / && / || / parentheses, format()) — the same
 * value-returning && / || as JavaScript.
 */
function evalExpr(src: string, c: Ctx): unknown {
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(src.trim());
  if (!m) throw new Error(`not an expression: ${src}`);
  const js = m[1]
    .replace(/!=/g, '!==')
    .replace(/([^!=])==/g, '$1===')
    .replace(/\b(github|inputs)\./g, 'c.$1.')
    .replace(/\bformat\(/g, 'fmt(');
  expect(js).not.toMatch(/[^\w\s.'()!=&|,{}/-]/);
  const fmt = (f: string, ...a: unknown[]): string => f.replace(/\{(\d+)\}/g, (_x, i: string) => String(a[Number(i)]));
  return new Function('c', 'fmt', `return (${js});`)(c, fmt);
}

describe('what a release contains', () => {
  it('version 0.1.<run> (electron-updater sees every build as newer) and tag warlords-build-<run> (the updater’s asset links)', () => {
    expect(wf.env.APP_VERSION).toBe('0.1.${{ github.run_number }}');
    expect(wf.env.RELEASE_TAG).toBe(`${U.TAG_PREFIX}\${{ github.run_number }}`);
    const pack = wf.jobs.build.steps.find((s) => s.run?.includes('electron-builder'))!;
    expect(pack.run).toContain('--publish never');
    expect(pack.run).toContain('--config.extraMetadata.version="$APP_VERSION"');
    expect(pack.run).toContain('${{ matrix.target }}');
  });

  it('Windows (setup + portable), both Macs, Linux AppImage — each with its update metadata, checked', () => {
    const inc = wf.jobs.build.strategy!.matrix.include;
    expect(inc.map((m) => [m.target, m.feed])).toEqual([
      ['--win portable nsis --x64', 'latest.yml'],
      ['--mac dmg --arm64 --x64', 'latest-mac.yml'],
      ['--linux AppImage --x64', 'latest-linux.yml'],
    ]);
    const meta = wf.jobs.build.steps.find((s) => s.name?.startsWith('Update metadata'))!;
    expect(meta.run).toContain('release/${{ matrix.feed }}');
    const upload = wf.jobs.build.steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))!;
    const paths = String(upload.with?.path).trim().split('\n');
    expect(paths).toEqual([
      'warlords/release/*.exe',
      'warlords/release/*.dmg',
      'warlords/release/*.AppImage',
      'warlords/release/latest*.yml', // not *.yml: builder-debug.yml lives there too
      'warlords/release/*.blockmap',
    ]);
    const check = wf.jobs.release.steps.find((s) => s.name?.startsWith('Check what electron-updater'))!;
    for (const f of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml', '-Windows-setup.exe.blockmap']) expect(check.run).toContain(f);
  });

  it('keeps the macOS ad-hoc signature check', () => {
    const sig = wf.jobs.build.steps.find((s) => s.name === 'macOS signature check')!;
    expect(sig.if).toBe("runner.os == 'macOS'");
    expect(sig.run).toContain("grep -q 'Signature=adhoc'");
    expect(sig.run).toContain('codesign --verify --deep --strict');
  });

  it('ships the official server: the desktop build never switches it off (only tests / CI checks do)', () => {
    // (comments may mention it; no env entry / assignment may set it)
    const code = (t: string): string => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code(text)).not.toMatch(/VITE_OFFICIAL_(RELAY|WEB)/);
    expect(code(fs.readFileSync(path.join(WF_DIR, 'warlords-pages.yml'), 'utf8'))).not.toMatch(/VITE_OFFICIAL_(RELAY|WEB)/);
    // …while the Mac CI build and the unit tests never reach the real server
    expect(fs.readFileSync(path.join(WF_DIR, 'warlords-mac.yml'), 'utf8')).toMatch(/VITE_OFFICIAL_RELAY: ''/);
    expect(fs.readFileSync(path.resolve(__dirname, '../../../vite.config.ts'), 'utf8')).toMatch(/VITE_OFFICIAL_RELAY: ''/);
  });

  it('publishes a draft first, then the latest release (players only ever see a complete one); notes from the script', () => {
    const rel = wf.jobs.release;
    expect(rel.needs).toBe('build');
    const checkout = rel.steps.find((s) => s.uses?.startsWith('actions/checkout'))!;
    expect(checkout.with?.['fetch-depth']).toBe(0);
    const notes = rel.steps.find((s) => s.name === 'Release notes')!;
    expect(notes.run).toContain('warlords/scripts/release-notes.mjs --build "${{ github.run_number }}" --ref "$GITHUB_SHA" --version "$APP_VERSION"');
    const pub = rel.steps.find((s) => s.name?.startsWith('Publish'))!.run!;
    expect(pub).toContain('gh release create "$RELEASE_TAG" out/* --draft --target "$GITHUB_SHA"');
    expect(pub).toContain('gh release edit "$RELEASE_TAG" --draft=false --latest');
    expect(pub.indexOf('--draft --target')).toBeLessThan(pub.indexOf('--draft=false --latest'));
    expect(wf.permissions.contents).toBe('write');
  });

  it('every step is a well-formed action or command', () => {
    for (const [name, job] of Object.entries(wf.jobs))
      for (const s of job.steps) expect(!!s.uses !== !!s.run, `${name}: ${s.name ?? s.uses ?? s.run}`).toBe(true);
  });
});

describe('the release job’s shell, dry-run locally', () => {
  it('the metadata checks accept what electron-builder writes and name every file it lists', () => {
    const check = wf.jobs.release.steps.find((s) => s.name?.startsWith('Check what electron-updater'))!.run!;
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sgwl-release-'));
    try {
      const out = path.join(dir, 'out');
      fs.mkdirSync(out);
      const v = '0.1.42';
      const yml = (files: string[]): string =>
        `version: ${v}\nfiles:\n${files.map((f) => `  - url: ${f}\n    sha512: x\n    size: 1\n`).join('')}path: ${files[0]}\nsha512: x\nreleaseDate: '2026-09-28T05:00:25.368Z'\n`;
      const setup = `SanguoWarlords-${v}-Windows-setup.exe`;
      const files = [setup, `${setup}.blockmap`, `SanguoWarlords-${v}-Windows-portable.exe`, `SanguoWarlords-${v}-Linux.AppImage`, `SanguoWarlords-${v}-macOS-x64.dmg`, `SanguoWarlords-${v}-macOS-arm64.dmg`];
      for (const f of files) fs.writeFileSync(path.join(out, f), 'x');
      fs.writeFileSync(path.join(out, 'latest.yml'), yml([setup]));
      fs.writeFileSync(path.join(out, 'latest-linux.yml'), yml([`SanguoWarlords-${v}-Linux.AppImage`]));
      fs.writeFileSync(path.join(out, 'latest-mac.yml'), yml([`SanguoWarlords-${v}-macOS-x64.dmg`, `SanguoWarlords-${v}-macOS-arm64.dmg`]));
      const run = (): string => execFileSync('bash', ['-e', '-c', check], { cwd: dir, env: { ...process.env, APP_VERSION: v }, encoding: 'utf8', stdio: 'pipe' });
      expect(run()).toContain('latest-mac.yml');
      // a file the metadata names but the build lost: no release
      fs.rmSync(path.join(out, `SanguoWarlords-${v}-macOS-arm64.dmg`));
      expect(run).toThrow();
      fs.writeFileSync(path.join(out, `SanguoWarlords-${v}-macOS-arm64.dmg`), 'x');
      // metadata of another version: no release
      fs.writeFileSync(path.join(out, 'latest.yml'), yml([setup]).replace(`version: ${v}`, 'version: 0.1.41'));
      expect(run).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // the Publish step against a fake `gh` (the releases it lists, what it would create / delete)
  function publishRun(o: { run: number; ref?: string; published: string[]; drafts?: string[] }): { ok: boolean; log: string[]; out: string } {
    const step = wf.jobs.release.steps.find((s) => s.name?.startsWith('Publish'))!.run!.replace(/\$\{\{ github\.run_number \}\}/g, String(o.run));
    expect(step).not.toContain('${{');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sgwl-publish-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, 'out'));
      fs.writeFileSync(path.join(dir, 'out', 'latest.yml'), 'version: x\n');
      fs.writeFileSync(path.join(dir, 'published'), o.published.join('\n'));
      fs.writeFileSync(path.join(dir, 'drafts'), (o.drafts ?? []).join('\n'));
      // gh release list -q '…select(.isDraft)…' → the drafts; '…select(.isDraft | not)…' → the published
      fs.writeFileSync(
        path.join(bin, 'gh'),
        `#!/usr/bin/env bash
echo "gh $*" >> "$FAKE/log"
case "$1 $2" in
  "release list") if [[ "$*" == *"isDraft | not"* ]]; then cat "$FAKE/published"; else cat "$FAKE/drafts"; fi; echo ;;
  "release view") grep -qx -- "$3" "$FAKE/published" ;;
  "release create") printf '\n%s\n' "$3" >> "$FAKE/published" ;;
  *) exit 0 ;;
esac
`,
        { mode: 0o755 },
      );
      let out = '';
      let ok = true;
      try {
        out = execFileSync('bash', ['-c', step], {
          cwd: dir,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: dir, RUNNER_TEMP: dir, GITHUB_REF: o.ref ?? 'refs/heads/main', GITHUB_SHA: 'abc123', GITHUB_RUN_NUMBER: String(o.run), RELEASE_TAG: `${U.TAG_PREFIX}${o.run}` },
        });
      } catch (err) {
        ok = false;
        out = String((err as { stdout?: unknown }).stdout ?? '') + String((err as { stderr?: unknown }).stderr ?? '');
      }
      const logFile = path.join(dir, 'log');
      return { ok, out, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [] };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const created = (log: string[]): string[] => log.filter((l) => l.startsWith('gh release create') || l.startsWith('gh release edit'));

  it('publish: the next build becomes the latest release (a draft first); a stale draft is deleted', () => {
    const r = publishRun({ run: 12, published: ['warlords-build-9', 'warlords-build-10', 'v1.1.1'], drafts: ['warlords-build-11'] });
    expect(r.ok, r.out).toBe(true);
    expect(r.log).toContain('gh release delete warlords-build-11 --yes');
    const c = created(r.log);
    expect(c[0]).toMatch(/^gh release create warlords-build-12 out\/latest\.yml --draft --target abc123 /);
    expect(c[1]).toBe('gh release edit warlords-build-12 --draft=false --latest');
    // the very first automatic release (no warlords build yet beyond the old tag-built ones)
    expect(created(publishRun({ run: 9, published: [] }).log)).toHaveLength(2);
  });

  it('publish: a re-run of an older run never replaces a newer build as "latest"; a re-run of a published one does nothing', () => {
    const older = publishRun({ run: 10, published: ['warlords-build-9', 'warlords-build-11'] });
    expect(older.ok, older.out).toBe(true);
    expect(created(older.log)).toEqual([]);
    expect(older.out).toMatch(/warlords-build-11 is newer/);
    // numeric, not text order: build 100 is newer than build 99
    expect(created(publishRun({ run: 99, published: ['warlords-build-100', 'warlords-build-9'] }).log)).toEqual([]);
    expect(created(publishRun({ run: 101, published: ['warlords-build-100', 'warlords-build-99'] }).log)).toHaveLength(2);
    const again = publishRun({ run: 11, published: ['warlords-build-11'] });
    expect(again.ok).toBe(true);
    expect(created(again.log)).toEqual([]);
  });

  it('publish: never from a branch other than main, even if the step is reached', () => {
    const r = publishRun({ run: 12, ref: 'refs/heads/claude/some-feature', published: ['warlords-build-11'] });
    expect(r.ok).toBe(false);
    expect(r.log).toEqual([]);
  });
});
