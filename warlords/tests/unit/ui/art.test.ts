import { describe, expect, it } from 'vitest';
import { HEROES } from '../../../src/data';
import {
  CROPS,
  DEFAULT_FOCUS,
  PORTRAIT_ASPECT,
  PORTRAIT_FOCUS,
  TITLE_ART,
  cropBox,
  cropStyle,
  firstShipped,
  loadingArtCandidates,
  portraitArtPath,
  portraitCropStyle,
  portraitFocus,
  type CropSpec,
  type PortraitCrop,
} from '../../../src/ui/art';

const EPS = 0.02;

/** The image box covers the frame: no uncovered edge anywhere. */
function expectCovers(b: { w: number; h: number; l: number; t: number }): void {
  expect(b.l).toBeLessThanOrEqual(EPS);
  expect(b.t).toBeLessThanOrEqual(EPS);
  expect(b.l + b.w).toBeGreaterThanOrEqual(100 - EPS);
  expect(b.t + b.h).toBeGreaterThanOrEqual(100 - EPS);
}

describe('art paths', () => {
  it('portrait path is relative (works under any base URL)', () => {
    expect(portraitArtPath('guanyu')).toBe('assets/portraits/guanyu.webp');
    expect(portraitArtPath('guanyu').startsWith('/')).toBe(false);
  });

  it('loading art: own kingdom first, the title key art as the last resort', () => {
    expect(loadingArtCandidates('shu')).toEqual(['assets/ui/loading_shu.webp', TITLE_ART]);
    expect(loadingArtCandidates('wei')[0]).toBe('assets/ui/loading_wei.webp');
    expect(loadingArtCandidates('wu')[0]).toBe('assets/ui/loading_wu.webp');
    expect(loadingArtCandidates('qun')[0]).toBe('assets/ui/loading_qun.webp');
    // 神 has no battle scene; unknown hero → title art only
    expect(loadingArtCandidates('god')).toEqual([TITLE_ART]);
    expect(loadingArtCandidates(null)).toEqual([TITLE_ART]);
    expect(loadingArtCandidates(undefined)).toEqual([TITLE_ART]);
  });

  it('firstShipped picks the first listed candidate, null without a listing or a match', () => {
    const files = new Set([TITLE_ART, 'assets/ui/loading_wu.webp']);
    expect(firstShipped(files, loadingArtCandidates('wu'))).toBe('assets/ui/loading_wu.webp');
    expect(firstShipped(files, loadingArtCandidates('shu'))).toBe(TITLE_ART);
    expect(firstShipped(new Set(), loadingArtCandidates('shu'))).toBeNull();
    expect(firstShipped(null, loadingArtCandidates('shu'))).toBeNull();
  });
});

describe('portrait focus', () => {
  it('every hero has a measured focus inside the image', () => {
    for (const hero of HEROES) {
      const f = PORTRAIT_FOCUS[hero.id];
      expect(f, hero.id).toBeDefined();
      expect(f.x).toBeGreaterThan(0.2);
      expect(f.x).toBeLessThan(0.8);
      // head in the upper part of the painting
      expect(f.y).toBeGreaterThan(0.05);
      expect(f.y).toBeLessThan(0.4);
      expect(f.s).toBeGreaterThan(0.05);
      expect(f.s).toBeLessThan(0.3);
    }
  });

  it('unknown heroes fall back to the default focus', () => {
    expect(portraitFocus('nobody')).toBe(DEFAULT_FOCUS);
    expect(portraitFocus('guanyu')).toBe(PORTRAIT_FOCUS.guanyu);
  });
});

describe('cropBox', () => {
  const allFoci = [DEFAULT_FOCUS, ...Object.values(PORTRAIT_FOCUS)];

  it('every preset covers its frame for every hero (no empty edges)', () => {
    for (const crop of Object.keys(CROPS) as PortraitCrop[]) {
      for (const f of allFoci) expectCovers(cropBox(CROPS[crop], f));
    }
  });

  it('keeps the image aspect (no distortion)', () => {
    for (const crop of Object.keys(CROPS) as PortraitCrop[]) {
      const spec = CROPS[crop];
      const b = cropBox(spec, DEFAULT_FOCUS);
      // box width / height in frame units → image aspect
      const aspect = (b.w / 100) * spec.aspect / (b.h / 100);
      expect(aspect).toBeCloseTo(PORTRAIT_ASPECT, 2);
    }
  });

  it('the full crop shows the whole painting', () => {
    expect(cropBox(CROPS.full, PORTRAIT_FOCUS.guanyu)).toEqual({ w: 100, h: 100, l: 0, t: 0 });
  });

  it('face crop zooms in and centres the face', () => {
    const f = PORTRAIT_FOCUS.guanyu;
    const b = cropBox(CROPS.face, f);
    expect(b.w).toBeGreaterThan(200);
    // the face centre lands on the anchor (frame %)
    const fx = b.l + (f.x * b.w);
    const fy = b.t + (f.y * b.h);
    expect(fx).toBeCloseTo(CROPS.face.ax * 100, 0);
    expect(fy).toBeCloseTo(CROPS.face.ay * 100, 0);
    // head is the requested share of the frame height
    expect((f.s * b.h) / 100).toBeCloseTo(CROPS.face.head, 1);
  });

  it('never zooms past maxZoom and clamps at the image edges', () => {
    const spec: CropSpec = { aspect: 1, head: 0.9, ax: 0.5, ay: 0.5, maxZoom: 2 };
    const b = cropBox(spec, { x: 0.02, y: 0.01, s: 0.05 });
    expect(b.w).toBeCloseTo(200, 5);
    // a face at the very corner cannot be centred: the image edge stays on the frame edge
    expect(b.l).toBe(0);
    expect(b.t).toBe(0);
    const c = cropBox(spec, { x: 0.99, y: 0.99, s: 0.05 });
    expect(c.l + c.w).toBeCloseTo(100, 5);
    expect(c.t + c.h).toBeCloseTo(100, 5);
  });

  it('a wider-than-image frame zooms to cover by width, a taller one by height', () => {
    const wide = cropBox({ aspect: 2, head: 0, ax: 0.5, ay: 0.5, maxZoom: 1 }, DEFAULT_FOCUS);
    expect(wide.w).toBe(100);
    expect(wide.h).toBeGreaterThan(100);
    const tall = cropBox({ aspect: 0.5, head: 0, ax: 0.5, ay: 0.5, maxZoom: 1 }, DEFAULT_FOCUS);
    expect(tall.h).toBe(100);
    expect(tall.w).toBeGreaterThan(100);
  });

  it('style strings are plain percentages', () => {
    expect(cropStyle({ w: 120, h: 160, l: -10, t: 0 })).toBe('width:120%;height:160%;left:-10%;top:0%');
    expect(portraitCropStyle('caocao', 'face')).toMatch(/^width:[\d.]+%;height:[\d.]+%;left:-?[\d.]+%;top:-?[\d.]+%$/);
  });
});

