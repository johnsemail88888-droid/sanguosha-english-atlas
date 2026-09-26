// Lobby: seats (bots / humans / ready / host crown), host controls, big room
// code + invite link, match settings, chat.
import type { BotDifficulty, GameMode, LobbySeat, LobbyState, MatchSettings } from '../../core/types';
import type { GameSession } from '../../game/session';
import type { Screen, UiCtx } from '../ctx';
import { Bag, appendChildren, copyText, h } from '../dom';
import { colon, getLang, t, tx } from '../i18n';
import { displayName } from '../../game/names';
import { button, field, segmented, toggle } from '../widgets';
import { rolePreview } from './single';
import { inviteLink } from '../invite';

export { inviteLink };

export interface ChatLine {
  from: string;
  text: string;
  system?: boolean;
  /** system lines carry both languages (rendered in the current one) */
  zh?: string;
  en?: string;
}

/** A 'chat' session payload (G2 adds `system` + bilingual text for join / leave / kick lines). */
type ChatPayload = { from: string; text: string; system?: boolean; zh?: string; en?: string };

export function toChatLine(c: ChatPayload): ChatLine {
  return c.system ? { from: '', text: c.text, system: true, zh: c.zh ?? c.text, en: c.en ?? c.text } : { from: c.from, text: c.text };
}

/**
 * Lobby chat of one online session, owned by the app shell: the lobby screen is
 * rebuilt after every match, the conversation (and its join / leave / kick
 * lines) is not.
 */
export class LobbyChatLog {
  readonly lines: ChatLine[] = [];
  private readonly subs = new Set<(line: ChatLine) => void>();
  private readonly off: () => void;

  constructor(session: GameSession, private readonly max = 100) {
    this.off = session.on('chat', (c) => this.push(toChatLine(c as ChatPayload)));
  }

  push(line: ChatLine): void {
    this.lines.push(line);
    while (this.lines.length > this.max) this.lines.shift();
    for (const cb of [...this.subs]) cb(line);
  }

  subscribe(cb: (line: ChatLine) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  dispose(): void {
    this.off();
    this.subs.clear();
  }
}

export function createLobbyScreen(ctx: UiCtx, session: GameSession): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-lobby', data: { screen: 'lobby' } });
  let statusText: { zh: string; en: string } | null = null;
  const chatLog = h('div', { class: 'chat-log', role: 'log', aria: { live: 'polite' } });
  const chatInput = h('input', { class: 'sg-input dark', placeholder: t('lobby.chatPh'), maxlength: 120, autocomplete: 'off', aria: { label: t('lobby.chat') } });
  const seatsBox = h('div', { class: 'seats' });
  const settingsBox = h('div', { class: 'settings' });
  const footBox = h('div', { class: 'lobby-foot' });
  const headBox = h('div', { class: 'lobby-head' });

