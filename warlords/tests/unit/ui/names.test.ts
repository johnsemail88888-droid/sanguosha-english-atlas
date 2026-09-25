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
  });
  it('shows the generated default name 无名N in the viewer language', () => {
    expect(displayName('无名592', 'en')).toBe('Nameless 592');
    expect(displayName('无名592', 'zh')).toBe('无名592');
    // only the generated form: a chosen name that merely starts with 无名 stays
    expect(displayName('无名英雄', 'en')).toBe('无名英雄');
  });
});
