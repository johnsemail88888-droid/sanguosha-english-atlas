// Skill targeting preview plans (src/render/vfx/skillPreview.ts): what is drawn on the
// ground while an aimed skill's key is held.
import { describe, expect, it } from 'vitest';
import { ABILITY_BY_ID } from '../../../src/data';
import { SkillPreview, clampToRange, planSkillPreview, previewReach, previewStatus, previewTone, type PreviewUnit } from '../../../src/render/vfx/skillPreview';

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
    // 结姻: a male hero only
    const her: PreviewUnit = { id: 4, x: 0, y: 0, z: -8, kind: 'hero', own: false, male: false };
    expect(plan('sunshangxiang_jieyin', undefined, her)!.valid).toBe(false);
    expect(plan('sunshangxiang_jieyin', undefined, { ...her, male: true })!.valid).toBe(true);
  });

  it('a secondary area around the target (离间 15 m)', () => {
    const foe: PreviewUnit = { id: 3, x: 4, y: 0, z: -10, kind: 'hero', own: false };
    const other: PreviewUnit = { id: 4, x: 8, y: 0, z: -12, kind: 'hero', own: false };
    const p = planSkillPreview({ def: ABILITY_BY_ID.diaochan_lijian, caster: at, yaw: 0, aimPoint: { x: 4, y: 1, z: -10 }, target: foe, units: [foe, other] })!;
    expect(p.area).toMatchObject({ x: 4, z: -10, rOut: 15 });
    expect(p.caughtUnits.map((u) => u.id)).toEqual([4]);
  });

  it('an enemy under the crosshair but out of range is "far" (with its distance), not "no target"', () => {
    const foe: PreviewUnit = { id: 7, x: 0, y: 0, z: -20, kind: 'hero', own: false };
    const p = planSkillPreview({ def: ABILITY_BY_ID.zhangliao_tuxi, caster: at, yaw: 0, aimPoint: { x: 0, y: 1.1, z: -20 }, target: foe })!; // range 12
    expect(p).toMatchObject({ valid: false, reason: 'far', targetId: 7, tone: 'invalid' });
    expect(p.dist!).toBeCloseTo(20, 0);
    // nothing aimed at: 'none'
    expect(plan('zhangliao_tuxi')).toMatchObject({ valid: false, reason: 'none' });
    // 青囊 (no target → yourself) still casts, and says the aimed ally was too far
    const ally: PreviewUnit = { id: 8, x: 0, y: 0, z: -40, kind: 'hero', own: false };
    expect(plan('huatuo_qingnang', { x: 0, y: 1, z: -40 }, ally)).toMatchObject({ valid: true, reason: 'far', marker: { x: 0, z: 0 } });
  });

  it('like the sim, a unit just off the crosshair counts, and your own soldier in front does not block it', () => {
    const foe: PreviewUnit = { id: 7, x: 0.4, y: 0, z: -10, kind: 'hero', own: false };
    const mine: PreviewUnit = { id: 9, x: 0, y: 0, z: -5, kind: 'troop', own: true };
    const p = planSkillPreview({ def: ABILITY_BY_ID.guanyu_yijue, caster: at, yaw: 0, aimPoint: { x: 0, y: 1.1, z: -10 }, target: mine, units: [mine, foe] })!;
    expect(p).toMatchObject({ valid: true, targetId: 7, marker: { x: 0.4, z: -10 } });
    // 20° off: not aimed at
    const aside: PreviewUnit = { ...foe, x: 4 };
    expect(planSkillPreview({ def: ABILITY_BY_ID.guanyu_yijue, caster: at, yaw: 0, aimPoint: { x: 0, y: 1.1, z: -10 }, target: null, units: [aside] })!.valid).toBe(false);
  });

  it('反间 / 离间 draw a line to the hero the target will be turned on; with nobody near 反间 disarms, 离间 is not cast', () => {
    const foe: PreviewUnit = { id: 3, x: 0, y: 0, z: -10, kind: 'hero', own: false };
    const other: PreviewUnit = { id: 4, x: 6, y: 0, z: -12, kind: 'hero', own: false };
    const downed: PreviewUnit = { id: 5, x: 1, y: 0, z: -11, kind: 'hero', own: false, downed: true };
    const fj = planSkillPreview({ def: ABILITY_BY_ID.zhouyu_fanjian, caster: at, yaw: 0, aimPoint: { x: 0, y: 1, z: -10 }, target: foe, units: [foe, other, downed] })!;
    expect(fj).toMatchObject({ valid: true, targetId: 3, linkId: 4 });
    expect(fj.link).toMatchObject({ x: 0, z: -10 });
    // the partner gets the ring; nobody is "caught"
    expect(fj.caughtUnits.map((u) => u.id)).toEqual([4]);
    expect(fj.caught).toBeUndefined();
    const alone = planSkillPreview({ def: ABILITY_BY_ID.zhouyu_fanjian, caster: at, yaw: 0, aimPoint: { x: 0, y: 1, z: -10 }, target: foe, units: [foe] })!;
    expect(alone).toMatchObject({ valid: true, fallback: 'disarm', link: null });
    const lj = planSkillPreview({ def: ABILITY_BY_ID.diaochan_lijian, caster: at, yaw: 0, aimPoint: { x: 0, y: 1, z: -10 }, target: foe, units: [foe] })!;
    expect(lj).toMatchObject({ valid: false, reason: 'alone', tone: 'invalid' });
    // 离间 falls back on a soldier near it that is not its own
    const soldier: PreviewUnit = { id: 6, x: 3, y: 0, z: -10, kind: 'troop', own: false, owner: 99 };
    const itsOwn: PreviewUnit = { id: 7, x: 1, y: 0, z: -10, kind: 'troop', own: false, owner: 3 };
    expect(planSkillPreview({ def: ABILITY_BY_ID.diaochan_lijian, caster: at, yaw: 0, aimPoint: { x: 0, y: 1, z: -10 }, target: foe, units: [foe, itsOwn, soldier] })).toMatchObject({ valid: true, linkId: 6 });
  });

  it('an area counts (and marks) the units it would catch: foes for harm, never yours', () => {
    const units: PreviewUnit[] = [
      { id: 2, x: 0, y: 0, z: -7, kind: 'hero', own: false },
      { id: 3, x: 5, y: 0, z: 5, kind: 'troop', own: false },
      { id: 4, x: 0, y: 0, z: -12, kind: 'hero', own: false }, // outside the 10 m ring
      { id: 5, x: 2, y: 0, z: 0, kind: 'troop', own: true }, // yours
    ];
    const wz = planSkillPreview({ def: ABILITY_BY_ID.zhangliao_weizhen, caster: at, yaw: 0, aimPoint: at, target: null, units })!;
    expect(wz.caught).toBe(2);
    expect(wz.caughtUnits.map((u) => u.id)).toEqual([2, 3]);
    // a cone: only what is in front
    const cone = planSkillPreview({ def: ABILITY_BY_ID.zhangfei_duanqiao, caster: at, yaw: 0, aimPoint: at, target: null, units })!;
    expect(cone.caughtUnits.map((u) => u.id)).toEqual([2]);
    // a projectile line stops at its first hit: not counted
    expect(planSkillPreview({ def: ABILITY_BY_ID.huangzhong_chuanyang, caster: at, yaw: 0, aimPoint: at, target: null, units })!.caught).toBeUndefined();
    // a plain enemy-target skill: no count
    expect(planSkillPreview({ def: ABILITY_BY_ID.guanyu_yijue, caster: at, yaw: 0, aimPoint: { x: 0, y: 1.1, z: -7 }, target: units[0], units })!.caught).toBeUndefined();
  });

  it('a point skill aimed past its range lands on the ring: clamped, with a pin at the landing spot', () => {
    const far = plan('zhugeliang_bazhen', { x: 0, y: 0, z: -200 })!;
    expect(far.clamped).toBe(30);
    expect(far.pin!.z).toBeCloseTo(-30, 6);
    const near = plan('zhugeliang_bazhen', { x: 0, y: 0, z: -8 })!;
    expect(near.clamped).toBeUndefined();
    expect(near.pin).toBeNull();
    // (a 20 m circle is a sliver seen from the eye: pinned too, not clamped)
    expect(plan('zhugeliang_bazhen', { x: 0, y: 0, z: -20 })!.pin).not.toBeNull();
  });

  it('units matter as far as the skill reaches', () => {
    expect(previewReach(ABILITY_BY_ID.zhangliao_weizhen)).toBe(12);
    expect(previewReach(ABILITY_BY_ID.zhugeliang_bazhen)).toBe(39);
    expect(previewReach(ABILITY_BY_ID.zhouyu_fanjian)).toBeGreaterThanOrEqual(60);
    expect(previewStatus(null)).toEqual({ valid: true });
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
    expect(sp.status).toMatchObject({ valid: false, reason: 'none' });
    // a far point skill: the pin stands at the landing spot
    sp.update(0.016, { ...frame, aimPoint: { x: 0, y: 0, z: -90 } });
    expect(sp.status).toMatchObject({ valid: true, clamped: 30 });
    expect(visible()).toBe(3); // range ring + circle + pin
    // nothing held: valid again
    sp.update(0.016, { ...frame, def: null });
    expect(sp.status).toEqual({ valid: true });
    sp.dispose();
  });
});
