// Minimap + big map drawing (canvas 2D). Terrain (heights, water, prop
// footprints, contours, hill shading) is rendered once per MapData and cached.
import type { MapData, MapProp, PropType } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { EntityId, PrivateHeroView, RoleId, ViewEntity, ZoneView } from '../../core/types';
import { VF_DEAD, VF_EXPOSED, VF_LORD, VF_MARKED, VF_OPENED, VF_STEALTH } from '../../core/types';
import { roleColor } from '../theme';

export const TERRAIN_RES = 512;

/** Height → base RGB (water handled separately). Exported for tests. */
export function terrainRgb(height: number, waterLevel: number, maxH: number): [number, number, number] {
  if (height < waterLevel) {
    const depth = Math.min(1, (waterLevel - height) / 4);
    return [Math.round(70 - depth * 25), Math.round(112 - depth * 30), Math.round(138 - depth * 25)];
  }
  const t = maxH > 0 ? Math.max(0, Math.min(1, (height - waterLevel) / Math.max(1, maxH - waterLevel))) : 0;
  // lowland green → olive → umber → pale rock
  const stops: [number, [number, number, number]][] = [
    [0, [104, 128, 72]],
    [0.35, [128, 130, 80]],
    [0.65, [138, 112, 76]],
    [1, [178, 168, 146]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0 || 1);
      return [Math.round(c0[0] + (c1[0] - c0[0]) * k), Math.round(c0[1] + (c1[1] - c0[1]) * k), Math.round(c0[2] + (c1[2] - c0[2]) * k)];
    }
  }
  return stops[stops.length - 1][1];
}

const PROP_STYLE: Partial<Record<PropType, { fill: string; round?: boolean; min?: number }>> = {
  wall: { fill: '#3e342c', min: 1.5 },
  gateTower: { fill: '#7a2a1c' },
  palace: { fill: '#8e2c1c' },
  house: { fill: '#5e5046' },
  pavilion: { fill: '#8a3a26' },
  watchtower: { fill: '#6a3a24' },
  tent: { fill: '#c9b98f' },
  barricade: { fill: '#5a4028', min: 1 },
  crateStack: { fill: '#7a5a32' },
  rock: { fill: '#6c6a64', round: true },
  tree: { fill: '#2e4a24', round: true, min: 2.5 },
  pine: { fill: '#24401f', round: true, min: 2.5 },
  bamboo: { fill: '#46742e', round: true, min: 2.5 },
  bridge: { fill: '#8a6a44' },
  dock: { fill: '#7a5a3a' },
  ship: { fill: '#5a3a22' },
  statue: { fill: '#8a8478', round: true },
  banner: { fill: '#b8322a', round: true, min: 1 },
  brazier: { fill: '#e07a2a', round: true, min: 1.2 },
  ruin: { fill: '#766a5e' },
  farmField: { fill: 'rgba(176, 164, 84, 0.55)' },
  stairs: { fill: '#8a7a6a' },
};

const terrainCache = new WeakMap<MapData, HTMLCanvasElement>();

function drawProp(g: CanvasRenderingContext2D, p: MapProp, scale: number, half: number): void {
  const st = PROP_STYLE[p.type];
  if (!st) return;
  const x = (p.x + half) * scale;
  const y = (p.z + half) * scale;
  const min = (st.min ?? 1) * scale;
  g.fillStyle = st.fill;
  if (st.round) {
    const r = Math.max(min, (Math.max(p.sx, p.sz) / 2) * scale);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    return;
  }
  const w = Math.max(min, p.sx * scale);
  const hgt = Math.max(min, p.sz * scale);
  g.save();
  g.translate(x, y);
  g.rotate(-p.rot);
  g.fillRect(-w / 2, -hgt / 2, w, hgt);
  if (p.type === 'palace' || p.type === 'gateTower' || p.type === 'house' || p.type === 'pavilion') {
    g.strokeStyle = 'rgba(20, 12, 6, 0.6)';
    g.lineWidth = Math.max(0.5, scale * 0.4);
    g.strokeRect(-w / 2, -hgt / 2, w, hgt);
  }
  g.restore();
}

