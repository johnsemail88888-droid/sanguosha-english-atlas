// Title screen: painted key art (slow ken-burns drift) or, without art, the
// animated ink-wash / gold backdrop; logo, name input, main menu.
import { assetListSync } from '../../game/assets';
import { settings } from '../../game/settings';
import { TITLE_ART } from '../art';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h, s } from '../dom';
import { getLang, t, tx } from '../i18n';
import { artBackdrop } from '../keyart';
import { button, seal } from '../widgets';

/** Periodic ridge line (period = width/2) so the layer can scroll seamlessly. */
function ridgePath(width: number, height: number, base: number, amps: readonly [number, number, number][], seed: number): string {
  const period = width / 2;
  const pts: string[] = [`M0 ${height}`];
  for (let x = 0; x <= width; x += 10) {
    let y = base;
    for (const [amp, freq, phase] of amps) {
      y -= amp * Math.sin(((x / period) * freq + phase + seed) * Math.PI * 2);
    }
    pts.push(`L${x} ${y.toFixed(1)}`);
  }
  pts.push(`L${width} ${height}Z`);
  return pts.join(' ');
}

function mountainLayer(cls: string, fillTop: string, fillBottom: string, base: number, amps: readonly [number, number, number][], seed: number): SVGSVGElement {
  const W = 2000;
  const H = 400;
  const gid = `sg-mtn-${cls}`;
  return s('svg', { class: `mtn ${cls}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    s('defs', null,
      s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: '0%', 'stop-color': fillTop }),
        s('stop', { offset: '100%', 'stop-color': fillBottom }),
      ),
    ),
    s('path', { d: ridgePath(W, H, base, amps, seed), fill: `url(#${gid})` }),
  );
}

function embersLayer(): HTMLElement {
  const embers = h('div', { class: 'embers' });
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 28; i++) {
    const e = h('i');
    e.style.setProperty('--x', `${(rnd() * 100).toFixed(1)}%`);
    e.style.setProperty('--d', `${(7 + rnd() * 9).toFixed(1)}s`);
    e.style.setProperty('--delay', `${(-rnd() * 16).toFixed(1)}s`);
    e.style.setProperty('--s', `${(2 + rnd() * 3).toFixed(1)}px`);
    e.style.setProperty('--drift', `${((rnd() - 0.5) * 120).toFixed(0)}px`);
    embers.appendChild(e);
  }
  return embers;
}

/** The procedural backdrop (the look without painted art). */
function backdrop(): HTMLElement {
  return h('div', { class: 'sg-title-bg', aria: { hidden: 'true' } },
    h('div', { class: 'sky' }),
    h('div', { class: 'sun' }),
    h('div', { class: 'cloud c1' }),
    h('div', { class: 'cloud c2' }),
    h('div', { class: 'drift far' }, mountainLayer('far', '#6a4a3a', '#3a2a22', 250, [[40, 2, 0.1], [22, 5, 0.4], [9, 11, 0.7]], 0.13)),
    h('div', { class: 'drift mid' }, mountainLayer('mid', '#3a281c', '#1e150e', 300, [[55, 1, 0.3], [25, 4, 0.2], [10, 9, 0.5]], 0.57)),
    h('div', { class: 'mist' }),
    h('div', { class: 'drift near' }, mountainLayer('near', '#1a120c', '#0c0806', 350, [[35, 2, 0.8], [18, 6, 0.1], [6, 14, 0.3]], 0.91)),
    h('div', { class: 'flags' }, h('i', { class: 'f1' }), h('i', { class: 'f2' })),
    embersLayer(),
    h('div', { class: 'vignette' }),
  );
}

/**
 * Backdrop host: the key art when the deploy ships it (the procedural scene if
 * not, or if the listing is slow — the art then fades in over it).
 */
function titleBackdrop(bag: Bag, onArt: () => void): HTMLElement {
  const host = h('div', { class: 'sg-title-bghost' });
  const known = assetListSync();
  if (known && !known.has(TITLE_ART)) {
    host.appendChild(backdrop());
    return host;
  }
  let fallback: HTMLElement | null = null;
  const useFallback = (): void => {
    if (fallback) return;
    fallback = backdrop();
    host.prepend(fallback);
  };
  const art = artBackdrop([TITLE_ART], {
    drift: true,
    cls: 'title',
    onResolve: (url) => {
      if (!url) {
        useFallback();
        return;
      }
      host.appendChild(h('div', { class: 'sg-title-bg sg-title-art', aria: { hidden: 'true' } }, art.el, h('div', { class: 'shade' }), embersLayer(), h('div', { class: 'vignette' })));
      onArt();
      // the art arrived after the procedural scene was put up: drop it (and its animations) once faded over
      const covered = fallback;
      if (covered) bag.timeout(() => covered.remove(), 900);
    },
  });
  bag.add(art);
  bag.timeout(() => {
    if (art.url === undefined) useFallback();
  }, 2500);
  return host;
}

export function createTitleScreen(ctx: UiCtx, version: string): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-title', data: { screen: 'title' } });
  const bg = titleBackdrop(bag, () => el.classList.add('has-art'));

  const render = (): void => {
    el.replaceChildren(bg);
    const name = h('input', {
      class: 'sg-input dark',
      value: settings.get().playerName,
      placeholder: t('title.namePh'),
      maxlength: 16,
      autocomplete: 'off',
      aria: { label: t('title.name') },
    });
    name.addEventListener('change', () => settings.update({ playerName: name.value.trim().slice(0, 16) }));
    name.addEventListener('input', () => settings.update({ playerName: name.value.slice(0, 16) }));

    const langBtn = button(t('common.lang'), () => settings.update({ lang: getLang() === 'zh' ? 'en' : 'zh' }), {
      cls: 'ghost small sg-lang-btn',
      title: 'Language / 语言',
    });

    const menuItem = (label: string, sub: string | null, onClick: () => void, cls = '', disabled = false): HTMLButtonElement =>
      button([h('span', { class: 'lbl' }, label), sub ? h('span', { class: 'sub' }, sub) : null], onClick, {
        cls: `sg-menu-btn ${cls}`,
        sfx: 'confirm',
        disabled,
        title: disabled ? tx('需要 WebGL 2', 'Needs WebGL 2') : undefined,
      });

    // no WebGL 2: a match would be a black screen — explain, and keep play disabled
    const noGl = !ctx.webgl.ok;
    const glNotice = noGl
      ? h('div', { class: 'sg-webgl-warn', role: 'alert' },
          h('b', null, tx('无法启动 3D 画面', "3D graphics can't start")),
          h('p', null, tx(
            '你的浏览器未启用 WebGL 2，暂时无法开始对局。请在浏览器设置中开启「硬件加速」（或「使用图形加速」），更新显卡驱动或浏览器（推荐最新版 Chrome / Edge / Firefox，Safari 15 以上），然后刷新页面。',
            'WebGL 2 is not available in this browser, so no match can start. Turn on hardware acceleration in the browser settings, update your graphics driver or browser (latest Chrome / Edge / Firefox, Safari 15+), then reload the page.',
          )),
          ctx.webgl.reason ? h('p', { class: 'why' }, ctx.webgl.reason) : null,
          button(tx('刷新页面', 'Reload'), () => location.reload(), { cls: 'small gold' }),
        )
      : null;

    el.classList.toggle('no-gl', noGl);
    el.append(
      h('div', { class: 'sg-title-top' }, langBtn),
      h('div', { class: 'sg-title-main' },
        h('div', { class: 'sg-logo' },
          h('div', { class: 'l1' }, '三国杀'),
          h('div', { class: 'l2' }, h('span', { class: 'dot' }, '·'), '枪火乱世'),
          seal('乱', { size: '2.2em', title: '乱世' }),
          h('div', { class: 'en' }, 'SANGUO  WARLORDS'),
        ),
        h('div', { class: 'sg-tagline' }, t('title.pressStart')),
        h('div', { class: 'sg-title-menu' },
          glNotice,
          h('label', { class: 'sg-name' }, h('span', null, t('title.name')), name),
          menuItem(t('title.single'), t('title.singleSub'), () => ctx.go('single'), noGl ? 'primary off' : 'primary', noGl),
          menuItem(t('title.online'), t('title.onlineSub'), () => ctx.go('online'), '', noGl),
          h('div', { class: 'row' },
            menuItem(t('title.gallery'), null, () => ctx.go('gallery'), 'dark'),
            menuItem(t('title.help'), null, () => ctx.go('help'), 'dark'),
          ),
          menuItem(t('title.settings'), null, () => ctx.openSettings(), 'dark'),
        ),
      ),
      h('div', { class: 'sg-title-foot' }, t('app.subtitle'), h('span', { class: 'ver' }, t('title.version', { v: version }))),
    );
  };
  render();
  return {
    el,
    relabel: render,
    dispose: () => bag.dispose(),
  };
}
