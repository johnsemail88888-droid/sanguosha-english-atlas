// The in-match HUD. Reads the ViewSource once per animation frame and GameEvents
// through GameHandle.onEvents (never drains the view itself). Owns the in-match
// overlays (scoreboard, big map, wheel, chat, pause) and the touch overlay.
import type { EntityId, GameEvent, SquadOrderKind, ViewEntity } from '../../core/types';
import { VF_LORD } from '../../core/types';
import { HERO_BY_ID, ITEM_BY_ID } from '../../data';
import type { GameSession } from '../../game/session';
import { displayName } from '../../game/names';
import { settings } from '../../game/settings';
import type { ViewSource } from '../../render/view';
import type { GameHandle, PerfInfo, UiKey } from '../app';
import type { UiCtx } from '../ctx';
import { Bag, h, isTextInput, setClass, setText } from '../dom';
import { getLang, heroName, roleName, t, tx } from '../i18n';
import { CLAIM_TEXT, quickChatText, roleColor } from '../theme';
import { touchLabel, type TouchKey } from '../short';
import { mountTouchControls, shouldUseTouch, type TouchControls } from '../touch';
import { button, keyCap } from '../widgets';
import { controlsFor, touchControlCells } from '../screens/help';
import { AbilityBar, SquadPanel, TopBar, VitalsPanel, WeaponPanel } from './panels';
import { ChannelBar, Crosshair, DamageDirection, DamageNumbers, DuelBar, InteractPromptView, KillStamp, Scope, SquadFocusWarning, ZoneWarning } from './combat';
import { DeathCard, DownedPanel, KnockStamp, ReviveMarkers, ReviveRing, SpectatePanel, killerSnapshot } from './fallen';
import { DamageLog, HelpCalls, MARKER_RANGE, bledOut, downedMarkers, knownFriends, type DownedMarker } from './deathlog';
import { Announcer, ChatBox, KillFeed, PickupStrip, type FeedParty } from './feed';
import { createGuideCard, fitGuideCard, guideClockRuns, guideCount, guideMayMount, shouldShowGuide } from './guide';
import { drawMinimap, type MarkerInput } from './minimap';
import { BigMap, PauseMenu, Scoreboard, Wheel, cardRow, type WheelChoice } from './overlays';
import { UiKeyDeduper, cycleSpectate, deniedText, entityLabel } from './logic';
import { KillCauses } from './killcause';
import { LinkStatus, silentSecs } from './connstatus';
import { prewarmWeapons } from '../artIcons';
import type { HudFrame } from './types';
import { trackViewport } from './viewport';
import { gpuWarnDismissed, gpuWarning, isMac, perfLines } from '../perfcheck';

/** `setPaused` of a local single-player session (GameSession G2 extension; optional). */
type PausableSession = GameSession & { setPaused?(paused: boolean): void };

export interface HudDeps {
  view: ViewSource;
  handle: GameHandle;
  session: GameSession;
}

type Overlay = 'none' | 'pause' | 'chat' | 'wheel' | 'map' | 'controls';

/** Phones held upright get the "rotate to landscape" cover (same query as .sg-rotate in styles/hud.ts). */
export const ROTATE_QUERY = '(orientation: portrait) and (max-width: 820px)';

const MINIMAP_RADIUS = 85;

/** The touch guide is fitted again this many times, 0.5 s apart, after it first shows (layout / fonts settling). */
const GUIDE_SETTLE_REFITS = 6;
/** Seconds the camera stays on your own body after death (the renderer pulls back over it) before spectating the killer. */
export const DEATH_CAM_TIME = 1.8;

export class Hud {
  readonly el: HTMLElement;
  private readonly bag = new Bag();
  // released on dispose(): a disposed HUD must not keep the match (view, renderer handle, session) alive
  private view: ViewSource;
  private handle: GameHandle;
  private session: GameSession;

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
  /** 倒地: desaturated world, bleed-out bar, who is reviving you, how to get up (fallen.ts) */
  private readonly downed = new DownedPanel();
  private readonly spectate: SpectatePanel;
  /** 救 markers over downed heroes you may save, the reviver's ring, 击倒 stamp, death recap */
  private readonly rvMarks: ReviveMarkers;
  private readonly rvRing: ReviveRing;
  private readonly knockStamp = new KnockStamp();
  private readonly deathCard: DeathCard;
  /** hits you took (death recap) and who called for a 桃 lately (revive markers) */
  private readonly damageLog = new DamageLog();
  private readonly helpCalls = new HelpCalls();
  private myDownedBy: EntityId | undefined;
  /** HUD time you were knocked down in this life (the recap reaches back past a long bleed-out) */
  private myDownedAt: number | undefined;
  /** heroes you (or your troops) knocked down: a 补刀 marker over them, never a 救 */
  private readonly knockedByMe = new Set<EntityId>();
  /** the moment of death: the camera pulls back over your body until then, then goes to the killer */
  private deathCamUntil = -1;
  /** whom to spectate once the death moment is over (null: the next living hero) */
  private pendingSpectate: EntityId | null | undefined;
  /** cards / gear you carried while alive (the death card says they lie at your body) */
  private carried = { cards: 0, gear: 0 };
  /** this frame's revive markers, for the minimap / big map too */
  private sosMarks: readonly DownedMarker[] = [];
  private readonly zoneWarn = new ZoneWarning();
  /** 「主公卫队正在攻击你」: a squad focusing you */
  private readonly focusWarn = new SquadFocusWarning();
  private readonly duel: DuelBar;
  private readonly feed: KillFeed;
  private readonly announcer = new Announcer();
  /** what you just got: compact lines above the item bar (COMBAT-8) */
  readonly pickups = new PickupStrip();
  private readonly chat: ChatBox;
  private readonly scoreboard: Scoreboard;
  private readonly bigmap: BigMap;
  private readonly wheel: Wheel;
  private readonly pause: PauseMenu;
  private readonly controlsBox: HTMLElement;
  private readonly minimapCanvas: HTMLCanvasElement;
  private readonly minimapWrap: HTMLElement;
  private readonly regionEl: HTMLElement;
  /** F3 / 设置 → 显示帧率: frame rate, frame and JS time, draw calls, render scale, tier, GPU */
  private readonly fpsEl: HTMLElement;
  private readonly perfRows: HTMLElement;
  /** top-left column under the role chip: the software-renderer warning and the F3 panel */
  private readonly diagEl: HTMLElement;
  private readonly touchBar: HTMLElement;
  private readonly cardInfo: HTMLElement;
  private cardInfoTimer: ReturnType<typeof setTimeout> | null = null;
  private guide: HTMLElement | null = null;
  private guideTimer: ReturnType<typeof setTimeout> | null = null;
  /** the guide is due but the rotate cover is up: it goes up (and is counted) on the first landscape frame */
  private guidePending = false;
  /** 「应用中…」 while a mid-match quality switch applies (above the pause menu) */
  private readonly applyingEl = h('div', { class: 'hud-applying sg-hidden', role: 'status' });
  /** what the touch guide was last fitted to (screen size, the Lord's G button): refit when it changes */
  private guideFit = '';
  /** when it was last fitted, and how many settle-in refits it has had (text metrics can still move right after it shows) */
  private guideFitAt = 0;
  private guideRefits = 0;
  private touch: TouchControls | null = null;
  /** portrait phone: the rotate-to-landscape cover is up */
  private rotating = false;
  /** last value sent to session.setPaused (single player only) */
  private pausedSent = false;
  private disposed = false;

