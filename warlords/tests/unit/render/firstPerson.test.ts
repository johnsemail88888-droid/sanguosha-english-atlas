// First-person camera math and viewmodel (render/camera/firstPerson.ts,
// viewmodel.ts, viewMode.ts): eye height per state, the aim ray = the camera's
// centre ray (= the sim's first-person rig), the view toggle, the own-body
// hider and the viewmodel's poses / muzzle projection.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirFromYawPitch } from '../../../src/core/math';
import { BTN_FIRE, BTN_FIRST_PERSON, VF_DEAD, VF_DOWNED, VF_MOUNTED } from '../../../src/core/types';
import { firstPersonRig, FP_EYE_HEIGHT, FP_EYE_HEIGHT_DOWNED, FP_EYE_HEIGHT_MOUNTED } from '../../../src/sim/aim';
import { FirstPersonView, ShadowOnlyBody, firstPersonPose, fpEyeOf, viewRides } from '../../../src/render/camera/firstPerson';
import { CAMERA_TOGGLE_KEY, resolveCameraView, toggledCameraView } from '../../../src/render/camera/viewMode';
import { TpsCameraRig } from '../../../src/render/camera/tpsCamera';
import { HIP_POSE, ViewModel, adsPose, buildHands, handColorsOf, lookQuat, sightHeight, type ViewModelInput } from '../../../src/render/camera/viewmodel';
import { buildProceduralWeapon } from '../../../src/render/models/weapons';
import { InputController, InputState, shouldSuppressKey } from '../../../src/game/input';
import { settings } from '../../../src/game/settings';

const hero = (sub: string, flags = 0) => ({ kind: 'hero' as const, sub, flags });

describe('view mode', () => {
  it("'auto' is first person with mouse + keyboard, third person on touch", () => {
    expect(resolveCameraView('auto', false)).toBe('first');
    expect(resolveCameraView('auto', true)).toBe('third');
    expect(resolveCameraView(undefined, false)).toBe('first');
    expect(resolveCameraView('third', false)).toBe('third');
    expect(resolveCameraView('first', true)).toBe('first');
  });

  it('the toggle picks the other view explicitly', () => {
    expect(toggledCameraView('auto', false)).toBe('third');
    expect(toggledCameraView('auto', true)).toBe('first');
    expect(toggledCameraView('third', false)).toBe('first');
    expect(toggledCameraView('first', true)).toBe('third');
  });
});

describe('first-person eye', () => {
  it('standing, riding (a mount item or an always-mounted hero), downed', () => {
    expect(fpEyeOf(hero('guanyu'))).toBe(FP_EYE_HEIGHT);
    expect(viewRides(hero('guanyu', VF_MOUNTED))).toBe(true);
    expect(fpEyeOf(hero('guanyu', VF_MOUNTED))).toBe(FP_EYE_HEIGHT_MOUNTED);
    // 马超 / 吕布 always ride (sim ridesForHits: visual.mount)
    expect(viewRides(hero('machao'))).toBe(true);
    expect(fpEyeOf(hero('lubu'))).toBe(FP_EYE_HEIGHT_MOUNTED);
    expect(fpEyeOf(hero('machao', VF_DOWNED))).toBe(FP_EYE_HEIGHT_DOWNED);
    expect(viewRides(hero('machao', VF_DEAD))).toBe(false);
  });

  it('the pose is the sim first-person rig; the rendered camera looks exactly down it (crosshair = centre)', () => {
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 500);
    const rig = new TpsCameraRig(cam);
    for (const [yaw, pitch] of [
      [0, 0],
      [0.9, 0.35],
      [-2.2, -0.7],
    ]) {
      const pos = { x: 4, y: 1, z: -3 };
      const pose = firstPersonPose(pos, yaw, pitch, FP_EYE_HEIGHT);
      const sim = firstPersonRig(pos, yaw, pitch, FP_EYE_HEIGHT);
      expect(pose.origin).toEqual(sim.origin);
      expect(pose.dir).toEqual(sim.dir);
      rig.firstPerson(pos, FP_EYE_HEIGHT, yaw, pitch);
      rig.apply(0);
      expect(cam.position.x).toBeCloseTo(pos.x, 9);
      expect(cam.position.y).toBeCloseTo(pos.y + FP_EYE_HEIGHT, 9);
      expect(cam.position.z).toBeCloseTo(pos.z, 9);
      const d = dirFromYawPitch(yaw, pitch);
      const wd = cam.getWorldDirection(new THREE.Vector3());
      expect(wd.x).toBeCloseTo(d.x, 6);
      expect(wd.y).toBeCloseTo(d.y, 6);
      expect(wd.z).toBeCloseTo(d.z, 6);
      // a point 3 m down the aim ray projects to the screen centre (where the HUD crosshair is)
      const p = new THREE.Vector3(pose.origin.x + d.x * 3, pose.origin.y + d.y * 3, pose.origin.z + d.z * 3).project(cam);
      expect(Math.abs(p.x)).toBeLessThan(1e-6);
      expect(Math.abs(p.y)).toBeLessThan(1e-6);
    }
  });

  it('eases the eye when it changes (mounting, going down) and snaps on the first frame', () => {
    const fp = new FirstPersonView(new THREE.PerspectiveCamera());
    expect(fp.eyeHeight(hero('guanyu'), 1 / 60)).toBe(FP_EYE_HEIGHT);
    const h1 = fp.eyeHeight(hero('guanyu', VF_MOUNTED), 1 / 60);
    expect(h1).toBeGreaterThan(FP_EYE_HEIGHT);
    expect(h1).toBeLessThan(FP_EYE_HEIGHT_MOUNTED);
    let h = h1;
    for (let i = 0; i < 90; i++) h = fp.eyeHeight(hero('guanyu', VF_MOUNTED), 1 / 60);
    expect(h).toBe(FP_EYE_HEIGHT_MOUNTED);
  });
});

