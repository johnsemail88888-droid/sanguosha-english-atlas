// Top-down SVG preview of a generated map (height shading, water, props via
// their colliders, spawns, camps, loot/crates, regions). Used by
// preview.test.ts to write docs/map-preview.svg; Node-only (zlib for the PNG
// heightmap that is embedded into the SVG).
import { deflateSync } from 'node:zlib';
import type { MapData, MapProp, PropType } from '../../../src/core/map';
import { terrainHeight } from '../../../src/core/map';
import { NAV_MAIN, NAV_WATER, type NavGrid } from '../../../src/sim/map/nav';
import { propColliders } from '../../../src/sim/map/props';

// ── tiny PNG encoder ─────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGB pixels (w*h*3) as a PNG. */
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ── height shading ───────────────────────────────────────────────────────────
function ramp(h: number, wl: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [wl, [196, 186, 140]],
    [wl + 1.5, [150, 170, 102]],
    [8, [120, 156, 86]],
    [13, [104, 138, 76]],
    [18, [132, 128, 88]],
    [24, [150, 136, 110]],
    [34, [138, 128, 116]],
    [60, [176, 170, 162]],
  ];
  if (h <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (h <= stops[i][0]) {
      const [h0, c0] = stops[i - 1];
      const [h1, c1] = stops[i];
      const t = (h - h0) / (h1 - h0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

export function heightPng(map: MapData, px: number, nav?: NavGrid): Buffer {
  const rgb = new Uint8Array(px * px * 3);
  const half = map.size / 2;
  const m = map.size / px;
  for (let j = 0; j < px; j++) {
    const z = -half + (j + 0.5) * m;
    for (let i = 0; i < px; i++) {
      const x = -half + (i + 0.5) * m;
      const h = terrainHeight(map, x, z);
      const gx = terrainHeight(map, x + 1, z) - terrainHeight(map, x - 1, z);
      const gz = terrainHeight(map, x, z + 1) - terrainHeight(map, x, z - 1);
      // light from the north-west
      const shade = Math.max(0.45, Math.min(1.25, 1 + (gx + gz) * -0.18));
      let c: [number, number, number];
      if (h < map.waterLevel) {
        const d = Math.min(1, (map.waterLevel - h) / 1.5);
        c = [70 - 30 * d, 130 - 30 * d, 170 - 10 * d];
      } else {
        const r = ramp(h, map.waterLevel);
        c = [r[0] * shade, r[1] * shade, r[2] * shade];
        // contour every 2 m
        if (Math.abs(((h + 100) % 2) - 1) > 0.94) c = [c[0] * 0.88, c[1] * 0.88, c[2] * 0.88];
      }
      if (nav) {
        const col = Math.floor((x - nav.origin) / nav.cellSize);
        const row = Math.floor((z - nav.origin) / nav.cellSize);
        const base = (row * nav.cols + col) * nav.layers;
        let main = false;
        let any = false;
        for (let l = 0; l < nav.layers; l++) {
          if (Number.isNaN(nav.height[base + l])) break;
          any = true;
          if (nav.flags[base + l] & NAV_MAIN) main = true;
        }
        if (!any) c = [c[0] * 0.55 + 90, c[1] * 0.55, c[2] * 0.55];
        else if (!main) c = [c[0] * 0.6 + 100, c[1] * 0.6 + 40, c[2] * 0.6 + 100];
      }
      const k = (j * px + i) * 3;
      rgb[k] = Math.max(0, Math.min(255, c[0]));
      rgb[k + 1] = Math.max(0, Math.min(255, c[1]));
      rgb[k + 2] = Math.max(0, Math.min(255, c[2]));
    }
  }
  return encodePng(px, px, rgb);
}

// ── SVG ──────────────────────────────────────────────────────────────────────
const PROP_STYLE: Partial<Record<PropType, { fill: string; stroke: string }>> = {
  wall: { fill: '#8d8478', stroke: '#3b352e' },
  gateTower: { fill: '#b23a2a', stroke: '#4a1a12' },
  palace: { fill: '#c9a227', stroke: '#5a4510' },
  house: { fill: '#d8d0c0', stroke: '#5b5040' },
  pavilion: { fill: '#c0392b', stroke: '#5a1a12' },
  watchtower: { fill: '#a0522d', stroke: '#3a1a0a' },
  tent: { fill: '#e8dcc0', stroke: '#6b5a3a' },
  barricade: { fill: '#9a8a60', stroke: '#4a3a20' },
  crateStack: { fill: '#b08040', stroke: '#4a3010' },
  rock: { fill: '#7d7d80', stroke: '#3a3a3c' },
  tree: { fill: '#2f6b2f', stroke: '#1a3a1a' },
  pine: { fill: '#1f4f3a', stroke: '#0f2a1f' },
  bamboo: { fill: '#5aa048', stroke: '#2a5020' },
  bridge: { fill: '#b89a70', stroke: '#4a3a20' },
  dock: { fill: '#a0784a', stroke: '#4a3010' },
  ship: { fill: '#6a4a2a', stroke: '#2a1a0a' },
  statue: { fill: '#9a9a9a', stroke: '#3a3a3a' },
  banner: { fill: '#c0392b', stroke: '#5a1a12' },
  brazier: { fill: '#ff8a20', stroke: '#6a2a00' },
  ruin: { fill: '#9a9080', stroke: '#4a4030' },
  stairs: { fill: '#c8b89a', stroke: '#6a5a3a' },
};

const f1 = (v: number): string => (Math.round(v * 10) / 10).toString();

function propSvg(p: MapProp): string {
  const st = PROP_STYLE[p.type];
  if (p.type === 'farmField') {
    const c = Math.cos(p.rot);
    const s = Math.sin(p.rot);
    const pts = [
      [-p.sx / 2, -p.sz / 2],
      [p.sx / 2, -p.sz / 2],
      [p.sx / 2, p.sz / 2],
      [-p.sx / 2, p.sz / 2],
    ].map(([lx, lz]) => `${f1(p.x + lx * c + lz * s)},${f1(p.z - lx * s + lz * c)}`);
    const fill = p.variant === 1 ? '#8fb8a0' : p.variant === 2 ? '#9ab860' : '#d8c060';
    return `<polygon points="${pts.join(' ')}" fill="${fill}" fill-opacity="0.75" stroke="#7a6a30" stroke-width="0.3" stroke-dasharray="1 1"/>`;
  }
  if (!st) return '';
  let out = '';
  if (p.type === 'tree' || p.type === 'pine' || p.type === 'bamboo') {
    out += `<circle cx="${f1(p.x)}" cy="${f1(p.z)}" r="${f1(p.sx / 2)}" fill="${st.fill}" fill-opacity="0.55" stroke="${st.stroke}" stroke-width="0.2"/>`;
  }
  const fill = p.color && (p.type === 'banner' || p.type === 'tent' || p.type === 'ship' || p.type === 'rock') ? p.color : st.fill;
  for (const c of propColliders(p)) {
    if (c.kind === 'cyl') {
      out += `<circle cx="${f1(c.x)}" cy="${f1(c.z)}" r="${f1(Math.max(c.r, 0.25))}" fill="${fill}" stroke="${st.stroke}" stroke-width="0.15"/>`;
    } else {
      const cs = Math.cos(c.rot);
      const sn = Math.sin(c.rot);
      const pts = [
        [-c.hx, -c.hz],
        [c.hx, -c.hz],
        [c.hx, c.hz],
        [-c.hx, c.hz],
      ].map(([lx, lz]) => `${f1(c.cx + lx * cs + lz * sn)},${f1(c.cz - lx * sn + lz * cs)}`);
      out += `<polygon points="${pts.join(' ')}" fill="${fill}" fill-opacity="${p.type === 'stairs' ? 0.5 : 0.9}" stroke="${st.stroke}" stroke-width="0.15"/>`;
    }
  }
  return out;
}

export interface PreviewOptions {
  nav?: NavGrid;
  title?: string;
  /** heightmap pixels per side */
  px?: number;
  paths?: { x: number; z: number }[][];
}

export function mapSvg(map: MapData, opts: PreviewOptions = {}): string {
  const half = map.size / 2;
  const png = heightPng(map, opts.px ?? 960, opts.nav).toString('base64');
  const parts: string[] = [];
  const W = 1100;
  // frame: 22 m title band above the map, 14 m legend band below it
  const vbH = map.size + 36;
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round((W * vbH) / (map.size + 20))}" viewBox="${-half - 10} ${-half - 22} ${map.size + 20} ${vbH}" font-family="'WenQuanYi Zen Hei','Noto Sans CJK SC','Microsoft YaHei',sans-serif">`,
  );
  parts.push(`<rect x="${-half - 10}" y="${-half - 22}" width="${map.size + 20}" height="${vbH}" fill="#1c1a17"/>`);
  parts.push(`<image href="data:image/png;base64,${png}" x="${-half}" y="${-half}" width="${map.size}" height="${map.size}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`);
  // props: flat things first, then solids, then vegetation on top
  const order: PropType[] = ['farmField', 'dock', 'bridge', 'stairs', 'wall', 'gateTower', 'palace', 'house', 'watchtower', 'pavilion', 'tent', 'ship', 'ruin', 'barricade', 'crateStack', 'statue', 'rock', 'brazier', 'banner', 'bamboo', 'tree', 'pine'];
  for (const t of order) for (const p of map.props) if (p.type === t) parts.push(propSvg(p));
  // regions
  for (const r of map.regions) {
    parts.push(`<circle cx="${f1(r.center.x)}" cy="${f1(r.center.z)}" r="${r.radius}" fill="none" stroke="#fff4c8" stroke-width="0.5" stroke-dasharray="3 2" opacity="0.8"/>`);
    const ty = r.center.z - r.radius + 7;
    parts.push(`<text x="${f1(r.center.x)}" y="${f1(ty)}" text-anchor="middle" font-size="6" fill="#fff8e0" stroke="#1c1a17" stroke-width="0.9" paint-order="stroke">${r.nameZh}</text>`);
    parts.push(`<text x="${f1(r.center.x)}" y="${f1(ty + 4.2)}" text-anchor="middle" font-size="3.2" fill="#fff8e0" stroke="#1c1a17" stroke-width="0.6" paint-order="stroke">${r.nameEn}</text>`);
  }
  // paths
  for (const path of opts.paths ?? []) {
    parts.push(`<polyline points="${path.map((p) => `${f1(p.x)},${f1(p.z)}`).join(' ')}" fill="none" stroke="#00e5ff" stroke-width="0.6" opacity="0.9"/>`);
  }
  // loot + crates
  for (const l of map.lootSpots) parts.push(`<circle cx="${f1(l.x)}" cy="${f1(l.z)}" r="1" fill="#ffe14a" stroke="#3a3000" stroke-width="0.3"/>`);
  for (const c of map.crateSpots) {
    const s = c.tier === 2 ? 2.6 : 1.9;
    const fill = c.tier === 2 ? '#d88a2a' : '#8a5a2a';
    parts.push(`<rect x="${f1(c.pos.x - s / 2)}" y="${f1(c.pos.z - s / 2)}" width="${s}" height="${s}" fill="${fill}" stroke="#fff0c0" stroke-width="${c.tier === 2 ? 0.6 : 0.3}"/>`);
  }
  // camps
  for (const c of map.camps) {
    const col = c.npcType === 'barbarian' ? '#a0522d' : '#e0b020';
    parts.push(`<circle cx="${f1(c.pos.x)}" cy="${f1(c.pos.z)}" r="9" fill="${col}" fill-opacity="0.18" stroke="${col}" stroke-width="0.8"/>`);
    parts.push(`<text x="${f1(c.pos.x)}" y="${f1(c.pos.z + 13)}" text-anchor="middle" font-size="3.6" fill="${col}" stroke="#1c1a17" stroke-width="0.6" paint-order="stroke">${c.npcType === 'barbarian' ? '南蛮 ×' : '黄巾 ×'}${c.count}</text>`);
  }
  // spawns
  map.spawns.forEach((s, i) => {
    parts.push(`<circle cx="${f1(s.x)}" cy="${f1(s.z)}" r="3" fill="#2e8bff" stroke="#fff" stroke-width="0.6"/>`);
    parts.push(`<text x="${f1(s.x)}" y="${f1(s.z + 1.3)}" text-anchor="middle" font-size="3.6" font-weight="bold" fill="#fff">${i + 1}</text>`);
  });
  const L = map.lordSpawn;
  const star = Array.from({ length: 10 }, (_, k) => {
    const a = (k * Math.PI) / 5 - Math.PI / 2;
    const r = k % 2 === 0 ? 4 : 1.8;
    return `${f1(L.x + Math.cos(a) * r)},${f1(L.z + Math.sin(a) * r)}`;
  }).join(' ');
  parts.push(`<polygon points="${star}" fill="#ffd700" stroke="#5a3a00" stroke-width="0.5"/>`);
  // frame, title, compass, scale, legend
  parts.push(`<rect x="${-half}" y="${-half}" width="${map.size}" height="${map.size}" fill="none" stroke="#c9a227" stroke-width="0.8"/>`);
  parts.push(`<text x="${-half}" y="${-half - 8}" font-size="8" fill="#f0e0b0">${map.nameZh} <tspan font-size="5">${map.nameEn} · seed ${map.seed}${opts.title ? ' · ' + opts.title : ''}</tspan></text>`);
  parts.push(`<text x="${half}" y="${-half - 8}" text-anchor="end" font-size="4" fill="#d8c8a0">props ${map.props.length} · colliders ${map.colliders.length} · spawns ${map.spawns.length} · loot ${map.lootSpots.length} · crates ${map.crateSpots.length}</text>`);
  parts.push(
    `<g transform="translate(${half - 13},${-half + 14})"><circle r="9" fill="#1c1a17" fill-opacity="0.75" stroke="#c9a227" stroke-width="0.5"/><polygon points="0,-7 2.6,1.5 0,0 -2.6,1.5" fill="#f0e0b0"/><text y="6.3" text-anchor="middle" font-size="3.6" font-weight="bold" fill="#f0e0b0">N 北</text></g>`,
  );
  parts.push(`<g transform="translate(${-half + 8},${half - 8})"><rect width="50" height="1.6" fill="#fff"/><rect width="25" height="1.6" fill="#1c1a17"/><text y="-1.5" font-size="3.4" fill="#fff" stroke="#1c1a17" stroke-width="0.5" paint-order="stroke">50 m</text></g>`);
  const legend: [string, string][] = [
    ['#ffd700', '主公 lord spawn'],
    ['#2e8bff', 'spawn'],
    ['#d88a2a', 'crate T2'],
    ['#8a5a2a', 'crate T1'],
    ['#ffe14a', 'loot'],
  ];
  // legend: one row in the band under the map (keeps the map itself unobstructed)
  const ly = half + 8.5;
  legend.forEach(([c, t], i) => {
    const x = -half + i * 44;
    parts.push(`<rect x="${x}" y="${ly - 3}" width="3.4" height="3.4" fill="${c}" stroke="#fff" stroke-width="0.3"/><text x="${x + 5}" y="${ly}" font-size="3.6" fill="#fff">${t}</text>`);
  });
  if (opts.nav) {
    parts.push(`<text x="${half}" y="${ly}" text-anchor="end" font-size="3" fill="#fff">red: not walkable · purple: walkable, unreachable</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** Nav stats helper for debugging. */
export function navStats(nav: NavGrid): { nodes: number; main: number; water: number; multi: number } {
  let nodes = 0;
  let main = 0;
  let water = 0;
  let multi = 0;
  for (let c = 0; c < nav.cols * nav.rows; c++) {
    let k = 0;
    for (let l = 0; l < nav.layers; l++) {
      const i = c * nav.layers + l;
      if (Number.isNaN(nav.height[i])) break;
      k++;
      nodes++;
      if (nav.flags[i] & NAV_MAIN) main++;
      if (nav.flags[i] & NAV_WATER) water++;
    }
    if (k > 1) multi++;
  }
  return { nodes, main, water, multi };
}
