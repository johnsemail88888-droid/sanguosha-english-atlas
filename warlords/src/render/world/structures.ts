// Non-building props: tents, barricades, crates, bridges, docks, ships,
// statues, ruins, fields, stairs, brazier stands and banner poles.
import * as THREE from 'three';
import { ARCH, NATURE } from '../palette';
import type { ColorLike } from '../core/geo';
import { buildCharacter } from '../models/humanoid';
import { hipRoof } from './roof';
import { face, tri } from './roof';
import { PropCtx, SURF, boxMM, jitter, lantern, lattice, pillar, roofExtras, shade, mixCol, surf, trs, PRIM, V, col } from './propkit';
import {
  BRIDGE_DECK_T,
  BRIDGE_RAIL_H,
  BRIDGE_RAIL_T,
  DOCK_DECK_T,
  SHIP_BULWARK_H,
  SHIP_BULWARK_T,
  SHIP_CABIN_H,
  bridgePiers,
  stairSteps,
} from '../../sim/map/props';

const cloth = (c: PropCtx, fallback: string): string => c.p.color ?? fallback;

/** Draw with plain (untextured) surfaces, restoring the current one. */
function plainBox(c: PropCtx, fn: () => void): void {
  const prev = c.b.extra;
  c.b.extra = SURF.plain;
  fn();
  c.b.extra = prev;
}

export function buildTent(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  const cc = jitter(c, cloth(c, p.variant === 3 ? '#b89a50' : '#d8cfb8'), 0.05);
  const trim = p.variant === 1 ? ARCH.gold : shade(cc, 0.7);
  switch (p.variant) {
    case 1: {
      // large command tent: cloth walls + hip roof + valance + door
      const wallH = sy * 0.45;
      boxMM(b, -hx, -0.2, -hz, hx, wallH, hz, cc);
      boxMM(b, -hx - 0.05, wallH - 0.35, -hz - 0.05, hx + 0.05, wallH, hz + 0.05, mixCol(cc, '#c0392b', 0.6));
      for (let x = -hx + 0.4; x < hx; x += 0.8) b.add(PRIM.cone(3), trs(x, wallH - 0.45, -hz - 0.06, Math.PI, 0, 0, 0.18, 0.2, 0.03), trim);
      boxMM(b, -0.9, 0, -hz - 0.03, 0.9, wallH * 0.95, -hz - 0.01, '#2a1d14');
      hipRoof(b, 0, wallH, 0, sx, sz, sy - wallH, { ...roofExtras(c), color: cc, overhang: 0.35, ridge: 0.5, upturn: 0.1, curve: 1.15, stripes: false, plain: true, underside: shade(cc, 0.6), surface: SURF.plain });
      surf(c, SURF.woodV);
      b.rod(V(0, sy - 0.2, 0), V(0, sy + 2.6, 0), 0.05, ARCH.woodDark, 5);
      b.add(PRIM.cone(4), trs(0, sy + 2.75, 0, 0, 0, 0, 0.07, 0.3, 0.07), ARCH.gold);
      break;
    }
    case 2: {
      // 南蛮 hide tent: cone with poles poking out
      const r = Math.min(sx, sz) / 2;
      b.add(PRIM.cone(8), trs(0, sy / 2, 0, 0, 0, 0, r, sy, r), jitter(c, cloth(c, '#8a6a44'), 0.08));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.rod(V(Math.cos(a) * r * 0.9, 0, Math.sin(a) * r * 0.9), V(Math.cos(a) * 0.25, sy + 0.6, Math.sin(a) * 0.25), 0.05, ARCH.woodDark, 4);
      }
      b.boxAt(0, 0.8, -r * 0.55, 0.9, 1.6, 0.05, '#2a1d14');
      for (let i = 0; i < 3; i++) b.boxAt(0, sy * (0.3 + i * 0.12), 0, r * (1.6 - i * 0.35), 0.1, r * (1.6 - i * 0.35), '#c0392b');
      break;
    }
    default: {
      // ridge tent (ridge along local X); v3 = ragged 黄巾 tent
      const v = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z);
      const col2 = p.variant === 3 ? mixCol(cc, '#6b5530', 0.25) : cc;
      face(b, v(-hx, 0, -hz), v(hx, 0, -hz), v(hx, sy, 0), v(-hx, sy, 0), col2, V(0, 1, -1));
      face(b, v(-hx, 0, hz), v(hx, 0, hz), v(hx, sy, 0), v(-hx, sy, 0), shade(col2, 0.88), V(0, 1, 1));
      tri(b, v(-hx, 0, -hz), v(-hx, 0, hz), v(-hx, sy, 0), shade(col2, 0.8), V(-1, 0, 0));
      tri(b, v(hx, 0, -hz), v(hx, 0, hz), v(hx, sy, 0), shade(col2, 0.8), V(1, 0, 0));
      // door flap on the front slope
      face(b, v(-0.5, 0.02, -hz - 0.02), v(0.5, 0.02, -hz - 0.02), v(0.2, sy * 0.75, -hz * 0.25 - 0.02), v(-0.2, sy * 0.75, -hz * 0.25 - 0.02), '#2a1d14', V(0, 1, -1));
      b.rod(v(-hx - 0.1, 0, 0), v(-hx - 0.1, sy + 0.3, 0), 0.05, ARCH.woodDark, 4);
      b.rod(v(hx + 0.1, 0, 0), v(hx + 0.1, sy + 0.3, 0), 0.05, ARCH.woodDark, 4);
      b.boxAt(0, sy + 0.02, 0, sx + 0.1, 0.08, 0.1, trim);
      if (p.variant === 3) {
        for (let i = 0; i < 4; i++) {
          const px = (c.rand() - 0.5) * sx * 0.8;
          const pv = c.rand() * 0.6 + 0.15;
          b.add(PRIM.box(), trs(px, sy * pv, -hz * (1 - pv) - 0.03, Math.atan2(hz, sy), 0, 0, 0.6, 0.5, 0.02), c.rand() < 0.5 ? '#6b5530' : '#9a8a60');
        }
      }
      // guy ropes
      for (const sgn of [-1, 1]) {
        b.rod(v(-hx - 0.1, sy + 0.2, 0), v(-hx - 1.2, 0, sgn * 0.8), 0.012, ARCH.rope, 3);
        b.rod(v(hx + 0.1, sy + 0.2, 0), v(hx + 1.2, 0, sgn * 0.8), 0.012, ARCH.rope, 3);
      }
      break;
    }
  }
}

