// Warm late-afternoon sun (the ONE shadow-casting light, following the local
// player) + hemisphere fill.
import * as THREE from 'three';

/** Direction TO the sun: late afternoon, low in the west-south-west. */
export const SUN_DIR = new THREE.Vector3(-0.72, 0.5, 0.42).normalize();

export class SceneLights {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private extent = 40;
  private mapSize = 1024;
  private readonly tmp = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.sun = new THREE.DirectionalLight('#ffe2b0', 2.7);
    this.sun.castShadow = false;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.5;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 400;
    this.sun.shadow.intensity = 0.85;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight('#bcd0e0', '#6a5638', 1.35);
    scene.add(this.hemi);
  }

  setShadows(enabled: boolean, mapSize: number, extent: number): void {
    this.sun.castShadow = enabled;
    this.extent = extent;
    if (this.mapSize !== mapSize) {
      this.mapSize = mapSize;
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();
  }

  /**
   * Centre the shadow frustum on `focus` (usually the local hero). The centre
   * is snapped to shadow-map texels in light space to avoid shimmering.
   */
  follow(focus: THREE.Vector3): void {
    const texel = (this.extent * 2) / this.mapSize;
    // light-space basis
    const dir = SUN_DIR;
    const right = this.tmp.set(0, 1, 0).cross(dir).normalize();
    const up = this.tmpUp.crossVectors(dir, right).normalize();
    const r = Math.round(focus.dot(right) / texel) * texel;
    const u = Math.round(focus.dot(up) / texel) * texel;
    const d = focus.dot(dir);
    const centre = this.tmpC.set(0, 0, 0).addScaledVector(right, r).addScaledVector(up, u).addScaledVector(dir, d);
    this.sun.target.position.copy(centre);
    this.sun.position.copy(centre).addScaledVector(dir, 180);
    this.sun.target.updateMatrixWorld();
  }
}
