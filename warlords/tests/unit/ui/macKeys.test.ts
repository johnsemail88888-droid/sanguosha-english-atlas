// Mac players: the controls in Mac words (⌥ for 闪避, the trackpad's two-finger click)
// and the notes on the macOS / Safari shortcuts the game keys meet. (One weapon switch
// per trackpad / Magic Mouse swipe: tests/unit/game/wheel.test.ts.)
import { afterEach, describe, expect, it } from 'vitest';
import { KEY_MAP } from '../../../src/game/input';
import { overrideLang } from '../../../src/ui/i18n';
import { CONTROLS, MAC_NOTES, controlsFor } from '../../../src/ui/screens/help';

afterEach(() => overrideLang(null));

describe('the controls table on a Mac', () => {
  it('elsewhere: unchanged', () => {
    expect(controlsFor(false)).toBe(CONTROLS);
  });

  it('⌥ Option first for 闪避 (⌃ Control + click is a right-click), the trackpad for 右键, B for the missing middle button', () => {
    const mac = controlsFor(true);
    expect(mac).toHaveLength(CONTROLS.length);
    const dodge = mac.find((c) => c.zh.startsWith('闪避翻滚'))!;
    expect(dodge.keys[0]).toBe('⌥ Option');
    expect(dodge.zh).toContain('⌃+点击会变成右键');
    expect(mac.some((c) => c.keys.includes('Ctrl'))).toBe(false);
    expect(mac.find((c) => c.keys[0] === '右键')!.zh).toContain('双指点按');
    expect(mac.find((c) => c.keys.includes('中键'))!.zh).toContain('按 B');
    // the same rows, in the same order: only the wording changes
    expect(mac.map((c) => c.zh.slice(0, 2))).toEqual(CONTROLS.map((c) => c.zh.slice(0, 2)));
  });

  it('the notes: trackpad, ⌃ shortcuts, ⌘W / ⌘Q, fn + F3 (or the settings toggle)', () => {
    const zh = MAC_NOTES.map((n) => n.zh).join(' ');
    expect(zh).toContain('触控板：双指点按 = 右键瞄准；建议使用鼠标');
    expect(zh).toContain('⌃+空格会切换输入法');
    expect(zh).toMatch(/⌘W.*⌘Q/);
    expect(zh).toContain('fn + F3');
    expect(zh).toContain('显示帧率');
    for (const n of MAC_NOTES) expect(n.en.length).toBeGreaterThan(10);
  });

  it('the advice holds: ⌥ (Alt) is a dodge key, and no game key needs ⌘ or an F-key', () => {
    expect(KEY_MAP.AltLeft).toMatchObject({ kind: 'action', action: { a: 'dodge' } });
    expect(KEY_MAP.AltRight).toMatchObject({ kind: 'action', action: { a: 'dodge' } });
    expect(Object.keys(KEY_MAP).filter((k) => /^(Meta|OS|F\d+$)/.test(k))).toEqual([]);
  });
});
