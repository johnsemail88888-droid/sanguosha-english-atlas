// Hero detail panel shared by 选将 and 武将图鉴: header, 勾玉, abilities with
// key badges, signature weapon, troops, and (gallery) bio / playstyle / quotes.
import type { AbilityDef, HeroDef, WeaponDef } from '../../data/types';
import { HERO_BY_ID, TROOP_BY_ID, WEAPON_BY_ID, WEAPON_CLASS_INFO, isPassiveAbility } from '../../data';
import type { UiCtx } from '../ctx';
import { Bag, appendChildren, h } from '../dom';
import { getLang, heroName, heroTitle, kingdomName, t, tx } from '../i18n';
import { portraitArtPath } from '../art';
import { kingdomColor } from '../theme';
import { difficultyStars, kingdomBadge, magatamaRow } from '../widgets';
import { gearArt } from '../cardArt';
import { abilityArt, setArt } from '../artIcons';

export const SLOT_ORDER: Record<AbilityDef['slot'], number> = { passive: 0, q: 1, e: 2, lord: 3 };
export const SLOT_KEY: Record<AbilityDef['slot'], string> = { passive: '', q: 'Q', e: 'E', lord: 'G' };

export function sortedAbilities(def: HeroDef): AbilityDef[] {
  return [...def.abilities].sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]);
}

export function slotLabel(slot: AbilityDef['slot'], passive = false): string {
  if (slot === 'passive') return t('select.passive');
  if (slot === 'lord') return passive ? `${t('select.lordSkill')} · ${t('select.passive')}` : `G · ${t('select.lordSkill')}`;
  return SLOT_KEY[slot];
}

export function abilityBlock(a: AbilityDef, opts: { dimLord?: boolean } = {}): HTMLElement {
  const meta: string[] = [];
  if (a.cooldown) meta.push(t('select.cooldown', { n: a.cooldown }));
  if (a.charges && a.charges > 1) meta.push(t('select.charges', { n: a.charges }));
  const dim = a.slot === 'lord' && opts.dimLord;
  // the painted skill icon beside the text (an empty, hidden slot without art)
  const ico = h('span', { class: 'ab-ico' });
  setArt(ico, abilityArt(a.id), { lazy: true });
  return h('div', { class: `sg-ability slot-${a.slot}${dim ? ' dim' : ''}` },
    ico,
    h('div', { class: 'ab-head' },
      h('span', { class: `ab-key k-${a.slot}` }, slotLabel(a.slot, isPassiveAbility(a))),
      h('span', { class: 'ab-name' }, tx(a.nameZh, a.nameEn)),
      a.sgsSkill && a.sgsSkill !== a.nameZh ? h('span', { class: 'ab-sgs' }, `〔${a.sgsSkill}〕`) : null,
      meta.length ? h('span', { class: 'ab-meta' }, meta.join(' · ')) : null,
    ),
    h('p', { class: 'ab-desc' }, tx(a.descZh, a.descEn)),
    dim ? h('p', { class: 'ab-note' }, t('select.lordOnly')) : null,
  );
}

const CLASS_NAMES: Record<WeaponDef['class'], [string, string]> = {
  pistol: ['手枪', 'Pistol'],
  smg: ['冲锋枪', 'SMG'],
  rifle: ['步枪', 'Rifle'],
  shotgun: ['霰弹枪', 'Shotgun'],
  dmr: ['精确射手步枪', 'DMR'],
  sniper: ['狙击枪', 'Sniper'],
  lmg: ['轻机枪', 'LMG'],
  launcher: ['发射器', 'Launcher'],
  flamer: ['喷火器', 'Flamethrower'],
  bow: ['弓', 'Bow'],
  crossbow: ['弩', 'Crossbow'],
  melee: ['近战', 'Melee'],
};

export function weaponClassName(c: WeaponDef['class']): string {
  const d = WEAPON_CLASS_INFO?.[c];
  if (d) return tx(d.nameZh, d.nameEn);
  const n = CLASS_NAMES[c];
  return n ? tx(n[0], n[1]) : c;
}

export function weaponBlock(w: WeaponDef): HTMLElement {
  const dmg = w.pellets > 1 ? `${w.damage}×${w.pellets}` : String(w.damage);
  // the painted render beside the stats (an empty, hidden slot without art)
  const art = h('span', { class: 'wc-art' });
  setArt(art, gearArt(w.id), { lazy: true });
  return h('div', { class: 'sg-weapon-card' },
    art,
    h('div', { class: 'wc-head' },
      h('span', { class: 'wc-name' }, tx(w.nameZh, w.nameEn)),
      w.sgsCard ? h('span', { class: 'wc-card' }, `〔${w.sgsCard}〕`) : null,
      h('span', { class: `wc-class rarity-${w.rarity}` }, weaponClassName(w.class)),
    ),
    h('div', { class: 'wc-stats' },
      stat(tx('伤害', 'Damage'), dmg),
      stat(tx('射速', 'Rate'), `${w.fireRate}/s`),
      stat(tx('弹匣', 'Mag'), String(w.magSize)),
      stat(tx('射程', 'Range'), `${w.maxRange}m`),
    ),
    h('p', { class: 'wc-desc' }, tx(w.descZh, w.descEn)),
  );
}

function stat(label: string, value: string): HTMLElement {
  return h('span', { class: 'st' }, h('i', null, label), h('b', null, value));
}

