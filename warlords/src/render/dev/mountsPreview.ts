// Dev-only: mount lineup (render-dev.html?mode=mounts) — every horse coat
// (mount items) + the war elephant, ridden by GLB heroes / troops when shipped.
//   &coats=chitu,dawan,…   which horses (default: the six mount items)
//   &elephant=0            no elephant
//   &speed=<m/s>           gait (0 idle, ~3 walk, ~7 gallop)
//   &rider=0               no riders
//   &heroes=machao,…       the horses' riders (default: every 5th hero), &weapon=<id> overrides their weapons
//   &pitch=<rad>           the riders' aim pitch
//   &layout=file           nose to tail along Z (a side camera sees every coat), default side by side
//   &cam=side|front|tps|game|x,y,z,tx,ty,tz   (game: the player's camera behind the first rider, 75° fov)
//   &bones=1               skeleton overlay (bones=rider: the riders' skeletons)
// window.__step(frames, dt) advances the animation; window.__cam(x,y,z,tx,ty,tz) moves the camera;
// window.__game(i) puts it behind rider i (sim/aim cameraRig, the game's 75° fov).
import * as THREE from 'three';
import { HEROES, MOUNT_BY_ID, TROOP_BY_ID } from '../../data';
import { CharacterRig } from '../models/character';
import { heroSpec, troopLook } from '../models';
import { GLB_HERO_HEIGHT, heroModelPath, troopModelPath } from '../models/glb';
import { loadAllClips } from '../anim/glbClips';
import { loadMountTemplate } from '../models/mountGlb';
import { mountSeatHeight } from '../models/mounts';
import { kingdomColor } from '../palette';
import { cameraRig } from '../../sim/aim';

declare global {
  interface Window {
    __step?: (frames: number, dt?: number) => void;
    __cam?: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => void;
    __game?: (i: number) => void;
  }
}

