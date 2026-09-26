// Architecture props: walls, gate towers, palace, houses, pavilions, watch
// towers. Proportions follow the collider conventions in sim/map/props.ts so
// what you see is what you collide with.
import { ARCH } from '../palette';
import type { ColorLike } from '../core/geo';
import { hipRoof, copingRoof } from './roof';
import { PropCtx, SURF, boxMM, door, jitter, lantern, lattice, pillar, plain, roofExtras, shade, mixCol, surf, trs, PRIM, V } from './propkit';
import {
  GATE_HALL_H,
  GATE_LINTEL,
  GATE_PIER,
  GATE_PILLAR_INSET,
  PALACE_BASE,
  PARAPET_H,
  PARAPET_T,
  WT_GAP,
  WT_PARAPET_H,
  WT_PARAPET_T,
  WT_POST_H,
  pavilionPillars,
} from '../../sim/map/props';

/**
 * Brick courses on both long faces of a local box — procedural-look detail
 * only: the brick texture paints its own mortar, so the textured material
 * drops these strips (SURF.procDetail).
 */
function courses(c: PropCtx, x0: number, x1: number, y0: number, y1: number, zFront: number, zBack: number, color: ColorLike): void {
  const step = 0.9;
  const prev = c.b.extra;
  surf(c, SURF.procDetail);
  for (let y = y0 + step; y < y1 - 0.2; y += step) {
    c.b.boxAt((x0 + x1) / 2, y, zFront - 0.015, x1 - x0, 0.05, 0.04, color);
    c.b.boxAt((x0 + x1) / 2, y, zBack + 0.015, x1 - x0, 0.05, 0.04, color);
  }
  c.b.extra = prev;
}

/** Merlons along X on top of y0 (crenellated parapet), thickness t at z. */
function merlons(c: PropCtx, x0: number, x1: number, y0: number, z: number, t: number, h: number, color: ColorLike): void {
  const len = x1 - x0;
  const n = Math.max(1, Math.round(len / 2));
  const pitch = len / n;
  for (let i = 0; i < n; i++) {
    const mx = x0 + pitch * (i + 0.5);
    c.b.boxAt(mx, y0 + h / 2, z, pitch * 0.62, h, t, color);
  }
}

