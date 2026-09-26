// Shared fixtures for the net unit tests.
import { Rng } from '../../../src/core/rng';
import type {
  EntityKind,
  Kingdom,
  PrivateHeroView,
  PublicPlayerView,
  RoleId,
  Snapshot,
  ViewEntity,
} from '../../../src/core/types';
import { VF_ADS, VF_FIRING, VF_LORD, VF_REVEALED, VF_SPRINTING } from '../../../src/core/types';
import type { HeroDef } from '../../../src/data/types';

export const HERO_IDS = ['liubei', 'guanyu', 'zhangfei', 'caocao', 'simayi', 'sunquan', 'zhouyu', 'lubu'];
const KINGDOMS: Kingdom[] = ['shu', 'shu', 'shu', 'wei', 'wei', 'wu', 'wu', 'qun'];
const TROOP_TYPES = ['shu_rifleman', 'wei_tiger', 'wu_crossbow', 'qun_raider'];

/** Extra strings a real match table would contain for this fixture. */
export const FIXTURE_STRINGS = [
  ...HERO_IDS,
  ...TROOP_TYPES,
  'yellowTurban',
  'yellowTurbanBrute',
  'carbine',
  'smg',
  'pistol',
  'troop_rifle',
  'troop_smg',
  'tao',
  'bagua',
  'chitu',
  'liubei_rende',
  'liubei_banner',
  ...Array.from({ length: 8 }, (_, i) => `peer-${i}`),
  ...Array.from({ length: 8 }, (_, i) => `玩家${i}`),
];

function entity(r: Rng, id: number, kind: EntityKind, sub: string, extra: Partial<ViewEntity> = {}): ViewEntity {
  return {
    id,
    kind,
    sub,
    x: r.range(-150, 150),
    y: r.range(0, 25),
    z: r.range(-150, 150),
    yaw: r.range(-Math.PI, Math.PI),
    pitch: 0,
    speed: 0,
    hp: 0,
    maxHp: 0,
    shield: 0,
    flags: 0,
    ...extra,
  };
}

/** 8 heroes + 60 troops + 30 NPCs + 20 misc — the §11 size budget scenario. */
export function bigSnapshot(seed = 7): Snapshot {
  const r = new Rng(seed);
  const ents: ViewEntity[] = [];
  let id = 1;
  const heroIds: number[] = [];
  for (let i = 0; i < 8; i++) {
    const hid = id++;
    heroIds.push(hid);
    ents.push(
      entity(r, hid, 'hero', HERO_IDS[i], {
        pitch: r.range(-0.6, 0.6),
        speed: r.range(0, 7),
        hp: Math.round(r.range(50, 400)),
        maxHp: i === 0 ? 500 : 400,
        shield: i % 3 === 0 ? 60 : 0,
        flags: (i === 0 ? VF_LORD | VF_REVEALED : 0) | (i % 2 ? VF_FIRING | VF_ADS : VF_SPRINTING),
        kingdom: KINGDOMS[i],
        weapon: i % 2 ? 'carbine' : 'smg',
        armor: i === 2 ? 'bagua' : undefined,
        mount: i === 3 ? 'chitu' : undefined,
        name: `玩家${i}`,
        role: i === 0 ? 'lord' : undefined,
      }),
    );
  }
  // strip explicit undefined so deep-equality comparisons are fair
  for (const e of ents) for (const k of Object.keys(e) as (keyof ViewEntity)[]) if (e[k] === undefined) delete e[k];
  // 60 troops in squads of 7-8 (spawned together → consecutive ids)
  for (let i = 0; i < 60; i++) {
    const owner = heroIds[Math.floor(i / 7.5)];
    const ownerIdx = heroIds.indexOf(owner);
    ents.push(
      entity(r, id++, 'troop', TROOP_TYPES[ownerIdx % 4], {
        speed: r.range(0, 5),
        hp: Math.round(r.range(10, 120)),
        maxHp: 120,
        flags: r.chance(0.3) ? VF_FIRING : 0,
        kingdom: KINGDOMS[ownerIdx],
        owner,
        weapon: 'troop_rifle',
      }),
    );
  }
  // 30 NPCs in 5 camps
  for (let i = 0; i < 30; i++) {
    ents.push(
      entity(r, id++, 'npc', i % 6 === 5 ? 'yellowTurbanBrute' : 'yellowTurban', {
        speed: r.chance(0.5) ? r.range(0, 4) : 0,
        hp: Math.round(r.range(40, 150)),
        maxHp: i % 6 === 5 ? 300 : 150,
        weapon: i % 6 === 5 ? undefined : 'troop_smg',
      }),
    );
    const last = ents[ents.length - 1];
    if (last.weapon === undefined) delete last.weapon;
  }
  // 20 misc: projectiles, loot, crates, hazards
  for (let i = 0; i < 20; i++) {
    const k = i % 4;
    if (k === 0) ents.push(entity(r, id++, 'projectile', 'rocket', { pitch: r.range(-0.3, 0.3), speed: 40, owner: heroIds[i % 8] }));
    else if (k === 1) ents.push(entity(r, id++, 'loot', 'tao'));
    else if (k === 2) ents.push(entity(r, id++, 'crate', '1', { flags: r.chance(0.5) ? 1 << 20 : 0 }));
    else ents.push(entity(r, id++, 'hazard', 'fire', { radius: 4.5, owner: heroIds[i % 8] }));
  }

  const you: PrivateHeroView = {
    entityId: heroIds[1],
    heroId: HERO_IDS[1],
    role: 'loyalist',
    hp: 312,
    maxHp: 400,
    shield: 0,
    weapons: [{ id: 'carbine', mag: 24, reserve: 90 }, { id: 'pistol', mag: 12, reserve: 36 }],
    activeSlot: 0,
    items: [{ id: 'tao', count: 2 }, null, { id: 'bagua', count: 1 }, null],
    armor: 'bagua',
    mount: null,
    cooldowns: { liubei_rende: 3.25, liubei_banner: 0 },
    charges: { liubei_rende: 2 },
    abilityState: { liubei_rende: 1.5 },
    dodgeCharges: 2,
    reloading: 0,
    channel: { kind: 'revive', progress: 0.4 },
    downed: false,
    downedRemaining: 0,
    dead: false,
    statuses: [
      { id: 'haste', remaining: 2.5 },
      { id: 'nullify', remaining: Infinity },
    ],
    squad: Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, hp: 100 - i * 5, maxHp: 120 })),
    order: { kind: 'hold', point: { x: 12.5, y: 3, z: -40.25 } },
    knownAllies: [heroIds[0]],
    stats: { kills: 3, damage: 1234, healing: 80, rescues: 1 },
    vel: { x: 1.5, y: -0.25, z: 4 },
    onGround: true,
    moveMods: { speedMul: 1.25, canSprint: true, canJump: false, rooted: false },
  };

  const players: PublicPlayerView[] = HERO_IDS.map((h, i) => {
    const p: PublicPlayerView = {
      playerId: `peer-${i}`,
      name: `玩家${i}`,
      isBot: i >= 4,
      seat: i,
      entityId: heroIds[i],
      heroId: h,
      kingdom: KINGDOMS[i],
      alive: i !== 6,
      downed: i === 5,
      kills: i,
    };
    if (i === 0) p.role = 'lord';
    if (i === 6) p.role = 'rebel';
    if (i === 3) p.claim = 'loyalist';
    if (i < 4) p.ping = 30 + i * 10;
    return p;
  });

  return {
    tick: 12345,
    time: 411.5,
    ackSeq: 9876,
    ents,
    zone: {
      phase: 2,
      center: { x: 10, y: 0, z: -20 },
      radius: 150,
      targetCenter: { x: 5, y: 0, z: -10 },
      targetRadius: 100,
      shrinkStart: 390,
      shrinkEnd: 435,
      dps: 8,
    },
    you,
    players,
    elapsed: 411.5,
  };
}

