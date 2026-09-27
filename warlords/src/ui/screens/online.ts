// Online: host a room (public P2P or relay server) or join by code.
// `?room=CODE` links pre-fill the join code.
import { settings } from '../../game/settings';
import type { Screen, UiCtx } from '../ctx';
import { Bag, copyText, h } from '../dom';
import { getLang, t, tx } from '../i18n';
import { button, segmented } from '../widgets';
import { desktopInfo, detectLocalServer, refreshLanUrls, servedByLocalServer } from '../desktop';
import {
  choiceChosen,
  choiceOf,
  choicePatch,
  clearRejoin,
  customRelay,
  defaultChoice,
  isReconnectable,
  loadRejoin,
  markModeChosen,
  modeChosen,
  modeOfChoice,
  netPatch,
  parseInvite,
  relayNet,
  type ConnChoice,
  type InviteNet,
  type NetMode,
  type RejoinInfo,
} from '../invite';
import { isOfficialWeb, officialServer } from '../../net/official';
import type { ProbeResult } from '../../net/netCheck';
import { checkVerdict, classifyP2pFailure, formatCheck, formatProbe, p2pFailureText, p2pFix, type P2pFailure } from '../netHelp';

/** Normalize a typed room code (uppercase alphanumerics, max 12). */
export function normalizeRoomCode(raw: string): string {
  let s = raw.trim();
  const m = /[?&#]room=([A-Za-z0-9-]+)/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('SGWL') && s.length > 7) s = s.slice(4);
  return s.slice(0, 12);
}

/** Bilingual message from a NetError-like rejection ({zh, en}) or any Error. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { zh?: unknown; en?: unknown; message?: unknown };
    if (typeof e.zh === 'string' && typeof e.en === 'string') return tx(e.zh, e.en);
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  return String(err);
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{3,12}$/.test(code);
}

/** The join failed because the room does not exist (maybe it lives on the other connection mode). */
export function isRoomNotFound(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return code === 'roomNotFound' || (typeof code === 'string' && /not.?found/i.test(code));
}

/** Apply an invite's / rejoin record's server fields to the saved settings (the net layer reads them). */
function applyNet(over: InviteNet): void {
  const patch = netPatch(settings.get().net, over);
  if (patch) settings.update({ net: { ...settings.get().net, ...patch } });
}

/** One automatic rejoin per page load (a failed one leaves the screen to the player). */
let rejoinTried = false;
/** One automatic join of an invite link per page load (a failed one offers 重试, it never loops). */
let inviteTried = false;

/**
 * What the online screen does by itself when it opens: rejoin the room this tab was
 * in (F5, a dropped link), join the room an invite link names (one click from the
 * friend's message to the lobby) — each once per page load — or nothing: no valid
 * code, or no way to reach its server (a relay link without an address).
 */
export function autoJoinPlan(i: { invited: string | null; rejoin: boolean; inviteTried: boolean; canJoin: boolean }): 'rejoin' | 'invite' | null {
  if (i.rejoin) return 'rejoin';
  if (!i.invited || i.inviteTried || !i.canJoin || !isValidRoomCode(normalizeRoomCode(i.invited))) return null;
  return 'invite';
}

/** Tests: a fresh page load (the automatic joins may run again). */
export function resetAutoJoinForTests(): void {
  rejoinTried = false;
  inviteTried = false;
}

/**
 * After a lost link: `true` — the player asked to rejoin, the next online screen joins the
 * saved room by itself; `false` — they went to the title instead: the online screen only
 * offers 重新加入 {CODE}.
 */
export function allowRejoin(auto = true): void {
  rejoinTried = !auto;
}

export function createOnlineScreen(ctx: UiCtx): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-menu-screen sg-online', data: { screen: 'online' } });
  const invited = ctx.pendingRoom();
  let code = invited ? normalizeRoomCode(invited) : '';
  // the desktop app's LAN addresses as they are now (the startup list goes stale when the network changes)
  if (desktopInfo()) refreshLanUrls();
  const desktop = desktopInfo();
  // an invite link says how the host is reachable: that beats the saved default
  const link = invited ? parseInvite(globalThis.location?.search ?? '') : null;
  const urlMode: NetMode | null = link?.mode ?? null;
  // the room this tab was in (F5 mid-session, or a dropped link — kept ≤ 30 min): its code and its own mode
  const rj = loadRejoin();
  const saved: RejoinInfo | null = rj && (!invited || normalizeRoomCode(invited) === rj.code) ? rj : null;
  // F5 / 重新加入 after a drop: rejoin the same room the same way (once per page load, or when asked)
  const rejoin = saved && !rejoinTried ? saved : null;
  // a relay room without an address (ws=) is on the page's own server: same origin, not a relay from an earlier room
  if (saved) {
    code = saved.code;
    applyNet(relayNet(saved.mode, saved.net));
  } else if (link && urlMode) applyNet(relayNet(urlMode, link.net));
  if (rejoin) rejoinTried = true;
  const official = officialServer();
  const chosen = official ? choiceChosen() : modeChosen();
  // the desktop app used to default to its LAN server: its invite links (a LAN address) then failed for friends
  // elsewhere — every page starts on the official server when this build has one, else on the saved mode
  // (public P2P unless the player picked the server); an invite / the saved room says how its room is reached
  const net0 = settings.get().net;
  let choice: ConnChoice = saved || urlMode ? choiceOf(saved?.mode ?? urlMode ?? 'peer', net0.wsUrl) : defaultChoice({ mode: net0.mode, wsUrl: net0.wsUrl, chosen });
  let mode: NetMode = modeOfChoice(choice);
  const pick = (c: ConnChoice): void => {
    choice = c;
    mode = modeOfChoice(c);
  };
  /** the relay address the 自建服务器 choice would use ('' = this page's own server) */
  const ownWsUrl = (): string => choicePatch('ws', settings.get().net).wsUrl ?? settings.get().net.wsUrl;
  /** the net layer reads the connection from the settings: make them say `choice` */
  const commitChoice = (): void => {
    const cur = settings.get().net;
    const patch = choicePatch(choice, cur);
    if ((Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== cur[k])) settings.update({ net: { ...cur, ...patch } });
  };
  // a mode from the URL / the saved room (a P2P room stays P2P on a self-hosted page), or one the player picked, is never auto-switched
  let modeTouched = !!saved || !!urlMode || chosen;
  /** how the invite link reaches its room */
  const urlChoice: ConnChoice | null = link && urlMode ? choiceOf(urlMode, link.net.wsUrl ?? '') : null;
  const choiceName = (c: ConnChoice): string => (c === 'official' ? t('online.official') : c === 'peer' ? t('online.peer') : official ? t('online.own') : t('online.ws'));
  let busy: 'host' | 'join' | null = null;
  /** bumped by every attempt and by 取消: a cancelled attempt's outcome is ignored */
  let attempt = 0;
  /** the last join failed: 重试 (the same code, the same way) */
  let retryJoin = false;
  let errorText = '';
  /** after 房间不存在: offer the other connection mode */
  let suggest: ConnChoice | null = null;
  /** a P2P create / join failed for a known reason: say why and offer the fix (改用官方服务器重试) */
  let p2pFail: { kind: P2pFailure; action: 'host' | 'join' } | null = null;
  /** 联机检测: running (results null) or its last result */
  let check: { results: ProbeResult[] | null; at: Date } | null = null;
  let runRef: ((kind: 'host' | 'join') => Promise<void>) | null = null;
  const runJoin = (): Promise<void> => runRef?.('join') ?? Promise.resolve();
  const sameOrigin = (): boolean => servedByLocalServer() && !ownWsUrl().trim();
  /** 取消 a join in progress: its answer is dropped (a session that still arrives is left at once) */
  const cancel = (): void => {
    attempt++;
    busy = null;
    errorText = '';
    retryJoin = false;
    p2pFail = null;
    ctx.cancelJoin?.();
    if (el.isConnected) render();
  };

  const render = (): void => {
    const status = h('div', { class: 'sg-online-status', aria: { live: 'polite' } });
    if (busy === 'join') {
      // 正在加入房间 CODE… — 取消 lets the player do something else (the late answer is dropped)
      status.append(h('span', { class: 'sg-spinner' }), ' ', h('span', { class: 'joining' }, t('online.joiningRoom', { code })), ' ',
        button(t('common.cancel'), cancel, { cls: 'small dark cancel-join', sfx: 'back' }));
    } else if (busy) status.append(h('span', { class: 'sg-spinner' }), ' ', t('online.hosting'));
    else if (errorText) {
      status.append(h('span', { class: 'err' }, errorText));
      if (retryJoin) status.append(' ', button(t('online.retry'), () => void run('join'), { cls: 'small gold retry-join', sfx: 'confirm' }));
      if (suggest) {
        const other = suggest;
        status.append(
          h('div', { class: 'suggest' },
            h('span', { class: 'sg-mute' }, t('online.notFoundHint', { mode: choiceName(other) })), ' ',
            button(t('online.switchRetry', { mode: choiceName(other) }), () => {
              pick(other);
              modeTouched = true;
              suggest = null;
              void run('join');
            }, { cls: 'small gold switch-mode', sfx: 'confirm' }),
          ),
        );
      }
      if (p2pFail) {
        const failed = p2pFail;
        const fix = p2pFix(failed.kind, { official: !!official, host: failed.action === 'host' });
        status.append(
          h('div', { class: 'p2p-help', data: { reason: failed.kind } },
            h('span', { class: 'sg-mute' }, tx(fix.hint.zh, fix.hint.en)), ' ',
            button(tx(fix.label.zh, fix.label.en), () => {
              pick(fix.action);
              modeTouched = true;
              markModeChosen();
              settings.update({ net: { ...settings.get().net, ...choicePatch(fix.action, settings.get().net) } });
              p2pFail = null;
              errorText = '';
              // the official server: straight into the same attempt; server mode may still need its address
              if (fix.action === 'official') void run(failed.action);
              else render();
            }, { cls: 'small gold p2p-fix', sfx: 'confirm' }),
          ),
        );
      }
    }

    const wsMissing = choice === 'ws' && !ownWsUrl().trim() && !servedByLocalServer();
    const codeInput = h('input', {
      class: 'sg-input sg-code-input',
      value: code,
      placeholder: t('online.codePh'),
      maxlength: 12,
      autocomplete: 'off',
      aria: { label: t('online.code') },
    });
    codeInput.addEventListener('input', () => {
      const v = normalizeRoomCode(codeInput.value);
      if (v !== codeInput.value) codeInput.value = v;
      code = v;
      joinBtn.disabled = !!busy || !isValidRoomCode(code) || wsMissing;
    });
    codeInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
    });

    const run = async (kind: 'host' | 'join'): Promise<void> => {
      if (busy) return;
      if (kind === 'join' && !isValidRoomCode(code)) {
        errorText = t('online.badCode');
        render();
        return;
      }
      const mine = ++attempt;
      busy = kind;
      errorText = '';
      suggest = null;
      retryJoin = false;
      p2pFail = null;
      commitChoice();
      render();
      try {
        if (kind === 'host') await ctx.hostOnline(mode);
        else await ctx.joinOnline(code, mode);
      } catch (err) {
        if (mine !== attempt) return; // cancelled: nobody is waiting for this answer
        errorText = t('online.failed', { msg: errorMessage(err) });
        retryJoin = kind === 'join';
        // public P2P: say which part failed (signalling / NAT / no room) in plain words, and offer the fix
        const why = choice === 'peer' ? classifyP2pFailure(err) : null;
        if (why) {
          const text = p2pFailureText(why);
          errorText = t('online.failed', { msg: tx(text.zh, text.en) });
          if (why !== 'notFound') p2pFail = { kind: why, action: kind };
        }
        // the room may be on the other network: P2P rooms and relay rooms are separate
        if (kind === 'join' && isRoomNotFound(err)) suggest = choice === 'peer' ? (official ? 'official' : 'ws') : 'peer';
        // a room that is gone / full / refuses us is forgotten; a link that timed out can be retried (重新加入)
        const errCode = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
        if (kind === 'join' && !isReconnectable(typeof errCode === 'string' ? errCode : undefined)) clearRejoin();
        ctx.sfx('error');
      } finally {
        if (mine === attempt) {
          busy = null;
          if (el.isConnected) render();
        }
      }
    };

    runRef = run;
    const hostBtn = button(t('online.host'), () => void run('host'), { cls: 'gold', sfx: 'confirm', disabled: !!busy || wsMissing });
    const joinBtn = button(t('online.joinBtn'), () => void run('join'), { sfx: 'confirm', disabled: !!busy || !isValidRoomCode(code) || wsMissing });

    el.replaceChildren(
      button(`‹ ${t('common.back')}`, () => ctx.go('title'), { cls: 'ghost small sg-back', sfx: 'back' }),
      h('div', { class: 'sg-sheet sg-panel sg-corners' },
        h('h1', { class: 'sg-h1 sg-title-bar' }, t('online.title')),
        invited ? h('div', { class: 'sg-invite' }, t('online.invited', { code: normalizeRoomCode(invited) }), urlChoice ? h('span', { class: 'via' }, ` · ${t('online.invitedMode', { mode: choiceName(urlChoice) })}`) : null) : null,
        saved && !invited ? rejoinBox(saved) : null,
        h('div', { class: 'sg-online-mode' },
          h('span', { class: 'sg-label' }, t('online.via')),
          segmented<ConnChoice>([
            ...(official ? [{ value: 'official' as const, label: t('online.official') }] : []),
            { value: 'peer' as const, label: t('online.peer') },
            { value: 'ws' as const, label: choiceName('ws') },
          ], choice, (v) => {
            pick(v);
            modeTouched = true;
            markModeChosen();
            settings.update({ net: { ...settings.get().net, ...choicePatch(v, settings.get().net) } });
            errorText = '';
            suggest = null;
            p2pFail = null;
            render();
          }, { disabled: !!busy, name: t('online.via') }),
          h('span', { class: 'sg-mute desc' }, choice === 'official' ? t('online.officialDesc') : choice === 'peer' ? t('online.peerDesc') : t('online.wsDesc')),
          button(t('online.serverSettings'), () => ctx.openSettings('network'), { cls: 'ghost small' }),
          button(tx('联机检测', 'Connection check'), () => void runCheck(), { cls: 'ghost small net-check-btn', disabled: !!check && !check.results }),
        ),
        checkBox(),
        wsMissing ? h('div', { class: 'sg-warn' }, t('online.noWsUrl')) : null,
        choice === 'ws' && sameOrigin()
          ? h('div', { class: 'sg-note' }, tx(`使用本机服务器中继：${location.host}/ws`, `Relaying through this server: ${location.host}/ws`))
          : null,
        lanBox(),
        h('div', { class: 'sg-online-cols' },
          h('section', { class: 'col' },
            h('h2', { class: 'sg-h2' }, t('online.host')),
            h('p', { class: 'sg-mute' }, t('online.hostDesc')),
            hostBtn,
          ),
          h('div', { class: 'or' }, h('span', null, tx('或', 'or'))),
          h('section', { class: 'col' },
            h('h2', { class: 'sg-h2' }, t('online.join')),
            h('p', { class: 'sg-mute' }, t('online.joinDesc')),
            h('div', { class: 'join-row' }, codeInput, joinBtn),
          ),
        ),
        status,
      ),
    );
    if (invited && !busy) queueMicrotask(() => codeInput.focus());
  };

  /** 联机检测: signalling, STUN/TURN and the official relay, probed at once (a few seconds). */
  async function runCheck(): Promise<void> {
    if (check && !check.results) return;
    check = { results: null, at: new Date() };
    render();
    let results: ProbeResult[];
    try {
      const { runNetCheck } = await import('../../net/netCheck');
      results = await runNetCheck(settings.get().net, official?.relay ?? null);
    } catch (e) {
      console.warn('[ui] connection check failed', e);
      results = [];
    }
    check = { results, at: new Date() };
    if (el.isConnected) render();
  }

  /** The check's rows (✓/✗ + ms) — made to be screenshotted or copied for us. */
  function checkBox(): HTMLElement | null {
    if (!check) return null;
    const results = check.results;
    const lang = getLang();
    const verdict = results?.length ? checkVerdict(results) : null;
    return h('div', { class: 'sg-netcheck', aria: { live: 'polite' } },
      h('div', { class: 'head' },
        h('strong', null, tx('联机检测', 'Connection check')),
        results
          ? button(t('common.copy'), () => {
              const text = formatCheck(results, lang, check?.at);
              void copyText(text).then((ok) => ctx.toast(ok ? t('common.copied') : text));
            }, { cls: 'small dark net-check-copy' })
          : h('span', { class: 'sg-mute' }, h('span', { class: 'sg-spinner' }), ' ', tx('检测中…（约 5 秒）', 'Checking… (about 5 s)')),
      ),
      results ? h('ul', { class: 'rows' }, results.map((r) => h('li', { class: r.ok === null ? 'na' : r.ok ? 'ok' : 'bad', data: { probe: r.id } }, formatProbe(r, lang)))) : null,
      verdict ? h('p', { class: 'verdict' }, tx(verdict.zh, verdict.en)) : null,
    );
  }

  /** The saved room: where you were, and 重新加入 {CODE} in the room's own mode (MP2-3). */
  function rejoinBox(r: RejoinInfo): HTMLElement {
    const again = (): void => {
      code = r.code;
      applyNet(relayNet(r.mode, r.net));
      pick(choiceOf(r.mode, settings.get().net.wsUrl));
      modeTouched = true;
      void runJoin();
    };
    return h('div', { class: 'sg-invite sg-rejoin' },
      h('span', null, t(rejoin ? 'online.rejoinHint' : 'online.droppedHint', { code: r.code, mode: choiceName(choiceOf(r.mode, r.net.wsUrl ?? '')) })),
      busy ? null : button(t('online.rejoinCode', { code: r.code }), again, { cls: 'small gold rejoin-btn', sfx: 'confirm' }),
    );
  }

  /** Desktop app: the LAN addresses friends open in their browser, with copy buttons. */
  function lanBox(): HTMLElement | null {
    if (!desktop) return null;
    const urls = desktopInfo()?.lanUrls ?? [];
    const rows = urls.map((u) =>
      h('li', { class: 'lan-row' },
        h('code', { class: 'lan-url' }, u),
        button(tx('复制', 'Copy'), () => {
          void copyText(u).then((ok) => ctx.toast(ok ? `${t('common.copied')} · ${u}` : u));
        }, { cls: 'small dark' }),
      ),
    );
    return h('div', { class: 'sg-lan' },
      h('h2', { class: 'sg-h2' }, tx('局域网联机', 'LAN play')),
      h('p', { class: 'sg-mute' }, urls.length
        ? tx('同一局域网（同一 Wi-Fi / 路由器）的朋友用浏览器打开下面的地址，选择「服务器」模式输入房间码即可加入：', 'Friends on the same network open one of these addresses in a browser, choose Server mode and enter your room code:')
        : tx('未检测到局域网地址（请检查网络连接）。', 'No LAN address found (check your network connection).')),
      urls.length ? h('ul', { class: 'lan-list' }, rows) : null,
    );
  }

  render();
  // F5 / a dropped link: rejoin; an invite link: straight into the host's lobby, no 加入 click
  const wsReachable = choice !== 'ws' || !!ownWsUrl().trim() || servedByLocalServer() || !!desktop;
  const plan = autoJoinPlan({ invited: rejoin ? null : invited, rejoin: !!rejoin, inviteTried, canJoin: wsReachable });
  if (plan === 'invite') inviteTried = true;
  if (plan) queueMicrotask(() => {
    if (el.isConnected && !busy) void runJoin();
  });
  // 邀请朋友一起玩 (title): create the room at once, in the mode 创建房间 would use — on a web
  // page that is known once the same-origin server probe below has answered
  const quick = (ctx.takeQuickHost?.() ?? false) && !plan;
  const quickHost = (): void => {
    if (!quick || !el.isConnected || busy) return;
    if (choice === 'ws' && !ownWsUrl().trim() && !servedByLocalServer()) return; // 服务器 without an address: the warning says so
    void runRef?.('host');
  };
  // a page served by our own server (LAN / self-host): same-origin relay → default to server mode
  if (!desktop) {
    void detectLocalServer().then((ok) => {
      if (!el.isConnected) return;
      if (ok) {
        // (the official server's own page stays on 官方服务器: that is this very server)
        if (!modeTouched && !busy && !customRelay(settings.get().net.wsUrl) && !isOfficialWeb(globalThis.location?.origin)) pick('ws');
        if (!busy) render();
        // a relay invite (mode=ws) on a page our own server serves: its relay turned out to be right here
        if (!plan && !quick && !busy && autoJoinPlan({ invited: rejoin ? null : invited, rejoin: false, inviteTried, canJoin: true }) === 'invite') {
          inviteTried = true;
          void runJoin();
        }
      }
      quickHost();
    });
  } else if (quick) queueMicrotask(quickHost);
  // desktop: a network change (Wi-Fi switched, cable plugged) → fresh LAN addresses
  if (desktop) {
    const onNet = (): void => {
      const before = (desktopInfo()?.lanUrls ?? []).join(' ');
      if (refreshLanUrls().join(' ') !== before && !busy && el.isConnected) render();
    };
    bag.listen(window, 'online', onNet);
    const conn = (navigator as { connection?: EventTarget }).connection;
    if (conn && typeof conn.addEventListener === 'function') bag.listen(conn, 'change', onNet);
  }
  // re-evaluate when the server URL is configured from the settings modal
  let lastWs = settings.get().net.wsUrl;
  bag.add(
    settings.subscribe((st) => {
      if (st.net.wsUrl !== lastWs) {
        lastWs = st.net.wsUrl;
        if (!busy) render();
      }
    }),
  );
  return { el, relabel: render, dispose: () => bag.dispose() };
}