  const sendChat = (): void => {
    const text = chatInput.value.trim();
    if (!text) return;
    session.sendChat(text.slice(0, 120));
    chatInput.value = '';
  };
  chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      sendChat();
    }
  });

  // history lives in the app's LobbyChatLog (survives matches); a bare session gets a local one
  const log = ctx.chatLog?.() ?? null;
  const ownLog = log ? null : new LobbyChatLog(session);
  const chat = log ?? (ownLog as LobbyChatLog);
  if (ownLog) bag.add(ownLog);
  const appendChat = (line: ChatLine): void => {
    chatLog.appendChild(chatRow(line));
    while (chatLog.childElementCount > 100) chatLog.firstElementChild?.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  };
  const renderChat = (): void => {
    chatLog.replaceChildren(...chat.lines.map(chatRow));
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  const me = (lobby: LobbyState): LobbySeat | undefined => lobby.seats.find((x) => x.playerId === session.myId);

  const renderHead = (lobby: LobbyState): void => {
    const code = lobby.roomCode;
    const copyCodeBtn = h('button', { class: 'room-code', type: 'button', title: t('lobby.copyCode'), aria: { label: `${t('lobby.roomCode')} ${code}` } },
      h('span', { class: 'lbl' }, t('lobby.roomCode')),
      h('span', { class: 'code' }, code || '——'),
    );
    copyCodeBtn.addEventListener('click', () => {
      void copyText(code).then((ok) => ctx.toast(ok ? `${t('common.copied')} · ${code}` : code));
    });
    headBox.replaceChildren(
      h('h1', { class: 'sg-h1' }, t('lobby.title')),
      h('div', { class: 'code-box' },
        copyCodeBtn,
        button(t('lobby.copyLink'), () => {
          const link = inviteLink(code, location, ctx.connection?.() ?? undefined);
          void copyText(link).then((ok) => ctx.toast(ok ? t('common.copied') : link));
        }, { cls: 'small dark' }),
      ),
      button(t('lobby.leave'), () => {
        // the host's session IS the room
        void ctx.confirm(t(session.isHost ? 'lobby.hostLeaveConfirm' : 'lobby.leaveConfirm')).then((yes) => {
          if (yes) ctx.leaveSession(true);
        });
      }, { cls: 'small ghost', sfx: 'back' }),
    );
  };

  const renderSeats = (lobby: LobbyState): void => {
    const count = lobby.settings.playerCount;
    const isHost = session.isHost;
    const list = h('ol', { class: 'seat-list' });
    const seats = [...lobby.seats].sort((a, b) => a.seat - b.seat);
    const bySeat = new Map(seats.map((x) => [x.seat, x]));
    const total = Math.max(count, seats.length ? Math.max(...seats.map((x) => x.seat)) + 1 : 0);
    for (let i = 0; i < total; i++) {
      const seat = bySeat.get(i);
      if (!seat) {
        list.appendChild(h('li', { class: 'seat empty' }, h('span', { class: 'no' }, String(i + 1)), h('span', { class: 'avatar' }, '空'), h('span', { class: 'nm sg-mute' }, t('lobby.emptySeat'))));
        continue;
      }
      const mine = seat.playerId === session.myId;
      const actions = h('span', { class: 'acts' });
      if (isHost && seat.isBot) {
        actions.appendChild(button(t('lobby.removeBot'), () => session.removeBot(seat.seat), { cls: 'small dark' }));
      } else if (isHost && !mine && !seat.isHost) {
        actions.appendChild(button(t('lobby.kick'), () => {
          void ctx.confirm(t('lobby.kickConfirm', { name: displayName(seat.name, getLang()) })).then((yes) => {
            if (yes) session.kick(seat.seat);
          });
        }, { cls: 'small dark' }));
      }
      const state = seat.isBot
        ? h('span', { class: 'sg-chip bot' }, t('common.bot'))
        : seat.isHost
          ? h('span', { class: 'sg-chip host' }, '♛ ', t('common.host'))
          : h('span', { class: `sg-chip ${seat.ready ? 'ready' : 'wait'}` }, seat.ready ? t('lobby.ready') : t('lobby.notReady'));
      list.appendChild(
        h('li', { class: `seat${mine ? ' mine' : ''}${seat.isBot ? ' bot' : ''}` },
          h('span', { class: 'no' }, String(seat.seat + 1)),
          h('span', { class: 'avatar' }, seat.isBot ? '机' : seat.name.slice(0, 1).toUpperCase()),
          h('span', { class: 'nm' }, displayName(seat.name, getLang()), mine ? h('span', { class: 'you' }, tx(`（${t('common.you')}）`, ` (${t('common.you')})`)) : null),
          state,
          actions,
        ),
      );
    }
    const humans = seats.filter((x) => !x.isBot).length;
    seatsBox.replaceChildren();
    appendChildren(seatsBox,
      h('div', { class: 'box-head' },
        h('h2', { class: 'sg-h2' }, tx('座次', 'Seats')),
        h('span', { class: 'sg-mute' }, t('lobby.players', { n: seats.length, max: count }), ' · ', tx(`${humans} 名真人`, `${humans} human${humans === 1 ? '' : 's'}`)),
      ),
      list,
      isHost
        ? h('div', { class: 'seat-tools' }, button(`＋ ${t('lobby.addBot')}`, () => session.addBot(), { cls: 'small dark', disabled: seats.length >= count }))
        : null,
    );
  };

  const renderSettings = (lobby: LobbyState): void => {
    const st = lobby.settings;
    const isHost = session.isHost;
    const upd = (patch: Partial<MatchSettings>): void => session.updateSettings(patch);
    const ro = (text: string): HTMLElement => h('span', { class: 'ro' }, text);
    const modeLabel = (m: GameMode): string => (m === 'chaos' ? t('single.modeChaos') : t('single.modeStandard'));
    const diffLabel = (d: BotDifficulty): string => t(d === 'easy' ? 'single.easy' : d === 'hard' ? 'single.hard' : 'single.normal');
    const rows = [
      field(t('single.players'), isHost
        ? segmented([5, 6, 7, 8].map((n) => ({ value: n as 5 | 6 | 7 | 8, label: String(n) })), st.playerCount, (v) => upd({ playerCount: v }))
        : ro(String(st.playerCount))),
      field(t('single.mode'), isHost
        ? segmented([{ value: 'standard' as GameMode, label: modeLabel('standard') }, { value: 'chaos' as GameMode, label: modeLabel('chaos') }], st.mode, (v) => upd({ mode: v }))
        : ro(modeLabel(st.mode))),
      field(t('single.botDiff'), isHost
        ? segmented((['easy', 'normal', 'hard'] as BotDifficulty[]).map((d) => ({ value: d, label: diffLabel(d) })), st.botDifficulty, (v) => upd({ botDifficulty: v }))
        : ro(diffLabel(st.botDifficulty))),
      field(t('single.freePick'), isHost ? toggle(st.freePick, (v) => upd({ freePick: v }), t('single.freePick')) : ro(st.freePick ? t('common.on') : t('common.off'))),
      field(t('lobby.friendlyFire'), isHost ? toggle(st.friendlyFire, (v) => upd({ friendlyFire: v }), t('lobby.friendlyFire')) : ro(st.friendlyFire ? t('common.on') : t('common.off'))),
      field(t('lobby.troops'), isHost
        ? segmented([2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })), st.troopsPerHero, (v) => upd({ troopsPerHero: v }))
        : ro(String(st.troopsPerHero))),
    ];
    settingsBox.replaceChildren(
      h('div', { class: 'box-head' }, h('h2', { class: 'sg-h2' }, t('lobby.settings'))),
      // a guest only reads them: two per row (short screens keep 身份分配 in view)
      ...(isHost ? rows : [h('div', { class: 'ro-grid' }, rows)]),
      field(t('single.roles'), rolePreview(st.mode, st.playerCount)),
    );
  };

  const renderFoot = (lobby: LobbyState): void => {
    const mySeat = me(lobby);
    const status = h('div', { class: 'status' }, statusText ? tx(statusText.zh, statusText.en) : '');
    let action: HTMLElement;
    if (session.isHost) {
      const notReady = lobby.seats.some((x) => !x.isBot && !x.isHost && !x.ready);
      action = h('div', { class: 'act' },
        notReady ? h('span', { class: 'sg-mute warn' }, t('lobby.notAllReady')) : null,
        button(t('lobby.start'), () => {
          if (notReady) {
            void ctx.confirm(tx('尚有玩家未准备，仍要开始吗？', 'Some players are not ready. Start anyway?')).then((yes) => {
              if (yes) session.start();
            });
          } else session.start();
        }, { cls: 'big gold', sfx: 'confirm' }),
      );
    } else {
      const ready = !!mySeat?.ready;
      action = h('div', { class: 'act' },
        h('span', { class: 'sg-mute' }, t('lobby.waitHost')),
        button(ready ? t('lobby.unready') : t('lobby.readyBtn'), () => session.setReady(!ready), { cls: ready ? 'big dark' : 'big gold', sfx: 'confirm' }),
      );
    }
    footBox.replaceChildren(status, action);
  };

  const update = (): void => {
    const lobby = session.lobby;
    if (!lobby) return;
    renderHead(lobby);
    renderSeats(lobby);
    renderSettings(lobby);
    renderFoot(lobby);
  };

  const build = (): void => {
    chatInput.placeholder = t('lobby.chatPh');
    const chatBox = h('section', { class: 'chat sg-dark' },
      h('div', { class: 'box-head' }, h('h2', { class: 'sg-h2' }, t('lobby.chat'))),
      chatLog,
      h('div', { class: 'chat-row' }, chatInput, button(t('lobby.send'), sendChat, { cls: 'small' })),
    );
    // phones: seats / settings / chat as tabs (each gets the full height)
    const tabBar = h('div', { class: 'lobby-tabs', role: 'tablist' },
      (['seats', 'settings', 'chat'] as const).map((id) => {
        const b = h('button', { class: `lt${phoneTab === id ? ' on' : ''}`, type: 'button', role: 'tab', data: { tab: id }, aria: { selected: phoneTab === id } }, t(id === 'seats' ? 'lobby.tabSeats' : id === 'settings' ? 'lobby.settings' : 'lobby.chat'));
        b.addEventListener('click', () => {
          phoneTab = id;
          grid.dataset.tab = id;
          for (const x of tabBar.querySelectorAll<HTMLElement>('.lt')) {
            x.classList.toggle('on', x.dataset.tab === id);
            x.setAttribute('aria-selected', String(x.dataset.tab === id));
          }
        });
        return b;
      }),
    );
    const grid = h('div', { class: 'lobby-grid', data: { tab: phoneTab } },
      h('section', { class: 'seats-panel sg-panel sg-corners' }, seatsBox),
      h('section', { class: 'settings-panel sg-panel sg-corners' }, settingsBox),
      chatBox,
    );
    el.replaceChildren(headBox, tabBar, grid, footBox);
    renderChat();
    update();
  };
  let phoneTab: 'seats' | 'settings' | 'chat' = 'seats';

  bag.add(session.on('lobby', () => update()));
  bag.add(chat.subscribe((line) => appendChat(line)));
  bag.add(
    session.on('status', (st) => {
      statusText = st;
      const lobby = session.lobby;
      if (lobby) renderFoot(lobby);
    }),
  );
  build();
  return {
    el,
    relabel: build,
    dispose: () => bag.dispose(),
  };
}

export function chatRow(line: ChatLine): HTMLElement {
  if (line.system) return h('div', { class: 'chat-line system' }, h('span', null, tx(line.zh ?? line.text, line.en ?? line.text)));
  return h('div', { class: 'chat-line' }, h('b', null, displayName(line.from, getLang()), colon()), h('span', null, line.text));
}
