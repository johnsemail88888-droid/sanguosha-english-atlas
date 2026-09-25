// Touch overlay: virtual joystick (left half), drag-to-look (right half) and
// on-screen buttons. Talks only to InputSink.
import type { AbilitySlot, InputAction, PrivateHeroView, SquadOrderKind } from '../core/types';
import type { InputSink } from '../game/input-types';
import { HERO_BY_ID, ITEM_BY_ID, isPassiveAbility } from '../data';
import type { AbilityDef } from '../data/types';
import { h, setClass, setText } from './dom';
import { getLang, t, tx, type I18nKey } from './i18n';
import { ORDER_GLYPH, ORDER_SEQUENCE, inkOn } from './theme';
import { abilityReady, cooldownFraction } from './hud/logic';
import { flashDenied } from './hud/panels';
import { abilityShort, itemLabel, touchLabel, type TouchKey } from './short';
import { gearArt } from './cardArt';
import { abilityArt, setArt } from './artIcons';

/** Hold an item slot this long (ms) to read the card instead of using it. */
export const LONG_PRESS_MS = 450;

/** Pixels of finger drag → look delta multiplier (mouse-equivalent pixels). */
export const TOUCH_LOOK_SCALE = 1.6;
/** Joystick radius in CSS px. */
const STICK_R = 56;

export function shouldUseTouch(pref: 'auto' | 'on' | 'off', coarse?: boolean): boolean {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  if (coarse !== undefined) return coarse;
  try {
    return globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  } catch {
    return false;
  }
}

/** Joystick vector from a drag delta: clamped to the unit circle, z = forward (up). */
export function stickVector(dx: number, dy: number, radius = STICK_R): { x: number; z: number; mag: number } {
  const len = Math.hypot(dx, dy);
  const k = len > radius ? radius / len : 1;
  const x = (dx * k) / radius;
  const z = (-dy * k) / radius;
  const mag = Math.min(1, len / radius);
  // small dead zone
  if (mag < 0.08) return { x: 0, z: 0, mag: 0 };
  return { x, z, mag };
}

export interface TouchControls {
  readonly el: HTMLElement;
  /** refresh cooldowns, items, lord button, order */
  update(me: PrivateHeroView | null): void;
  setVisible(on: boolean): void;
  /** re-label the buttons after a language change */
  relabel(): void;
  /** the sim refused this ability: a short red pulse on its button */
  denied?(abilityId: string): void;
  dispose(): void;
}

export interface TouchOptions {
  /** called when the interact button is tapped (HUD may use it for prompts) */
  onInteract?(): void;
  /** long-press on an item slot: show that card's description (slot index, item id) */
  onItemInfo?(slot: number, itemId: string): void;
}

interface AbilityBtn {
  el: HTMLElement;
  cd: HTMLElement;
  label: HTMLElement;
  secs: HTMLElement;
  lastP: number;
  lastSecs: number;
  state: string;
  labelKey: string;
}

