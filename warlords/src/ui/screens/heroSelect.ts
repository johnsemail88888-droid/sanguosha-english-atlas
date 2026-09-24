// 选将: lord-first stage, card grid with portraits, detail panel, countdown
// ring, and everyone's picks appearing as they happen.
import type { HeroSelectView, RoleDealView } from '../../core/types';
import type { GameSession } from '../../game/session';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h, s, setText } from '../dom';
import { heroName, seatLabel, t } from '../i18n';
import { button, heroCard, seal } from '../widgets';
import { heroDetail } from './heroDetail';
import { crownSeats, mySeat, seatName, shownSeatRole } from './roles';

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

/** Heroes already taken by other seats. */
export function takenHeroes(view: HeroSelectView, mine: number): Set<string> {
  const out = new Set<string>();
  for (const [seat, hero] of Object.entries(view.picks)) if (Number(seat) !== mine && hero) out.add(hero);
  return out;
}

export interface SelectTurn {
  /** seats wearing a crown (the Lord, and the 影武者 in 乱世 mode) — they pick in the lord phase */
  crowns: number[];
  iAmCrown: boolean;
  /** the real Lord (gets the lord skill; the Double only gets the +1 勾玉) */
  iAmRealLord: boolean;
  /** nothing to choose right now: another stage is picking */
  waiting: boolean;
}

/**
 * Whose turn it is, decided from the view itself: you are a picker iff the host
 * sent you options. (`lordSeat` alone is not enough — the 影武者 sees the real
 * Lord's seat there but picks in the lord phase too.)
 */
export function selectTurn(v: HeroSelectView, me: number, deal: RoleDealView | null): SelectTurn {
  const crowns = deal ? crownSeats(deal) : [];
  if (!crowns.includes(v.lordSeat)) crowns.push(v.lordSeat);
  crowns.sort((a, b) => a - b);
  return {
    crowns,
    iAmCrown: crowns.includes(me),
    iAmRealLord: deal ? deal.yourRole === 'lord' : me === v.lordSeat,
    waiting: v.lordPhase && v.options.length === 0,
  };
}