  private overlay: Overlay = 'none';
  private scoreboardHeld = false;
  private scoreboardToggled = false;
  private active = true;
  private gameOver = false;
  private settingsOpen = false;
  private spectateId: EntityId | null = null;
  /** spectating from the watched hero's eye (V) */
  private spectateFp = false;
  private myDeathHandled = false;
  private raf = 0;
  private lastT = 0;
  private lastMinimap = 0;
  private lastScore = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  private regionKey = '';
  private readonly keyDedupe = new UiKeyDeduper();
  /** a guest's link to the host: one live chip instead of a chat line + announcement per status */
  private readonly link = new LinkStatus();
  /** the match's weapon renders were queued for their cut-out (kill feed / pickups show them without a hitch) */
  private prewarmed = false;
  /** what each kill / down was made with (kill feed glyph when the art ships) */
  private readonly causes = new KillCauses({
    heldWeapon: (id) => this.view?.get(id)?.weapon,
    ownerOf: (id) => this.view?.get(id)?.owner,
  });
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
    this.scoreboard = new Scoreboard(() => this.setScoreboardToggled(false), ctx.portraits);
    this.duel = new DuelBar((id) => this.nameOf(id));
    this.weapon = new WeaponPanel();
    this.abilities = new AbilityBar((slot, index) => {
      if (slot === 'item') this.handle.input.pushAction({ a: 'item', slot: index ?? 0 });
      else this.handle.input.pushAction({ a: 'ability', slot });
    });
    this.squad = new SquadPanel((o: SquadOrderKind) => this.handle.input.pushAction({ a: 'command', order: o }));
    this.top = new TopBar((id) => entityLabel(this.view, id, getLang())?.name ?? `#${id}`);
    // the link chip's buttons: 重试 restarts the automatic rejoin now, 离开 leaves the room (MP2-1 / MP2-2)
    this.top.onLinkAction = (a) => {
      if (a === 'retry') this.session.retryNow?.();
      else this.confirmLeave();
    };
    this.crosshair = new Crosshair(() => settings.get().fov);
    this.dmg = new DamageNumbers(this.handle.worldToScreen ? (p) => this.handle.worldToScreen?.(p) ?? null : undefined);
    this.interact = new InteractPromptView(() => this.handle.input.pushAction({ a: 'interact' }));
    this.deathCard = new DeathCard(ctx.portraits, () => this.deathCard.hide(), () => this.confirmLeave());
    this.spectate = new SpectatePanel((dir) => this.cycleSpectate(dir), (id) => this.nameOf(id), ctx.portraits, () => this.deathCard.reopen(), () => this.confirmLeave());
    this.rvMarks = new ReviveMarkers(this.handle.worldToScreen ? (p) => this.handle.worldToScreen?.(p) ?? null : undefined, (id) => this.nameOf(id));
    this.rvRing = new ReviveRing((id) => this.nameOf(id));
    this.chat = new ChatBox(
      (text) => this.session.sendChat(text),
      () => this.closeOverlay('chat'),
      () => this.isTouch(),
    );
    this.bigmap = new BigMap(this.view.map, () => this.closeOverlay('map'));
    this.wheel = new Wheel(
      (c) => this.pickWheel(c),
      () => this.closeOverlay('wheel'),
      () => this.isTouch(),
    );
    const online = (): boolean => this.ctx.sessionKind === 'online';
    this.pause = new PauseMenu(
      {
        resume: () => this.resume(),
        settings: () => this.ctx.openSettings('controls'),
        leave: () => this.confirmLeave(),
        help: () => this.openOverlay('controls'),
        endMatch: () => {
          void this.ctx.confirm(t('pause.endConfirm')).then((yes) => {
            if (yes && !this.disposed) this.session.returnToLobby();
          });
        },
      },
      {
        online,
        isHost: () => this.session.isHost,
        items: () => this.view.local()?.items ?? [],
        role: () => this.view.local()?.role,
      },
    );
    this.controlsBox = h('div', { class: 'hud-controls sg-panel sg-corners', role: 'dialog' });

