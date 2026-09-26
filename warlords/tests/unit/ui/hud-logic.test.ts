import { describe, expect, it } from 'vitest';
import type { PrivateHeroView, PublicPlayerView, ViewEntity, ZoneView } from '../../../src/core/types';
import { VF_AIRBORNE, VF_DEAD, VF_DOWNED, VF_EXPOSED, VF_OPENED, VF_STEALTH } from '../../../src/core/types';
import { HEROES, HERO_BY_ID, WEAPONS, isPassiveAbility } from '../../../src/data';
import { crownKind, isMapVisible } from '../../../src/ui/hud/minimap';
import {
  BASE_DODGE_CHARGES,
  abilityReady,
  canReviveFree,
  maxDodgeCharges,
  aliveCount,
  cooldownFraction,
  crosshairStyle,
  cycleSpectate,
  deniedText,
  deriveInteract,
  distanceOutsideZone,
  entityLabel,
  filledTicks,
  hpTicks,
  hudAbilities,
  relativeBearing,
  spreadToPx,
  UiKeyDeduper,
  zoneStatus,
} from '../../../src/ui/hud/logic';

function me(over: Partial<PrivateHeroView> = {}): PrivateHeroView {
  return {
    entityId: 1,
    heroId: HEROES[0].id,
    role: 'loyalist',
    hp: 300,
    maxHp: 400,
    shield: 0,
    weapons: [{ id: 'pistol', mag: 12, reserve: 48 }, null],
    activeSlot: 0,
    items: [null, null, null, null],
    armor: null,
    mount: null,
    cooldowns: {},
    charges: {},
    abilityState: {},
    dodgeCharges: 2,
    reloading: 0,
    channel: null,
    downed: false,
    downedRemaining: 0,
    dead: false,
    statuses: [],
    squad: [],
    order: { kind: 'follow' },
    stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
    ...over,
  };
}

function ent(id: number, kind: ViewEntity['kind'], sub: string, x: number, z: number, flags = 0, extra: Partial<ViewEntity> = {}): ViewEntity {
  return { id, kind, sub, x, y: 0, z, yaw: 0, pitch: 0, speed: 0, hp: 100, maxHp: 100, shield: 0, flags, ...extra };
}

const zone = (over: Partial<ZoneView> = {}): ZoneView => ({
  phase: 1,
  center: { x: 0, y: 0, z: 0 },
  radius: 100,
  targetCenter: { x: 10, y: 0, z: 0 },
  targetRadius: 50,
  shrinkStart: 100,
  shrinkEnd: 160,
  dps: 4,
  ...over,
});

describe('HP ticks (勾玉)', () => {
  it('one tick per 100 HP', () => {
    expect(hpTicks(300)).toBe(3);
    expect(hpTicks(500)).toBe(5);
    expect(hpTicks(40)).toBe(1);
  });
  it('partially filled ticks count as filled', () => {
    expect(filledTicks(400, 400)).toBe(4);
    expect(filledTicks(301, 400)).toBe(4);
    expect(filledTicks(300, 400)).toBe(3);
    expect(filledTicks(1, 400)).toBe(1);
    expect(filledTicks(0, 400)).toBe(0);
    expect(filledTicks(999, 400)).toBe(4);
  });
});

describe('zone status', () => {
  it('waits, shrinks, then settles', () => {
    expect(zoneStatus(zone(), 70)).toEqual({ kind: 'wait', secs: 30 });
    expect(zoneStatus(zone(), 130)).toEqual({ kind: 'shrink', secs: 30 });
    expect(zoneStatus(zone(), 200).kind).toBe('final');
  });
  it('measures distance outside the circle', () => {
    expect(distanceOutsideZone(50, 0, zone())).toBe(0);
    expect(distanceOutsideZone(130, 0, zone())).toBeCloseTo(30);
  });
});

