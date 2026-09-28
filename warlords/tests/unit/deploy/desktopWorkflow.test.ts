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
  concurrency: { group: string; 'cancel-in-progress': boolean };
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

  it('a manual run publishes by default; publish=false is a dry run (artifacts only)', () => {
    expect(wf.on.workflow_dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: true });
    expect(wf.env.PUBLISH).toBe("${{ github.event_name != 'workflow_dispatch' || inputs.publish }}");
    const publish = wf.jobs.release.steps.find((s) => s.name?.startsWith('Publish'))!;
    expect(publish.if).toBe("env.PUBLISH == 'true'");
    expect(wf.jobs.release.steps.find((s) => s.if === "env.PUBLISH != 'true'")?.uses).toMatch(/^actions\/upload-artifact@/);
  });

  it('one release build at a time, a newer push cancels the older; dry runs never cancel a release', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
    expect(wf.concurrency.group).toContain("'warlords-desktop-release'");
    expect(wf.concurrency.group).toContain("github.event_name == 'workflow_dispatch' && !inputs.publish");
    expect(wf.concurrency.group).toContain('github.ref');
  });
});

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
});
