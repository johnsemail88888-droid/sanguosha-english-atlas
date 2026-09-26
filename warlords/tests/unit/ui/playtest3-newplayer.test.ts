// Playtest round-3 NEWPLAYER UI fixes: the first-match guide never spent behind the rotate
// cover (NP-3), touch-first tips and controls (NP-7), 初始武器 for a common starting gun
// (NP-8), no 诸葛连弩〔诸葛连弩〕 (NP-10), the Lord's crown off the map labels (NP-12),
// 乐不思蜀 → 乐 (NP-13) and the lord phase once the Lord has chosen (NP-15).
// Layout (NP-4 glyphs, NP-11 phone overlaps) is checked in tests/e2e/ui-harness.spec.ts.
import { afterEach, describe, expect, it } from 'vitest';
import type { HeroSelectView } from '../../../src/core/types';
import { HERO_BY_ID, WEAPONS, WEAPON_BY_ID } from '../../../src/data';
import { overrideLang, t } from '../../../src/ui/i18n';
import { guideClockRuns, guideMayMount } from '../../../src/ui/hud/guide';
import { LOADING_TIPS, loadingTip } from '../../../src/ui/screens/loading';
import { CONTROLS, TOUCH_CONTROLS, playerWeapons, touchCapLabels } from '../../../src/ui/screens/help';
import { isSignatureWeapon, weaponCardNote } from '../../../src/ui/screens/heroDetail';
import { clearOfLabels, type MapBox } from '../../../src/ui/hud/minimap';
import { itemLabel, itemShort, touchLabel } from '../../../src/ui/short';
import { lordWaitKey } from '../../../src/ui/screens/heroSelect';

afterEach(() => overrideLang(null));

describe('NP-3: the first-match guide and the rotate cover', () => {
  it('is not put up (nor counted) behind the rotate-to-landscape cover', () => {
    expect(guideMayMount(true)).toBe(false);
    expect(guideMayMount(false)).toBe(true);
  });

  it('its fade-out clock runs only while the card can be read', () => {
    expect(guideClockRuns({ overlay: 'none', rotating: false })).toBe(true);
    expect(guideClockRuns({ overlay: 'none', rotating: true })).toBe(false);
    // 「点击进入战场」 / the menu: not yet
    expect(guideClockRuns({ overlay: 'pause', rotating: false })).toBe(false);
  });
});

describe('NP-7: touch-first text', () => {
  const KEYS = /\b(Ctrl|Alt|Press T|[ZXCV] (follow|hold|attack|charge))\b|按 T|Z 跟随|Ctrl/;

  it('every tip naming a key has a touch wording with the on-screen button instead', () => {
    for (let i = 0; i < LOADING_TIPS.length; i++) {
      const [zh, en] = loadingTip(i, true);
      expect(zh, `tip ${i}`).not.toMatch(KEYS);
      expect(en, `tip ${i}`).not.toMatch(KEYS);
    }
    // the buttons as the screen labels them
    const all = LOADING_TIPS.map((_, i) => loadingTip(i, true));
    expect(all.some(([zh, en]) => zh.includes(`「${touchLabel('wheel', 'zh')}」`) && en.includes(`“${touchLabel('wheel', 'en')}”`))).toBe(true);
    expect(all.some(([zh, en]) => zh.includes(`「${touchLabel('dodge', 'zh')}」`) && en.includes(`“${touchLabel('dodge', 'en')}”`))).toBe(true);
    expect(all.some(([zh]) => zh.includes('「随」') && zh.includes('随 → 守 → 攻 → 冲'))).toBe(true);
  });

  it('desktop keeps the key tips; the index wraps', () => {
    const desk = LOADING_TIPS.map((_, i) => loadingTip(i, false)[0]);
    expect(desk.some((s) => s.includes('按 T'))).toBe(true);
    expect(desk.some((s) => s.includes('Ctrl'))).toBe(true);
    expect(loadingTip(LOADING_TIPS.length + 3, true)).toEqual(loadingTip(3, true));
    expect(loadingTip(-1, false)).toEqual(loadingTip(LOADING_TIPS.length - 1, false));
  });

  it('the touch controls read like the buttons: 装弹 (not 换弹), 切枪, long-press → 丢弃此锦囊, 随 → 守 → 攻 → 冲', () => {
    const zh = TOUCH_CONTROLS.map((r) => `${touchCapLabels(r, 'zh').join(' ')} ${r.zh}`).join('\n');
    expect(zh).not.toContain('换弹');
    expect(zh).toContain('装弹');
    expect(zh).toContain('切枪');
    overrideLang('zh');
    expect(zh).toContain(`「${t('hud.discard')}」`);
    expect(zh).toContain('长按');
    expect(zh).toContain('随 跟随 → 守 驻守 → 攻 进攻 → 冲 冲锋');
    const reload = TOUCH_CONTROLS.find((r) => r.caps.includes('reload'))!;
    expect(touchCapLabels(reload, 'zh')).toEqual(['装弹']);
    expect(touchCapLabels(reload, 'en')).toEqual(['Reload']);
    overrideLang('en');
    const order = TOUCH_CONTROLS.find((r) => r.caps.includes('order'))!;
    expect(touchCapLabels(order, 'zh')).toEqual(['随']);
    expect(touchCapLabels(order, 'en')).toEqual(['Follow']);
    const en = TOUCH_CONTROLS.map((r) => r.en).join('\n');
    expect(en).toContain('long-press');
    expect(en).toContain('Discard this card');
    // no keyboard keys on the touch sheet, and every touch button is on it
    for (const r of TOUCH_CONTROLS) expect(r.zh, r.zh).not.toMatch(/Ctrl|Shift|按住 X|鼠标/);
    const caps = new Set(TOUCH_CONTROLS.flatMap((r) => r.caps.filter((c) => typeof c === 'string')));
    for (const k of ['fire', 'ads', 'jump', 'dodge', 'reload', 'swap', 'interact', 'mark', 'wheel', 'chat', 'map', 'score', 'menu', 'order']) expect(caps.has(k as never), k).toBe(true);
    // the keyboard table is unchanged (R 换弹 is what shooters call it on a keyboard)
    expect(CONTROLS.find((c) => c.keys[0] === 'R')?.zh).toBe('换弹');
  });
});

