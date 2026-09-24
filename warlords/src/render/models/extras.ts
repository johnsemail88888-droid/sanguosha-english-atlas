// HeroVisual.extras — silhouette-defining accessories (fan, eyepatch, back
// flags, cape, ribbons, quiver, staff...). Each is skinned to the bone it
// should follow.
import * as THREE from 'three';
import { PRIM, col, mixCol, shade, trs } from '../core/geo';
import { GOLD, LEATHER, ball, frustum, strip, type BodyCtx } from './parts';

export function buildExtras(c: BodyCtx): void {
  for (const e of c.s.extras) {
    switch (e) {
      case 'fan':
        fan(c);
        break;
      case 'eyepatch':
        eyepatch(c);
        break;
      case 'shoulderPads':
        shoulderPads(c);
        break;
      case 'backFlags':
        backFlags(c);
        break;
      case 'cape':
        cape(c);
        break;
      case 'scarf':
        scarf(c);
        break;
      case 'goggles':
        goggles(c);
        break;
      case 'mask':
        mask(c);
        break;
      case 'bells':
        bells(c);
        break;
      case 'whiteRobe':
        whiteRobe(c);
        break;
      case 'medicBag':
        medicBag(c);
        break;
      case 'ribbons':
        ribbons(c);
        break;
      case 'backpack':
        backpack(c);
        break;
      case 'quiver':
        quiver(c);
        break;
      case 'staff':
        staff(c);
        break;
      case 'bareChest':
      default:
        break; // bareChest is handled by the torso builder
    }
  }
}

/** 羽扇: feather fan in the left hand, pointing along the hand's −Z (up when the forearm is raised). */
function fan(c: BodyCtx): void {
  const { d, b } = c;
  const x = -d.shoulderX;
  const y = d.wristY - 0.06;
  c.on('handL');
  b.rod(c.v(x, y, 0.02), c.v(x, y, -0.14), 0.012, '#6b4a2e', 5);
  b.add(PRIM.sphere(10, 6), trs(x, y, -0.3, 0, 0, 0, 0.13, 0.012, 0.19), '#f3eee2');
  b.add(PRIM.sphere(10, 6), trs(x, y + 0.004, -0.29, 0, 0, 0, 0.1, 0.014, 0.15), '#dcd4c2');
  b.add(PRIM.cyl(8), trs(x, y, -0.13, 0, 0, 0, 0.04, 0.02, 0.03), '#2a2a2a');
  // feather ribs
  for (let i = -2; i <= 2; i++) b.add(PRIM.box(), trs(x, y + 0.01, -0.27, 0, i * 0.25, 0, 0.006, 0.006, 0.3), '#b8ad98');
}

function eyepatch(c: BodyCtx): void {
  const { d, b } = c;
  const hs = d.headScale;
  const cy = d.headCY;
  c.on('head');
  b.add(PRIM.box(), trs(-0.04 * hs, cy + 0.012 * hs, -0.119 * hs, 0, 0.15, 0, 0.05 * hs, 0.042 * hs, 0.012), '#101010');
  b.add(PRIM.torus(0.06, 3, 14), trs(0, cy + 0.03 * hs, 0.0, Math.PI / 2 + 0.35, 0, 0.15, 0.114 * hs, 0.124 * hs, 0.114 * hs), '#1a1a1a');
}

function shoulderPads(c: BodyCtx): void {
  const { d, s, b } = c;
  for (const side of [-1, 1] as const) {
    c.on(side < 0 ? 'armUL' : 'armUR');
    const x = side * (d.shoulderX + 0.03);
    for (let i = 0; i < 3; i++) {
      b.add(
        PRIM.box(),
        trs(x + side * i * 0.012, d.shoulderY + 0.035 - i * 0.05, 0, 0, 0, -side * (0.45 + i * 0.1), 0.16 * d.w - i * 0.01, 0.035, 0.19 * d.depth),
        i === 0 ? s.secondary : shade(s.secondary, 0.9 - i * 0.05),
      );
      b.add(
        PRIM.box(),
        trs(x + side * (i * 0.012 + 0.06), d.shoulderY + 0.005 - i * 0.05, 0, 0, 0, -side * (0.45 + i * 0.1), 0.02, 0.02, 0.195 * d.depth),
        s.accent,
      );
    }
    // beast-head boss
    ball(c, x + side * 0.02, d.shoulderY + 0.06, 0, 0.035, s.accent);
  }
}