export function buildBarricade(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  switch (p.variant) {
    case 1: {
      // 拒马 cheval-de-frise: a log with crossed sharpened stakes
      const logY = sy * 0.5;
      surf(c, SURF.planks);
      b.add(PRIM.cyl(8), trs(0, logY, 0, 0, 0, Math.PI / 2, 0.16, sx, 0.16), ARCH.wood);
      surf(c, SURF.woodV);
      const n = Math.max(2, Math.round(sx / 0.9));
      for (let i = 0; i < n; i++) {
        const x = -hx + ((i + 0.5) * sx) / n;
        for (const sgn of [-1, 1]) {
          const a = V(x, logY - (sgn * sy) / 2, (-sgn * sz) / 2);
          const e = V(x, logY + (sgn * sy) / 2, (sgn * sz) / 2);
          b.rod(a, e, 0.06, jitter(c, ARCH.woodLight, 0.1), 5);
          // sharpened tip continuing the stake direction
          b.rod(e, e.clone().add(e.clone().sub(a).normalize().multiplyScalar(0.25)), 0.06, '#d8c9a0', 5, 0.05);
        }
      }
      break;
    }
    case 2: {
      // plank wall with struts
      surf(c, SURF.woodV);
      const n = Math.max(2, Math.round(sx / 0.3));
      for (let i = 0; i < n; i++) {
        const x = -hx + ((i + 0.5) * sx) / n;
        b.boxAt(x, sy / 2 - 0.15, 0, sx / n - 0.03, sy + 0.3 - c.rand() * 0.2, Math.min(0.12, sz), jitter(c, ARCH.woodLight, 0.15));
      }
      surf(c, SURF.planks);
      b.boxAt(0, sy * 0.3, -Math.min(0.12, sz) / 2 - 0.05, sx, 0.15, 0.08, ARCH.woodDark);
      b.boxAt(0, sy * 0.75, -Math.min(0.12, sz) / 2 - 0.05, sx, 0.15, 0.08, ARCH.woodDark);
      surf(c, SURF.woodV);
      for (let x = -hx + 0.5; x < hx; x += 2) b.add(PRIM.box(), trs(x, sy * 0.4, sz / 2 * 0.6, -0.6, 0, 0, 0.1, sy * 1.1, 0.1), ARCH.woodDark);
      break;
    }
    default: {
      // sandbags: a packed core with bags on the outer faces and the top layer
      const rows = Math.max(1, Math.round(sy / 0.28));
      const rh = sy / rows;
      const bagCol = '#b8a47a';
      boxMM(b, -hx + 0.05, 0, -sz / 2 + 0.12, hx - 0.05, sy - 0.05, sz / 2 - 0.12, shade(bagCol, 0.8));
      const depthN = Math.max(1, Math.round(sz / 0.5));
      for (let r = 0; r < rows; r++) {
        const n = Math.max(1, Math.round(sx / 0.75));
        const off = r % 2 ? 0.5 : 0;
        const top = r === rows - 1;
        const ks = top ? Array.from({ length: depthN }, (_, k) => k) : depthN > 1 ? [0, depthN - 1] : [0];
        for (let i = 0; i < n + (r % 2 ? -1 : 0); i++) {
          const x = -hx + (i + 0.5 + off) * (sx / n);
          for (const k of ks) {
            const z = -sz / 2 + (k + 0.5) * (sz / depthN);
            b.add(PRIM.sphere(6, 3), trs(x, r * rh + rh / 2, z, 0, c.rand() * 0.2 - 0.1, 0, sx / n / 2 + 0.02, rh / 2 + 0.03, 0.27), jitter(c, bagCol, 0.1));
          }
        }
      }
      break;
    }
  }
}

