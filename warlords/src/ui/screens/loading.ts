// Loading: shown between hero select and the first playable frame. With the
// painted art: a full-bleed battle scene of your hero's kingdom behind the
// portrait card, your role, the progress bar and a tip.
import type { Kingdom } from '../../core/types';
import { HERO_BY_ID, ROLE_BY_ID } from '../../data';
import type { GameSession } from '../../game/session';
import { assetListSync } from '../../game/assets';
import { firstShipped, loadingArtCandidates } from '../art';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h, setClass } from '../dom';
import { heroName, heroTitle, roleName, t, tx } from '../i18n';
import { artBackdrop, type ArtBackdrop } from '../keyart';
import { heroCard, roleSeal } from '../widgets';
import { mySeat } from './roles';

export const LOADING_TIPS: readonly [string, string][] = [
  ['主公的身份是公开的，其他人的身份只有死亡后才会揭晓。', 'Only the Lord is public; every other role is revealed on death.'],
  ['击杀反贼的人可以获得 3 个锦囊奖励。', 'Whoever kills a Rebel is rewarded with 3 items.'],
  ['主公误杀忠臣会丢弃所有锦囊、装备和副武器。', 'If the Lord kills a Loyalist, the Lord drops every item, armor, mount and the secondary weapon.'],
  ['按 T 打开跳身份轮盘——但别忘了，谎言也是一种战术。', 'Press T for the claim wheel — lying is a valid strategy.'],
  ['濒死时 12 秒内被队友用「桃」救起即可复活，也可以饮「酒」自救。', 'When downed you have 12 s: an ally can revive you with a Peach, or drink Wine to rise yourself.'],
  ['Z 跟随 · X 驻守 · C 进攻 · V 冲锋：别忘了指挥你的部曲。', 'Z follow · X hold · C attack · V charge — command your squad.'],
  ['烽火圈外每秒都会受到伤害，且无视护甲与闪避。', 'The zone burns you every second outside, ignoring armor and dodges.'],
  ['天降锦囊每 100 秒降落一次，里面有传说级武器。', 'Airdrops land every 100 s and carry legendary weapons.'],
  ['Ctrl / Alt 闪避翻滚有短暂无敌时间。', 'Ctrl / Alt dodge-rolls grant brief invulnerability.'],
  ['内奸必须在最后与主公单挑并获胜。', 'The Traitor must be the last one standing against the Lord.'],
];

/** Loading stage → [progress, zh, en]; `null` = the host is still generating the match. */
const STAGES: Record<string, [number, string, string]> = {
  sim: [0.15, '生成战场与地形…', 'Generating the battlefield…'],
  scene: [0.4, '搭建城池与山河…', 'Building the world…'],
  models: [0.62, '点将列阵（载入模型）…', 'Loading models…'],
  shaders: [0.62, '研墨点彩（编译着色器）…', 'Compiling shaders…'],
  warmup: [0.88, '整军待发…', 'Mustering the troops…'],
  ready: [1, '开战！', 'To battle!'],
  failed: [1, '开战！', 'To battle!'],
};

/**
 * The stage line under the bar. Built and ready while the host has not started the
 * clock yet (it — or a slow guest — is still loading; session.awaitingHostStart):
 * 「等待房主加载…」 instead of a 「开战！」 that would sit there for a minute (MP2-1).
 */
export function loadStageText(stage: string, progress: number, awaitingHost: boolean): string {
  if ((stage === 'ready' || stage === 'failed') && awaitingHost) return t('loading.waitHost');
  const st = STAGES[stage] ?? STAGES.sim;
  return `${tx(st[1], st[2])} ${Math.round(progress * 100)}%`;
}

