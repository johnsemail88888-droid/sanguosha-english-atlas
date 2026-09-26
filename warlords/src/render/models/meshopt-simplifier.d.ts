// Typings for three's bundled meshoptimizer simplifier (no @types entry).
declare module 'three/addons/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    supported: boolean;
    simplify(
      indices: Uint32Array | Uint16Array,
      vertexPositions: Float32Array,
      vertexPositionsStride: number,
      targetIndexCount: number,
      targetError: number,
      flags?: string[],
    ): [Uint32Array, number];
  };
}