function crate(c: PropCtx, x: number, y0: number, z: number, w: number, h: number, d: number): void {
  const { b } = c;
  surf(c, SURF.planks);
  const wood = jitter(c, '#a07a48', 0.12);
  const dark = shade(wood, 0.6);
  b.boxAt(x, y0 + h / 2, z, w - 0.04, h - 0.04, d - 0.04, wood);
  b.boxAt(x, y0 + 0.06, z, w, 0.12, d, dark);
  b.boxAt(x, y0 + h - 0.06, z, w, 0.12, d, dark);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxAt(x + (sx * (w - 0.1)) / 2, y0 + h / 2, z + (sz * (d - 0.1)) / 2, 0.11, h, 0.11, dark);
  // diagonal brace on the front
  b.add(PRIM.box(), trs(x, y0 + h / 2, z - d / 2 - 0.01, 0, 0, Math.atan2(h, w), Math.hypot(w, h) * 0.85, 0.09, 0.03), dark);
}

function fillCrates(c: PropCtx, cx: number, y0: number, cz: number, w: number, h: number, d: number): void {
  const nx = Math.max(1, Math.round(w / 1.15));
  const nz = Math.max(1, Math.round(d / 1.15));
  const ny = Math.max(1, Math.round(h / 1.15));
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        crate(c, cx - w / 2 + (i + 0.5) * (w / nx), y0 + (j * h) / ny, cz - d / 2 + (k + 0.5) * (d / nz), w / nx, h / ny, d / nz);
}

export function buildCrateStack(c: PropCtx): void {
  const { p } = c;
  const { sx, sy, sz } = p;
  if (p.variant === 1) {
    fillCrates(c, 0, 0, 0, sx, sy / 2, sz);
    fillCrates(c, -sx / 4, sy / 2, 0, sx / 2, sy / 2, sz);
  } else if (p.variant === 2) {
    fillCrates(c, 0, 0, 0, sx, sy / 2, sz);
    fillCrates(c, 0, sy / 2, 0, sx / 2, sy / 2, sz / 2);
  } else fillCrates(c, 0, 0, 0, sx, sy, sz);
}

export function buildBridge(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  const v = p.variant;
  const deckCol = v === 0 ? ARCH.stoneLight : ARCH.woodLight;
  // deck
  if (v === 0) {
    surf(c, SURF.paving);
    boxMM(b, -hx, -BRIDGE_DECK_T, -hz, hx, 0, hz, deckCol);
    for (let x = -hx + 1; x < hx; x += 2) b.boxAt(x, 0.005, 0, 0.05, 0.02, sz - 0.5, shade(deckCol, 0.85));
  } else {
    // boards run across the deck (local Z)
    surf(c, SURF.planks, Math.PI / 2);
    const n = Math.max(2, Math.round(sx / 0.35));
    for (let i = 0; i < n; i++) {
      const x = -hx + ((i + 0.5) * sx) / n;
      b.boxAt(x, -0.1, 0, sx / n - 0.03, 0.2, sz, jitter(c, deckCol, 0.12));
    }
    surf(c, SURF.planks);
    boxMM(b, -hx, -BRIDGE_DECK_T, -hz + 0.3, hx, -0.2, hz - 0.3, ARCH.woodDark);
  }
  surf(c, v === 0 ? SURF.plain : SURF.planks);
  // rails: rz = sz/2 - 0.1, length sx - 2
  const rz = hz - BRIDGE_RAIL_T / 2;
  for (const sgn of [-1, 1]) {
    const z = sgn * rz;
    if (v === 0) {
      boxMM(b, -hx + 1, 0, z - BRIDGE_RAIL_T / 2, hx - 1, BRIDGE_RAIL_H * 0.75, z + BRIDGE_RAIL_T / 2, '#e8e2d4');
      boxMM(b, -hx + 1, BRIDGE_RAIL_H * 0.75, z - BRIDGE_RAIL_T / 2 - 0.02, hx - 1, BRIDGE_RAIL_H * 0.85, z + BRIDGE_RAIL_T / 2 + 0.02, ARCH.stoneLight);
      for (let x = -hx + 1; x <= hx - 1 + 1e-3; x += 2) {
        b.boxAt(x, BRIDGE_RAIL_H / 2 + 0.05, z, 0.26, BRIDGE_RAIL_H + 0.1, 0.26, '#ece6d8');
        b.add(PRIM.sphere(6, 4), trs(x, BRIDGE_RAIL_H + 0.18, z, 0, 0, 0, 0.13), '#ece6d8');
      }
    } else {
      surf(c, SURF.woodV);
      for (let x = -hx + 1; x <= hx - 1 + 1e-3; x += 1.6) b.boxAt(x, BRIDGE_RAIL_H / 2, z, 0.14, BRIDGE_RAIL_H, 0.14, ARCH.woodDark);
      surf(c, SURF.planks);
      boxMM(b, -hx + 1, BRIDGE_RAIL_H - 0.12, z - 0.07, hx - 1, BRIDGE_RAIL_H, z + 0.07, ARCH.wood);
      boxMM(b, -hx + 1, BRIDGE_RAIL_H * 0.5 - 0.05, z - 0.05, hx - 1, BRIDGE_RAIL_H * 0.5 + 0.05, z + 0.05, ARCH.wood);
    }
  }
  // piers
  const waterY = c.map.waterLevel - p.y;
  for (const lx of bridgePiers(p)) {
    if (v === 2) {
      // chained boats as floating piers
      boat(c, lx, waterY, 0, 1.6, sz + 0.8);
      b.boxAt(lx, (waterY - BRIDGE_DECK_T) / 2, 0, 0.3, Math.max(0.1, -waterY - BRIDGE_DECK_T), sz - 1, ARCH.woodDark);
    } else if (v === 1) {
      surf(c, SURF.woodV);
      for (const pz of [-hz + 0.5, 0, hz - 0.5]) b.cylAt(lx, -sy, pz, 0.18, sy - BRIDGE_DECK_T, ARCH.woodDark, 6);
      b.boxAt(lx, -BRIDGE_DECK_T - 0.15, 0, 0.3, 0.3, sz, ARCH.woodDark);
    } else {
      surf(c, SURF.paving);
      boxMM(b, lx - 0.6, -sy, -(sz - 0.4) / 2, lx + 0.6, -BRIDGE_DECK_T, (sz - 0.4) / 2, ARCH.stone);
      // cutwaters
      b.add(PRIM.prism(), trs(lx, -sy / 2 - BRIDGE_DECK_T / 2, -(sz - 0.4) / 2 - 0.5, Math.PI / 2, 0, 0, 1.2, 1.0, sy - BRIDGE_DECK_T), ARCH.stone);
    }
  }
  if (v === 2) {
    surf(c, SURF.plain);
    for (const sgn of [-1, 1]) b.rod(V(-hx, 0.05, sgn * (hz + 0.05)), V(hx, 0.05, sgn * (hz + 0.05)), 0.04, '#3a3a3a', 4);
  }
}

