// Dev-only: AI-art weapon calibration bench (render-dev.html?mode=models&set=weapons).
// One row per weapon (models/weaponGlb.ts WEAPON_GLB_CAL), one cell per view:
//   bench  the calibrated weapon alone from its right side (barrel → right), with
//          the calibration grid (u every 0.1 along the barrel, v every 0.05 up;
//          darker: u = 0 / 0.5 / 1, v = 0) and the points: grip (red, the
//          weapon origin = wrist target), fore (blue), mag (green), muzzle (yellow);
//          the 2D weapon art in the corner for reference; label: hold, size, tris (full / far LOD)
//   side   a GLB hero holding it in the aimed pose, from the right
//   hand   close-up of the weapon hand from the right (grip in the fist?)
//   draw   both hands from the right, wider (the bow's drawing hand on the string, the pistol's cupping hand)
//   top    the same from above (barrel along the aim, nothing inside the body)
//   front  from the front-left
//   tps    the player's over-the-shoulder camera (sim/aim cameraRig), cropped
//          around the crosshair; the yellow line leaves the muzzle along the barrel
//   game   the same camera at the game's default 75° field of view
// Params: ids=a,b (default: every calibrated weapon), views=bench,side,top,tps
// (default), hero=<id> (default zhaoyun; 'owner' = the weapon's hero),
// pitch=<rad>, anim=ads|reload|sprint|low (sprint: running in place; low: the
// showcase's low-ready idle), cell=<px width>, bones=1 (hand joint
// markers + the weapon's fore point in magenta), noweapon=1.
// window.__reach: per row, the support arm's reach and its shoulder's distances
// to the weapon's grip / fore point, the hand's to the fore point (m).
import * as THREE from 'three';
import { HEROES, WEAPON_BY_ID } from '../../data';
import { VF_ADS, VF_RELOADING, VF_SPRINTING } from '../../core/types';
import { cameraRig } from '../../sim/aim';
import { CharacterRig } from '../models/character';
import { heroSpec } from '../models';
import { heroModelPath, loadCharTemplate } from '../models/glb';
import { loadAllClips } from '../anim/glbClips';
import { WEAPON_GLB_CAL, loadWeaponArt, weaponArtSync, type WeaponPoint } from '../models/weaponGlb';
import { buildWeapon } from '../models/weapons';

type View = 'bench' | 'side' | 'hand' | 'draw' | 'top' | 'front' | 'tps' | 'game';

/** Distance between the rows' heroes (m): nothing of one row shows in another's views. */
const SPACING = 40;

