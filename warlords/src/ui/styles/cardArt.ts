// Painted card / icon art (src/ui/cardArt.ts, artIcons.ts): identity cards, card /
// armor / mount emblems, ability icons, weapon renders. Every rule is keyed to a
// class that only exists when the art ships — `.sg-art` (the art span), `.art-on`
// (a host showing art), `.sg-rcard` (a painted identity card), `.front.art`,
// `.pm-role` — so without art the procedural look is untouched. The few empty art
// slots some screens always keep (`.ab-ico`, `.wc-art`, `.ip-art`) are hidden.
const u = (n: number): string => `calc(var(--u) * ${n})`;

export const CARD_ART_CSS = /* css */ `
/* ── the art span ──────────────────────────────────────── */
.sg-art { position: relative; display: block; flex: none; overflow: hidden; pointer-events: none; user-select: none; -webkit-user-select: none; }
/* until its picture has loaded the span keeps its size but paints nothing (its host keeps the glyph: artIcons.ts) */
.sg-art:not(.ready) { visibility: hidden; }
.sg-art img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* round emblems: the ink circle stops short of the file's edge (white corners on some) — mask and crop in */
.sg-art.disc { border-radius: 50%; aspect-ratio: 1; background: #140d08; }
.sg-art.disc img { transform: scale(1.1); }
/* weapon renders: black cut out on a canvas (the raw file + lighten if that failed) */
.sg-art.weapon { aspect-ratio: 16 / 9; overflow: visible; }
.sg-art.weapon img { object-fit: contain; }
.sg-art.weapon img:not([src]) { visibility: hidden; }
.sg-art.weapon.blend img { mix-blend-mode: lighten; }
.sg-art.card { aspect-ratio: 3 / 4; background: #1a120c; }
.sg-art.card img { object-position: 50% 28%; }

/* small painted identity card (role reminders / reveals); height set per place */
.sg-rcard { --rc: #d6ad52; position: relative; display: inline-block; flex: none; height: 2em; aspect-ratio: 3 / 4; border-radius: 0.14em; overflow: hidden; vertical-align: middle; background: #1a120c; box-shadow: 0 0 0 1.5px var(--rc), 0 0 0 2.5px rgba(20, 12, 6, 0.85), 0 2px 5px rgba(0, 0, 0, 0.45); }
.sg-rcard > .sg-art { position: absolute; inset: 0; width: 100%; height: 100%; aspect-ratio: auto; }

/* ── identity reveal: the painted front of the flip card ── */
.flip-card .front.art { background: #140d08; }
.flip-card .front.art > .sg-art { position: absolute; inset: 0; width: 100%; height: 100%; aspect-ratio: auto; }
.flip-card .front.art .frame { justify-content: flex-end; gap: 0; padding: 0 0.4em 0.75em; border: 1.5px solid color-mix(in srgb, var(--rc) 70%, #f5dc98 30%); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.55); background: linear-gradient(180deg, rgba(10, 6, 3, 0.35) 0%, transparent 16%, transparent 58%, rgba(10, 6, 3, 0.82) 84%, rgba(10, 6, 3, 0.92) 100%); }
.flip-card .front.art .frame > .sg-seal { position: absolute; left: 0.45em; top: 0.45em; }
.flip-card .front.art .rbanner { display: flex; flex-direction: column; align-items: center; gap: 0.15em; }
.flip-card .front.art .rname { color: var(--rc); text-shadow: 0 2px 0 #000, 0 0 10px rgba(0, 0, 0, 0.95), 0 0 22px color-mix(in srgb, var(--rc) 45%, transparent); }
.flip-card .front.art .faction { color: rgba(250, 238, 212, 0.85); text-shadow: 0 1px 2px #000; }

/* role reminders / reveals (the card has no text baseline: centre the cell like the face avatars) */
.role-cell:has(.sg-rcard) { vertical-align: middle; }
.role-chip .rc-card { height: ${u(52)}; font-size: inherit; }
.hud-scoreboard .role-cell .sb-card { height: 2.05em; margin: -0.3em 0.1em; }
.over-table .role-cell .go-card { height: 2.3em; margin: -0.35em 0.1em; }
.role-row .help-card { height: 5.4em; border-radius: 4px; }

/* pause: your identity card and goal */
.pm-role { display: flex; align-items: center; gap: 0.8em; margin-top: -0.2em; padding: 0.45em 0.6em; border-radius: 6px; background: rgba(40, 28, 16, 0.07); border: 1px solid rgba(140, 106, 38, 0.35); }
.pm-role .pm-rcard { height: 5em; border-radius: 4px; }
.pm-rtext { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.pm-rtext .yr { font-size: 0.75em; color: var(--paper-mute); letter-spacing: 0.15em; }
.pm-rtext b { font-family: var(--font-display); font-size: 1.3em; font-weight: 900; color: var(--ri, var(--paper-ink)); letter-spacing: 0.08em; }
.pm-rtext .goal { font-size: 0.82em; color: var(--paper-ink); }
@media (max-height: 500px) {
  .pm-role { padding: 0.25em 0.5em; margin-top: 0; }
  .pm-role .pm-rcard { height: 3.2em; }
  .pm-rtext .goal { display: none; }
}

/* ── HUD: ability buttons ──────────────────────────────── */
.hud-abilities .ico > .sg-art { position: absolute; inset: 0; width: 100%; height: 100%; }
.hud-abilities .ico.art-on .g { visibility: hidden; }
.hud-abilities .ico.art-on .cdnum { text-shadow: 0 0 3px #000, 0 1px 2px #000, 0 0 10px rgba(0, 0, 0, 0.9); }
/* on cooldown: greyed and darkened under the sweep; silenced / stunned: fully grey under 默 */
.hud-abilities .cooling .ico.art-on > .sg-art { filter: grayscale(0.8) brightness(0.72); }
.hud-abilities.silenced .ab:not(.slot-passive) .ico.art-on > .sg-art { filter: grayscale(1) brightness(0.42); }
.hud-abilities.silenced .ab:not(.slot-passive) .ico.art-on::after { background: rgba(60, 20, 80, 0.45); }

/* ── HUD: item cards ───────────────────────────────────── */
.hud-abilities .item .card > .sg-art { position: absolute; left: 50%; top: ${u(4)}; width: ${u(38)}; transform: translateX(-50%); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ic, #999) 65%, #000 25%), 0 1px 3px rgba(0, 0, 0, 0.45); }
.hud-abilities .item .card.art-on .g { visibility: hidden; }

/* armor / mount chips */
.v-gear .gchip:has(> .gc-ico) { display: inline-flex; align-items: center; gap: ${u(4)}; padding-left: ${u(2)}; }
.v-gear .gchip > .gc-ico { width: 1.45em; margin: -0.25em 0; box-shadow: 0 0 0 1px var(--gc); }

/* ── HUD: weapon panel ─────────────────────────────────── */
.w-main:has(> .w-art) { position: relative; min-width: ${u(340)}; padding-left: ${u(168)}; }
.w-main > .w-art { position: absolute; left: ${u(6)}; top: 50%; width: ${u(158)}; transform: translateY(-50%); filter: drop-shadow(0 ${u(2)} ${u(3)} rgba(0, 0, 0, 0.7)); }
.wslot .k { order: 0; }
.wslot > .ws-art { order: 1; width: ${u(40)}; margin: ${u(-5)} 0; }
.wslot .n { order: 2; }
.sg-hud.touch .w-main:has(> .w-art) { min-width: 0; padding-left: ${u(118)}; }
.sg-hud.touch .w-main > .w-art { width: ${u(108)}; }

/* ── HUD: prompts, loot popups, kill feed ──────────────── */
.hud-interact .ip-art:not(:has(> .sg-art)) { display: none; }
.hud-interact .ip-art { flex: none; width: ${u(34)}; margin: ${u(-5)} 0; }
.hud-interact .ip-art.weapon { width: ${u(70)}; margin: ${u(-10)} 0; }
.hud-interact .ip-art > .sg-art { width: 100%; }
.hud-interact .ip-art > .sg-art.disc { box-shadow: 0 0 0 1px var(--hud-line); }
.ann-info .line.has-art { display: inline-grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: ${u(10)}; text-align: left; }
.ann-info .line.has-art .ann-art { grid-row: 1 / span 2; }
.ann-info .line.has-art.has-sub { align-items: center; }
.ann-info .line.has-art :is(.main, .sub) { grid-column: 2; }
.ann-art { display: inline-flex; align-items: center; gap: ${u(8)}; }
.ann-art .ann-ico.disc { width: ${u(36)}; box-shadow: 0 0 0 1px var(--hud-line); }
.ann-art .ann-ico.weapon { width: ${u(72)}; }
.ann-big .msg .ann-art { margin-top: ${u(6)}; gap: ${u(12)}; }
.ann-big .msg .ann-art .ann-ico.disc { width: ${u(46)}; }
.ann-big .msg .ann-art .ann-ico.weapon { width: ${u(96)}; }
.kf .kf-how { flex: none; }
.kf .kf-how.disc { width: ${u(22)}; box-shadow: 0 0 0 1px rgba(214, 173, 82, 0.6); }
.kf .kf-how.weapon { width: ${u(42)}; margin: ${u(-6)} 0; }
/* the glyphs make lines longer: names shorten (ellipsis) before a line reaches the zone banner */
@media (min-width: 901px) { .hud-feed:has(.kf-how) { max-width: min(${u(560)}, 44vw, calc(50vw - ${u(250)} - ${u(130)})); } }

/* ── touch buttons ─────────────────────────────────────── */
.sg-touch .tbtn.ab > .tb-art { position: absolute; inset: 0; width: 100%; height: 100%; }
.sg-touch .tbtn.ab.art-on .l { visibility: hidden; }
.sg-touch .tbtn.ab.art-on .k { opacity: 1; text-shadow: 0 0 3px #000, 0 1px 2px #000; }
.sg-touch .tbtn.ab.cooling > .tb-art { filter: grayscale(0.8) brightness(0.72); }
.sg-touch .tbtn.ab.down > .tb-art { filter: brightness(1.3); }
.sg-touch .item.art-on { justify-content: flex-end; padding-bottom: 1px; }
.sg-touch .item > .tb-art { position: absolute; left: 50%; top: 7%; width: 82%; transform: translateX(-50%); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ic, #999) 65%, #000 25%); }
.sg-touch .item.art-on .g { display: none; }
.sg-touch .item.art-on :is(.k, .c) { z-index: 1; }
.sg-touch .item.art-on .k { color: #f5ead0; text-shadow: 0 0 2px #000, 0 1px 2px #000; }

/* ── card glyph tiles (玩法说明 tables, 锦囊说明, long-press card info) ── */
.item-glyph.art-on { position: relative; width: 2.5em; height: 2.5em; border: 0; border-radius: 50%; color: transparent; text-shadow: none; background: #140d08; box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ic) 70%, #3a2a14 30%), 0 1px 3px rgba(0, 0, 0, 0.4); }
.item-glyph > .sg-art { position: absolute; inset: 0; width: 100%; height: 100%; }
.pc-card .item-glyph.art-on { width: 2.3em; height: 2.3em; }

/* 玩法说明 weapon table: the render above the name */
.sg-table.weapons .wt-art { width: 7.4em; margin: -0.3em 0 0.1em -0.2em; filter: drop-shadow(0 1px 1px rgba(40, 25, 10, 0.35)); }

/* ── hero detail: skill icons, signature weapon render ─── */
/* the art's room is kept while the file loads (lazy): the layout never jumps when it arrives */
.sg-ability > .ab-ico:not(:has(> .sg-art)), .sg-weapon-card > .wc-art:not(:has(> .sg-art)) { display: none; }
/* floated: the name sits beside the icon, the description flows under it at full width (no extra lines) */
.sg-ability:has(> .ab-ico > .sg-art) { display: flow-root; }
.sg-ability > .ab-ico { float: left; width: 2.6em; margin: 0.1em 0.6em 0.1em 0; }
.sg-ability > .ab-ico > .sg-art { width: 100%; box-shadow: 0 0 0 1.5px #c9a04a, 0 1px 3px rgba(0, 0, 0, 0.35); }
.sg-ability.dim > .ab-ico { filter: grayscale(0.8); }
.sg-weapon-card:has(> .wc-art > .sg-art) { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 0.6em; }
.sg-weapon-card > .wc-art { grid-column: 2; grid-row: 1 / span 2; width: 7em; align-self: center; }
.sg-weapon-card > :not(.wc-art) { grid-column: 1; }
.sg-weapon-card > .wc-desc { grid-column: 1 / -1; }
@media (max-height: 520px) and (min-aspect-ratio: 4/3) {
  .sg-select .sg-ability > .ab-ico { width: 2em; margin-right: 0.45em; }
  .sg-select .sg-weapon-card > .wc-art { width: 5.2em; }
}
`;
