// Public surface of the map module (虎牢·赤壁 generator + nav grid).
//   generateMap(seed)            deterministic MapData (see generate.ts header
//                                for the per-PropType geometry conventions)
//   buildNavGrid(map, cellSize)  cached walkability grid; findPath / nearestWalkable
//                                / isWalkable / navWalkSegment for AI
//   propColliders(prop) & co.    the single source of truth for prop geometry
//   ColliderIndex                fast static collider queries (raycast, clearance)
export { generateMap, generateMapDetailed, type GeneratedMapDetails, MAP_RES, MAP_SIZE, WATER_LEVEL } from './generate';
export {
  buildNavGrid,
  findPath,
  isWalkable,
  locateNode,
  NAV_AGENT_HEIGHT,
  NAV_AGENT_RADIUS,
  NAV_MAIN,
  NAV_MAX_DROP,
  NAV_MAX_SLOPE,
  NAV_MAX_STEP,
  NAV_WATER,
  NAV_WATER_COST,
  type NavGrid,
  navCellAt,
  navNodePos,
  navWalkSegment,
  nearestNode,
  nearestWalkable,
  randomWalkablePoint,
} from './nav';
export * from './props';
export { COLLIDER_BOX, COLLIDER_CYL, ColliderIndex, segmentClear } from './colliders';
export { dcos, dsin } from './noise';
