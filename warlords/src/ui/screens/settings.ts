// Settings modal: language, name, controls, graphics, audio, network
// (explains 公共P2P vs 局域网/自建服务器 and `npm run server`).
import { DEFAULT_SETTINGS, QUALITIES, defaultQuality, settings, type Lang, type UserSettings } from '../../game/settings';
import type { Screen, SettingsTab, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { getLang, t, tx } from '../i18n';
import { button, field, nameFieldModel, segmented, slider, tabs, textInput, toggle } from '../widgets';
import { markModeChosen } from '../invite';
import { gpuShortName, qualityName } from '../perfcheck';

/** localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, *.local: nobody has a TLS certificate there */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Reset every setting but the player's name and language (and the GPU benchmark: a measurement, not a choice — 自动 uses it again). */
export function resetSettings(current: UserSettings): UserSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), quality: defaultQuality(), playerName: current.playerName, lang: current.lang, gpuBench: current.gpuBench };
}

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
  // the lobby name is sent once the edit is committed (blur / Enter / closing the
  // panel), not on every keystroke: each setName is a network message + lobby rebroadcast
  let sentName = settings.get().playerName.trim();
  const commitName = (): void => {
    const name = settings.get().playerName.trim().slice(0, 16);
    if (!name || name === sentName) return;
    sentName = name;
    const s = ctx.session;
    if (s && s.phase === 'lobby') s.setName(name);
  };
  const net = (patch: Partial<UserSettings['net']>): void => settings.update({ net: { ...settings.get().net, ...patch } });

  const nameInput = (): HTMLInputElement => {
    // a generated 无名N is the placeholder ("Nameless 885" in English), not a value to edit
    const m = nameFieldModel(settings.get().playerName, getLang(), t('title.namePh'));
    const input = textInput(m.value, (v) => upd({ playerName: m.toStored(v) }), { maxlength: 16, placeholder: m.placeholder, label: t('settings.name') });
    input.addEventListener('change', commitName);
    return input;
  };

  const general = (): HTMLElement[] => {
    const st = settings.get();
    return [
      field(t('settings.language'), segmented([
        { value: 'zh' as Lang, label: '中文' },
        { value: 'en' as Lang, label: 'English' },
      ], st.lang, (v) => upd({ lang: v }), { name: t('settings.language') })),
      field(t('settings.name'), nameInput()),
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
    // 自动（当前：高清）: the tier follows this machine (GPU benchmark, 自动调节画质); a tier below it is the player's pick
    const tuning = ctx.autoTuning?.() ?? false;
    const auto = h('button', { type: 'button', class: 'q-auto', aria: { pressed: st.qualityAuto }, data: { value: 'auto' } },
      tuning ? tx('自动（检测中…）', 'Auto (checking…)') : tx(`自动（当前：${qualityName(st.quality)}）`, `Auto (now: ${qualityName(st.quality)})`));
    auto.addEventListener('click', () => {
      if (settings.get().qualityAuto) return;
      if (ctx.setQualityAuto) ctx.setQualityAuto();
      else upd({ qualityAuto: true });
    });
    const tiers = segmented(QUALITIES.map((q) => ({ value: q, label: t(`settings.quality.${q}`) })), st.quality, (v) => upd({ quality: v, qualityAuto: false }), { name: t('settings.quality') });
    tiers.classList.toggle('auto', st.qualityAuto);
    return [
      field(t('settings.fov'), slider(st.fov, 60, 100, 1, (v) => upd({ fov: v }), (v) => `${v}°`, t('settings.fov'))),
      field(t('settings.quality'), h('div', { class: 'set-quality' }, auto, tiers),
        st.qualityAuto
          ? tx('自动：按显卡测速选择画质和渲染比例（换显卡会重新测）。', 'Auto: picked from a quick benchmark of your graphics card — quality and render scale (measured again on a new GPU).')
          : tx('集成显卡或手机选“流畅”；很卡或没有独立显卡（软件渲染）选“极速”。', 'Pick “Low” on integrated GPUs and phones; “Lowest” when it still stutters (no GPU / software rendering).')),
      field(tx('自动调节画质', 'Auto-adjust quality'), toggle(st.autoAdjust, (v) => upd({ autoAdjust: v }), tx('自动调节画质', 'Auto-adjust quality')),
        st.qualityAuto
          ? tx('对局中持续卡顿（低于 28 帧）时先降分辨率、再降一档画质；很流畅时在暂停或下一局提高一档。', 'In a match that keeps lagging (under 28 fps): resolution first, then one tier down; with lots of headroom one tier up at a pause or the next match.')
          : tx('对局中持续卡顿（低于 28 帧）时先降分辨率、再降一档画质。', 'In a match that keeps lagging (under 28 fps): resolution first, then one tier down.')),
      field(t('settings.fps'), toggle(st.showFps, (v) => upd({ showFps: v }), t('settings.fps')),
        tx('对局中按 F3 也可开关：帧率、帧时间、绘制调用、渲染比例、画质与显卡。', 'F3 toggles it in a match: frame rate and time, draw calls, render scale, tier and GPU.')),
      gpuLine(),
    ];
  };

  /** 显卡：<renderer> — which GPU the browser draws with (a software renderer is flagged). */
  const gpuLine = (): HTMLElement => {
    const { renderer, software } = ctx.gpu;
    return h('div', { class: `set-gpu${software ? ' soft' : ''}`, title: renderer },
      ctx.openPerfCheck ? button(tx('性能体检', 'Performance check'), () => ctx.openPerfCheck?.(), { cls: 'small gold pc-open' }) : null,
      h('span', { class: 'lbl' }, tx('显卡：', 'GPU: ')),
      h('b', null, gpuShortName(renderer) || tx('未知', 'unknown')),
      software ? h('span', { class: 'warn' }, tx('（软件渲染：浏览器没有使用显卡）', ' (software rendering: the browser is not using the GPU)')) : null,
      renderer ? h('code', null, renderer) : null,
    );
  };

  const audio = (): HTMLElement[] => {
    const st = settings.get();
    return [
      field(t('settings.master'), slider(st.masterVolume, 0, 1, 0.01, (v) => upd({ masterVolume: v }), pct, t('settings.master'))),
      field(t('settings.music'), slider(st.musicVolume, 0, 1, 0.01, (v) => upd({ musicVolume: v }), pct, t('settings.music'))),
      field(tx('配乐', 'Soundtrack'), segmented([
        { value: 'noname' as const, label: tx('无名杀', 'Noname') },
        { value: 'original' as const, label: tx('原创国风', 'Original') },
      ], st.musicSource === 'original' ? 'original' : 'noname', (v) => upd({ musicSource: v }), { name: tx('配乐', 'Soundtrack') }),
        tx('「无名杀」曲目在线加载自开源项目 无名杀（github.com/libnoname/noname），版权归原作者；加载不到时自动改用原创国风配乐。',
          'The Noname tracks stream from the open-source project 无名杀 (github.com/libnoname/noname), rights with their authors; if they can’t load, the original score plays instead.')),
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
            '（默认端口 8787），然后把地址填为 ws://<该电脑IP>:8787/ws。该服务器同时提供 PeerJS 信令（路径 /peerjs），可填入下方的 PeerJS 设置。',
            ' inside the warlords folder (port 8787 by default), then set the address to ws://<that-machine-IP>:8787/ws. The same server also hosts PeerJS signalling (path /peerjs) for the PeerJS fields below.',
          )),
        ),
      ),
      field(t('settings.netMode'), segmented([
        { value: 'peer' as const, label: t('online.peer') },
        { value: 'ws' as const, label: t('online.ws') },
      ], n.mode, (v) => {
        markModeChosen();
        net({ mode: v });
      }, { name: t('settings.netMode') })),
      field(t('settings.wsUrl'), textInput(n.wsUrl, (v) => net({ wsUrl: v.trim() }), { placeholder: t('settings.wsUrlPh'), label: t('settings.wsUrl') })),
      field(t('settings.peerHost'), (() => {
        const input = textInput(n.peerHost, (v) => net({ peerHost: v.trim() }), { placeholder: t('settings.peerHostPh'), label: t('settings.peerHost') });
        // a LAN / localhost signalling server has no TLS certificate: HTTPS/WSS off by itself
        input.addEventListener('change', () => {
          if (isPrivateHost(input.value) && settings.get().net.peerSecure) {
            net({ peerSecure: false });
            renderBody();
          }
        });
        return input;
      })(), tx('局域网 / 本机地址会自动关闭 HTTPS/WSS。', 'LAN / localhost addresses switch HTTPS/WSS off automatically.')),
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

  // 画质 moves by itself (the GPU benchmark finished, 自动调节画质, 自动 turned on): the graphics tab follows
  const qualityKey = (st: UserSettings): string => `${st.quality}|${st.qualityAuto}|${st.autoAdjust}|${st.gpuBench?.at ?? 0}`;
  let lastQuality = qualityKey(settings.get());
  bag.add(
    settings.subscribe((st) => {
      const k = qualityKey(st);
      if (k === lastQuality) return;
      lastQuality = k;
      if (tab === 'graphics') renderBody();
    }),
  );

  // PLATFORM-4: a quality switch made mid-match applies in stages — 「应用中…」 in the heading meanwhile
  let applying = false;
  const applyingBadge = h('span', { class: 'set-applying sg-hidden', role: 'status' });
  const showApplying = (): void => {
    applyingBadge.textContent = t('settings.applying');
    applyingBadge.classList.toggle('sg-hidden', !applying);
  };
  const offApplying = ctx.qualityApplying?.((on) => {
    applying = on;
    showApplying();
  });
  if (offApplying) bag.add(offApplying);

  const build = (): void => {
    const ids: SettingsTab[] = ['general', 'controls', 'graphics', 'audio', 'network'];
    showApplying();
    sheet.replaceChildren(
      h('header', { class: 'set-head' },
        h('h2', { class: 'sg-h2' }, t('settings.title')),
        applyingBadge,
        button('✕', onClose, { cls: 'icon small ghost', title: t('common.close'), sfx: 'back' }),
      ),
      tabs(ids.map((id) => ({ id, label: t(`settings.tab.${id}`) })), tab, (id) => {
        tab = id;
        renderBody();
      }),
      body,
      h('footer', { class: 'set-foot' },
        button(t('settings.reset'), () => {
          void ctx.confirm(tx('恢复全部默认设置？（名号与语言会保留）', 'Reset every setting to default? (your name and language are kept)')).then((yes) => {
            if (!yes) return;
            settings.update(resetSettings(settings.get()));
            // 自动 again: the stored benchmark's pick (or a new benchmark)
            ctx.setQualityAuto?.();
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
  return {
    el: back,
    relabel: build,
    dispose: () => {
      commitName();
      bag.dispose();
    },
  };
}
