import { describe, expect, it } from 'vitest';
import type { InputAction, InputFrame, Snapshot, ViewEntity } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, BTN_SPRINT } from '../../../src/core/types';
import { ByteReader, ByteWriter } from '../../../src/net/binary';
import {
  buildMatchStrings,
  decodeInputMsg,
  decodeJson,
  decodeSnapshotMsg,
  encodeInputMsg,
  encodeJson,
  encodeSnapshotMsg,
  quantizeInput,
  StringTable,
} from '../../../src/net/codec';
import { bigSnapshot, FIXTURE_STRINGS } from './fixtures';

const POS_EPS = 0.0051; // 1 cm quantization
const ANG_EPS = (2 * Math.PI) / 65536 + 1e-9;

function angDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function expectEntityClose(got: ViewEntity, want: ViewEntity): void {
  expect(got.kind).toBe(want.kind);
  expect(got.sub).toBe(want.sub);
  expect(Math.abs(got.x - want.x)).toBeLessThanOrEqual(POS_EPS);
  expect(Math.abs(got.y - want.y)).toBeLessThanOrEqual(POS_EPS);
  expect(Math.abs(got.z - want.z)).toBeLessThanOrEqual(POS_EPS);
  expect(angDiff(got.yaw, want.yaw)).toBeLessThanOrEqual(ANG_EPS);
  expect(Math.abs(got.pitch - want.pitch)).toBeLessThanOrEqual(1e-4);
  expect(Math.abs(got.speed - want.speed)).toBeLessThanOrEqual(0.1 + 1e-9);
  expect(got.hp).toBe(Math.round(want.hp));
  expect(got.maxHp).toBe(Math.round(want.maxHp));
  expect(got.shield).toBe(Math.round(want.shield));
  expect(got.flags).toBe(want.flags);
  for (const k of ['kingdom', 'owner', 'weapon', 'armor', 'mount', 'role', 'claim', 'name'] as const) {
    expect(got[k], `${k} of #${want.id}`).toEqual(want[k]);
  }
  if (want.radius === undefined) expect(got.radius).toBeUndefined();
  else expect(Math.abs((got.radius as number) - want.radius)).toBeLessThanOrEqual(POS_EPS);
}

function tableFor(): StringTable {
  return new StringTable(buildMatchStrings(FIXTURE_STRINGS));
}

