// Skill targeting preview plans (src/render/vfx/skillPreview.ts): what is drawn on the
// ground while an aimed skill's key is held.
import { describe, expect, it } from 'vitest';
import { ABILITY_BY_ID } from '../../../src/data';
import { SkillPreview, clampToRange, planSkillPreview, previewTone, type PreviewUnit } from '../../../src/render/vfx/skillPreview';

const at = { x: 0, y: 0, z: 0 };
// yaw 0 faces −z
const plan = (id: string, aim = { x: 0, y: 0, z: -10 }, target: PreviewUnit | null = null, yaw = 0) =>
  planSkillPreview({ def: ABILITY_BY_ID[id], caster: at, yaw, aimPoint: aim, target });

describe('planSkillPreview', () => {
  it('a point skill: range ring around you + its circle at the crosshair, clamped to range', () => {
    const p = plan('zhugeliang_bazhen', { x: 0, y: 0, z: -50 })!; // range 30, radius 7
    expect(p.range).toMatchObject({ rOut: 30 });
    expect(p.area).toMatchObject({ rIn: 0, rOut: 7 });
    expect(p.area!.z).toBeCloseTo(-30, 6);
    expect(p.valid).toBe(true);
    expect(p.tone).toBe('harm');
  });

  it('a dash + sweep: the corridor along the aim, the sweep sector at its end', () => {
    const p = plan('guanyu_qinglong')!; // dash 8, arc 110, range 4.5
    expect(p.strip).toMatchObject({ yaw: 0, end: 8 });
    expect(p.area).toMatchObject({ rOut: 4.5, yaw: 0 });
    expect(p.area!.z).toBeCloseTo(-8, 6);
    expect(p.area!.halfArc).toBeCloseTo((110 * Math.PI) / 360, 6);
  });

  it('a charge that stops at the first enemy in its way ends there (青龙斩: 1.2 m short, its sweep from there)', () => {
    const foe: PreviewUnit = { id: 9, x: 0.5, y: 0, z: -5, kind: 'hero', own: false };
    const mine: PreviewUnit = { id: 10, x: 0, y: 0, z: -3, kind: 'troop', own: true };
    const aside: PreviewUnit = { id: 11, x: 4, y: 0, z: -2, kind: 'hero', own: false };
    const p = planSkillPreview({ def: ABILITY_BY_ID.guanyu_qinglong, caster: at, yaw: 0, aimPoint: { x: 0, y: 0, z: -10 }, target: null, units: [mine, foe, aside] })!;
    expect(p.strip!.end).toBeCloseTo(5 - 0.45 - 1.2, 6);
    expect(p.area!.z).toBeCloseTo(-(5 - 0.45 - 1.2), 6);
    expect(p.marker).toMatchObject({ x: 0.5, z: -5 });
    // 独目怒冲 stops at heroes only: a soldier in the way does not end it
    const troop: PreviewUnit = { id: 12, x: 0, y: 0, z: -4, kind: 'troop', own: false };
    const xhd = planSkillPreview({ def: ABILITY_BY_ID.xiahoudun_charge, caster: at, yaw: 0, aimPoint: at, target: null, units: [troop] })!;
    expect(xhd.strip!.end).toBe(12);
  });

  it('a cone faces the aim yaw', () => {
    const p = plan('zhangfei_duanqiao', undefined, null, Math.PI / 2)!;
    expect(p.area).toMatchObject({ x: 0, z: 0, rOut: 10, yaw: Math.PI / 2 });
    expect(p.area!.halfArc).toBeCloseTo((70 * Math.PI) / 360, 6);
  });

  it('a self-centred skill is a filled ring around you', () => {
    expect(plan('lubu_fangtian')!.area).toMatchObject({ x: 0, z: 0, rIn: 0, rOut: 5, halfArc: Math.PI });
  });

  it('an enemy-target skill: ring under the aimed enemy, grey and invalid without one', () => {
    const foe: PreviewUnit = { id: 7, x: 0, y: 0, z: -12, kind: 'hero', own: false };
    const ok = plan('guanyu_yijue', undefined, foe)!;
    expect(ok.valid).toBe(true);
    expect(ok.marker).toMatchObject({ x: 0, z: -12 });
    const none = plan('guanyu_yijue')!;
    expect(none.valid).toBe(false);
    expect(none.tone).toBe('invalid');
    expect(none.marker).toBeNull();
    // out of range (30 m) or one of your own soldiers: not a target
    expect(plan('guanyu_yijue', undefined, { ...foe, z: -45 })!.valid).toBe(false);
    expect(plan('guanyu_yijue', undefined, { ...foe, kind: 'troop', own: true })!.valid).toBe(false);
  });

  it('an ally skill with a "or yourself" fallback marks you when nobody is aimed at', () => {
    const p = plan('huatuo_qingnang')!;
    expect(p.valid).toBe(true);
    expect(p.marker).toMatchObject({ x: 0, z: 0 });
    expect(p.tone).toBe('help');
    // 济民 has no fallback
    expect(plan('liubei_jimin')!.valid).toBe(false);
  });

  it('a secondary area around the target (离间 15 m)', () => {
    const foe: PreviewUnit = { id: 3, x: 4, y: 0, z: -10, kind: 'hero', own: false };
    expect(plan('diaochan_lijian', undefined, foe)!.area).toMatchObject({ x: 4, z: -10, rOut: 15 });
  });

  it('pure self buffs have nothing to draw', () => {
    expect(plan('xuchu_luoyi')).toBeNull();
    expect(plan('guanyu_wusheng')).toBeNull();
  });

  it('tones: heals green, harm red, the rest gold', () => {
    expect(previewTone(ABILITY_BY_ID.daqiao_anxian)).toBe('help');
    expect(previewTone(ABILITY_BY_ID.zhouyu_chibi)).toBe('harm');
    expect(previewTone(ABILITY_BY_ID.sunquan_zuoduan)).toBe('self');
  });

  it('clampToRange keeps near points and pulls far ones onto the ring', () => {
    expect(clampToRange({ x: 0, z: 0 }, { x: 3, z: 4 }, 10)).toEqual({ x: 3, z: 4 });
    const c = clampToRange({ x: 0, z: 0 }, { x: 30, z: 40 }, 10);
    expect(Math.hypot(c.x, c.z)).toBeCloseTo(10, 6);
  });
});

describe('SkillPreview (meshes)', () => {
  it('shows while held, flashes on cast, hides after', () => {
    const sp = new SkillPreview();
    const def = ABILITY_BY_ID.zhugeliang_bazhen;
    const frame = { def, caster: at, yaw: 0, aimPoint: { x: 0, y: 0, z: -10 }, target: null };
    sp.update(0.016, frame);
    const visible = (): number => sp.group.children.filter((c) => c.visible).length;
    expect(visible()).toBe(2); // range ring + circle
    // released: nothing held; the cast event replays the last plan, then it fades out
    sp.update(0.016, { ...frame, def: null });
    expect(visible()).toBe(0);
    sp.castOf(def, () => ({ ...frame }));
    sp.update(0.016, { ...frame, def: null });
    expect(visible()).toBe(1); // the circle (no range ring while flashing)
    sp.update(1, { ...frame, def: null });
    expect(visible()).toBe(0);
    // an invalid target skill reports it
    sp.update(0.016, { ...frame, def: ABILITY_BY_ID.guanyu_yijue });
    expect(sp.valid).toBe(false);
    sp.dispose();
  });
});
