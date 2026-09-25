import { describe, expect, it } from 'vitest';
import { displayName } from '../../../src/game/names';

describe('displayName', () => {
  it('shows host-named bots in the viewer language', () => {
    expect(displayName('人机3', 'en')).toBe('Bot 3');
    expect(displayName('人机3', 'zh')).toBe('人机3');
  });
  it('leaves human names alone', () => {
    expect(displayName('人机爱好者', 'en')).toBe('人机爱好者');
    expect(displayName('Alice', 'en')).toBe('Alice');
    expect(displayName('无名592', 'en')).toBe('无名592');
  });
});
