import { describe, expect, it } from 'vitest';
import { defaultLang, langFrom, urlLang } from '../../../src/game/settings';

describe('language', () => {
  it('reads language tags and link values', () => {
    expect(langFrom('zh')).toBe('zh');
    expect(langFrom('zh-CN')).toBe('zh');
    expect(langFrom('zh-Hant-TW')).toBe('zh');
    expect(langFrom('CN')).toBe('zh');
    expect(langFrom('en')).toBe('en');
    expect(langFrom('en-US')).toBe('en');
    expect(langFrom('fr')).toBe(null);
    expect(langFrom(undefined)).toBe(null);
  });

  it('first run follows the browser / OS language on a page: Chinese → 中文, anything else → English', () => {
    const page = (languages: string[]) => ({ document: {}, navigator: { language: languages[0], languages } });
    expect(defaultLang(page(['zh-CN', 'en']))).toBe('zh');
    expect(defaultLang(page(['en-US']))).toBe('en');
    expect(defaultLang(page(['ja-JP']))).toBe('en');
    expect(defaultLang({ document: {}, navigator: {} })).toBe('zh');
    // Node (tests, tools) has a navigator but no page: the default stays
    expect(defaultLang({ navigator: { language: 'en-US', languages: ['en-US'] } })).toBe('zh');
  });

  it('?lang=zh / ?lang=en links pick the language', () => {
    expect(urlLang('?lang=en')).toBe('en');
    expect(urlLang('?room=ABCD&lang=zh')).toBe('zh');
    expect(urlLang('?room=ABCD')).toBe(null);
    expect(urlLang('?lang=xx')).toBe(null);
  });
});
