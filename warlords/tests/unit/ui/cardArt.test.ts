// Painted card / icon art (src/ui/cardArt.ts + artIcons.ts): paths, which id gets
// which art, the weapon cut-out maths, and — the rule every caller relies on —
// with no art listed nothing changes (same element, no art child, no request),
// while a listing turns the art on. The node test environment has no DOM: a tiny
// fake implements the parts the art helpers touch.
import { readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ARMORS, HEROES, ITEMS, MOUNTS, ROLES, WEAPONS } from '../../../src/data';
import { assetList, setAssetListForTests } from '../../../src/game/assets';
import {
  CUTOUT_RAMP,
  abilityIconPath,
  cutoutAlpha,
  cutoutFloor,
  cutoutGain,
  gearArt,
  itemArtPath,
  roleCardPath,
  shippedPath,
  weaponArtPath,
} from '../../../src/ui/cardArt';
import { abilityArt, abilityIcon, artKnown, artOr, artUrl, gearIcon, roleArt, roleCardBadge, setArt } from '../../../src/ui/artIcons';
import { causeIcon } from '../../../src/ui/hud/feed';

// ── a DOM just big enough for h() / setArt() / artEl() ───────────────────────

class FakeNode {
  parentNode: FakeEl | null = null;
  remove(): void {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(n: FakeNode): void {
    const p = this.parentNode;
    if (!p) return;
    n.remove();
    p.childNodes[p.childNodes.indexOf(this)] = n;
    n.parentNode = p;
    this.parentNode = null;
  }
  get textContent(): string {
    return '';
  }
}

class FakeText extends FakeNode {
  constructor(readonly text: string) {
    super();
  }
  override get textContent(): string {
    return this.text;
  }
}

class FakeEl extends FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, (() => void)[]> = {};
  readonly style = { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } };
  className = '';
  title = '';
  draggable = false;
  decoding = '';
  loading = '';
  src = '';
  constructor(readonly tagName: string) {
    super();
  }
  get classList(): { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void } {
    const list = (): string[] => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (c) => void (list().includes(c) || (this.className = [...list(), c].join(' '))),
      remove: (c) => void (this.className = list().filter((x) => x !== c).join(' ')),
      contains: (c) => list().includes(c),
      toggle: (c, on) => void ((on ?? !list().includes(c)) ? this.classList.add(c) : this.classList.remove(c)),
    };
  }
  appendChild<T extends FakeNode>(c: T): T {
    c.remove();
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  prepend(c: FakeNode): void {
    c.remove();
    this.childNodes.unshift(c);
    c.parentNode = this;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'src') this.src = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  get children(): FakeEl[] {
    return this.childNodes.filter((n): n is FakeEl => n instanceof FakeEl);
  }
  override get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  /** first descendant (depth-first) with this class */
  find(cls: string): FakeEl | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const d = c.find(cls);
      if (d) return d;
    }
    return null;
  }
}

