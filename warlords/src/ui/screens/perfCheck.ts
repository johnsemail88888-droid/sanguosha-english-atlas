// 性能体检 (Performance check): is the game using the graphics card, how fast will
// it run, and — when something is wrong — how to fix it in a click or two: the
// browser's own "use hardware acceleration" switch (its settings address copied
// for pasting: pages cannot open chrome:// links), Windows' per-app GPU choice on
// a laptop with an integrated GPU, or the desktop app, which turns the GPU on by
// itself. Opens by itself when a problem is found (App), from 设置 → 画面 and from
// the F3 panel; 重新检测 probes the GPU again and runs the 2 s benchmark in place.
import { classifyGpu, defaultQuality, settings } from '../../game/settings';
import type { AutoTunePick } from '../../render/adaptiveRes';
import { autoPick, benchFor as storedBench, type GpuState } from '../autoQuality';
import type { Screen, UiCtx } from '../ctx';
import { Bag, copyText, h } from '../dom';
import { t, tx } from '../i18n';
import {
  RELEASES_URL,
  WINDOWS_GRAPHICS_URL,
  desktopDownload,
  externalLink,
  gpuShortName,
  integratedTip,
  isDesktopOs,
  perfVerdict,
  platformInfo,
  qualityName,
  softwareFix,
  verdictText,
} from '../perfcheck';
import { button } from '../widgets';

const viewPixels = (): number => (globalThis.innerWidth || 1280) * (globalThis.innerHeight || 720);

/** This GPU's stored benchmark, when it measured something (null: not benchmarked on it, or it failed). */
function benchFor(gpu: GpuState): { ms: number; msSmall: number } | null {
  const b = storedBench(settings.get(), gpu);
  return b && b.ms > 0 ? b : null;
}

/** What the stored benchmark (this GPU's) says this machine can run; null: not benchmarked. */
export function currentPick(gpu: GpuState): AutoTunePick | null {
  if (!gpu.software && !benchFor(gpu)) return null;
  return autoPick(settings.get(), gpu, { cssPixels: viewPixels(), dpr: globalThis.devicePixelRatio || 1 }, defaultQuality());
}

