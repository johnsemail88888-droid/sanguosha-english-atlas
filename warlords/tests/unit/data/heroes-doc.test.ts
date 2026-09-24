import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEROES } from '../../../src/data';
import { renderHeroesMarkdown } from './heroes-doc';

const DOC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/HEROES.md');

describe('docs/HEROES.md', () => {
  const md = renderHeroesMarkdown();

  it('covers every hero and ability', () => {
    for (const h of HEROES) {
      expect(md).toContain(`### ${h.nameZh} ${h.nameEn}`);
      for (const a of h.abilities) expect(md).toContain(a.descZh);
    }
  });

  it('is in sync with the data (UPDATE_DOCS=1 regenerates it)', () => {
    if (process.env.UPDATE_DOCS || !existsSync(DOC_PATH)) writeFileSync(DOC_PATH, md, 'utf8');
    const onDisk = readFileSync(DOC_PATH, 'utf8');
    expect(onDisk === md, 'docs/HEROES.md is stale — run `UPDATE_DOCS=1 npx vitest run tests/unit/data`').toBe(true);
  });
});
