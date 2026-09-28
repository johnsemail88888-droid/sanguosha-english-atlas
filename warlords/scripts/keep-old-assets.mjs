#!/usr/bin/env node
// Keep the previous build's hashed bundles next to a new build for a while.
//
// A page left open (a player on the title screen while the server updates, a tab from yesterday)
// still runs the old build, and its lazy imports (`import('./world-l9k5lhJ4.js')`) ask for bundle
// names the new build no longer has: without them the page breaks the moment the player starts a
// match. So the files right in <old>/assets/ that <new>/assets/ lacks (Vite's content-hashed
// bundles and their .br / .gz) are copied over, and forgotten `days` after they were first
// retired (<assets>/.sgwl-retired.json remembers when). Art under assets/<dir>/ keeps its name
// across builds and is not touched.
//
//   node scripts/keep-old-assets.mjs <old build dir> <new build dir> [--days=7]
//
// Used by deploy/install.sh (the Mac mini / cloud server, before the new build goes live) and
// .github/workflows/warlords-pages.yml (GitHub Pages, with the currently published files).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETIRED_FILE = '.sgwl-retired.json';

function readRetired(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, RETIRED_FILE), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * Carry `oldDir`/assets/* that `newDir`/assets/ lacks into it, for `days` after each was retired.
 * Resolves to { kept, dropped } (file names).
 * @param {string} oldDir
 * @param {string} newDir
 * @param {{ days?: number, now?: number }} [opts]
 */
export function keepOldAssets(oldDir, newDir, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAge = Math.max(0, opts.days ?? 7) * 86_400_000;
  const oldAssets = path.join(oldDir, 'assets');
  const newAssets = path.join(newDir, 'assets');
  const kept = [];
  const dropped = [];
  let names = [];
  try {
    names = fs.readdirSync(oldAssets, { withFileTypes: true }).filter((e) => e.isFile() && e.name !== RETIRED_FILE).map((e) => e.name);
  } catch {
    return { kept, dropped };
  }
  fs.mkdirSync(newAssets, { recursive: true });
  const oldRetired = readRetired(oldAssets);
  const retired = {};
  for (const name of names.sort()) {
    const target = path.join(newAssets, name);
    if (fs.existsSync(target)) continue; // still part of the new build
    // live in the old build (retired just now) or carried already (retired back then)
    const since = typeof oldRetired[name] === 'number' ? oldRetired[name] : now;
    if (now - since >= maxAge) {
      dropped.push(name);
      continue;
    }
    fs.copyFileSync(path.join(oldAssets, name), target);
    const st = fs.statSync(path.join(oldAssets, name));
    fs.utimesSync(target, st.atime, st.mtime); // (a .br / .gz stays as fresh as its file)
    retired[name] = since;
    kept.push(name);
  }
  if (kept.length) fs.writeFileSync(path.join(newAssets, RETIRED_FILE), `${JSON.stringify(retired, null, 0)}\n`);
  return { kept, dropped };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const [oldDir, newDir] = args.filter((a) => !a.startsWith('--'));
  const d = args.find((a) => a.startsWith('--days='));
  if (!oldDir || !newDir) {
    console.error('usage: node scripts/keep-old-assets.mjs <old build dir> <new build dir> [--days=7]');
    process.exit(2);
  }
  const { kept, dropped } = keepOldAssets(oldDir, newDir, { days: d ? Number(d.slice(7)) : 7 });
  console.log(`keep-old-assets: ${kept.length} earlier bundle files kept, ${dropped.length} expired`);
}
