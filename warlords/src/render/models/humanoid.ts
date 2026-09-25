// Procedural low-poly humanoid built from a CharacterSpec (derived from
// HeroVisual or TroopTypeDef.visual). Output: one rigidly-skinned geometry
// (vertex colours) + skeleton. Headgear / beards / extras live in
// headgear.ts and extras.ts and are added through the same BodyCtx.
import * as THREE from 'three';
import type { BodyType, Headgear, HeroExtra, HeroVisual } from '../../data/types';
import { GeoBuilder, PRIM, col, mixCol, shade, trs } from '../core/geo';
import { B, bodyDims, createSkeleton, type BodyDims, type BoneName } from './rig';
import { buildHeadgear, buildBeard } from './headgear';
import { buildExtras } from './extras';
import { BOOT, LEATHER, EYE, ball, frustum, type BodyCtx } from './parts';

export type { BodyCtx } from './parts';

export interface CharacterSpec {
  skin: string;
  face: string;
  hair: string;
  primary: string;
  secondary: string;
  accent: string;
  /** kingdom colour (sash / trims / pennants) */
  kingdom: string;
  headgear: Headgear;
  beard: 'none' | 'short' | 'long' | 'wild';
  body: BodyType;
  extras: HeroExtra[];
  female: boolean;
  /** troop shield on the left forearm */
  shield?: boolean;
  scale?: number;
  /** seed for small variations */
  seed?: number;
}

export function specFromHeroVisual(v: HeroVisual, kingdomColor: string, female: boolean): CharacterSpec {
  return {
    skin: v.skin,
    face: v.face ?? v.skin,
    hair: v.hair,
    primary: v.primary,
    secondary: v.secondary,
    accent: v.accent,
    kingdom: kingdomColor,
    headgear: v.headgear,
    beard: female ? 'none' : v.beard,
    body: v.body,
    extras: v.extras,
    female,
  };
}

export interface BuiltCharacter {
  /** shared (cached) geometry — never dispose it per instance */
  geometry: THREE.BufferGeometry;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  rest: THREE.Vector3[];
  dims: BodyDims;
  /** true when the left hand is busy (fan) and must not grab the weapon */
  leftHandBusy: boolean;
}

const geoCache = new Map<string, { geometry: THREE.BufferGeometry; dims: BodyDims }>();

export function specKey(spec: CharacterSpec): string {
  return JSON.stringify([
    spec.skin,
    spec.face,
    spec.hair,
    spec.primary,
    spec.secondary,
    spec.accent,
    spec.kingdom,
    spec.headgear,
    spec.beard,
    spec.body,
    spec.extras,
    spec.female,
    !!spec.shield,
    spec.scale ?? 1,
  ]);
}

/** Build (or reuse) the skinned geometry for a spec and create a fresh skeleton for it. */
export function buildCharacter(spec: CharacterSpec): BuiltCharacter {
  const key = specKey(spec);
  let hit = geoCache.get(key);
  if (!hit) {
    hit = { geometry: buildCharacterGeometry(spec), dims: bodyDims(spec.body, spec.female, spec.scale ?? 1) };
    geoCache.set(key, hit);
  }
  const { bones, rest, skeleton } = createSkeleton(hit.dims);
  return {
    geometry: hit.geometry,
    bones,
    skeleton,
    rest,
    dims: hit.dims,
    leftHandBusy: spec.extras.includes('fan'),
  };
}

/** Number of cached character geometries (for diagnostics). */
export const characterGeometryCacheSize = (): number => geoCache.size;

/**
 * Dispose and forget every cached body geometry (end of a match: the next one
 * rebuilds what it needs). Rigs still alive keep working with theirs.
 */
export function releaseCharacterGeometryCache(): void {
  for (const v of geoCache.values()) v.geometry.dispose();
  geoCache.clear();
}

function buildCharacterGeometry(spec: CharacterSpec): THREE.BufferGeometry {
  const d = bodyDims(spec.body, spec.female, spec.scale ?? 1);
  const b = new GeoBuilder({ skinned: true });
  const bare = spec.extras.includes('bareChest');
  const armored =
    !bare &&
    (spec.extras.includes('shoulderPads') ||
      spec.headgear === 'helmet' ||
      spec.headgear === 'plumeHelmet' ||
      spec.headgear === 'tacticalHelmet');
  const robed = !armored && !bare;
  const ctx: BodyCtx = {
    b,
    d,
    s: spec,
    armored,
    robed,
    bare,
    on(bone: BoneName) {
      b.bone = B[bone];
      return ctx;
    },
    v: (x, y, z) => new THREE.Vector3(x, y, z),
  };
  buildTorso(ctx);
  buildArms(ctx);
  buildLegs(ctx);
  buildHead(ctx);
  buildHeadgear(ctx);
  buildBeard(ctx);
  buildExtras(ctx);
  if (spec.shield) buildShield(ctx);
  return b.build();
}

