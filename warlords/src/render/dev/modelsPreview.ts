// Dev-only: character lineup preview (render-dev.html?mode=models); &set=weapons
// opens the AI-art weapon calibration bench (dev/weaponsPreview.ts).
import * as THREE from 'three';
import { HEROES, TROOPS } from '../../data';
import { CharacterRig } from '../models/character';
import { heroSpec, troopLook } from '../models';
import { VF_ADS, VF_DANCING, VF_DEAD, VF_DOWNED, VF_RELOADING, VF_SPRINTING, VF_STUNNED } from '../../core/types';

export function startModelsPreview(canvas: HTMLCanvasElement, params: URLSearchParams): void {
  if (params.get('set') === 'weapons') {
    void import('./weaponsPreview').then((m) => m.startWeaponsPreview(canvas, params));
    return;
  }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d9ccb0');
  const cam = new THREE.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
  const sun = new THREE.DirectionalLight('#ffe2b0', 2.6);
  sun.position.set(-6, 8, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#bcd0e0', '#6a5638', 1.4));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#8a8a60' }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const which = params.get('set') ?? 'heroes';
  const flagSet = params.get('anim') ?? '';
  const rigs: { rig: CharacterRig; flags: number; speed: number }[] = [];
  const only = params.get('ids')?.split(',');
  const ids = (which === 'troops' ? TROOPS.map((t) => t.id) : HEROES.map((h) => h.id)).filter((id) => !only || only.includes(id));
  const perRow = Number(params.get('row') ?? 8);
  ids.forEach((id, i) => {
    let rig: CharacterRig;
    if (which === 'troops') {
      const look = troopLook(id);
      rig = new CharacterRig(look.spec);
      const def = TROOPS.find((t) => t.id === id)!;
      rig.setWeapon(def.weapon);
      if (look.mount) rig.setMount(look.mount, look.mount === 'elephant' ? '#8a8580' : '#5a3f2a', look.spec.kingdom);
    } else {
      rig = new CharacterRig(heroSpec(id));
      rig.setWeapon(HEROES.find((h) => h.id === id)!.signatureWeapon);
    }
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    rig.root.position.set((col - (perRow - 1) / 2) * 1.6, 0, -row * 2.4);
    rig.root.rotation.y = Number(params.get('yaw') ?? 0);
    scene.add(rig.root);
    let flags = 0;
    if (flagSet === 'ads') flags = VF_ADS;
    if (flagSet === 'dead') flags = VF_DEAD;
    if (flagSet === 'downed') flags = VF_DOWNED;
    if (flagSet === 'dance') flags = VF_DANCING;
    if (flagSet === 'stun') flags = VF_STUNNED;
    if (flagSet === 'reload') flags = VF_RELOADING;
    if (flagSet === 'sprint') flags = VF_SPRINTING;
    rigs.push({ rig, flags, speed: Number(params.get('speed') ?? 0) });
  });
  const dist = Number(params.get('dist') ?? 14);
  const camY = Number(params.get('camy') ?? 2.2 + dist * 0.12);
  cam.position.set(Number(params.get('camx') ?? 0), camY, dist);
  cam.lookAt(0, Number(params.get('looky') ?? 1.0), Number(params.get('lookz') ?? -2));
  let t = 0;
  const tick = (): void => {
    const dt = 1 / 60;
    t += dt;
    for (const r of rigs) r.rig.update(dt, t, { speed: r.speed, moveX: 0, moveZ: r.speed > 0 ? 1 : 0, pitch: Number(params.get('pitch') ?? 0), flags: r.flags });
    renderer.render(scene, cam);
    requestAnimationFrame(tick);
  };
  // warm up the animators so one-shot poses settle
  for (let i = 0; i < 90; i++) {
    t += 1 / 60;
    for (const r of rigs) r.rig.update(1 / 60, t, { speed: r.speed, moveX: 0, moveZ: r.speed > 0 ? 1 : 0, pitch: Number(params.get('pitch') ?? 0), flags: r.flags });
  }
  tick();
  (window as unknown as { __ready: boolean }).__ready = true;
}
