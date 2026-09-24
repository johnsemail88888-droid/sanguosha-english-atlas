// ClientView: jitter buffer + interpolation, extrapolation cap, local-hero
// prediction/reconciliation, event release and input redundancy — driven by a
// fake clock and a simulated host.
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import type { GameEvent, InputFrame, PrivateHeroView, Snapshot, ViewEntity } from '../../../src/core/types';
import { BTN_FIRE, emptyInput, INPUT_HZ, SIM_DT } from '../../../src/core/types';
import { ClientView, EXTRAPOLATION_CAP, SMOOTH_DISTANCE, SNAP_DISTANCE } from '../../../src/net/clientView';
import type { InputPacket } from '../../../src/net/protocol';
import { emptyZone } from '../../../src/net/interp';
import { buildCollisionWorld, forcedMove, predictMove, type MoveState } from '../../../src/sim/physics';
import { flatMap } from './fixtures';

const map = flatMap();

function heroEnt(id: number, x: number, z: number, extra: Partial<ViewEntity> = {}): ViewEntity {
  return { id, kind: 'hero', sub: 'guanyu', x, y: 0, z, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0, ...extra };
}

function you(id: number, extra: Partial<PrivateHeroView> = {}): PrivateHeroView {
  return {
    entityId: id,
    heroId: 'guanyu',
    role: 'rebel',
    hp: 400,
    maxHp: 400,
    shield: 0,
    weapons: [null, null],
    activeSlot: 0,
    items: [null, null, null, null],
    armor: null,
    mount: null,
    cooldowns: {},
    charges: {},
    abilityState: {},
    dodgeCharges: 2,
    reloading: 0,
    channel: null,
    downed: false,
    downedRemaining: 0,
    dead: false,
    statuses: [],
    squad: [],
    order: { kind: 'follow' },
    stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
    ...extra,
  };
}

function snap(tick: number, ents: ViewEntity[], extra: Partial<Snapshot> = {}): Snapshot {
  return { tick, time: tick * SIM_DT, ackSeq: 0, ents, zone: emptyZone(), you: null, players: [], elapsed: tick * SIM_DT, ...extra };
}

class Clock {
  t = 100;
  now = (): number => this.t;
}

describe('remote interpolation', () => {
  it('renders a moving entity smoothly INTERP_DELAY in the past despite jitter', () => {
    const clock = new Clock();
    const view = new ClientView({ map, localEntityId: null, sendInput: () => {}, now: clock.now });
    const rng = new Rng(3);
    const speed = 5;
    const deliveries: { at: number; s: Snapshot }[] = [];
    // host produces a snapshot every 1.5 ticks (20 Hz); latency 60 ms ± 20 ms jitter
    for (let tick = 0; tick <= 300; tick += 1.5) {
      const t = Math.round(tick);
      const hostTime = t * SIM_DT;
      deliveries.push({ at: 100 + hostTime + 0.06 + rng.range(-0.02, 0.02), s: snap(t, [heroEnt(7, speed * hostTime, 0)]) });
    }
    deliveries.sort((a, b) => a.at - b.at);
    let di = 0;
    let lastX = -Infinity;
    const steps: number[] = [];
    for (let frame = 0; frame < 60 * 8; frame++) {
      clock.t += 1 / 60;
      while (di < deliveries.length && deliveries[di].at <= clock.t) view.onSnapshot(deliveries[di++].s);
      view.update(1 / 60);
      const e = view.get(7);
      if (!e || frame < 60) continue; // warm-up
      // linear motion is reproduced exactly at the render clock
      expect(Math.abs(e.x - speed * view.elapsed())).toBeLessThan(1e-6);
      expect(e.x).toBeGreaterThanOrEqual(lastX); // never goes backwards
      if (lastX > -Infinity) steps.push(e.x - lastX);
      lastX = e.x;
      // always inside the buffer: interpolating, never extrapolating
      const info = view.debugInfo();
      expect(info.renderLag).toBeGreaterThan(0);
      expect(info.renderLag).toBeLessThan(0.2);
      expect(view.stats.extrapolating).toBe(false);
    }
    // per-frame motion stays close to speed/60 (no stutter): slewing is ≤ 10 %
    for (const d of steps) {
      expect(d).toBeGreaterThan((speed / 60) * 0.85);
      expect(d).toBeLessThan((speed / 60) * 1.15);
    }
    expect(view.stats.extrapolating).toBe(false);
  });

  it('extrapolates for at most 250 ms when snapshots stop', () => {
    const clock = new Clock();
    const view = new ClientView({ map, localEntityId: null, sendInput: () => {}, now: clock.now });
    let lastX = 0;
    for (let tick = 0; tick <= 60; tick += 1.5) {
      const t = Math.round(tick);
      clock.t = 100 + t * SIM_DT + 0.05;
      lastX = 4 * t * SIM_DT;
      view.onSnapshot(snap(t, [heroEnt(1, lastX, 0)]));
      view.update(1 / 20);
    }
    for (let i = 0; i < 120; i++) {
      clock.t += 1 / 60;
      view.update(1 / 60);
    }
    const e = view.get(1)!;
    expect(view.stats.extrapolating).toBe(true);
    expect(e.x).toBeGreaterThan(lastX);
    expect(e.x).toBeLessThanOrEqual(lastX + 4 * EXTRAPOLATION_CAP + 0.05);
  });

  it('releases events with the render clock, local events immediately, and ticks HUD timers down', () => {
    const clock = new Clock();
    const view = new ClientView({ map, localEntityId: 5, sendInput: () => {}, now: clock.now });
    view.onSnapshot(snap(0, [heroEnt(5, 0, 0)], { you: you(5, { cooldowns: { q: 2 } }) }));
    view.update(0);
    const shot: GameEvent = { t: 'shot', src: 9, weapon: 'carbine', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } };
    const mine: GameEvent = { t: 'shot', src: 5, weapon: 'carbine', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } };
    view.onEvents(30, [shot, mine]);
    expect(view.drainEvents()).toEqual([mine]);
    clock.t += 0.1;
    view.update(0.1);
    expect(view.drainEvents()).toEqual([]); // render clock is still far behind tick 30
    clock.t += 0.2;
    view.update(0.2);
    expect(view.drainEvents()).toEqual([shot]); // max delay reached
    expect(view.local()?.cooldowns.q).toBeCloseTo(2 - 0.3, 5);
  });
});

