// Online: host a room (public P2P or relay server) or join by code.
// `?room=CODE` links pre-fill the join code.
import { settings } from '../../game/settings';
import type { Screen, UiCtx } from '../ctx';
import { Bag, copyText, h } from '../dom';
import { t, tx } from '../i18n';
import { button, segmented } from '../widgets';
import { desktopInfo, detectLocalServer, servedByLocalServer } from '../desktop';

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

export function createOnlineScreen(ctx: UiCtx): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-menu-screen sg-online', data: { screen: 'online' } });
  const invited = ctx.pendingRoom();
  let code = invited ? normalizeRoomCode(invited) : '';
  const desktop = desktopInfo();
  // the desktop app (embedded server) and pages served by `npm run server` relay on
  // the same origin: default to server mode there (the player can still pick P2P)
  let mode: 'peer' | 'ws' = desktop ? 'ws' : settings.get().net.mode;
  let modeTouched = false;
  let busy: 'host' | 'join' | null = null;
  let errorText = '';
  const sameOrigin = (): boolean => servedByLocalServer() && !settings.get().net.wsUrl.trim();

  const render = (): void => {
    const status = h('div', { class: 'sg-online-status', aria: { live: 'polite' } });
    if (busy) status.append(h('span', { class: 'sg-spinner' }), ' ', busy === 'host' ? t('online.hosting') : t('online.connecting'));
    else if (errorText) status.append(h('span', { class: 'err' }, errorText));

    const wsMissing = mode === 'ws' && !settings.get().net.wsUrl.trim() && !servedByLocalServer();
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
      busy = kind;
      errorText = '';
      render();
      try {
        if (kind === 'host') await ctx.hostOnline(mode);
        else await ctx.joinOnline(code, mode);
      } catch (err) {
        errorText = t('online.failed', { msg: errorMessage(err) });
        ctx.sfx('error');
      } finally {
        busy = null;
        if (el.isConnected) render();
      }
    };

    const hostBtn = button(t('online.host'), () => void run('host'), { cls: 'gold', sfx: 'confirm', disabled: !!busy || wsMissing });
    const joinBtn = button(t('online.joinBtn'), () => void run('join'), { sfx: 'confirm', disabled: !!busy || !isValidRoomCode(code) || wsMissing });

    el.replaceChildren(
      button(`‹ ${t('common.back')}`, () => ctx.go('title'), { cls: 'ghost small sg-back', sfx: 'back' }),
      h('div', { class: 'sg-sheet sg-panel sg-corners' },
        h('h1', { class: 'sg-h1 sg-title-bar' }, t('online.title')),
        invited ? h('div', { class: 'sg-invite' }, t('online.invited', { code: normalizeRoomCode(invited) })) : null,
        h('div', { class: 'sg-online-mode' },
          h('span', { class: 'sg-label' }, t('online.via')),
          segmented([
            { value: 'peer' as const, label: t('online.peer') },
            { value: 'ws' as const, label: t('online.ws') },
          ], mode, (v) => {
            mode = v;
            modeTouched = true;
            settings.update({ net: { ...settings.get().net, mode: v } });
            errorText = '';
            render();
          }, { disabled: !!busy, name: t('online.via') }),
          h('span', { class: 'sg-mute desc' }, mode === 'peer' ? t('online.peerDesc') : t('online.wsDesc')),
          button(t('online.serverSettings'), () => ctx.openSettings('network'), { cls: 'ghost small' }),
        ),
        wsMissing ? h('div', { class: 'sg-warn' }, t('online.noWsUrl')) : null,
        mode === 'ws' && sameOrigin()
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

  /** Desktop app: the LAN addresses friends open in their browser, with copy buttons. */
  function lanBox(): HTMLElement | null {
    const urls = desktop?.lanUrls ?? [];
    if (!desktop) return null;
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
  // a page served by our own server (LAN / self-host): same-origin relay → default to server mode
  if (!desktop) {
    void detectLocalServer().then((ok) => {
      if (!ok || !el.isConnected) return;
      if (!modeTouched && !busy && !settings.get().net.wsUrl.trim()) mode = 'ws';
      if (!busy) render();
    });
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
