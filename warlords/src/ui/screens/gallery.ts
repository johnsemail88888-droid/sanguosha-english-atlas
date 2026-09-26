// 武将图鉴: kingdom filter, card grid, detail with 3D turntable (if provided)
// or portrait, abilities, bio, playstyle, quotes.
import type { Kingdom } from '../../core/types';
import { HEROES, KINGDOM_ORDER as DATA_KINGDOM_ORDER } from '../../data';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { kingdomName, t } from '../i18n';
import { KINGDOM_GLYPH, kingdomColor } from '../theme';
import { button, heroCard } from '../widgets';
import { heroDetail } from './heroDetail';

const KINGDOM_ORDER: readonly Kingdom[] = DATA_KINGDOM_ORDER?.length ? DATA_KINGDOM_ORDER : ['shu', 'wei', 'wu', 'qun', 'god'];

export function galleryKingdoms(): Kingdom[] {
  const present = new Set(HEROES.map((x) => x.kingdom));
  return KINGDOM_ORDER.filter((k) => present.has(k));
}

export function createGalleryScreen(ctx: UiCtx): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-gallery', data: { screen: 'gallery' } });
  let filter: Kingdom | 'all' = 'all';
  let selected: string | null = null;
  let detail: { el: HTMLElement; dispose(): void } | null = null;

  const list = (): typeof HEROES => {
    const order = new Map(KINGDOM_ORDER.map((k, i) => [k, i]));
    return HEROES.filter((x) => filter === 'all' || x.kingdom === filter).sort(
      (a, b) => (order.get(a.kingdom) ?? 9) - (order.get(b.kingdom) ?? 9) || Number(b.lordCandidate) - Number(a.lordCandidate),
    );
  };

  const grid = h('div', { class: 'gal-grid' });
  const detailPane = h('aside', { class: 'gal-detail sg-panel sg-corners' });
  const countEl = h('span', { class: 'sg-mute count' });

  const renderGrid = (): void => {
    const heroes = list();
    countEl.textContent = t('gallery.count', { n: heroes.length });
    if (!heroes.length) {
      grid.replaceChildren(h('p', { class: 'sg-mute' }, t('gallery.empty')));
      return;
    }
    if (!selected || !heroes.some((x) => x.id === selected)) {
      // on wide screens keep something selected; on phones the detail is an overlay
      selected = window.matchMedia('(max-width: 760px)').matches ? null : heroes[0].id;
    }
    grid.replaceChildren(
      ...heroes.map((hero) =>
        heroCard(ctx.portraits, hero.id, {
          compact: true,
          selected: hero.id === selected,
          size: 192,
          onClick: () => {
            selected = hero.id;
            renderGrid();
            renderDetail();
          },
        }),
      ),
    );
  };

  const renderDetail = (): void => {
    detail?.dispose();
    detail = null;
    el.classList.toggle('has-detail', !!selected);
    if (!selected) {
      detailPane.replaceChildren();
      return;
    }
    detail = heroDetail(ctx, selected, { lore: true, visual: 'turntable' });
    detailPane.replaceChildren(
      button('✕', () => {
        selected = null;
        renderGrid();
        renderDetail();
      }, { cls: 'icon small ghost close-detail', title: t('common.close'), sfx: 'back' }),
      detail.el,
    );
    detailPane.scrollTop = 0;
  };

  const build = (): void => {
    const filters: (Kingdom | 'all')[] = ['all', ...galleryKingdoms()];
    const bar = h('div', { class: 'gal-filter', role: 'tablist' },
      filters.map((k) => {
        const b = h('button', { class: `kd-filter${k === filter ? ' on' : ''}`, type: 'button', role: 'tab', aria: { selected: k === filter }, data: { kingdom: k } },
          k === 'all' ? t('common.all') : h('span', null, h('i', { class: 'dot', style: `background:${kingdomColor(k)}` }, KINGDOM_GLYPH[k]), kingdomName(k)),
        );
        b.addEventListener('click', () => {
          filter = k;
          ctx.sfx('click');
          build();
        });
        return b;
      }),
    );
    el.replaceChildren(
      h('header', { class: 'gal-head' },
        button(`‹ ${t('common.back')}`, () => ctx.go('title'), { cls: 'ghost small', sfx: 'back' }),
        h('h1', { class: 'sg-h1' }, t('gallery.title')),
        countEl,
      ),
      bar,
      h('div', { class: 'gal-main' }, h('div', { class: 'gal-grid-wrap' }, grid), detailPane),
    );
    renderGrid();
    renderDetail();
  };

  build();
  return {
    el,
    relabel: build,
    dispose: () => {
      detail?.dispose();
      bag.dispose();
    },
  };
}
