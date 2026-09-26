// Playtest round-2 PLATFORM fixes (phones): touch labels that cannot be misread
// (PLATFORM-5), the interact button naming what a tap does, the touch guide that
// fits its corner of the screen (PLATFORM-10) and the portrait prefetch order
// (PLATFORM-12). Layout itself is checked in tests/e2e/ui-harness.spec.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { HEROES } from '../../../src/data';
import { overrideLang } from '../../../src/ui/i18n';
import { TOUCH_LABEL, interactLabel, touchLabel, type InteractKind } from '../../../src/ui/short';
import { labelClass } from '../../../src/ui/touch';
import { GUIDE_FIT_STEPS, fitGuideCard, guideLines } from '../../../src/ui/hud/guide';
import { interactText } from '../../../src/ui/hud/combat';
import { PortraitCache, portraitPrefetchPlan } from '../../../src/ui/widgets';
import { portraitArtPath } from '../../../src/ui/art';

afterEach(() => overrideLang(null));

describe('PLATFORM-5: touch button labels', () => {
  it('reload / swap / interact read 装弹 / 切枪 / 互动 — never a lone 换 (换弹?) or a Latin F', () => {
    expect(touchLabel('reload', 'zh')).toBe('装弹');
    expect(touchLabel('swap', 'zh')).toBe('切枪');
    expect(touchLabel('interact', 'zh')).toBe('互动');
    expect(touchLabel('interact', 'en')).toBe('Use');
    for (const [key, [zh, en]] of Object.entries(TOUCH_LABEL)) {
      // every Chinese label is one or two glyphs, and none is a bare key letter
      expect([...zh].length, key).toBeLessThanOrEqual(2);
      if (key !== 'menu') expect(/^[A-Za-z]$/.test(zh), key).toBe(false);
      expect(en.length, key).toBeGreaterThan(0);
    }
  });

  it('the interact button says what a tap does now, 互动 when nothing is in reach', () => {
    const zh: Record<InteractKind, string> = { pickup: '拾取', full: '替换', crate: '打开', airdrop: '打开', revive: '救援', selfRevive: '互动' };
    for (const [k, v] of Object.entries(zh)) expect(interactLabel(k as InteractKind, 'zh'), k).toBe(v);
    expect(interactLabel(null, 'zh')).toBe('互动');
    expect(interactLabel(undefined, 'en')).toBe('Use');
    expect(interactLabel('revive', 'en')).toBe('Revive');
    expect(interactLabel('pickup', 'en')).toBe('Take');
  });

  it('two glyphs get the smaller `two` size, Latin words the body font', () => {
    expect(labelClass('装弹')).toEqual({ word: false, two: true });
    expect(labelClass('射')).toEqual({ word: false, two: false });
    expect(labelClass('Reload')).toEqual({ word: true, two: false });
    expect(labelClass('F')).toEqual({ word: false, two: false });
    expect(labelClass('☰')).toEqual({ word: false, two: false });
  });

  it('the revive prompt on touch names the button, not the F key', () => {
    const p = { kind: 'revive' as const, targetId: 7, heroId: 'huatuo', name: '刘玄德', needPeach: false };
    expect(interactText(p, 'zh', false).text).toContain('按住 F');
    expect(interactText(p, 'zh', true).text).toBe('按住「救援」救起 华佗·刘玄德');
    overrideLang('en');
    expect(interactText(p, 'en', true).text).not.toMatch(/\bF\b/);
    expect(interactText(p, 'en', true).text).toContain('Hold Revive');
  });
});