describe('own body in first person', () => {
  it('drawn for no colour / depth in the first-person camera only (shadow pass untouched), restored after', () => {
    const cam = new THREE.PerspectiveCamera();
    const other = new THREE.PerspectiveCamera();
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial();
    const body = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const mount = new THREE.Group();
    const horse = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mount.add(horse);
    root.add(body, mount);
    const hider = new ShadowOnlyBody();
    hider.apply(root, cam, mount);
    const draw = (m: THREE.Mesh, c: THREE.Camera): { color: boolean; depth: boolean } => {
      const mat = m.material as THREE.Material;
      m.onBeforeRender(null as never, null as never, c, m.geometry, mat, null as never);
      const seen = { color: mat.colorWrite, depth: mat.depthWrite };
      m.onAfterRender(null as never, null as never, c, m.geometry, mat, null as never);
      return seen;
    };
    expect(draw(body, cam)).toEqual({ color: false, depth: false });
    expect(shared.colorWrite).toBe(true); // restored for everyone else sharing it
    expect(shared.depthWrite).toBe(true);
    expect(draw(body, other)).toEqual({ color: true, depth: true });
    expect(draw(horse, cam)).toEqual({ color: true, depth: true }); // the mount stays in view
    // a mesh added later (GLB body swapping in) is hidden from the next apply()
    const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    root.add(late);
    hider.apply(root, cam, mount);
    expect(draw(late, cam).color).toBe(false);
    // leaving first person shows everything again
    hider.apply(null, cam);
    expect(draw(body, cam)).toEqual({ color: true, depth: true });
  });
});

function vmInput(p: Partial<ViewModelInput> = {}): ViewModelInput {
  return {
    weaponId: 'carbine',
    heroId: 'guanyu',
    ads: false,
    hidden: false,
    sprinting: false,
    reloading: false,
    lowered: false,
    airborne: false,
    speed: 0,
    yaw: 0,
    pitch: 0,
    cameraQuat: new THREE.Quaternion(),
    ...p,
  };
}