export function buildWall(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  switch (p.variant) {
    case 1: {
      // 女墙 parapet: solid lower 60 %, merlons above
      surf(c, SURF.brick);
      const stone = jitter(c, ARCH.brick, 0.05);
      boxMM(b, -hx, 0, -hz, hx, sy * 0.6, hz, stone);
      merlons(c, -hx, hx, sy * 0.6, 0, sz, sy * 0.4, shade(ARCH.brick, 1.05));
      break;
    }
    case 2: {
      // white courtyard wall with a grey tile coping
      const base = Math.min(0.6, sy * 0.2);
      surf(c, SURF.paving);
      boxMM(b, -hx, -0.3, -hz, hx, base, hz, ARCH.stoneDark);
      surf(c, SURF.plaster);
      boxMM(b, -hx, base, -hz * 0.92, hx, sy - 0.35, hz * 0.92, jitter(c, ARCH.wallWhite, 0.03));
      copingRoof(b, 0, sy - 0.35, 0, sx + 0.1, sz + 0.5, 0.45, ARCH.roofTile);
      break;
    }
    case 3: {
      // timber palisade
      surf(c, SURF.woodV);
      const n = Math.max(2, Math.round(sx / 0.32));
      for (let i = 0; i < n; i++) {
        const x = -hx + ((i + 0.5) * sx) / n;
        const h = sy * (0.92 + c.rand() * 0.12);
        b.cylAt(x, -0.3, 0, Math.min(0.17, sz / 2), h + 0.3, jitter(c, ARCH.wood, 0.12), 6);
        b.add(PRIM.cone(6), trs(x, h + 0.18, 0, 0, 0, 0, Math.min(0.17, sz / 2), 0.36, Math.min(0.17, sz / 2)), ARCH.woodLight);
      }
      surf(c, SURF.planks);
      boxMM(b, -hx, sy * 0.25, -hz - 0.05, hx, sy * 0.25 + 0.2, -hz + 0.1, ARCH.woodDark);
      boxMM(b, -hx, sy * 0.7, -hz - 0.05, hx, sy * 0.7 + 0.2, -hz + 0.1, ARCH.woodDark);
      break;
    }
    default: {
      // rammed earth core with grey brick facing, battered base and coping
      const brick = jitter(c, ARCH.brick, 0.04);
      surf(c, SURF.brick);
      boxMM(b, -hx, -0.5, -hz, hx, sy, hz, brick);
      surf(c, SURF.paving);
      boxMM(b, -hx, -0.5, -hz - 0.25, hx, Math.min(1.2, sy * 0.15), hz + 0.25, ARCH.stoneDark);
      surf(c, SURF.brick);
      courses(c, -hx, hx, 0, sy, -hz, hz, shade(ARCH.brick, 0.8));
      surf(c, SURF.paving);
      boxMM(b, -hx, sy - 0.12, -hz - 0.12, hx, sy + 0.05, hz + 0.12, ARCH.stone);
      // walkway paving
      boxMM(b, -hx, sy + 0.05, -hz + 0.1, hx, sy + 0.07, hz - 0.1, mixCol(ARCH.stone, ARCH.earth, 0.3));
      // drainage spouts along the outer face
      surf(c, SURF.plain);
      for (let x = -hx + 4; x < hx - 2; x += 8) b.boxAt(x, sy - 0.6, -hz - 0.25, 0.25, 0.2, 0.5, ARCH.stoneDark);
      break;
    }
  }
}