/** A synthetic hero pool with 30 heroes (5 lord candidates), independent of the DATA roster. */
export function testHeroPool(): HeroDef[] {
  const kingdoms: Kingdom[] = ['shu', 'wei', 'wu', 'qun'];
  const hints = ['offense', 'defense', 'heal', 'mobility', 'summon', 'utility'] as const;
  return Array.from({ length: 30 }, (_, i) => ({
    id: `hero${i}`,
    nameZh: `武将${i}`,
    nameEn: `Hero ${i}`,
    titleZh: '',
    titleEn: '',
    kingdom: kingdoms[i % 4],
    gender: i % 5 === 0 ? 'female' : 'male',
    sgsHp: i % 3 === 0 ? 3 : 4,
    maxHp: i % 3 === 0 ? 300 : 400,
    speedMul: 1,
    lordCandidate: i < 5,
    signatureWeapon: 'carbine',
    troopType: 'shu_rifleman',
    troopBonus: 0,
    abilities: [
      { id: `hero${i}_p`, slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, aiHint: hints[i % 6] },
      { id: `hero${i}_q`, slot: 'q', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, aiHint: hints[(i + 1) % 6] },
      { id: `hero${i}_e`, slot: 'e', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {}, aiHint: hints[(i + 2) % 6] },
    ],
    visual: {
      skin: '#c98c5a',
      hair: '#111111',
      primary: '#222222',
      secondary: '#333333',
      accent: '#d9b24a',
      headgear: 'helmet',
      beard: 'none',
      body: 'normal',
      extras: [],
      artPromptEn: '',
    },
    bioZh: '',
    bioEn: '',
    playstyleZh: '',
    playstyleEn: '',
    difficulty: ((i % 3) + 1) as 1 | 2 | 3,
    quotesZh: [],
    series: 'standard',
  }));
}

export const HIDDEN_ROLES: RoleId[] = ['loyalist', 'rebel', 'traitor', 'opportunist', 'bounty', 'double'];

/** Wait until `cond` is true (polling), or throw after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Tiny flat map so tests never depend on the (possibly slow) real generator. */
export function flatMap(seed = 1): import('../../../src/core/map').MapData {
  const res = 8;
  return {
    seed,
    nameZh: '测试',
    nameEn: 'Test',
    size: 320,
    res,
    heights: new Float32Array((res + 1) * (res + 1)),
    waterLevel: -5,
    props: [],
    colliders: [],
    lordSpawn: { x: 0, y: 0, z: 0 },
    spawns: Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i) * 110, y: 0, z: Math.sin(i) * 110 })),
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
}