/** Small hull (for boat bridges / docks). Length along Z. */
function boat(c: PropCtx, x: number, waterY: number, z: number, beam: number, length: number): void {
  const { b } = c;
  surf(c, SURF.planks);
  const hull = jitter(c, '#5a3f28', 0.1);
  b.add(PRIM.sphere(8, 5), trs(x, waterY + 0.05, z, 0, 0, 0, beam / 2, 0.55, length / 2), hull);
  b.boxAt(x, waterY + 0.35, z, beam * 0.9, 0.12, length * 0.85, shade(hull, 1.2));
}

export function buildDock(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  const n = Math.max(2, Math.round(sz / 0.4));
  surf(c, SURF.planks);
  for (let i = 0; i < n; i++) {
    const z = -hz + ((i + 0.5) * sz) / n;
    b.boxAt(0, -0.09, z, sx, 0.18, sz / n - 0.03, jitter(c, ARCH.woodLight, 0.12));
  }
  boxMM(b, -hx, -DOCK_DECK_T, -hz, hx, -0.18, hz, ARCH.woodDark);
  // the low space between the water and the planks is no place for the camera
  // (a hero wading beside the dock would otherwise look up at the dark underside)
  c.occ?.addLocalBox(b.frame, 0, (-sy - DOCK_DECK_T) / 2, 0, hx, (sy - DOCK_DECK_T) / 2, hz);
  surf(c, SURF.woodV);
  for (let x = -hx + 0.3; x <= hx - 0.3 + 1e-3; x += Math.max(2, (sx - 0.6) / Math.max(1, Math.round((sx - 0.6) / 2.5)))) {
    for (const z of [-hz + 0.3, hz - 0.3]) b.cylAt(x, -sy, z, 0.16, sy + 0.1, ARCH.woodDark, 6);
  }
  for (const x of [-hx + 1, hx - 1]) {
    b.cylAt(x, 0, -hz + 0.4, 0.14, 0.5, ARCH.woodDark, 6);
    surf(c, SURF.plain);
    b.add(PRIM.torus(0.3, 3, 8), trs(x, 0.35, -hz + 0.4, Math.PI / 2, 0, 0, 0.15), ARCH.rope);
    surf(c, SURF.woodV);
  }
  b.rod(V(hx - 0.5, 0, hz - 0.5), V(hx - 0.5, 3, hz - 0.5), 0.06, ARCH.woodDark, 5);
  lantern(c, hx - 0.5, 2.6, hz - 0.9, 0.25);
}

