// Playtest round-2 UI fixes: readable inks on parchment (UX-1, UX-9), the 玩法说明
// weapon table (UX-2), card labels (UX-9), draw results (UX-13), the name field
// (UX-14), kill-feed rows that keep hero + role (UX-15), and the full-item-bar
// prompt / discard hint (COMBAT-7).
import { afterEach, describe, expect, it } from 'vitest';
import type { GameResult, PrivateHeroView, ViewEntity } from '../../../src/core/types';
import { ARMORS, HEROES, ITEMS, MOUNTS, WEAPONS } from '../../../src/data';
import { overrideLang } from '../../../src/ui/i18n';
import { PARCHMENT_DARK, RARITY_COLOR, RARITY_INK, cardTileVars, contrastRatio, glyphInk, inkOn } from '../../../src/ui/theme';
import { ITEM_SHORT, itemLabel, itemShort } from '../../../src/ui/short';
import { CONTROLS, playerWeapons } from '../../../src/ui/screens/help';
import { buildOverRows, rowResult } from '../../../src/ui/screens/gameOver';
import { isGeneratedName, nameFieldModel } from '../../../src/ui/widgets';
import { fitFeedRow } from '../../../src/ui/hud/feed';
import { deriveInteract } from '../../../src/ui/hud/logic';
import { interactText } from '../../../src/ui/hud/combat';
import { hasRemotePlayers } from '../../../src/ui/hud/overlays';
import { isFatalSessionError } from '../../../src/ui/app';
import { isReconnectable } from '../../../src/ui/invite';

afterEach(() => overrideLang(null));

/** the parchment tones text sits on: panel top, middle, bottom; HUD card top / bottom */
const PARCHMENTS = ['#f3e7cb', '#e6d3a8', PARCHMENT_DARK, '#fbf3de', '#e2cf9f'];