/** Pre-rendered top-down terrain for a map (cached per MapData object). */
export function terrainCanvas(map: MapData, doc: Document = document): HTMLCanvasElement {
  const cached = terrainCache.get(map);
  if (cached) return cached;
  const N = TERRAIN_RES;
  const c = doc.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d');
  if (!g) return c;
  const img = g.createImageData(N, N);
  const half = map.size / 2;
  const step = map.size / N;
  let maxH = -Infinity;
  for (let i = 0; i < map.heights.length; i++) if (map.heights[i] > maxH) maxH = map.heights[i];
  if (!Number.isFinite(maxH)) maxH = 0;
  const hs = new Float32Array(N * N);
  for (let py = 0; py < N; py++) {
    const z = -half + (py + 0.5) * step;
    for (let px = 0; px < N; px++) {
      const x = -half + (px + 0.5) * step;
      hs[py * N + px] = map.heights.length ? terrainHeight(map, x, z) : 0;
    }
  }
  const contour = 5;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const i = py * N + px;
      const hgt = hs[i];
      const [r, gg, b] = terrainRgb(hgt, map.waterLevel, maxH);
      // hill shading: light from the north-west
      const hl = hs[py * N + Math.max(0, px - 1)];
      const hr = hs[py * N + Math.min(N - 1, px + 1)];
      const hu = hs[Math.max(0, py - 1) * N + px];
      const hd = hs[Math.min(N - 1, py + 1) * N + px];
      const shade = Math.max(-0.35, Math.min(0.35, ((hl - hr) + (hu - hd)) * 0.35));
      let k = 1 + shade;
      // contour lines
      if (hgt >= map.waterLevel && Math.floor(hgt / contour) !== Math.floor(hr / contour)) k *= 0.82;
      else if (hgt >= map.waterLevel && Math.floor(hgt / contour) !== Math.floor(hd / contour)) k *= 0.82;
      // shoreline
      if ((hgt < map.waterLevel) !== (hr < map.waterLevel) || (hgt < map.waterLevel) !== (hd < map.waterLevel)) k *= 0.7;
      const o = i * 4;
      img.data[o] = Math.max(0, Math.min(255, r * k));
      img.data[o + 1] = Math.max(0, Math.min(255, gg * k));
      img.data[o + 2] = Math.max(0, Math.min(255, b * k));
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const scale = N / map.size;
  // draw big footprints last so trees do not cover buildings
  const order: PropType[] = ['farmField', 'tree', 'pine', 'bamboo', 'rock', 'ruin', 'bridge', 'dock', 'ship', 'stairs', 'barricade', 'crateStack', 'tent', 'house', 'pavilion', 'watchtower', 'statue', 'banner', 'brazier', 'wall', 'gateTower', 'palace'];
  const rank = new Map(order.map((t, i) => [t, i]));
  const props = [...map.props].sort((a, b) => (rank.get(a.type) ?? 0) - (rank.get(b.type) ?? 0));
  for (const p of props) drawProp(g, p, scale, half);
  // faint grid (100 m)
  g.strokeStyle = 'rgba(30, 20, 10, 0.12)';
  g.lineWidth = 1;
  for (let m = -half + 50; m < half; m += 50) {
    const v = (m + half) * scale;
    g.beginPath();
    g.moveTo(v, 0);
    g.lineTo(v, N);
    g.moveTo(0, v);
    g.lineTo(N, v);
    g.stroke();
  }
  terrainCache.set(map, c);
  return c;
}

export interface MarkerInput {
  me: PrivateHeroView | null;
  /** whose position centres the minimap (you, or the spectate target) */
  focus: ViewEntity | undefined;
  ents: readonly ViewEntity[];
  zone: ZoneView;
  airdrops: ReadonlyMap<EntityId, { x: number; z: number; until: number }>;
  now: number;
  knownAllies: readonly EntityId[];
}

interface Transform {
  cx: number;
  cz: number;
  scale: number;
  size: number;
}

function toScreen(tf: Transform, x: number, z: number): [number, number] {
  return [tf.size / 2 + (x - tf.cx) * tf.scale, tf.size / 2 + (z - tf.cz) * tf.scale];
}