describe('viewmodel', () => {
  it('holds the weapon lower right at the hip and centred on the sights when aiming', () => {
    const vm = new ViewModel();
    vm.update(1 / 60, vmInput());
    expect(vm.visible).toBe(true);
    expect(vm.hold).toBe('rifle');
    for (let i = 0; i < 60; i++) vm.update(1 / 60, vmInput());
    const hip = { ...vm.currentPose };
    expect(hip.x).toBeGreaterThan(0.08); // right of centre
    expect(hip.y).toBeLessThan(-0.08); // below
    expect(hip.z).toBeLessThan(0); // in front of the camera
    for (let i = 0; i < 60; i++) vm.update(1 / 60, vmInput({ ads: true }));
    const ads = vm.currentPose;
    expect(Math.abs(ads.x)).toBeLessThan(0.01);
    // the sight line sits just under the crosshair
    const sight = sightHeight(buildProceduralWeapon('carbine').mesh.geometry);
    expect(ads.y + sight).toBeLessThan(0);
    expect(ads.y + sight).toBeGreaterThan(-0.03);
    vm.dispose();
  });

  it('hidden while a scope fills the screen / downed; nothing for an empty hand', () => {
    const vm = new ViewModel();
    vm.update(1 / 60, vmInput({ weaponId: 'qilin', ads: true, hidden: true }));
    expect(vm.visible).toBe(false);
    vm.update(1 / 60, vmInput({ weaponId: null }));
    expect(vm.visible).toBe(false);
    vm.dispose();
  });

  it('sprint lowers it, a shot kicks it back and up, a weapon switch raises it from below', () => {
    const vm = new ViewModel();
    for (let i = 0; i < 60; i++) vm.update(1 / 60, vmInput());
    const rest = { ...vm.currentPose };
    for (let i = 0; i < 40; i++) vm.update(1 / 60, vmInput({ sprinting: true, speed: 7 }));
    expect(vm.currentPose.pitch).toBeLessThan(rest.pitch - 0.15);
    for (let i = 0; i < 60; i++) vm.update(1 / 60, vmInput());
    vm.fire(2);
    vm.update(1 / 60, vmInput());
    expect(vm.currentPose.z).toBeGreaterThan(rest.z + 0.01);
    expect(vm.currentPose.pitch).toBeGreaterThan(rest.pitch + 0.02);
    for (let i = 0; i < 60; i++) vm.update(1 / 60, vmInput());
    vm.update(1 / 60, vmInput({ weaponId: 'pistol' }));
    expect(vm.hold).toBe('pistol');
    expect(vm.currentPose.y).toBeLessThan(HIP_POSE.pistol.y - 0.1);
    vm.dispose();
  });

  it('akimbo, bow and polearm holds', () => {
    const vm = new ViewModel();
    vm.update(1 / 60, vmInput({ weaponId: 'cixiong' }));
    expect(vm.hold).toBe('akimbo');
    vm.update(1 / 60, vmInput({ weaponId: 'liegong' }));
    expect(vm.hold).toBe('bow');
    vm.update(1 / 60, vmInput({ weaponId: 'taiping' }));
    expect(vm.hold).toBe('pole');
    // aiming draws the bow in toward the centre
    expect(Math.abs(adsPose('bow', 0).x)).toBeLessThan(Math.abs(HIP_POSE.bow.x) * 0.6);
    vm.dispose();
  });

  it('muzzle flash point: projects where the viewmodel muzzle is drawn', () => {
    const vm = new ViewModel();
    vm.setAspect(16 / 9);
    const main = new THREE.PerspectiveCamera(80, 16 / 9, 0.1, 500);
    main.position.set(10, 2, -4);
    main.quaternion.copy(lookQuat(0.7, 0.2));
    main.updateMatrixWorld();
    for (let i = 0; i < 30; i++) vm.update(1 / 60, vmInput({ cameraQuat: main.quaternion }));
    const out = new THREE.Vector3();
    expect(vm.muzzleWorld(main, out)).toBe(true);
    const onScreen = out.clone().project(main);
    // the same point through the viewmodel camera
    const info = buildProceduralWeapon('carbine').info;
    const scene = vm.scene;
    let weapon: THREE.Object3D | undefined;
    scene.traverse((o) => {
      if (o.name === 'weapon_carbine') weapon = o;
    });
    expect(weapon).toBeTruthy();
    weapon!.updateWorldMatrix(true, false);
    const vmp = info.muzzle.clone().applyMatrix4(weapon!.matrixWorld).project(vm.camera);
    expect(onScreen.x).toBeCloseTo(vmp.x, 4);
    expect(onScreen.y).toBeCloseTo(vmp.y, 4);
    // in front of the world camera, lower right of the crosshair
    expect(out.distanceTo(main.position)).toBeGreaterThan(0.3);
    expect(onScreen.x).toBeGreaterThan(0);
    expect(onScreen.y).toBeLessThan(0);
    vm.dispose();
  });

  it('hands for every hold (none: empty), coloured from the hero', () => {
    const c = handColorsOf('guanyu');
    for (const hold of ['rifle', 'hip', 'launcher', 'pistol', 'akimbo', 'bow', 'pole', 'sword'] as const) {
      const g = buildHands(hold, new THREE.Vector3(-0.02, -0.01, -0.42), c);
      expect(g.getAttribute('position').count, hold).toBeGreaterThan(50);
    }
    expect(buildHands('none', null, c).getAttribute('position')?.count ?? 0).toBe(0);
    // the sight line of the procedural carbine: its sight rail top (0.135 m)
    expect(sightHeight(buildProceduralWeapon('carbine').mesh.geometry)).toBeCloseTo(0.135, 2);
  });
});