export function buildGateTower(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  const passage = Math.max(0, sx - 2 * GATE_PIER);
  const brick = jitter(c, ARCH.brick, 0.04);
  surf(c, SURF.brick);
  // piers
  boxMM(b, -hx, -0.5, -hz, -hx + GATE_PIER, sy, hz, brick);
  boxMM(b, hx - GATE_PIER, -0.5, -hz, hx, sy, hz, brick);
  courses(c, -hx, -hx + GATE_PIER, 0, sy, -hz, hz, shade(ARCH.brick, 0.8));
  courses(c, hx - GATE_PIER, hx, 0, sy, -hz, hz, shade(ARCH.brick, 0.8));
  // lintel deck over the passage (+ an arch face on both sides)
  boxMM(b, -passage / 2, sy - GATE_LINTEL, -hz, passage / 2, sy, hz, shade(ARCH.brick, 0.95));
  surf(c, SURF.paving);
  for (const zs of [-1, 1]) {
    const z = zs * (hz + 0.02);
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI;
      const a1 = ((i + 1) / segs) * Math.PI;
      const r = passage / 2;
      const yb = sy - GATE_LINTEL - r * 0.35;
      const x0 = -Math.cos(a0) * r;
      const x1 = -Math.cos(a1) * r;
      const y0 = yb + Math.sin(a0) * r * 0.35;
      const y1 = yb + Math.sin(a1) * r * 0.35;
      b.add(PRIM.box(), trs((x0 + x1) / 2, (y0 + y1) / 2 + 0.2, z, 0, 0, Math.atan2(y1 - y0, x1 - x0), Math.hypot(x1 - x0, y1 - y0) + 0.05, 0.4, 0.1), ARCH.stoneLight);
    }
  }
  // open door leaves, recessed against the passage walls
  const dh = Math.max(2.5, sy - GATE_LINTEL - 0.4);
  for (const sgn of [-1, 1]) {
    surf(c, SURF.woodV);
    b.boxAt(sgn * (passage / 2 - 0.12), dh / 2, -hz * 0.3, 0.14, dh, passage / 2 - 0.1, ARCH.pillarRedDark);
    surf(c, SURF.plain);
    for (let r = 0; r < 5; r++) b.boxAt(sgn * (passage / 2 - 0.2), dh * (0.15 + r * 0.17), -hz * 0.3, 0.04, 0.06, passage / 2 - 0.3, ARCH.gold);
  }
  // front breastwork (crenellated) + back railing
  surf(c, SURF.brick);
  boxMM(b, -hx, sy, -hz, hx, sy + PARAPET_H * 0.6, -hz + PARAPET_T, brick);
  merlons(c, -hx, hx, sy + PARAPET_H * 0.6, -hz + PARAPET_T / 2, PARAPET_T, PARAPET_H * 0.4, shade(ARCH.brick, 1.05));
  // hall on top
  const top = sy;
  const px = hx - GATE_PILLAR_INSET;
  const pz = hz - GATE_PILLAR_INSET;
  for (const lx of [-px, px]) for (const lz of [-pz, pz]) pillar(b, lx, top, lz, 0.3, GATE_HALL_H);
  // inner hall walls (set back) with lattice windows
  const iw = Math.max(2, sx - 5);
  const idp = Math.max(1.5, sz - 2.4);
  surf(c, SURF.plaster);
  boxMM(b, -iw / 2, top, -idp / 2, iw / 2, top + GATE_HALL_H - 0.4, idp / 2, ARCH.wallPlaster);
  surf(c, SURF.plain);
  for (let x = -iw / 2 + 1.2; x < iw / 2 - 0.8; x += 2) {
    lattice(b, x, top + 1.7, -idp / 2 - 0.02, 1.2, 1.6, ARCH.pillarRedDark);
    lattice(b, x, top + 1.7, idp / 2 + 0.02, 1.2, 1.6, ARCH.pillarRedDark, 1);
  }
  // beams
  boxMM(b, -hx, top + GATE_HALL_H - 0.4, -hz + 0.05, hx, top + GATE_HALL_H, -hz + 0.5, '#2f6b5a');
  boxMM(b, -hx, top + GATE_HALL_H - 0.4, hz - 0.5, hx, top + GATE_HALL_H, hz - 0.05, '#2f6b5a');
  // double-eave roof (重檐)
  const roofY = top + GATE_HALL_H;
  const v1 = p.variant === 1;
  hipRoof(b, 0, roofY, 0, sx + 0.2, sz + 0.2, 1.4, { ...roofExtras(c), color: ARCH.roofTile, overhang: 0.9, ridge: 0.9, upturn: 0.55, plain: true });
  hipRoof(b, 0, roofY + 1.3, 0, sx * 0.72, sz * 0.72, v1 ? 3.2 : 2.6, { ...roofExtras(c), color: ARCH.roofTile, overhang: 0.8, ridge: 0.7, upturn: 0.6 });
  // plaque (匾额) on the front
  b.boxAt(0, roofY - 0.1, -hz - 0.1, 2.2, 0.8, 0.08, ARCH.ink);
  b.boxAt(0, roofY - 0.1, -hz - 0.14, 1.9, 0.55, 0.02, ARCH.gold);
  // lanterns flanking the gate
  lantern(c, -passage / 2 - 0.6, sy - GATE_LINTEL - 0.8, -hz - 0.5, 0.3);
  lantern(c, passage / 2 + 0.6, sy - GATE_LINTEL - 0.8, -hz - 0.5, 0.3);
}