describe('snapshot codec', () => {
  it('roundtrips a full snapshot within quantization', () => {
    const snap = bigSnapshot();
    const st = tableFor();
    const bytes = encodeSnapshotMsg(snap, st);
    const out = decodeSnapshotMsg(bytes, st);

    expect(out.tick).toBe(snap.tick);
    expect(out.ackSeq).toBe(snap.ackSeq);
    expect(out.time).toBeCloseTo(snap.time, 3);
    expect(out.elapsed).toBeCloseTo(snap.elapsed, 3);
    expect(out.zone).toEqual(snap.zone);
    expect(out.players).toEqual(snap.players);

    expect(out.ents).toHaveLength(snap.ents.length);
    const byId = new Map(out.ents.map((e) => [e.id, e]));
    for (const want of snap.ents) {
      const got = byId.get(want.id);
      expect(got, `entity ${want.id}`).toBeDefined();
      expectEntityClose(got as ViewEntity, want);
    }

    const y = out.you!;
    const w = snap.you!;
    expect(y.entityId).toBe(w.entityId);
    expect(y.role).toBe(w.role);
    expect(y.weapons).toEqual(w.weapons);
    expect(y.items).toEqual(w.items);
    expect(y.armor).toBe(w.armor);
    expect(y.mount).toBe(w.mount);
    expect(y.cooldowns).toEqual(w.cooldowns);
    expect(y.charges).toEqual(w.charges);
    expect(y.abilityState).toEqual(w.abilityState);
    expect(y.channel?.kind).toBe('revive');
    expect(y.channel?.progress).toBeCloseTo(0.4, 4);
    expect(y.statuses).toEqual(w.statuses); // Infinity survives
    expect(y.squad).toEqual(w.squad);
    expect(y.order).toEqual(w.order);
    expect(y.knownAllies).toEqual(w.knownAllies);
    expect(y.stats).toEqual(w.stats);
    expect(y.vel).toEqual(w.vel);
    expect(y.onGround).toBe(true);
    expect(y.moveMods).toEqual(w.moveMods);
    expect(y.bountyTargetId).toBeUndefined();
    expect(y.forced).toBeUndefined();
  });

  it('carries the local hero\'s forced movement (dash / knockback) for prediction', () => {
    const snap = bigSnapshot();
    snap.you!.forced = { vel: { x: 23.456, y: 0, z: -12.3 }, remaining: 0.2333 };
    const st = tableFor();
    const out = decodeSnapshotMsg(encodeSnapshotMsg(snap, st), st);
    expect(out.you!.forced!.vel.x).toBeCloseTo(23.46, 2);
    expect(out.you!.forced!.vel.z).toBeCloseTo(-12.3, 2);
    expect(out.you!.forced!.remaining).toBeCloseTo(0.23, 2);
    expect(out.you!.moveMods).toEqual(snap.you!.moveMods); // flags byte shared with moveMods
  });

  it('stays under 3 KB for 8 heroes + 60 troops + 30 NPCs + 20 misc', () => {
    const snap = bigSnapshot();
    expect(snap.ents.length).toBe(118);
    const bytes = encodeSnapshotMsg(snap, tableFor());
    expect(bytes.length).toBeLessThan(3072);
    // and JSON would be an order of magnitude bigger
    expect(JSON.stringify(snap).length).toBeGreaterThan(bytes.length * 5);
  });

  it('is robust to entity order (grouping is internal)', () => {
    const snap = bigSnapshot(3);
    const shuffled: Snapshot = { ...snap, ents: [...snap.ents].reverse() };
    const st = tableFor();
    const a = decodeSnapshotMsg(encodeSnapshotMsg(snap, st), st);
    const b = decodeSnapshotMsg(encodeSnapshotMsg(shuffled, st), st);
    expect(b.ents).toEqual(a.ents);
  });

  it('inlines strings that are not in the table', () => {
    const snap = bigSnapshot();
    snap.ents[0].sub = 'brand_new_hero';
    snap.ents[0].name = '没见过的名字';
    snap.players[0].playerId = 'reconnected-peer-xyz';
    const st = new StringTable([]);
    const out = decodeSnapshotMsg(encodeSnapshotMsg(snap, st), st);
    const e = out.ents.find((x) => x.id === snap.ents[0].id)!;
    expect(e.sub).toBe('brand_new_hero');
    expect(e.name).toBe('没见过的名字');
    expect(out.players[0].playerId).toBe('reconnected-peer-xyz');
  });

  it('handles a spectator snapshot (no private view, empty world)', () => {
    const snap = bigSnapshot();
    const empty: Snapshot = { ...snap, you: null, ents: [], players: [] };
    const st = tableFor();
    const out = decodeSnapshotMsg(encodeSnapshotMsg(empty, st), st);
    expect(out.you).toBeNull();
    expect(out.ents).toEqual([]);
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const snap = bigSnapshot();
    const e = snap.ents[0];
    e.x = 5000;
    e.hp = 1e9;
    e.speed = 999;
    e.hp = 0.4; // alive with a sliver of hp must not read as 0
    const st = tableFor();
    const got = decodeSnapshotMsg(encodeSnapshotMsg(snap, st), st).ents.find((x) => x.id === e.id)!;
    expect(got.x).toBeCloseTo(327.67, 2);
    expect(got.hp).toBe(1);
    expect(got.speed).toBe(51);
  });

  it('rejects truncated / foreign buffers', () => {
    const st = tableFor();
    const bytes = encodeSnapshotMsg(bigSnapshot(), st);
    expect(() => decodeSnapshotMsg(bytes.subarray(0, bytes.length - 7), st)).toThrow(RangeError);
    expect(() => decodeSnapshotMsg(new Uint8Array([2, 0, 0]), st)).toThrow(RangeError);
  });
});

