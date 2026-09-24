// 身份分配: your role card flips over (seal + goal); the Lord (and 影武者 crowns)
// are announced to everyone.
import type { RoleDealView, RoleId } from '../../core/types';
import { ROLE_BY_ID } from '../../data';
import type { GameSession } from '../../game/session';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { roleName, seatLabel, t, tx } from '../i18n';
import { ROLE_GLYPH, roleColor } from '../theme';
import { roleSeal, seal } from '../widgets';

export function seatName(session: GameSession, seat: number): string {
  const s = session.lobby?.seats.find((x) => x.seat === seat);
  return s ? s.name : seatLabel(seat);
}

export function mySeat(session: GameSession): number {
  return session.lobby?.seats.find((x) => x.playerId === session.myId)?.seat ?? -1;
}

/** Seats publicly shown with a crown (the lord, plus the 影武者 disguise). */
export function crownSeats(deal: RoleDealView): number[] {
  return Object.entries(deal.publicRoles)
    .filter(([, r]) => r === 'lord' || r === 'double')
    .map(([seat]) => Number(seat))
    .sort((a, b) => a - b);
}

/**
 * What the crown line should tell this player. Only the real Lord is sent
 * `publicRoles[doubleSeat] = 'double'`; the Double knows the other crown is real.
 */
export function crownSecret(deal: RoleDealView, me: number): { kind: 'yourDouble' | 'trueLord'; seat: number } | null {
  if (deal.yourRole === 'lord') {
    const seat = crownSeats(deal).find((c) => deal.publicRoles[c] === 'double');
    return seat === undefined ? null : { kind: 'yourDouble', seat };
  }
  if (deal.yourRole === 'double') {
    const seat = crownSeats(deal).find((c) => c !== me);
    return seat === undefined ? null : { kind: 'trueLord', seat };
  }
  return null;
}

/** Role seal to show on a seat chip: your own role, else what is public (the Lord sees the decoy as 影). */
export function shownSeatRole(deal: RoleDealView, seat: number, me: number): RoleId | undefined {
  return seat === me ? deal.yourRole : deal.publicRoles[seat];
}

function roleCard(role: RoleId): HTMLElement {
  const def = ROLE_BY_ID[role];
  const color = roleColor(role);
  const front = h('div', { class: 'face front' },
    h('div', { class: 'frame' },
      seal(ROLE_GLYPH[role], { color, size: '5.2em' }),
      h('div', { class: 'rname' }, roleName(role)),
      h('div', { class: 'faction' }, def ? tx(def.nameEn, def.nameZh) : ''),
    ),
  );
  front.style.setProperty('--rc', color);
  const back = h('div', { class: 'face back' }, h('div', { class: 'frame' }, h('div', { class: 'back-logo' }, '身'), h('div', { class: 'back-sub' }, '三国杀·枪火乱世')));
  return h('div', { class: 'flip-card', role: 'img', aria: { label: roleName(role) } }, back, front);
}

export function createRolesScreen(ctx: UiCtx, session: GameSession): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-roles', data: { screen: 'roles' } });
  let flipped = false;

  const render = (): void => {
    const deal = session.roles;
    if (!deal) {
      el.replaceChildren(h('div', { class: 'sg-center' }, h('span', { class: 'sg-spinner' }), ' ', t('common.loading')));
      return;
    }
    const role = deal.yourRole;
    const def = ROLE_BY_ID[role];
    const card = roleCard(role);
    if (flipped) card.classList.add('flipped');
    const hint = h('div', { class: 'sg-mute hint' }, flipped ? t('roles.secret') : t('roles.tap'));
    const flip = (): void => {
      if (card.classList.contains('flipped')) return;
      flipped = true;
      card.classList.add('flipped');
      hint.textContent = t('roles.secret');
      ctx.sfx('flip');
      bag.timeout(() => ctx.sfx('reveal'), 450);
    };
    card.addEventListener('click', flip);

    const crowns = crownSeats(deal);
    const me = mySeat(session);
    const announce = h('div', { class: 'announce' });
    if (crowns.length === 1) {
      announce.appendChild(h('div', { class: 'lordline' }, h('span', { class: 'crown' }, '♛'), t('roles.lordIs', { name: seatName(session, crowns[0]), seat: seatLabel(crowns[0]) })));
    } else if (crowns.length > 1) {
      announce.appendChild(h('div', { class: 'lordline' }, h('span', { class: 'crown' }, '♛♛'), t('roles.twoCrowns')));
      announce.appendChild(h('div', { class: 'sg-mute' }, crowns.map((c) => `${seatName(session, c)}（${seatLabel(c)}）`).join(tx('、', ', '))));
      const secret = crownSecret(deal, me);
      if (secret) {
        const vars = { name: seatName(session, secret.seat), seat: seatLabel(secret.seat) };
        announce.appendChild(h('div', { class: `crown-secret ${secret.kind}` },
          roleSeal(secret.kind === 'yourDouble' ? 'double' : 'lord', '1.6em'), ' ',
          t(secret.kind === 'yourDouble' ? 'roles.yourDouble' : 'roles.youAreDouble', vars)));
      }
    }
    if (deal.bountySeat !== undefined) {
      announce.appendChild(h('div', { class: 'bounty' }, roleSeal('bounty', '1.6em'), ' ', t('roles.bounty', { name: seatName(session, deal.bountySeat), seat: seatLabel(deal.bountySeat) })));
    }

    const seats = [...(session.lobby?.seats ?? [])].sort((a, b) => a.seat - b.seat);
    const seatStrip = h('div', { class: 'seat-strip' },
      seats.map((st) => {
        const isMe = st.seat === me;
        const shown = shownSeatRole(deal, st.seat, me);
        const crowned = crowns.includes(st.seat);
        return h('div', { class: `seat-chip${isMe ? ' me' : ''}${crowned ? ' lord' : ''}${crowned && shown === 'double' ? ' decoy' : ''}` },
          shown ? roleSeal(shown, '1.8em') : h('span', { class: 'unknown' }, '?'),
          h('span', { class: 'nm' }, st.name),
          h('span', { class: 'no' }, seatLabel(st.seat)),
        );
      }),
    );

    el.replaceChildren(
      h('h1', { class: 'sg-h1 sg-title-bar' }, t('roles.title')),
      h('div', { class: 'stage' },
        h('div', { class: 'card-col' }, card, hint),
        h('div', { class: 'info sg-panel sg-corners' },
          h('div', { class: 'yr' }, t('roles.yourRole')),
          h('div', { class: 'rn' }, roleSeal(role, '2.2em'), h('span', null, roleName(role))),
          h('h3', { class: 'sg-h3' }, t('roles.goal')),
          h('p', null, def ? tx(def.goalZh, def.goalEn) : ''),
          h('h3', { class: 'sg-h3' }, t('roles.tips')),
          h('p', { class: 'sg-mute' }, def ? tx(def.tipsZh, def.tipsEn) : ''),
        ),
      ),
      announce,
      seatStrip,
    );
    if (!flipped) bag.timeout(flip, 700);
  };

  bag.add(session.on('roles', () => render()));
  render();
  return { el, relabel: render, dispose: () => bag.dispose() };
}