describe('abilities', () => {
  const lordHero = HEROES.find((h) => h.abilities.some((a) => a.slot === 'lord'));
  it('shows the lord skill only to the real lord', () => {
    if (!lordHero) return;
    const asLord = hudAbilities(lordHero, 'lord').map((a) => a.def.slot);
    const asDouble = hudAbilities(lordHero, 'double').map((a) => a.def.slot);
    expect(asLord).toContain('lord');
    expect(asDouble).not.toContain('lord');
    expect(asLord[0]).toBe('passive');
    expect(hudAbilities(lordHero, 'lord').find((a) => a.def.slot === 'lord')?.key).toBe('G');
  });
  it('returns nothing for unknown heroes', () => {
    expect(hudAbilities(undefined, 'lord')).toEqual([]);
  });
  it('shows passive lord skills (袁绍 血裔) without a key and not clickable', () => {
    const passiveLord = HEROES.find((h) => h.abilities.some((a) => a.slot === 'lord' && isPassiveAbility(a)));
    if (!passiveLord) return;
    const views = hudAbilities(passiveLord, 'lord');
    const lord = views.find((a) => a.def.slot === 'lord');
    expect(lord).toMatchObject({ key: '', active: false });
    for (const v of views.filter((a) => a.def.slot === 'q' || a.def.slot === 'e')) expect(v.active).toBe(true);
    for (const v of views.filter((a) => a.def.slot === 'passive')) expect(v).toMatchObject({ key: '', active: false });
  });
  it('charge-based abilities stay ready while a charge is left', () => {
    const charged = HEROES.flatMap((h) => h.abilities).find((a) => (a.charges ?? 0) > 1);
    const plain = HEROES.flatMap((h) => h.abilities).find((a) => !a.charges && a.cooldown);
    if (charged) {
      expect(abilityReady(charged, 7, 1)).toBe(true); // recharging the 2nd charge
      expect(abilityReady(charged, 7, 0)).toBe(false);
      expect(abilityReady(charged, 0, undefined)).toBe(true); // not sent yet → full
    }
    if (plain) {
      expect(abilityReady(plain, 3, undefined)).toBe(false);
      expect(abilityReady(plain, 0, undefined)).toBe(true);
    }
  });
  it('reads max dodge charges from hero data', () => {
    expect(maxDodgeCharges(undefined)).toBe(BASE_DODGE_CHARGES);
    expect(maxDodgeCharges('no-such-hero')).toBe(BASE_DODGE_CHARGES);
    for (const h of HEROES) {
      const extra = h.abilities.map((a) => a.params?.maxDodges).find((m) => typeof m === 'number');
      expect(maxDodgeCharges(h.id)).toBe(Math.max(BASE_DODGE_CHARGES, extra ?? 0));
    }
    if (HERO_BY_ID.zhaoyun) expect(maxDodgeCharges('zhaoyun')).toBe(3);
  });
  it('knows who can revive without a peach (data-driven, cooldown-aware)', () => {
    const healer = HEROES.find((h) => h.abilities.some((a) => typeof a.params?.freeReviveCd === 'number'));
    const other = HEROES.find((h) => !h.abilities.some((a) => typeof a.params?.freeReviveCd === 'number'));
    if (other) expect(canReviveFree({ heroId: other.id, cooldowns: {} })).toBe(false);
    if (healer) {
      const ab = healer.abilities.find((a) => typeof a.params?.freeReviveCd === 'number')!;
      expect(canReviveFree({ heroId: healer.id, cooldowns: {} })).toBe(true);
      expect(canReviveFree({ heroId: healer.id, cooldowns: { [ab.id]: 12 } })).toBe(false);
      const downed = [ent(2, 'hero', (other ?? healer).id, 1, 1, VF_DOWNED)];
      const p = deriveInteract(me({ heroId: healer.id, cooldowns: { [ab.id]: 12 } }), { x: 0, y: 0, z: 0 }, downed);
      expect(p?.kind === 'revive' && p.needPeach).toBe(true);
    }
  });
  it('cooldown fraction is clamped', () => {
    expect(cooldownFraction(0, 10)).toBe(0);
    expect(cooldownFraction(5, 10)).toBe(0.5);
    expect(cooldownFraction(15, 10)).toBe(1);
    expect(cooldownFraction(3, undefined)).toBe(1);
  });
});

describe('crosshair', () => {
  it('maps weapon classes to styles', () => {
    expect(crosshairStyle('rifle')).toBe('cross');
    expect(crosshairStyle('shotgun')).toBe('circle');
    expect(crosshairStyle('sniper')).toBe('dot');
    expect(crosshairStyle('bow')).toBe('bow');
    expect(crosshairStyle('launcher')).toBe('launcher');
    expect(crosshairStyle(undefined)).toBe('cross');
  });
  it('spread grows with angle and shrinks with zoom', () => {
    const a = spreadToPx(1, 75, 1080);
    const b = spreadToPx(2, 75, 1080);
    const zoomed = spreadToPx(1, 75 / 3.5, 1080);
    expect(b).toBeGreaterThan(a);
    expect(zoomed).toBeGreaterThan(a);
    expect(spreadToPx(0, 75, 1080)).toBe(0);
  });
});