describe('input codec', () => {
  const allActions: InputAction[] = [
    { a: 'jump' },
    { a: 'dodge' },
    { a: 'reload' },
    { a: 'ability', slot: 'q' },
    { a: 'ability', slot: 'lord' },
    { a: 'interact' },
    { a: 'weapon', slot: 1 },
    { a: 'item', slot: 3 },
    { a: 'drop', slot: 0, what: 'weapon' },
    { a: 'drop', slot: 2, what: 'item' },
    { a: 'command', order: 'charge' },
    { a: 'mark' },
    { a: 'claim', role: 'loyalist' },
    { a: 'quickchat', id: 'needPeach' },
  ];

  it('roundtrips every action type plus history', () => {
    const frame: InputFrame = {
      seq: 70001,
      moveX: -0.5,
      moveZ: 1,
      yaw: 2.9,
      pitch: -0.4,
      buttons: BTN_FIRE | BTN_ADS | BTN_SPRINT,
      actions: allActions,
      aimPoint: { x: 1000.25, y: -3.5, z: 12.125 },
      aimTargetId: 42,
      viewTick: 123456,
    };
    const pkt = decodeInputMsg(
      encodeInputMsg({
        frame,
        history: [
          { seq: 69998, actions: [{ a: 'jump' }] },
          { seq: 70000, actions: [{ a: 'dodge' }, { a: 'reload' }] },
          { seq: 69999, actions: [] }, // empty groups are skipped
        ],
      }),
    );
    const q = quantizeInput(frame);
    expect(pkt.frame.seq).toBe(70001);
    expect(pkt.frame.moveX).toBeCloseTo(q.moveX, 9);
    expect(pkt.frame.moveZ).toBe(1);
    expect(pkt.frame.yaw).toBeCloseTo(q.yaw, 9);
    expect(pkt.frame.pitch).toBeCloseTo(q.pitch, 9);
    expect(pkt.frame.buttons).toBe(frame.buttons);
    expect(pkt.frame.actions).toEqual(allActions);
    expect(pkt.frame.aimPoint).toEqual(frame.aimPoint);
    expect(pkt.frame.aimTargetId).toBe(42);
    expect(pkt.frame.viewTick).toBe(123456);
    expect(pkt.history).toEqual([
      { seq: 69998, actions: [{ a: 'jump' }] },
      { seq: 70000, actions: [{ a: 'dodge' }, { a: 'reload' }] },
    ]);
  });

  it('is compact for an idle frame', () => {
    const bytes = encodeInputMsg({ frame: { seq: 5, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, actions: [] }, history: [] });
    expect(bytes.length).toBeLessThanOrEqual(12);
  });

  it('quantizeInput matches what the host decodes (prediction parity)', () => {
    const frame: InputFrame = { seq: 1, moveX: 0.3333, moveZ: -0.77, yaw: -3.0001, pitch: 0.123456, buttons: 0, actions: [] };
    const decoded = decodeInputMsg(encodeInputMsg({ frame, history: [] })).frame;
    const q = quantizeInput(frame);
    expect(decoded.moveX).toBe(q.moveX);
    expect(decoded.moveZ).toBe(q.moveZ);
    expect(decoded.yaw).toBe(q.yaw);
    expect(decoded.pitch).toBe(q.pitch);
  });

  it('carries unknown future actions as JSON', () => {
    const odd = { a: 'emote', id: 'bow' } as unknown as InputAction;
    const pkt = decodeInputMsg(encodeInputMsg({ frame: { seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, actions: [odd] }, history: [] }));
    expect(pkt.frame.actions).toEqual([odd]);
  });
});

describe('json + primitives', () => {
  it('rounds floats in event payloads and parses safely', () => {
    const text = encodeJson({ t: 'events', tick: 3, events: [{ t: 'explosion', pos: { x: 1.23456789, y: 0, z: -2.5 }, radius: 3, kind: 'frag' }] }, { round: true });
    expect(text).toContain('1.235');
    expect(decodeJson(text)?.t).toBe('events');
    expect(decodeJson('{"nope":1}')).toBeNull();
    expect(decodeJson('garbage')).toBeNull();
  });

  it('varints and strings roundtrip', () => {
    const w = new ByteWriter(4);
    const nums = [0, 1, 127, 128, 300, 65535, 2 ** 31, 2 ** 40 + 7];
    for (const n of nums) w.varuint(n);
    for (const n of [-1, 0, 1, -1000, 123456]) w.varint(n);
    w.str('三国杀 ✓').f32(1.5).i16(-5);
    const r = new ByteReader(w.finish());
    for (const n of nums) expect(r.varuint()).toBe(n);
    for (const n of [-1, 0, 1, -1000, 123456]) expect(r.varint()).toBe(n);
    expect(r.str()).toBe('三国杀 ✓');
    expect(r.f32()).toBe(1.5);
    expect(r.i16()).toBe(-5);
    expect(r.remaining).toBe(0);
  });

  it('string table dedupes and includes content ids', () => {
    const t = new StringTable(['a', 'b', 'a']);
    expect(t.strings).toEqual(['a', 'b']);
    const all = buildMatchStrings(['p1']);
    expect(all).toContain('guanyu');
    expect(all).toContain('lord');
    expect(all).toContain('stun');
    expect(all).toContain('p1');
    expect(new Set(all).size).toBe(all.length);
  });
});
