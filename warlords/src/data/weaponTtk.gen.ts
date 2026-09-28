// GENERATED — 5 / 20 / 50 m time-to-kill of each weapon (seconds; Infinity: cannot kill there): the human
// TTK model (weapons spec D3: mid skill, 400 HP, unarmored, 20 % headshots), read by the stat card's TTK strip.
// Placeholder from the spec's final model rows (scratchpad weapons-study/final/rows_final_mid.json) until the
// D3 script regenerates it (drift-checked like docs/HEROES.md). Do not edit by hand.
export const WEAPON_TTK: Record<string, { m5: number; m20: number; m50: number }> = {
  baiyi: { m5: 2.68, m20: 2.68, m50: 3.45 },
  carbine: { m5: 2.49, m20: 2.49, m50: 5.86 },
  cixiong: { m5: 2.3, m20: 2.95, m50: Infinity },
  fangtian: { m5: 2.62, m20: 4.52, m50: Infinity },
  guanshi: { m5: Infinity, m20: 3.63, m50: 10 },
  guding: { m5: 1.61, m20: 8.33, m50: Infinity },
  hanbing: { m5: 2.49, m20: 2.62, m50: 6.06 },
  huben: { m5: 2.73, m20: 2.96, m50: 5.73 },
  hutou: { m5: 2.15, m20: 2.37, m50: 5.69 },
  jiguan: { m5: 2, m20: 2.2, m50: 6 },
  jinfan: { m5: 1.93, m20: 2.65, m50: Infinity },
  liegong: { m5: 3.65, m20: 3.75, m50: 8.1 },
  longdan: { m5: 2.22, m20: 2.22, m50: 3.85 },
  manwang: { m5: 1.53, m20: 10.46, m50: Infinity },
  pistol: { m5: 3.13, m20: 3.45, m50: 10.76 },
  qilin: { m5: 3.5, m20: 3.5, m50: 3.5 },
  qinggang: { m5: 3.05, m20: 3.05, m50: 3.81 },
  qinglong: { m5: 2.09, m20: 2.22, m50: 4.09 },
  qingnang: { m5: 2.63, m20: 2.75, m50: 7.61 },
  smg: { m5: 2.07, m20: 2.72, m50: Infinity },
  taiping: { m5: 2.13, m20: 2.6, m50: 10.02 },
  wushuang: { m5: 2.2, m20: 2.42, m50: 4.02 },
  xiaoji: { m5: 2.73, m20: 3.42, m50: 8.68 },
  yitian: { m5: 3.05, m20: 3.05, m50: 3.45 },
  zhangba: { m5: 1.43, m20: 9.63, m50: Infinity },
  zhuge: { m5: 1.84, m20: 2.96, m50: Infinity },
  zhuque: { m5: 1.81, m20: Infinity, m50: Infinity },
};