describe('interaction prompt', () => {
  const pos = { x: 0, y: 0, z: 0 };
  const lootWeapon = WEAPONS.find((w) => w.lootable && w.id !== 'pistol') ?? WEAPONS[0];

  // yaw 0 faces −z (core/math: forward = (−sin yaw, −cos yaw))
  const facing = { x: 0, y: 0, z: 0, yaw: 0 };

  it('names what F really takes: the thing in front of you beats the raw nearest one', () => {
    // a downed hero in front, loot and a crate beside / behind you
    const ents = [ent(2, 'hero', HEROES[1].id, 0, -1.4, VF_DOWNED, { name: 'Bob' }), ent(3, 'loot', lootWeapon.id, 0.5, 0.6), ent(4, 'crate', '1', 1.2, 0.3)];
    const p = deriveInteract(me(), facing, ents);
    expect(p?.kind).toBe('revive');
    if (p?.kind === 'revive') {
      expect(p.targetId).toBe(2);
      expect(p.needPeach).toBe(HEROES[0].id !== 'huatuo');
    }
  });

  it('after a swap, the new mount under the crosshair wins over the old one dropped at your feet (大宛)', () => {
    const ents = [ent(7, 'loot', 'chitu', 0.35, 0.5), ent(8, 'loot', 'dawan', 0.2, -2.1)];
    const p = deriveInteract(me({ mount: 'zixing' }), facing, ents);
    expect(p).toMatchObject({ kind: 'pickup', targetId: 8, itemId: 'dawan', swap: true });
    // looking the other way, the old one is the pick again
    expect(deriveInteract(me({ mount: 'zixing' }), { ...facing, yaw: Math.PI }, ents)).toMatchObject({ targetId: 7, itemId: 'chitu' });
  });

  it('skips a downed hero behind you (the sim only revives what you face)', () => {
    const ents = [ent(2, 'hero', HEROES[1].id, 0, 1.4, VF_DOWNED)];
    expect(deriveInteract(me(), facing, ents)).toBeNull();
    // without a known facing: plain distance
    expect(deriveInteract(me(), pos, ents)?.kind).toBe('revive');
  });

  it('a full item bar: F swaps the card (COMBAT-7), so it competes like any pickup; an unswappable one only warns when nothing else is in reach', () => {
    // (was: the card only warned — F could not take it; the sim now swaps it for slot 7's card)
    const full = me({ items: [1, 2, 3, 4].map(() => ({ id: 'zzz', count: 1 })) });
    expect(deriveInteract(full, facing, [ent(3, 'loot', 'tao', 0, -0.5), ent(4, 'crate', '1', 0, -2.5)])).toMatchObject({ kind: 'full', itemId: 'tao', swapSlot: 3, swapId: 'zzz' });
    expect(deriveInteract(full, facing, [ent(3, 'loot', 'tao', 0, -2.4), ent(4, 'crate', '1', 0, -0.8)])?.kind).toBe('crate');
    const peaches = me({ items: [1, 2, 3, 4].map(() => ({ id: 'tao', count: 3 })) });
    expect(deriveInteract(peaches, facing, [ent(3, 'loot', 'tao', 0, -0.5), ent(4, 'crate', '1', 0, -2.5)])?.kind).toBe('crate');
    expect(deriveInteract(peaches, facing, [ent(3, 'loot', 'tao', 0, -0.5)])).toMatchObject({ kind: 'full', swapSlot: -1 });
  });

  it('knows when you carry a peach', () => {
    const ents = [ent(2, 'hero', HEROES[1].id, 1, 1, VF_DOWNED)];
    const p = deriveInteract(me({ items: [{ id: 'tao', count: 1 }, null, null, null] }), pos, ents);
    expect(p?.kind === 'revive' && p.needPeach).toBe(false);
  });

  it('opens crates, ignores opened crates and falling airdrops', () => {
    expect(deriveInteract(me(), pos, [ent(4, 'crate', '2', 1, 0)])).toMatchObject({ kind: 'crate', tier: 2 });
    expect(deriveInteract(me(), pos, [ent(4, 'crate', '2', 1, 0, VF_OPENED)])).toBeNull();
    expect(deriveInteract(me(), pos, [ent(5, 'airdrop', '3', 1, 0, VF_AIRBORNE)])).toBeNull();
    expect(deriveInteract(me(), pos, [ent(5, 'airdrop', '3', 1, 0)])?.kind).toBe('airdrop');
  });

  it('offers weapon pickup / swap', () => {
    const p = deriveInteract(me(), pos, [ent(3, 'loot', lootWeapon.id, 1, 0)]);
    expect(p).toMatchObject({ kind: 'pickup', itemId: lootWeapon.id, swap: lootWeapon.id !== 'pistol' });
  });

  it('warns when item slots are full', () => {
    const full = me({ items: [1, 2, 3, 4].map(() => ({ id: 'zzz', count: 1 })) });
    expect(deriveInteract(full, pos, [ent(3, 'loot', 'tao', 1, 0)])?.kind).toBe('full');
    expect(deriveInteract(me(), pos, [ent(3, 'loot', 'tao', 1, 0)])).toBeNull();
  });

  it('ignores far or dead things, and nothing while channeling / dead', () => {
    expect(deriveInteract(me(), pos, [ent(4, 'crate', '1', 10, 0)])).toBeNull();
    expect(deriveInteract(me(), pos, [ent(2, 'hero', HEROES[1].id, 1, 0, VF_DOWNED | VF_DEAD)])).toBeNull();
    expect(deriveInteract(me({ channel: { kind: 'open', progress: 0.5 } }), pos, [ent(4, 'crate', '1', 1, 0)])).toBeNull();
    expect(deriveInteract(me({ dead: true }), pos, [ent(4, 'crate', '1', 1, 0)])).toBeNull();
  });

  it('suggests wine self-revive when downed', () => {
    const downed = me({ downed: true, items: [null, { id: 'jiu', count: 1 }, null, null] });
    expect(deriveInteract(downed, pos, [])).toEqual({ kind: 'selfRevive', slot: 1 });
    expect(deriveInteract(me({ downed: true }), pos, [])).toBeNull();
  });
});