export function mountTouchControls(container: HTMLElement, sink: InputSink, opts: TouchOptions = {}): TouchControls {
  const cleanup: (() => void)[] = [];
  const el = h('div', { class: 'sg-touch', aria: { hidden: 'true' } });
  const stickBase = h('div', { class: 'stick-base' });
  const stickKnob = h('div', { class: 'stick-knob' });
  stickBase.appendChild(stickKnob);
  const moveZone = h('div', { class: 'zone move' }, stickBase);
  const lookZone = h('div', { class: 'zone look' });
  el.append(moveZone, lookZone);

  let adsOn = false;
  let sprintOn = false;
  let orderIdx = 0;
  let activeSlot = 0;

  const push = (a: InputAction): void => {
    try {
      sink.pushAction(a);
    } catch (err) {
      console.warn('[touch] pushAction failed', err);
    }
  };

  // ── buttons ────────────────────────────────────────────────────────────────
  /** static buttons re-labelled on a language change */
  const labelled: { el: HTMLElement; key: TouchKey }[] = [];
  const labelFor = (el: HTMLElement, key: TouchKey): void => {
    const text = touchLabel(key, getLang());
    setText(el.firstElementChild as HTMLElement, text);
    setClass(el, 'word', text.length > 1 && /^[\x20-\x7e]+$/.test(text));
  };
  const btn = (cls: string, label: string | TouchKey, onDown: (ev: PointerEvent) => void, onUp?: () => void, title?: string, key?: TouchKey): HTMLElement => {
    const b = h('div', { class: `tbtn ${cls}`, role: 'button', title }, h('span', { class: 'l' }, label));
    if (key) {
      labelled.push({ el: b, key });
      labelFor(b, key);
    }
    let pid: number | null = null;
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      pid = ev.pointerId;
      try {
        b.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      b.classList.add('down');
      onDown(ev);
    });
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return;
      pid = null;
      b.classList.remove('down');
      onUp?.();
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  };

  // fire: hold + drag to aim
  let firePid: number | null = null;
  let fireLast = { x: 0, y: 0 };
  const fire = btn('fire', 'fire', (ev) => {
    firePid = ev.pointerId;
    fireLast = { x: ev.clientX, y: ev.clientY };
    sink.setHeld('fire', true);
  }, () => {
    firePid = null;
    sink.setHeld('fire', false);
  }, tx('开火', 'Fire'), 'fire');
  fire.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== firePid) return;
    sink.addLook((ev.clientX - fireLast.x) * TOUCH_LOOK_SCALE, (ev.clientY - fireLast.y) * TOUCH_LOOK_SCALE);
    fireLast = { x: ev.clientX, y: ev.clientY };
  });

  const setAds = (on: boolean): void => {
    adsOn = on;
    setClass(ads, 'on', on);
    sink.setHeld('ads', on);
  };
  const ads = btn('ads', 'ads', () => setAds(!adsOn), undefined, tx('开镜', 'Aim'), 'ads');
  const jump = btn('jump', 'jump', () => push({ a: 'jump' }), undefined, tx('跳跃', 'Jump'), 'jump');
  const dodge = btn('dodge', 'dodge', () => push({ a: 'dodge' }), undefined, tx('闪避', 'Dodge'), 'dodge');
  const reload = btn('reload', 'reload', () => push({ a: 'reload' }), undefined, tx('换弹', 'Reload'), 'reload');
  const swap = btn('swap', 'swap', () => push({ a: 'weapon', slot: activeSlot === 0 ? 1 : 0 }), undefined, tx('切换武器', 'Swap weapon'), 'swap');
  const interact = btn('interact', 'interact', () => {
    push({ a: 'interact' });
    sink.setHeld('interact', true);
    opts.onInteract?.();
  }, () => sink.setHeld('interact', false), tx('互动', 'Interact'), 'interact');

  /** Q / E / G: short skill name, the key letter in a corner, cooldown sweep + seconds */
  const abilityBtn = (slot: AbilitySlot, key: string): AbilityBtn => {
    const cd = h('i', { class: 'cd' });
    const b = btn(`ab ab-${slot}`, key, () => push({ a: 'ability', slot }));
    const label = b.firstElementChild as HTMLElement;
    const secs = h('b', { class: 'cs' });
    b.append(cd, h('span', { class: 'k' }, key), secs);
    return { el: b, cd, label, secs, lastP: -1, lastSecs: -1, state: '', labelKey: '' };
  };
  const abQ = abilityBtn('q', 'Q');
  const abE = abilityBtn('e', 'E');
  const abG = abilityBtn('lord', 'G');

  const order = btn('order', ORDER_GLYPH.follow, () => {
    orderIdx = (orderIdx + 1) % ORDER_SEQUENCE.length;
    const o: SquadOrderKind = ORDER_SEQUENCE[orderIdx];
    push({ a: 'command', order: o });
    setOrderLabel(o);
    order.title = t(`hud.order.${o}` as I18nKey);
  }, undefined, t('hud.squad'));
  function setOrderLabel(o: SquadOrderKind): void {
    const en = getLang() === 'en';
    setText(order.firstElementChild as HTMLElement, en ? t(`hud.order.${o}` as I18nKey) : ORDER_GLYPH[o]);
    setClass(order, 'word', en);
  }
  setOrderLabel('follow');
  const mark = btn('mark', 'mark', () => push({ a: 'mark' }), undefined, tx('标记', 'Mark'), 'mark');

  // item slots: tap uses the card (on release), a long press shows what it does instead
  const items = [0, 1, 2, 3].map((i) => {
    const g = h('span', { class: 'g' });
    const c = h('b', { class: 'c' });
    const n = h('span', { class: 'n' });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let long = false;
    let itemId = '';
    const cancel = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const b = btn('item empty', '', () => {
      long = false;
      cancel();
      if (!itemId) return;
      const id = itemId;
      timer = setTimeout(() => {
        timer = null;
        long = true;
        b.classList.remove('down');
        opts.onItemInfo?.(i, id);
      }, LONG_PRESS_MS);
    }, () => {
      const wasPending = timer !== null;
      cancel();
      if (wasPending && !long) push({ a: 'item', slot: i });
      long = false;
    });
    b.addEventListener('pointercancel', cancel);
    cleanup.push(cancel);
    b.replaceChildren(g, n, c, h('span', { class: 'k' }, String(4 + i)));
    return { el: b, g, c, n, key: '', setId: (id: string) => (itemId = id) };
  });

  el.append(
    h('div', { class: 'cluster right' }, fire, ads, jump, dodge, reload, abQ.el, abE.el, abG.el, interact, swap),
    h('div', { class: 'cluster left' }, order, mark),
    h('div', { class: 'item-bar' }, ...items.map((x) => x.el)),
  );

  // ── joystick ───────────────────────────────────────────────────────────────
  let stickPid: number | null = null;
  let origin = { x: 0, y: 0 };
  const placeBase = (x: number, y: number): void => {
    const r = moveZone.getBoundingClientRect();
    stickBase.style.left = `${x - r.left}px`;
    stickBase.style.top = `${y - r.top}px`;
  };
  moveZone.addEventListener('pointerdown', (ev) => {
    if (stickPid !== null) return;
    ev.preventDefault();
    stickPid = ev.pointerId;
    origin = { x: ev.clientX, y: ev.clientY };
    try {
      moveZone.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    placeBase(ev.clientX, ev.clientY);
    stickBase.classList.add('active');
  });
  moveZone.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== stickPid) return;
    const v = stickVector(ev.clientX - origin.x, ev.clientY - origin.y);
    stickKnob.style.transform = `translate(calc(-50% + ${(v.x * STICK_R).toFixed(1)}px), calc(-50% + ${(-v.z * STICK_R).toFixed(1)}px))`;
    sink.setMove(v.x, v.z);
    const sprint = v.mag > 0.95 && v.z > 0.7;
    if (sprint !== sprintOn) {
      sprintOn = sprint;
      sink.setHeld('sprint', sprint);
      setClass(stickBase, 'sprint', sprint);
    }
  });
  const stickEnd = (ev: PointerEvent): void => {
    if (ev.pointerId !== stickPid) return;
    stickPid = null;
    sink.setMove(0, 0);
    if (sprintOn) {
      sprintOn = false;
      sink.setHeld('sprint', false);
    }
    stickKnob.style.transform = 'translate(-50%, -50%)';
    stickBase.classList.remove('active', 'sprint');
    stickBase.style.left = '';
    stickBase.style.top = '';
  };
  moveZone.addEventListener('pointerup', stickEnd);
  moveZone.addEventListener('pointercancel', stickEnd);
  const resetStick = (): void => {
    stickPid = null;
    sprintOn = false;
    stickKnob.style.transform = 'translate(-50%, -50%)';
    stickBase.classList.remove('active', 'sprint');
    stickBase.style.left = '';
    stickBase.style.top = '';
  };

  // ── look ───────────────────────────────────────────────────────────────────
  const lookers = new Map<number, { x: number; y: number }>();
  lookZone.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    lookers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try {
      lookZone.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  });
  lookZone.addEventListener('pointermove', (ev) => {
    const last = lookers.get(ev.pointerId);
    if (!last) return;
    sink.addLook((ev.clientX - last.x) * TOUCH_LOOK_SCALE, (ev.clientY - last.y) * TOUCH_LOOK_SCALE);
    last.x = ev.clientX;
    last.y = ev.clientY;
  });
  const lookEnd = (ev: PointerEvent): void => {
    lookers.delete(ev.pointerId);
  };
  lookZone.addEventListener('pointerup', lookEnd);
  lookZone.addEventListener('pointercancel', lookEnd);

  const noMenu = (ev: Event): void => ev.preventDefault();
  el.addEventListener('contextmenu', noMenu);
  cleanup.push(() => el.removeEventListener('contextmenu', noMenu));

  container.appendChild(el);
  sink.setTouchMode(true);

  let lordKey = '';
  const updateAbility = (b: AbilityBtn, def: AbilityDef, me: PrivateHeroView): void => {
    const lang = getLang();
    const lk = `${def.id}|${lang}`;
    if (lk !== b.labelKey) {
      b.labelKey = lk;
      setText(b.label, abilityShort(def, lang));
      setClass(b.el, 'word', lang === 'en');
      b.el.title = tx(def.nameZh, def.nameEn);
      // the painted icon fills the button (under the sweep / key / seconds) when the art ships
      setArt(b.el, abilityArt(def.id), { first: true, cls: 'tb-art' });
    }
    const rem = me.cooldowns[def.id] ?? 0;
    const p = Math.round(cooldownFraction(rem, def.cooldown) * 100) / 100;
    if (p !== b.lastP) {
      b.lastP = p;
      b.cd.style.setProperty('--p', String(p));
    }
    // charge-based abilities stay usable (no dimming) while a charge is left
    const ready = abilityReady(def, rem, me.charges[def.id]);
    const state = !ready ? 'cooling' : rem > 0 ? 'recharging' : '';
    if (state !== b.state) {
      b.state = state;
      setClass(b.el, 'cooling', state === 'cooling');
      setClass(b.el, 'recharging', state === 'recharging');
    }
    // seconds left while the button is unusable
    const secs = state === 'cooling' && rem > 0 ? Math.ceil(rem) : 0;
    if (secs !== b.lastSecs) {
      b.lastSecs = secs;
      setText(b.secs, secs > 0 ? String(secs) : '');
    }
  };
  let itemLang = getLang();

  return {
    el,
    update(me) {
      if (!me) return;
      activeSlot = me.activeSlot;
      const def = HERO_BY_ID[me.heroId];
      const ab = (slot: AbilitySlot) => def?.abilities.find((a) => a.slot === slot);
      const q = ab('q');
      const e = ab('e');
      const g = ab('lord');
      if (q) updateAbility(abQ, q, me);
      if (e) updateAbility(abE, e, me);
      // passive lord skills (袁绍 血裔) have nothing to press
      const showLord = !!g && me.role === 'lord' && !isPassiveAbility(g);
      const lk = `${showLord}`;
      if (lk !== lordKey) {
        lordKey = lk;
        setClass(abG.el, 'sg-hidden', !showLord);
      }
      if (g && showLord) updateAbility(abG, g, me);
      const lang = getLang();
      if (lang !== itemLang) {
        itemLang = lang;
        for (const it of items) it.key = '';
      }
      items.forEach((it, i) => {
        const st = me.items[i];
        const key = st ? `${st.id}:${st.count}` : '';
        if (key === it.key) return;
        it.key = key;
        it.setId(st?.id ?? '');
        setClass(it.el, 'empty', !st);
        setArt(it.el, gearArt(st?.id), { first: true, cls: 'tb-art' });
        const idef = st ? ITEM_BY_ID[st.id] : undefined;
        setText(it.g, st ? idef?.icon ?? st.id.slice(0, 1) : '');
        // the short name under the glyph / emblem (with the glyph on the card, not repeated when it IS the glyph: 桃, 酒 …)
        const label = st ? itemLabel(st.id, lang) : { text: '', dup: false };
        setText(it.n, label.text);
        setClass(it.n, 'dup', label.dup);
        it.el.style.setProperty('--in', inkOn(idef?.color ?? '#6d5639'));
        setText(it.c, st && st.count > 1 ? String(st.count) : '');
        it.el.title = idef ? `${tx(idef.nameZh, idef.nameEn)} · ${t('hud.cardHint')}` : '';
        it.el.style.setProperty('--ic', idef?.color ?? '#e8d8b0');
      });
      const oi = ORDER_SEQUENCE.indexOf(me.order.kind);
      if (oi >= 0 && oi !== orderIdx) {
        orderIdx = oi;
        setOrderLabel(me.order.kind);
      }
      setClass(el, 'downed', me.downed);
      setClass(el, 'dead', me.dead);
    },
    setVisible(on) {
      setClass(el, 'sg-hidden', !on);
      if (!on) {
        // overlays release every held input (InputController.releaseAll): mirror that here
        sink.setMove(0, 0);
        sink.setHeld('fire', false);
        sink.setHeld('sprint', false);
        sink.setHeld('interact', false);
        if (adsOn) setAds(false);
        lookers.clear();
        firePid = null;
        resetStick();
        for (const b of el.querySelectorAll('.tbtn.down')) b.classList.remove('down');
      }
    },
    denied(abilityId) {
      for (const b of [abQ, abE, abG]) if (b.labelKey.startsWith(`${abilityId}|`)) flashDenied(b.el);
    },
    relabel() {
      for (const l of labelled) labelFor(l.el, l.key);
      abQ.labelKey = abE.labelKey = abG.labelKey = '';
      for (const it of items) it.key = '';
      order.title = t(`hud.order.${ORDER_SEQUENCE[orderIdx]}` as I18nKey);
      setOrderLabel(ORDER_SEQUENCE[orderIdx]);
      mark.title = tx('标记', 'Mark');
    },
    dispose() {
      for (const c of cleanup) c();
      sink.setMove(0, 0);
      sink.setHeld('fire', false);
      sink.setHeld('ads', false);
      sink.setHeld('sprint', false);
      sink.setHeld('interact', false);
      sink.setTouchMode(false);
      el.remove();
    },
  };
}
