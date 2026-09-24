// ═════════════════════════════════════════════════════════════════════════════
// 虎牢·赤壁 (Hulao · Red Cliffs) — deterministic battlefield generator.
//
//   generateMap(seed) -> MapData   (same seed ⇒ bit-identical MapData on every
//   peer and JS engine: all decisions use exact arithmetic + dsin/dcos from
//   ./noise.ts, never Math.sin/cos/atan2/pow/hypot).
//
// WORLD FRAME
//   X east, Z south, Y up (three.js). North = -Z (top of the minimap). The map
//   spans [-160, 160]² m; heightfield res 160 (2 m cells); water surface at
//   map.waterLevel (river bed ≤ 1.3 m below it: wadeable). Terrain beyond
//   ~143 m (rounded square, see terrain.ts rimDistance) rises into an
//   impassable mountain rim; invisible boundary boxes (colliders without props)
//   stand at 151 m.
//
//   洛阳宫城 centre (walls ±38, outer face ±40.5)   虎牢关 north (fortress z=-100)
//   赤壁 river z≈92 (3 bridges, docks, 3 ships)      官渡大营 east (104,-6)
//   长坂坡 west (-104,6)   乌巢 NE (98,-100)   北邙山 NW (-98,-100)
//   南蛮营地 SW (-92,122)  华容道 SE (98,122)  red cliffs (40,124)
//
// ─────────────────────────────────────────────────────────────────────────────
// PROP GEOMETRY CONVENTIONS  (renderer builds meshes from the same numbers;
// colliders come from props.ts propColliders(), which implements exactly this)
// ─────────────────────────────────────────────────────────────────────────────
// Common to all props:
//   x, z   footprint centre (world).
//   y      BASE height (bottom of the prop, usually the lowest terrain under
//          the footprint, slightly embedded). EXCEPTIONS: bridge, dock, ship
//          use y = walkable DECK TOP.
//   rot    yaw, exactly three.js mesh.rotation.y. local +X -> world
//          (cos rot, 0, -sin rot); local +Z -> world (sin rot, 0, cos rot).
//          The FRONT of every prop is local -Z = forwardFromYaw(rot): doors,
//          the outside face of walls/gates, the direction stairs climb to.
//   sx sy sz  full size along local X / Y / Z (sy = height unless noted).
//   variant   style index (listed per type).  color = tint hint (flags, tents,
//             ships, red-cliff rocks).
//   Collider boxes use the prop's rot; offsets below are prop-local.
//
// wall        Box sx(length) × sy × sz(thickness). Collider: the full box
//             (top is walkable: city/fortress wall walks).
//             v0 rammed-earth + grey brick city/fortress wall; v1 crenellated
//             parapet 女墙 (1.2 m high, 0.6 thick; notches in the top 40% are
//             visual only, collider is the full box; sits ON the wall top at
//             the outer (front) edge); v2 white courtyard wall w/ tile coping;
//             v3 timber palisade (camp).
// gateTower   城门楼 over a gate passage. sx = total length along the wall,
//             sy = walkway height (= adjoining wall height), sz = depth (= wall
//             thickness). Passage (gap) width = sx - 2·GATE_PIER(3), centred
//             at local x = 0. Colliders: two solid piers (local x ∈ ±[sx/2-3,
//             sx/2], full sz, y..y+sy); lintel deck over the passage
//             (y+sy-1.2 .. y+sy, walkable top continuing the wall walk);
//             front breastwork (local z ∈ [-sz/2, -sz/2+0.6], 1.2 m high, full
//             sx); open hall on top: 4 pillars r0.3 at local (±(sx/2-0.3),
//             ±(sz/2-0.3)) from y+sy to y+sy+3.4; roof slab (sx+1.6)×1.4×(sz+1.6)
//             at y+sy+3.4 (visual hip roof may rise higher). The hall is OPEN
//             (pillars only, no walls): the wall walk runs straight through
//             it, so anything drawn between the pillars must be see-through
//             lattice/rails below 0.45 m or omitted. Door leaves: open,
//             recessed in the passage (visual). v0 city gate, v1 虎牢关 gate.
// palace      宫殿 main hall. sx width, sz depth, sy height to the ridge.
//             Colliders: 台基 terrace box sx×1.2×sz (walkable, reached by a
//             separate 'stairs' prop in front); hall body 0.7sx × hallH ×
//             0.55sz (hallH = 0.4·(sy-1.2)) on the terrace; lower eave slab
//             0.84sx×1.0×0.8sz above the hall; upper roof 0.6sx×rest×0.45sz up
//             to y+sy (double-eave 重檐 roof); 6 front colonnade pillars r0.35 at
//             local z = -(0.275sz+1.3), x = -0.3sx + i·0.12sx (i=0..5), terrace
//             top to hall top; two bronze 鼎 cauldrons r0.6, 1.2 high on the
//             terrace at local (±0.3sx, -sz/2+1.6). Main door centred on the
//             hall's front face. The terrace front edge has no railing collider
//             (the front stairs are 10 m wide).
// house       民居, solid (no interior). sx width (front face), sz depth,
//             sy ridge height. Walls HOUSE_WALL_FRAC(0.58)·sy high; hip roof
//             from there to y+sy, ridge along local X (pyramid if sz >= sx).
//             Roof profile (what the renderer draws): eave overhang 0.6 m
//             (v4 0.9); at height fraction f of the roof the surface is inset
//             from the eave line by (1 - f^(1/curve)) of the eave half extent,
//             curve 1.6 (v3 thatch 1.05); ridge length 0.75·(W - D) (thatch
//             0.8), W/D = sx/sz + 2·overhang. Colliders: body sx×0.58sy×sz
//             (v2: sx×sz up to y+0.52·wallH+0.25, then the upper floor
//             0.9sx×0.9sz to the eave) plus 4 stacked roof boxes following that
//             profile (houseRoofTiers(), clamped to the wall footprint; the
//             overhanging eaves, above head height, have no collider).
//             Door centred on the front face (local -Z), windows on the sides.
//             City blocks mix rows of houses facing N/S across >= 3.4 m
//             alleys with back-to-back shops facing the E/W lanes.
//             v0 city house (white plaster, grey tiles), v1 timber house,
//             v2 two-storey hall/shop (mid eave at ~half height), v3 thatched
//             village cottage, v4 granary/warehouse (wide, low walls, big roof).
// pavilion    亭 open pavilion. sx×sz roof plan, sy total height. Colliders:
//             base platform sx×0.3×sz (walkable); pillars r0.22 at local
//             (±(sx/2-0.35), ±(sz/2-0.35)) plus mid pillars on sides longer
//             than 7 m (see pavilionPillars()), from y to y+0.3+0.55sy; 美人靠
//             bench railings 0.25 thick from y+0.3 to y+0.75 (bx = sx/2-0.35,
//             bz = sz/2-0.35) along the back (+Z) edge, full width, and along
//             both sides from local z = -0.6bz to +bz — the FRONT (-Z) IS OPEN;
//             stone table cylinder r0.55 at the centre (y+0.3 .. y+0.98); roof
//             slab (sx+1)×…×(sz+1) from y+0.3+0.55sy to y+sy.
// watchtower  箭楼. sx×sz footprint, sy = PLATFORM height (walkable top).
//             Colliders: solid base sx×sy×sz; parapets 1.1 high, 0.35 thick on
//             the platform edges: front and both sides full length, back (+Z)
//             split leaving a centred 2.2 m gap (WT_GAP) where the stairs
//             arrive; 4 corner posts r0.18 at local (±(sx/2-0.18), ±(sz/2-0.18))
//             from y+sy to y+sy+2.7; roof slab (sx+1.2)×0.7×(sz+1.2) on the
//             posts. Its stairs are a separate 'stairs' prop behind it with the
//             same rot. v0 brick city tower, v1 timber camp tower.
// tent        军帐. sx×sz footprint, sy ridge height. Collider: box
//             sx×0.7sy×sz. Door flap on the front. v0 small ridge tent (ridge
//             along local X), v1 large command tent, v2 南蛮 hide tent,
//             v3 ragged 黄巾 tent. color = cloth.
// barricade   Box sx×sy×sz (chest-high cover). v0 sandbags, v1 拒马
//             cheval-de-frise, v2 wooden plank wall.
// crateStack  Wooden crates. v0: one layer filling sx×sy×sz. v1: bottom
//             layer sx×sy/2×sz + top layer sx/2×sy/2×sz over the local -X half
//             (centre x = -sx/4). v2: bottom sx×sy/2×sz + top sx/2×sy/2×sz/2
//             centred. Colliders = those boxes; draw crates filling them.
// rock        Boulder filling sx×sy×sz (base at y, bottom ~0.25 m buried): a
//             rounded blob whose horizontal section is ~an ellipse with
//             semi-axes 0.47sx × 0.47sz, widest around 0.4sy, tapering to a
//             cap (v1: flat-topped slab, wide to the top). Colliders (only if
//             sy ≥ 0.6): body y-0.3 .. y+0.72sy = cylinder r = 0.47·min(sx,sz)
//             plus, if elongated > 1.15:1, two boxes along the long axis (half
//             extents 0.94a×0.47c and 0.72a×0.78c, a/c = long/short
//             semi-axis); cap up to y+0.9sy = cylinder r = 0.3·sqrt(sx·sz)
//             (v1: the body shape at 0.45 up to y+0.95sy). Reach from the
//             centre ≤ rockReach() = 0.5·max(sx,sz). v0..3 shapes (v1 is the
//             flat-topped slab); color = tint (red cliffs).
// tree / pine Trunk + canopy. sx = canopy diameter (sz = sx), sy = height.
//             Collider: trunk cylinder r = trunkRadius(sy) = clamp(0.045sy,
//             0.18, 0.5) from y to y+0.55sy (tree) / y+0.6sy (pine); foliage
//             does not block. Instanced.
// bamboo      Cluster of stalks, diameter sx (=sz), height sy. Collider:
//             cylinder r = 0.3·min(sx,sz), full height.
// bridge      y = DECK TOP. sx = span length along local X, sz = deck width,
//             sy = depth from the deck top down to the river bed (piers).
//             Colliders: deck sx×0.6×sz (top at y); rails 1.0 high × 0.2 thick
//             along both long edges (local z = ±(sz/2-0.1)), length sx-2
//             (open 1 m at each end); piers 1.2 × (sz-0.4) from y-sy to y-0.6
//             at local x = k·8 for |k·8| ≤ sx/2-8 (bridgePiers()).
//             v0 stone beam bridge, v1 timber bridge, v2 chained-boat bridge
//             (连舟浮桥: draw boats as piers). Deck ends rest on flattened banks.
// dock        y = DECK TOP. sx×sz planked deck, sy = pile length below the
//             deck. Collider: deck sx×0.5×sz. Piles/bollards are visual.
// ship        战船, y = DECK TOP, sx = length (BOW at local -X, stern +X),
//             sz = beam, sy = hull depth below the deck. Colliders: hull box
//             sx×sy×sz (top = walkable deck); bulwarks 1.0 high × 0.3 thick on
//             the back (+Z) side, both ends, and the front (-Z, boarding) side
//             split around a 3.2 m gap centred at local x = 0 (SHIP_GANG_GAP)
//             where a gangplank 'stairs' prop arrives; deck house (楼) at
//             local x ∈ [0.18sx, 0.44sx], z ∈ ±(sz/2-1.2), 2.8 m high (v0 draws a
//             second tier above it visually); mast r0.28 at local (-0.1sx, 0),
//             height 0.55sx (sail visual). v0 楼船 tower ship, v1 艨艟, v2 火船
//             fire ship (straw bundles instead of cabin, same colliders).
// statue      Plinth sx×0.22sy×sz + figure cylinder r = 0.3·min(sx,sz) up to
//             y+sy. Faces front. v0 stone general, v1 石狮 guardian lion,
//             v2 bronze 鼎, v3 南蛮 totem.
// banner      军旗: pole at (x,z), height sy; flag of width sx hangs from the
//             top towards local +X. Collider: thin pole cylinder r0.12.
//             color = flag colour (kingdom colours).
// brazier     Fire basin on a stand, diameter sx, height sy; light/fire at
//             y+sy. Collider: cylinder r = 0.5sx.
// ruin        Broken wall, length sx, thickness sz, max height sy.
//             v0: tall part local x ∈ [-sx/2, 0.1sx] full height + low part
//             x ∈ [0.1sx, sx/2] at 0.5sy. v1: mirrored (tall part on +X).
//             v2: ruined gateway: two pillars of width 0.25sx at both ends,
//             full height, no lintel. Colliders = those boxes.
// farmField   Flat crop decal sx×sz on the terrain (rows along local X).
//             No collider. v0 wheat, v1 rice paddy, v2 vegetables.
// stairs      Straight flight. sx = width, sy = total rise, sz = run; climbs
//             towards the front (local -Z): bottom edge at local z = +sz/2,
//             top edge at -sz/2. n = stairStepCount(sy) = ceil(sy/0.4) steps,
//             rise sy/n ≤ 0.4 m, run sz/n. Step i (0 = lowest) is a SOLID box
//             spanning local z ∈ [sz/2-(i+1)·run, sz/2-i·run] and y ∈ [y,
//             y+(i+1)·rise] (see stairSteps()); the last step's top is flush
//             with the landing it serves. v0 stone, v1 timber (gangplanks,
//             camp towers).
//
// Physics contract implied by the layout: characters must step up ≥ 0.45 m
// (NAV_MAX_STEP) without jumping; box tops are walkable surfaces.
// ═════════════════════════════════════════════════════════════════════════════
import type { Collider, MapData, MapRegion, NpcCamp } from '../../core/map';
import { Rng } from '../../core/rng';
import { MapBuilder } from './builder';
import { buildCity } from './city';
import { ColliderIndex } from './colliders';
import { buildNavGridUncached, type NavGrid, primeNavCache } from './nav';
import { PI, TWO_PI } from './noise';
import { propColliders } from './props';
import {
  BEIMANG,
  BRIDGE_DECK_Y,
  BRIDGE_W,
  buildBeimang,
  buildChangban,
  buildChibi,
  buildGuandu,
  buildHulao,
  buildHuarong,
  buildNanman,
  buildWuchao,
  CHANGBAN,
  CHANGBAN_YT,
  GUANDU,
  HUARONG,
  NANMAN,
  planRiver,
  QUAY_Y,
  RED_CLIFFS,
  VILLAGE,
  WUCHAO,
} from './regions';
import { decorateRim, plantBamboo, scatterCover } from './scatter';
import { chooseSpawns, chooseSpots, type Poi } from './spots';
import { BOUNDARY, FORTRESS_Z, MAP_RES, MAP_SIZE, makeRiver, type Pad, Terrain, WATER_LEVEL } from './terrain';