// ── torso ───────────────────────────────────────────────────────────────────
function buildTorso(c: BodyCtx): void {
  const { d, s, b } = c;
  const w = d.w;
  const dp = d.depth;
  const robe = col(s.primary);
  const armor = col(s.secondary);
  const accent = col(s.accent);
  const pants = c.armored ? shade(s.secondary, 0.55) : c.bare ? shade(s.secondary, 0.8) : shade(s.primary, 0.8);
  const top = c.bare ? col(s.skin) : robe;

  // hips / pelvis
  c.on('hips');
  b.boxAt(0, (d.hipY - 0.08 + d.spineY + 0.02) / 2, 0, 0.32 * w, d.spineY + 0.02 - (d.hipY - 0.08), 0.2 * dp, pants);
  // belt + kingdom sash knot
  b.boxAt(0, d.spineY - 0.01, 0, 0.34 * w + 0.02, 0.065, 0.215 * dp + 0.02, c.bare ? LEATHER : mixCol(LEATHER, s.accent, 0.35));
  b.boxAt(0, d.spineY - 0.01, -0.118 * dp - 0.012, 0.07, 0.05, 0.02, accent); // buckle
  // kingdom-coloured sash knot on the hip with two short tails (绶带)
  b.boxAt(0.13 * w, d.spineY - 0.02, -0.1 * dp, 0.05, 0.05, 0.04, s.kingdom);
  b.add(PRIM.box(), trs(0.12 * w, d.spineY - 0.11, -0.105 * dp, 0.05, 0, 0.08, 0.028, 0.14, 0.012), s.kingdom);
  b.add(PRIM.box(), trs(0.15 * w, d.spineY - 0.1, -0.1 * dp, 0.03, 0, -0.12, 0.024, 0.12, 0.012), s.kingdom);

  // front / back apron panels (short enough to clear the swinging knees)
  const apronLen = c.robed ? 0.36 : 0.3;
  const apronCol = c.armored ? robe : robe;
  b.add(
    PRIM.box(),
    trs(0, d.spineY - 0.04 - apronLen / 2, -0.112 * dp, 0.12, 0, 0, 0.24 * w, apronLen, 0.022),
    apronCol,
  );
  b.add(PRIM.box(), trs(0, d.spineY - 0.04 - apronLen / 2, 0.112 * dp, -0.12, 0, 0, 0.26 * w, apronLen, 0.022), apronCol);
  if (!c.bare) {
    // accent hem
    b.add(
      PRIM.box(),
      trs(0, d.spineY - 0.04 - apronLen + 0.015, -0.112 * dp - apronLen * 0.12, 0.12, 0, 0, 0.245 * w, 0.03, 0.026),
      accent,
    );
  }

  // abdomen (spine)
  c.on('spine');
  const abH = d.chestY + 0.02 - (d.spineY - 0.02);
  b.boxAt(0, (d.spineY - 0.02 + d.chestY + 0.02) / 2, 0, (c.s.female ? 0.26 : 0.3) * w, abH, 0.2 * dp, top);
  if (d.belly > 0) {
    ball(c, 0, d.spineY + 0.09, -0.06 * dp, 0.16 * w * (0.7 + d.belly * 0.4), c.bare ? col(s.skin) : top, 0.9);
  }
  if (c.bare) {
    // abs
    for (let i = 0; i < 3; i++) {
      b.boxAt(-0.035, d.spineY + 0.04 + i * 0.055, -0.1 * dp - 0.01, 0.055, 0.045, 0.02, shade(s.skin, 0.92));
      b.boxAt(0.035, d.spineY + 0.04 + i * 0.055, -0.1 * dp - 0.01, 0.055, 0.045, 0.02, shade(s.skin, 0.92));
    }
  }

  // chest
  c.on('chest');
  const chestBot = d.chestY - 0.03;
  const chestTop = d.shoulderY + 0.015;
  b.boxAt(0, (chestBot + chestTop) / 2, 0, (c.s.female ? 0.33 : 0.4) * w, chestTop - chestBot, 0.23 * dp, top);
  b.boxAt(0, chestTop + 0.015, 0.01, 0.24 * w, 0.05, 0.17 * dp, top); // trapezius
  if (c.s.female) {
    ball(c, -0.055, d.chestY + 0.1, -0.1 * dp, 0.06, top, 0.9);
    ball(c, 0.055, d.chestY + 0.1, -0.1 * dp, 0.06, top, 0.9);
  }
  if (c.bare) {
    // pecs + a diagonal sash
    b.boxAt(-0.07 * w, d.chestY + 0.13, -0.112 * dp, 0.13 * w, 0.09, 0.03, shade(s.skin, 0.95));
    b.boxAt(0.07 * w, d.chestY + 0.13, -0.112 * dp, 0.13 * w, 0.09, 0.03, shade(s.skin, 0.95));
    b.add(PRIM.box(), trs(0, d.chestY + 0.08, 0, 0, 0, 0.75, 0.07, 0.62 * w, 0.25 * dp), s.primary);
  } else if (c.robed) {
    // cross-collar robe (交领): overlapping lapel in accent
    b.add(PRIM.box(), trs(0.04 * w, d.chestY + 0.14, -0.118 * dp, 0, 0, 0.6, 0.045, 0.3, 0.02), accent);
    b.add(PRIM.box(), trs(-0.05 * w, d.chestY + 0.16, -0.119 * dp, 0, 0, -0.55, 0.04, 0.2, 0.018), shade(s.primary, 1.2));
    b.boxAt(0, chestTop - 0.005, -0.08 * dp, 0.14, 0.04, 0.08, accent); // collar
  } else {
    // lamellar vest + chest mirror (护心镜)
    b.boxAt(0, (chestBot + chestTop) / 2 - 0.01, 0, 0.42 * w, chestTop - chestBot - 0.02, 0.25 * dp, armor);
    b.boxAt(0, (d.spineY + d.chestY) / 2 + 0.01, 0, 0.33 * w, 0.14, 0.225 * dp, shade(s.secondary, 0.85));
    for (let i = 0; i < 3; i++) {
      b.boxAt(0, d.spineY + 0.06 + i * 0.07, -0.113 * dp, 0.3 * w, 0.012, 0.012, shade(s.secondary, 0.65));
    }
    b.add(PRIM.cyl(10), trs(0, d.chestY + 0.11, -0.128 * dp, Math.PI / 2, 0, 0, 0.065, 0.02, 0.065), accent);
    b.add(PRIM.cyl(10), trs(0, d.chestY + 0.11, -0.139 * dp, Math.PI / 2, 0, 0, 0.04, 0.01, 0.04), shade(s.accent, 1.25));
    b.boxAt(0, chestTop - 0.005, 0, 0.44 * w, 0.03, 0.26 * dp, accent); // top trim
    b.boxAt(0, chestBot + 0.005, 0, 0.43 * w, 0.025, 0.255 * dp, accent);
  }
}

