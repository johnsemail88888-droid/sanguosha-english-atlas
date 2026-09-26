import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent, MatchPhase } from '../../../src/core/types';
import { MockSession, MockView } from '../../../src/ui/dev/mock';

describe('MockView (dev harness data)', () => {
  it('produces a consistent private view and lively events', () => {
    const v = new MockView({ seed: 3 });
    const me = v.local();
    expect(me).not.toBeNull();
    expect(v.get(v.localId() ?? -1)?.kind).toBe('hero');
    expect(v.players().length).toBe(8);
    expect(v.players().filter((p) => p.entityId === me?.entityId)).toHaveLength(1);
    const first = v.drainEvents();
    expect(first.some((e) => e.t === 'death')).toBe(true);
    expect(v.drainEvents()).toEqual([]);
    const seen: GameEvent[] = [];
    for (let i = 0; i < 600; i++) {
      v.update(1 / 60);
      seen.push(...v.drainEvents());
    }
    expect(seen.some((e) => e.t === 'hit' && e.src === v.localId())).toBe(true);
    expect(v.elapsed()).toBeGreaterThan(186 + 9);
    const z = v.zone();
    expect(z.radius).toBeLessThanOrEqual(150);
    expect(z.radius).toBeGreaterThanOrEqual(z.targetRadius);
    const m = v.local();
    expect(m && m.hp >= 0 && m.hp <= m.maxHp).toBe(true);
  });

  it('supports downed / dead states', () => {
    expect(new MockView({ state: 'downed' }).local()?.downed).toBe(true);
    const dead = new MockView({ state: 'dead' });
    expect(dead.local()?.dead).toBe(true);
    expect(dead.players().find((p) => p.entityId === dead.localId())?.alive).toBe(false);
  });
});

describe('MockSession flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks lobby → roles → hero select → loading → playing', () => {
    const s = new MockSession({ auto: true, isHost: true });
    const phases: MatchPhase[] = [];
    s.on('phase', (p) => phases.push(p));
    let started = false;
    s.on('matchStart', () => {
      started = true;
    });
    expect(s.phase).toBe('lobby');
    s.start();
    expect(s.phase).toBe('roles');
    expect(s.roles?.publicRoles[0]).toBe('lord');
    vi.advanceTimersByTime(4000);
    expect(s.phase).toBe('heroSelect');
    expect(s.heroSelect?.lordPhase).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(s.heroSelect?.lordPhase).toBe(false);
    const option = s.heroSelect?.options[0];
    expect(option).toBeTruthy();
    s.pickHero(option ?? '');
    vi.advanceTimersByTime(4000);
    expect(s.phase).toBe('playing');
    expect(started).toBe(true);
    expect(s.view?.local()?.heroId).toBe(option);
    expect(phases).toEqual(['roles', 'heroSelect', 'loading', 'playing']);
    s.finish('rebel');
    expect(s.phase).toBe('gameOver');
    expect(s.result?.winner).toBe('rebel');
    s.returnToLobby();
    expect(s.phase).toBe('lobby');
  });

  it('host controls mutate the lobby', () => {
    const s = new MockSession({ online: true, isHost: true });
    const before = s.lobby?.seats.length ?? 0;
    s.addBot();
    expect(s.lobby?.seats.length).toBe(before + 1);
    const bot = s.lobby?.seats.find((x) => x.isBot);
    s.removeBot(bot?.seat ?? -1);
    expect(s.lobby?.seats.length).toBe(before);
    s.updateSettings({ playerCount: 6, mode: 'chaos' });
    expect(s.lobby?.settings.mode).toBe('chaos');
    s.leave();
    expect(s.calls).toContain('leave');
  });
});
