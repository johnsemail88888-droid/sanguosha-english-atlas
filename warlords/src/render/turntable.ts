// 武将图鉴 gallery turntable: the hero on a pedestal, slowly rotating, draggable,
// cycling a few poses. Owns its own small WebGLRenderer (dispose() frees it).
import * as THREE from 'three';
import { VF_ADS, VF_FIRING, VF_RELOADING } from '../core/types';
import { HERO_BY_ID } from '../data';
import { CharacterRig } from './models/character';
import { heroMountCoat, heroSpec } from './models';
import { kingdomColor } from './palette';
import { GeoBuilder, PRIM, shade, trs } from './core/geo';
import { worldMaterial } from './core/materials';

export interface TurntableHandle {
  dispose(): void;
}

export function mountHeroTurntable(container: HTMLElement, heroId: string): TurntableHandle {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab';
  container.appendChild(canvas);
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    canvas.remove();
    return { dispose: () => undefined };
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 0);

  const def = HERO_BY_ID[heroId];
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  // pedestal
  const kc = kingdomColor(def?.kingdom);
  const pb = new GeoBuilder();
  pb.add(PRIM.cyl(32), trs(0, -0.12, 0, 0, 0, 0, 1.05, 0.24, 1.05), '#6c6860');
  pb.add(PRIM.cyl(32), trs(0, 0.02, 0, 0, 0, 0, 0.98, 0.05, 0.98), '#8f8a80');
  pb.add(PRIM.torus(0.04, 4, 48), trs(0, 0.04, 0, Math.PI / 2, 0, 0, 1.0, 1.0, 1.0), '#d8ac4c');
  pb.add(PRIM.cyl(32), trs(0, -0.12, 0, 0, 0, 0, 1.07, 0.1, 1.07), shade(kc, 0.9));
  const pedestalGeo = pb.build();
  const pedestal = new THREE.Mesh(pedestalGeo, worldMaterial());
  pedestal.receiveShadow = true;
  scene.add(pedestal);
  // hero
  const turn = new THREE.Group();
  scene.add(turn);
  const rig = new CharacterRig(heroSpec(heroId, def?.kingdom));
  rig.setWeapon(def?.signatureWeapon ?? null);
  rig.tryGlbOverride(heroId);
  rig.root.position.y = 0.045;
  rig.root.rotation.y = Math.PI; // face the camera
  turn.add(rig.root);
  // lights
  const key = new THREE.DirectionalLight('#ffe2b8', 3);
  key.position.set(-3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera as THREE.OrthographicCamera;
  sc.left = -2;
  sc.right = 2;
  sc.top = 3;
  sc.bottom = -1;
  key.shadow.normalBias = 0.02;
  const rim = new THREE.DirectionalLight('#a8c8ff', 2.2);
  rim.position.set(3, 3, -4);
  scene.add(key, rim, new THREE.HemisphereLight('#d0dcea', '#4a3a28', 1.1));

  // always-mounted heroes (HeroVisual.mount: 马超 西凉战马, 吕布 赤兔) are shown riding, as in the match
  const coat = heroMountCoat(heroId, undefined, false);
  if (coat) rig.setMount('horse', coat, kc, '#d8ac4c');
  const frameH = coat ? Math.max(2.55, rig.headHeight() + 0.45) : 2.55;
  const resize = (): void => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    const dist = (frameH / 2 / Math.tan((cam.fov * Math.PI) / 360)) * 1.12;
    cam.position.set(0, frameH * 0.5 + 0.1, dist);
    cam.lookAt(0, frameH * 0.46, 0);
    cam.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  resize();

  // drag to rotate (with inertia), otherwise slow auto-spin
  let angle = 0.35;
  let vel = 0.25;
  let dragging = false;
  let lastX = 0;
  const onDown = (e: PointerEvent): void => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    angle += dx * 0.01;
    vel = dx * 0.6;
  };
  const onUp = (e: PointerEvent): void => {
    dragging = false;
    canvas.style.cursor = 'grab';
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  let raf = 0;
  let last = performance.now();
  let t = 0;
  let disposed = false;
  const loop = (now: number): void => {
    if (disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    if (!dragging) {
      vel += (0.25 - vel) * (1 - Math.exp(-dt * 1.5));
      angle += vel * dt;
    }
    turn.rotation.y = angle;
    // pose cycle: idle → aim + fire bursts → reload → idle
    const phase = t % 12;
    let flags = 0;
    if (phase > 5 && phase < 8.5) flags = VF_ADS | (phase % 1 < 0.35 ? VF_FIRING : 0);
    else if (phase >= 8.5 && phase < 10.5) flags = VF_RELOADING;
    rig.update(dt, t, { speed: 0, moveX: 0, moveZ: 0, pitch: flags & VF_ADS ? 0.05 : 0, flags });
    renderer.render(scene, cam);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      rig.dispose();
      pedestalGeo.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
