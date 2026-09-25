// 选将: lord-first stage, card grid with portraits, detail panel, countdown
// ring, and everyone's picks appearing as they happen.
import type { HeroSelectView, RoleDealView } from '../../core/types';
import type { GameSession } from '../../game/session';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h, s, setText } from '../dom';
import { getLang, heroName, seatLabel, t } from '../i18n';
import { displayName } from '../../game/names';
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

/** Seconds before the deadline at which a focused-but-unconfirmed card is locked in for you. */
export const AUTO_PICK_AT = 1.5;

/**
 * Should the focused card be locked in now? Only a card the player chose
 * (clicked) counts, only while nothing is locked yet and the countdown is at
 * AUTO_PICK_AT seconds or less — the host's own timeout would otherwise give a
 * random hero.
 */
export function shouldAutoPick(o: { remaining: number; focused: string | null; userFocused: boolean; picked: boolean; options: readonly string[]; taken: ReadonlySet<string> }): boolean {
  return !o.picked && o.userFocused && !!o.focused && o.remaining <= AUTO_PICK_AT && o.options.includes(o.focused) && !o.taken.has(o.focused);
}

/** focusHero: G2's GameSession extension (the host picks the focused card on timeout) */
type FocusSession = GameSession & { focusHero?(heroId: string): void };

