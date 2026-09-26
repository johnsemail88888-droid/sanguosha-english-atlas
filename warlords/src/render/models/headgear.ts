// Headgear + beards for procedural characters (all skinned to the head bone).
// Every Headgear value in data/types.ts has a distinct silhouette.
import * as THREE from 'three';
import { PRIM, col, mixCol, shade, trs } from '../core/geo';
import { GOLD, ball, frustum, strip, type BodyCtx } from './parts';

// hood shell: sphere with the face (−Z) cut out
let hoodGeo: THREE.BufferGeometry | null = null;
function hoodShell(): THREE.BufferGeometry {
  if (!hoodGeo) {
    const g = new THREE.SphereGeometry(1, 12, 8, (3 * Math.PI) / 2 + Math.PI / 3.2, 2 * Math.PI - (2 * Math.PI) / 3.2, 0, Math.PI * 0.62);
    const ng = g.toNonIndexed();
    g.dispose();
    ng.deleteAttribute('uv');
    ng.computeVertexNormals();
    hoodGeo = ng;
  }
  return hoodGeo;
}

function hairCap(c: BodyCtx, fuller = false): void {
  const { d, s, b } = c;
  const hs = d.headScale;
  const cy = d.headCY;
  b.add(
    PRIM.sphere(10, 7),
    trs(0, cy + 0.03 * hs, 0.02, -0.15, 0, 0, 0.113 * hs, (fuller ? 0.118 : 0.11) * hs, 0.123 * hs),
    s.hair,
  );
  // hairline in front so the forehead reads
  b.add(PRIM.box(), trs(0, cy + 0.085 * hs, -0.085 * hs, -0.5, 0, 0, 0.17 * hs, 0.035, 0.05), s.hair);
  // sideburns
  b.boxAt(-0.1 * hs, cy + 0.01, -0.03, 0.018, 0.07, 0.04, s.hair);
  b.boxAt(0.1 * hs, cy + 0.01, -0.03, 0.018, 0.07, 0.04, s.hair);
}

function topKnot(c: BodyCtx, pin = true): void {
  const { d, s, b } = c;
  const hs = d.headScale;
  const cy = d.headCY;
  ball(c, 0, cy + 0.135 * hs, 0.03, 0.045 * hs, s.hair);
  if (pin) {
    // small crown cap (发冠) + pin
    b.add(PRIM.cyl(8, 0.8), trs(0, cy + 0.15 * hs, 0.03, 0, 0, 0, 0.042 * hs, 0.05, 0.042 * hs), s.accent);
    b.add(PRIM.cyl(5), trs(0, cy + 0.15 * hs, 0.03, 0, 0, Math.PI / 2, 0.006, 0.16, 0.006), GOLD);
  }
}