describe('local prediction', () => {
  /** Simulated host: one input per tick (like HostSession), snapshots at 20 Hz, symmetric latency. */
  function simulate(opts: { seconds: number; latency: number; teleportAt?: { t: number; dx: number } }) {
    const clock = new Clock();
    const cw = buildCollisionWorld(map);
    const inFlight: { at: number; pkt: InputPacket }[] = [];
    const toClient: { at: number; s: Snapshot }[] = [];
    const view = new ClientView({
      map,
      localEntityId: 1,
      sendInput: (pkt) => inFlight.push({ at: clock.t + opts.latency, pkt }),
      now: clock.now,
    });
    const st: MoveState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
    const queue: InputFrame[] = [];
    let ack = 0;
    let tick = 0;
    let hostAcc = 0;
    let snapAcc = 0;
    let latest: InputFrame = emptyInput();
    const displayed: { t: number; x: number; z: number }[] = [];
    const mods = { speedMul: 1, canSprint: true, canJump: true, rooted: false, ads: false, downed: false };
    let teleported = false;
    const frameDt = 1 / 60;
    for (let f = 0; f < opts.seconds * 60; f++) {
      clock.t += frameDt;
      // host side
      for (let i = inFlight.length - 1; i >= 0; i--) {
        if (inFlight[i].at <= clock.t) {
          queue.push(inFlight[i].pkt.frame);
          inFlight.splice(i, 1);
        }
      }
      queue.sort((a, b) => a.seq - b.seq);
      hostAcc += frameDt;
      while (hostAcc >= SIM_DT) {
        hostAcc -= SIM_DT;
        const next = queue.shift();
        if (next) {
          latest = next;
          ack = next.seq;
        }
        predictMove(cw, st, latest, SIM_DT, mods);
        tick++;
        if (opts.teleportAt && !teleported && tick * SIM_DT >= opts.teleportAt.t) {
          st.pos.x += opts.teleportAt.dx;
          teleported = true;
        }
        snapAcc += 20 / 30;
        if (snapAcc >= 1) {
          snapAcc -= 1;
          toClient.push({
            at: clock.t + opts.latency,
            s: snap(tick, [heroEnt(1, st.pos.x, st.pos.z)], {
              ackSeq: ack,
              you: you(1, { vel: { ...st.vel }, onGround: true, moveMods: { speedMul: 1, canSprint: true, canJump: true, rooted: false } }),
            }),
          });
        }
      }
      // client side
      while (toClient.length && toClient[0].at <= clock.t) view.onSnapshot(toClient.shift()!.s);
      view.pushInput({ ...emptyInput(), moveZ: 1, moveX: 0.5, yaw: 0.3 });
      view.update(frameDt);
      const e = view.get(1);
      if (e) displayed.push({ t: clock.t, x: e.x, z: e.z });
    }
    return { view, st, displayed };
  }

  it('predicts ahead of the authoritative state with ~zero reconciliation error', () => {
    const { view, st, displayed } = simulate({ seconds: 3, latency: 0.08 });
    const last = displayed[displayed.length - 1];
    // moving towards -z (yaw 0.3 forward): the prediction includes inputs still in
    // flight, so it is ahead even of the host's current state
    expect(last.z).toBeLessThan(st.pos.z);
    expect(view.stats.lastError).toBeLessThan(0.02);
    expect(view.debugInfo().pendingInputs).toBeGreaterThan(2); // RTT worth of unacked inputs
    expect(view.debugInfo().pendingInputs).toBeLessThan(15);
    expect(view.stats.inputsSent).toBeGreaterThan(3 * INPUT_HZ * 0.9);
    // smooth: consecutive frames never jump
    for (let i = 1; i < displayed.length; i++) {
      const d = Math.hypot(displayed[i].x - displayed[i - 1].x, displayed[i].z - displayed[i - 1].z);
      expect(d).toBeLessThan(0.2);
    }
  });

  it('smooths a small server correction instead of snapping', () => {
    const { displayed } = simulate({ seconds: 3, latency: 0.05, teleportAt: { t: 1.5, dx: 1.5 } });
    for (let i = 1; i < displayed.length; i++) {
      const d = Math.hypot(displayed[i].x - displayed[i - 1].x, displayed[i].z - displayed[i - 1].z);
      expect(d).toBeLessThan(0.45); // 1.5 m correction spread over several frames
    }
    // converged: x offset fully applied by the end (moveX 0.5 drift + 1.5 m teleport)
    const end = displayed[displayed.length - 1];
    const before = displayed.find((p) => p.t > 101.4)!;
    expect(end.x - before.x).toBeGreaterThan(1.5);
  });

  it('snaps a large correction (teleport)', () => {
    const { displayed } = simulate({ seconds: 3, latency: 0.05, teleportAt: { t: 1.5, dx: 20 } });
    let maxStep = 0;
    for (let i = 1; i < displayed.length; i++) {
      maxStep = Math.max(maxStep, Math.hypot(displayed[i].x - displayed[i - 1].x, displayed[i].z - displayed[i - 1].z));
    }
    expect(maxStep).toBeGreaterThan(15);
  });

  it('sends inputs at INPUT_HZ and repeats edge actions in the next 3 packets', () => {
    const clock = new Clock();
    const sent: InputPacket[] = [];
    const view = new ClientView({ map, localEntityId: 1, sendInput: (p) => sent.push(p), now: clock.now });
    for (let f = 0; f < 60; f++) {
      clock.t += 1 / 60;
      view.pushInput({ ...emptyInput(), actions: f === 10 ? [{ a: 'jump' }] : [] });
      view.update(1 / 60);
    }
    expect(sent.length).toBeGreaterThanOrEqual(29);
    expect(sent.length).toBeLessThanOrEqual(31);
    const withJump = sent.filter((p) => p.frame.actions.some((a) => a.a === 'jump'));
    expect(withJump).toHaveLength(1);
    const jumpSeq = withJump[0].frame.seq;
    const echoes = sent.filter((p) => p.history.some((h) => h.seq === jumpSeq && h.actions.some((a) => a.a === 'jump')));
    expect(echoes.map((p) => p.frame.seq)).toEqual([jumpSeq + 1, jumpSeq + 2, jumpSeq + 3]);
    for (let i = 1; i < sent.length; i++) expect(sent[i].frame.seq).toBe(sent[i - 1].frame.seq + 1);
    expect(sent[sent.length - 1].frame.viewTick).toBeDefined();
  });
});

