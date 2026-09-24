// Loading: shown between hero select and the first playable frame.
import type { GameSession } from '../../game/session';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h } from '../dom';
import { heroName, heroTitle, t, tx } from '../i18n';
import { heroCard } from '../widgets';
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

export function createLoadingScreen(ctx: UiCtx, session: GameSession): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-loading', data: { screen: 'loading' } });
  let tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
  const tipEl = h('p', { class: 'tip-text' });
  const showTip = (): void => {
    const [zh, en] = LOADING_TIPS[tipIndex % LOADING_TIPS.length];
    tipEl.textContent = tx(zh, en);
  };

  const render = (): void => {
    const hero = session.heroSelect?.picks[mySeat(session)];
    showTip();
    el.replaceChildren(
      h('div', { class: 'load-inner' },
        hero ? h('div', { class: 'load-card' }, heroCard(ctx.portraits, hero)) : null,
        h('div', { class: 'load-text' },
          hero ? h('div', { class: 'load-hero' }, h('span', { class: 'nm' }, heroName(hero)), h('span', { class: 'ttl' }, heroTitle(hero))) : null,
          h('h1', { class: 'sg-h1' }, t('loading.title')),
          h('div', { class: 'brush-bar' }, h('i')),
          h('div', { class: 'tip sg-dark' }, h('b', null, t('loading.tip')), tipEl),
        ),
      ),
    );
  };
  bag.interval(() => {
    tipIndex++;
    showTip();
  }, 5000);
  render();
  return { el, relabel: render, dispose: () => bag.dispose() };
}
