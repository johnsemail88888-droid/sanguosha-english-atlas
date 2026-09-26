// COMBAT-9: practical weapon output, measured the way a perfect player would get it — a rooted,
// unarmored dummy hero, the crosshair on its chest every tick, one full magazine per cell, hip
// fire at 6 m and 15 m, aimed (ADS) at 15 m and 40 m. "dps" is sustained: the damage of the
// magazine over (time to empty it + reload). The table prints on every run
// (`npx vitest run tests/unit/items/weaponsDps.test.ts`); the balance rules below keep it sane:
// every signature epic beats the commons at its intended range, no weapon leads at every range,
// and pellet guns are strong up close.
import { describe, expect, it } from 'vitest';
import type { Entity, RoleId } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, emptyInput } from '../../../src/core/types';
import { HEROES, WEAPONS } from '../../../src/data';
import type { WeaponDef } from '../../../src/data/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from '../sim/helpers';

const ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
export const CELLS = [
  { key: 'hip6', dist: 6, ads: false },
  { key: 'hip15', dist: 15, ads: false },
  { key: 'ads15', dist: 15, ads: true },
  { key: 'ads40', dist: 40, ads: true },
] as const;
type CellKey = (typeof CELLS)[number]['key'];

const SIGNATURES = new Set(HEROES.map((h) => h.signatureWeapon));
/** player weapons: every lootable gun and every hero's signature weapon */
const MEASURED = WEAPONS.filter((w) => !w.melee && (w.lootable || SIGNATURES.has(w.id)));

export interface Cell {
  perRound: number;
  dps: number;
}

/** One magazine of `def` at a rooted dummy `dist` m away. */
export function measure(def: WeaponDef, dist: number, ads: boolean): Cell {
  const w: World = makeWorld(ROLES, { heroes: ['dummy', 'dummy', 'dummy', 'dummy', 'dummy'] });
  const me = hero(w, 2);
  const t = hero(w, 3);
  for (const s of [0, 1, 4]) place(w, hero(w, s), 40 + s * 4, 50);
  place(w, me, -45, -35, Math.PI);
  place(w, t, -45, -35 + dist, 0);
  t.maxHp = t.hp = 1e6;
  w.applyStatus(t.id, 'root', 1e4, { sourceId: t.id });
  w.applyStatus(t.id, 'silence', 1e4, { sourceId: t.id });
  const h = me.hero!;
  h.weapons[0] = { id: def.id, mag: def.magSize, reserve: def.magSize * 4 };
  h.weapons[1] = null;
  h.activeSlot = 0;
  let seq = 1;
  const chest = (e: Entity) => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });
  const frame = (buttons: number) => {
    const c = chest(t);
    const a = aimAnglesFor(me.pos, c);
    w.setInput(h.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimPoint: c, aimTargetId: t.id, buttons });
  };
  const adsBtn = adsOn(ads);
  // settle (and raise the sights) first
  for (let i = 0; i < 15; i++) {
    frame(adsBtn);
    w.step();
  }
  const hp0 = t.hp;
  const inst = h.weapons[0]!;
  let first = -1;
  let empty = -1;
  let pressed = false;
  for (let i = 0; i < 30 * 40 && empty < 0; i++) {
    // automatic: hold; semi-automatic: click as fast as the gun cycles (a fresh press once it is ready)
    const click: boolean = def.auto || (!pressed && h.nextFireAt <= w.time + 1 / 30 + 1e-6);
    pressed = click;
    frame(adsBtn | (click ? BTN_FIRE : 0));
    const before = inst.mag;
    w.step();
    if (first < 0 && inst.mag < before) first = w.time;
    if (inst.mag === 0 && first >= 0) empty = w.time;
  }
  // let projectiles land
  for (let i = 0; i < 90; i++) {
    frame(adsBtn);
    w.step();
  }
  const dmg = hp0 - t.hp;
  const magTime = Math.max(0, empty - first) + 1 / def.fireRate;
  return { perRound: dmg / def.magSize, dps: dmg / (magTime + def.reloadTime) };
}