describe('large corrections', () => {
  it('blends a mid-size correction over ~100 ms instead of snapping (e.g. an unpredicted dash)', () => {
    // reuse the prediction harness: a 7 m server-side shove
    const clock = new Clock();
    const view = new ClientView({ map, localEntityId: 1, sendInput: () => {}, now: clock.now });
    let tick = 0;
    const feed = (x: number) => {
      tick += 2;
      clock.t += 2 * SIM_DT;
      view.onSnapshot(snap(tick, [heroEnt(1, x, 0)], { ackSeq: 1_000_000, you: you(1) }));
    };
    feed(0);
    view.update(1 / 60);
    feed(0);
    view.update(1 / 60);
    expect(view.get(1)!.x).toBeCloseTo(0, 3);
    feed(7); // > SMOOTH_DISTANCE, < SNAP_DISTANCE
    expect(7).toBeGreaterThan(SMOOTH_DISTANCE);
    expect(7).toBeLessThan(SNAP_DISTANCE);
    const xs: number[] = [];
    for (let f = 0; f < 12; f++) {
      clock.t += 1 / 60;
      view.update(1 / 60);
      xs.push(view.get(1)!.x);
    }
    expect(xs[0]).toBeLessThan(5); // not snapped in one frame
    const after100ms = xs[5];
    expect(after100ms).toBeGreaterThan(6.4); // ≥ ~92 % blended within ~100 ms
    expect(xs[xs.length - 1]).toBeCloseTo(7, 1);
  });
});

