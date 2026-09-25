// Loading-screen preload of the AI-art character bodies for one match: the
// heroes in play, the four kingdom troop models, the neutral NPC camps and
// every shared animation clip — so no body swaps from procedural to GLB in the
// middle of the match. Resolves (never rejects) when everything settled or the
// time budget ran out (a slow / broken file then swaps in late or never).
import { assetList } from '../../game/assets';
import { HERO_BY_ID, TROOPS } from '../../data';
import { CLIP_IDS, clipFilePath, CLIP_SPECS, loadClip } from '../anim/glbClips';
import { heroModelPath, loadCharTemplate, troopModelPath } from './glb';

/** Give up waiting (the loading bar moves on; late files still swap in when they arrive). */
export const PRELOAD_BUDGET_MS = 25_000;

/** Model files a match needs: its heroes + every troop / NPC model. */
export function matchModelPaths(heroIds: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const id of heroIds) if (HERO_BY_ID[id]) paths.add(heroModelPath(id));
  for (const t of TROOPS) paths.add(troopModelPath({ headgear: t.visual.headgear, kingdom: t.kingdom === 'neutral' ? undefined : t.kingdom, id: t.id }));
  for (const k of ['shu', 'wei', 'wu', 'qun']) paths.add(troopModelPath({ kingdom: k }));
  return [...paths];
}

/**
 * Load the match's character art. `onProgress` gets 0..1 (files settled / files
 * shipped). Instant (0 files) when the deploy ships no art.
 */
export async function preloadCharacterArt(heroIds: Iterable<string>, onProgress?: (f: number) => void): Promise<void> {
  const list = await assetList();
  const models = matchModelPaths(heroIds).filter((p) => list.has(p));
  const clips = CLIP_IDS.filter((id) => {
    const f = CLIP_SPECS[id].file;
    return f ? list.has(clipFilePath(f)) : true;
  });
  const total = models.length + clips.length;
  if (!models.length || !total) {
    onProgress?.(1);
    return;
  }
  let done = 0;
  const tick = (): void => {
    done++;
    onProgress?.(Math.min(1, done / total));
  };
  const all = Promise.all([
    ...models.map((p) => loadCharTemplate(p).then(tick, tick)),
    ...clips.map((id) => loadClip(id).then(tick, tick)),
  ]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((res) => {
    timer = setTimeout(res, PRELOAD_BUDGET_MS);
  });
  await Promise.race([all, budget]);
  if (timer !== undefined) clearTimeout(timer);
  onProgress?.(1);
}