describe('input: first person', () => {
  it('frames carry BTN_FIRST_PERSON in first person, also while input is disabled (a view, not a control)', () => {
    const s = new InputState();
    s.firstPerson = true;
    s.setMouseButton('fire', true);
    expect(s.frame().buttons).toBe(BTN_FIRE | BTN_FIRST_PERSON);
    s.enabled = false;
    expect(s.frame().buttons).toBe(BTN_FIRST_PERSON);
    s.firstPerson = false;
    expect(s.frame().buttons).toBe(0);
    expect(shouldSuppressKey(CAMERA_TOGGLE_KEY, { ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
  });

  describe('toggle key', () => {
    class FakeTarget {
      private readonly ls = new Map<string, Set<(e: unknown) => void>>();
      addEventListener(t: string, fn: (e: unknown) => void): void {
        if (!this.ls.has(t)) this.ls.set(t, new Set());
        this.ls.get(t)!.add(fn);
      }
      removeEventListener(t: string, fn: (e: unknown) => void): void {
        this.ls.get(t)?.delete(fn);
      }
      emit(t: string, e: unknown): void {
        for (const fn of this.ls.get(t) ?? []) fn(e);
      }
    }
    const key = (code: string, repeat = false) => ({ code, ctrlKey: false, altKey: false, metaKey: false, repeat, target: null, preventDefault() {} });
    let win: FakeTarget;
    const saved = settings.get().cameraView;
    beforeEach(() => {
      win = new FakeTarget();
      vi.stubGlobal('window', win);
      vi.stubGlobal('document', Object.assign(new FakeTarget(), { hidden: false, pointerLockElement: null, fullscreenElement: null, exitPointerLock: () => undefined }));
      settings.update({ cameraView: 'auto' });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      settings.update({ cameraView: saved });
    });

    it('flips first ↔ third person and saves it; touch controls start in third person', () => {
      const ic = new InputController(new FakeTarget() as unknown as HTMLElement);
      expect(ic.view).toBe('first');
      win.emit('keydown', key(CAMERA_TOGGLE_KEY));
      win.emit('keydown', key(CAMERA_TOGGLE_KEY, true)); // auto-repeat: ignored
      expect(ic.view).toBe('third');
      expect(settings.get().cameraView).toBe('third');
      win.emit('keyup', key(CAMERA_TOGGLE_KEY));
      win.emit('keydown', key(CAMERA_TOGGLE_KEY));
      expect(ic.view).toBe('first');
      settings.update({ cameraView: 'auto' });
      ic.setTouchMode(true);
      expect(ic.view).toBe('third');
      // the sampled frame says so to the host
      const r = { pick: () => ({ aimPoint: { x: 0, y: 0, z: 0 } }) };
      expect(ic.sample(r).buttons & BTN_FIRST_PERSON).toBe(0);
      ic.setTouchMode(false);
      expect(ic.sample(r).buttons & BTN_FIRST_PERSON).toBe(BTN_FIRST_PERSON);
      ic.dispose();
    });

    it('a forced view (dev harness) flips without touching the saved setting', () => {
      const ic = new InputController(new FakeTarget() as unknown as HTMLElement, { view: 'third' });
      expect(ic.view).toBe('third');
      win.emit('keydown', key(CAMERA_TOGGLE_KEY));
      expect(ic.view).toBe('first');
      expect(settings.get().cameraView).toBe('auto');
      ic.dispose();
    });
  });
});