// ── arms ────────────────────────────────────────────────────────────────────
function buildArms(c: BodyCtx): void {
  const { d, s } = c;
  const w = d.w;
  const sleeve = c.bare ? col(s.skin) : col(s.primary);
  const skin = col(s.skin);
  for (const side of [-1, 1] as const) {
    const x = side * d.shoulderX;
    const U: BoneName = side < 0 ? 'armUL' : 'armUR';
    const L: BoneName = side < 0 ? 'armLL' : 'armLR';
    const H: BoneName = side < 0 ? 'handL' : 'handR';
    c.on(U);
    ball(c, x, d.shoulderY, 0, 0.068 * w, c.armored ? col(s.secondary) : sleeve);
    frustum(c, c.v(x, d.shoulderY, 0), c.v(x, d.elbowY, 0), 0.058 * w, c.robed ? 0.068 * w : 0.05 * w, sleeve);
    ball(c, x, d.elbowY, 0, 0.05 * w, c.bare ? skin : sleeve);
    if (c.bare) {
      // arm band
      frustum(c, c.v(x, d.shoulderY - 0.1, 0), c.v(x, d.shoulderY - 0.13, 0), 0.062 * w, 0.06 * w, s.accent);
    }
    c.on(L);
    const fore = c.robed ? sleeve : c.bare ? skin : shade(s.primary, 0.9);
    frustum(c, c.v(x, d.elbowY, 0), c.v(x, d.wristY + 0.02, 0), 0.047 * w, 0.04 * w, fore);
    if (c.robed) {
      // 广袖 wide cuff with trim
      frustum(c, c.v(x, d.elbowY - 0.1, 0), c.v(x, d.wristY + 0.01, 0), 0.05 * w, 0.085 * w, sleeve, 8);
      frustum(c, c.v(x, d.wristY + 0.03, 0), c.v(x, d.wristY + 0.005, 0), 0.084 * w, 0.087 * w, s.accent, 8);
    } else {
      // bracer
      frustum(c, c.v(x, d.elbowY - 0.05, 0), c.v(x, d.wristY + 0.03, 0), 0.052 * w, 0.048 * w, c.bare ? LEATHER : s.secondary, 6);
      frustum(c, c.v(x, d.wristY + 0.05, 0), c.v(x, d.wristY + 0.03, 0), 0.05 * w, 0.05 * w, s.accent, 6);
    }
    c.on(H);
    c.b.boxAt(x, d.wristY - 0.045, -0.005, 0.055 * w + 0.01, 0.09, 0.048, skin);
    c.b.add(PRIM.box(), trs(x - side * 0.03, d.wristY - 0.035, -0.03, 0, 0, side * 0.4, 0.02, 0.05, 0.022), skin);
  }
}