    this.minimapCanvas = h('canvas', { class: 'mm-canvas' });
    this.minimapCanvas.width = 256;
    this.minimapCanvas.height = 256;
    this.regionEl = h('div', { class: 'mm-region' });
    this.minimapWrap = h('div', { class: 'hud-minimap' }, h('div', { class: 'mm-ring' }, this.minimapCanvas, h('span', { class: 'mm-n' }, tx('北', 'N'))), this.regionEl);
    this.bag.listen(this.minimapWrap, 'click', () => this.toggleOverlay('map'));
    this.perfRows = h('div', { class: 'rows' });
    // 性能体检 from the panel (clickable while the pointer is free: pause menu, touch)
    const perfOpen = ctx.openPerfCheck ? button(tx('性能体检', 'Performance check'), () => this.ctx.openPerfCheck?.(), { cls: 'small dark pc-open' }) : null;
    this.fpsEl = h('div', { class: 'hud-perf sg-hidden' }, this.perfRows, perfOpen);
    // WebGL on a software renderer: the match crawls whatever the machine — say so (desktop HUD; the title says it too)
    const gpu = ctx.gpu;
    const gpuWarn = gpu?.software && !gpuWarnDismissed(gpu.renderer) ? gpuWarning('hud', gpu.renderer, () => gpuWarn?.remove()) : null;
    this.diagEl = h('div', { class: 'hud-diag' }, gpuWarn, this.fpsEl);
    this.touchBar = h('div', { class: 'hud-touchbar sg-hidden' });
    this.cardInfo = h('div', { class: 'hud-cardinfo off', role: 'status' });
    this.bag.listen(this.cardInfo, 'click', () => this.hideCardInfo());
    // modal overlays close on a tap / click on their backdrop (the empty area around the panel)
    const wheelSlot = h('div', { class: 'hud-overlay-slot wheel modal' }, this.wheel.el);
    this.bag.listen(wheelSlot, 'click', (ev) => {
      if (ev.target === wheelSlot) this.closeOverlay('wheel');
    });
    const chatBack = h('div', { class: 'hud-overlay-slot chatback modal' });
    this.bag.listen(chatBack, 'click', () => this.closeOverlay('chat'));

