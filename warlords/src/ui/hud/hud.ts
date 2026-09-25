// The in-match HUD. Reads the ViewSource once per animation frame and GameEvents
// through GameHandle.onEvents (never drains the view itself). Owns the in-match
// overlays (scoreboard, big map, wheel, chat, pause) and the touch overlay.
import type { EntityId, GameEvent, SquadOrderKind, ViewEntity } from '../../core/types';
import type { GameSession } from '../../game/session';
import { settings } from '../../game/settings';
import type { ViewSource } from '../../render/view';
import type { GameHandle, UiKey } from '../app';
import type { UiCtx } from '../ctx';
import { Bag, h, isTextInput, setClass, setText } from '../dom';
import { getLang, heroName, roleName, t, tx } from '../i18n';
import { CLAIM_TEXT, quickChatText, roleColor } from '../theme';
import { mountTouchControls, shouldUseTouch, type TouchControls } from '../touch';
import { button, keyCap } from '../widgets';
import { CONTROLS } from '../screens/help';
import { AbilityBar, SquadPanel, TopBar, VitalsPanel, WeaponPanel } from './panels';
import { ChannelBar, Crosshair, DamageDirection, DamageNumbers, DownedOverlay, InteractPromptView, KillStamp, Scope, SpectateBar, ZoneWarning, pickupName } from './combat';
import { Announcer, ChatBox, KillFeed, type FeedParty } from './feed';
import { drawMinimap, type MarkerInput } from './minimap';
import { BigMap, PauseMenu, Scoreboard, Wheel, type WheelChoice } from './overlays';
import { UiKeyDeduper, cycleSpectate, deniedText, entityLabel } from './logic';
import type { HudFrame } from './types';
import { trackViewport } from './viewport';

export interface HudDeps {
  view: ViewSource;
  handle: GameHandle;
  session: GameSession;
}

type Overlay = 'none' | 'pause' | 'chat' | 'wheel' | 'map' | 'controls';

const MINIMAP_RADIUS = 85;

export class Hud {
  readonly el: HTMLElement;
  private readonly bag = new Bag();
  private readonly view: ViewSource;
  private readonly handle: GameHandle;
  private readonly session: GameSession;

  private readonly vitals: VitalsPanel;
  private readonly weapon: WeaponPanel;
  private readonly abilities: AbilityBar;
  private readonly squad: SquadPanel;
  private readonly top: TopBar;
  private readonly crosshair: Crosshair;
  private readonly killStamp: KillStamp;
  private readonly dmg: DamageNumbers;
  private readonly dmgDir = new DamageDirection();
  private readonly scope = new Scope();
  private readonly interact: InteractPromptView;
  private readonly channel = new ChannelBar();
  private readonly downed = new DownedOverlay();
  private readonly spectate: SpectateBar;
  private readonly zoneWarn = new ZoneWarning();
  private readonly feed: KillFeed;
  private readonly announcer = new Announcer();
  private readonly chat: ChatBox;
  private readonly scoreboard: Scoreboard;
  private readonly bigmap: BigMap;
  private readonly wheel: Wheel;
  private readonly pause: PauseMenu;
  private readonly controlsBox: HTMLElement;
  private readonly minimapCanvas: HTMLCanvasElement;
  private readonly minimapWrap: HTMLElement;
  private readonly regionEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly touchBar: HTMLElement;
  private touch: TouchControls | null = null;

  private overlay: Overlay = 'none';
  private scoreboardHeld = false;
  private scoreboardToggled = false;
  private active = true;
  private gameOver = false;
  private settingsOpen = false;
  private spectateId: EntityId | null = null;
  private myDeathHandled = false;
  private raf = 0;
  private lastT = 0;
  private lastMinimap = 0;
  private lastScore = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  private regionKey = '';
  private readonly keyDedupe = new UiKeyDeduper();
  private readonly airdrops = new Map<EntityId, { x: number; z: number; until: number }>();
  private lastDenied = -1e9;
  private inputEnabled: boolean | null = null;
  private minimapCss = 0;
  private readFailed = false;
  /** key codes the HUD consumed on keydown: their auto-repeats / keyup never reach the input controller */
  private readonly swallowed = new Set<string>();
  /** touch mode + language the touch bar was last built for */
  private touchBarKey = '';