export function buildShip(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const hx = sx / 2;
  const v = p.variant;
  const hullCol = jitter(c, v === 1 ? '#3a2e24' : '#4e3726', 0.08);
  const paint = p.color ?? (v === 2 ? '#6b5530' : '#8a2a22');
  // hull cross-sections along X (bow at −X)
  const N = 14;
  const halfW = (t: number): number => {
    const bow = Math.min(1, t / 0.22);
    const stern = Math.min(1, (1 - t) / 0.12);
    return (sz / 2) * (0.3 + 0.7 * Math.sqrt(Math.min(bow, 1))) * (0.6 + 0.4 * Math.sqrt(Math.min(stern, 1)));
  };
  const sheer = (t: number): number => 0.9 * Math.pow(1 - t, 3) + 0.6 * Math.pow(t, 4);
  const sec = (i: number): { x: number; w: number; top: number } => {
    const t = i / N;
    return { x: -hx + t * sx, w: halfW(t), top: sheer(t) };
  };
  for (let i = 0; i < N; i++) {
    const a = sec(i);
    const e = sec(i + 1);
    surf(c, SURF.planks);
    for (const sgn of [-1, 1]) {
      const out = V(0, 0, sgn);
      // upper strake (painted band) and lower hull
      face(b, V(a.x, a.top + SHIP_BULWARK_H, sgn * a.w), V(e.x, e.top + SHIP_BULWARK_H, sgn * e.w), V(e.x, -0.3, sgn * e.w), V(a.x, -0.3, sgn * a.w), paint, out);
      face(b, V(a.x, -0.3, sgn * a.w), V(e.x, -0.3, sgn * e.w), V(e.x, -sy, sgn * e.w * 0.35), V(a.x, -sy, sgn * a.w * 0.35), hullCol, out.clone().setY(-0.4));
      // inner bulwark face
      face(b, V(a.x, a.top + SHIP_BULWARK_H, sgn * (a.w - SHIP_BULWARK_T)), V(e.x, e.top + SHIP_BULWARK_H, sgn * (e.w - SHIP_BULWARK_T)), V(e.x, 0, sgn * (e.w - SHIP_BULWARK_T)), V(a.x, 0, sgn * (a.w - SHIP_BULWARK_T)), shade(hullCol, 1.3), out.clone().negate());
      // gunwale cap
      surf(c, SURF.plain);
      face(b, V(a.x, a.top + SHIP_BULWARK_H, sgn * a.w), V(e.x, e.top + SHIP_BULWARK_H, sgn * e.w), V(e.x, e.top + SHIP_BULWARK_H, sgn * (e.w - SHIP_BULWARK_T)), V(a.x, a.top + SHIP_BULWARK_H, sgn * (a.w - SHIP_BULWARK_T)), ARCH.gold, V(0, 1, 0));
      surf(c, SURF.planks);
    }
    // keel bottom + deck
    face(b, V(a.x, -sy, -a.w * 0.35), V(e.x, -sy, -e.w * 0.35), V(e.x, -sy, e.w * 0.35), V(a.x, -sy, a.w * 0.35), hullCol, V(0, -1, 0));
    face(b, V(a.x, 0, -a.w + 0.05), V(e.x, 0, -e.w + 0.05), V(e.x, 0, e.w - 0.05), V(a.x, 0, a.w - 0.05), i % 2 ? ARCH.woodLight : shade(ARCH.woodLight, 0.92), V(0, 1, 0));
  }
  // bow / stern caps
  for (const [i, sgn] of [
    [0, -1],
    [N, 1],
  ] as const) {
    const s = sec(i);
    face(b, V(s.x, s.top + SHIP_BULWARK_H, -s.w), V(s.x, s.top + SHIP_BULWARK_H, s.w), V(s.x, -sy, s.w * 0.35), V(s.x, -sy, -s.w * 0.35), sgn < 0 ? paint : hullCol, V(sgn, 0, 0));
  }
  // bow dragon head / ram
  surf(c, SURF.plain);
  b.add(PRIM.cone(6), trs(-hx - 0.8, 0.6, 0, 0, 0, Math.PI / 2, 0.35, 1.8, 0.35), v === 1 ? '#6a6a6a' : ARCH.gold);
  // eyes on the bow
  for (const sgn of [-1, 1]) b.add(PRIM.cyl(10), trs(-hx + 0.8, 0.2, sgn * (halfW(0.06) + 0.02), Math.PI / 2, 0, 0, 0.3, 0.04, 0.3), '#f0e8d0');
  // oars
  surf(c, SURF.woodV);
  for (let x = -hx * 0.6; x < hx * 0.7; x += 1.6) {
    for (const sgn of [-1, 1]) {
      const w = halfW((x + hx) / sx);
      b.rod(V(x, 0.8, sgn * (w - 0.3)), V(x - 0.4, -sy * 0.8, sgn * (w + 2.2)), 0.05, ARCH.wood, 4);
    }
  }
  const cabinX0 = 0.18 * sx;
  const cabinX1 = 0.44 * sx;
  const cz = sz / 2 - 1.2;
  surf(c, SURF.plain);
  if (v === 2) {
    // fire ship: straw bundles
    for (let x = -hx * 0.6; x < hx * 0.8; x += 1.4) {
      for (const z of [-cz * 0.5, cz * 0.5]) b.add(PRIM.cyl(7), trs(x, 0.55, z, 0, 0.3, Math.PI / 2, 0.55, 1.2, 0.55), jitter(c, '#c8a050', 0.1));
    }
  } else if (v === 1) {
    // 艨艟: hide-covered armoured deck
    hipRoof(b, 0, 0.2, 0, sx * 0.8, sz - 1, 2.2, { ...roofExtras(c), color: '#5a4030', overhang: 0.1, ridge: 0.9, curve: 0.8, upturn: 0, stripes: false, plain: true, surface: SURF.plain });
  } else {
    // 楼船 deck house (+ second tier)
    surf(c, SURF.planks);
    boxMM(b, cabinX0, 0, -cz, cabinX1, SHIP_CABIN_H, cz, ARCH.pillarRed);
    for (let x = cabinX0 + 0.8; x < cabinX1 - 0.4; x += 1.4) lattice(b, x, SHIP_CABIN_H * 0.55, -cz - 0.02, 0.9, 1.2, ARCH.gold);
    hipRoof(b, (cabinX0 + cabinX1) / 2, SHIP_CABIN_H, 0, cabinX1 - cabinX0, cz * 2, 1.0, { ...roofExtras(c), color: ARCH.roofTile, overhang: 0.5, ridge: 0.8, upturn: 0.35, plain: true });
    const w2 = (cabinX1 - cabinX0) * 0.6;
    const mx = (cabinX0 + cabinX1) / 2;
    surf(c, SURF.planks);
    boxMM(b, mx - w2 / 2, SHIP_CABIN_H + 0.8, -cz * 0.6, mx + w2 / 2, SHIP_CABIN_H + 2.6, cz * 0.6, ARCH.pillarRed);
    hipRoof(b, mx, SHIP_CABIN_H + 2.6, 0, w2, cz * 1.2, 1.3, { ...roofExtras(c), color: ARCH.roofTile, overhang: 0.5, ridge: 0.6, upturn: 0.45, ornate: true });
    for (const z of [-cz, cz]) lantern(c, cabinX0 - 0.3, SHIP_CABIN_H - 0.5, z, 0.25);
  }
  // mast + battened junk sail
  const mx = -0.1 * sx;
  const mh = 0.55 * sx;
  surf(c, SURF.woodV);
  b.cylAt(mx, 0, 0, 0.28, mh, ARCH.woodDark, 8);
  surf(c, SURF.plain);
  if (v !== 1) {
    const sw = sx * (v === 2 ? 0.22 : 0.34);
    const sh = mh * 0.62;
    const y0 = mh * 0.3;
    const sailCol = v === 2 ? '#a08a60' : mixCol(paint, '#e8dcc0', 0.35);
    const verts = (x: number, y: number): THREE.Vector3 => V(mx + x, y0 + y, 0.35);
    c.cloth.quad(verts(-sw * 0.35, 0), verts(sw * 0.65, 0), verts(sw * 0.55, sh), verts(-sw * 0.3, sh * 0.96), sailCol, true);
    for (let k = 1; k < 7; k++) {
      const y = (k / 7) * sh;
      b.boxAt(mx + sw * 0.15, y0 + y, 0.4, sw * 0.95, 0.08, 0.08, ARCH.woodDark);
    }
    // pennant at the masthead
    c.cloth.quad(V(mx, mh, 0), V(mx + 2.4, mh - 0.3, 0), V(mx + 2.4, mh - 0.6, 0), V(mx, mh - 0.9, 0), paint, true);
  }
}