export function createPerfCheckPanel(ctx: UiCtx, onClose: () => void): Screen {
  const bag = new Bag();
  const back = h('div', { class: 'sg-modal-back sg-perf-back', role: 'dialog', aria: { modal: 'true', label: tx('性能体检', 'Performance check') }, data: { screen: 'perfcheck' } });
  const sheet = h('div', { class: 'sg-modal sg-perfcheck sg-panel sg-corners', tabindex: -1 });
  back.appendChild(sheet);
  let checking = false;
  let alive = true;

  const copyBtn = (url: string): HTMLButtonElement =>
    button(tx('复制设置地址', 'Copy settings address'), () => {
      void copyText(url).then((ok) => ctx.toast(ok ? `${t('common.copied')} · ${url}` : url));
    }, { cls: 'small gold pc-copy', data: { url } });

  const steps = (list: string[], first?: HTMLElement | null): HTMLElement =>
    h('ol', { class: 'pc-steps' }, ...list.map((s, i) => h('li', null, h('span', null, s), i === 0 && first ? first : null)));

  const render = (): void => {
    const gpu = ctx.gpu;
    const pick = currentPick(gpu);
    const b = benchFor(gpu);
    const st = settings.get();
    const v = perfVerdict({ webgl2: ctx.webgl.ok, renderer: gpu.renderer, pick });
    const plat = platformInfo();
    const benched = b;

    const facts = h('div', { class: 'pc-facts' },
      h('div', null, h('span', { class: 'k' }, tx('显卡', 'GPU')), h('b', null, gpuShortName(gpu.renderer) || tx('未知', 'unknown'))),
      gpu.renderer ? h('code', { class: 'raw' }, gpu.renderer) : null,
      benched ? h('div', null, h('span', { class: 'k' }, tx('测速', 'Benchmark')), `${benched.ms.toFixed(1)} ms @ 1280×720 · ${benched.msSmall.toFixed(1)} ms @ 640×360`) : null,
      pick ? h('div', null, h('span', { class: 'k' }, tx('适合', 'Best fit')), `${qualityName(pick.quality)} · ${tx('渲染比例', 'render scale')} ≤ ${pick.maxPixelRatio.toFixed(2)}×`) : null,
      h('div', { class: 'now' }, h('span', { class: 'k' }, tx('当前画质', 'Quality now')), st.qualityAuto ? tx(`自动（${qualityName(st.quality)}）`, `Auto (${qualityName(st.quality)})`) : qualityName(st.quality)),
    );

    const sections: (HTMLElement | null)[] = [];
    if (v.kind === 'software') {
      const fix = softwareFix(plat.desktopApp ? 'desktop' : plat.browser);
      sections.push(
        h('section', { class: 'pc-sec fix' },
          h('h3', { class: 'sg-h3' }, plat.desktopApp ? tx('让桌面版用上显卡', 'Get the desktop app onto the GPU') : tx(`让浏览器用上显卡（${fix.name}）`, `Turn the GPU on in ${fix.name}`)),
          steps(fix.steps, fix.url ? h('span', { class: 'pc-url' }, copyBtn(fix.url), h('code', null, fix.url)) : null),
          h('p', { class: 'pc-note' }, tx('改好后重新打开游戏，这里会自动再检查一次，显示 ✅ 就成功了。', 'Open the game again afterwards: it checks by itself and shows ✅ once it works.')),
        ),
      );
    }
    const tip = v.kind !== 'software' && v.kind !== 'nowebgl' ? integratedTip(plat.os, gpu.renderer, plat.desktopApp) : null;
    if (tip) {
      sections.push(
        h('section', { class: 'pc-sec tip' },
          h('h3', { class: 'sg-h3' }, tx('笔记本还有独立显卡？让游戏用上它', 'Laptop with a graphics card too? Let the game use it')),
          steps(tip, h('span', { class: 'pc-url' }, copyBtn(WINDOWS_GRAPHICS_URL), h('code', null, WINDOWS_GRAPHICS_URL), h('small', null, tx('（按 Win+R，粘贴后回车）', ' (Win+R, paste, Enter)')))),
        ),
      );
    }
    if (v.kind === 'slow') {
      sections.push(
        h('section', { class: 'pc-sec slow' },
          h('h3', { class: 'sg-h3' }, tx('还能更流畅', 'Smoother still')),
          h('ul', { class: 'pc-steps' },
            h('li', null, tx('画质已按显卡自动选择，对局中卡顿时还会自动调低。', 'The quality is picked for this GPU and steps down by itself when a match lags.')),
            h('li', null, tx('关闭其他占用显卡的程序和标签页；笔记本请接上电源。', 'Close other programs and tabs using the GPU; plug a laptop in.')),
          ),
        ),
      );
    }
    // the no-fuss path: the desktop app uses the GPU by itself (web, on an OS it exists for)
    const dl = !plat.desktopApp && isDesktopOs(plat.os) ? desktopDownload(plat.os, classifyGpu(gpu.renderer)) : null;
    if (dl) {
      sections.push(
        h('section', { class: 'pc-sec dl' },
          externalLink(RELEASES_URL, tx('下载桌面版（自动使用显卡，更流畅）', 'Get the desktop app (uses the GPU by itself, smoother)'), 'sg-btn gold wide pc-dl'),
          h('div', { class: 'pc-file' }, `${dl.os}${tx('：', ': ')}`, h('code', null, dl.file)),
        ),
      );
    }

    const recheck = button(checking ? tx('正在检测…（约 2 秒）', 'Checking… (about 2 s)') : tx('重新检测', 'Check again'), () => void runCheck(), {
      cls: 'dark pc-recheck',
      disabled: checking || !ctx.recheckGpu,
    });
    sheet.replaceChildren(
      h('header', { class: 'set-head' },
        h('h2', { class: 'sg-h2' }, tx('性能体检', 'Performance check')),
        button('✕', onClose, { cls: 'icon small ghost', title: t('common.close'), sfx: 'back' }),
      ),
      h('div', { class: `pc-verdict ${v.kind}`, role: 'status', data: { verdict: v.kind } }, checking ? h('span', { class: 'sg-spinner' }) : null, verdictText(v)),
      facts,
      ...sections.filter((x): x is HTMLElement => !!x),
      h('footer', { class: 'set-foot' }, recheck, button(t('common.close'), onClose, { cls: 'gold', sfx: 'back' })),
    );
  };

  const runCheck = async (): Promise<void> => {
    if (checking || !ctx.recheckGpu) return;
    checking = true;
    render();
    try {
      await ctx.recheckGpu();
    } catch (err) {
      console.warn('[ui] GPU re-check failed', err);
    } finally {
      checking = false;
      if (alive) render();
    }
  };

  bag.listen(back, 'pointerdown', (ev) => {
    if (ev.target === back) onClose();
  });
  render();
  return {
    el: back,
    relabel: render,
    dispose: () => {
      alive = false;
      bag.dispose();
    },
  };
}