export { MAP_SIZE, MAP_RES, WATER_LEVEL } from './terrain';

const rect = (x: number, z: number, hx: number, hz: number): Pad['shape'] => ({ kind: 'rect', x, z, hx, hz });
const circle = (x: number, z: number, r: number): Pad['shape'] => ({ kind: 'circle', x, z, r });

/** Build the 虎牢·赤壁 battlefield for a seed. Pure and deterministic. */
export function generateMap(seed: number): MapData {
  return generateMapDetailed(seed).map;
}

export interface GeneratedMapDetails {
  map: MapData;
  /** nav grid built during generation (also cached for buildNavGrid(map)) */
  nav: NavGrid;
  /** every candidate point of interest considered for loot/crates */
  pois: readonly Poi[];
}

/** generateMap plus the intermediate artefacts (tests, previews, tooling). */
export function generateMapDetailed(seed: number): GeneratedMapDetails {
  const rng = new Rng(seed ^ 0x2f6b1d3);
  const river = makeRiver(rng);
  const terrain = new Terrain(seed, river);
  const plan = planRiver(terrain, river);

  // ── terrain pads (plateaus under structures), then the rim ────────────────
  const cityY = terrain.applyPad({ shape: rect(0, 0, 44, 44), blend: 15, min: 8, max: 12 });
  const hulaoY = terrain.applyPad({ shape: rect(0, FORTRESS_Z, 27, 14), blend: 9 });
  terrain.applyPad({ shape: circle(GUANDU.x, GUANDU.z, 30), blend: 16 });
  terrain.applyPad({ shape: circle(WUCHAO.x, WUCHAO.z, 20), blend: 14 });
  terrain.applyPad({ shape: rect(BEIMANG.x, BEIMANG.z, 7, 15), blend: 10 });
  terrain.applyPad({ shape: circle(VILLAGE.x, VILLAGE.z, 16), blend: 12 });
  terrain.applyPad({ shape: circle(CHANGBAN_YT.x, CHANGBAN_YT.z, 12), blend: 10 });
  terrain.applyPad({ shape: circle(NANMAN.x, NANMAN.z, 13), blend: 10 });
  terrain.applyPad({ shape: rect(HUARONG.x, HUARONG.z, 22, 5), blend: 10 });
  // bridgeheads: flat landing at the deck ends, then a ramp road up the valley flank
  const landY = BRIDGE_DECK_Y - 0.25;
  for (const br of plan.bridges) {
    const hw = BRIDGE_W / 2 + 3; // deck + the braziers flanking it (at ±(W/2 + 1.6))
    terrain.applyPad({ shape: rect(br.x, br.zN - 11, hw, 12.5), blend: 5, ramp: { axis: 'z', from: br.zN - 1, to: br.zN - 22, h0: landY, h1: 'natural' } });
    terrain.applyPad({ shape: rect(br.x, br.zS + 11, hw, 12.5), blend: 5, ramp: { axis: 'z', from: br.zS + 1, to: br.zS + 22, h0: landY, h1: 'natural' } });
  }
  const { zq, zs, northDock: nd, southDock: sd } = plan;
  // quays: a flat strip along the water plus a ramp road climbing the valley flank
  terrain.applyPad({ shape: rect((nd.x0 + nd.x1) / 2, zq - 3, (nd.x1 - nd.x0) / 2 + 3, 3.5), blend: 12, height: QUAY_Y });
  terrain.applyPad({ shape: rect(39, zq - 14, 5, 10), blend: 5, ramp: { axis: 'z', from: zq - 5, to: zq - 24, h0: QUAY_Y, h1: 'natural' } });
  terrain.applyPad({ shape: rect((nd.x0 + nd.x1) / 2, zq + 8, (nd.x1 - nd.x0) / 2 + 1, 5.5), blend: 2, height: WATER_LEVEL - 1.3 });
  terrain.applyPad({ shape: rect((sd.x0 + sd.x1) / 2, zs + 3, (sd.x1 - sd.x0) / 2 + 3, 3.5), blend: 12, height: QUAY_Y });
  terrain.applyPad({ shape: rect(-34, zs + 14, 5, 10), blend: 5, ramp: { axis: 'z', from: zs + 5, to: zs + 24, h0: QUAY_Y, h1: 'natural' } });
  terrain.applyPad({ shape: rect((sd.x0 + sd.x1) / 2, zs - 8, (sd.x1 - sd.x0) / 2 + 1, 5.5), blend: 2, height: WATER_LEVEL - 1.3 });
  terrain.applyRim();
  // quantise to float32 now so placement uses exactly the heights peers will see
  for (let i = 0; i < terrain.h.length; i++) terrain.h[i] = Math.fround(terrain.h[i]);

  // ── structures ────────────────────────────────────────────────────────────
  const b = new MapBuilder(terrain, rng);
  const pois: Poi[] = [];
  const brW = plan.bridges[0];
  const brC = plan.bridges[1];
  const brE = plan.bridges[2];
  // keep the main roads free of scatter
  b.markRoad([{ x: 0, z: -40 }, { x: 0, z: -94 }], 9);
  b.markRoad([{ x: 0, z: -106 }, { x: 0, z: -140 }], 8);
  b.markRoad([{ x: 1, z: 40 }, { x: brC.x, z: brC.zN }], 9);
  b.markRoad([{ x: brC.x, z: brC.zS }, { x: brC.x, z: 136 }], 8);
  b.markRoad([{ x: 40, z: 0 }, { x: 82, z: -6 }], 9);
  b.markRoad([{ x: -40, z: 0 }, { x: -84, z: -4 }], 9);
  b.markRoad([{ x: -52, z: 0 }, { x: brW.x, z: brW.zN }], 7);
  b.markRoad([{ x: brW.x, z: brW.zS }, { x: -90, z: 114 }], 7);
  b.markRoad([{ x: 52, z: -2 }, { x: brE.x, z: brE.zN }], 7);
  b.markRoad([{ x: brE.x, z: brE.zS }, { x: 86, z: 120 }], 7);
  b.markRoad([{ x: 1, z: 62 }, { x: 39, z: zq - 6 }], 7);
  b.markRoad([{ x: 104, z: -28 }, { x: 98, z: -86 }], 7);
  b.markRoad([{ x: -96, z: -16 }, { x: -98, z: -84 }], 7);

  const city = buildCity(b, cityY, pois);
  buildHulao(b, hulaoY, pois);
  const guanduCamp = buildGuandu(b, pois);
  buildWuchao(b, pois);
  buildBeimang(b, pois);
  const changbanCamp = buildChangban(b, pois);
  const nanmanCamp = buildNanman(b, pois);
  buildChibi(b, plan, pois);
  buildHuarong(b, pois);
  plantBamboo(b, pois);
  scatterCover(b, pois);
  decorateRim(b);

  // ── colliders (props + invisible boundary) ────────────────────────────────
  const colliders: Collider[] = [];
  for (const p of b.props) for (const c of propColliders(p)) colliders.push(c);
  colliders.push(...boundaryColliders());

  const camps: NpcCamp[] = [
    { pos: guanduCamp, npcType: 'yellowTurban', count: 5, crateTier: 2 },
    { pos: changbanCamp, npcType: 'yellowTurban', count: 5, crateTier: 2 },
    { pos: nanmanCamp, npcType: 'barbarian', count: 4, crateTier: 2 },
  ];

  const g = (x: number, z: number): number => terrain.heightAt(x, z);
  const region = (id: string, nameZh: string, nameEn: string, x: number, z: number, radius: number): MapRegion => ({
    id,
    nameZh,
    nameEn,
    center: { x, y: g(x, z), z },
    radius,
  });
  const regions: MapRegion[] = [
    region('luoyang', '洛阳宫城', 'Luoyang Palace City', 0, 0, 46),
    region('hulao', '虎牢关', 'Hulao Pass', 0, FORTRESS_Z - 4, 30),
    region('chibi', '赤壁渡口', 'Red Cliffs Ferry', 39, zq + 4, 32),
    region('guandu', '官渡大营', 'Guandu Camp', GUANDU.x, GUANDU.z, 30),
    region('changban', '长坂坡', 'Changban Slope', CHANGBAN.x, CHANGBAN.z, 36),
    region('wuchao', '乌巢粮仓', 'Wuchao Granary', WUCHAO.x, WUCHAO.z, 24),
    region('beimang', '北邙山', 'Mount Beimang', BEIMANG.x, BEIMANG.z, 26),
    region('nanman', '南蛮营地', 'Nanman Camp', NANMAN.x, NANMAN.z, 20),
    region('huarong', '华容道', 'Huarong Trail', HUARONG.x, HUARONG.z, 24),
    region('redcliffs', '赤壁', 'Red Cliffs', RED_CLIFFS.x, RED_CLIFFS.z, 22),
  ];

  const map: MapData = {
    seed,
    nameZh: '虎牢·赤壁',
    nameEn: 'Hulao · Red Cliffs',
    size: MAP_SIZE,
    res: MAP_RES,
    heights: terrain.toFloat32(),
    waterLevel: WATER_LEVEL,
    props: b.props,
    colliders,
    lordSpawn: { x: city.lordSpawn.x, y: terrain.heightAt(city.lordSpawn.x, city.lordSpawn.z), z: city.lordSpawn.z },
    spawns: [],
    lootSpots: [],
    crateSpots: [],
    camps,
    regions,
  };

  // ── nav-validated spots ───────────────────────────────────────────────────
  const index = new ColliderIndex(colliders, MAP_SIZE);
  const nav = buildNavGridUncached(map, 2, index);
  primeNavCache(map, nav);
  // keep spawns out of NPC aggro range (yellowTurban aggroRange 28 m + margin)
  const avoid = camps.map((c) => ({ pos: c.pos, r: 38 }));
  map.spawns = chooseSpawns(map, nav, avoid, rng.range(0, TWO_PI / 10) + PI / 10);
  const spots = chooseSpots(nav, pois);
  map.lootSpots = spots.lootSpots;
  map.crateSpots = spots.crateSpots;
  return { map, nav, pois };
}

/** Invisible walls just inside the rim so nobody climbs out of the arena. */
function boundaryColliders(): Collider[] {
  const B = BOUNDARY;
  const T = 5;
  const out: Collider[] = [];
  const yc = 40;
  const hy = 90;
  for (const s of [-1, 1]) {
    out.push({ kind: 'box', cx: s * (B + T), cy: yc, cz: 0, hx: T, hy, hz: B + 2 * T, rot: 0 });
    out.push({ kind: 'box', cx: 0, cy: yc, cz: s * (B + T), hx: B + 2 * T, hy, hz: T, rot: 0 });
  }
  // corners are cut by the rounded rim: diagonal walls along |x|+|z| = B/0.62
  const d = B / 0.62;
  const off = T / Math.SQRT2;
  const half = ((2 * B - d) * Math.SQRT2) / 2 + 6;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const cx = sx * (d / 2 + off);
      const cz = sz * (d / 2 + off);
      out.push({ kind: 'box', cx, cy: yc, cz, hx: half, hy, hz: T, rot: sx * sz > 0 ? PI / 4 : -PI / 4 });
    }
  return out;
}