export function buildStatue(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const plinth = 0.22 * sy;
  const stone = jitter(c, p.variant === 2 ? ARCH.bronzeGreen : ARCH.stone, 0.05);
  surf(c, SURF.paving);
  boxMM(b, -sx / 2, -0.3, -sz / 2, sx / 2, plinth, sz / 2, shade(ARCH.stoneDark, 1.05));
  boxMM(b, -sx / 2 - 0.1, plinth - 0.12, -sz / 2 - 0.1, sx / 2 + 0.1, plinth, sz / 2 + 0.1, ARCH.stone);
  surf(c, p.variant === 0 || p.variant === 1 ? SURF.stone : SURF.plain);
  const figH = sy - plinth;
  const r = 0.3 * Math.min(sx, sz);
  switch (p.variant) {
    case 1: {
      // 石狮 guardian lion (sitting)
      const s = figH / 1.6;
      b.push(trs(0, plinth, 0, 0, 0, 0, s, s, s));
      b.add(PRIM.sphere(8, 6), trs(0, 0.55, 0.15, 0, 0, 0, 0.42, 0.5, 0.5), stone);
      b.add(PRIM.sphere(8, 6), trs(0, 1.15, -0.1, 0, 0, 0, 0.42, 0.42, 0.4), shade(stone, 1.08));
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        b.add(PRIM.sphere(5, 4), trs(Math.cos(a) * 0.38, 1.15 + Math.sin(a) * 0.38, 0.05, 0, 0, 0, 0.12), shade(stone, 0.92));
      }
      b.add(PRIM.box(), trs(0, 1.05, -0.45, 0, 0, 0, 0.3, 0.2, 0.2), stone);
      for (const sgn of [-1, 1]) b.add(PRIM.box(), trs(sgn * 0.2, 0.3, -0.3, 0, 0, 0, 0.16, 0.6, 0.18), stone);
      b.add(PRIM.sphere(7, 5), trs(0.25, 0.15, -0.55, 0, 0, 0, 0.16), shade(stone, 1.1));
      b.pop();
      break;
    }
    case 2: {
      // bronze 鼎
      const s = figH / 1.4;
      b.push(trs(0, plinth, 0, 0, 0, 0, s, s, s));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        b.cylAt(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, 0.08, 0.6, stone, 6);
      }
      b.add(PRIM.sphere(10, 6), trs(0, 0.85, 0, 0, 0, 0, 0.7, 0.45, 0.7), stone);
      b.cylAt(0, 1.05, 0, 0.72, 0.12, shade(stone, 1.1), 12);
      for (const sgn of [-1, 1]) b.add(PRIM.torus(0.25, 4, 8, Math.PI), trs(sgn * 0.5, 1.15, 0, 0, Math.PI / 2, 0, 0.18), stone);
      b.pop();
      break;
    }
    case 3: {
      // 南蛮 totem pole
      const cols = ['#b8322a', '#d9a42c', '#2a2a2a', '#3a7a5a'];
      const n = 4;
      for (let i = 0; i < n; i++) {
        const y = plinth + (i * figH) / n;
        const hh = figH / n;
        b.cylAt(0, y, 0, r * (1 - i * 0.08), hh, cols[i % cols.length], 8);
        b.boxAt(-r * 0.35, y + hh * 0.6, -r * 0.95, r * 0.3, hh * 0.15, 0.08, '#f0e8d0');
        b.boxAt(r * 0.35, y + hh * 0.6, -r * 0.95, r * 0.3, hh * 0.15, 0.08, '#f0e8d0');
        b.boxAt(0, y + hh * 0.25, -r * 0.95, r * 0.8, hh * 0.1, 0.08, '#1a1410');
      }
      for (const sgn of [-1, 1]) b.add(PRIM.box(), trs(sgn * r * 1.4, plinth + figH * 0.8, 0, 0, 0, sgn * 0.3, r * 1.6, 0.2, 0.1), '#d9a42c');
      break;
    }
    default: {
      // stone general: a humanoid figure in stone
      const built = buildCharacter({
        skin: '#a8a296',
        face: '#a8a296',
        hair: '#8f8a80',
        primary: '#9d978b',
        secondary: '#8a857a',
        accent: '#b3ada0',
        kingdom: '#9d978b',
        headgear: 'helmet',
        beard: 'long',
        body: 'heavy',
        extras: ['cape', 'shoulderPads'],
        female: false,
      });
      const s = figH / 1.85;
      b.addRaw(built.geometry, trs(0, plinth, 0, 0, 0, 0, s, s, s));
      // a sword planted in front
      b.rod(V(0.15 * s, plinth, -0.45 * s), V(0.15 * s, plinth + 1.1 * s, -0.45 * s), 0.04 * s, '#9d978b', 4);
      break;
    }
  }
}

