// First-match guidance: a dismissible hint card shown in the player's first two
// matches (counted in localStorage) with the keys that are easy to miss (Tab,
// M, T, Shift, Ctrl, F) and what claiming a role (自称忠臣) means. Touch players
// get the matching on-screen buttons instead of keys.
import { h } from '../dom';
import { t, tx } from '../i18n';
import { touchLabel, type TouchKey } from '../short';
import { keyCap } from '../widgets';
import { getLang } from '../i18n';

export const GUIDE_KEY = 'sgwl.guide.v1';
/** matches the card is shown in */
export const GUIDE_MATCHES = 2;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** How many matches already showed the guide (never = a large number). */
export function guideCount(s: Pick<Storage, 'getItem'> | null = store()): number {
  try {
    const n = Number(s?.getItem(GUIDE_KEY) ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Show the guide this match? (true for the first GUIDE_MATCHES matches) */
export function shouldShowGuide(count: number): boolean {
  return count < GUIDE_MATCHES;
}

function save(n: number): void {
  try {
    store()?.setItem(GUIDE_KEY, String(n));
  } catch {
    /* storage blocked: the guide simply shows again next time */
  }
}

interface GuideLine {
  keys: string[];
  /** the on-screen button that does the same on touch (none: explained in the text) */
  touch?: TouchKey;
  zh: string;
  en: string;
  /** a shorter line for the touch card (it shares a phone screen with the controls) */
  touchZh?: string;
  touchEn?: string;
}

const LINES: readonly GuideLine[] = [
  { keys: ['Tab'], touch: 'score', zh: '战况：谁活着、谁跳了什么身份', en: 'Scoreboard: who is alive, who claimed what', touchEn: 'Scoreboard: who lives, who claimed what' },
  { keys: ['M'], touch: 'map', zh: '战场地图：烽火圈、下一圈、天降锦囊', en: 'Battle map: the zone, the next circle, airdrops', touchZh: '地图：烽火圈、下一圈、天降锦囊', touchEn: 'Map: the zone, next circle, airdrops' },
  { keys: ['T'], touch: 'wheel', zh: '跳身份 / 快捷喊话轮盘', en: 'Claim a role / quick-chat wheel', touchEn: 'Claim a role / quick chat' },
  { keys: ['Shift'], zh: '冲刺（触屏：摇杆推到底）', en: 'Sprint (touch: push the stick all the way)', touchZh: '冲刺：摇杆推到底', touchEn: 'Sprint: push the stick all the way' },
  { keys: ['Ctrl'], touch: 'dodge', zh: '闪避翻滚，短暂无敌（2 次充能）', en: 'Dodge roll with brief invulnerability (2 charges)', touchEn: 'Roll: brief invulnerability, 2 charges' },
  { keys: ['F'], touch: 'interact', zh: '拾取 / 开锦囊 / 按住救起濒死队友', en: 'Pick up / open chests / hold to revive a downed ally', touchEn: 'Take / open chests / hold to revive' },
];

/** The card's lines as shown (touch: the shorter wording where there is one). */
export function guideLines(touch: boolean, lang: 'zh' | 'en'): { touch?: TouchKey; keys: string[]; text: string }[] {
  return LINES.map((l) => ({
    keys: l.keys,
    touch: l.touch,
    text: lang === 'en' ? (touch && l.touchEn) || l.en : (touch && l.touchZh) || l.zh,
  }));
}

/**
 * The hint card. `onClose` runs once when it is dismissed (button, ✕ or timeout).
 * Showing it counts one match; "don't show again" ends the series.
 */
export function createGuideCard(touch: boolean, onClose: () => void): HTMLElement {
  save(guideCount() + 1);
  let closed = false;
  const close = (never: boolean): void => {
    if (closed) return;
    closed = true;
    if (never) save(99);
    card.remove();
    onClose();
  };
  const en = getLang() === 'en';
  const keysOf = (l: { keys: string[]; touch?: TouchKey }): HTMLElement[] => {
    if (!touch) return l.keys.map((k) => keyCap(k));
    return l.touch ? [h('span', { class: 'tb-cap' }, touchLabel(l.touch, en ? 'en' : 'zh'))] : [];
  };
  const dismiss = h('button', { class: 'sg-btn small gold', type: 'button' }, t('guide.dismiss'));
  dismiss.addEventListener('click', (ev) => {
    ev.stopPropagation();
    close(false);
  });
  const never = h('button', { class: 'sg-btn small ghost', type: 'button' }, t('guide.never'));
  never.addEventListener('click', (ev) => {
    ev.stopPropagation();
    close(true);
  });
  const x = h('button', { class: 'gd-x', type: 'button', aria: { label: t('common.close') } }, '✕');
  x.addEventListener('click', (ev) => {
    ev.stopPropagation();
    close(false);
  });
  const card = h('div', { class: 'hud-guide sg-panel sg-corners', role: 'note' },
    x,
    h('h3', { class: 'sg-h3' }, t('guide.title')),
    h('ul', { class: 'gd-list' },
      guideLines(touch, en ? 'en' : 'zh').map((l) =>
        h('li', null, h('span', { class: 'keys' }, keysOf(l)), h('span', null, l.text)),
      ),
    ),
    h('p', { class: 'gd-claim' },
      h('b', null, tx('自称忠臣？', 'Claiming “Loyalist”?')), ' ',
      tx(
        '跳身份就是公开声明自己的身份，比如「我是忠臣」。声明可以是谎言——反贼和内奸也会假装忠臣，所以要看他打谁、救谁。',
        touch
          ? 'A claim says your role out loud (“I am a Loyalist”). It can be a lie — Rebels and the Traitor pose as Loyalists too: watch whom they shoot and save.'
          : 'A claim publicly states your role, e.g. “I am a Loyalist”. Claims can be lies — Rebels and the Traitor pose as Loyalists too, so watch whom they shoot and whom they save.',
      ),
    ),
    h('div', { class: 'gd-actions' }, never, dismiss),
  );
  // clicks on the card never reach the game underneath (no pointer lock, no "click to play")
  card.addEventListener('click', (ev) => ev.stopPropagation());
  card.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  (card as HTMLElement & { closeGuide?: (never: boolean) => void }).closeGuide = close;
  return card;
}

/**
 * Touch layouts tried in turn until the whole card shows (PLATFORM-10): a tighter type, then wider
 * (over the crosshair), then a little into the stick zone (never over the stick's resting place).
 */
export const GUIDE_FIT_STEPS = ['fit-tight', 'fit-wide', 'fit-lean'] as const;

/**
 * Touch: the card cannot be scrolled (touches pass through it to the look zone), so it
 * steps through GUIDE_FIT_STEPS until nothing is clipped — the long English lines or a
 * narrow phone get the tighter / wider layouts, 844×390 in Chinese keeps the default one
 * right of the crosshair. Returns the steps applied.
 */
export function fitGuideCard(card: HTMLElement): string[] {
  for (const c of GUIDE_FIT_STEPS) card.classList.remove(c);
  const applied: string[] = [];
  for (const c of GUIDE_FIT_STEPS) {
    // reading scrollHeight lays the card out: one short burst when it appears (or the screen turns)
    if (card.scrollHeight <= card.clientHeight + 1) break;
    card.classList.add(c);
    applied.push(c);
  }
  return applied;
}
