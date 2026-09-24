import { describe, expect, it } from 'vitest';
import type { PrivateHeroView, PublicPlayerView, ViewEntity, ZoneView } from '../../../src/core/types';
import { VF_AIRBORNE, VF_DEAD, VF_DOWNED, VF_OPENED } from '../../../src/core/types';
import { HEROES, WEAPONS } from '../../../src/data';
import {
  aliveCount,
  cooldownFraction,
  crosshairStyle,
  cycleSpectate,
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

  it('prefers reviving a downed hero over loot', () => {
    const ents = [ent(2, 'hero', HEROES[1].id, 1, 1, VF_DOWNED, { name: 'Bob' }), ent(3, 'loot', lootWeapon.id, 0.5, 0), ent(4, 'crate', '1', 1, 0)];
    const p = deriveInteract(me(), pos, ents);
    expect(p?.kind).toBe('revive');
    if (p?.kind === 'revive') {
      expect(p.targetId).toBe(2);
      expect(p.needPeach).toBe(HEROES[0].id !== 'huatuo');
    }
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