export function buildRuin(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sy, sz } = p;
  const stone = jitter(c, ARCH.stone, 0.06);
  surf(c, SURF.brick);
  const jag = (x0: number, x1: number, h: number): void => {
    const n = Math.max(2, Math.round((x1 - x0) / 0.7));
    for (let i = 0; i < n; i++) {
      const xa = x0 + (i * (x1 - x0)) / n;
      const xb = x0 + ((i + 1) * (x1 - x0)) / n;
      const hh = h * (0.75 + c.rand() * 0.25);
      boxMM(b, xa, -0.4, -sz / 2, xb, hh, sz / 2, i % 2 ? stone : shade(stone, 0.93));
      if (c.rand() < 0.35) plainBox(c, () => b.boxAt((xa + xb) / 2, hh * c.rand(), -sz / 2 - 0.01, xb - xa, 0.4, 0.02, mixCol(stone, NATURE.grassLush, 0.5)));
    }
  };
  if (p.variant === 2) {
    jag(-sx / 2, -sx / 2 + 0.25 * sx, sy);
    jag(sx / 2 - 0.25 * sx, sx / 2, sy);
  } else {
    const m = p.variant === 1 ? -1 : 1;
    const a0 = m * -0.2 * sx - 0.3 * sx;
    jag(Math.min(a0, a0 + 0.6 * sx), Math.max(a0, a0 + 0.6 * sx), sy);
    const b0 = m * 0.3 * sx - 0.2 * sx;
    jag(Math.min(b0, b0 + 0.4 * sx), Math.max(b0, b0 + 0.4 * sx), 0.5 * sy);
  }
  // rubble
  for (let i = 0; i < 6; i++) {
    const x = (c.rand() - 0.5) * sx * 1.1;
    const z = (c.rand() < 0.5 ? -1 : 1) * (sz / 2 + 0.3 + c.rand() * 0.8);
    const s = 0.2 + c.rand() * 0.35;
    b.add(PRIM.box(), trs(x, s * 0.4, z, c.rand(), c.rand() * 3, c.rand(), s * 1.4, s, s), shade(stone, 0.9 + c.rand() * 0.2));
  }
}