export function buildPalace(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const base = PALACE_BASE;
  const hallH = 0.4 * (sy - base);
  // 台基 terrace with white marble balustrade
  surf(c, SURF.paving);
  boxMM(b, -sx / 2, -1, -sz / 2, sx / 2, base, sz / 2, ARCH.stoneLight);
  boxMM(b, -sx / 2 - 0.1, base - 0.15, -sz / 2 - 0.1, sx / 2 + 0.1, base, sz / 2 + 0.1, '#e8e2d4');
  surf(c, SURF.plain);
  for (let x = -sx / 2 + 0.3; x <= sx / 2 - 0.2; x += 1.6) {
    if (Math.abs(x) < 3) continue; // stairs gap in front
    b.boxAt(x, base + 0.45, -sz / 2 + 0.15, 0.18, 0.9, 0.18, '#ece6d8');
  }
  boxMM(b, -sx / 2 + 0.2, base + 0.6, -sz / 2 + 0.1, -3, base + 0.72, -sz / 2 + 0.2, '#ece6d8');
  boxMM(b, 3, base + 0.6, -sz / 2 + 0.1, sx / 2 - 0.2, base + 0.72, -sz / 2 + 0.2, '#ece6d8');
  // hall body
  const hw = 0.7 * sx;
  const hd = 0.55 * sz;
  surf(c, SURF.plaster);
  boxMM(b, -hw / 2, base, -hd / 2, hw / 2, base + hallH, hd / 2, '#a8342a');
  surf(c, SURF.plain);
  // front: row of lattice doors between the wall posts
  const nDoors = Math.max(3, Math.round(hw / 2.4));
  for (let i = 0; i < nDoors; i++) {
    const x = -hw / 2 + (i + 0.5) * (hw / nDoors);
    lattice(b, x, base + hallH * 0.45, -hd / 2 - 0.02, hw / nDoors - 0.35, hallH * 0.8, ARCH.gold, -1, '#b8402e');
  }
  // colonnade
  const cz = -(0.275 * sz + 1.3);
  for (let i = 0; i < 6; i++) pillar(b, -0.3 * sx + i * 0.12 * sx, base, cz, 0.35, hallH);
  boxMM(b, -0.33 * sx, base + hallH - 0.5, cz - 0.25, 0.33 * sx, base + hallH, cz + 0.25, '#2f6b5a');
  // lower eave roof (overhangs the colonnade) + upper main roof (glazed tiles)
  const lowerY = base + hallH;
  hipRoof(b, 0, lowerY, 0, 0.84 * sx, 0.8 * sz, 1.4, { ...roofExtras(c),
    color: ARCH.roofGlazed,
    overhang: 1.2,
    ridge: 0.95,
    upturn: 0.7,
    plain: true,
    underside: '#3a5a4a',
  });
  surf(c, SURF.plaster);
  boxMM(b, -0.6 * sx / 2, lowerY + 0.6, -0.45 * sz / 2, 0.6 * sx / 2, lowerY + 1.6, 0.45 * sz / 2, '#a8342a');
  surf(c, SURF.plain);
  hipRoof(b, 0, lowerY + 1.6, 0, 0.6 * sx, 0.45 * sz, Math.max(2, sy - lowerY - 1.6), { ...roofExtras(c),
    color: ARCH.roofGlazed,
    overhang: 1.3,
    ridge: 0.7,
    upturn: 0.9,
    ornate: true,
    ridgeColor: '#b07a22',
    underside: '#3a5a4a',
  });
  // bronze cauldrons + lanterns before the hall
  for (const sgn of [-1, 1]) {
    const x = sgn * 0.3 * sx;
    b.cylAt(x, base, -sz / 2 + 1.6, 0.5, 0.2, ARCH.stoneDark, 8);
    b.add(PRIM.sphere(10, 6), trs(x, base + 0.75, -sz / 2 + 1.6, 0, 0, 0, 0.6, 0.45, 0.6), ARCH.bronzeGreen);
    lantern(c, sgn * (hw / 2 - 0.6), base + hallH - 0.9, cz, 0.32);
  }
}