export async function startWeaponsPreview(canvas: HTMLCanvasElement, params: URLSearchParams): Promise<void> {
  const ids = (params.get('ids')?.split(',') ?? Object.keys(WEAPON_GLB_CAL)).filter((id) => WEAPON_GLB_CAL[id]);
  const views = (params.get('views')?.split(',') ?? ['bench', 'side', 'top', 'tps']) as View[];
  const heroParam = params.get('hero') ?? 'zhaoyun';
  const pitch = Number(params.get('pitch') ?? 0);
  const anim = params.get('anim') ?? '';
  const flags = anim === 'ads' ? VF_ADS : anim === 'reload' ? VF_RELOADING : anim === 'sprint' ? VF_SPRINTING : 0;
  const cellW = Number(params.get('cell') ?? 400);
  const cellH = Math.round((cellW * 9) / 16);
  const W = cellW * views.length;
  const H = cellH * ids.length;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.style.overflow = 'auto';
  document.getElementById('crosshair')?.remove();

  const heroOf = (wid: string): string => (heroParam === 'owner' ? (HEROES.find((h) => h.signatureWeapon === wid)?.id ?? 'zhaoyun') : heroParam);
  const heroes = [...new Set(ids.map(heroOf))];
  await Promise.all([...heroes.map((h) => loadCharTemplate(heroModelPath(h))), loadAllClips(), ...ids.map((id) => loadWeaponArt(id))]);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#b8b0a0');
  const sun = new THREE.DirectionalLight('#ffe2b0', 2.4);
  sun.position.set(4, 8, 6);
  scene.add(sun, new THREE.HemisphereLight('#d0dcea', '#6a5638', 1.5));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: '#8a8a60' }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;pointer-events:none;font:11px monospace;color:#fff`;
  document.body.appendChild(overlay);
  const label = (x: number, y: number, text: string, color = '#fff'): void => {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;color:${color};text-shadow:0 0 2px #000,0 0 2px #000;white-space:pre`;
    overlay.appendChild(d);
  };

  const marker = (color: string, r: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.renderOrder = 20;
    return m;
  };
  const lineMat = (color: string, opacity: number): THREE.LineBasicMaterial => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });

  interface Row {
    id: string;
    rig: CharacterRig;
    bench: THREE.Group;
    length: number;
    center: THREE.Vector3;
    pos: THREE.Vector3;
    barrel: THREE.Line;
    /** &bones=1: markers on the hand joints (red right wrist, blue left wrist, orange right elbow) */
    joints: { name: string; m: THREE.Mesh }[];
  }
  const showBones = params.get('bones') === '1';
  const hideWeapon = params.get('noweapon') === '1';
  const rows: Row[] = [];
  ids.forEach((id, i) => {
    const cal = WEAPON_GLB_CAL[id];
    const art = weaponArtSync(id);
    // bench: the calibrated weapon alone, far from the heroes
    const bench = new THREE.Group();
    bench.position.set(i * SPACING, 40, -60);
    const w = buildWeapon(id);
    bench.add(w.mesh);
    const L = w.info.length;
    const at = (p: WeaponPoint): THREE.Vector3 => new THREE.Vector3((p[2] ?? 0) * L, (p[1] - cal.grip[1]) * L, -(p[0] - cal.grip[0]) * L);
    const pts: number[] = [];
    const strong: number[] = [];
    const vr = 0.35;
    for (let k = 0; k <= 10; k++) {
      const a = at([k / 10, -vr]);
      const b = at([k / 10, vr]);
      (k % 5 === 0 ? strong : pts).push(a.x - 0.3, a.y, a.z, b.x - 0.3, b.y, b.z);
    }
    for (let k = -7; k <= 7; k++) {
      const a = at([-0.05, k * 0.05]);
      const b = at([1.05, k * 0.05]);
      (k === 0 ? strong : pts).push(a.x - 0.3, a.y, a.z, b.x - 0.3, b.y, b.z);
    }
    const g1 = new THREE.BufferGeometry();
    g1.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(strong, 3));
    const grid = new THREE.LineSegments(g1, lineMat('#303030', 0.35));
    const grid2 = new THREE.LineSegments(g2, lineMat('#000000', 0.7));
    grid.renderOrder = grid2.renderOrder = -1;
    (grid.material as THREE.Material).depthTest = true;
    (grid2.material as THREE.Material).depthTest = true;
    bench.add(grid, grid2);
    const r = L * 0.012 + 0.004;
    const grip = marker('#ff2020', r);
    bench.add(grip);
    const muzzle = marker('#ffe000', r);
    muzzle.position.copy(w.info.muzzle);
    bench.add(muzzle);
    if (w.info.fore) {
      const f = marker('#2060ff', r);
      f.position.copy(w.info.fore);
      bench.add(f);
    }
    if (w.info.mag) {
      const m = marker('#20c040', r);
      m.position.copy(w.info.mag);
      bench.add(m);
    }
    scene.add(bench);
    const geo = w.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const box = geo.boundingBox!.clone();
    // the hero holding it
    const hero = heroOf(id);
    const rig = new CharacterRig(heroSpec(hero));
    rig.setWeapon(id);
    rig.useGlb(heroModelPath(hero));
    const pos = new THREE.Vector3(i * SPACING, 0, 0);
    rig.root.position.copy(pos);
    scene.add(rig.root);
    const barrel = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat('#ffe000', 0.9));
    barrel.renderOrder = 21;
    barrel.frustumCulled = false;
    scene.add(barrel);
    const joints = showBones
      ? [
          ['RightHand', '#ff2020'],
          ['LeftHand', '#2060ff'],
          ['RightForeArm', '#ff9020'],
          ['fore', '#ff20ff'],
        ].map(([name, c]) => {
          const m = marker(c, 0.012);
          scene.add(m);
          return { name, m };
        })
      : [];
    rows.push({ id, rig, bench, length: L, center: box.getCenter(new THREE.Vector3()), pos, barrel, joints });
    const def = WEAPON_BY_ID[id];
    const y = i * cellH;
    const tris = (g: THREE.BufferGeometry | null | undefined): string => (g ? String(Math.round((g.getIndex()?.count ?? g.getAttribute('position').count) / 3)) : '-');
    label(
      4,
      y + 2,
      `${id} ${def?.nameZh ?? ''} ${w.info.hold}${art ? '' : ' (PROCEDURAL)'} L=${L.toFixed(2)} h=${(box.max.y - box.min.y).toFixed(2)} tris=${tris(art?.geo)}/${tris(art?.lod)}`,
      art ? '#fff' : '#f66',
    );
    views.forEach((v, k) => {
      if (k > 0) label(k * cellW + 4, y + 2, v);
    });
    if (views.includes('bench') && art) {
      const img = document.createElement('img');
      img.src = `assets/weapons/${id}.webp`;
      img.style.cssText = `position:absolute;left:${views.indexOf('bench') * cellW + cellW - 98}px;top:${y + cellH - 56}px;width:96px;height:54px;border:1px solid #000;background:#000`;
      overlay.appendChild(img);
    }
  });

  const cam = new THREE.PerspectiveCamera(35, cellW / cellH, 0.05, 500);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 50);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  let t = 0;
  const step = (dt: number): void => {
    t += dt;
    // sprint: running in place (the lowered carry needs speed); low: the showcase's low-ready idle
    const speed = anim === 'sprint' ? 7.5 : 0;
    for (const r of rows) r.rig.update(dt, t, { speed, moveX: 0, moveZ: speed > 0 ? 1 : 0, pitch, flags, lowReady: anim === 'low' });
  };
  for (let i = 0; i < 90; i++) step(1 / 60);
  scene.updateMatrixWorld(true);
  for (const r of rows) {
    for (const j of r.joints) {
      if (j.name === 'fore') {
        // the held weapon's fore point (foregrip / bow nock), magenta
        const wm = findWeaponMesh(r.rig.root, r.id);
        const fore = r.rig.glbBody?.weaponInfo?.fore;
        j.m.visible = !!(wm && fore);
        if (wm && fore) j.m.position.copy(fore).applyMatrix4(wm.matrixWorld);
      } else r.rig.glbBody?.boneWorld(j.name, j.m.position);
    }
    if (hideWeapon) r.rig.root.traverse((o) => o.name.startsWith('weapon_') && (o.visible = false));
  }
  // window.__reach: the support arm's reach vs its distances to the weapon's grip / fore point (m)
  (window as unknown as { __reach: unknown }).__reach = rows.map((r) => {
    const body = r.rig.glbBody;
    const wm = findWeaponMesh(r.rig.root, r.id);
    const fore = body?.weaponInfo?.fore;
    if (!body || !wm || !fore) return { id: r.id };
    const pos = (name: string): THREE.Vector3 => {
      const v = new THREE.Vector3();
      body.boneWorld(name, v);
      return v;
    };
    const [a, b, c, ra] = [pos('LeftArm'), pos('LeftForeArm'), pos('LeftHand'), pos('RightArm')];
    const grip = new THREE.Vector3().setFromMatrixPosition(wm.matrixWorld);
    const f = fore.clone().applyMatrix4(wm.matrixWorld);
    const r3 = (x: number): number => Math.round(x * 1000) / 1000;
    return { id: r.id, reach: r3(a.distanceTo(b) + b.distanceTo(c)), shoulders: r3(a.distanceTo(ra)), toGrip: r3(a.distanceTo(grip)), toFore: r3(a.distanceTo(f)), handToFore: r3(c.distanceTo(f)), gripToFore: r3(grip.distanceTo(f)) };
  });

  const draw = (): void => {
    scene.updateMatrixWorld(true);
    rows.forEach((r, i) => {
      // only this row's objects (the other rows' lines would cross the views)
      for (const o of rows) {
        o.rig.root.visible = o === r;
        o.bench.visible = o === r;
        o.barrel.visible = false;
        for (const j of o.joints) j.m.visible = o === r;
      }
      // barrel line from the muzzle along the weapon's −Z
      const pa = r.barrel.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (r.rig.muzzleWorld(tmp)) {
        const wm = r.rig.glbBody ? findWeaponMesh(r.rig.root, r.id) : null;
        tmp2.set(0, 0, -1);
        if (wm) tmp2.transformDirection(wm.matrixWorld);
        pa.setXYZ(0, tmp.x, tmp.y, tmp.z);
        pa.setXYZ(1, tmp.x + tmp2.x * 40, tmp.y + tmp2.y * 40, tmp.z + tmp2.z * 40);
        pa.needsUpdate = true;
        r.barrel.visible = true;
      } else r.barrel.visible = false;
      views.forEach((v, k) => {
        const x = k * cellW;
        const y = H - (i + 1) * cellH;
        renderer.setViewport(x, y, cellW - 1, cellH - 1);
        renderer.setScissor(x, y, cellW - 1, cellH - 1);
        if (v === 'bench') {
          const half = r.length * 0.62;
          ortho.left = -half;
          ortho.right = half;
          ortho.top = (half * cellH) / cellW;
          ortho.bottom = -ortho.top;
          ortho.updateProjectionMatrix();
          tmp.copy(r.bench.position).add(r.center);
          ortho.position.set(tmp.x + 10, tmp.y, tmp.z);
          ortho.up.set(0, 1, 0);
          ortho.lookAt(tmp);
          renderer.render(scene, ortho);
          return;
        }
        const p = r.pos;
        if (v === 'side') {
          cam.fov = 26;
          cam.position.set(p.x + 2.6, 1.35, p.z - 0.4);
          cam.up.set(0, 1, 0);
          cam.lookAt(p.x, 1.3, p.z - 0.4);
        } else if (v === 'hand') {
          const hand = r.rig.glbBody?.boneWorld(r.id && WEAPON_GLB_CAL[r.id].fit === 'height' ? 'LeftHand' : 'RightHand', tmp) ? tmp : tmp.set(p.x, 1.3, p.z - 0.3);
          cam.fov = 24;
          cam.position.set(hand.x + 1.1, hand.y + 0.05, hand.z - 0.15);
          cam.up.set(0, 1, 0);
          cam.lookAt(hand.x, hand.y, hand.z - 0.15);
        } else if (v === 'draw') {
          // between the two hands, from the right
          const a = r.rig.glbBody?.boneWorld('LeftHand', tmp) ? tmp.clone() : tmp.set(p.x, 1.3, p.z - 0.3).clone();
          const b = r.rig.glbBody?.boneWorld('RightHand', tmp2) ? tmp2 : tmp2.set(p.x, 1.3, p.z - 0.3);
          a.add(b).multiplyScalar(0.5);
          cam.fov = 34;
          cam.position.set(a.x + 1.5, a.y + 0.15, a.z);
          cam.up.set(0, 1, 0);
          cam.lookAt(a.x, a.y, a.z);
        } else if (v === 'front') {
          cam.fov = 30;
          cam.position.set(p.x - 0.6, 1.5, p.z - 3.2);
          cam.up.set(0, 1, 0);
          cam.lookAt(p.x, 1.25, p.z);
        } else if (v === 'top') {
          cam.fov = 30;
          cam.position.set(p.x + 0.01, 4.4, p.z - 0.4);
          cam.up.set(0, 0, -1);
          cam.lookAt(p.x, 1.2, p.z - 0.4);
        } else {
          // the player's camera, cropped around the crosshair (the game shows ~75° vertically)
          const rig = cameraRig({ x: p.x, y: p.y, z: p.z }, 0, pitch);
          cam.fov = v === 'game' ? 75 : 44;
          cam.position.set(rig.origin.x, rig.origin.y, rig.origin.z);
          cam.up.set(0, 1, 0);
          cam.lookAt(rig.origin.x + rig.dir.x, rig.origin.y + rig.dir.y, rig.origin.z + rig.dir.z);
        }
        cam.aspect = cellW / cellH;
        cam.updateProjectionMatrix();
        renderer.render(scene, cam);
      });
      views.forEach((v, k) => {
        if (v === 'tps' || v === 'game') label(k * cellW + cellW / 2 - 4, i * cellH + cellH / 2 - 8, '+', '#0f0');
      });
    });
  };
  draw();
  (window as unknown as { __ready: boolean; __redraw: () => void }).__ready = true;
  (window as unknown as { __redraw: () => void }).__redraw = draw;
}

function findWeaponMesh(root: THREE.Object3D, id: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.name === `weapon_${id}` && (o as THREE.Mesh).isMesh) found = o;
  });
  return found;
}