export function buildHeadgear(c: BodyCtx): void {
  const { d, s, b } = c;
  const hs = d.headScale;
  const cy = d.headCY;
  c.on('head');
  switch (s.headgear) {
    case 'crown': {
      hairCap(c);
      // cap + 冕旒 board with bead curtains
      b.add(PRIM.cyl(10, 0.9), trs(0, cy + 0.13 * hs, 0.01, 0, 0, 0, 0.078 * hs, 0.11, 0.078 * hs), '#1d1a1a');
      b.add(PRIM.box(), trs(0, cy + 0.2 * hs, -0.01, 0.08, 0, 0, 0.32 * hs, 0.02, 0.19 * hs), '#1a1618');
      b.add(PRIM.box(), trs(0, cy + 0.188 * hs, -0.01, 0.08, 0, 0, 0.33 * hs, 0.012, 0.2 * hs), GOLD);
      b.add(PRIM.cyl(5), trs(0, cy + 0.14 * hs, 0.01, 0, 0, Math.PI / 2, 0.008, 0.24, 0.008), GOLD);
      for (const zSide of [-1, 1]) {
        const z = -0.01 + zSide * 0.098 * hs;
        for (let i = 0; i < 7; i++) {
          const x = (i - 3) * 0.045 * hs;
          for (let k = 0; k < 3; k++) {
            b.boxAt(x, cy + 0.18 * hs - 0.035 - k * 0.035, z - zSide * 0.004 * k, 0.014, 0.014, 0.014, k % 2 ? '#e8dcc0' : '#c83a2a');
          }
        }
      }
      break;
    }
    case 'helmet': {
      b.add(PRIM.dome(12, 5), trs(0, cy + 0.03 * hs, 0.005, 0, 0, 0, 0.126 * hs, 0.13 * hs, 0.136 * hs), s.secondary);
      b.add(PRIM.torus(0.1, 4, 16), trs(0, cy + 0.035 * hs, 0.005, Math.PI / 2, 0, 0, 0.128 * hs, 0.14 * hs, 0.128 * hs), s.accent);
      // brow ridge / visor
      b.add(PRIM.box(), trs(0, cy + 0.05 * hs, -0.12 * hs, -0.3, 0, 0, 0.2 * hs, 0.025, 0.05), s.accent);
      // spike + red tassel (红缨)
      b.add(PRIM.cone(6), trs(0, cy + 0.2 * hs, 0.005, 0, 0, 0, 0.018, 0.1, 0.018), s.accent);
      b.add(PRIM.cone(8), trs(0, cy + 0.155 * hs, 0.005, Math.PI, 0, 0, 0.05, 0.07, 0.05), '#b3261e');
      // cheek guards + neck guard
      b.add(PRIM.box(), trs(-0.105 * hs, cy - 0.03, -0.02, 0, 0, 0.12, 0.02, 0.11, 0.1), s.secondary);
      b.add(PRIM.box(), trs(0.105 * hs, cy - 0.03, -0.02, 0, 0, -0.12, 0.02, 0.11, 0.1), s.secondary);
      b.add(PRIM.box(), trs(0, cy - 0.03, 0.12 * hs, -0.35, 0, 0, 0.21 * hs, 0.11, 0.025), shade(s.secondary, 0.8));
      break;
    }
    case 'plumeHelmet': {
      // 紫金冠 + two long pheasant tail feathers (雉鸡翎)
      hairCap(c);
      b.add(PRIM.dome(12, 4), trs(0, cy + 0.06 * hs, 0.01, 0, 0, 0, 0.118 * hs, 0.1 * hs, 0.126 * hs), GOLD);
      b.add(PRIM.box(), trs(0, cy + 0.13 * hs, -0.1 * hs, -0.25, 0, 0, 0.12 * hs, 0.08, 0.02), s.accent);
      ball(c, 0, cy + 0.15 * hs, -0.105 * hs, 0.022, '#c8322a');
      // the feathers ride their own bone so the local TPS view can shorten them (CharacterRig.setLocalView)
      c.on('plume');
      for (const side of [-1, 1]) {
        const pts: THREE.Vector3[] = [];
        const N = 10;
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          // arc up, outward and back: a wide 'V' that frames the head instead of hiding it
          pts.push(
            new THREE.Vector3(
              side * (0.05 + 0.55 * t * t + 0.1 * t),
              cy + 0.14 * hs + 0.95 * t - 0.6 * t * t,
              -0.06 + 0.12 * t + 0.35 * t * t,
            ),
          );
        }
        strip(c, pts, 0.034, 0.01, 0.008, (i) => (i % 2 ? '#e9dfc4' : '#5e3f24'), new THREE.Vector3(1, 0, 0));
        ball(c, side * 0.045, cy + 0.14 * hs, -0.06, 0.035, '#c8322a');
      }
      c.on('head');
      break;
    }
    case 'scholarHat': {
      // 纶巾: soft silk cap with two ribbons behind
      hairCap(c);
      const silk = mixCol('#1f2633', s.secondary, 0.25);
      // soft cap wrapping the top-back of the head, with a raised folded crest
      b.add(PRIM.dome(10, 4), trs(0, cy + 0.045 * hs, 0.02, -0.2, 0, 0, 0.12 * hs, 0.11 * hs, 0.13 * hs), silk);
      b.add(PRIM.box(), trs(0, cy + 0.13 * hs, 0.045, -0.35, 0, 0, 0.13 * hs, 0.07, 0.11 * hs), silk);
      b.add(PRIM.torus(0.12, 4, 14), trs(0, cy + 0.055 * hs, 0.018, Math.PI / 2 - 0.2, 0, 0, 0.117 * hs, 0.125 * hs, 0.117 * hs), shade(silk, 0.75));
      for (const side of [-1, 1]) {
        strip(
          c,
          [
            new THREE.Vector3(side * 0.04, cy + 0.07 * hs, 0.125 * hs),
            new THREE.Vector3(side * 0.06, cy - 0.12, 0.15),
            new THREE.Vector3(side * 0.07, cy - 0.3, 0.17),
          ],
          0.045,
          0.035,
          0.008,
          silk,
          new THREE.Vector3(1, 0, 0),
        );
      }
      break;
    }
    case 'headband': {
      hairCap(c);
      topKnot(c, true);
      b.add(PRIM.torus(0.14, 4, 16), trs(0, cy + 0.055 * hs, 0.012, Math.PI / 2 - 0.12, 0, 0, 0.114 * hs, 0.12 * hs, 0.114 * hs), s.primary);
      b.add(PRIM.box(), trs(0, cy + 0.07 * hs, -0.118 * hs, -0.12, 0, 0, 0.035, 0.03, 0.02), s.accent);
      for (const side of [-1, 1]) {
        strip(
          c,
          [
            new THREE.Vector3(side * 0.02, cy + 0.07 * hs, 0.12 * hs),
            new THREE.Vector3(side * 0.06, cy - 0.05, 0.16),
            new THREE.Vector3(side * 0.08, cy - 0.17, 0.17),
          ],
          0.035,
          0.025,
          0.008,
          s.primary,
        );
      }
      break;
    }
    case 'hood': {
      const cloth = shade(s.primary, 0.8);
      b.add(hoodShell(), trs(0, cy + 0.01, 0.02, 0, 0, 0, 0.138 * hs, 0.155 * hs, 0.14 * hs), cloth);
      frustum(c, c.v(0, cy - 0.05, 0.03), c.v(0, d.neckY - 0.08, 0.04), 0.12 * hs, 0.2 * d.w, cloth, 10);
      break;
    }
    case 'hairBun': {
      hairCap(c, true);
      ball(c, 0, cy + 0.13 * hs, 0.07, 0.06 * hs, s.hair);
      ball(c, 0, cy + 0.17 * hs, 0.03, 0.045 * hs, s.hair);
      b.rod(c.v(-0.11, cy + 0.17 * hs, 0.02), c.v(0.1, cy + 0.12 * hs, 0.1), 0.006, GOLD, 5);
      b.rod(c.v(0.1, cy + 0.19 * hs, 0.03), c.v(-0.08, cy + 0.11 * hs, 0.11), 0.006, GOLD, 5);
      ball(c, -0.11, cy + 0.17 * hs, 0.02, 0.016, s.accent);
      ball(c, 0.1, cy + 0.19 * hs, 0.03, 0.016, s.accent);
      // side locks
      b.add(PRIM.box(), trs(-0.1 * hs, cy - 0.04, -0.04, 0, 0, 0.05, 0.025, 0.14, 0.035), s.hair);
      b.add(PRIM.box(), trs(0.1 * hs, cy - 0.04, -0.04, 0, 0, -0.05, 0.025, 0.14, 0.035), s.hair);
      // hair ornament flower
      ball(c, 0.07, cy + 0.12 * hs, -0.02, 0.022, s.accent);
      break;
    }
    case 'longHair': {
      hairCap(c, true);
      b.add(PRIM.box(), trs(0, cy - 0.2, 0.1, 0.12, 0, 0, 0.2 * hs, 0.52, 0.05), s.hair);
      b.add(PRIM.box(), trs(0, cy - 0.47, 0.135, 0.12, 0, 0, 0.16 * hs, 0.08, 0.04), shade(s.hair, 1.1));
      b.add(PRIM.box(), trs(-0.1 * hs, cy - 0.12, -0.03, 0, 0, 0.06, 0.03, 0.28, 0.04), s.hair);
      b.add(PRIM.box(), trs(0.1 * hs, cy - 0.12, -0.03, 0, 0, -0.06, 0.03, 0.28, 0.04), s.hair);
      b.add(PRIM.box(), trs(0, cy + 0.075 * hs, -0.1 * hs, -0.4, 0, 0, 0.18 * hs, 0.04, 0.035), s.hair);
      ball(c, -0.08, cy + 0.1 * hs, -0.06, 0.02, s.accent);
      break;
    }
    case 'turban': {
      const y1 = '#d9b22a';
      const y2 = shade(y1, 0.85);
      b.add(PRIM.dome(10, 4), trs(0, cy + 0.05 * hs, 0.01, 0, 0, 0, 0.118 * hs, 0.12 * hs, 0.128 * hs), y1);
      b.add(PRIM.torus(0.28, 5, 14), trs(0, cy + 0.06 * hs, 0.01, Math.PI / 2 - 0.1, 0, 0, 0.108 * hs, 0.118 * hs, 0.1 * hs), y2);
      b.add(PRIM.torus(0.25, 5, 14), trs(0, cy + 0.11 * hs, 0.02, Math.PI / 2 + 0.1, 0.3, 0, 0.09 * hs, 0.1 * hs, 0.08 * hs), y1);
      ball(c, 0.03, cy + 0.07 * hs, 0.13 * hs, 0.04, y2);
      strip(
        c,
        [new THREE.Vector3(0.03, cy + 0.06 * hs, 0.14 * hs), new THREE.Vector3(0.06, cy - 0.12, 0.17), new THREE.Vector3(0.05, cy - 0.3, 0.19)],
        0.06,
        0.045,
        0.01,
        y1,
      );
      break;
    }
    case 'featherCrown': {
      hairCap(c);
      b.add(PRIM.torus(0.2, 4, 14), trs(0, cy + 0.07 * hs, 0.01, Math.PI / 2, 0, 0, 0.113 * hs, 0.12 * hs, 0.113 * hs), '#7a4a22');
      const feathers = ['#c8322a', '#e0b02a', '#2e8b57', '#2e5fa8', '#e0b02a', '#c8322a', '#2e8b57'];
      feathers.forEach((fc, i) => {
        const a = ((i - 3) / 3) * 1.1;
        const base = new THREE.Vector3(Math.sin(a) * 0.1 * hs, cy + 0.08 * hs, -Math.cos(a) * 0.05 + 0.03);
        const tip = new THREE.Vector3(Math.sin(a) * 0.3, cy + 0.42 - Math.abs(i - 3) * 0.05, 0.1 - Math.cos(a) * 0.04);
        strip(c, [base, base.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, 0.03, 0)), tip], 0.05, 0.02, 0.01, fc);
      });
      ball(c, 0, cy + 0.08 * hs, -0.115 * hs, 0.025, '#e0b02a');
      break;
    }
    case 'bandana': {
      const cloth = s.primary;
      b.add(PRIM.dome(10, 4), trs(0, cy + 0.035 * hs, 0.012, -0.08, 0, 0, 0.117 * hs, 0.125 * hs, 0.127 * hs), cloth);
      ball(c, 0, cy + 0.03, 0.13 * hs, 0.035, shade(cloth, 0.85));
      for (const side of [-1, 1]) {
        strip(
          c,
          [new THREE.Vector3(side * 0.01, cy + 0.03, 0.13 * hs), new THREE.Vector3(side * 0.05, cy - 0.1, 0.16), new THREE.Vector3(side * 0.07, cy - 0.18, 0.15)],
          0.04,
          0.025,
          0.008,
          cloth,
        );
      }
      break;
    }
    case 'tacticalHelmet': {
      const shell = mixCol('#5a5f45', s.secondary, 0.4);
      b.add(PRIM.dome(12, 5), trs(0, cy + 0.02 * hs, 0.01, -0.08, 0, 0, 0.132 * hs, 0.14 * hs, 0.14 * hs), shell);
      b.add(PRIM.cyl(14), trs(0, cy + 0.02 * hs, 0.015, -0.08, 0, 0, 0.138 * hs, 0.02, 0.146 * hs), shade(shell, 0.8));
      b.boxAt(-0.13 * hs, cy + 0.05, 0.0, 0.02, 0.03, 0.12, '#2a2a2a');
      b.boxAt(0.13 * hs, cy + 0.05, 0.0, 0.02, 0.03, 0.12, '#2a2a2a');
      // goggles on the helmet front + NVG mount
      for (const side of [-1, 1]) {
        b.add(PRIM.cyl(8), trs(side * 0.045, cy + 0.1 * hs, -0.118 * hs, Math.PI / 2 - 0.3, 0, 0, 0.032, 0.03, 0.032), '#1d1d1f');
        b.add(PRIM.cyl(8), trs(side * 0.045, cy + 0.1 * hs, -0.133 * hs, Math.PI / 2 - 0.3, 0, 0, 0.024, 0.01, 0.024), '#e0a030');
      }
      b.boxAt(0, cy + 0.12 * hs, -0.12 * hs, 0.05, 0.03, 0.03, '#2a2a2a');
      break;
    }
    case 'beret': {
      hairCap(c);
      const cloth = mixCol(s.secondary, s.kingdom, 0.5);
      b.add(PRIM.cyl(12), trs(0.02, cy + 0.11 * hs, 0.0, 0.05, 0, -0.3, 0.125 * hs, 0.045, 0.13 * hs), cloth);
      ball(c, 0.03, cy + 0.14 * hs, 0.0, 0.02, shade(cloth, 0.8));
      b.boxAt(-0.06, cy + 0.1 * hs, -0.1 * hs, 0.03, 0.035, 0.012, GOLD);
      break;
    }
    case 'none':
    default:
      hairCap(c);
      topKnot(c, true);
      break;
  }
}

