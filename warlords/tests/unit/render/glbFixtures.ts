// Test fixtures for the GLB loaders: in-memory binary glTF files (data: URLs)
// that the real GLTFLoader parses in Node, and the one DOM class it needs there.
import * as THREE from 'three';

// three's FileLoader reports progress with the DOM ProgressEvent (absent from Node)
const globals = globalThis as { ProgressEvent?: unknown };
globals.ProgressEvent ??= class extends Event {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
  constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
    super(type);
    this.lengthComputable = !!init.lengthComputable;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
};


/** Binary glTF of one box mesh (w × h × d at `lift` above the origin), optionally with UVs; as a data: URL. */
export function boxGlbUrl(w: number, h: number, d: number, lift = 0, uvs = true): string {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, lift + h / 2, 0);
  const pos = new Float32Array(g.getAttribute('position').array);
  const uv = new Float32Array(g.getAttribute('uv').array);
  const idx = new Uint16Array(g.getIndex()!.array);
  const box = new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
  const views = [pos, ...(uvs ? [uv] : []), idx];
  let off = 0;
  const bufferViews = views.map((a) => {
    const v = { buffer: 0, byteOffset: off, byteLength: a.byteLength };
    off += a.byteLength;
    return v;
  });
  const bin = Buffer.concat(views.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const attributes: Record<string, number> = { POSITION: 0 };
  const accessors: object[] = [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: box.min.toArray(), max: box.max.toArray() }];
  if (uvs) {
    attributes.TEXCOORD_0 = 1;
    accessors.push({ bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' });
  }
  accessors.push({ bufferView: bufferViews.length - 1, componentType: 5123, count: idx.length, type: 'SCALAR' });
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: accessors.length - 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const binBuf = bin.length % 4 ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]) : bin;
  const chunk = (buf: Buffer, type: number): Buffer => {
    const h2 = Buffer.alloc(8);
    h2.writeUInt32LE(buf.length, 0);
    h2.writeUInt32LE(type, 4);
    return Buffer.concat([h2, buf]);
  };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const all = Buffer.concat([header, chunk(jsonBuf, 0x4e4f534a), chunk(binBuf, 0x004e4942)]);
  return `data:model/gltf-binary;base64,${all.toString('base64')}`;
}