class FakeImage extends FakeEl {
  constructor() {
    super('IMG');
  }
  decode(): Promise<void> {
    return Promise.resolve();
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeAll(() => {
  for (const k of ['document', 'Node', 'Image']) saved[k] = g[k];
  g.Node = FakeNode;
  g.Image = FakeImage;
  g.document = {
    // canvases have no 2D context here: the weapon cut-out falls back to the raw render + lighten
    createElement: (tag: string) => (tag === 'img' ? new FakeImage() : Object.assign(new FakeEl(tag.toUpperCase()), { getContext: () => null })),
    createTextNode: (text: string) => new FakeText(text),
  };
});

afterAll(() => {
  for (const k of ['document', 'Node', 'Image']) g[k] = saved[k];
});

afterEach(() => setAssetListForTests(null));

const el = (): HTMLElement => new FakeEl('SPAN') as unknown as HTMLElement;
const fake = (x: unknown): FakeEl => x as FakeEl;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

/** every art file of this wave: roles, items / armor / mounts, ability icons, weapon renders */
function allArt(): string[] {
  return [
    ...ROLES.map((r) => roleCardPath(r.id)),
    ...[...ITEMS, ...ARMORS, ...MOUNTS].map((x) => itemArtPath(x.id)),
    ...HEROES.flatMap((h) => h.abilities.map((a) => abilityIconPath(a.id))),
    ...WEAPONS.map((w) => gearArt(w.id)?.path).filter((p): p is string => !!p),
  ];
}

// ── pure logic ───────────────────────────────────────────────────────────────

describe('art paths', () => {
  it('are relative (work under any base URL) and follow the asset folders', () => {
    expect(roleCardPath('lord')).toBe('assets/cards/roles/lord.webp');
    expect(itemArtPath('tao')).toBe('assets/cards/items/tao.webp');
    expect(abilityIconPath('guanyu_wusheng')).toBe('assets/icons/abilities/guanyu_wusheng.webp');
    expect(weaponArtPath('qinglong')).toBe('assets/weapons/qinglong.webp');
    for (const p of allArt()) expect(p.startsWith('/')).toBe(false);
  });

  it('gearArt: weapons get their render, cards / armor / mounts their round emblem, troop gear nothing', () => {
    expect(gearArt('qinglong')).toEqual({ path: 'assets/weapons/qinglong.webp', shape: 'weapon' });
    expect(gearArt('pistol')?.shape).toBe('weapon');
    expect(gearArt('tao')).toEqual({ path: 'assets/cards/items/tao.webp', shape: 'disc' });
    expect(gearArt('bagua')?.shape).toBe('disc');
    expect(gearArt('chitu')?.shape).toBe('disc');
    const unit = WEAPONS.filter((x) => /^(troop|npc|turret)_/.test(x.id));
    expect(unit.length).toBeGreaterThan(0);
    for (const w of unit) expect(gearArt(w.id), w.id).toBeNull();
    expect(gearArt('nothing')).toBeNull();
    expect(gearArt(undefined)).toBeNull();
    expect(gearArt(null)).toBeNull();
  });

  it('every id with art has its file in public/assets, and no file is orphaned', () => {
    const pub = new URL('../../../public/', import.meta.url).pathname;
    const shipped = new Set<string>();
    for (const dir of ['assets/cards/roles', 'assets/cards/items', 'assets/icons/abilities', 'assets/weapons']) {
      for (const f of readdirSync(pub + dir)) if (f.endsWith('.webp')) shipped.add(`${dir}/${f}`);
    }
    const wanted = new Set(allArt());
    expect([...wanted].filter((p) => !shipped.has(p))).toEqual([]);
    expect([...shipped].filter((p) => !wanted.has(p))).toEqual([]);
    // the wave-2 counts: 7 roles, 30 cards / armor / mounts, 97 ability icons, 27 weapon renders
    expect(shipped.size).toBe(7 + 30 + 97 + 27);
  });

  it('shippedPath: only listed, not broken files; nothing while the listing is unknown', () => {
    const files = new Set(['assets/cards/items/tao.webp']);
    expect(shippedPath(files, 'assets/cards/items/tao.webp')).toBe('assets/cards/items/tao.webp');
    expect(shippedPath(files, 'assets/cards/items/jiu.webp')).toBeNull();
    expect(shippedPath(files, 'assets/cards/items/tao.webp', new Set(['assets/cards/items/tao.webp']))).toBeNull();
    expect(shippedPath(null, 'assets/cards/items/tao.webp')).toBeNull();
    expect(shippedPath(new Set(), 'assets/cards/items/tao.webp')).toBeNull();
    expect(shippedPath(files, null)).toBeNull();
  });
});

describe('weapon cut-out', () => {
  it('floor = the 95th percentile of the border brightness', () => {
    expect(cutoutFloor([])).toBe(0);
    expect(cutoutFloor(Array.from({ length: 100 }, () => 1))).toBe(1);
    // a vignette (qilin, zhuge): the floor rises with it; a weapon touching the edge does not
    const vignette = [...Array.from({ length: 196 }, (_, i) => i % 14), ...Array.from({ length: 4 }, () => 230)];
    expect(cutoutFloor(vignette)).toBeLessThan(20);
    expect(cutoutFloor(vignette)).toBeGreaterThanOrEqual(12);
  });

  it('alpha: backdrop and noise vanish, gunmetal stays solid, the rim ramps smoothly', () => {
    expect(cutoutAlpha(0, 1)).toBe(0);
    expect(cutoutAlpha(4, 1)).toBe(0);
    expect(cutoutAlpha(14, 13)).toBe(0);
    expect(cutoutAlpha(40, 1)).toBe(1);
    expect(cutoutAlpha(255, 13)).toBe(1);
    let last = -1;
    for (let m = 0; m <= 60; m++) {
      const a = cutoutAlpha(m, 2);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
    expect(cutoutAlpha(2 + 3 + CUTOUT_RAMP / 2, 2)).toBeCloseTo(0.5, 5);
  });

  it('gain lifts dim rim pixels (no dark fringe on parchment), never touches solid ones', () => {
    expect(cutoutGain(255, 1)).toBe(1);
    expect(cutoutGain(40, 1)).toBe(1);
    expect(cutoutGain(15, 1)).toBeCloseTo(30 / 15, 5);
    expect(cutoutGain(1, 1)).toBe(4);
    expect(cutoutGain(0, 1)).toBe(1);
  });
});

// ── no art → today's look; a listing → the art ───────────────────────────────

describe('no art listed: every caller keeps its procedural look', () => {
  it('nothing is shipped, so nothing is ever requested', async () => {
    setAssetListForTests([]);
    await assetList();
    expect(artKnown()).toBe(true);
    for (const p of allArt()) expect(artUrl(p), p).toBeNull();
  });

  it('setArt leaves the host exactly as it was', async () => {
    setAssetListForTests([]);
    await assetList();
    for (const ref of [gearArt('tao'), gearArt('qinglong'), gearArt('bagua'), abilityArt('guanyu_wusheng'), roleArt('lord')]) {
      const host = el();
      fake(host).className = 'item-glyph';
      expect(setArt(host, ref, { first: true })).toBe(false);
      expect(fake(host).childNodes).toHaveLength(0);
      expect(fake(host).className).toBe('item-glyph');
    }
  });

  it('role badges are the plain seal, icons are absent (feed, loot popups)', async () => {
    setAssetListForTests([]);
    await assetList();
    const seal = el();
    expect(roleCardBadge('lord', () => seal)).toBe(seal);
    const plain = el();
    expect(artOr(roleArt('rebel'), () => el(), () => plain)).toBe(plain);
    expect(gearIcon('tao')).toBeNull();
    expect(gearIcon('qinglong')).toBeNull();
    expect(abilityIcon('guanyu_wusheng')).toBeNull();
    expect(causeIcon({ kind: 'weapon', id: 'qinglong' })).toBeNull();
    expect(causeIcon({ kind: 'ability', id: 'guanyu_wusheng' })).toBeNull();
    expect(causeIcon({ kind: 'item', id: 'nanman' })).toBeNull();
  });
});

describe('art listed: the art turns on', () => {
  it('setArt adds one round art span (first child) and marks the host; clearing takes it out', async () => {
    setAssetListForTests(allArt());
    await assetList();
    const host = el();
    fake(host).appendChild(new FakeText('桃'));
    expect(setArt(host, gearArt('tao'), { first: true, cls: 'it-art' })).toBe(true);
    const f = fake(host);
    expect(f.classList.contains('art-on')).toBe(true);
    const art = f.children[0];
    expect(art.className).toBe('sg-art disc it-art');
    expect(art.children[0].src).toBe('assets/cards/items/tao.webp');
    // the same art again: untouched (the HUD calls this whenever a slot may have changed)
    expect(setArt(host, gearArt('tao'))).toBe(true);
    expect(f.children).toHaveLength(1);
    expect(f.children[0]).toBe(art);
    // another card replaces it; an empty slot clears it
    setArt(host, gearArt('jiu'));
    expect(f.children).toHaveLength(1);
    expect(f.children[0].children[0].src).toBe('assets/cards/items/jiu.webp');
    setArt(host, null);
    expect(f.children).toHaveLength(0);
    expect(f.classList.contains('art-on')).toBe(false);
    expect(f.textContent).toBe('桃');
  });

  it('a file that fails to load puts the procedural look back and is never asked for again', async () => {
    setAssetListForTests(allArt());
    await assetList();
    const host = el();
    setArt(host, abilityArt('zhangfei_paoxiao'));
    fake(host).children[0].children[0].fire('error');
    expect(fake(host).children).toHaveLength(0);
    expect(fake(host).classList.contains('art-on')).toBe(false);
    expect(artUrl(abilityIconPath('zhangfei_paoxiao'))).toBeNull();
    expect(setArt(el(), abilityArt('zhangfei_paoxiao'))).toBe(false);
  });

  it('role badges become painted cards; a load failure swaps the seal back in', async () => {
    setAssetListForTests(allArt());
    await assetList();
    const parent = fake(el());
    const seal = el();
    const badge = roleCardBadge('traitor', () => seal, 'sb-card');
    parent.appendChild(fake(badge));
    expect(fake(badge).className).toBe('sg-rcard sb-card');
    expect(fake(badge).style.props['--rc']).toBeTruthy();
    fake(badge).find('sg-art')?.children[0].fire('error');
    expect(parent.children[0]).toBe(fake(seal));
  });

  it('icons: emblems for cards, a render for weapons (lighten fallback without a canvas)', async () => {
    setAssetListForTests(allArt());
    await assetList();
    expect(fake(gearIcon('bagua', 'ann-ico')).className).toBe('sg-art disc ann-ico');
    expect(fake(abilityIcon('guanyu_wusheng')).className).toBe('sg-art disc');
    expect(fake(causeIcon({ kind: 'item', id: 'nanman' })).className).toBe('sg-art disc kf-how');
    const w = fake(gearIcon('qinglong', 'kf-how'));
    expect(w.className).toBe('sg-art weapon kf-how');
    // the cut-out is queued: the span keeps its size meanwhile, the image has no src yet
    expect(w.children[0].src).toBe('');
    await flush();
    await flush();
    expect(w.children[0].src).toBe('assets/weapons/qinglong.webp');
    expect(w.classList.contains('blend')).toBe(true);
  });

  it('a host asking before the listing arrives gets its art once the listing is known', async () => {
    setAssetListForTests(allArt());
    const host = el();
    expect(artKnown()).toBe(false);
    expect(setArt(host, gearArt('wuzhong'))).toBe(false);
    expect(fake(host).children).toHaveLength(0);
    await assetList();
    await flush();
    expect(fake(host).classList.contains('art-on')).toBe(true);
    // …but not when it changed its mind meanwhile
    setAssetListForTests(allArt());
    const other = el();
    setArt(other, gearArt('wuzhong'));
    setArt(other, null);
    await assetList();
    await flush();
    expect(fake(other).children).toHaveLength(0);
  });
});