// ── legs ────────────────────────────────────────────────────────────────────
function buildLegs(c: BodyCtx): void {
  const { d, s } = c;
  const w = d.w;
  const pants = c.armored ? shade(s.secondary, 0.55) : c.bare ? shade(s.secondary, 0.8) : shade(s.primary, 0.82);
  const robeLeg = c.robed ? col(s.primary) : pants;
  for (const side of [-1, 1] as const) {
    const x = side * d.hipX;
    const U: BoneName = side < 0 ? 'legUL' : 'legUR';
    const L: BoneName = side < 0 ? 'legLL' : 'legLR';
    const F: BoneName = side < 0 ? 'footL' : 'footR';
    c.on(U);
    frustum(c, c.v(x, d.hipY + 0.02, 0), c.v(x, d.kneeY, 0), 0.085 * w, 0.062 * w, robeLeg);
    ball(c, x, d.kneeY, 0, 0.058 * w, robeLeg);
    if (c.robed) {
      // robe skirt flap on the outside of each thigh
      c.b.add(
        PRIM.box(),
        trs(x + side * 0.045 * w, (d.hipY + d.kneeY) / 2 - 0.02, 0, 0, 0, -side * 0.06, 0.05, d.hipY - d.kneeY + 0.08, 0.2 * d.depth),
        robeLeg,
      );
    }
    if (c.armored) {
      // tassets (甲裙)
      c.b.add(
        PRIM.box(),
        trs(x + side * 0.035 * w, d.hipY - 0.11, -0.01, 0.0, 0, -side * 0.1, 0.13 * w, 0.26, 0.19 * d.depth),
        s.secondary,
      );
      c.b.add(
        PRIM.box(),
        trs(x + side * 0.045 * w, d.hipY - 0.235, -0.01, 0.0, 0, -side * 0.1, 0.135 * w, 0.025, 0.195 * d.depth),
        s.accent,
      );
    }
    c.on(L);
    frustum(c, c.v(x, d.kneeY, 0), c.v(x, d.ankleY + 0.03, 0), 0.058 * w, 0.046 * w, robeLeg);
    if (c.robed) {
      // wide robe trouser hem (flares at the ankle)
      frustum(c, c.v(x, d.kneeY - 0.05, 0), c.v(x, d.ankleY + 0.1, 0), 0.068 * w, 0.085 * w, robeLeg, 8);
      frustum(c, c.v(x, d.ankleY + 0.12, 0), c.v(x, d.ankleY + 0.09, 0), 0.086 * w, 0.088 * w, s.accent, 8);
    } else {
      // boots
      frustum(c, c.v(x, d.ankleY, 0), c.v(x, d.kneeY - 0.08, 0), 0.06 * w, 0.058 * w, BOOT);
      frustum(c, c.v(x, d.kneeY - 0.06, 0), c.v(x, d.kneeY - 0.1, 0), 0.064 * w, 0.064 * w, s.accent);
    }
    c.on(F);
    c.b.boxAt(x, 0.04, -0.04, 0.085 * w + 0.01, 0.08, 0.2, BOOT);
    c.b.add(PRIM.box(), trs(x, 0.055, -0.15, -0.35, 0, 0, 0.07 * w + 0.01, 0.05, 0.06), BOOT); // upturned toe
  }
}