export function createHeroSelectScreen(ctx: UiCtx, session: GameSession): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-select', data: { screen: 'heroSelect' } });
  let receivedAt = performance.now();
  let deadline = session.heroSelect?.deadline ?? 0;
  let focused: string | null = null;
  /** the player clicked a card (the focus is theirs, not the default) */
  let userFocused = false;
  let localPick: string | null = null;
  let autoPicked = false;
  // crown picks already announced (seat → hero); the initial view's picks are not flashed
  const flashed = new Map<number, string>(Object.entries(session.heroSelect?.picks ?? {}).map(([seat, hero]) => [Number(seat), hero]));
  let lastBeep = -1;
  let detail: { el: HTMLElement; dispose(): void } | null = null;
  let detailHero: string | null = null;
  // the grid is built once per set of options; later updates only patch classes
  let gridKey = '';
  const cards = new Map<string, HTMLElement>();
  const cardState = new Map<string, string>();
  let stripKey = '';

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
  const lockIn = (hero: string): void => {
    localPick = hero;
    session.pickHero(hero);
    update();
  };
  const confirmBtn = button(t('select.confirm'), () => {
    const v = session.heroSelect;
    if (!focused || !v) return;
    lockIn(focused);
    ctx.sfx('confirm');
  }, { cls: 'big gold', sfx: 'none' });
  const waitNote = h('div', { class: 'wait-note' });
  const flash = h('div', { class: 'lord-flash', aria: { live: 'polite' } });
  const single = ctx.sessionKind === 'single';
  const back = single ? backToSetup(ctx, session) : null;

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

  const focus = (id: string): void => {
    const v = session.heroSelect;
    if (!v || myPick(v, mySeat(session))) return;
    focused = id;
    userFocused = true;
    try {
      (session as FocusSession).focusHero?.(id);
    } catch (err) {
      console.warn('[ui] focusHero failed', err);
    }
    update();
  };

  /** (Re)build the option cards only when the set of options changes. */
  const buildGrid = (opts: readonly string[], lordBonus: boolean): void => {
    const compact = opts.length > 8;
    const key = `${opts.join(',')}|${lordBonus}|${getLang()}`;
    if (key === gridKey) return;
    gridKey = key;
    cards.clear();
    cardState.clear();
    // your options are drawn before the thumbnails of other seats' picks
    ctx.portraits.prioritize?.(opts);
    grid.className = `grid ${opts.length <= 3 ? 'n-small' : opts.length <= 8 ? 'n-mid' : 'n-large'}`;
    grid.replaceChildren(
      ...opts.map((id) => {
        const card = heroCard(ctx.portraits, id, {
          compact,
          lordBonus,
          size: compact ? 192 : 256,
          priority: 10,
          onClick: () => focus(id),
        });
        cards.set(id, card);
        return card;
      }),
    );
  };

  /** Patch selected / taken / locked state in place (cards never detach under a click). */
  const patchCards = (picked: string | null, taken: ReadonlySet<string>, waiting: boolean): void => {
    for (const [id, card] of cards) {
      const isTaken = taken.has(id);
      const selected = id === focused;
      const disabled = isTaken || waiting;
      const tag = isTaken ? 'taken' : picked === id ? 'mine' : '';
      const st = `${selected}|${disabled}|${tag}`;
      if (cardState.get(id) === st) continue;
      cardState.set(id, st);
      card.classList.toggle('selected', selected);
      card.classList.toggle('disabled', disabled);
      card.setAttribute('aria-pressed', String(selected));
      card.setAttribute('aria-disabled', String(disabled));
      card.tabIndex = disabled ? -1 : 0;
      card.querySelector(':scope > .tag')?.remove();
      if (tag) {
        const stamp = tag === 'taken' ? seal('选', { size: '2.6em', title: t('select.taken') }) : seal('定', { size: '2.6em', color: '#2e8b57' });
        card.appendChild(h('div', { class: 'tag' }, stamp));
      }
    }
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

    // options grid (crowns get no options in the general phase: show their own pick)
    const opts = v.options.length ? v.options : picked ? [picked] : [];
    if (!focused || !opts.includes(focused) || taken.has(focused)) {
      focused = picked ?? opts.find((o) => !taken.has(o)) ?? opts[0] ?? null;
      userFocused = false;
    }
    buildGrid(opts, iAmCrown);
    patchCards(picked, taken, waiting);

    // picks strip (crowns first) — rebuilt only when a pick / seat changes
    const rank = (seat: number): number => (crowns.includes(seat) ? -100 + seat : seat);
    const seats = [...(session.lobby?.seats ?? [])].sort((a, b) => rank(a.seat) - rank(b.seat));
    const sk = JSON.stringify([seats.map((st) => [st.seat, st.name, st.seat === me ? picked : v.picks[st.seat]]), crowns, me, getLang(), deal?.publicRoles]);
    if (sk !== stripKey) {
      stripKey = sk;
      strip.replaceChildren(
        ...seats.map((st) => {
          const hero = st.seat === me ? picked : v.picks[st.seat];
          const crowned = crowns.includes(st.seat);
          // only the real Lord is told which crown is the decoy
          const decoy = crowned && !!deal && shownSeatRole(deal, st.seat, me) === 'double';
          return h('div', { class: `pick${st.seat === me ? ' me' : ''}${crowned ? ' lord' : ''}${decoy ? ' decoy' : ''}${hero ? ' done' : ''}` },
            h('div', { class: 'thumb' }, hero ? heroCard(ctx.portraits, hero, { compact: true, size: 128 }) : h('span', { class: 'q' }, '?')),
            h('div', { class: 'who' }, crowned ? h('span', { class: `crown${decoy ? ' decoy' : ''}`, title: decoy ? t('score.decoy') : undefined }, '♛') : null, h('span', { class: 'nm' }, displayName(st.name, getLang()))),
            h('div', { class: 'what' }, hero ? heroName(hero) : t('select.picking')),
          );
        }),
      );
    }

    el.classList.toggle('waiting', waiting);
    // nothing to show or choose yet (another stage is picking): hide the empty detail panel
    el.classList.toggle('no-options', !opts.length);
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
    gridKey = '';
    stripKey = '';
    el.replaceChildren(
      h('header', { class: 'sel-head' },
        back ? back.el : null,
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
    back?.relabel();
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
    const me = mySeat(session);
    if (secs <= 5 && secs > 0 && secs !== lastBeep) {
      lastBeep = secs;
      if (!myPick(v, me) && v.options.length > 0) ctx.sfx('countdown');
    }
    // the clicked (but not confirmed) card is locked in just before the deadline
    if (!autoPicked && shouldAutoPick({ remaining, focused, userFocused, picked: !!myPick(v, me), options: v.options, taken: takenHeroes(v, me) })) {
      autoPicked = true;
      const hero = focused as string;
      lockIn(hero);
      ctx.toast(t('select.autoPick', { hero: heroName(hero) }));
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
      if (!localPick) autoPicked = false;
      update();
    }),
  );
  bag.add(session.on('lobby', () => update()));
  if (back) bag.add(back);
  build();
  return {
    el,
    relabel: build,
    dispose: () => {
      detail?.dispose();
      detail = null;
      bag.dispose();
      cards.clear();
      cardState.clear();
      grid.replaceChildren();
      strip.replaceChildren();
    },
  };
}

/**
 * Single player: 返回 on the roles / hero-select screens (and Esc) goes back to
 * the setup screen — the local session returns to its lobby.
 */
export function backToSetup(ctx: UiCtx, session: GameSession): { el: HTMLButtonElement; relabel(): void; dispose(): void } {
  const go = (): void => {
    ctx.sfx('back');
    session.returnToLobby();
  };
  const el = button(`‹ ${t('common.back')}`, go, { cls: 'ghost small sg-back sel-back', sfx: 'none', title: t('select.backHint') });
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || !el.isConnected) return;
    // a modal (settings / confirm) above the screen gets the Esc first
    if (el.ownerDocument.querySelector('.sg-modal-back')) return;
    ev.preventDefault();
    go();
  };
  el.ownerDocument.addEventListener('keydown', onKey);
  return {
    el,
    relabel: () => {
      el.textContent = `‹ ${t('common.back')}`;
      el.title = t('select.backHint');
    },
    dispose: () => el.ownerDocument.removeEventListener('keydown', onKey),
  };
}

/** Exposed for the loading screen: the hero this player picked (if known). */
export function pickedHero(session: GameSession): string | null {
  const v = session.heroSelect;
  if (!v) return null;
  return v.picks[mySeat(session)] ?? null;
}