    this.el = h('div', { class: 'sg-hud', data: { overlay: 'none' } },
      this.downed.el,
      this.rvMarks.el,
      this.scope.el,
      this.dmgDir.el,
      this.focusWarn.el,
      this.dmg.el,
      this.crosshair.el,
      this.rvRing.el,
      this.killStamp.el,
      this.knockStamp.el,
      this.top.el,
      this.minimapWrap,
      this.feed.el,
      this.announcer.el,
      this.zoneWarn.el,
      this.duel.el,
      this.channel.el,
      this.interact.el,
      this.chat.el,
      h('div', { class: 'hud-left' }, this.squad.el, this.vitals.el),
      this.abilities.el,
      this.pickups.el,
      this.weapon.el,
      this.spectate.el,
      this.deathCard.el,
      this.diagEl,
      this.cardInfo,
      this.touchBar,
      // map + scoreboard let touches through around the panel (stick / fire keep working);
      // wheel, chat, controls and pause are modal
      h('div', { class: 'hud-overlay-slot score' }, this.scoreboard.el),
      h('div', { class: 'hud-overlay-slot map' }, this.bigmap.el),
      chatBack,
      wheelSlot,
      h('div', { class: 'hud-overlay-slot controls modal' }, this.controlsBox),
      h('div', { class: 'hud-overlay-slot pause modal' }, this.pause.el),
      this.applyingEl,
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
    // PLATFORM-4: a mid-match graphics switch is applied in stages — 「应用中…」 over the HUD; single player stays paused meanwhile
    const offApplying = this.ctx.qualityApplying?.((on) => this.setQualityApplying(on));
    if (offApplying) this.bag.add(offApplying);
    this.bag.add(this.handle.onEvents((evs) => this.onEvents(evs)));
    this.bag.add(
      this.session.on('chat', (c) => {
        // lobby notices (join / leave / kick) also arrive as 'status' below: show them once
        if ((c as { system?: boolean }).system) return;
        this.chat.add({ from: this.speaker(c.from), text: c.text }, performance.now() / 1000);
      }),
    );
    // connection notices (player left / replaced by a bot / reconnected) show as system lines
    this.bag.add(
      this.session.on('status', (st) => {
        const now = performance.now() / 1000;
        // the link to the host: the chip (+ one chat line for a lasting trouble, updated in place), no announcement
        const ln = this.link.push(st, now);
        if (ln.handled) {
          this.top.setLink(this.link.chip);
          if (ln.chat) this.chat.add({ from: t('chat.system'), text: tx(ln.chat.zh, ln.chat.en), kind: 'system', key: ln.chat.key }, now);
          return;
        }
        const text = tx(st.zh, st.en);
        this.chat.add({ from: t('chat.system'), text, kind: 'system' }, now);
        this.announcer.push(text, 'info', undefined, now);
      }),
    );

    // a phone held upright shows the rotate cover: single player pauses behind it
    const mq = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(ROTATE_QUERY) : null;
    if (mq) {
      this.rotating = mq.matches;
      const onRotate = (): void => {
        this.rotating = mq.matches;
        this.syncPause();
      };
      mq.addEventListener?.('change', onRotate);
      this.bag.add(() => mq.removeEventListener?.('change', onRotate));
    }

    // first two matches: a hint card with the keys that are easy to miss (NP-3: never behind the rotate cover)
    if (shouldShowGuide(guideCount())) {
      if (guideMayMount(this.rotating)) this.showGuide();
      else this.guidePending = true;
    }

    // initial pointer-lock state: desktop players must click into the game first
    if (!this.isTouch() && !this.safeIsLocked()) this.openPause('click');
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  setActive(on: boolean): void {
    this.active = on;
    setClass(this.el, 'inactive', !on);
    this.syncInput();
    this.syncPause();
  }

  setGameOver(on: boolean): void {
    this.gameOver = on;
    setClass(this.el, 'game-over', on);
    if (on) {
      this.closeAllOverlays();
      this.touch?.setVisible(false);
      this.releasePointer();
      this.closeGuide();
    }
    this.syncInput();
    this.syncPause();
  }

  setSettingsOpen(on: boolean): void {
    this.settingsOpen = on;
    this.syncInput();
    this.syncPause();
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
    this.rvMarks.relabel();
    this.rvRing.relabel();
    this.deathCard.relabel();
    this.zoneWarn.relabel();
    this.duel.relabel();
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
    this.touch?.relabel();
    this.renderTouchBar();
  }

  dispose(): void {
    if (this.disposed) return;
    // an unmounted HUD never leaves a local match paused
    if (this.pausedSent) this.sendPaused(false);
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.bag.dispose();
    this.bigmap.dispose();
    this.touch?.dispose();
    this.touch = null;
    this.hideCardInfo();
    this.closeGuide();
    try {
      this.handle.input.setEnabled(true);
    } catch {
      /* handle may already be disposed */
    }
    this.airdrops.clear();
    this.swallowed.clear();
    const gone = null as unknown;
    this.view = gone as ViewSource;
    this.handle = gone as GameHandle;
    this.session = gone as GameSession;
  }

  // ── per-frame ───────────────────────────────────────────────────────────────

  private frame(ts: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((t2) => this.frame(t2));
    const now = ts / 1000;
    const dt = this.lastT ? Math.min(0.1, now - this.lastT) : 1 / 60;
    this.lastT = now;
    this.fpsFrames++;
    if (now - this.fpsT >= 0.5) {
      if (!this.fpsEl.classList.contains('sg-hidden')) this.renderPerf(this.fpsFrames / (now - this.fpsT || 1));
      this.fpsFrames = 0;
      this.fpsT = now;
    }
    if (this.guidePending && !this.gameOver && guideMayMount(this.rotating)) {
      this.guidePending = false;
      if (shouldShowGuide(guideCount())) this.showGuide();
    }
    if (!this.active) return;
    if (this.guide) {
      const runs = guideClockRuns({ overlay: this.overlay, rotating: this.rotating });
      if (runs && this.guideTimer === null) this.guideTimer = setTimeout(() => this.closeGuide(), 45_000);
      else if (!runs && this.rotating && this.guideTimer !== null) {
        // held upright again: the card waits behind the cover with its full time
        clearTimeout(this.guideTimer);
        this.guideTimer = null;
      }
    }
    let f: HudFrame;
    try {
      f = this.readFrame(now, dt);
    } catch (err) {
      if (!this.readFailed) console.error('[hud] view read failed', err);
      this.readFailed = true;
      return;
    }
    this.readFailed = false;
    const lk = this.link.update(now);
    if (lk.chip) this.top.setLink(this.link.chip);
    // waiting on a silent host: the chip counts the seconds (responsive time, session.hostSilentMs)
    if (this.link.state === 'waiting') this.top.setLinkSecs(silentSecs(this.session.hostSilentMs));
    if (lk.chat) this.chat.add({ from: t('chat.system'), text: tx(lk.chat.zh, lk.chat.en), kind: 'system', key: lk.chat.key }, now);
    if (!this.prewarmed && f.players.length) {
      this.prewarmed = true;
      prewarmWeapons([...f.players.map((p) => HERO_BY_ID[p.heroId]?.signatureWeapon), 'pistol']);
    }
    this.vitals.update(f);
    this.weapon.update(f);
    this.abilities.update(f);
    this.squad.update(f);
    this.top.update(f);
    const scoped = this.scope.update(f);
    this.crosshair.update(f, scoped);
    this.dmg.update(now);
    this.dmgDir.update(f);
    const prompt = this.interact.update(f);
    this.channel.update(f);
    this.updateFallen(f, now);
    this.zoneWarn.update(f);
    this.focusWarn.update(f, now, (id) => {
      const c = id !== undefined ? this.view.get(id) : undefined;
      if (!c || c.kind !== 'hero') return { kind: 'wild', name: '' };
      return { kind: c.flags & VF_LORD ? 'lord' : 'hero', name: heroName(c.sub) };
    });
    this.duel.update(f);
    this.feed.update(now);
    this.announcer.update(now);
    this.pickups.update(now);
    this.chat.update(now);
    this.touch?.update(f.me);
    // downed: the touch interact button calls for help (F)
    this.touch?.setInteract?.(f.me?.downed && !f.me.dead ? 'selfRevive' : prompt?.kind ?? null);
    // touch: the guide is fitted once the HUD is on screen (it is built during loading), and again
    // when what it shares the screen with changes — the size, the Lord's G button appearing
    if (this.guide && this.isTouch() && this.guide.clientHeight > 0) {
      // (the HUD's own box: it can be laid out at a stub size for a frame while its layer mounts)
      const lordBtn = !!this.el.querySelector('.sg-touch .ab-lord:not(.sg-hidden)');
      const key = `${this.el.clientWidth}x${this.el.clientHeight}|${lordBtn ? 'G' : ''}`;
      const settle = this.guideRefits < GUIDE_SETTLE_REFITS && now - this.guideFitAt >= 0.5;
      if (key !== this.guideFit || settle) {
        if (key === this.guideFit) this.guideRefits++;
        this.guideFit = key;
        this.guideFitAt = now;
        if (lordBtn) this.el.dataset.lordBtn = '';
        else delete this.el.dataset.lordBtn;
        this.el.dataset.guide = 'on';
        const steps = fitGuideCard(this.guide);
        this.el.dataset.guide = steps.at(-1) ?? 'on';
      }
    }
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
    this.handleDeath(f, now);
  }

  /** Downed panel, revive markers / ring, spectate panel (fallen.ts). */
  private updateFallen(f: HudFrame, now: number): void {
    const myId = f.me?.entityId ?? null;
    this.downed.update(f, { label: (id) => this.nameOf(id), sinceCall: myId !== null ? this.helpCalls.since(myId, now) : Infinity });
    setClass(this.el, 'reviving', this.rvRing.update(f));
    const alive = !!f.me && !f.me.dead;
    const marks = alive ? downedMarkers(myId, f.myEnt, f.ents, knownFriends(f.me?.role, f.me?.knownAllies, f.ents), this.helpCalls, now, MARKER_RANGE, this.knockedByMe) : [];
    this.rvMarks.update(marks, f.lang);
    // (the minimap / big map SOS dots: calls for help and allies only)
    this.sosMarks = marks.filter((m) => !m.finish);
    const dying = !!f.me?.dead && (now < this.deathCamUntil || this.pendingSpectate !== undefined);
    this.spectate.update(f, this.deathCard.isOpen, this.deathCard.hasRecap, dying);
    this.deathCard.updateSoul(f.me?.dead ? f.me.soul : undefined);
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
      sos: this.sosMarks,
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
    try {
      this.causes.ingest(evs, now);
    } catch (err) {
      console.error('[hud] kill causes failed', err);
    }
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
            // the death recap: what hit you, with what, how hard
            if (myId !== null && ev.target === myId && ev.amount > 0 && !ev.blocked) {
              const cause = ev.src !== undefined && ev.src !== myId ? this.causes.causeOf(myId, ev.src, now) : null;
              this.damageLog.add({ at: now, src: ev.src !== myId ? ev.src : undefined, amount: ev.amount, head: !!ev.head, dtype: ev.dtype, cause });
            }
            break;
          }
          case 'heal':
            if (ev.target === myId && ev.amount >= 1) this.dmg.spawn(`+${Math.round(ev.amount)}`, 'heal', null, now);
            break;
          case 'shot':
            // soldiers' hits on you: the squad focus warning
            if (ev.hit !== undefined && ev.hit === myId) {
              const s = this.view.get(ev.src);
              if (s && (s.kind === 'troop' || s.kind === 'npc' || s.kind === 'turret')) this.focusWarn.note(ev.src, s.owner, now);
            }
            break;
          case 'death':
            this.onDeath(ev, myId, lang, now);
            break;
          case 'downed': {
            const aboutMe = ev.target === myId;
            const mine = ev.src !== undefined && ev.src === myId;
            const victim = entityLabel(this.view, ev.target, lang);
            if ((aboutMe || mine) && victim?.kind === 'hero') {
              this.feed.push(this.party(ev.src, lang), this.toParty(victim), { downed: true, mine, aboutMe, now, cause: this.causes.causeOf(ev.target, ev.src, now) });
            }
            // 击倒 (amber) — not the 斩 kill stamp: he can still be revived
            if (mine && !aboutMe && victim?.kind === 'hero') {
              this.knockStamp.show(heroName(victim.heroId));
              this.crosshair.hit('head');
            }
            if (aboutMe) {
              this.myDownedBy = ev.src;
              this.myDownedAt = now;
            }
            // your victim: a 补刀 marker (his call for help must not invite you to revive him)
            if (mine && !aboutMe && victim?.kind === 'hero') this.knockedByMe.add(ev.target);
            break;
          }
          case 'revived':
            this.helpCalls.forget(ev.target);
            this.knockedByMe.delete(ev.target);
            if (ev.target === myId) {
              this.myDownedBy = undefined;
              this.myDownedAt = undefined;
              const by = ev.by !== undefined && ev.by !== myId ? this.nameOf(ev.by) : null;
              let msg: string;
              if (ev.recall) msg = by ? tx('{name} 为你招魂，你回来了！', '{name} called you back from the dead!', { name: by }) : tx('你被招魂归来！', 'You were called back!');
              else if (ev.squad) msg = tx('部曲为你包扎，你重新站了起来！', 'Your soldier bandaged you: back on your feet!');
              else msg = by ? tx('{name} 把你救了起来！', '{name} got you back up!', { name: by }) : tx('你被救起了！', 'You were revived!');
              this.announcer.push(msg, 'info', undefined, now);
            }
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
            // 「需要桃！」 (F while downed): the caller shows up with a 救 marker for a while
            if (ev.id === 'needPeach') this.helpCalls.note(ev.who, now);
            const who = entityLabel(this.view, ev.who, lang);
            this.chat.add({ from: who ? `${heroName(who.heroId)}${who.heroId ? '·' : ''}${who.name}` : '?', text: quickChatText(ev.id, lang), kind: 'quick' }, now);
            break;
          }
          case 'chat':
            this.chat.add({ from: this.speaker(ev.from), text: ev.text }, now);
            break;
          case 'reward':
            if (ev.who === myId && (ev.kind === 'rebelKill' || ev.kind === 'bounty')) {
              // the headline only; the cards themselves go to the pickup lines above the item bar
              this.announcer.push(t(ev.kind === 'rebelKill' ? 'hud.reward.rebelKill' : 'hud.reward.bounty'), 'big', undefined, now);
              for (const id of ev.items ?? []) this.pickups.push(id, now);
            }
            break;
          case 'pickup':
            // a compact line by the item bar, never over the crosshair (the card's effect: tooltip / long-press / 锦囊说明)
            if (ev.who === myId) this.pickups.push(ev.item, now);
            break;
          case 'sfx':
            // the sim refused a card / ability of ours: say why when the sim tells us, else stay neutral
            if (ev.name === 'abilityDenied' && typeof ev.ability === 'string' && (ev.privateTo === undefined || ev.privateTo === myId)) {
              this.abilities.denied(ev.ability);
              this.touch?.denied?.(ev.ability);
            }
            if ((ev.name === 'itemDenied' || ev.name === 'abilityDenied') && (ev.privateTo === undefined || ev.privateTo === myId) && now - this.lastDenied > 1.2) {
              this.lastDenied = now;
              const msg = deniedText(ev as { reason?: unknown; item?: unknown; ability?: unknown });
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
    const cause = this.causes.causeOf(ev.target, ev.killer, now);
    this.causes.forget(ev.target);
    this.feed.push(killer, victim, { mine, aboutMe, now, cause });
    this.helpCalls.forget(ev.target);
    this.knockedByMe.delete(ev.target);
    if (mine && !aboutMe) {
      // 击杀 (a kill for good) — the amber 击倒 stamp only said he was down
      this.killStamp.show(`${tx('击杀 ', 'Eliminated ')}${heroName(victim.heroId)}${victim.role ? tx(`（${roleName(victim.role)}）`, ` (${roleName(victim.role)})`) : ''}`, victim.heroId);
      this.crosshair.hit('kill');
    }
    if (aboutMe) {
      // kept as a reference: the name is rendered (and re-rendered) in the current language
      this.spectate.killer = killer && ev.killer !== undefined ? { entityId: ev.killer } : { zone: true };
      // the moment of death first (the camera pulls back over your body), then the killer (PUBG):
      // the death card sits beside him
      const killerId = ev.killer !== undefined && this.view.players().some((p) => p.entityId === ev.killer && p.alive) ? ev.killer : null;
      this.deathCamUntil = now + DEATH_CAM_TIME;
      this.pendingSpectate = killerId;
      this.setSpectate(null);
      this.showDeathCard(ev, myId, cause, now);
    } else if (this.spectateId === ev.target) {
      this.setSpectate(cycleSpectate(this.view.players(), ev.target, 1, myId));
    }
    // role reveal banner for important deaths
    if (ev.role === 'lord') this.announcer.push(tx('主公阵亡！', 'The Lord has fallen!'), 'big', undefined, now);
  }