const adsOn = (on: boolean): number => (on ? BTN_ADS : 0);

export function measureAll(): Map<string, Record<CellKey, Cell>> {
  const out = new Map<string, Record<CellKey, Cell>>();
  for (const def of MEASURED) {
    const row = {} as Record<CellKey, Cell>;
    for (const c of CELLS) row[c.key] = measure(def, c.dist, c.ads);
    out.set(def.id, row);
  }
  return out;
}

/**
 * The range each class is built for — hip 6 m for close-range guns, aimed 15 / 40 m for the rest,
 * hip 15 m for launchers (no spread: their edge where hip fire scatters) — and the common guns it is
 * measured against there (its own common for pistols / SMGs, the carbine for rifles, every common
 * gun for the classes without one).
 */
export function intendedCell(def: WeaponDef): { cell: CellKey; vs: string[] } {
  const commons = ['pistol', 'carbine', 'smg'];
  switch (def.class) {
    case 'shotgun':
    case 'flamer':
      return { cell: 'hip6', vs: commons };
    case 'smg':
      return { cell: 'hip6', vs: ['smg'] };
    case 'pistol':
      return { cell: 'ads15', vs: ['pistol'] };
    case 'dmr':
    case 'bow':
    case 'sniper':
      return { cell: 'ads40', vs: commons };
    case 'launcher':
      return { cell: 'hip15', vs: commons };
    default:
      return { cell: 'ads15', vs: ['carbine'] };
  }
}

describe('practical weapon DPS (COMBAT-9)', () => {
  const table = measureAll();
  const dps = (id: string, k: CellKey): number => table.get(id)![k].dps;

  it('prints the table', () => {
    const lines = ['| weapon | class | rarity | hip 6 m | hip 15 m | ADS 15 m | ADS 40 m |', '|---|---|---|---|---|---|---|'];
    for (const def of MEASURED) {
      const r = table.get(def.id)!;
      const cell = (k: CellKey): string => `${r[k].perRound.toFixed(0)}/rd · ${r[k].dps.toFixed(0)} dps`;
      const sig = SIGNATURES.has(def.id) && !def.lootable ? 'sig' : def.rarity;
      lines.push(`| ${def.id} | ${def.class} | ${sig} | ${cell('hip6')} | ${cell('hip15')} | ${cell('ads15')} | ${cell('ads40')} |`);
    }
    process.stdout.write(`\n[weapons] practical DPS (perfect aim at a rooted dummy's chest, one magazine + reload)\n${lines.join('\n')}\n`);
    expect(table.size).toBe(MEASURED.length);
  });

  it('every signature / epic weapon clearly beats the commons at the range it is built for', () => {
    const bad: string[] = [];
    for (const def of MEASURED) {
      if (def.rarity !== 'epic' && def.rarity !== 'legendary') continue;
      const { cell, vs } = intendedCell(def);
      const best = Math.max(...vs.map((c) => dps(c, cell)));
      if (dps(def.id, cell) < best * 1.08) bad.push(`${def.id} ${cell} ${dps(def.id, cell).toFixed(0)} < ${vs.join('/')} ${best.toFixed(0)} × 1.08`);
    }
    expect(bad).toEqual([]);
  });

  it('no weapon leads at every range (top 3 in all four cells)', () => {
    const top = new Map<string, number>();
    for (const c of CELLS) {
      const ranked = MEASURED.map((d) => d.id).sort((a, b) => dps(b, c.key) - dps(a, c.key));
      for (const id of ranked.slice(0, 3)) top.set(id, (top.get(id) ?? 0) + 1);
    }
    const everywhere = [...top].filter(([, n]) => n >= CELLS.length).map(([id]) => id);
    expect(everywhere).toEqual([]);
  });

  it('shotguns hit hard up close (≥ every common gun at 6 m)', () => {
    const best = Math.max(dps('pistol', 'hip6'), dps('carbine', 'hip6'), dps('smg', 'hip6'));
    for (const def of MEASURED.filter((d) => d.class === 'shotgun')) expect(dps(def.id, 'hip6'), def.id).toBeGreaterThanOrEqual(best);
  });
});