export interface HeroDetailOpts {
  /** show the crown's +1 勾玉 / +100 HP (the Lord, and the 影武者) */
  asLord?: boolean;
  /** dim the lord skill (hero select as anyone but the real Lord) */
  dimLord?: boolean;
  /** gallery extras: bio / playstyle / quotes */
  lore?: boolean;
  /** a 3D turntable or portrait visual at the top */
  visual?: 'turntable' | 'portrait' | 'none';
  /**
   * hero select: the painted face as a medallion in place of the kingdom badge (only
   * when the art ships). Same footprint as the header, so the abilities keep their room.
   */
  medallion?: boolean;
}

export function heroDetail(ctx: UiCtx, heroId: string, opts: HeroDetailOpts = {}): { el: HTMLElement; dispose(): void } {
  const bag = new Bag();
  const def = HERO_BY_ID[heroId];
  const el = h('div', { class: 'sg-hero-detail', data: { hero: heroId } });
  if (!def) {
    el.appendChild(h('p', null, heroId));
    return { el, dispose: () => bag.dispose() };
  }
  el.style.setProperty('--kc', kingdomColor(def.kingdom));

  const art = ctx.portraits.hasArt(heroId);
  if (opts.visual && opts.visual !== 'none') {
    const vis = h('div', { class: 'hd-visual' });
    let mounted = false;
    if (opts.visual === 'turntable' && ctx.deps.mountHeroTurntable) {
      // painted portrait beside the 3D model when the art ships
      const stage = art ? h('div', { class: 'hd-stage' }) : vis;
      try {
        const tt = ctx.deps.mountHeroTurntable(stage, heroId);
        bag.add(() => tt.dispose());
        mounted = true;
      } catch (err) {
        console.warn('[ui] turntable failed', err);
      }
      if (mounted && art) {
        vis.classList.add('duo');
        // the model stands on a blurred copy of its own painting
        stage.style.setProperty('--art', `url("${portraitArtPath(heroId)}")`);
        vis.append(h('div', { class: 'hd-paint' }, ctx.portraits.layer(heroId, 512, 'full')), stage);
      }
    }
    if (!mounted) {
      if (art) vis.classList.add('paint');
      vis.appendChild(ctx.portraits.layer(heroId, 512, 'bust'));
    }
    el.appendChild(vis);
  }

  let badge = kingdomBadge(def.kingdom, '2.4em');
  if (opts.medallion && !opts.visual) {
    // painted face with the kingdom seal on its rim; the plain badge without art
    const medal = (): HTMLElement => h('span', { class: 'hd-medal' }, ctx.portraits.avatar(heroId, 'hd-ava'), kingdomBadge(def.kingdom));
    if (art) badge = medal();
    // art listing still loading (first screen of a deep link): swap once it is known
    else if (ctx.portraits.artState(heroId) === null) {
      const plain = badge;
      void ctx.portraits.whenKnown().then(() => !bag.isDisposed && ctx.portraits.hasArt(heroId) && plain.replaceWith(medal()));
    }
  }

  const weapon = WEAPON_BY_ID[def.signatureWeapon];
  const troop = TROOP_BY_ID[def.troopType];
  appendChildren(el,
    h('div', { class: 'hd-head' },
      badge,
      h('div', { class: 'hd-names' },
        h('div', { class: 'hd-name' }, heroName(heroId), h('span', { class: 'hd-title' }, heroTitle(heroId))),
        h('div', { class: 'hd-meta' },
          magatamaRow(def.sgsHp, opts.asLord ? 1 : 0),
          h('span', { class: 'sg-mute' }, `${def.maxHp + (opts.asLord ? 100 : 0)} ${t('common.hp')}`),
          h('span', { class: 'sep' }),
          h('span', { class: 'sg-mute' }, kingdomName(def.kingdom)),
          h('span', { class: 'sg-mute' }, t(def.gender === 'female' ? 'gallery.gender.female' : 'gallery.gender.male')),
          h('span', { class: 'sep' }),
          h('span', { class: 'sg-mute' }, t('common.difficulty')),
          difficultyStars(def.difficulty),
          def.lordCandidate ? h('span', { class: 'sg-chip lordc' }, '♛ ', t('gallery.lordCandidate')) : null,
        ),
      ),
    ),
    h('div', { class: 'hd-abilities' }, sortedAbilities(def).map((a) => abilityBlock(a, { dimLord: opts.dimLord }))),
    h('div', { class: 'hd-gear' },
      weapon ? h('div', { class: 'hd-sec' }, h('h4', null, t('select.signature')), weaponBlock(weapon)) : null,
      troop
        ? h('div', { class: 'hd-sec' }, h('h4', null, t('select.troops')),
            h('div', { class: 'hd-troop' }, h('b', null, tx(troop.nameZh, troop.nameEn)), h('span', { class: 'sg-mute' }, ` · ${troop.hp} ${t('common.hp')}${def.troopBonus ? tx(` · 兵力 +${def.troopBonus}`, ` · squad +${def.troopBonus}`) : ''}`)))
        : null,
    ),
  );

  if (opts.lore) {
    appendChildren(el,
      h('div', { class: 'hd-sec' }, h('h4', null, t('gallery.playstyle')), h('p', null, tx(def.playstyleZh, def.playstyleEn))),
      h('div', { class: 'hd-sec' }, h('h4', null, t('gallery.bio')), h('p', null, tx(def.bioZh, def.bioEn))),
      def.quotesZh.length
        ? h('div', { class: 'hd-sec' }, h('h4', null, t('gallery.quotes')),
            h('ul', { class: 'hd-quotes' }, def.quotesZh.map((q, i) => {
              const en = def.quotesEn?.[i];
              return h('li', null, `「${q}」`, getLang() === 'en' && en ? h('span', { class: 'en' }, en) : null);
            })))
        : null,
    );
  }
  return { el, dispose: () => bag.dispose() };
}