describe('UX-1: rarity names readable on parchment', () => {
  it('every rarity ink is ≥ 4.5:1 on every parchment tone, and the four stay distinct', () => {
    for (const [r, c] of Object.entries(RARITY_INK)) for (const bg of PARCHMENTS) expect(contrastRatio(c, bg), `${r} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(new Set(Object.values(RARITY_INK)).size).toBe(4);
    // the pale tones were the bug (杀 / 闪 / 桃 in #b9b2a2 ≈ 1.6:1); they stay for the dark HUD
    expect(contrastRatio(RARITY_COLOR.common, '#ede1c4')).toBeLessThan(2);
    expect(contrastRatio(RARITY_COLOR.common, '#15100b')).toBeGreaterThan(4.5);
  });

  it('contrastRatio follows WCAG (black on white 21:1, same color 1:1)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#8a8a8a', '#8a8a8a')).toBeCloseTo(1, 5);
  });
});

describe('UX-2: the 玩法说明 weapon table lists only what a hero can hold', () => {
  it('no troop / NPC / turret weapons (黄巾力士 hammer, elephant tusks); lootable first, signatures after', () => {
    const list = playerWeapons();
    expect(list.some((w) => /^(troop|npc|turret)_/.test(w.id))).toBe(false);
    expect(list.map((w) => w.id)).not.toContain('npc_hammer');
    expect(list.map((w) => w.id)).not.toContain('npc_tusk');
    const firstSig = list.findIndex((w) => !w.lootable);
    expect(firstSig).toBeGreaterThan(0);
    expect(list.slice(firstSig).every((w) => !w.lootable)).toBe(true);
    // every hero's signature weapon is still there
    for (const h of HEROES) if (h.signatureWeapon) expect(list.map((w) => w.id), h.id).toContain(h.signatureWeapon);
    expect(list.length).toBe(WEAPONS.filter((w) => !/^(troop|npc|turret)_/.test(w.id)).length);
  });
});

describe('UX-9: HUD card labels', () => {
  it('Chinese labels are at most two glyphs (无中 / 借刀 / 乐不 …), English unchanged', () => {
    for (const it of ITEMS) expect([...itemShort(it.id, 'zh')].length, it.id).toBeLessThanOrEqual(2);
    expect(['wuzhong', 'guohe', 'shunshou', 'jiedao', 'wuxie', 'nanman', 'wanjian', 'taoyuan', 'wugu', 'tiesuo', 'lebusishu', 'bingliang'].map((id) => itemShort(id, 'zh'))).toEqual([
      '无中', '过河', '顺手', '借刀', '无懈', '南蛮', '万箭', '桃园', '五谷', '铁索', '乐不', '兵粮',
    ]);
    expect(itemShort('wuzhong', 'en')).toBe('Draw 2');
    expect(Object.keys(ITEM_SHORT).length).toBe(ITEMS.length);
  });

  it('with the emblem on, 杀 / 闪 / 桃 / 酒 get a label too (it only repeats the glyph without art: dup)', () => {
    for (const id of ['sha', 'shan', 'tao', 'jiu']) expect(itemLabel(id, 'zh'), id).toEqual({ text: ITEMS.find((x) => x.id === id)!.icon, dup: true });
    expect(itemLabel('wuzhong', 'zh')).toEqual({ text: '无中', dup: false });
    expect(itemLabel('tao', 'en')).toEqual({ text: 'Peach', dup: false });
  });

  it('every card colour, darkened by inkOn(), reads ≥ 4.5:1 on the card parchment and keeps its hue', () => {
    for (const it of ITEMS) {
      const ink = inkOn(it.color);
      for (const bg of PARCHMENTS) expect(contrastRatio(ink, bg), `${it.id} ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // the big glyph (shown until the emblem loads, and in the single-file build): large text, ≥ 3:1
    for (const x of [...ITEMS, ...ARMORS, ...MOUNTS]) {
      expect(contrastRatio(glyphInk(x.color), PARCHMENT_DARK), x.id).toBeGreaterThanOrEqual(3);
      expect(cardTileVars(x.color)).toBe(`--ic:${x.color};--ig:${glyphInk(x.color)}`);
    }
    // already dark enough: unchanged
    expect(inkOn('#2b1d12')).toBe('#2b1d12');
    expect(inkOn('not a color')).toBe('#2b1d12');
  });
});

describe('UX-13: a draw is nobody’s defeat', () => {
  const players = [0, 1, 2].map((i) => ({ playerId: `p${i}`, name: `人机${i}`, isBot: true, seat: i, entityId: 100 + i, heroId: HEROES[i].id, kingdom: HEROES[i].kingdom, alive: false, downed: false, kills: 0 }));
  const draw: GameResult = { winner: 'draw', winners: [], roles: { 100: 'lord', 101: 'rebel', 102: 'traitor' }, reasonZh: '同归于尽', reasonEn: 'Everyone fell', durationSec: 300, mvp: null } as unknown as GameResult;

  it('every row reads 平 / Draw (not 败), a neutral who still won keeps 胜', () => {
    expect(buildOverRows(draw, players, 100).map((r) => r.res)).toEqual(['draw', 'draw', 'draw']);
    expect(rowResult({ ...draw, winners: [102] } as GameResult, 102)).toBe('won');
    const lordWin = { ...draw, winner: 'lord', winners: [100] } as GameResult;
    expect(buildOverRows(lordWin, players, 100).map((r) => r.res)).toEqual(['won', 'lost', 'lost']);
  });
});

describe('UX-14: the name field shows a generated name as its placeholder', () => {
  it('无名885: empty field, "Nameless 885" placeholder in English; clearing keeps the generated name', () => {
    expect(isGeneratedName('无名885')).toBe(true);
    expect(isGeneratedName('无名英雄')).toBe(false);
    const en = nameFieldModel('无名885', 'en', 'Enter a name');
    expect(en.value).toBe('');
    expect(en.placeholder).toBe('Nameless 885');
    expect(en.toStored('关二')).toBe('关二');
    expect(en.toStored('')).toBe('无名885');
    expect(en.toStored('  ')).toBe('无名885');
    expect(nameFieldModel('无名885', 'zh', '输入名号').placeholder).toBe('无名885');
    const typed = nameFieldModel('关二', 'en', 'Enter a name');
    expect(typed).toMatchObject({ value: '关二', placeholder: 'Enter a name' });
    expect(typed.toStored('')).toBe('');
    expect(nameFieldModel('', 'en', 'Enter a name')).toMatchObject({ value: '', placeholder: 'Enter a name' });
    expect(en.toStored('a'.repeat(30))).toHaveLength(16);
  });
});

describe('UX-15: a kill-feed row that does not fit drops player names, never the role', () => {
  const row = (): HTMLElement & { cls: Set<string> } => {
    const cls = new Set<string>();
    return { cls, classList: { add: (c: string) => cls.add(c), contains: (c: string) => cls.has(c) } } as unknown as HTMLElement & { cls: Set<string> };
  };

  it('fits: untouched; too long: the killer’s player name goes first, then the victim’s', () => {
    const a = row();
    fitFeedRow(a, () => false);
    expect([...a.cls]).toEqual([]);
    // fits once the killer's name is gone
    const b = row();
    fitFeedRow(b, (r) => !r.classList.contains('tight-k'));
    expect([...b.cls]).toEqual(['tight-k']);
    // still too long: both player names go (hero names + the role seal stay)
    const c = row();
    fitFeedRow(c, () => true);
    expect([...c.cls]).toEqual(['tight-k', 'tight']);
  });
});

describe('COMBAT-7: the full-bar prompt says what F swaps and how to discard', () => {
  const me = (items: PrivateHeroView['items']): PrivateHeroView => ({
    entityId: 1, heroId: HEROES[0].id, role: 'loyalist', hp: 300, maxHp: 300, shield: 0,
    weapons: [{ id: 'pistol', mag: 12, reserve: 48 }, null], activeSlot: 0, items, armor: null, mount: null,
    cooldowns: {}, charges: {}, abilityState: {}, dodgeCharges: 2, reloading: 0, channel: null,
    downed: false, downedRemaining: 0, dead: false, statuses: [], squad: [], order: { kind: 'follow' },
    stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
  });
  const tao: ViewEntity = { id: 9, kind: 'loot', sub: 'tao', x: 0, y: 0, z: -1, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 };
  const four: PrivateHeroView['items'] = [
    { id: 'wugu', count: 1 },
    { id: 'jiedao', count: 1 },
    { id: 'tiesuo', count: 1 },
    { id: 'wuxie', count: 1 },
  ];

  it('F: take 桃, drop slot 7’s 无懈可击 — with the X + 4–7 hint (long-press on touch)', () => {
    const p = deriveInteract(me(four), { x: 0, y: 0, z: 0, yaw: 0 }, [tao]);
    expect(p).toMatchObject({ kind: 'full', itemId: 'tao', swapSlot: 3, swapId: 'wuxie' });
    overrideLang('zh');
    const zh = interactText(p!, 'zh');
    expect(zh.key).toBe('F');
    expect(zh.text).toContain('桃');
    expect(zh.text).toContain('7');
    expect(zh.text).toContain('无懈可击');
    expect(zh.sub).toContain('锦囊栏已满');
    expect(zh.sub).toContain('X');
    expect(interactText(p!, 'zh', true).sub).toContain('长按');
    overrideLang('en');
    const en = interactText(p!, 'en');
    expect(en.text).toMatch(/^Take Peach.*, drop .+ \(slot 7\)$/);
    expect(en.sub).toContain('X + 4–7');
  });

  it('nothing to swap (four full stacks of 桃): no F key, just the warning', () => {
    const peaches = [0, 1, 2, 3].map(() => ({ id: 'tao', count: 3 }));
    const p = deriveInteract(me(peaches), { x: 0, y: 0, z: 0, yaw: 0 }, [tao]);
    overrideLang('zh');
    expect(interactText(p!, 'zh')).toEqual({ key: '', text: '桃', sub: '锦囊栏已满' });
  });

  it('the controls list teaches the discard chord', () => {
    expect(CONTROLS.some((c) => c.keys.join(' ').includes('X') && c.keys.join(' ').includes('4–7') && c.zh.includes('丢弃'))).toBe(true);
  });
});

describe('UX-19: the scoreboard ping column only with remote players', () => {
  const p = (entityId: number, isBot: boolean) => ({ playerId: `p${entityId}`, name: 'x', isBot, seat: entityId, entityId, heroId: HEROES[0].id, kingdom: HEROES[0].kingdom, alive: true, downed: false, kills: 0 });
  it('single player (you + bots): no 延迟 column; a second human: the column is back', () => {
    expect(hasRemotePlayers([p(1, false), p(2, true), p(3, true)], 1)).toBe(false);
    expect(hasRemotePlayers([p(1, false), p(2, true), p(3, false)], 1)).toBe(true);
    // spectating before your entity is known: other humans still count
    expect(hasRemotePlayers([p(1, false), p(2, true)], null)).toBe(true);
  });
});

describe('a guest who lost the host is offered 重新连接', () => {
  it('lost links are reconnectable; being kicked / the room closing / a full room are not', () => {
    for (const c of ['connectionLost', 'timeout', 'closed', 'serverUnreachable', 'networkRestricted']) {
      expect(isReconnectable(c), c).toBe(true);
      expect(isFatalSessionError(c), c).toBe(true);
    }
    for (const c of ['kicked', 'hostLeft', 'roomNotFound', 'roomFull', 'versionMismatch', 'inProgress', 'simFailed']) expect(isReconnectable(c), c).toBe(false);
  });
});