/** 靠旗: four little pennants on poles from the back — a very tall silhouette. */
function backFlags(c: BodyCtx): void {
  const { d, s, b } = c;
  c.on('chest');
  const cols = [s.kingdom, s.accent, s.kingdom, s.accent];
  [-0.09, -0.03, 0.03, 0.09].forEach((x, i) => {
    const base = c.v(x, d.chestY + 0.05, 0.13 * d.depth);
    const tip = c.v(x * 4.2, d.shoulderY + 0.6 - Math.abs(x) * 0.8, 0.26);
    b.rod(base, tip, 0.01, '#5a3f28', 5);
    ball(c, tip.x, tip.y + 0.02, tip.z, 0.018, GOLD);
    const a = tip.clone().lerp(base, 0.08);
    const bpt = tip.clone().lerp(base, 0.45);
    const out = new THREE.Vector3(Math.sign(x) * 0.22 + x, 0, 0.05);
    const p = bpt.clone().lerp(a, 0.5).add(out);
    b.tri(a, bpt, p, cols[i]);
    b.tri(a, p, bpt, cols[i]);
  });
}

function cape(c: BodyCtx): void {
  const { d, s, b } = c;
  c.on('cape');
  const clr = shade(mixCol(s.primary, s.kingdom, 0.35), 0.78);
  const inner = shade(clr, 0.62);
  const topY = d.shoulderY + 0.01;
  const botY = 0.32;
  const zTop = 0.13 * d.depth;
  const zBot = zTop + 0.14;
  const wTop = 0.44 * d.w;
  const wBot = 0.64 * d.w;
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  // five vertical folds: alternating depth + shade so the cloth reads from behind
  const folds = 5;
  for (let i = 0; i < folds; i++) {
    const u0 = i / folds;
    const u1 = (i + 1) / folds;
    const x0t = -wTop / 2 + u0 * wTop;
    const x1t = -wTop / 2 + u1 * wTop;
    const x0b = -wBot / 2 + u0 * wBot;
    const x1b = -wBot / 2 + u1 * wBot;
    const dz = i % 2 ? 0.035 : 0;
    const col = i % 2 ? shade(clr, 0.86) : clr;
    b.quad(v(x0t, topY, zTop + dz * 0.3), v(x0b, botY, zBot + dz), v(x1b, botY, zBot + dz), v(x1t, topY, zTop + dz * 0.3), col, true);
    // hem trim
    b.quad(v(x0b, botY + 0.06, zBot + dz + 0.004), v(x0b, botY, zBot + dz + 0.004), v(x1b, botY, zBot + dz + 0.004), v(x1b, botY + 0.06, zBot + dz + 0.004), s.accent, true);
  }
  b.quad(v(-wTop / 2, topY, zTop - 0.012), v(-wBot / 2, botY, zBot - 0.012), v(wBot / 2, botY, zBot - 0.012), v(wTop / 2, topY, zTop - 0.012), inner, true);
  // collar + clasps
  b.boxAt(0, topY + 0.01, zTop - 0.01, wTop + 0.04, 0.05, 0.05, shade(clr, 0.9));
  ball(c, -wTop / 2, topY, zTop - 0.05, 0.03, s.accent);
  ball(c, wTop / 2, topY, zTop - 0.05, 0.03, s.accent);
}

function scarf(c: BodyCtx): void {
  const { d, s, b } = c;
  c.on('chest');
  b.add(PRIM.torus(0.35, 5, 12), trs(0, d.shoulderY + 0.035, 0.0, Math.PI / 2, 0, 0, 0.1 * d.w, 0.1 * d.depth, 0.1), s.kingdom);
  strip(
    c,
    [c.v(0.06, d.shoulderY + 0.03, 0.08), c.v(0.1, d.chestY + 0.05, 0.16), c.v(0.12, d.chestY - 0.12, 0.17)],
    0.08,
    0.06,
    0.02,
    s.kingdom,
  );
  void b;
}