describe('names and spectating', () => {
  const players: PublicPlayerView[] = [
    { playerId: 'a', name: 'Alice', isBot: false, seat: 0, entityId: 10, heroId: HEROES[0].id, kingdom: HEROES[0].kingdom, alive: true, downed: false, kills: 0 },
    { playerId: 'b', name: 'Bot', isBot: true, seat: 1, entityId: 11, heroId: HEROES[1].id, kingdom: HEROES[1].kingdom, alive: false, downed: false, kills: 0 },
    { playerId: 'c', name: 'Cat', isBot: false, seat: 2, entityId: 12, heroId: HEROES[2].id, kingdom: HEROES[2].kingdom, alive: true, downed: false, kills: 0 },
  ];
  const ents = new Map<number, ViewEntity>([
    [20, ent(20, 'troop', 'shu_rifleman', 0, 0, 0, { owner: 10 })],
    [30, ent(30, 'projectile', 'rocket', 0, 0, 0, { owner: 12 })],
  ]);
  const view = { get: (id: number) => ents.get(id), players: () => players };

  it('labels heroes, troops (by commander) and projectiles (by owner)', () => {
    expect(entityLabel(view, 10, 'en')?.name).toBe('Alice');
    const troop = entityLabel(view, 20, 'zh');
    expect(troop?.kind).toBe('troop');
    expect(troop?.name.startsWith('Alice·')).toBe(true);
    expect(entityLabel(view, 30, 'en')?.name).toBe('Cat');
    expect(entityLabel(view, 999, 'en')).toBeNull();
    expect(entityLabel(view, undefined, 'en')).toBeNull();
  });

  it('cycles alive heroes only, skipping yourself', () => {
    expect(cycleSpectate(players, null, 1, 12)).toBe(10);
    expect(cycleSpectate(players, 10, 1, null)).toBe(12);
    expect(cycleSpectate(players, 12, 1, null)).toBe(10);
    expect(cycleSpectate(players, 10, -1, null)).toBe(12);
    expect(cycleSpectate(players.filter((p) => !p.alive), null, 1, null)).toBeNull();
    expect(aliveCount(players)).toBe(2);
  });

  it('computes the bearing of a point relative to your facing', () => {
    // yaw 0 faces -Z
    expect(relativeBearing(0, 0, 0, 0, -10)).toBeCloseTo(0);
    expect(relativeBearing(0, 0, 0, 10, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(relativeBearing(0, 0, 0, 0, 10))).toBeCloseTo(Math.PI);
    // turning left (yaw +90°) puts -X straight ahead
    expect(relativeBearing(0, 0, Math.PI / 2, -10, 0)).toBeCloseTo(0);
  });
});

describe('UI key de-duplication', () => {
  it('pairs one press reported by both sources, keeps real repeats', () => {
    const d = new UiKeyDeduper(150);
    expect(d.accept('map:true', 'doc', 0)).toBe(true);
    expect(d.accept('map:true', 'ctl', 2)).toBe(false);
    // second physical press 40 ms later
    expect(d.accept('map:true', 'doc', 40)).toBe(true);
    expect(d.accept('map:true', 'ctl', 41)).toBe(false);
    // only one source reporting: every press counts
    expect(d.accept('menu:true', 'ctl', 100)).toBe(true);
    expect(d.accept('menu:true', 'ctl', 120)).toBe(true);
    // twins outside the window are separate presses
    expect(d.accept('chat:true', 'doc', 0)).toBe(true);
    expect(d.accept('chat:true', 'ctl', 500)).toBe(true);
    // different keys never pair
    expect(d.accept('map:false', 'ctl', 600)).toBe(true);
    expect(d.accept('quickchat:true', 'doc', 601)).toBe(true);
  });
});

describe('minimap visibility', () => {
  it('hides stealthed enemies unless exposed; friends always show', () => {
    expect(isMapVisible({ flags: 0 }, false)).toBe(true);
    expect(isMapVisible({ flags: VF_STEALTH }, false)).toBe(false);
    expect(isMapVisible({ flags: VF_STEALTH | VF_EXPOSED }, false)).toBe(true);
    expect(isMapVisible({ flags: VF_STEALTH }, true)).toBe(true);
    expect(isMapVisible({ flags: VF_DEAD | VF_EXPOSED }, false)).toBe(false);
  });
  it('only the real Lord sees which crown is the decoy', () => {
    const allies = new Set([7]);
    // the Lord: the Double arrives as role 'double' and is a known ally
    expect(crownKind('lord', { id: 7, role: 'double' }, allies)).toBe('decoy');
    // the Double: the real Lord is a known ally
    expect(crownKind('double', { id: 7, role: 'lord' }, allies)).toBe('ally');
    // everyone else: both crowns look the same
    expect(crownKind('rebel', { id: 7, role: 'lord' }, new Set())).toBe('plain');
    expect(crownKind('loyalist', { id: 9, role: 'lord' }, new Set())).toBe('plain');
  });
});

describe('refused card / ability text', () => {
  it('stays neutral without a reason (桃 at full HP is not an aiming problem)', () => {
    expect(deniedText({}).en).toBe("Can't use that now");
    expect(deniedText({ item: 'tao' }).zh).toContain('现在无法使用');
    expect(deniedText({ item: 'tao' }).zh).not.toContain('准星');
  });
  it('explains when the sim says why', () => {
    expect(deniedText({ reason: 'noTarget' }).en).toBe('Aim at a target first');
    expect(deniedText({ reason: 'fullHp', item: 'tao' }).zh).toBe('体力已满');
    expect(deniedText({ reason: 'cap', item: 'shan' }).en).toMatch(/limit/);
  });
  it('has a zh and an en text for every reason', () => {
    const cases: [string, string, string][] = [
      ['noTarget', '准星需对准目标', 'Aim at a target first'],
      ['fullHp', '体力已满', 'Already at full health'],
      ['cap', '已达上限', 'Already at the limit'],
      ['blocked', '此处无法使用', "Can't use that here"],
      ['needOther', '附近需要另一名武将', 'Needs another hero nearby'],
      ['invalidTarget', '目标无效', 'Invalid target'],
      ['silenced', '无法施放：被沉默', 'Silenced'],
    ];
    for (const [reason, zh, en] of cases) expect(deniedText({ reason }), reason).toEqual({ zh, en });
  });
  it('prefixes the ability name when the refusal is about an ability', () => {
    const tuxi = HERO_BY_ID.zhangliao.abilities.find((a) => a.id === 'zhangliao_tuxi')!;
    expect(deniedText({ reason: 'invalidTarget', ability: 'zhangliao_tuxi' })).toEqual({ zh: `${tuxi.nameZh}：目标无效`, en: `${tuxi.nameEn}: Invalid target` });
    expect(deniedText({ reason: 'silenced', ability: 'zhangliao_tuxi' }).en).toBe(`${tuxi.nameEn}: Silenced`);
    expect(deniedText({ reason: 'needOther', ability: 'zhangliao_tuxi' }).zh).toBe(`${tuxi.nameZh}：附近需要另一名武将`);
    // no reason: neutral, still named
    expect(deniedText({ ability: 'zhangliao_tuxi' }).en).toBe(`${tuxi.nameEn}: Can't cast that now`);
    // unknown ability ids are ignored
    expect(deniedText({ reason: 'noTarget', ability: 'nope' }).en).toBe('Aim at a target first');
  });
  it('ignores junk fields', () => {
    expect(deniedText({ reason: 3, item: 'no-such-card' }).en).toBe("Can't use that now");
  });
});