  /** The death recap: who, with what, the last 10 s of damage, the killer's HP — public information only. */
  private showDeathCard(ev: Extract<GameEvent, { t: 'death' }>, myId: EntityId | null, cause: ReturnType<KillCauses['causeOf']>, now: number): void {
    try {
      const killerId = ev.killer !== undefined && ev.killer !== myId ? ev.killer : undefined;
      const myEnt = myId !== null ? this.view.get(myId) : undefined;
      const recap = this.damageLog.recap(now, killerId, this.myDownedBy !== myId ? this.myDownedBy : undefined, killerId !== undefined ? cause : null, this.myDownedAt);
      this.deathCard.show({
        recap,
        bledOut: bledOut(recap, this.myDownedAt, now),
        dropped: { ...this.carried },
        role: ev.role ?? this.view.local()?.role,
        killer: killerSnapshot(killerId, this.view.entities(), this.view.players(), myEnt),
        label: (id) => this.nameOf(id),
        heroOf: (id) => entityLabel(this.view, id, getLang())?.heroId,
        online: this.ctx.sessionKind === 'online',
      });
    } catch (err) {
      console.error('[hud] death card failed', err);
    }
  }

  /** "hero·player" for an entity (heroes, their troops / turrets), in the current language. */
  private nameOf(id: EntityId): string | null {
    const l = entityLabel(this.view, id, getLang());
    if (!l) return null;
    return l.heroId ? `${heroName(l.heroId)}·${l.name}` : l.name;
  }