function goggles(c: BodyCtx): void {
  const { d, b } = c;
  const hs = d.headScale;
  const cy = d.headCY;
  c.on('head');
  for (const side of [-1, 1]) {
    b.add(PRIM.cyl(8), trs(side * 0.042, cy + 0.07 * hs, -0.115 * hs, Math.PI / 2 - 0.5, 0, 0, 0.032, 0.03, 0.032), '#2a2420');
    b.add(PRIM.cyl(8), trs(side * 0.042, cy + 0.077 * hs, -0.128 * hs, Math.PI / 2 - 0.5, 0, 0, 0.025, 0.008, 0.025), '#7fb7c9');
  }
  b.add(PRIM.torus(0.08, 3, 14), trs(0, cy + 0.06 * hs, 0.005, Math.PI / 2 - 0.2, 0, 0, 0.115 * hs, 0.125 * hs, 0.115 * hs), '#2a2420');
}

function mask(c: BodyCtx): void {
  const { d, s, b } = c;
  const hs = d.headScale;
  const cy = d.headCY;
  c.on('head');
  b.add(PRIM.box(), trs(0, cy - 0.045 * hs, -0.095 * hs, 0.1, 0, 0, 0.19 * hs, 0.085 * hs, 0.06), mixCol('#222226', s.secondary, 0.3));
}

function bells(c: BodyCtx): void {
  const { d, b } = c;
  c.on('hips');
  const pts: [number, number][] = [
    [0.16, -0.06],
    [0.13, -0.1],
    [-0.15, -0.07],
    [0.0, 0.12],
  ];
  for (const [x, z] of pts) {
    const px = x * d.w;
    b.rod(c.v(px, d.spineY - 0.03, z * d.depth), c.v(px, d.spineY - 0.1, z * d.depth), 0.004, '#3a2a1a', 3);
    ball(c, px, d.spineY - 0.12, z * d.depth, 0.026, GOLD);
  }
}

function whiteRobe(c: BodyCtx): void {
  const { d, b } = c;
  const white = '#ece6d8';
  c.on('hips');
  b.add(PRIM.box(), trs(0, d.spineY - 0.28, 0.12 * d.depth, -0.15, 0, 0, 0.3 * d.w, 0.5, 0.02), white);
  for (const side of [-1, 1] as const) {
    c.on(side < 0 ? 'legUL' : 'legUR');
    b.add(
      PRIM.box(),
      trs(side * (d.hipX + 0.05 * d.w), (d.hipY + d.kneeY) / 2 - 0.04, 0, 0, 0, -side * 0.08, 0.04, d.hipY - d.kneeY + 0.12, 0.22 * d.depth),
      white,
    );
  }
  c.on('chest');
  b.boxAt(0, d.shoulderY - 0.02, 0.0, 0.46 * d.w, 0.05, 0.26 * d.depth, white);
}

function medicBag(c: BodyCtx): void {
  const { d, b } = c;
  c.on('hips');
  const x = 0.2 * d.w;
  b.boxAt(x, d.spineY - 0.12, 0.02, 0.07, 0.15, 0.17, '#7a5a34');
  b.boxAt(x + 0.036, d.spineY - 0.1, 0.02, 0.006, 0.07, 0.022, '#c22a2a');
  b.boxAt(x + 0.036, d.spineY - 0.1, 0.02, 0.006, 0.022, 0.07, '#c22a2a');
  c.on('chest');
  b.add(PRIM.box(), trs(0, d.chestY + 0.07, 0, 0, 0, -0.72, 0.04, 0.6 * d.w, 0.245 * d.depth), LEATHER);
  // gourd (药葫芦)
  c.on('hips');
  ball(c, -0.19 * d.w, d.spineY - 0.1, 0.05, 0.045, '#c9983a');
  ball(c, -0.19 * d.w, d.spineY - 0.035, 0.05, 0.032, '#c9983a');
}

