// Single-player setup: player count, mode, bot difficulty, free pick.
import type { BotDifficulty, GameMode, MatchSettings, RoleId } from '../../core/types';
import { ROLE_DISTRIBUTION } from '../../data';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { roleName, t } from '../i18n';
import { button, field, roleSeal, segmented, toggle } from '../widgets';

export interface SinglePrefs {
  playerCount: MatchSettings['playerCount'];
  mode: GameMode;
  botDifficulty: BotDifficulty;
  freePick: boolean;
}

const PREF_KEY = 'sgwl.ui.single.v1';

export function loadSinglePrefs(): SinglePrefs {
  const def: SinglePrefs = { playerCount: 5, mode: 'standard', botDifficulty: 'normal', freePick: false };
  try {
    const raw = globalThis.localStorage?.getItem(PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SinglePrefs>;
      return {
        playerCount: p.playerCount && [5, 6, 7, 8].includes(p.playerCount) ? p.playerCount : def.playerCount,
        mode: p.mode === 'chaos' ? 'chaos' : 'standard',
        botDifficulty: p.botDifficulty === 'easy' || p.botDifficulty === 'hard' ? p.botDifficulty : 'normal',
        freePick: !!p.freePick,
      };
    }
  } catch {
    /* ignore */
  }
  return def;
}

function saveSinglePrefs(p: SinglePrefs): void {
  try {
    globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Seal row previewing the dealt roles (chaos shows every variant). */
export function rolePreview(mode: GameMode, count: 5 | 6 | 7 | 8): HTMLElement {
  const variants = ROLE_DISTRIBUTION[mode]?.[count] ?? [];
  const wrap = h('div', { class: 'sg-role-preview' });
  variants.forEach((roles: RoleId[], i: number) => {
    const row = h('div', { class: 'variant' });
    if (variants.length > 1) row.appendChild(h('span', { class: 'vlabel' }, `${String.fromCharCode(65 + i)}`));
    for (const r of roles) {
      const cell = h('span', { class: 'cell', title: roleName(r) }, roleSeal(r, '1.9em'));
      row.appendChild(cell);
    }
    wrap.appendChild(row);
  });
  return wrap;
}

export function createSingleScreen(ctx: UiCtx): Screen {
  const bag = new Bag();
  const prefs = loadSinglePrefs();
  const el = h('div', { class: 'sg-screen sg-menu-screen sg-single', data: { screen: 'single' } });

  const render = (): void => {
    const preview = h('div', { class: 'preview-slot' }, rolePreview(prefs.mode, prefs.playerCount));
    const refreshPreview = (): void => {
      preview.replaceChildren(rolePreview(prefs.mode, prefs.playerCount));
      modeDesc.textContent = prefs.mode === 'chaos' ? t('single.modeChaosDesc') : t('single.modeStandardDesc');
      saveSinglePrefs(prefs);
    };
    const modeDesc = h('span', null, prefs.mode === 'chaos' ? t('single.modeChaosDesc') : t('single.modeStandardDesc'));
    const start = button(t('single.start'), () => {
      saveSinglePrefs(prefs);
      start.disabled = true;
      ctx.startSingle({ playerCount: prefs.playerCount, mode: prefs.mode, botDifficulty: prefs.botDifficulty, freePick: prefs.freePick });
      // if the session did not advance (error), re-enable
      setTimeout(() => {
        if (el.isConnected) start.disabled = false;
      }, 1500);
    }, { cls: 'big gold', sfx: 'confirm' });

    el.replaceChildren(
      button(`‹ ${t('common.back')}`, () => {
        if (ctx.sessionKind === 'single') ctx.leaveSession(true);
        else ctx.go('title');
      }, { cls: 'ghost small sg-back', sfx: 'back' }),
      h('div', { class: 'sg-sheet sg-panel sg-corners' },
        h('h1', { class: 'sg-h1 sg-title-bar' }, t('single.title')),
        h('div', { class: 'fields' },
          field(t('single.players'),
            segmented([5, 6, 7, 8].map((n) => ({ value: n as 5 | 6 | 7 | 8, label: String(n) })), prefs.playerCount, (v) => {
              prefs.playerCount = v;
              refreshPreview();
            }, { name: t('single.players') })),
          field(t('single.mode'),
            segmented([
              { value: 'standard' as GameMode, label: t('single.modeStandard') },
              { value: 'chaos' as GameMode, label: t('single.modeChaos') },
            ], prefs.mode, (v) => {
              prefs.mode = v;
              refreshPreview();
            }, { name: t('single.mode') }),
            modeDesc),
          field(t('single.botDiff'),
            segmented([
              { value: 'easy' as BotDifficulty, label: t('single.easy') },
              { value: 'normal' as BotDifficulty, label: t('single.normal') },
              { value: 'hard' as BotDifficulty, label: t('single.hard') },
            ], prefs.botDifficulty, (v) => {
              prefs.botDifficulty = v;
              saveSinglePrefs(prefs);
            }, { name: t('single.botDiff') })),
          field(t('single.freePick'), toggle(prefs.freePick, (v) => {
            prefs.freePick = v;
            saveSinglePrefs(prefs);
          }, t('single.freePick')), t('single.freePickDesc')),
          field(t('single.roles'), preview),
        ),
        h('div', { class: 'sg-sheet-actions' }, start),
      ),
    );
  };
  render();
  return { el, relabel: render, dispose: () => bag.dispose() };
}