// ── head ────────────────────────────────────────────────────────────────────
function buildHead(c: BodyCtx): void {
  const { d, s, b } = c;
  const hs = d.headScale;
  const face = col(s.face);
  const skin = col(s.skin);
  const cy = d.headCY;
  c.on('head');
  // neck
  frustum(c, c.v(0, d.neckY - 0.06, 0.005), c.v(0, d.neckY + 0.08, 0.005), 0.052 * d.w, 0.048, skin);
  // skull + jaw
  b.add(PRIM.sphere(10, 8), trs(0, cy, 0.005, 0, 0, 0, 0.106 * hs, 0.128 * hs, 0.116 * hs), face);
  b.add(
    PRIM.sphere(8, 6),
    trs(0, cy - 0.055 * hs, -0.022 * hs, 0, 0, 0, (s.female ? 0.078 : 0.088) * hs, 0.07 * hs, 0.085 * hs),
    face,
  );
  // ears
  b.boxAt(-0.105 * hs, cy - 0.005, 0.01, 0.02, 0.045, 0.035, face);
  b.boxAt(0.105 * hs, cy - 0.005, 0.01, 0.02, 0.045, 0.035, face);
  const fz = -0.113 * hs;
  // eyes (whites + pupils) and brows
  for (const sx of [-1, 1]) {
    b.boxAt(sx * 0.04 * hs, cy + 0.012 * hs, fz + 0.002, 0.034 * hs, 0.018 * hs, 0.01, '#f2ece0');
    b.boxAt(sx * 0.038 * hs, cy + 0.011 * hs, fz - 0.002, 0.016 * hs, 0.018 * hs, 0.01, EYE);
    b.add(
      PRIM.box(),
      trs(sx * 0.043 * hs, cy + 0.042 * hs, fz + 0.001, 0, 0, sx * (s.female ? 0.08 : -0.22), 0.046 * hs, (s.female ? 0.008 : 0.014) * hs, 0.014),
      s.female ? s.hair : shade(s.hair, 0.9),
    );
  }
  // nose + mouth
  b.add(PRIM.box(), trs(0, cy - 0.012 * hs, fz - 0.006, -0.2, 0, 0, 0.024 * hs, 0.046 * hs, 0.028), shade(s.face, 0.92));
  b.boxAt(0, cy - 0.058 * hs, fz + 0.012, 0.038 * hs, 0.009 * hs, 0.01, s.female ? '#b8474a' : shade(s.face, 0.62));
  if (s.female) {
    // blush
    b.boxAt(-0.06 * hs, cy - 0.025 * hs, fz + 0.012, 0.025, 0.012, 0.006, mixCol(s.face, '#e07070', 0.4));
    b.boxAt(0.06 * hs, cy - 0.025 * hs, fz + 0.012, 0.025, 0.012, 0.006, mixCol(s.face, '#e07070', 0.4));
  }
}

// ── troop shield ────────────────────────────────────────────────────────────
function buildShield(c: BodyCtx): void {
  const { d, s, b } = c;
  const x = -d.shoulderX - 0.07;
  const y = (d.elbowY + d.wristY) / 2;
  c.on('armLL');
  // round shield facing outward (−X)
  b.add(PRIM.cyl(12), trs(x, y, 0, 0, 0, Math.PI / 2, 0.3, 0.035, 0.3), s.secondary);
  b.add(PRIM.torus(0.08, 4, 14), trs(x - 0.02, y, 0, 0, Math.PI / 2, 0, 0.3, 0.3, 0.3), s.kingdom);
  b.add(PRIM.sphere(8, 5), trs(x - 0.03, y, 0, 0, 0, 0, 0.06, 0.06, 0.06), s.primary);
  // painted tiger-face stripes
  for (let i = -1; i <= 1; i++) b.boxAt(x - 0.022, y + i * 0.09, 0, 0.01, 0.025, 0.36 - Math.abs(i) * 0.14, s.kingdom);
}