export async function startMountsPreview(canvas: HTMLCanvasElement, params: URLSearchParams): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fb4c4');
  const cam = new THREE.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 300);
  const sun = new THREE.DirectionalLight('#ffe2b0', 2.7);
  sun.position.set(-7, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -16;
  sc.right = 16;
  sc.top = 16;
  sc.bottom = -16;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#bcd0e0', '#6a5638', 1.35));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#7d7a58', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // 1 m grid lines on the ground (hoof / scale checks)
  const grid = new THREE.GridHelper(40, 40, '#4a4838', '#5f5c44');
  grid.position.y = 0.002;
  scene.add(grid);

  // the mount art first, so the rigs are built with it
  await Promise.all([loadMountTemplate('horse', mountSeatHeight('horse')), loadMountTemplate('elephant', mountSeatHeight('elephant'))]);
  const riders = params.get('rider') !== '0';
  if (riders) await loadAllClips().catch(() => undefined);
  const coats = (params.get('coats') ?? 'chitu,dawan,zixing,dilu,jueying,zhuahuang').split(',').filter(Boolean);
  const heroes = params.get('heroes')?.split(',').filter((h) => HEROES.some((x) => x.id === h)) ?? [];
  const pickHero = (i: number): string => (heroes.length ? heroes[i % heroes.length] : HEROES[(i * 5 + 1) % HEROES.length].id);
  const weapon = params.get('weapon');
  const rigs: CharacterRig[] = [];
  const gap = 2.2;
  const file = params.get('layout') === 'file';
  coats.forEach((id, i) => {
    const heroId = pickHero(i);
    const rig = new CharacterRig(heroSpec(heroId));
    rig.setWeapon(weapon ?? HEROES.find((h) => h.id === heroId)?.signatureWeapon ?? 'carbine');
    const coat = MOUNT_BY_ID[id]?.color ?? id;
    rig.setMount('horse', coat, kingdomColor(HEROES.find((h) => h.id === heroId)?.kingdom), '#d8ac4c');
    if (riders) rig.useGlb(heroModelPath(heroId), GLB_HERO_HEIGHT);
    else rig.mesh.visible = false;
    if (file) rig.root.position.set(0, 0, (i - (coats.length - 1) / 2) * 3.0);
    else rig.root.position.set((i - (coats.length - 1) / 2) * gap, 0, 0);
    scene.add(rig.root);
    rigs.push(rig);
  });
  if (params.get('elephant') !== '0') {
    const look = troopLook('elephant');
    const rig = new CharacterRig(look.spec);
    // as in a match (models/index.ts createTroopModel): the troop's weapon and scale
    const def = TROOP_BY_ID.elephant;
    rig.setWeapon(weapon ?? def?.weapon ?? (def?.melee ? 'troop_melee' : 'troop_rifle'));
    rig.root.scale.setScalar(look.rootScale);
    rig.setMount('elephant', '#8a8580', look.spec.kingdom, '#d8ac4c');
    if (riders) rig.useGlb(troopModelPath({ id: 'elephant', headgear: look.spec.headgear }), rig.standHeight());
    else rig.mesh.visible = false;
    rig.root.position.set(0, 0, file ? -((coats.length - 1) / 2) * 3.0 - 5 : -5.5);
    scene.add(rig.root);
    rigs.push(rig);
  }
  if (params.get('bones') === '1') for (const r of rigs) if (r.mount) scene.add(new THREE.SkeletonHelper(r.mount.mesh));
  // GLB bodies swap in asynchronously
  for (let i = 0; i < 100 && riders && rigs.some((r) => !r.usesGlb); i++) await new Promise((res) => setTimeout(res, 100));
  // &bones=rider: the riders' skeletons (drawn over the meshes)
  if (params.get('bones') === 'rider') {
    for (const r of rigs) {
      const g = r.glbObject;
      if (!g) continue;
      const h = new THREE.SkeletonHelper(g);
      (h.material as THREE.LineBasicMaterial).depthTest = false;
      h.renderOrder = 30;
      scene.add(h);
    }
  }

  const setCam = (x: number, y: number, z: number, tx: number, ty: number, tz: number): void => {
    cam.fov = 35;
    cam.updateProjectionMatrix();
    cam.position.set(x, y, z);
    cam.lookAt(tx, ty, tz);
  };
  const pitch = Number(params.get('pitch') ?? 0);
  const gameCam = (i: number): void => {
    const p = rigs[Math.min(i, rigs.length - 1)].root.position;
    const r = cameraRig({ x: p.x, y: p.y, z: p.z }, 0, pitch);
    cam.fov = 75;
    cam.updateProjectionMatrix();
    cam.position.set(r.origin.x, r.origin.y, r.origin.z);
    cam.lookAt(r.origin.x + r.dir.x, r.origin.y + r.dir.y, r.origin.z + r.dir.z);
  };
  const cp = params.get('cam') ?? 'side';
  const span = (coats.length - 1) * gap;
  if (cp === 'side' && file) setCam(15, 1.6, -1.2, 0, 1.2, -1.2);
  else if (cp === 'side') setCam(span / 2 + 9, 1.5, 2.5, 0, 1.0, -1.5);
  else if (cp === 'front') setCam(0, 1.8, -14, 0, 1.2, 0);
  else if (cp === 'tps') setCam(0.6, 2.6, 4.2, 0, 1.9, -3);
  else if (cp === 'game') gameCam(0);
  else {
    const v = cp.split(',').map(Number);
    if (v.length === 6) setCam(v[0], v[1], v[2], v[3], v[4], v[5]);
  }
  const speed = Number(params.get('speed') ?? 0);
  let t = 0;
  const step = (frames: number, dt = 1 / 60): void => {
    for (let f = 0; f < frames; f++) {
      t += dt;
      for (const r of rigs) r.update(dt, t, { speed, moveX: 0, moveZ: speed > 0 ? 1 : 0, pitch, flags: 0 });
    }
    renderer.render(scene, cam);
  };
  window.__step = step;
  window.__cam = (x, y, z, tx, ty, tz) => {
    setCam(x, y, z, tx, ty, tz);
    renderer.render(scene, cam);
  };
  window.__game = (i) => {
    gameCam(i);
    renderer.render(scene, cam);
  };
  // settle the animators (one-shot poses, gait blend)
  step(Number(params.get('warm') ?? 90));
  (window as unknown as { __info: unknown }).__info = { mounts: rigs.map((r) => ({ kind: r.mount?.kind, glb: r.mount?.usesGlb, body: r.usesGlb })) };
  (window as unknown as { __ready: boolean }).__ready = true;
}
