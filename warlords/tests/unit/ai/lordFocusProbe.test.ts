// Opt-in probe (LF_PROBE=1): prints the lord-focus harness table for every lord candidate.
// LF_NEUTRAL=1: with the troop-vs-hero rules and the bot lord's restraint off (the old rules).
// LF_TROOP='{"focusDps":45}': override single troop-vs-hero tunables; LF_SCEN=rebelFocus: only that scene.
import { describe, it } from 'vitest';
import { LORD_CANDIDATE_IDS } from '../../../src/data';
import { TROOP_VS_HERO } from '../../../src/sim/combat';
import { LORD_RESTRAINT } from '../../../src/sim/ai/abilityUse';
import { fmtLordFocus, runLordFocus, type LordScenario } from './lordFocus';

const ON = process.env.LF_PROBE === '1';
const SEEDS = Number(process.env.LF_SEEDS ?? 2);
if (process.env.LF_NEUTRAL === '1') {
  Object.assign(TROOP_VS_HERO, { mul: 1, focusDps: 1e9, over: 1, downedMul: 1 });
  Object.assign(LORD_RESTRAINT, { openingDelay: 0, pileOn: 1e9 });
}
if (process.env.LF_TROOP) Object.assign(TROOP_VS_HERO, JSON.parse(process.env.LF_TROOP));
const SCEN = process.env.LF_SCEN;

describe.skipIf(!ON)('lord focus probe', () => {
  it('table', () => {
    const scen: [LordScenario, number, number?][] = [
      ['rebelShot', 8],
      ['rebelShot', 18],
      ['loyalShot', 10],
      ['loyalNear', 6],
      ['rebelShot', 8, 400],
      ['rebelFocus', 18],
      ['rebelFocus', 18, 400],
    ];
    for (const lord of LORD_CANDIDATE_IDS) {
      for (const [s, d, at] of scen) {
        if (SCEN && s !== SCEN) continue;
        for (let k = 0; k < SEEDS; k++) {
          const r = runLordFocus({ lord, scenario: s, dist: d, seed: 1000 + k, startAt: at, seconds: 12 });
          process.stdout.write(`${fmtLordFocus(r)}${at ? ` (t=${at})` : ''} seed ${1000 + k}\n`);
        }
      }
    }
  }, 600000);
});