  /** Typed chat: "hero·player" like claims, resolved through the match's player list. */
  private speaker(from: string): string {
    if (!from) return from;
    const lang = getLang();
    const p = this.view.players().find((x) => x.name === from);
    const name = displayName(from, lang);
    return p?.heroId ? `${heroName(p.heroId)}·${name}` : name;
  }

  private party(id: EntityId | undefined, lang: 'zh' | 'en'): FeedParty | null {
    const l = entityLabel(this.view, id, lang);
    return l ? this.toParty(l) : null;
  }

  private toParty(l: { name: string; heroId?: string; kingdom?: ViewEntity['kingdom']; role?: FeedParty['role'] }): FeedParty {
    return { name: l.name, heroId: l.heroId, kingdom: l.kingdom, role: l.role };
  }

  private handleDeath(f: HudFrame, now: number): void {
    const dead = !!f.me?.dead;
    const myId = f.me?.entityId ?? null;
    if (dead && !this.myDeathHandled) {
      this.myDeathHandled = true;
      // (a death seen without its event — a rejoin: no death moment)
      if (this.spectateId === null && now >= this.deathCamUntil && this.pendingSpectate === undefined) this.setSpectate(cycleSpectate(f.players, null, 1, myId));
      try {
        if (document.pointerLockElement) document.exitPointerLock();
      } catch {
        /* ignore */
      }
      if (this.overlay === 'pause') this.closeOverlay('pause');
    } else if (!dead && this.myDeathHandled) {
      // back in the fight (招魂)
      this.myDeathHandled = false;
      this.deathCamUntil = -1;
      this.pendingSpectate = undefined;
      this.setSpectate(null);
      this.deathCard.reset();
      this.damageLog.clear();
      this.myDownedBy = undefined;
      this.myDownedAt = undefined;
    }
    // the death moment is over: go to the killer (or whoever is left)
    if (dead && this.pendingSpectate !== undefined && now >= this.deathCamUntil) {
      const want = this.pendingSpectate;
      this.pendingSpectate = undefined;
      const alive = want !== null && f.players.some((p) => p.entityId === want && p.alive);
      this.setSpectate(alive ? want : cycleSpectate(f.players, null, 1, myId));
    }
    setClass(this.el, 'dying', dead && now < this.deathCamUntil);
    if (!dead && f.me) {
      let cards = 0;
      for (const it of f.me.items) if (it) cards += it.count;
      this.carried.cards = cards;
      this.carried.gear = (f.me.armor ? 1 : 0) + (f.me.mount ? 1 : 0) + (f.me.weapons[1] ? 1 : 0);
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
    // (skips the rest of the death moment)
    this.pendingSpectate = undefined;
    this.deathCamUntil = -1;
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
      // F3: the performance panel (the browser's own F3 is "find next")
      if (ev.code === 'F3' && this.active) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.repeat) settings.update({ showFps: !settings.get().showFps });
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
      // V while dead: watch from his eye / over his shoulder
      if (this.dead() && ev.code === 'KeyV' && this.overlay === 'none') {
        consume();
        this.spectateFp = !this.spectateFp;
        try {
          this.handle.setSpectateView?.(this.spectateFp);
        } catch (err) {
          console.warn('[hud] setSpectateView failed', err);
        }
        return;
      }
      if (this.dead() && (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight')) {
        consume();
        this.cycleSpectate(ev.code === 'ArrowLeft' ? -1 : 1);
        return;
      }
      // Space on the death recap: 继续观战
      if (this.dead() && ev.code === 'Space' && this.deathCard.isOpen && this.overlay === 'none') {
        consume();
        this.deathCard.hide();
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
    // dead (pointer free): a click on the world switches whom you watch — left next, right previous.
    // Captured before the input controller, which would grab the pointer lock for a match you left.
    this.bag.listen(doc, 'mousedown', (ev: MouseEvent) => {
      if (!this.dead() || !this.active || this.gameOver || this.overlay !== 'none' || this.isTouch()) return;
      if (ev.button !== 0 && ev.button !== 2) return;
      const target = ev.target as Element | null;
      if (target?.closest?.('button, a, input, textarea, .hud-deathcard, .hud-spectate2, .hud-minimap, .hud-feed, .hud-chat, .sg-panel, .sg-dark')) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.cycleSpectate(ev.button === 2 ? -1 : 1);
    }, { capture: true });
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
  /** a mid-match quality switch is being applied (App.qualityApplying) */
  private applyingQuality = false;

  private setQualityApplying(on: boolean): void {
    this.applyingQuality = on;
    setClass(this.applyingEl, 'sg-hidden', !on);
    setText(this.applyingEl, t('settings.applying'));
    // single player: 继续 waits until the new tier is in place (the sim stays paused meanwhile)
    this.pause.setApplying(on && this.ctx.sessionKind === 'single');
    this.syncPause();
  }

  private openPause(mode: 'menu' | 'click'): void {
    this.pauseMode = mode;
    this.el.dataset.pauseMode = mode;
    this.pause.setMode(mode);
    this.openOverlay('pause');
    this.syncPause();
  }

  /** Resume from the pause menu. `viaKey` = Esc (cannot grab the pointer lock). */
  private resume(viaKey = false): void {
    // single player: the menu stays up while a quality switch applies (its 继续 reads 「应用中…」)
    if (this.applyingQuality && this.ctx.sessionKind === 'single' && !this.dead()) return;
    if (this.isTouch() || this.safeIsLocked() || this.dead()) {
      this.closeOverlay('pause', true);
      return;
    }
    if (viaKey) {
      this.pauseMode = 'click';
      this.el.dataset.pauseMode = 'click';
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
    // every menu needs a free cursor: the pause menu too (its buttons are unclickable
    // under pointer lock). The pointerlockchange that follows finds the menu already
    // open and leaves it alone.
    if (o === 'wheel' || o === 'pause' || o === 'controls') this.releasePointer();
    this.ctx.sfx(o === 'pause' ? 'back' : 'click');
    this.syncInput();
  }

  private releasePointer(): void {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* ignore */
    }
    try {
      (this.handle.input as { exitLock?(): void }).exitLock?.();
    } catch {
      /* ignore */
    }
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
    this.syncPause();
  }

  private setScoreboardToggled(on: boolean): void {
    this.scoreboardToggled = on;
    if (!on) this.scoreboardHeld = false;
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

  // ── single-player pause ───────────────────────────────────────────────────

  /**
   * A local single-player match really pauses while a menu covers it: the pause
   * menu (or "click to play"), the controls sheet, the settings modal and the
   * rotate-to-landscape cover. Online matches never pause (other people play on).
   */
  private wantsPause(): boolean {
    if (this.disposed || this.ctx.sessionKind !== 'single' || !this.active || this.gameOver) return false;
    return this.overlay === 'pause' || this.overlay === 'controls' || this.settingsOpen || this.rotating || this.applyingQuality;
  }

  private syncPause(): void {
    const want = this.wantsPause();
    if (want !== this.pausedSent) this.sendPaused(want);
  }

  private sendPaused(on: boolean): void {
    this.pausedSent = on;
    try {
      (this.session as PausableSession).setPaused?.(on);
    } catch (err) {
      console.warn('[hud] setPaused failed', err);
    }
  }

  /** For tests / harness: whether the HUD asked the session to pause. */
  get pauseRequested(): boolean {
    return this.pausedSent;
  }

  // ── card info (touch long-press) / first-match guide ─────────────────────

  private showCardInfo(itemId: string, slot?: number): void {
    const def = ITEM_BY_ID[itemId];
    if (!def) return;
    // COMBAT-7: a full bar is managed here on touch — discard drops the card at your feet
    const discard = slot === undefined ? null : button(t('hud.discard'), (ev) => {
      ev.stopPropagation();
      this.handle.input.pushAction({ a: 'drop', slot, what: 'item' });
      this.hideCardInfo();
    }, { cls: 'small dark pc-discard', sfx: 'back' });
    const row = cardRow(itemId);
    if (discard) row.appendChild(discard);
    this.cardInfo.replaceChildren(h('ul', { class: 'pc-list' }, row));
    setClass(this.cardInfo, 'off', false);
    if (this.cardInfoTimer !== null) clearTimeout(this.cardInfoTimer);
    this.cardInfoTimer = setTimeout(() => this.hideCardInfo(), 4500);
    this.ctx.sfx('click');
  }

  private hideCardInfo(): void {
    if (this.cardInfoTimer !== null) clearTimeout(this.cardInfoTimer);
    this.cardInfoTimer = null;
    setClass(this.cardInfo, 'off', true);
  }

  /** Leave the match (pause menu / the link chip's 离开): confirmed first — for the host it closes the room. */
  private confirmLeave(): void {
    // the host's session is the room: leaving closes it for everyone
    const host = this.ctx.sessionKind === 'online' && this.session.isHost;
    void this.ctx.confirm(t(host ? 'pause.hostLeaveConfirm' : 'pause.leaveConfirm')).then((yes) => {
      if (yes) this.ctx.leaveSession(true);
    });
  }

  private showGuide(): void {
    // touch: the card is fitted (it cannot scroll) by frame()
    const card = createGuideCard(this.isTouch(), () => {
      if (this.guide === card) this.guide = null;
      delete this.el.dataset.guide;
      if (this.guideTimer !== null) clearTimeout(this.guideTimer);
      this.guideTimer = null;
    });
    this.guide = card;
    this.guideFit = '';
    this.guideRefits = 0;
    this.el.dataset.guide = 'on';
    this.el.appendChild(card);
    // it never has to be dismissed: it fades out on its own 45 s into play — the clock starts
    // on the first click-in (frame()), not behind 「点击进入战场」 (UX-11)
  }

  private closeGuide(): void {
    this.guidePending = false;
    const g = this.guide as (HTMLElement & { closeGuide?: (never: boolean) => void }) | null;
    if (g?.closeGuide) g.closeGuide(false);
    else g?.remove();
    this.guide = null;
    if (this.guideTimer !== null) clearTimeout(this.guideTimer);
    this.guideTimer = null;
  }

  private renderControls(): void {
    // touch: the on-screen buttons (NP-7), not a keyboard a phone does not have
    const rows = this.isTouch()
      ? touchControlCells(getLang()).map((c) => h('div', { class: 'ctl' }, h('span', { class: 'keys' }, c.caps), h('span', null, c.text)))
      : controlsFor(isMac()).map((c) => h('div', { class: 'ctl' }, h('span', { class: 'keys' }, c.keys.map((k) => keyCap(k === '左键' ? tx('左键', 'LMB') : k === '右键' ? tx('右键', 'RMB') : k === '中键' ? tx('中键', 'MMB') : k))), h('span', null, tx(c.zh, c.en))));
    this.controlsBox.replaceChildren(
      h('div', { class: 'ctl-head' }, h('h2', { class: 'sg-h2' }, t('pause.controls')), button(t('common.back'), () => this.closeOverlay('controls'), { cls: 'small dark', sfx: 'back' })),
      h('div', { class: 'ctl-grid' }, rows),
    );
  }

  /** Enable gameplay input only when nothing modal is open. */
  private syncInput(): void {
    this.syncPause();
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
    if (this.fpsEl.classList.contains('sg-hidden') === st.showFps) {
      setClass(this.fpsEl, 'sg-hidden', !st.showFps);
      if (st.showFps) this.renderPerf(0);
    }
    const wantTouch = this.isTouch();
    if (wantTouch && !this.touch) {
      this.touch = mountTouchControls(this.el, this.handle.input, {
        onInteract: () => undefined,
        onItemInfo: (slot, itemId) => this.showCardInfo(itemId, slot),
      });
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
    if (tk !== this.touchBarKey) {
      this.renderTouchBar();
      // touch-aware hints (no Enter / Esc / T on a phone)
      this.wheel.render();
      if (this.overlay === 'chat') this.chat.setOpen(true);
    }
  }

  private renderTouchBar(): void {
    const on = this.isTouch();
    const lang = getLang();
    this.touchBarKey = `${on}|${lang}`;
    setClass(this.touchBar, 'sg-hidden', !on);
    if (!on) return;
    const b = (key: TouchKey, title: string, fn: () => void): HTMLElement => {
      const label = touchLabel(key, lang);
      const el = h('button', { class: `tb${label.length > 1 && lang === 'en' ? ' word' : ''}`, type: 'button', title, aria: { label: title }, data: { key } }, label);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
      return el;
    };
    // every button toggles its own overlay: the second tap closes what the first opened
    this.touchBar.replaceChildren(
      b('wheel', t('wheel.title'), () => this.onUiKey('quickchat', true)),
      b('chat', t('lobby.chat'), () => {
        if (this.overlay === 'chat') this.closeOverlay('chat');
        else if (this.overlay !== 'pause' && this.overlay !== 'controls') this.openOverlay('chat');
      }),
      b('map', t('map.title'), () => this.onUiKey('map', true)),
      b('score', t('score.title'), () => this.setScoreboardToggled(!this.scoreboardToggled)),
      b('menu', t('pause.title'), () => {
        if (this.overlay === 'pause') this.resume();
        else this.openPause('menu');
      }),
    );
  }

  private isTouch(): boolean {
    return shouldUseTouch(settings.get().touchControls);
  }

  /** The F3 panel (every 0.5 s while shown). `hudFps`: the HUD's own count, when the view has no numbers yet. */
  private renderPerf(hudFps: number): void {
    let p: PerfInfo | null = null;
    try {
      p = this.handle.perf?.() ?? null;
    } catch {
      p = null;
    }
    const lines = perfLines(p, { fps: hudFps, ms: hudFps > 0 ? 1000 / hudFps : 0 }, this.ctx.gpu?.renderer ?? '');
    const rows = this.perfRows.children;
    if (rows.length !== lines.length) this.perfRows.replaceChildren(...lines.map((l, i) => h('div', { class: i === lines.length - 1 ? 'gpu' : 'ln' }, l)));
    else lines.forEach((l, i) => setText(rows[i] as HTMLElement, l));
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

