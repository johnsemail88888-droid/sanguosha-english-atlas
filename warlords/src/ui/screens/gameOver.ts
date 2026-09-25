// Game over: victory / defeat for your side, every role revealed in a seat
// table with heroes, stats, MVP, and navigation back to the lobby / title.
import type { EntityId, GameResult, PublicPlayerView, RoleId } from '../../core/types';
import { HERO_BY_ID } from '../../data';
import type { GameSession } from '../../game/session';
import type { ViewSource } from '../../render/view';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { fmtTime, getLang, heroName, roleName, t, tx } from '../i18n';
import { displayName } from '../../game/names';
import { roleInk } from '../theme';
import { heroIcon, roleSeal, seal } from '../widgets';
import { roleCardBadge } from '../artIcons';

export interface OverRow {
  entityId: EntityId;
  seat: number;
  name: string;
  heroId: string;
  role: RoleId | undefined;
  kills: number;
  won: boolean;
  mvp: boolean;
  isMe: boolean;
  isBot: boolean;
}

export type Outcome = 'victory' | 'defeat' | 'draw';

export function outcomeFor(result: GameResult, me: EntityId | null | undefined): Outcome {
  if (result.winner === 'draw') return 'draw';
  return me !== null && me !== undefined && result.winners.includes(me) ? 'victory' : 'defeat';
}

export function buildOverRows(result: GameResult, players: readonly PublicPlayerView[], me: EntityId | null | undefined): OverRow[] {
  const rows: OverRow[] = players.map((p) => ({
    entityId: p.entityId,
    seat: p.seat,
    name: displayName(p.name, getLang()),
    heroId: p.heroId,
    role: result.roles[p.entityId] ?? p.role,
    kills: p.kills,
    won: result.winners.includes(p.entityId),
    mvp: result.mvp === p.entityId,
    isMe: p.entityId === me,
    isBot: p.isBot,
  }));
  // entities with a role but no player row (should not happen, but stay robust)
  for (const [idStr, role] of Object.entries(result.roles)) {
    const id = Number(idStr);
    if (!rows.some((r) => r.entityId === id)) {
      rows.push({ entityId: id, seat: rows.length, name: `#${id}`, heroId: '', role, kills: 0, won: result.winners.includes(id), mvp: result.mvp === id, isMe: id === me, isBot: true });
    }
  }
  return rows.sort((a, b) => a.seat - b.seat);
}

function factionLabel(w: GameResult['winner']): string {
  return t(w === 'lord' ? 'faction.lord' : w === 'rebel' ? 'faction.rebel' : w === 'traitor' ? 'faction.traitor' : w === 'neutral' ? 'faction.neutral' : 'faction.draw');
}

