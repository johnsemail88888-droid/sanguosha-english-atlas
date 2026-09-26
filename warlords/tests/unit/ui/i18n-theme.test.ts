import { afterEach, describe, expect, it } from 'vitest';
import type { RoleId, StatusId } from '../../../src/core/types';
import { HEROES, ROLES } from '../../../src/data';
import { allKeys, fmtTime, gearName, hasKey, heroName, overrideLang, rawEntry, roleName, t, tx } from '../../../src/ui/i18n';
import {
  CLAIMABLE_ROLES,
  CLAIM_TEXT,
  QUICKCHAT,
  ROLE_GLYPH,
  STATUS_INFO,
  luminance,
  quickChatText,
  roleInk,
  shade,
  statusInfo,
} from '../../../src/ui/theme';

afterEach(() => overrideLang(null));

describe('i18n dictionary', () => {
  it('every key has non-empty zh and en text with the same placeholders', () => {
    for (const key of allKeys()) {
      const [zh, en] = rawEntry(key);
      expect(zh.trim(), key).not.toBe('');
      expect(en.trim(), key).not.toBe('');
      const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(zh), key).toEqual(vars(en));
    }
  });

  it('switches language and interpolates variables', () => {
    overrideLang('zh');
    expect(t('common.seat', { n: 3 })).toBe('3号位');
    expect(tx('中', 'EN')).toBe('中');
    overrideLang('en');
    expect(t('common.seat', { n: 3 })).toBe('Seat 3');
    expect(tx('中', 'EN')).toBe('EN');
    expect(tx('只有中文', '')).toBe('只有中文');
    expect(t('hud.zone.outside', { dps: 8 })).toContain('8');
  });

  it('leaves unknown placeholders untouched', () => {
    overrideLang('en');
    expect(t('common.seat')).toBe('Seat {n}');
  });

  it('hasKey guards dynamic keys', () => {
    expect(hasKey('hud.order.follow')).toBe(true);
    expect(hasKey('hud.order.nope')).toBe(false);
  });

  it('formats match time as m:ss (ceil, never negative)', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(9.2)).toBe('0:10');
    expect(fmtTime(61)).toBe('1:01');
    expect(fmtTime(548)).toBe('9:08');
    expect(fmtTime(-3)).toBe('0:00');
  });

  it('content name helpers fall back to raw ids', () => {
    overrideLang('zh');
    expect(heroName('definitely-not-a-hero')).toBe('definitely-not-a-hero');
    expect(gearName('no-such-gear')).toBe('no-such-gear');
    expect(heroName(undefined)).toBe('');
    const first = HEROES[0];
    expect(heroName(first.id)).toBe(first.nameZh);
    overrideLang('en');
    expect(heroName(first.id)).toBe(first.nameEn);
    expect(roleName('lord')).toBe('Lord');
  });
});

describe('theme vocabulary', () => {
  it('has a seal glyph for every role', () => {
    for (const r of ROLES) expect(ROLE_GLYPH[r.id]).toMatch(/^.$/u);
  });

  it('has an icon for every status id', () => {
    const ids = Object.keys(STATUS_INFO) as StatusId[];
    expect(ids.length).toBeGreaterThanOrEqual(32);
    for (const id of ids) {
      const info = statusInfo(id);
      expect(info, id).toBeDefined();
      expect(info?.glyph.length).toBeGreaterThan(0);
    }
  });

  it('quick-chat ids are unique and translated', () => {
    const ids = QUICKCHAT.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(quickChatText('needPeach', 'zh')).toBe('需要桃！');
    expect(quickChatText('needPeach', 'en')).toBe('I need a Peach!');
    expect(quickChatText('unknown-id', 'en')).toBe('unknown-id');
  });

  it('every claimable role has claim text', () => {
    for (const r of CLAIMABLE_ROLES) expect(CLAIM_TEXT[r as RoleId]).toBeDefined();
  });

  it('shade / luminance / roleInk keep role colors readable on parchment', () => {
    expect(shade('#ffffff', 0.5)).toBe('#808080');
    expect(shade('#000000', 0.5)).toBe('#000000');
    expect(shade('not-a-color', 0.5)).toBe('not-a-color');
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    expect(luminance('#000000')).toBeCloseTo(0, 5);
    for (const r of ROLES) expect(luminance(roleInk(r.id))).toBeLessThan(0.3);
  });
});