  constructor(private readonly ctx: UiCtx, deps: HudDeps) {
    this.view = deps.view;
    this.handle = deps.handle;
    this.session = deps.session;
    const playerName = ctx.playerName();
    trackViewport();

    this.vitals = new VitalsPanel(ctx.portraits, playerName);
    this.killStamp = new KillStamp(ctx.portraits);
    this.feed = new KillFeed(ctx.portraits);
    this.scoreboard = new Scoreboard(ctx.portraits);
    this.weapon = new WeaponPanel();
    this.abilities = new AbilityBar((slot, index) => {
      if (slot === 'item') this.handle.input.pushAction({ a: 'item', slot: index ?? 0 });
      else this.handle.input.pushAction({ a: 'ability', slot });
    });
    this.squad = new SquadPanel((o: SquadOrderKind) => this.handle.input.pushAction({ a: 'command', order: o }));
    this.top = new TopBar((id) => entityLabel(this.view, id, getLang())?.name ?? `#${id}`);
    this.crosshair = new Crosshair(() => settings.get().fov);
    this.dmg = new DamageNumbers(this.handle.worldToScreen ? (p) => this.handle.worldToScreen?.(p) ?? null : undefined);
    this.interact = new InteractPromptView(() => this.handle.input.pushAction({ a: 'interact' }));
    this.spectate = new SpectateBar((dir) => this.cycleSpectate(dir), ctx.portraits);
    this.chat = new ChatBox(
      (text) => this.session.sendChat(text),
      () => this.closeOverlay('chat'),
    );
    this.bigmap = new BigMap(this.view.map);
    this.wheel = new Wheel(
      (c) => this.pickWheel(c),
      () => this.closeOverlay('wheel'),
    );
    this.pause = new PauseMenu({
      resume: () => this.resume(),
      settings: () => this.ctx.openSettings('controls'),
      leave: () => {
        void this.ctx.confirm(t('pause.leaveConfirm')).then((yes) => {
          if (yes) this.ctx.leaveSession(true);
        });
      },
      help: () => this.openOverlay('controls'),
    });
    this.controlsBox = h('div', { class: 'hud-controls sg-panel sg-corners', role: 'dialog' });

    this.minimapCanvas = h('canvas', { class: 'mm-canvas' });
    this.minimapCanvas.width = 256;
    this.minimapCanvas.height = 256;
    this.regionEl = h('div', { class: 'mm-region' });
    this.minimapWrap = h('div', { class: 'hud-minimap' }, h('div', { class: 'mm-ring' }, this.minimapCanvas, h('span', { class: 'mm-n' }, tx('北', 'N'))), this.regionEl);
    this.minimapWrap.addEventListener('click', () => this.toggleOverlay('map'));
    this.fpsEl = h('div', { class: 'hud-fps sg-hidden' });
    this.touchBar = h('div', { class: 'hud-touchbar sg-hidden' });

    this.el = h('div', { class: 'sg-hud', data: { overlay: 'none' } },
      this.downed.el,
      this.scope.el,
      this.dmgDir.el,
      this.dmg.el,
      this.crosshair.el,
      this.killStamp.el,
      this.top.el,
      this.minimapWrap,
      this.feed.el,
      this.announcer.el,
      this.zoneWarn.el,
      this.channel.el,
      this.interact.el,
      this.chat.el,
      h('div', { class: 'hud-left' }, this.squad.el, this.vitals.el),
      this.abilities.el,
      this.weapon.el,
      this.spectate.el,
      this.fpsEl,
      this.touchBar,
      h('div', { class: 'hud-overlay-slot score' }, this.scoreboard.el),
      h('div', { class: 'hud-overlay-slot map' }, this.bigmap.el),
      h('div', { class: 'hud-overlay-slot wheel' }, this.wheel.el),
      h('div', { class: 'hud-overlay-slot controls' }, this.controlsBox),
      h('div', { class: 'hud-overlay-slot pause' }, this.pause.el),
      h('div', { class: 'sg-rotate' }, h('div', { class: 'phone' }), h('p', null, t('hud.rotate'))),
    );

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) this.minimapCss = e.contentRect.width;
      });
      ro.observe(this.minimapCanvas);
      this.bag.add(() => ro.disconnect());
    } else {
      this.minimapCss = 210;
    }
    this.bindInput();
    this.applySettings();
    this.bag.add(settings.subscribe(() => this.applySettings()));
    this.bag.add(this.handle.onEvents((evs) => this.onEvents(evs)));
    this.bag.add(this.session.on('chat', (c) => this.chat.add({ from: c.from, text: c.text }, performance.now() / 1000)));
    // connection notices (player left / replaced by a bot / reconnected) show as system lines
    this.bag.add(
      this.session.on('status', (st) => {
        const now = performance.now() / 1000;
        const text = tx(st.zh, st.en);
        this.chat.add({ from: t('chat.system'), text, kind: 'system' }, now);
        this.announcer.push(text, 'info', undefined, now);
      }),
    );

    // initial pointer-lock state: desktop players must click into the game first
    if (!this.isTouch() && !this.safeIsLocked()) this.openPause('click');
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  setActive(on: boolean): void {
    this.active = on;
    setClass(this.el, 'inactive', !on);
    this.syncInput();
  }

  setGameOver(on: boolean): void {
    this.gameOver = on;
    setClass(this.el, 'game-over', on);
    if (on) {
      this.closeAllOverlays();
      this.touch?.setVisible(false);
      try {
        if (document.pointerLockElement) document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
    this.syncInput();
  }

  setSettingsOpen(on: boolean): void {
    this.settingsOpen = on;
    this.syncInput();
  }

  relabel(): void {
    this.vitals.relabel();
    this.weapon.relabel();
    this.abilities.relabel();
    this.squad.relabel();
    this.top.relabel();
    this.interact.relabel();
    this.channel.relabel();
    this.downed.relabel();
    this.spectate.relabel();
    this.zoneWarn.relabel();
    this.scoreboard.relabel();
    this.bigmap.relabel();
    this.wheel.render();
    this.pause.render();
    if (this.overlay === 'controls') this.renderControls();
    this.regionKey = '';
    const north = this.el.querySelector('.mm-n');
    if (north) north.textContent = tx('北', 'N');
    const rot = this.el.querySelector('.sg-rotate p');
    if (rot) rot.textContent = t('hud.rotate');
    this.renderTouchBar();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.bag.dispose();
    this.bigmap.dispose();
    this.touch?.dispose();
    this.touch = null;
    try {
      this.handle.input.setEnabled(true);
    } catch {
      /* handle may already be disposed */
    }
  }

  // ── per-frame ───────────────────────────────────────────────────────────────

  private frame(ts: number): void {
    this.raf = requestAnimationFrame((t2) => this.frame(t2));
    const now = ts / 1000;
    const dt = this.lastT ? Math.min(0.1, now - this.lastT) : 1 / 60;
    this.lastT = now;
    this.fpsFrames++;
    if (now - this.fpsT >= 0.5) {
      if (!this.fpsEl.classList.contains('sg-hidden')) setText(this.fpsEl, t('hud.fps', { n: Math.round(this.fpsFrames / (now - this.fpsT || 1)) }));
      this.fpsFrames = 0;
      this.fpsT = now;
    }
    if (!this.active) return;
    let f: HudFrame;
    try {
      f = this.readFrame(now, dt);
    } catch (err) {
      if (!this.readFailed) console.error('[hud] view read failed', err);
      this.readFailed = true;
      return;
    }
    this.readFailed = false;
    this.vitals.update(f);
    this.weapon.update(f);
    this.abilities.update(f);
    this.squad.update(f);
    this.top.update(f);
    const scoped = this.scope.update(f);
    this.crosshair.update(f, scoped);
    this.dmg.update(now);
    this.dmgDir.update(f);
    this.interact.update(f);
    this.channel.update(f);
    this.downed.update(f);
    this.spectate.update(f);
    this.zoneWarn.update(f);
    this.feed.update(now);
    this.announcer.update(now);
    this.chat.update(now);
    this.touch?.update(f.me);
    setClass(this.el, 'no-hero', !f.me);
    setClass(this.el, 'dead', !!f.me?.dead);
    setClass(this.el, 'downed', !!f.me?.downed);
    if (now - this.lastMinimap > 1 / 30) {
      this.lastMinimap = now;
      this.drawMinimap(f);
    }
    if (this.overlay === 'map') this.bigmap.draw(this.markerInput(f), now);
    if ((this.scoreboardHeld || this.scoreboardToggled) && now - this.lastScore > 0.25) {
      this.lastScore = now;
      this.scoreboard.update(f.players, f.me, this.view.localId());
    }
    this.handleDeath(f);
  }

  private readFrame(now: number, dt: number): HudFrame {
    const me = this.view.local();
    const localId = this.view.localId();
    const myEnt = localId !== null ? this.view.get(localId) : undefined;
    const spectating = !!me?.dead && this.spectateId !== null;
    const focus = spectating && this.spectateId !== null ? this.view.get(this.spectateId) ?? myEnt : myEnt;
    return {
      now,
      dt,
      elapsed: this.view.elapsed(),
      me,
      myEnt,
      focus,
      spectateId: this.spectateId,
      ents: this.view.entities(),
      zone: this.view.zone(),
      players: this.view.players(),
      lang: getLang(),
      touch: this.isTouch(),
    };
  }

  private markerInput(f: HudFrame): MarkerInput {
    for (const [id, d] of this.airdrops) if (d.until < f.now) this.airdrops.delete(id);
    return {
      me: f.me,
      focus: f.focus,
      ents: f.ents,
      zone: f.zone,
      airdrops: this.airdrops,
      now: f.now,
      knownAllies: f.me?.knownAllies ?? [],
    };
  }

  private drawMinimap(f: HudFrame): void {
    // size comes from a ResizeObserver: no layout reads inside the frame loop
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.max(64, Math.round(this.minimapCss * dpr));
    if (this.minimapCss > 0 && this.minimapCanvas.width !== size) {
      this.minimapCanvas.width = size;
      this.minimapCanvas.height = size;
    }
    drawMinimap(this.minimapCanvas, this.view.map, this.markerInput(f), MINIMAP_RADIUS);
    // region name under the minimap
    const focus = f.focus;
    let region = '';
    if (focus) {
      let best = Infinity;
      for (const r of this.view.map.regions) {
        const d = Math.hypot(focus.x - r.center.x, focus.z - r.center.z);
        if (d <= r.radius && d < best) {
          best = d;
          region = tx(r.nameZh, r.nameEn);
        }
      }
    }
    const rk = `${region}|${Math.round(focus?.x ?? 0)},${Math.round(focus?.z ?? 0)}`;
    if (rk !== this.regionKey) {
      this.regionKey = rk;
      setText(this.regionEl, region || tx(this.view.map.nameZh, this.view.map.nameEn));
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  private onEvents(evs: readonly GameEvent[]): void {
    if (!evs.length) return;
    const now = performance.now() / 1000;
    const myId = this.view.localId();
    const me = this.view.local();
    const squad = new Set(me?.squad.map((s) => s.id) ?? []);
    const lang = getLang();
    for (const ev of evs) {
      try {
        switch (ev.t) {
          case 'hit': {
            const mine = ev.src !== undefined && ev.src === myId;
            const bySquad = ev.src !== undefined && squad.has(ev.src);
            if ((mine || bySquad) && ev.target !== myId) {
              if (ev.blocked) this.dmg.spawn(t(`hud.blocked.${ev.blocked}`), 'blocked', ev.pos, now);
              else if (ev.amount > 0) this.dmg.spawn(String(Math.round(ev.amount)), ev.head ? 'head' : mine ? 'normal' : 'squad', ev.pos, now);
              if (mine && !ev.blocked && ev.amount > 0) this.crosshair.hit(ev.head ? 'head' : 'hit');
            }
            if (ev.target === myId && ev.src !== undefined && ev.src !== myId && ev.amount > 0) {
              const src = this.view.get(ev.src);
              if (src) this.dmgDir.add({ x: src.x, y: src.y, z: src.z }, now);
            }
            break;
          }
          case 'heal':
            if (ev.target === myId && ev.amount >= 1) this.dmg.spawn(`+${Math.round(ev.amount)}`, 'heal', null, now);
            break;
          case 'death':
            this.onDeath(ev, myId, lang, now);
            break;
          case 'downed': {
            const aboutMe = ev.target === myId;
            const mine = ev.src !== undefined && ev.src === myId;
            const victim = entityLabel(this.view, ev.target, lang);
            if ((aboutMe || mine) && victim?.kind === 'hero') {
              this.feed.push(this.party(ev.src, lang), this.toParty(victim), { downed: true, mine, aboutMe, now });
            }
            break;
          }
          case 'revived':
            if (ev.target === myId) this.announcer.push(tx('你被救起了！', 'You were revived!'), 'info', undefined, now);
            break;
          case 'announce':
            this.announcer.push(tx(ev.zh, ev.en), ev.kind ?? 'info', undefined, now);
            break;
          // zone phases, airdrops and the lord penalty are announced by the sim itself
          // ('announce' events): the HUD only adds the airdrop map marker
          case 'airdrop':
            this.airdrops.set(ev.id, { x: ev.pos.x, z: ev.pos.z, until: now + 90 });
            break;
          case 'claim': {
            const who = entityLabel(this.view, ev.who, lang);
            if (who) {
              this.feed.pushClaim(this.toParty(who), ev.role, now);
              const txt = CLAIM_TEXT[ev.role];
              this.chat.add({ from: `${heroName(who.heroId)}${who.heroId ? '·' : ''}${who.name}`, text: txt ? tx(txt.zh, txt.en) : roleName(ev.role), kind: 'claim', color: roleColor(ev.role) }, now);
            }
            break;
          }
          case 'quickchat': {
            const who = entityLabel(this.view, ev.who, lang);
            this.chat.add({ from: who ? `${heroName(who.heroId)}${who.heroId ? '·' : ''}${who.name}` : '?', text: quickChatText(ev.id, lang), kind: 'quick' }, now);
            break;
          }
          case 'chat':
            this.chat.add({ from: ev.from, text: ev.text }, now);
            break;
          case 'reward':
            if (ev.who === myId) {
              if (ev.kind === 'rebelKill') this.announcer.push(t('hud.reward.rebelKill'), 'big', ev.items?.map(pickupName).join(tx('、', ', ')), now);
              else if (ev.kind === 'bounty') this.announcer.push(t('hud.reward.bounty'), 'big', ev.items?.map(pickupName).join(tx('、', ', ')), now);
            }
            break;
          case 'pickup':
            if (ev.who === myId) this.announcer.push(t('hud.pickup', { name: pickupName(ev.item) }), 'info', undefined, now);
            break;
          case 'sfx':
            // the sim refused a card / ability of ours: say why when the sim tells us, else stay neutral
            if ((ev.name === 'itemDenied' || ev.name === 'abilityDenied') && (ev.privateTo === undefined || ev.privateTo === myId) && now - this.lastDenied > 1.2) {
              this.lastDenied = now;
              const msg = deniedText(ev as { reason?: unknown; item?: unknown });
              this.announcer.push(tx(msg.zh, msg.en), 'warn', undefined, now);
            }
            break;
          case 'command':
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('[hud] event failed', ev.t, err);
      }
    }
  }

  private onDeath(ev: Extract<GameEvent, { t: 'death' }>, myId: EntityId | null, lang: 'zh' | 'en', now: number): void {
    if (ev.kind !== 'hero') return;
    const victim: FeedParty = {
      name: ev.name ?? entityLabel(this.view, ev.target, lang)?.name ?? `#${ev.target}`,
      heroId: ev.heroId ?? entityLabel(this.view, ev.target, lang)?.heroId,
      kingdom: this.view.players().find((p) => p.entityId === ev.target)?.kingdom,
      role: ev.role,
    };
    const killer = this.party(ev.killer, lang);
    const mine = ev.killer !== undefined && ev.killer === myId;
    const aboutMe = ev.target === myId;
    this.feed.push(killer, victim, { mine, aboutMe, now });
    if (mine && !aboutMe) {
      this.killStamp.show(`${heroName(victim.heroId)}${victim.role ? `（${roleName(victim.role)}）` : ''}`, victim.heroId);
      this.crosshair.hit('kill');
    }
    if (aboutMe) {
      this.spectate.killer = killer ? `${killer.heroId ? `${heroName(killer.heroId)}·` : ''}${killer.name}` : t('hud.zoneDeath');
      this.spectate.killerHero = killer?.heroId ?? null;
      const killerId = ev.killer !== undefined && this.view.players().some((p) => p.entityId === ev.killer && p.alive) ? ev.killer : null;
      this.setSpectate(killerId ?? cycleSpectate(this.view.players(), null, 1, myId));
    } else if (this.spectateId === ev.target) {
      this.setSpectate(cycleSpectate(this.view.players(), ev.target, 1, myId));
    }
    // role reveal banner for important deaths
    if (ev.role === 'lord') this.announcer.push(tx('主公阵亡！', 'The Lord has fallen!'), 'big', undefined, now);
  }

  private party(id: EntityId | undefined, lang: 'zh' | 'en'): FeedParty | null {
    const l = entityLabel(this.view, id, lang);
    return l ? this.toParty(l) : null;
  }

  private toParty(l: { name: string; heroId?: string; kingdom?: ViewEntity['kingdom']; role?: FeedParty['role'] }): FeedParty {
    return { name: l.name, heroId: l.heroId, kingdom: l.kingdom, role: l.role };
  }

  private handleDeath(f: HudFrame): void {
    const dead = !!f.me?.dead;
    if (dead && !this.myDeathHandled) {
      this.myDeathHandled = true;
      if (this.spectateId === null) this.setSpectate(cycleSpectate(f.players, null, 1, f.me?.entityId ?? null));
      try {
        if (document.pointerLockElement) document.exitPointerLock();
      } catch {
        /* ignore */
      }
      if (this.overlay === 'pause') this.closeOverlay('pause');
    } else if (!dead && this.myDeathHandled) {
      this.myDeathHandled = false;
      this.setSpectate(null);
    }
    // spectate target died → next
    if (dead && this.spectateId !== null) {
      const tgt = f.players.find((p) => p.entityId === this.spectateId);
      if (tgt && !tgt.alive) this.setSpectate(cycleSpectate(f.players, this.spectateId, 1, f.me?.entityId ?? null));
    }
  }

  private setSpectate(id: EntityId | null): void {
    if (id === this.spectateId) return;
    this.spectateId = id;
    try {
      this.handle.setSpectateTarget(id);
    } catch (err) {
      console.warn('[hud] setSpectateTarget failed', err);
    }
  }

  private cycleSpectate(dir: 1 | -1): void {
    const next = cycleSpectate(this.view.players(), this.spectateId, dir, this.view.localId());
    this.setSpectate(next);
    this.ctx.sfx('click');
  }

  // ── input / overlays ──────────────────────────────────────────────────────

  private bindInput(): void {
    this.bag.add(this.handle.input.onUiKey((key, down) => this.onUiKey(key, down, 'ctl')));
    const doc = this.el.ownerDocument;
    // The HUD listens on the document, the input controller on the window: every key
    // the HUD consumes stops propagating here so it cannot also become a gameplay
    // action (a wheel pick re-enables input synchronously, and the same Digit6 would
    // otherwise use item slot 3).
    this.bag.listen(doc, 'keydown', (ev: KeyboardEvent) => {
      if (this.swallowed.has(ev.code)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (!this.active || this.gameOver || this.settingsOpen) return;
      if (isTextInput(ev.target)) return;
      const consume = (): void => {
        ev.preventDefault();
        ev.stopPropagation();
        this.swallowed.add(ev.code);
      };
      if (this.overlay === 'wheel' && /^(Digit|Numpad)[1-9]$/.test(ev.code)) {
        consume();
        this.wheel.pickIndex(Number(ev.code.slice(-1)) - 1);
        return;
      }
      if (this.dead() && (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight')) {
        consume();
        this.cycleSpectate(ev.code === 'ArrowLeft' ? -1 : 1);
        return;
      }
      const key = keyToUi(ev.code);
      if (!key) return;
      ev.stopPropagation();
      if (key === 'scoreboard') ev.preventDefault();
      if (key === 'chat' && this.overlay === 'none') ev.preventDefault();
      if (ev.repeat && key !== 'scoreboard') return;
      this.onUiKey(key, true, 'doc');
    });
    this.bag.listen(doc, 'keyup', (ev: KeyboardEvent) => {
      if (this.swallowed.delete(ev.code)) {
        ev.stopPropagation();
        return;
      }
      if (ev.code === 'Tab') {
        ev.preventDefault();
        ev.stopPropagation();
        this.onUiKey('scoreboard', false, 'doc');
      }
    });
    this.bag.listen(doc, 'pointerlockchange', () => {
      const locked = this.safeIsLocked();
      if (locked) {
        if (this.overlay === 'pause') this.closeOverlay('pause', true);
        return;
      }
      // lost the lock during play → pause (desktop only)
      if (!this.isTouch() && this.active && !this.gameOver && !this.dead() && this.overlay === 'none' && !this.settingsOpen) {
        this.openPause('menu');
        this.pauseByUnlockAt = performance.now();
      }
    });
    this.bag.listen(doc, 'pointerlockerror', () => {
      if (!this.isTouch() && this.overlay === 'none' && this.active && !this.gameOver && !this.dead()) this.openPause('click');
    });
    this.bag.listen(window, 'blur', () => {
      this.swallowed.clear();
      if (this.scoreboardHeld) this.onUiKey('scoreboard', false, 'ui');
    });
  }

  /** `src`: 'ctl' = input controller, 'doc' = HUD key listener, 'ui' = on-screen button (never deduped). */
  private onUiKey(key: UiKey, down: boolean, src: 'ctl' | 'doc' | 'ui' = 'ui'): void {
    if (!this.active || this.gameOver) return;
    if (src !== 'ui' && !this.keyDedupe.accept(`${key}:${down}`, src, performance.now())) return;
    if (key === 'scoreboard') {
      if (this.scoreboardHeld === down) return;
      this.scoreboardHeld = down;
      this.lastScore = 0;
      this.renderScoreboardVisibility();
      return;
    }
    if (!down || this.settingsOpen) return;
    switch (key) {
      case 'menu':
        // the Esc that released the pointer lock may also arrive as a key: keep the menu open
        if (this.overlay === 'pause' && performance.now() - this.pauseByUnlockAt < 350) break;
        if (this.overlay === 'pause') {
          if (this.pauseMode === 'menu') this.resume(true);
          else this.openPause('menu');
        } else if (this.overlay !== 'none') this.closeOverlay(this.overlay);
        else this.openPause('menu');
        break;
      case 'map':
        this.toggleOverlay('map');
        break;
      case 'chat':
        if (this.overlay === 'none' || this.overlay === 'map') this.openOverlay('chat');
        else if (this.overlay === 'chat') this.chat.setOpen(true);
        break;
      case 'quickchat':
        if (this.dead()) break;
        this.toggleOverlay('wheel');
        break;
    }
  }

  private pauseMode: 'menu' | 'click' = 'menu';
  private pauseByUnlockAt = -1e9;

  private openPause(mode: 'menu' | 'click'): void {
    this.pauseMode = mode;
    this.pause.setMode(mode);
    this.openOverlay('pause');
  }

  /** Resume from the pause menu. `viaKey` = Esc (cannot grab the pointer lock). */
  private resume(viaKey = false): void {
    if (this.isTouch() || this.safeIsLocked() || this.dead()) {
      this.closeOverlay('pause', true);
      return;
    }
    if (viaKey) {
      this.pauseMode = 'click';
      this.pause.setMode('click');
      return;
    }
    this.closeOverlay('pause', true);
    try {
      this.handle.input.requestLock();
    } catch (err) {
      console.warn('[hud] requestLock failed', err);
    }
  }

  private toggleOverlay(o: Overlay): void {
    if (this.overlay === o) this.closeOverlay(o);
    else this.openOverlay(o);
  }

  private openOverlay(o: Overlay): void {
    if (this.overlay === o) return;
    if (this.overlay === 'chat') this.chat.setOpen(false);
    this.overlay = o;
    this.el.dataset.overlay = o;
    if (o === 'chat') this.chat.setOpen(true);
    if (o === 'controls') this.renderControls();
    if (o === 'wheel' || o === 'pause' || o === 'controls') {
      try {
        if (document.pointerLockElement && o !== 'pause') document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
    this.ctx.sfx(o === 'pause' ? 'back' : 'click');
    this.syncInput();
  }

  private closeOverlay(o: Overlay, silent = false): void {
    if (this.overlay !== o) return;
    if (o === 'chat') this.chat.setOpen(false);
    this.overlay = 'none';
    this.el.dataset.overlay = 'none';
    this.syncInput();
    if (o === 'controls') {
      this.openPause('menu');
      return;
    }
    if (silent || this.isTouch() || this.safeIsLocked() || this.dead() || !this.active || this.gameOver) return;
    if (o === 'wheel' || o === 'pause') {
      // closed by a click / key with the pointer free → ask for the lock again
      try {
        this.handle.input.requestLock();
      } catch {
        /* ignore */
      }
    } else if (o === 'chat' || o === 'map') {
      // the pointer lock was lost while chat / the map was open (Esc under pointer
      // lock): the player is back in the game with a free cursor → click to play
      this.openPause('click');
    }
  }

  private closeAllOverlays(): void {
    if (this.overlay !== 'none') {
      if (this.overlay === 'chat') this.chat.setOpen(false);
      this.overlay = 'none';
      this.el.dataset.overlay = 'none';
    }
    this.scoreboardHeld = false;
    this.scoreboardToggled = false;
    this.renderScoreboardVisibility();
  }

  private renderScoreboardVisibility(): void {
    const on = this.scoreboardHeld || this.scoreboardToggled;
    setClass(this.el, 'show-score', on);
    if (on) {
      const f = this.readFrame(performance.now() / 1000, 0);
      this.scoreboard.update(f.players, f.me, this.view.localId());
    }
  }

  private pickWheel(c: WheelChoice): void {
    // close first: the wheel disables gameplay input, and the input controller drops
    // actions pushed while disabled
    this.closeOverlay('wheel');
    try {
      if (c.kind === 'claim') this.handle.input.pushAction({ a: 'claim', role: c.role });
      else this.handle.input.pushAction({ a: 'quickchat', id: c.id });
    } catch (err) {
      console.warn('[hud] pushAction failed', err);
    }
    this.ctx.sfx('confirm');
  }

  private renderControls(): void {
    this.controlsBox.replaceChildren(
      h('div', { class: 'ctl-head' }, h('h2', { class: 'sg-h2' }, t('pause.controls')), button(t('common.back'), () => this.closeOverlay('controls'), { cls: 'small dark', sfx: 'back' })),
      h('div', { class: 'ctl-grid' }, CONTROLS.map((c) => h('div', { class: 'ctl' }, h('span', { class: 'keys' }, c.keys.map((k) => keyCap(k === '左键' ? tx('左键', 'LMB') : k === '右键' ? tx('右键', 'RMB') : k === '中键' ? tx('中键', 'MMB') : k))), h('span', null, tx(c.zh, c.en))))),
    );
  }

  /** Enable gameplay input only when nothing modal is open. */
  private syncInput(): void {
    const on = this.active && !this.gameOver && !this.settingsOpen && (this.overlay === 'none' || this.overlay === 'map');
    if (on === this.inputEnabled) return;
    this.inputEnabled = on;
    try {
      this.handle.input.setEnabled(on);
    } catch (err) {
      console.warn('[hud] setEnabled failed', err);
    }
    this.touch?.setVisible(on && !this.gameOver);
  }

  // ── settings / touch ──────────────────────────────────────────────────────

  private applySettings(): void {
    const st = settings.get();
    setClass(this.fpsEl, 'sg-hidden', !st.showFps);
    const wantTouch = this.isTouch();
    if (wantTouch && !this.touch) {
      this.touch = mountTouchControls(this.el, this.handle.input, { onInteract: () => undefined });
      this.touch.setVisible(this.inputEnabled !== false && !this.gameOver);
      if (this.overlay === 'pause' && this.pauseMode === 'click') this.closeOverlay('pause', true);
    } else if (!wantTouch && this.touch) {
      this.touch.dispose();
      this.touch = null;
      try {
        this.handle.input.setTouchMode(false);
      } catch {
        /* ignore */
      }
    }
    setClass(this.el, 'touch', wantTouch);
    // settings change often during a match (sensitivity sliders…): rebuild only when needed
    const tk = `${wantTouch}|${getLang()}`;
    if (tk !== this.touchBarKey) this.renderTouchBar();
  }

  private renderTouchBar(): void {
    const on = this.isTouch();
    this.touchBarKey = `${on}|${getLang()}`;
    setClass(this.touchBar, 'sg-hidden', !on);
    if (!on) return;
    const b = (label: string, title: string, fn: () => void): HTMLElement => {
      const el = h('button', { class: 'tb', type: 'button', title, aria: { label: title } }, label);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
      return el;
    };
    this.touchBar.replaceChildren(
      b('令', t('wheel.title'), () => this.onUiKey('quickchat', true)),
      b('聊', t('lobby.chat'), () => this.onUiKey('chat', true)),
      b('图', t('map.title'), () => this.onUiKey('map', true)),
      b('战', t('score.title'), () => {
        this.scoreboardToggled = !this.scoreboardToggled;
        this.renderScoreboardVisibility();
      }),
      b('☰', t('pause.title'), () => this.onUiKey('menu', true)),
    );
  }

  private isTouch(): boolean {
    return shouldUseTouch(settings.get().touchControls);
  }

  private safeIsLocked(): boolean {
    try {
      return this.handle.input.isLocked();
    } catch {
      return false;
    }
  }

  private dead(): boolean {
    return !!this.view.local()?.dead;
  }

  /** For tests / harness: current overlay. */
  get currentOverlay(): Overlay {
    return this.overlay;
  }
}

function keyToUi(code: string): UiKey | null {
  switch (code) {
    case 'Tab':
      return 'scoreboard';
    case 'KeyM':
      return 'map';
    case 'Enter':
    case 'NumpadEnter':
      return 'chat';
    case 'Escape':
      return 'menu';
    case 'KeyT':
      return 'quickchat';
    default:
      return null;
  }
}