/** 披帛: silk shawl looping behind the back and trailing past the elbows. */
function ribbons(c: BodyCtx): void {
  const { d, s } = c;
  c.on('chest');
  const silk = mixCol(s.accent, '#f2c6d0', 0.35);
  strip(
    c,
    [
      c.v(-d.shoulderX - 0.05, d.shoulderY - 0.02, 0.06),
      c.v(-0.12, d.shoulderY - 0.2, 0.2),
      c.v(0.12, d.shoulderY - 0.2, 0.2),
      c.v(d.shoulderX + 0.05, d.shoulderY - 0.02, 0.06),
    ],
    0.07,
    0.07,
    0.01,
    silk,
    new THREE.Vector3(0, 1, 0.4),
  );
  for (const side of [-1, 1]) {
    strip(
      c,
      [
        c.v(side * (d.shoulderX + 0.06), d.shoulderY - 0.02, 0.05),
        c.v(side * (d.shoulderX + 0.14), d.elbowY - 0.05, 0.02),
        c.v(side * (d.shoulderX + 0.18), d.hipY - 0.15, 0.08),
        c.v(side * (d.shoulderX + 0.14), d.kneeY - 0.05, 0.14),
      ],
      0.07,
      0.05,
      0.01,
      silk,
      new THREE.Vector3(0, 0, 1),
    );
  }
}

function backpack(c: BodyCtx): void {
  const { d, s, b } = c;
  c.on('chest');
  const pack = mixCol('#5a5a40', s.secondary, 0.3);
  b.boxAt(0, d.chestY + 0.06, 0.2 * d.depth, 0.3 * d.w, 0.34, 0.16, pack);
  b.boxAt(0, d.chestY - 0.05, 0.3 * d.depth, 0.24 * d.w, 0.12, 0.05, shade(pack, 0.85));
  b.add(PRIM.cyl(8), trs(0, d.shoulderY + 0.03, 0.2 * d.depth, 0, 0, Math.PI / 2, 0.06, 0.34 * d.w, 0.06), '#8a7a5a');
}

function quiver(c: BodyCtx): void {
  const { d, b } = c;
  c.on('chest');
  const a = c.v(0.13, d.chestY - 0.22, 0.17 * d.depth + 0.04);
  const t = c.v(-0.1, d.shoulderY + 0.14, 0.17 * d.depth + 0.04);
  frustum(c, a, t, 0.055, 0.065, '#6b4a2e', 8);
  frustum(c, t.clone().lerp(a, 0.05), t, 0.07, 0.07, GOLD, 8);
  for (let i = 0; i < 5; i++) {
    const off = new THREE.Vector3((i - 2) * 0.018, 0, (i % 2) * 0.02 - 0.01);
    const base = t.clone().add(off);
    const tip = base.clone().add(new THREE.Vector3(-0.05, 0.14, 0));
    b.rod(base, tip, 0.005, '#d8c9a0', 3);
    b.add(PRIM.box(), trs(tip.x, tip.y - 0.03, tip.z, 0, 0, 0.3, 0.025, 0.06, 0.004), i % 2 ? '#c8322a' : '#f0ead8');
  }
  b.add(PRIM.box(), trs(0, d.chestY + 0.08, 0, 0, 0, 0.72, 0.035, 0.6 * d.w, 0.245 * d.depth), LEATHER);
}

/** 张角's 九节杖 slung on the back: wooden staff with a gold ring head and yellow talismans. */
function staff(c: BodyCtx): void {
  const { d, b } = c;
  c.on('chest');
  const a = c.v(0.28, d.hipY - 0.45, 0.2 * d.depth);
  const t = c.v(-0.26, d.shoulderY + 0.55, 0.2 * d.depth);
  b.rod(a, t, 0.018, '#6b4a2e', 6);
  for (let i = 1; i < 9; i++) {
    const p = a.clone().lerp(t, i / 9);
    b.add(PRIM.cyl(6), trs(p.x, p.y, p.z, 0, 0, -0.48, 0.024, 0.02, 0.024), shade('#6b4a2e', 0.7));
  }
  b.add(PRIM.torus(0.12, 4, 12), trs(t.x - 0.04, t.y + 0.08, t.z, 0, 0, -0.48, 0.09, 0.09, 0.09), GOLD);
  ball(c, t.x - 0.04, t.y + 0.08, t.z, 0.03, '#f0d060');
  for (let i = 0; i < 2; i++) {
    const p = t.clone().lerp(a, 0.1 + i * 0.05);
    b.add(PRIM.box(), trs(p.x + 0.03, p.y - 0.08, p.z + 0.02, 0, 0, 0.1, 0.035, 0.14, 0.004), '#e8cf5a');
  }
  void col;
}