describe('forced movement prediction', () => {
  /** Host with a dash at `dashAt`; snapshots optionally report `you.forced`. Returns the reconciliation errors. */
  function simulateDash(reportForced: boolean) {
    const clock = new Clock();
    const cw = buildCollisionWorld(map);
    const latency = 0.08;
    const inFlight: { at: number; pkt: InputPacket }[] = [];
    const toClient: { at: number; s: Snapshot }[] = [];
    const view = new ClientView({ map, localEntityId: 1, sendInput: (pkt) => inFlight.push({ at: clock.t + latency, pkt }), now: clock.now });
    const st: MoveState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };
    const queue: InputFrame[] = [];
    const mods = { speedMul: 1, canSprint: true, canJump: true, rooted: false, ads: false, downed: false };
    let ack = 0;
    let tick = 0;
    let hostAcc = 0;
    let snapAcc = 0;
    let latest: InputFrame = emptyInput();
    const dash = { at: 1.5, vx: 24, vz: 0, duration: 0.5 };
    let forcedUntil = -1;
    const errors: { t: number; err: number }[] = [];
    for (let f = 0; f < 3 * 60; f++) {
      clock.t += 1 / 60;
      for (let i = inFlight.length - 1; i >= 0; i--) {
        if (inFlight[i].at <= clock.t) {
          queue.push(inFlight[i].pkt.frame);
          inFlight.splice(i, 1);
        }
      }
      queue.sort((a, b) => a.seq - b.seq);
      hostAcc += 1 / 60;
      while (hostAcc >= SIM_DT) {
        hostAcc -= SIM_DT;
        const next = queue.shift();
        if (next) {
          latest = next;
          ack = next.seq;
        }
        const now = tick * SIM_DT;
        if (forcedUntil < 0 && now >= dash.at) forcedUntil = now + dash.duration;
        if (now < forcedUntil) forcedMove(cw, st, dash.vx, dash.vz, SIM_DT);
        else predictMove(cw, st, latest, SIM_DT, mods);
        tick++;
        snapAcc += 20 / 30;
        if (snapAcc >= 1) {
          snapAcc -= 1;
          const time = tick * SIM_DT;
          const y = you(1, { vel: { ...st.vel }, onGround: true, moveMods: { speedMul: 1, canSprint: true, canJump: true, rooted: false } });
          if (reportForced && time < forcedUntil) y.forced = { vel: { x: dash.vx, y: 0, z: dash.vz }, remaining: forcedUntil - time };
          toClient.push({ at: clock.t + latency, s: snap(tick, [heroEnt(1, st.pos.x, st.pos.z)], { ackSeq: ack, you: y }) });
        }
      }
      while (toClient.length && toClient[0].at <= clock.t) {
        const s = toClient.shift()!;
        view.onSnapshot(s.s);
        errors.push({ t: s.s.time, err: view.stats.lastError });
      }
      view.pushInput({ ...emptyInput(), moveZ: 1, yaw: Math.PI / 2 }); // walking along +x... (yaw π/2 → forward = -x)
      view.update(1 / 60);
    }
    return { errors, dash };
  }

  it('replays reported dashes: after the first snapshot that reveals it, prediction stays exact', () => {
    const { errors, dash } = simulateDash(true);
    const during = errors.filter((e) => e.t > dash.at + 0.1 && e.t < dash.at + dash.duration + 0.4);
    expect(during.length).toBeGreaterThan(8);
    // the first reveal costs one correction (the client learns of the dash one RTT late) …
    const reveal = errors.find((e) => e.t > dash.at)!;
    expect(reveal.err).toBeGreaterThan(0.5);
    // … then the dash and its end are predicted exactly
    for (const e of during) expect(e.err).toBeLessThan(0.05);
  });

  it('without forced info every snapshot during the dash corrects the prediction', () => {
    const { errors, dash } = simulateDash(false);
    const during = errors.filter((e) => e.t > dash.at + 0.1 && e.t < dash.at + dash.duration);
    // every snapshot during the dash corrects by 0.3–0.8 m (rubber-banding)
    expect(during.length).toBeGreaterThan(6);
    for (const e of during) expect(e.err).toBeGreaterThan(0.25);
  });
});