describe('PortraitCache art state', () => {
  it('reports unknown → shipped / not shipped from its art source', async () => {
    const { PortraitCache } = await import('../../../src/ui/widgets');
    let files: Set<string> | null = null;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((r) => (release = r));
    const pc = new PortraitCache(async () => '', { has: (p) => (files ? files.has(p) : null), ready: () => ready });
    expect(pc.artState('guanyu')).toBeNull();
    expect(pc.hasArt('guanyu')).toBe(false);
    expect(pc.known()).toBe(false);
    files = new Set([portraitArtPath('guanyu')]);
    release();
    await pc.whenKnown();
    expect(pc.artState('guanyu')).toBe(true);
    expect(pc.hasArt('guanyu')).toBe(true);
    expect(pc.artState('caocao')).toBe(false);
    expect(pc.known()).toBe(true);
  });

  it('memoizes the procedural render per hero (one render at PORTRAIT_SIZE, whatever size is asked)', async () => {
    const { PortraitCache, PORTRAIT_SIZE } = await import('../../../src/ui/widgets');
    let calls = 0;
    const pc = new PortraitCache(async (id, size) => {
      calls++;
      return `${id}@${size}`;
    }, { has: () => false, ready: async () => undefined });
    const one = `liubei@${PORTRAIT_SIZE}`;
    expect(await pc.get('liubei', 128)).toBe(one);
    expect(await pc.get('liubei', 128)).toBe(one);
    expect(await pc.get('liubei', 256)).toBe(one);
    expect(calls).toBe(1);
  });

  it('prioritize() queues only heroes without painted art (they never need a render)', async () => {
    const { PortraitCache } = await import('../../../src/ui/widgets');
    const shipped = new Set([portraitArtPath('guanyu'), portraitArtPath('zhangfei')]);
    const rendered: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const pc = new PortraitCache(async (id) => {
      rendered.push(id);
      if (id === 'first') await gate;
      return id;
    }, { has: (p) => shipped.has(p), ready: async () => undefined });
    const first = pc.get('first');
    pc.prioritize(['guanyu', 'liubei', 'zhangfei', 'caocao']);
    expect(pc.pending()).toEqual(['liubei', 'caocao']);
    release();
    await first;
    await Promise.all([pc.get('liubei'), pc.get('caocao')]);
    expect(rendered).toEqual(['first', 'liubei', 'caocao']);
  });

  it('prioritize() before the art listing loads queues nothing until the listing says a hero has no art', async () => {
    const { PortraitCache } = await import('../../../src/ui/widgets');
    let files: Set<string> | null = null;
    let release: () => void = () => undefined;
    const listed = new Promise<void>((r) => (release = r));
    const rendered: string[] = [];
    const pc = new PortraitCache(
      async (id) => {
        rendered.push(id);
        return id;
      },
      { has: (p) => (files ? files.has(p) : null), ready: () => listed },
      1,
      0,
    );
    pc.prioritize(['guanyu', 'liubei', 'zhangfei', 'caocao']);
    // unknown yet: no render (and so no GLB / clip download) is started for any option
    expect(pc.pending()).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(rendered).toEqual([]);
    files = new Set([portraitArtPath('guanyu'), portraitArtPath('zhangfei')]);
    release();
    await pc.whenKnown();
    // queued by prioritize() itself once the listing is known (liubei already running)
    expect(rendered).toEqual(['liubei']);
    expect(pc.pending()).toEqual(['caocao']);
    await Promise.all([pc.get('liubei'), pc.get('caocao')]);
    // only the heroes without painted art are rendered, in option order
    expect(rendered).toEqual(['liubei', 'caocao']);
  });
});