export function buildHouse(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const wallH = 0.58 * sy;
  const hx = sx / 2;
  const hz = sz / 2;
  const v = p.variant;
  const wallCol =
    v === 1 ? jitter(c, ARCH.woodLight, 0.1) : v === 3 ? jitter(c, '#b59a72', 0.08) : jitter(c, ARCH.wallWhite, 0.04);
  // foundation plinth down into the ground
  surf(c, SURF.paving);
  boxMM(b, -hx - 0.1, Math.min(-0.5, c.groundAt(0, 0) - 0.5), -hz - 0.1, hx + 0.1, 0.35, hz + 0.1, ARCH.stoneDark);
  const wallSurf = v === 1 ? SURF.planks : SURF.plaster;
  surf(c, wallSurf);
  if (v === 2) {
    // two-storey hall / shop: ground floor, mid eave, upper floor
    const f1 = wallH * 0.52;
    boxMM(b, -hx, 0.35, -hz, hx, f1, hz, wallCol);
    hipRoof(b, 0, f1, 0, sx, sz, 0.9, { ...roofExtras(c), color: ARCH.roofTile, overhang: 0.7, ridge: 1, upturn: 0.3, plain: true });
    surf(c, wallSurf);
    boxMM(b, -hx * 0.9, f1 + 0.3, -hz * 0.9, hx * 0.9, wallH, hz * 0.9, wallCol);
    for (let x = -hx + 1.2; x < hx - 0.8; x += 1.8) lattice(b, x, f1 + (wallH - f1) * 0.55, -hz * 0.9 - 0.02, 1.1, 0.9, ARCH.pillarRedDark);
    // shop sign
    c.cloth.add(PRIM.box(), trs(hx - 0.8, f1 - 1.1, -hz - 0.35, 0, 0, 0, 0.5, 1.6, 0.02), '#c8322a');
  } else {
    boxMM(b, -hx, 0.35, -hz, hx, wallH, hz, wallCol);
  }
  // timber frame: corner posts + top beam
  const frame = v === 1 ? ARCH.woodDark : ARCH.wood;
  surf(c, SURF.woodV);
  for (const [x, z] of [
    [-hx, -hz],
    [hx, -hz],
    [-hx, hz],
    [hx, hz],
  ])
    b.boxAt(x, wallH / 2 + 0.17, z, 0.26, wallH - 0.34, 0.26, frame);
  surf(c, SURF.planks);
  boxMM(b, -hx - 0.05, wallH - 0.25, -hz - 0.05, hx + 0.05, wallH, hz + 0.05, frame);
  if (v === 1) {
    for (let y = 0.8; y < wallH - 0.3; y += 0.45) {
      b.boxAt(0, y, -hz - 0.02, sx, 0.04, 0.03, ARCH.woodDark);
      b.boxAt(0, y, hz + 0.02, sx, 0.04, 0.03, ARCH.woodDark);
    }
  }
  // front door + windows
  const dh = Math.min(2.4, wallH - 0.7);
  door(b, 0, 0.35, -hz, Math.min(1.5, sx * 0.3), dh, v === 3 ? ARCH.wood : ARCH.pillarRedDark);
  if (sx > 4.5) {
    lattice(b, -hx * 0.62, 0.35 + dh * 0.62, -hz - 0.02, 1.0, 0.8, ARCH.woodDark);
    lattice(b, hx * 0.62, 0.35 + dh * 0.62, -hz - 0.02, 1.0, 0.8, ARCH.woodDark);
  }
  for (const sgn of [-1, 1]) {
    b.push(trs(sgn * hx, 0, 0, 0, sgn * Math.PI / 2, 0));
    lattice(b, 0, 0.35 + dh * 0.6, -0.02, Math.min(1.2, sz * 0.3), 0.8, ARCH.woodDark);
    b.pop();
  }
  // roof
  const roofH = sy - wallH;
  if (v === 3) {
    // thatch: steep, no upturn, straw colour
    hipRoof(b, 0, wallH, 0, sx, sz, roofH, { ...roofExtras(c),
      color: '#b8994e',
      overhang: 0.6,
      ridge: 0.8,
      curve: 1.05,
      upturn: 0,
      stripes: false,
      plain: true,
      underside: '#7a6030',
      thickness: 0.3,
      surface: SURF.plain,
    });
    surf(c, SURF.plain);
    b.boxAt(0, sy + 0.05, 0, Math.max(0.5, sx - sz) * 0.8 + 0.4, 0.2, 0.4, '#8a7038');
  } else {
    const wide = v === 4;
    hipRoof(b, 0, wallH, 0, sx, sz, roofH, { ...roofExtras(c),
      color: jitter(c, v === 1 ? ARCH.roofTileDark : ARCH.roofTile, 0.05),
      overhang: wide ? 0.9 : 0.6,
      ridge: 0.75,
      upturn: wide ? 0.35 : 0.45,
      curve: 1.6,
    });
  }
  // eave lanterns on city houses
  if ((v === 0 || v === 2) && c.rand() < 0.5) {
    lantern(c, -Math.min(1.5, sx * 0.3) / 2 - 0.5, wallH - 0.45, -hz - 0.45, 0.2);
    lantern(c, Math.min(1.5, sx * 0.3) / 2 + 0.5, wallH - 0.45, -hz - 0.45, 0.2);
  }
}