describe('PLATFORM-10: the touch guide', () => {
  it('touch lines are the short wording (no 「触屏：」 on a touch screen), desktop keeps the long one', () => {
    const touch = guideLines(true, 'zh');
    const desk = guideLines(false, 'zh');
    expect(touch).toHaveLength(desk.length);
    expect(touch.find((l) => l.keys[0] === 'Shift')?.text).toBe('冲刺：摇杆推到底');
    expect(desk.find((l) => l.keys[0] === 'Shift')?.text).toBe('冲刺（触屏：摇杆推到底）');
    expect(touch.every((l) => !l.text.includes('触屏'))).toBe(true);
    // English on touch: every line shorter than (or as long as) the desktop one
    const en = guideLines(true, 'en');
    guideLines(false, 'en').forEach((l, i) => expect(en[i].text.length, l.text).toBeLessThanOrEqual(l.text.length));
  });

  /** a card whose content height depends on the fit classes applied */
  const fakeCard = (content: number, box: number, savings: Record<string, number>) => {
    const cls = new Set<string>();
    return {
      cls,
      classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) },
      get clientHeight() {
        return box;
      },
      get scrollHeight() {
        let h = content;
        for (const c of cls) h -= savings[c] ?? 0;
        return Math.max(h, box);
      },
    };
  };

  it('fitGuideCard steps through tighter / wider layouts only until nothing is clipped', () => {
    const savings = { 'fit-tight': 20, 'fit-wide': 40, 'fit-lean': 30 };
    // fits as it is (844×390 in Chinese … on a tablet): no step
    let card = fakeCard(150, 190, savings);
    expect(fitGuideCard(card as unknown as HTMLElement)).toEqual([]);
    // a little too tall: the tighter type is enough
    card = fakeCard(205, 190, savings);
    expect(fitGuideCard(card as unknown as HTMLElement)).toEqual(['fit-tight']);
    // English on a small phone: wider, then into the stick zone's edge
    card = fakeCard(270, 190, savings);
    expect(fitGuideCard(card as unknown as HTMLElement)).toEqual([...GUIDE_FIT_STEPS]);
    // refitting (the screen turned / grew) starts again from the default layout
    card.cls.add('stale');
    const big = fakeCard(150, 190, savings);
    for (const c of GUIDE_FIT_STEPS) big.cls.add(c);
    expect(fitGuideCard(big as unknown as HTMLElement)).toEqual([]);
    expect([...big.cls]).toEqual([]);
  });
});

describe('PLATFORM-12: portrait prefetch order', () => {
  const all = HEROES.map((x) => x.id);

  it('offered heroes first, then the picks, each once; every other hero after, in list order', () => {
    const plan = portraitPrefetchPlan(['zhouyu', 'luxun', 'caocao', 'liubei', 'caocao', undefined, null], all);
    expect(plan.first).toEqual(['zhouyu', 'luxun', 'caocao', 'liubei']);
    expect(plan.rest).toHaveLength(all.length - 4);
    expect(plan.rest.some((id) => plan.first.includes(id))).toBe(false);
    expect(plan.rest).toEqual(all.filter((id) => !plan.first.includes(id)));
  });

  it('PortraitCache.prefetch asks for the shown heroes at high priority before the rest, once each, only shipped files', async () => {
    type Img = { src: string; fetchPriority: string; decoding: string; onload: (() => void) | null; onerror: (() => void) | null };
    const made: Img[] = [];
    const g = globalThis as unknown as { Image?: unknown };
    const Orig = g.Image;
    g.Image = class {
      src = '';
      fetchPriority = '';
      decoding = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        made.push(this);
      }
    };
    try {
      const shipped = new Set(['zhouyu', 'luxun', 'liubei', 'guanyu'].map(portraitArtPath));
      const pc = new PortraitCache(async () => '', { has: (p) => shipped.has(p), ready: () => Promise.resolve() });
      const plan = portraitPrefetchPlan(['zhouyu', 'luxun', 'caocao', 'liubei'], all);
      let firstDone = false;
      const first = pc.prefetch(plan.first, 'high').then(() => (firstDone = true));
      // caocao ships no portrait: nothing asked for it
      expect(made.map((i) => i.src)).toEqual(['zhouyu', 'luxun', 'liubei'].map(portraitArtPath));
      expect(made.every((i) => i.fetchPriority === 'high')).toBe(true);
      await Promise.resolve();
      expect(firstDone).toBe(false);
      made[0].onload?.();
      made[1].onerror?.();
      made[2].onload?.();
      await first;
      expect(firstDone).toBe(true);
      void pc.prefetch(plan.rest, 'low');
      expect(made.slice(3).map((i) => [i.src, i.fetchPriority])).toEqual([[portraitArtPath('guanyu'), 'low']]);
      // asked once: a second round (a new pick) re-requests nothing
      void pc.prefetch(['zhouyu', 'guanyu'], 'high');
      expect(made).toHaveLength(4);
    } finally {
      g.Image = Orig;
    }
  });

  it('while the art listing loads nothing is requested; once it is known, the files are', async () => {
    const made: string[] = [];
    const g = globalThis as unknown as { Image?: unknown };
    const Orig = g.Image;
    g.Image = class {
      decoding = '';
      fetchPriority = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(v: string) {
        made.push(v);
      }
    };
    try {
      let files: Set<string> | null = null;
      let release: () => void = () => undefined;
      const ready = new Promise<void>((r) => (release = r));
      const pc = new PortraitCache(async () => '', { has: (p) => (files ? files.has(p) : null), ready: () => ready });
      void pc.prefetch(['luxun'], 'high');
      expect(made).toEqual([]);
      files = new Set([portraitArtPath('luxun')]);
      release();
      await ready;
      await Promise.resolve();
      await Promise.resolve();
      expect(made).toEqual([portraitArtPath('luxun')]);
    } finally {
      g.Image = Orig;
    }
  });
});