export function createLoadingScreen(ctx: UiCtx, session: GameSession): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-loading', data: { screen: 'loading' } });
  let stage = 'sim';
  let progress = STAGES.sim[0];
  const barFill = h('i');
  const bar = h('div', { class: 'brush-bar det', role: 'progressbar', aria: { valuemin: '0', valuemax: '100' } }, barFill);
  const stageEl = h('div', { class: 'load-stage' });
  const showStage = (): void => {
    barFill.style.width = `${Math.round(progress * 100)}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    const waiting = !!session.awaitingHostStart;
    stageEl.textContent = loadStageText(stage, progress, waiting);
    el.dataset.stage = stage;
    setClass(el, 'wait-host', waiting && (stage === 'ready' || stage === 'failed'));
  };
  let tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
  const tipEl = h('p', { class: 'tip-text' });
  const showTip = (): void => {
    const [zh, en] = LOADING_TIPS[tipIndex % LOADING_TIPS.length];
    tipEl.textContent = tx(zh, en);
  };

  // Painted battle scene of your hero's kingdom (none shipped: the plain screen, unchanged).
  // When the art listing already names the file, the art layout is used from the first
  // frame and the image fades in once decoded, so nothing jumps.
  let art: ArtBackdrop | null = null;
  let artKingdom: Kingdom | null | undefined;
  const syncArt = (hero: string | null): void => {
    const k = (hero && HERO_BY_ID[hero]?.kingdom) || null;
    if (art && k === artKingdom) return;
    artKingdom = k;
    art?.dispose();
    const candidates = loadingArtCandidates(k);
    const next = artBackdrop(candidates, {
      drift: true,
      cls: 'loading',
      onResolve: (url) => {
        if (art !== next || (url !== null) === el.classList.contains('art')) return;
        el.classList.toggle('art', url !== null);
        render();
      },
    });
    art = next;
    if (firstShipped(assetListSync(), candidates)) el.classList.add('art');
  };
  bag.add(() => art?.dispose());

  const roleLine = (): HTMLElement | null => {
    const role = session.roles?.yourRole;
    const def = role ? ROLE_BY_ID[role] : undefined;
    if (!role || !el.classList.contains('art')) return null;
    return h('div', { class: 'load-role' }, roleSeal(role, '1.7em'), h('b', null, roleName(role)), def ? h('span', null, tx(def.goalZh, def.goalEn)) : null);
  };

  const render = (): void => {
    const hero = session.heroSelect?.picks[mySeat(session)] ?? ctx.myHero();
    syncArt(hero);
    showTip();
    el.replaceChildren(
      ...(art && el.classList.contains('art') ? [art.el] : []),
      h('div', { class: 'load-inner' },
        hero ? h('div', { class: 'load-card' }, heroCard(ctx.portraits, hero)) : null,
        h('div', { class: 'load-text' },
          hero ? h('div', { class: 'load-hero' }, h('span', { class: 'nm' }, heroName(hero)), h('span', { class: 'ttl' }, heroTitle(hero))) : null,
          roleLine(),
          h('h1', { class: 'sg-h1' }, t('loading.title')),
          bar,
          stageEl,
          h('div', { class: 'tip sg-dark' }, h('b', null, t('loading.tip')), tipEl),
        ),
      ),
    );
  };
  // a late hero-select broadcast (auto-pick at the deadline) still shows your hero
  bag.add(session.on('heroSelect', () => render()));
  // real progress of the staged 3D build (render/mountGame.ts)
  if (ctx.loadProgress) {
    bag.add(
      ctx.loadProgress((p) => {
        stage = p ? p.stage : 'sim';
        progress = p ? p.progress : STAGES.sim[0];
        showStage();
      }),
    );
  }
  bag.interval(() => {
    tipIndex++;
    showTip();
  }, 5000);
  // the host starting the clock is no event of its own: look again while the view is ready
  bag.interval(() => {
    if (stage === 'ready' || stage === 'failed') showStage();
  }, 500);
  render();
  showStage();
  return {
    el,
    relabel: () => {
      render();
      showStage();
    },
    dispose: () => bag.dispose(),
  };
}
