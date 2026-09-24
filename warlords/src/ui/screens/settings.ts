// Settings modal: language, name, controls, graphics, audio, network
// (explains 公共P2P vs 局域网/自建服务器 and `npm run server`).
import { DEFAULT_SETTINGS, settings, type Lang, type Quality, type UserSettings } from '../../game/settings';
import type { Screen, SettingsTab, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { t, tx } from '../i18n';
import { button, field, segmented, slider, tabs, textInput, toggle } from '../widgets';

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const mul = (v: number): string => `${v.toFixed(2)}×`;

export function createSettingsPanel(ctx: UiCtx, initialTab: SettingsTab, onClose: () => void): Screen {
  const bag = new Bag();
  let tab: SettingsTab = initialTab;
  const back = h('div', { class: 'sg-modal-back sg-settings-back', role: 'dialog', aria: { modal: 'true', label: t('settings.title') }, data: { screen: 'settings' } });
  const body = h('div', { class: 'set-body' });
  const sheet = h('div', { class: 'sg-modal sg-settings sg-panel sg-corners', tabindex: -1 });
  back.appendChild(sheet);

  const upd = (patch: Partial<UserSettings>): void => settings.update(patch);
  const net = (patch: Partial<UserSettings['net']>): void => settings.update({ net: { ...settings.get().net, ...patch } });

  const general = (): HTMLElement[] => {
    const st = settings.get();
    return [
      field(t('settings.language'), segmented([
        { value: 'zh' as Lang, label: '中文' },
        { value: 'en' as Lang, label: 'English' },
      ], st.lang, (v) => upd({ lang: v }), { name: t('settings.language') })),
      field(t('settings.name'), textInput(st.playerName, (v) => {
        upd({ playerName: v.slice(0, 16) });
        const s = ctx.session;
        if (s && s.phase === 'lobby' && v.trim()) s.setName(v.trim().slice(0, 16));
      }, { maxlength: 16, placeholder: t('title.namePh'), label: t('settings.name') })),
    ];
  };

  const controls = (): HTMLElement[] => {
    const st = settings.get();
    return [
      field(t('settings.mouse'), slider(st.mouseSensitivity, 0.2, 3, 0.05, (v) => upd({ mouseSensitivity: v }), mul, t('settings.mouse'))),
      field(t('settings.ads'), slider(st.adsSensitivity, 0.2, 1.5, 0.05, (v) => upd({ adsSensitivity: v }), mul, t('settings.ads'))),
      field(t('settings.invertY'), toggle(st.invertY, (v) => upd({ invertY: v }), t('settings.invertY'))),
      field(t('settings.touch'), segmented([
        { value: 'auto' as const, label: t('common.auto') },
        { value: 'on' as const, label: t('common.on') },
        { value: 'off' as const, label: t('common.off') },
      ], st.touchControls, (v) => upd({ touchControls: v }), { name: t('settings.touch') }),
      tx('“自动”会在触屏设备上显示虚拟摇杆与按钮。', '“Auto” shows the virtual stick and buttons on touch devices.')),
    ];
  };

  const graphics = (): HTMLElement[] => {
    const st = settings.get();
    return [
      field(t('settings.fov'), slider(st.fov, 60, 100, 1, (v) => upd({ fov: v }), (v) => `${v}°`, t('settings.fov'))),
      field(t('settings.quality'), segmented([
        { value: 'low' as Quality, label: t('settings.quality.low') },
        { value: 'medium' as Quality, label: t('settings.quality.medium') },
        { value: 'high' as Quality, label: t('settings.quality.high') },
      ], st.quality, (v) => upd({ quality: v }), { name: t('settings.quality') }),
      tx('集成显卡或手机请选择“流畅”。', 'Pick “Low” on integrated GPUs and phones.')),
      field(t('settings.fps'), toggle(st.showFps, (v) => upd({ showFps: v }), t('settings.fps'))),
    ];
  };

  const audio = (): HTMLElement[] => {
    const st = settings.get();
    return [
      field(t('settings.master'), slider(st.masterVolume, 0, 1, 0.01, (v) => upd({ masterVolume: v }), pct, t('settings.master'))),
      field(t('settings.music'), slider(st.musicVolume, 0, 1, 0.01, (v) => upd({ musicVolume: v }), pct, t('settings.music'))),
      field(t('settings.sfx'), slider(st.sfxVolume, 0, 1, 0.01, (v) => upd({ sfxVolume: v }), pct, t('settings.sfx'))),
      field(t('settings.voice'), toggle(st.voiceLines, (v) => upd({ voiceLines: v }), t('settings.voice'))),
    ];
  };

  const network = (): HTMLElement[] => {
    const n = settings.get().net;
    return [
      h('div', { class: 'net-explain' },
        h('div', { class: 'opt' },
          h('h3', { class: 'sg-h3' }, t('online.peer')),
          h('p', null, tx(
            '通过 PeerJS 公共信令服务器建立 WebRTC 点对点连接，无需自己架服务器。房主的电脑就是主机。若公共服务器访问缓慢或被屏蔽，可在下方填写自建的 PeerJS 服务器。',
            'Uses the public PeerJS signalling cloud to set up direct WebRTC connections — no server of your own. The host’s machine runs the game. If the public cloud is slow or blocked, point it at your own PeerJS server below.',
          )),
        ),
        h('div', { class: 'opt' },
          h('h3', { class: 'sg-h3' }, t('online.ws')),
          h('p', null, tx(
            '局域网 / 自建服务器：在任意一台电脑的 warlords 目录运行 ',
            'LAN / self-hosted: on any machine, run ',
          ), h('code', null, 'npm run server'), tx(
            '（默认端口 8787），然后把地址填为 ws://<该电脑IP>:8787/ws。该服务器同时提供 PeerJS 信令，可一并填入上方。',
            ' inside the warlords folder (port 8787 by default), then set the address to ws://<that-machine-IP>:8787/ws. The same server also hosts a PeerJS signalling endpoint you can use above.',
          )),
        ),
      ),
      field(t('settings.netMode'), segmented([
        { value: 'peer' as const, label: t('online.peer') },
        { value: 'ws' as const, label: t('online.ws') },
      ], n.mode, (v) => net({ mode: v }), { name: t('settings.netMode') })),
      field(t('settings.wsUrl'), textInput(n.wsUrl, (v) => net({ wsUrl: v.trim() }), { placeholder: t('settings.wsUrlPh'), label: t('settings.wsUrl') })),
      field(t('settings.peerHost'), textInput(n.peerHost, (v) => net({ peerHost: v.trim() }), { placeholder: t('settings.peerHostPh'), label: t('settings.peerHost') })),
      field(t('settings.peerPort'), textInput(String(n.peerPort), (v) => {
        const port = Number.parseInt(v, 10);
        if (Number.isFinite(port) && port > 0 && port < 65536) net({ peerPort: port });
      }, { type: 'number', label: t('settings.peerPort') })),
      field(t('settings.peerPath'), textInput(n.peerPath, (v) => net({ peerPath: v.trim() || '/' }), { label: t('settings.peerPath') })),
      field(t('settings.peerSecure'), toggle(n.peerSecure, (v) => net({ peerSecure: v }), t('settings.peerSecure'))),
      field(t('settings.turn'), textInput(n.turnUrl, (v) => net({ turnUrl: v.trim() }), { placeholder: 'turn:example.com:3478', label: t('settings.turn') }),
        tx('严格 NAT（如部分校园网、4G）下直连失败时才需要。', 'Only needed when direct connections fail behind strict NATs (some campus / mobile networks).')),
      field(t('settings.turnUser'), textInput(n.turnUser, (v) => net({ turnUser: v }), { label: t('settings.turnUser') })),
      field(t('settings.turnPass'), textInput(n.turnPass, (v) => net({ turnPass: v }), { type: 'password', label: t('settings.turnPass') })),
      h('div', { class: 'row-actions' }, button(t('settings.resetNet'), () => {
        settings.update({ net: structuredClone(DEFAULT_SETTINGS.net) });
        renderBody();
      }, { cls: 'small dark' })),
    ];
  };

  const SECTIONS: Record<SettingsTab, () => HTMLElement[]> = { general, controls, graphics, audio, network };

  const renderBody = (): void => {
    body.replaceChildren(...SECTIONS[tab]());
  };

  const build = (): void => {
    const ids: SettingsTab[] = ['general', 'controls', 'graphics', 'audio', 'network'];
    sheet.replaceChildren(
      h('header', { class: 'set-head' },
        h('h2', { class: 'sg-h2' }, t('settings.title')),
        button('✕', onClose, { cls: 'icon small ghost', title: t('common.close'), sfx: 'back' }),
      ),
      tabs(ids.map((id) => ({ id, label: t(`settings.tab.${id}`) })), tab, (id) => {
        tab = id;
        renderBody();
      }),
      body,
      h('footer', { class: 'set-foot' },
        button(t('settings.reset'), () => {
          void ctx.confirm(tx('恢复全部默认设置？（名号会保留）', 'Reset every setting to default? (your name is kept)')).then((yes) => {
            if (!yes) return;
            const name = settings.get().playerName;
            settings.update({ ...structuredClone(DEFAULT_SETTINGS), playerName: name });
            build();
          });
        }, { cls: 'small dark' }),
        button(t('common.close'), onClose, { cls: 'gold', sfx: 'back' }),
      ),
    );
    renderBody();
  };

  bag.listen(back, 'pointerdown', (ev) => {
    if (ev.target === back) onClose();
  });
  build();
  return { el: back, relabel: build, dispose: () => bag.dispose() };
}
