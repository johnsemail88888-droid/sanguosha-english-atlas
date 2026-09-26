import { describe, expect, it } from 'vitest';
import { QUICKCHAT } from '../../../src/ui/theme';
import { quickChatBubble } from '../../../src/render/vfx/eventVfx';

describe('quick-chat bubbles', () => {
  it('cover every shared quick-chat id in both languages', () => {
    for (const l of QUICKCHAT) {
      expect(quickChatBubble(l.id, 'zh')).toBe(l.zh);
      expect(quickChatBubble(l.id, 'en')).toBe(l.en);
    }
    expect(quickChatBubble('need_peach', 'en')).toBe(quickChatBubble('needPeach', 'en'));
  });

  it('never show a raw id', () => {
    expect(quickChatBubble('some_future_line', 'en')).not.toContain('some_future_line');
    expect(quickChatBubble('some_future_line', 'zh').length).toBeGreaterThan(0);
  });
});