export function buildBeard(c: BodyCtx): void {
  const { d, s, b } = c;
  if (s.beard === 'none') return;
  const hs = d.headScale;
  const cy = d.headCY;
  const fz = -0.113 * hs;
  const hair = col(s.hair);
  c.on('head');
  // moustache (all beard types)
  b.add(PRIM.box(), trs(-0.03 * hs, cy - 0.04 * hs, fz - 0.006, 0, 0, 0.35, 0.045 * hs, 0.012, 0.018), hair);
  b.add(PRIM.box(), trs(0.03 * hs, cy - 0.04 * hs, fz - 0.006, 0, 0, -0.35, 0.045 * hs, 0.012, 0.018), hair);
  switch (s.beard) {
    case 'short':
      b.add(PRIM.box(), trs(0, cy - 0.095 * hs, fz + 0.02, 0.2, 0, 0, 0.07 * hs, 0.05, 0.04), hair);
      b.boxAt(-0.075 * hs, cy - 0.055 * hs, -0.05, 0.02, 0.07, 0.07, hair);
      b.boxAt(0.075 * hs, cy - 0.055 * hs, -0.05, 0.02, 0.07, 0.07, hair);
      break;
    case 'long': {
      // 美髯: long tapered beard reaching the chest
      b.boxAt(-0.08 * hs, cy - 0.04 * hs, -0.045, 0.02, 0.1, 0.08, hair);
      b.boxAt(0.08 * hs, cy - 0.04 * hs, -0.045, 0.02, 0.1, 0.08, hair);
      b.add(PRIM.box(), trs(0, cy - 0.1 * hs, fz + 0.03, 0.1, 0, 0, 0.13 * hs, 0.08, 0.06), hair);
      strip(
        c,
        [
          new THREE.Vector3(0, cy - 0.11 * hs, fz + 0.015),
          new THREE.Vector3(0, cy - 0.26, fz - 0.015),
          new THREE.Vector3(0, cy - 0.42, fz - 0.03),
          new THREE.Vector3(0.01, cy - 0.56, fz - 0.035),
        ],
        0.11,
        0.035,
        0.04,
        hair,
        new THREE.Vector3(1, 0, 0),
      );
      // long drooping moustache tails
      b.add(PRIM.box(), trs(-0.055 * hs, cy - 0.1 * hs, fz - 0.008, 0, 0, 0.12, 0.012, 0.09, 0.012), hair);
      b.add(PRIM.box(), trs(0.055 * hs, cy - 0.1 * hs, fz - 0.008, 0, 0, -0.12, 0.012, 0.09, 0.012), hair);
      break;
    }
    case 'wild': {
      // 虎须: spiky beard radiating from the jaw
      const n = 11;
      for (let i = 0; i < n; i++) {
        const a = -1.4 + (i / (n - 1)) * 2.8;
        const base = new THREE.Vector3(Math.sin(a) * 0.08 * hs, cy - 0.06 * hs - Math.cos(a) * 0.035, fz + 0.04 - Math.cos(a) * 0.03);
        const dir = new THREE.Vector3(Math.sin(a) * 0.9, -0.8 - Math.cos(a) * 0.3, -0.35).normalize();
        const tip = base.clone().addScaledVector(dir, 0.1 + (1 - Math.abs(a) / 1.4) * 0.05);
        frustum(c, base, tip, 0.028, 0.004, hair, 4);
      }
      b.add(PRIM.box(), trs(-0.05 * hs, cy - 0.04 * hs, fz - 0.01, 0, 0.2, 0.55, 0.07 * hs, 0.018, 0.02), hair);
      b.add(PRIM.box(), trs(0.05 * hs, cy - 0.04 * hs, fz - 0.01, 0, -0.2, -0.55, 0.07 * hs, 0.018, 0.02), hair);
      break;
    }
  }
}
