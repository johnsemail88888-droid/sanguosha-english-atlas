// Draw-distance culling of static world meshes (terrain and prop chunks).
// The camera's far plane stretches to keep far heroes on screen (renderer
// updateFarPlane: up to HERO_VIEW_RANGE, 430 m), which also stretched the
// frustum culling of the world behind them — while the sky-matched fog has
// already dissolved everything beyond the tier's draw distance. Meshes whose
// bounding sphere lies entirely deeper than the draw distance along the view
// direction are hidden (view depth, like the fog — not radial distance, which
// would drop half-visible chunks at the screen edges).
import * as THREE from 'three';

interface Item {
  obj: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  r: number;
}

const _s = new THREE.Sphere();

export class DepthCuller {
  private readonly items: Item[] = [];

  get size(): number {
    return this.items.length;
  }

  /** Track a static mesh (its world matrix must be final). */
  add(mesh: THREE.Mesh): void {
    const g = mesh.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingSphere) return;
    mesh.updateWorldMatrix(true, false);
    _s.copy(g.boundingSphere).applyMatrix4(mesh.matrixWorld);
    this.items.push({ obj: mesh, x: _s.center.x, y: _s.center.y, z: _s.center.z, r: _s.radius });
  }

  /**
   * Show the tracked meshes within `maxDist` (m) of view depth from `camera`,
   * hide the rest. Infinity shows every one.
   */
  update(camera: THREE.Camera, maxDist: number): void {
    const e = camera.matrixWorld.elements;
    // forward = −(e8, e9, e10)
    let fx = -e[8];
    let fy = -e[9];
    let fz = -e[10];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const cx = e[12];
    const cy = e[13];
    const cz = e[14];
    for (const it of this.items) {
      const depth = (it.x - cx) * fx + (it.y - cy) * fy + (it.z - cz) * fz;
      it.obj.visible = depth - it.r <= maxDist;
    }
  }

  clear(): void {
    this.items.length = 0;
  }
}