describe('NP-8: 专属武器 / 初始武器', () => {
  it('a common gun anyone may start with is a starting weapon, a named one is the hero’s own', () => {
    for (const id of ['zhangliao', 'daqiao', 'zhenji', 'luxun', 'guojia', 'xiahouyuan', 'yuanshao']) {
      expect(isSignatureWeapon(WEAPON_BY_ID[HERO_BY_ID[id].signatureWeapon]), id).toBe(false);
    }
    for (const id of ['guanyu', 'zhaoyun', 'lubu', 'caocao', 'liubei', 'zhugeliang', 'huangzhong']) {
      expect(isSignatureWeapon(WEAPON_BY_ID[HERO_BY_ID[id].signatureWeapon]), id).toBe(true);
    }
    overrideLang('zh');
    expect([t('select.signature'), t('select.startWeapon')]).toEqual(['专属武器', '初始武器']);
    overrideLang('en');
    expect([t('select.signature'), t('select.startWeapon')]).toEqual(['Signature weapon', 'Starting weapon']);
  });
});

describe('NP-10: the 〔card〕 note only when it differs from the name', () => {
  it('诸葛连弩 / 丈八蛇矛 / 朱雀羽扇 / 方天画戟 / 麒麟弓 get none, 青釭〔青釭剑〕 keeps its', () => {
    for (const id of ['zhuge', 'zhangba', 'zhuque', 'fangtian', 'qilin']) expect(weaponCardNote(WEAPON_BY_ID[id]), id).toBeNull();
    expect(weaponCardNote(WEAPON_BY_ID.qinggang)).toBe('〔青釭剑〕');
    expect(weaponCardNote(WEAPON_BY_ID.cixiong)).toBe('〔雌雄双股剑〕');
    expect(weaponCardNote(WEAPON_BY_ID.carbine)).toBeNull();
    for (const w of playerWeapons()) expect(weaponCardNote(w), w.id).not.toBe(`〔${w.nameZh}〕`);
    expect(WEAPONS.filter((w) => weaponCardNote(w)).length).toBeGreaterThan(3);
  });
});

describe('NP-12: the Lord’s crown keeps off the region labels', () => {
  const label: MapBox = { x0: 100, y0: 190, x1: 180, y1: 210 };

  it('stays put when it covers nothing', () => {
    expect(clearOfLabels(60, 200, 8, 6, [label], 600)).toEqual({ x: 60, y: 200, moved: false });
    expect(clearOfLabels(140, 170, 8, 6, [label], 600).moved).toBe(false);
  });

  it('moves just above the label from its upper half, just below from its lower half', () => {
    const up = clearOfLabels(140, 198, 8, 6, [label], 600, 2);
    expect(up).toEqual({ x: 140, y: 190 - 2 - 6, moved: true });
    const down = clearOfLabels(140, 205, 8, 6, [label], 600, 2);
    expect(down).toEqual({ x: 140, y: 210 + 2 + 6, moved: true });
    // either way it no longer overlaps the label
    for (const p of [up, down]) expect(p.y + 6 <= label.y0 || p.y - 6 >= label.y1).toBe(true);
  });

  it('never leaves the map: a label at the top edge sends it below', () => {
    const top: MapBox = { x0: 100, y0: 2, x1: 180, y1: 20 };
    expect(clearOfLabels(140, 8, 8, 6, [top], 600, 2).y).toBe(20 + 2 + 6);
  });
});

describe('NP-13: 乐不思蜀 reads 乐', () => {
  it('is 乐 (like 桃, it repeats the glyph: hidden without the painted emblem)', () => {
    expect(itemShort('lebusishu', 'zh')).toBe('乐');
    expect(itemLabel('lebusishu', 'zh')).toEqual({ text: '乐', dup: true });
    expect(itemShort('lebusishu', 'en')).toBe('Dance');
  });
});

describe('NP-15: the lord phase once the Lord has chosen', () => {
  const view = (picks: Record<number, string>): Pick<HeroSelectView, 'picks'> => ({ picks });

  it('reads 等待主公选将… until the crown(s) picked, then 主公已选定，即将开始选将…', () => {
    expect(lordWaitKey(view({}), [0])).toBe('select.waitLord');
    expect(lordWaitKey(view({ 0: 'yuanshao' }), [0])).toBe('select.lordDone');
    expect(lordWaitKey(view({ 0: 'yuanshao' }), [0, 3])).toBe('select.crownsPicking');
    expect(lordWaitKey(view({ 0: 'yuanshao', 3: 'caocao' }), [0, 3])).toBe('select.crownsDone');
    overrideLang('zh');
    expect(t('select.lordDone')).toBe('主公已选定，即将开始选将…');
    overrideLang('en');
    expect(t('select.lordDone')).toBe('The Lord has chosen — hero select starts shortly…');
  });
});