export function buildPavilion(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const pillarTop = 0.3 + 0.55 * sy;
  surf(c, SURF.paving);
  boxMM(b, -sx / 2, -0.6, -sz / 2, sx / 2, 0.3, sz / 2, ARCH.stoneLight);
  boxMM(b, -sx / 2 + 0.1, 0.28, -sz / 2 + 0.1, sx / 2 - 0.1, 0.32, sz / 2 - 0.1, mixCol(ARCH.stoneLight, '#ffffff', 0.2));
  surf(c, SURF.plain);
  const pillars = pavilionPillars(p);
  for (const pp of pillars) pillar(b, pp.lx, 0.3, pp.lz, 0.22, pillarTop - 0.3);
  // beams around the top + railings (美人靠) on three sides
  const bx = sx / 2 - 0.35;
  const bz = sz / 2 - 0.35;
  boxMM(b, -bx, pillarTop - 0.45, -bz - 0.12, bx, pillarTop, -bz + 0.12, '#2f6b5a');
  boxMM(b, -bx, pillarTop - 0.45, bz - 0.12, bx, pillarTop, bz + 0.12, '#2f6b5a');
  boxMM(b, -bx - 0.12, pillarTop - 0.45, -bz, -bx + 0.12, pillarTop, bz, '#2f6b5a');
  boxMM(b, bx - 0.12, pillarTop - 0.45, -bz, bx + 0.12, pillarTop, bz, '#2f6b5a');
  boxMM(b, -bx, 0.3, bz - 0.2, bx, 0.75, bz + 0.05, ARCH.pillarRedDark);
  boxMM(b, -bx - 0.05, 0.3, -bz * 0.6, -bx + 0.2, 0.75, bz, ARCH.pillarRedDark);
  boxMM(b, bx - 0.2, 0.3, -bz * 0.6, bx + 0.05, 0.75, bz, ARCH.pillarRedDark);
  // stone table
  surf(c, SURF.paving);
  b.cylAt(0, 0.3, 0, 0.12, 0.6, ARCH.stone, 6);
  b.cylAt(0, 0.9, 0, 0.55, 0.08, ARCH.stoneLight, 10);
  // roof: pyramid for squarish plans, hip for long ones
  const square = Math.abs(sx - sz) < 1.5;
  hipRoof(b, 0, pillarTop, 0, sx + 0.2, sz + 0.2, sy - pillarTop, { ...roofExtras(c),
    color: p.variant % 2 === 1 ? ARCH.roofGreen : ARCH.roofTile,
    overhang: 0.6,
    ridge: square ? 0 : 0.6,
    upturn: 0.65,
    curve: 1.9,
    ornate: true,
  });
  lantern(c, 0, pillarTop - 0.6, -bz, 0.22);
}