export function createGameOverScreen(ctx: UiCtx, session: GameSession, view: ViewSource | null): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-over', data: { screen: 'gameOver' } });
  let playedSfx = false;

  const render = (): void => {
    const result = session.result;
    if (!result) {
      el.replaceChildren(h('div', { class: 'sg-center' }, h('span', { class: 'sg-spinner' })));
      return;
    }
    const players = view?.players() ?? [];
    const me = view?.localId() ?? players.find((p) => p.playerId === session.myId)?.entityId ?? null;
    const outcome = outcomeFor(result, me);
    const rows = buildOverRows(result, players, me);
    const stats = view?.local()?.stats;
    const mvpRow = rows.find((r) => r.mvp);
    el.dataset.outcome = outcome;
    if (!playedSfx) {
      playedSfx = true;
      ctx.sfx(outcome === 'victory' ? 'reveal' : 'flip');
    }

    const glyph = outcome === 'victory' ? '胜' : outcome === 'defeat' ? '败' : '和';
    const big = h('div', { class: 'over-banner' },
      seal(glyph, { size: '5.4em', color: outcome === 'victory' ? '#b3261e' : outcome === 'defeat' ? '#3b3530' : '#8c6a26' }),
      h('div', { class: 'ob-text' },
        h('div', { class: 'ob-title' }, t(outcome === 'victory' ? 'over.victory' : outcome === 'defeat' ? 'over.defeat' : 'over.draw')),
        h('div', { class: 'ob-reason' }, tx(result.reasonZh, result.reasonEn)),
        h('div', { class: 'ob-meta sg-mute' }, t('over.winners', { faction: factionLabel(result.winner) }), ' · ', t('over.duration', { t: fmtTime(result.durationSec) })),
      ),
    );

    const table = h('table', { class: 'sg-table over-table' },
      h('thead', null, h('tr', null,
        h('th', null, '#'),
        h('th', null, t('score.hero')),
        h('th', null, t('score.player')),
        h('th', null, t('score.role')),
        h('th', { class: 'num' }, t('score.kills')),
        h('th', null, ''),
      )),
      h('tbody', null, rows.map((r) => {
        const def = HERO_BY_ID[r.heroId];
        const tr = h('tr', { class: `${r.isMe ? 'me' : ''}${r.won ? ' won' : ''}` },
          h('td', { class: 'num' }, String(r.seat + 1)),
          h('td', null, h('span', { class: 'hero-cell' }, heroIcon(ctx.portraits, r.heroId || undefined, def?.kingdom, '1.5em'), h('span', null, heroName(r.heroId) || '—'))),
          h('td', null, r.name, r.isBot ? h('span', { class: 'sg-chip bot' }, t('common.bot')) : null, r.isMe ? h('span', { class: 'you' }, tx(`（${t('common.you')}）`, ` (${t('common.you')})`)) : null),
          h('td', null, r.role ? roleCell(r.role) : '—'),
          h('td', { class: 'num' }, String(r.kills)),
          h('td', null, h('span', { class: `res ${r.won ? 'w' : 'l'}` }, r.won ? t('over.won') : t('over.lost')), r.mvp ? h('span', { class: 'mvp' }, 'MVP') : null),
        );
        return tr;
      })),
    );

    const statBox = stats
      ? h('div', { class: 'over-stats' },
          h('h3', { class: 'sg-h3' }, t('score.yourStats')),
          h('div', { class: 'stat-row' },
            statCell(t('stat.kills'), stats.kills),
            statCell(t('stat.damage'), Math.round(stats.damage)),
            statCell(t('stat.healing'), Math.round(stats.healing)),
            statCell(t('stat.rescues'), stats.rescues),
          ),
        )
      : null;

    const mvpBox = mvpRow
      ? h('div', { class: 'over-mvp' },
          h('div', { class: 'mvp-card' }, mvpRow.heroId ? ctx.portraits.layer(mvpRow.heroId, 256) : null),
          h('div', null, h('div', { class: 'lbl' }, t('over.mvp')), h('div', { class: 'nm' }, heroName(mvpRow.heroId)), h('div', { class: 'sg-mute' }, mvpRow.name)),
        )
      : null;

    const actions = h('div', { class: 'over-actions' });
    if (ctx.sessionKind === 'single') {
      actions.append(
        h('button', { class: 'sg-btn dark', type: 'button', data: { sfx: 'back' }, on: { click: () => ctx.leaveSession(true) } }, t('over.toTitle')),
        h('button', { class: 'sg-btn gold big', type: 'button', data: { sfx: 'confirm' }, on: { click: () => ctx.playAgain() } }, t('over.again')),
      );
    } else {
      actions.append(h('button', { class: 'sg-btn dark', type: 'button', data: { sfx: 'back' }, on: { click: () => ctx.leaveSession(true) } }, t('over.toTitle')));
      if (session.isHost) actions.append(h('button', { class: 'sg-btn gold big', type: 'button', data: { sfx: 'confirm' }, on: { click: () => session.returnToLobby() } }, t('over.toLobby')));
      else actions.append(h('span', { class: 'sg-mute wait' }, h('span', { class: 'sg-spinner' }), ' ', t('over.waitHost')));
    }

    el.replaceChildren(
      h('div', { class: 'over-sheet sg-panel sg-corners' },
        big,
        h('div', { class: 'over-body' },
          h('div', { class: 'sg-table-wrap' }, table),
          h('div', { class: 'over-side' }, mvpBox, statBox),
        ),
        actions,
      ),
    );
  };

  bag.add(session.on('gameOver', () => render()));
  render();
  // painted faces once the art listing is known (only matters when this is the first screen shown)
  if (!ctx.portraits.known()) void ctx.portraits.whenKnown().then(() => !bag.isDisposed && render());
  return { el, relabel: render, dispose: () => bag.dispose() };
}

/** Every role revealed: the painted identity card when the art ships, else the seal. */
function roleCell(role: RoleId): HTMLElement {
  return h('span', { class: 'role-cell', style: `color:${roleInk(role)}` }, roleCardBadge(role, () => roleSeal(role, '1.6em'), 'go-card'), h('span', null, roleName(role)));
}

function statCell(label: string, value: number): HTMLElement {
  return h('div', { class: 'stat' }, h('b', null, String(value)), h('span', null, label));
}