export function buildFarmField(c: PropCtx): void {
  const { p, b } = c;
  const { sx, sz } = p;
  const hx = sx / 2;
  const hz = sz / 2;
  const cells = Math.max(1, Math.round(sx / 2));
  const gy = (x: number, z: number): number => c.groundAt(x, z) + 0.05;
  const rowStep = p.variant === 1 ? 2.2 : 0.9;
  const nRows = Math.max(1, Math.floor(sz / rowStep));
  const soil = mixCol(NATURE.dirt, '#5a4632', 0.4);
  for (let r = 0; r < nRows; r++) {
    const z0 = -hz + r * rowStep;
    const z1 = Math.min(hz, z0 + rowStep);
    for (let i = 0; i < cells; i++) {
      const x0 = -hx + (i * sx) / cells;
      const x1 = -hx + ((i + 1) * sx) / cells;
      if (p.variant === 1) {
        // paddy: water-green square + earth bund
        const water = mixCol('#6f9a86', '#a8c8b0', c.rand() * 0.3);
        face(b, V(x0, gy(x0, z0), z0 + 0.15), V(x1, gy(x1, z0), z0 + 0.15), V(x1, gy(x1, z1), z1), V(x0, gy(x0, z1), z1), water, V(0, 1, 0));
        face(b, V(x0, gy(x0, z0) + 0.12, z0), V(x1, gy(x1, z0) + 0.12, z0), V(x1, gy(x1, z0) + 0.12, z0 + 0.15), V(x0, gy(x0, z0) + 0.12, z0 + 0.15), NATURE.dirt, V(0, 1, 0));
      } else {
        // soil strip + crop ridge (wheat gold / vegetable green)
        const zm = (z0 + z1) / 2;
        face(b, V(x0, gy(x0, z0), z0), V(x1, gy(x1, z0), z0), V(x1, gy(x1, z1), z1), V(x0, gy(x0, z1), z1), soil, V(0, 1, 0));
        const crop = p.variant === 2 ? mixCol('#4f8a34', '#7ab050', c.rand() * 0.5) : mixCol('#c9a444', '#e0c060', c.rand() * 0.5);
        const hgt = p.variant === 2 ? 0.25 : 0.5;
        const w = rowStep * 0.28;
        face(b, V(x0, gy(x0, zm - w), zm - w), V(x1, gy(x1, zm - w), zm - w), V(x1, gy(x1, zm) + hgt, zm), V(x0, gy(x0, zm) + hgt, zm), crop, V(0, 1, -1));
        face(b, V(x0, gy(x0, zm + w), zm + w), V(x1, gy(x1, zm + w), zm + w), V(x1, gy(x1, zm) + hgt, zm), V(x0, gy(x0, zm) + hgt, zm), shade(crop, 0.85), V(0, 1, 1));
      }
    }
  }
}

export function buildStairs(c: PropCtx): void {
  const { p, b } = c;
  const timber = p.variant === 1;
  const steps = stairSteps(p);
  surf(c, timber ? SURF.planks : SURF.paving);
  steps.forEach((st, i) => {
    const colr: ColorLike = timber ? jitter(c, ARCH.woodLight, 0.08) : i % 2 ? ARCH.stoneLight : shade(ARCH.stoneLight, 0.94);
    boxMM(b, -p.sx / 2, i === 0 ? -0.3 : 0, st.z0, p.sx / 2, st.top, st.z1, colr);
    // nosing line
    b.boxAt(0, st.top - 0.02, st.z0 - 0.01, p.sx, 0.05, 0.05, timber ? ARCH.woodDark : ARCH.stone);
  });
  if (timber) {
    for (const sgn of [-1, 1]) {
      b.rod(V((sgn * p.sx) / 2, 0, p.sz / 2), V((sgn * p.sx) / 2, p.sy, -p.sz / 2), 0.08, ARCH.woodDark, 4);
    }
  }
}

export function buildBrazierStand(c: PropCtx): void {
  const { p, b } = c;
  const r = p.sx / 2;
  const h = p.sy;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    b.rod(V(Math.cos(a) * r * 0.9, 0, Math.sin(a) * r * 0.9), V(Math.cos(a) * r * 0.45, h - 0.25, Math.sin(a) * r * 0.45), 0.05, ARCH.bronze, 4);
  }
  b.add(PRIM.cyl(10, 1.6), trs(0, h - 0.18, 0, 0, 0, 0, r * 0.6, 0.36, r * 0.6), ARCH.bronze);
  b.add(PRIM.torus(0.12, 3, 12), trs(0, h, 0, Math.PI / 2, 0, 0, r * 0.95, r * 0.95, r * 0.95), ARCH.gold);
  c.glow.add(PRIM.sphere(8, 4), trs(0, h - 0.05, 0, 0, 0, 0, r * 0.8, 0.18, r * 0.8), '#ff7a2a');
}

export function buildBannerPole(c: PropCtx): void {
  const { p, b } = c;
  surf(c, SURF.woodV);
  b.cylAt(0, -0.3, 0, 0.09, p.sy + 0.3, ARCH.woodDark, 6);
  surf(c, SURF.plain);
  b.add(PRIM.cone(4), trs(0, p.sy + 0.25, 0, 0, 0, 0, 0.08, 0.5, 0.08), ARCH.gold);
  b.add(PRIM.cyl(5), trs(p.sx / 2, p.sy - 0.1, 0, 0, 0, Math.PI / 2, 0.035, p.sx + 0.2, 0.035), ARCH.woodDark);
  b.add(PRIM.cone(6), trs(0, p.sy - 0.35, 0, Math.PI, 0, 0, 0.16, 0.35, 0.16), '#c8322a'); // red tassel
}

export { pillar, col };