export function buildWatchtower(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  const top = sy;
  const timber = p.variant === 1;
  if (timber) {
    // timber-clad block with corner legs and cross bracing
    surf(c, SURF.planks);
    boxMM(b, -hx + 0.1, -0.4, -hz + 0.1, hx - 0.1, top, hz - 0.1, jitter(c, ARCH.woodLight, 0.08));
    surf(c, SURF.woodV);
    for (const [x, z] of [
      [-hx, -hz],
      [hx, -hz],
      [-hx, hz],
      [hx, hz],
    ])
      b.boxAt(x * 0.95, top / 2 - 0.2, z * 0.95, 0.35, top + 0.4, 0.35, ARCH.woodDark);
    for (let y = 1.5; y < top - 0.5; y += 2.2) {
      b.add(PRIM.box(), trs(0, y + 1, -hz - 0.02, 0, 0, Math.atan2(2.2, sx), Math.hypot(sx, 2.2), 0.14, 0.08), ARCH.woodDark);
      b.add(PRIM.box(), trs(0, y + 1, hz + 0.02, 0, 0, -Math.atan2(2.2, sx), Math.hypot(sx, 2.2), 0.14, 0.08), ARCH.woodDark);
    }
    surf(c, SURF.planks);
    boxMM(b, -hx - 0.1, top - 0.25, -hz - 0.1, hx + 0.1, top, hz + 0.1, ARCH.woodDark);
  } else {
    const brick = jitter(c, ARCH.brick, 0.04);
    surf(c, SURF.brick);
    boxMM(b, -hx, -0.5, -hz, hx, top, hz, brick);
    courses(c, -hx, hx, 0, top, -hz, hz, shade(ARCH.brick, 0.8));
    surf(c, SURF.paving);
    boxMM(b, -hx - 0.15, top - 0.2, -hz - 0.15, hx + 0.15, top, hz + 0.15, ARCH.stone);
    // arrow slits
    surf(c, SURF.plain);
    for (let y = 2.5; y < top - 1; y += 3) b.boxAt(0, y, -hz - 0.02, 0.25, 1.0, 0.04, '#1a1410');
  }
  // parapets on the platform (back gap for the stairs)
  const pt = WT_PARAPET_T;
  const ph = WT_PARAPET_H;
  const pc = timber ? ARCH.wood : ARCH.brick;
  surf(c, timber ? SURF.planks : SURF.brick);
  boxMM(b, -hx, top, -hz, hx, top + ph, -hz + pt, pc);
  boxMM(b, -hx, top, -hz, -hx + pt, top + ph, hz, pc);
  boxMM(b, hx - pt, top, -hz, hx, top + ph, hz, pc);
  const seg = (sx - WT_GAP) / 2;
  boxMM(b, -hx, top, hz - pt, -hx + seg, top + ph, hz, pc);
  boxMM(b, hx - seg, top, hz - pt, hx, top + ph, hz, pc);
  if (!timber) merlons(c, -hx, hx, top + ph, -hz + pt / 2, pt, 0.35, ARCH.brick);
  // corner posts + roof
  surf(c, timber ? SURF.woodV : SURF.plain);
  for (const lx of [-(hx - 0.18), hx - 0.18]) for (const lz of [-(hz - 0.18), hz - 0.18]) b.cylAt(lx, top + ph * 0.5, lz, 0.18, WT_POST_H - ph * 0.5, timber ? ARCH.woodDark : ARCH.pillarRed, 6);
  hipRoof(b, 0, top + WT_POST_H, 0, sx + 0.6, sz + 0.6, 1.6, { ...roofExtras(c),
    color: timber ? '#8a7048' : ARCH.roofTile,
    overhang: 0.6,
    ridge: 0.2,
    upturn: timber ? 0.1 : 0.45,
    stripes: !timber,
    surface: timber ? SURF.planks : SURF.roof,
  });
  // signal flag
  surf(c, SURF.woodV);
  c.b.rod(V(hx - 0.3, top + WT_POST_H + 1, hz - 0.3), V(hx - 0.3, top + WT_POST_H + 3.2, hz - 0.3), 0.05, ARCH.woodDark, 4);
}

export { GATE_LINTEL };