function drawZone(g: CanvasRenderingContext2D, tf: Transform, zone: ZoneView, px: number): void {
  const [zx, zy] = toScreen(tf, zone.center.x, zone.center.z);
  const r = zone.radius * tf.scale;
  // shade outside (even-odd)
  g.save();
  g.beginPath();
  g.rect(-10, -10, tf.size + 20, tf.size + 20);
  g.arc(zx, zy, Math.max(0, r), 0, Math.PI * 2, true);
  g.fillStyle = 'rgba(190, 40, 20, 0.22)';
  g.fill('evenodd');
  g.restore();
  g.beginPath();
  g.arc(zx, zy, Math.max(0, r), 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255, 120, 60, 0.95)';
  g.lineWidth = 2 * px;
  g.stroke();
  if (zone.targetRadius < zone.radius - 0.5) {
    const [tx, ty] = toScreen(tf, zone.targetCenter.x, zone.targetCenter.z);
    g.beginPath();
    g.arc(tx, ty, Math.max(0, zone.targetRadius * tf.scale), 0, Math.PI * 2);
    g.setLineDash([5 * px, 4 * px]);
    g.strokeStyle = 'rgba(255, 250, 235, 0.9)';
    g.lineWidth = 1.5 * px;
    g.stroke();
    g.setLineDash([]);
  }
}

/** Crown colours: the real / presumed Lord, and the 影武者 decoy (only the real Lord sees it). */
export const CROWN_GOLD = '#f2c14e';
export const CROWN_DECOY = '#c9d1dc';

/**
 * How a crowned hero is drawn for this viewer: 'decoy' when the viewer is the
 * real Lord and this crown is the Body Double; 'ally' when the viewer is the
 * Double and this is the real Lord; otherwise a plain crown.
 */
export function crownKind(viewerRole: RoleId | undefined, ent: Pick<ViewEntity, 'id' | 'role'>, knownAllies: ReadonlySet<EntityId>): 'plain' | 'decoy' | 'ally' {
  if (ent.role === 'double' || (viewerRole === 'lord' && knownAllies.has(ent.id))) return 'decoy';
  if (viewerRole === 'double' && knownAllies.has(ent.id)) return 'ally';
  return 'plain';
}

/** Whether a hero / troop should appear on the map for this viewer. */
export function isMapVisible(e: Pick<ViewEntity, 'flags'>, friendly: boolean): boolean {
  if (e.flags & VF_DEAD) return false;
  // stealthed enemies stay hidden unless a 'reveal' exposes them
  if (e.flags & VF_STEALTH && !friendly && !(e.flags & VF_EXPOSED)) return false;
  return true;
}

function drawCrown(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  g.beginPath();
  g.moveTo(x - s, y + s * 0.6);
  g.lineTo(x - s, y - s * 0.3);
  g.lineTo(x - s * 0.5, y + s * 0.1);
  g.lineTo(x, y - s * 0.7);
  g.lineTo(x + s * 0.5, y + s * 0.1);
  g.lineTo(x + s, y - s * 0.3);
  g.lineTo(x + s, y + s * 0.6);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.strokeStyle = '#2a1a06';
  g.lineWidth = Math.max(1, s * 0.22);
  g.stroke();
}

function drawArrow(g: CanvasRenderingContext2D, x: number, y: number, yaw: number, s: number, fill: string): void {
  // yaw 0 faces -Z = up on the map; yaw increases counter-clockwise
  g.save();
  g.translate(x, y);
  g.rotate(-yaw);
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s * 0.7, s * 0.8);
  g.lineTo(0, s * 0.4);
  g.lineTo(-s * 0.7, s * 0.8);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = '#1a1208';
  g.lineWidth = Math.max(1, s * 0.2);
  g.stroke();
  g.restore();
}