export function createHeroSelectScreen(ctx: UiCtx, session: GameSession): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-select', data: { screen: 'heroSelect' } });
  let receivedAt = performance.now();
  let deadline = session.heroSelect?.deadline ?? 0;
  let focused: string | null = null;
  let localPick: string | null = null;
  // crown picks already announced (seat → hero); the initial view's picks are not flashed
  const flashed = new Map<number, string>(Object.entries(session.heroSelect?.picks ?? {}).map(([seat, hero]) => [Number(seat), hero]));
  let lastBeep = -1;
  let detail: { el: HTMLElement; dispose(): void } | null = null;
  let detailHero: string | null = null;

  // persistent parts
  const stageText = h('div', { class: 'stage-text' });
  const ringFg = s('circle', { class: 'fg', cx: 30, cy: 30, r: RING_R, 'stroke-dasharray': RING_C.toFixed(2), 'stroke-dashoffset': '0' });
  const ringNum = h('span', { class: 'num' }, '');
  const ring = h('div', { class: 'sg-ring', aria: { label: 'countdown' } },
    s('svg', { viewBox: '0 0 60 60' }, s('circle', { class: 'bg', cx: 30, cy: 30, r: RING_R }), ringFg),
    ringNum,
  );
  const strip = h('div', { class: 'picks-strip' });
  const grid = h('div', { class: 'grid' });
  const detailBox = h('div', { class: 'detail-body' });
  const confirmBtn = button(t('select.confirm'), () => {
    const v = session.heroSelect;
    if (!focused || !v) return;
    localPick = focused;
    session.pickHero(focused);
    ctx.sfx('confirm');
    update();
  }, { cls: 'big gold', sfx: 'none' });
  const waitNote = h('div', { class: 'wait-note' });
  const flash = h('div', { class: 'lord-flash', aria: { live: 'polite' } });

  const myPick = (v: HeroSelectView, me: number): string | null => v.picks[me] ?? localPick;

  const renderDetail = (heroId: string | null, turn: SelectTurn): void => {
    if (heroId === detailHero && detail) return;
    detail?.dispose();
    detail = null;
    detailHero = heroId;
    detailBox.replaceChildren();
    if (!heroId) return;
    // crowns get the +1 勾玉; only the real Lord gets the lord skill
    detail = heroDetail(ctx, heroId, { asLord: turn.iAmCrown, dimLord: !turn.iAmRealLord });
    detailBox.appendChild(detail.el);
  };

  const update = (): void => {
    const v = session.heroSelect;
    if (!v) return;
    const me = mySeat(session);
    const deal = session.roles;
    const turn = selectTurn(v, me, deal);
    const { waiting, iAmCrown, crowns } = turn;
    const picked = myPick(v, me);
    const taken = takenHeroes(v, me);

    // stage text
    const n = v.options.length;
    setText(
      stageText,
      waiting
        ? t(crowns.length > 1 ? 'select.crownsPicking' : 'select.waitLord')
        : picked
          ? t('select.waitOthers')
          : v.lordPhase
            ? t(turn.iAmRealLord ? 'select.youAreLord' : 'select.youAreCrown')
            : n > 8
              ? t('select.freeHint')
              : t('select.pickHint', { n }),
    );

    // crown pick flash (every crown, not only v.lordSeat)
    for (const seat of crowns) {
      const hero = v.picks[seat];
      if (!hero || flashed.get(seat) === hero) continue;
      flashed.set(seat, hero);
      if (seat === me) continue;
      const who = crowns.length > 1 ? `${seatName(session, seat)} · ` : '';
      flash.replaceChildren(h('span', { class: 'crown' }, '♛'), who, t('select.lordPicked', { hero: heroName(hero) }));
      flash.classList.add('show');
      bag.timeout(() => flash.classList.remove('show'), 2400);
      ctx.sfx('reveal');
    }

    // picks strip (crowns first)
    const rank = (seat: number): number => (crowns.includes(seat) ? -100 + seat : seat);
    const seats = [...(session.lobby?.seats ?? [])].sort((a, b) => rank(a.seat) - rank(b.seat));
    strip.replaceChildren(
      ...seats.map((st) => {
        const hero = st.seat === me ? picked : v.picks[st.seat];
        const crowned = crowns.includes(st.seat);
        // only the real Lord is told which crown is the decoy
        const decoy = crowned && !!deal && shownSeatRole(deal, st.seat, me) === 'double';
        const chip = h('div', { class: `pick${st.seat === me ? ' me' : ''}${crowned ? ' lord' : ''}${decoy ? ' decoy' : ''}${hero ? ' done' : ''}` },
          h('div', { class: 'thumb' }, hero ? heroCard(ctx.portraits, hero, { compact: true, size: 128 }) : h('span', { class: 'q' }, '?')),
          h('div', { class: 'who' }, crowned ? h('span', { class: `crown${decoy ? ' decoy' : ''}`, title: decoy ? t('score.decoy') : undefined }, '♛') : null, h('span', { class: 'nm' }, st.name)),
          h('div', { class: 'what' }, hero ? heroName(hero) : t('select.picking')),
        );
        return chip;
      }),
    );

    // options grid
    const opts = v.options;
    if (!focused || !opts.includes(focused) || taken.has(focused)) focused = picked ?? opts.find((o) => !taken.has(o)) ?? opts[0] ?? null;
    grid.className = `grid ${opts.length <= 3 ? 'n-small' : opts.length <= 8 ? 'n-mid' : 'n-large'}`;
    grid.replaceChildren(
      ...opts.map((id) => {
        const isTaken = taken.has(id);
        return heroCard(ctx.portraits, id, {
          compact: opts.length > 8,
          selected: id === focused,
          disabled: isTaken || waiting,
          lordBonus: iAmCrown,
          tag: isTaken ? seal('选', { size: '2.6em', title: t('select.taken') }) : picked === id ? seal('定', { size: '2.6em', color: '#2e8b57' }) : null,
          size: opts.length > 8 ? 192 : 256,
          onClick: () => {
            if (picked) return;
            focused = id;
            update();
          },
        });
      }),
    );
    el.classList.toggle('waiting', waiting);
    el.classList.toggle('locked', !!picked);
    waitNote.replaceChildren();
    if (waiting) {
      const who = crowns.map((c) => `${seatName(session, c)}（${seatLabel(c)}）`).join(' · ');
      waitNote.append(h('span', { class: 'sg-spinner' }), ' ', t(crowns.length > 1 ? 'select.crownsPicking' : 'select.waitLord'), h('span', { class: 'sg-mute' }, ` · ${who}`));
    }
    renderDetail(focused, turn);
    confirmBtn.disabled = waiting || !!picked || !focused || !opts.length;
    confirmBtn.textContent = picked ? t('select.locked') : t('select.confirm');
  };

  const build = (): void => {
    detail?.dispose();
    detail = null;
    detailHero = null;
    el.replaceChildren(
      h('header', { class: 'sel-head' },
        h('div', { class: 'titles' }, h('h1', { class: 'sg-h1' }, t('select.title')), stageText),
        ring,
      ),
      strip,
      flash,
      h('div', { class: 'sel-main' },
        h('div', { class: 'grid-wrap' }, waitNote, grid),
        h('aside', { class: 'detail sg-panel sg-corners' }, detailBox, h('div', { class: 'detail-actions' }, confirmBtn)),
      ),
    );
    update();
  };

  // countdown ring (only this element animates per frame)
  let raf = 0;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const v = session.heroSelect;
    if (!v) return;
    const remaining = Math.max(0, deadline - (performance.now() - receivedAt) / 1000);
    const total = v.lordPhase ? 15 : 20;
    const frac = Math.max(0, Math.min(1, remaining / Math.max(total, deadline, 1)));
    ringFg.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
    const secs = Math.ceil(remaining);
    setText(ringNum, String(secs));
    ring.classList.toggle('urgent', secs <= 5);
    if (secs <= 5 && secs > 0 && secs !== lastBeep) {
      lastBeep = secs;
      const me = mySeat(session);
      if (!myPick(v, me) && v.options.length > 0) ctx.sfx('countdown');
    }
  };
  raf = requestAnimationFrame(tick);
  bag.add(() => cancelAnimationFrame(raf));

  bag.add(
    session.on('heroSelect', (v) => {
      deadline = v.deadline;
      receivedAt = performance.now();
      lastBeep = -1;
      if (!v.lordPhase && localPick && !v.options.includes(localPick)) localPick = null;
      update();
    }),
  );
  bag.add(session.on('lobby', () => update()));
  build();
  return {
    el,
    relabel: build,
    dispose: () => {
      detail?.dispose();
      bag.dispose();
    },
  };
}

/** Exposed for the loading screen: the hero this player picked (if known). */
export function pickedHero(session: GameSession): string | null {
  const v = session.heroSelect;
  if (!v) return null;
  return v.picks[mySeat(session)] ?? null;
}
