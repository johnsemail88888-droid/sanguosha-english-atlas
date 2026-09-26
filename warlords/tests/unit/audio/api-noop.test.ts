import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../../src/core/types';
import { VF_DODGING, VF_FIRING, VF_OPENED, VF_RELOADING } from '../../../src/core/types';
import { AudioEngine, audio, hasWebAudio } from '../../../src/audio';
import { UI_SOUNDS } from '../../../src/audio/recipes/ui';
import { fakeView } from '../../../src/audio/render';

const ALL_EVENTS: GameEvent[] = [
  { t: 'shot', src: 1, weapon: 'qinglong', from: { x: 0, y: 1, z: 0 }, to: { x: 5, y: 1, z: 5 } },
  { t: 'shot', src: 2, weapon: 'unknown_gun', from: { x: 0, y: 1, z: 0 }, to: { x: 5, y: 1, z: 5 }, hit: 1 },
  { t: 'hit', target: 1, src: 2, amount: 30, dtype: 'normal', pos: { x: 0, y: 1, z: 0 }, head: true },
  { t: 'hit', target: 1, amount: 0, dtype: 'normal', pos: { x: 0, y: 1, z: 0 }, blocked: 'shield' },
  { t: 'explosion', pos: { x: 1, y: 0, z: 1 }, radius: 5, kind: 'fire' },
  { t: 'melee', src: 1, pos: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, range: 3, arc: 1 },
  { t: 'ability', src: 1, ability: 'guanyu_qinglong' },
  { t: 'status', target: 1, status: 'stun', on: true },
  { t: 'heal', target: 1, amount: 80 },
  { t: 'downed', target: 1 },
  { t: 'revived', target: 1 },
  { t: 'death', target: 2, killer: 1, kind: 'hero' },
  { t: 'pickup', who: 1, item: 'tao' },
  { t: 'itemUse', who: 1, item: 'tao' },
  { t: 'reward', who: 1, kind: 'rebelKill' },
  { t: 'zone', phase: 1, center: { x: 0, y: 0, z: 0 }, radius: 160, targetRadius: 100, shrinkStart: 0, shrinkEnd: 60 },
  { t: 'airdrop', pos: { x: 0, y: 0, z: 0 }, id: 99 },
  { t: 'claim', who: 1, role: 'loyalist' },
  { t: 'quickchat', who: 2, id: 'help' },
  { t: 'chat', from: 'x', text: 'hi' },
  { t: 'command', who: 1, order: 'attack' },
  { t: 'announce', zh: '注意', en: 'Warning', kind: 'warn' },
  { t: 'sfx', name: 'crate_open', pos: { x: 0, y: 0, z: 0 } },
  { t: 'sfx', name: 'nonsense' },
  {
    t: 'gameOver',
    result: { winner: 'lord', winners: [1], roles: {}, reasonZh: '', reasonEn: '', durationSec: 1 },
  },
];

describe('audio API without WebAudio (Node)', () => {
  it('reports no WebAudio in Node', () => {
    expect(hasWebAudio()).toBe(false);
  });

  it('exposes a singleton AudioEngine', () => {
    expect(audio).toBeInstanceOf(AudioEngine);
    expect(audio.stats().state).toBe('unavailable');
    expect(audio.ready).toBe(false);
  });

  it('every method is a safe no-op', async () => {
    const eng = new AudioEngine();
    await expect(eng.unlock()).resolves.toBeUndefined();
    await expect(eng.unlock()).resolves.toBeUndefined();
    const view = fakeView(
      [
        { id: 1, kind: 'hero', sub: 'guanyu', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 5, hp: 1, maxHp: 1, shield: 0, flags: VF_FIRING | VF_DODGING | VF_RELOADING, weapon: 'zhuque' },
        { id: 3, kind: 'crate', sub: '1', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: VF_OPENED },
      ],
      1,
    );
    expect(() => {
      eng.setListener({ x: 1, y: 2, z: 3 }, 0.5, -0.2);
      eng.setListener({ x: NaN, y: 0, z: 0 }, NaN, NaN);
      eng.handleEvents(ALL_EVENTS, view);
      eng.handleEvents([], view);
      eng.localFire('qinglong');
      eng.localFire('');
      eng.dryFire();
      for (const u of UI_SOUNDS) eng.ui(u);
      eng.music('menu');
      eng.music('battle');
      eng.music('victory');
      eng.music('defeat');
      eng.music(null);
      eng.setIntensity(0.7);
      eng.setIntensity(Number.NaN);
      eng.setDowned(true);
      eng.setDowned(false);
      eng.speak('关羽在此，尔等受死！');
      eng.speak('');
      eng.loop('k', 'fire');
      expect(eng.play('gun', { variant: 'rifle' })).toBeNull();
      eng.dispose();
      eng.dispose();
    }).not.toThrow();
    await expect(eng.unlock()).resolves.toBeUndefined();
  });

  it('tolerates malformed input', () => {
    const eng = new AudioEngine();
    expect(() => {
      eng.handleEvents(undefined as unknown as GameEvent[], undefined as unknown as ReturnType<typeof fakeView>);
      eng.handleEvents([{ t: 'bogus' } as unknown as GameEvent], fakeView([], null));
    }).not.toThrow();
  });
});
