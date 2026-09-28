// Game-compatibility id of this source tree (both vite configs: __SGWL_COMPAT__).
//
// A server-run room runs the Mac mini's last build while the page may be a newer
// (GitHub Pages) or older (a desktop release, a tab left open) one; the client decodes
// the snapshots with its own protocol code and data tables, so two different builds
// would desync silently. The id is a hash of every source file the room worker runs
// plus the client's online code (the relative-import graph from these entries):
// UI / renderer / audio changes keep it, anything the match or the wire depends on
// changes it. POST /api/rooms answers 409 and the room's hello refuses another id.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['src/headless/worker.ts', 'src/net/clientSession.ts', 'src/net/clientView.ts'];
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"?]+)(?:\?[^'"]*)?['"]/g;
const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '/index.ts', '/index.js'];

function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of EXTS) {
    const p = base + ext;
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The compatibility id (12 hex characters) of the tree at `root`. */
export function compatId(root = ROOT) {
  const seen = new Set();
  const stack = ENTRIES.map((e) => path.join(root, e)).filter((p) => fs.existsSync(p));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const dep = resolveImport(file, m[1]);
      if (dep && !seen.has(dep)) stack.push(dep);
    }
  }
  const h = crypto.createHash('sha256');
  for (const file of [...seen].sort()) {
    // (line endings normalised: a Windows checkout builds the same id)
    h.update(path.relative(root, file).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

// `node scripts/compat-id.mjs` prints it
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(compatId());