function drawAirdrop(g: CanvasRenderingContext2D, x: number, y: number, s: number, pulse: number): void {
  g.save();
  g.beginPath();
  g.arc(x, y, s * (1.3 + pulse * 0.6), 0, Math.PI * 2);
  g.strokeStyle = `rgba(255, 210, 90, ${0.7 - pulse * 0.5})`;
  g.lineWidth = Math.max(1, s * 0.25);
  g.stroke();
  g.fillStyle = '#f2c14e';
  g.strokeStyle = '#5a3a08';
  g.lineWidth = Math.max(1, s * 0.2);
  g.fillRect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2);
  g.strokeRect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2);
  g.restore();
}

function drawExposedRing(g: CanvasRenderingContext2D, x: number, y: number, s: number, pulse: number, px: number): void {
  g.beginPath();
  g.arc(x, y, s * (1 + pulse * 0.9), 0, Math.PI * 2);
  g.strokeStyle = `rgba(255, 70, 50, ${(0.9 - pulse * 0.8).toFixed(3)})`;
  g.lineWidth = 1.6 * px;
  g.stroke();
}

function drawMarkers(g: CanvasRenderingContext2D, tf: Transform, m: MarkerInput, px: number, big: boolean): void {
  const myId = m.me?.entityId;
  const myRole = m.me?.role;
  const squad = new Set(m.me?.squad.map((s) => s.id) ?? []);
  const allies = new Set(m.knownAllies);
  const inView = (sx: number, sy: number): boolean => sx > -20 && sy > -20 && sx < tf.size + 20 && sy < tf.size + 20;
  const pulse = (m.now % 1.2) / 1.2;
  // airdrops (events + entities)
  const drops = new Map(m.airdrops);
  for (const e of m.ents) if (e.kind === 'airdrop' && !(e.flags & VF_OPENED)) drops.set(e.id, { x: e.x, z: e.z, until: Infinity });
  for (const d of drops.values()) {
    if (d.until < m.now) continue;
    const [sx, sy] = toScreen(tf, d.x, d.z);
    if (inView(sx, sy)) drawAirdrop(g, sx, sy, (big ? 6 : 4.5) * px, pulse);
  }
  // squad
  for (const e of m.ents) {
    if (!squad.has(e.id) || e.flags & VF_DEAD) continue;
    const [sx, sy] = toScreen(tf, e.x, e.z);
    if (!inView(sx, sy)) continue;
    g.beginPath();
    g.arc(sx, sy, (big ? 3 : 2.4) * px, 0, Math.PI * 2);
    g.fillStyle = '#7fe09a';
    g.fill();
    g.strokeStyle = '#0e2a14';
    g.lineWidth = px;
    g.stroke();
  }
  // exposed enemy troops (观星 / 狼顾 / 鬼谋 reveals)
  for (const e of m.ents) {
    if ((e.kind !== 'troop' && e.kind !== 'npc') || squad.has(e.id) || !(e.flags & VF_EXPOSED) || !isMapVisible(e, false)) continue;
    const [sx, sy] = toScreen(tf, e.x, e.z);
    if (!inView(sx, sy)) continue;
    const r = (big ? 2.6 : 2.1) * px;
    drawExposedRing(g, sx, sy, r * 1.6, pulse, px * 0.7);
    g.beginPath();
    g.arc(sx, sy, r, 0, Math.PI * 2);
    g.fillStyle = '#e04a3a';
    g.fill();
  }
  // heroes worth showing: crowns, known roles, marked, known allies, exposed
  for (const e of m.ents) {
    if (e.kind !== 'hero' || e.id === myId) continue;
    const ally = allies.has(e.id);
    if (!isMapVisible(e, ally)) continue;
    const crown = !!(e.flags & VF_LORD);
    const role: RoleId | undefined = e.role;
    const marked = !!(e.flags & VF_MARKED);
    const exposed = !!(e.flags & VF_EXPOSED);
    if (!crown && !role && !marked && !ally && !exposed) continue;
    const [sx, sy] = toScreen(tf, e.x, e.z);
    if (!inView(sx, sy)) continue;
    if (exposed) drawExposedRing(g, sx, sy, (big ? 7 : 5.8) * px, pulse, px);
    if (crown) {
      const kind = crownKind(myRole, e, allies);
      const s = (big ? 6 : 5) * px;
      drawCrown(g, sx, sy, s, kind === 'decoy' ? CROWN_DECOY : CROWN_GOLD);
      if (kind !== 'plain') {
        // decoy: a silver crown with a 影 badge; ally: a green halo around the real Lord
        g.beginPath();
        g.arc(sx, sy, s * 1.45, 0, Math.PI * 2);
        g.strokeStyle = kind === 'decoy' ? 'rgba(210, 220, 235, 0.95)' : '#7fe09a';
        g.lineWidth = 1.3 * px;
        g.stroke();
        if (kind === 'decoy' && big) {
          g.font = `900 ${Math.round(s * 1.3)}px "STKaiti","KaiTi","Kaiti SC",serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.lineWidth = 2.5 * px;
          g.strokeStyle = 'rgba(20, 12, 6, 0.9)';
          g.strokeText('影', sx + s * 1.7, sy - s * 1.2);
          g.fillStyle = '#e6ecf5';
          g.fillText('影', sx + s * 1.7, sy - s * 1.2);
        }
      }
    } else {
      g.beginPath();
      g.arc(sx, sy, (big ? 4.5 : 3.6) * px, 0, Math.PI * 2);
      g.fillStyle = role ? roleColor(role) : ally ? CROWN_GOLD : '#e04a3a';
      g.fill();
      g.strokeStyle = '#140c06';
      g.lineWidth = 1.2 * px;
      g.stroke();
    }
    if (marked) {
      g.beginPath();
      g.arc(sx, sy, (big ? 8 : 6.5) * px, 0, Math.PI * 2);
      g.strokeStyle = '#ff4a3a';
      g.lineWidth = 1.5 * px;
      g.stroke();
    }
  }
  // focus (you / spectated)
  const f = m.focus;
  if (f) {
    const [sx, sy] = toScreen(tf, f.x, f.z);
    drawArrow(g, sx, sy, f.yaw, (big ? 8 : 7) * px, f.id === myId ? '#fff4c8' : '#9fd0ff');
  }
}

/** Draw the player-centred round minimap. */
export function drawMinimap(canvas: HTMLCanvasElement, map: MapData, m: MarkerInput, radiusM: number): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const size = canvas.width;
  const px = size / 200;
  const cx = m.focus?.x ?? 0;
  const cz = m.focus?.z ?? 0;
  const tf: Transform = { cx, cz, scale: size / (2 * radiusM), size };
  g.clearRect(0, 0, size, size);
  g.save();
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = '#2a2016';
  g.fillRect(0, 0, size, size);
  const terr = terrainCanvas(map, canvas.ownerDocument);
  const tScale = terr.width / map.size;
  const half = map.size / 2;
  const sx = (cx - radiusM + half) * tScale;
  const sy = (cz - radiusM + half) * tScale;
  const sw = 2 * radiusM * tScale;
  g.imageSmoothingEnabled = true;
  g.drawImage(terr, sx, sy, sw, sw, 0, 0, size, size);
  drawZone(g, tf, m.zone, px);
  drawMarkers(g, tf, m, px, false);
  g.restore();
}

/** Draw the whole map (big map overlay). */
export function drawBigMap(canvas: HTMLCanvasElement, map: MapData, m: MarkerInput, lang: 'zh' | 'en'): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const size = canvas.width;
  const px = size / 600;
  const tf: Transform = { cx: 0, cz: 0, scale: size / map.size, size };
  g.clearRect(0, 0, size, size);
  g.imageSmoothingEnabled = true;
  g.drawImage(terrainCanvas(map, canvas.ownerDocument), 0, 0, size, size);
  // region labels
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const r of map.regions) {
    const [x, y] = toScreen(tf, r.center.x, r.center.z);
    const label = lang === 'en' ? r.nameEn : r.nameZh;
    g.font = `700 ${Math.round(15 * px)}px "STKaiti","KaiTi","Kaiti SC",serif`;
    g.lineWidth = 3.5 * px;
    g.strokeStyle = 'rgba(20, 12, 6, 0.85)';
    g.strokeText(label, x, y);
    g.fillStyle = '#f5e6c0';
    g.fillText(label, x, y);
  }
  drawZone(g, tf, m.zone, px);
  drawMarkers(g, tf, m, px * 1.4, true);
}