describe('input release', () => {
  it('releaseInput sends a neutral frame at once, keeping the aim; suspended views ignore input', () => {
    const clock = new Clock();
    const sent: InputPacket[] = [];
    const view = new ClientView({ map, localEntityId: 1, sendInput: (p) => sent.push(p), now: clock.now });
    view.pushInput({ ...emptyInput(), moveZ: 1, moveX: -0.5, yaw: 1.1, pitch: 0.2, buttons: BTN_FIRE, actions: [{ a: 'reload' }] });
    clock.t += 1 / 30;
    view.update(1 / 30);
    expect(sent).toHaveLength(1);
    view.setSuspended(true); // tab hidden: no render frame needed
    expect(sent).toHaveLength(2);
    const f = sent[1].frame;
    expect([f.moveX, f.moveZ, f.buttons]).toEqual([0, 0, 0]);
    expect(f.yaw).toBeCloseTo(1.1, 3);
    expect(f.pitch).toBeCloseTo(0.2, 3);
    expect(f.seq).toBe(sent[0].frame.seq + 1);
    // input while hidden is ignored; frames keep being neutral
    view.pushInput({ ...emptyInput(), moveZ: 1, buttons: BTN_FIRE, actions: [{ a: 'jump' }] });
    clock.t += 1 / 30;
    view.update(1 / 30);
    expect(sent[2].frame.moveZ).toBe(0);
    expect(sent[2].frame.actions).toEqual([]);
    view.setSuspended(false);
    view.pushInput({ ...emptyInput(), moveZ: 1 });
    clock.t += 1 / 30;
    view.update(1 / 30);
    expect(sent[sent.length - 1].frame.moveZ).toBe(1);
  });

  it('does not send anything before the first input (no aim to keep)', () => {
    const sent: InputPacket[] = [];
    const view = new ClientView({ map, localEntityId: 1, sendInput: (p) => sent.push(p), now: () => 0 });
    view.releaseInput();
    view.setSuspended(true);
    expect(sent).toHaveLength(0);
  });
});

describe('pooled output', () => {
  it('reuses one object per entity across frames and drops entities that left', () => {
    const clock = new Clock();
    const view = new ClientView({ map, localEntityId: null, sendInput: () => {}, now: clock.now });
    for (let t = 0; t <= 12; t += 2) {
      clock.t = 100 + t * SIM_DT + 0.05;
      const ents = [heroEnt(1, t * 0.1, 0), heroEnt(2, 0, t * 0.1, { weapon: 'carbine' })];
      if (t >= 8) ents.pop(); // entity 2 despawns
      view.onSnapshot(snap(t, ents));
    }
    clock.t = 100 + 4 * SIM_DT + 0.05 + 0.1;
    view.update(1 / 60);
    const list = view.entities();
    const e1 = view.get(1)!;
    const e2 = view.get(2)!;
    expect(e2.weapon).toBe('carbine');
    clock.t += 1 / 60;
    view.update(1 / 60);
    expect(view.entities()).toBe(list); // same array
    expect(view.get(1)).toBe(e1); // same object, updated in place
    // advance the render clock past the despawn
    for (let i = 0; i < 30; i++) {
      clock.t += 1 / 60;
      view.update(1 / 60);
    }
    expect(view.get(2)).toBeUndefined();
    expect(view.entities().map((e) => e.id)).toEqual([1]);
    expect(e2.id).toBe(2); // a retained reference keeps its last state
  });
});
