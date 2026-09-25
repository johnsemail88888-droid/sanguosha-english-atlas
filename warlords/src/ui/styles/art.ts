// Painted-art presentation: portrait crops, face avatars, full-bleed key art
// (title, menu backdrop, match loading), hero detail medallion. Every rule is keyed
// to a class that only exists when the art ships (`.portrait.art`, `.sg-ava`,
// `.sg-art-bg`, `.has-art`, `.menu-art`, `.sg-loading.art`, `.hd-medal`,
// `.duo`), so without art the procedural look is untouched.
const u = (n: number): string => `calc(var(--u) * ${n})`;

const MENU_SCREENS = ['single', 'online', 'lobby', 'roles', 'heroSelect', 'gallery', 'help'].map((s) => `[data-active-screen="${s}"]`).join(', ');

export const ART_CSS = /* css */ `
/* ── portraits ─────────────────────────────────────────── */
.portrait img.art { position: absolute; max-width: none; object-fit: cover; }
.portrait img.art.fade { opacity: 0; transition: opacity 0.3s ease-out; }
.portrait img.art.fade.on { opacity: 1; }
/* painted cards: a left fade keeps the vertical name legible over busy art */
.sg-hcard .portrait.art ~ .shade { background: linear-gradient(90deg, rgba(0, 0, 0, 0.42) 0%, transparent 34%), linear-gradient(180deg, rgba(0, 0, 0, 0.5) 0%, transparent 19%, transparent 56%, rgba(0, 0, 0, 0.86) 100%); }
.sg-hcard .portrait.art .ph { color: rgba(255, 245, 220, 0.14); }

/* round face avatar in a kingdom + gold ring */
.sg-ava {
  --kc: var(--qun);
  --sz: 1.8em;
  position: relative;
  flex: none;
  display: inline-block;
  width: var(--sz);
  height: var(--sz);
  border-radius: 50%;
  overflow: hidden;
  vertical-align: middle;
  isolation: isolate;
  background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--kc) 55%, #fff 20%), color-mix(in srgb, var(--kc) 60%, #000 40%));
  box-shadow: 0 0 0 1.5px var(--kc), 0 0 0 2.5px #e2bd68, 0 2px 6px rgba(0, 0, 0, 0.55);
}
.sg-ava .portrait { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; }
.sg-ava .ph { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-weight: 900; font-size: calc(var(--sz) * 0.5); line-height: 1; color: rgba(255, 245, 220, 0.85); text-shadow: none; }
/* the avatar has no text baseline: centre the cell instead of sitting it on the text baseline */
.hero-cell:has(.sg-ava) { vertical-align: middle; }
.hero-cell .sg-ava { width: 2.15em; height: 2.15em; margin: -0.3em 0.05em; }
.over-mvp .mvp-card:has(.portrait.art) { width: 6.8em; box-shadow: 0 0 0 2px var(--gold), 0 0 0 4px rgba(90, 60, 20, 0.5), 0 8px 18px rgba(0, 0, 0, 0.45); }

/* ── full-bleed key art ────────────────────────────────── */
.sg-layer.pass > .sg-art-bg, .sg-art-bg { pointer-events: none; }
.sg-art-bg { position: absolute; inset: 0; overflow: hidden; }
.sg-art-bg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.7s ease-out; user-select: none; }
.sg-art-bg.on img { opacity: 1; }
.sg-art-bg.kb img { animation: sg-kenburns 48s ease-in-out infinite alternate; will-change: transform; }
@keyframes sg-kenburns { from { transform: scale(1.02); } to { transform: scale(1.1) translate3d(-1.3%, -0.9%, 0); } }
@media (prefers-reduced-motion: reduce) { .sg-art-bg.kb img { animation: none; will-change: auto; transform: scale(1.02); } }

/* title */
.sg-title-bghost { position: absolute; inset: 0; pointer-events: none; }
.sg-art-bg.title img { object-position: 50% 38%; }
.sg-title-art .shade {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 38% 44% at 50% 64%, rgba(10, 6, 4, 0.7), rgba(10, 6, 4, 0.35) 62%, transparent 100%),
    radial-gradient(ellipse 46% 30% at 50% 24%, rgba(10, 6, 4, 0.45), transparent 100%),
    linear-gradient(180deg, rgba(8, 5, 3, 0.5) 0%, rgba(8, 5, 3, 0.05) 26%, rgba(8, 5, 3, 0.05) 58%, rgba(8, 5, 3, 0.8) 100%);
}
.sg-title-art .vignette { background: radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0, 0, 0, 0.62) 100%); }
.sg-title.has-art .sg-logo .l1 { filter: drop-shadow(0 3px 0 #3a1a08) drop-shadow(0 0 26px rgba(0, 0, 0, 0.85)) drop-shadow(0 0 18px rgba(240, 150, 60, 0.3)); }
.sg-title.has-art .sg-logo .l2 { text-shadow: 0 2px 0 #2a1208, 0 0 18px rgba(0, 0, 0, 0.95), 0 0 6px rgba(0, 0, 0, 0.9); }
.sg-title.has-art :is(.sg-tagline, .sg-logo .en, .sg-name) { text-shadow: 0 1px 3px #000, 0 0 12px rgba(0, 0, 0, 0.9); }
.sg-title.has-art .sg-title-foot { color: rgba(240, 220, 180, 0.7); }

/* menu screens: blurred, darkened key art behind the parchment */
.sg-art-bg.menu {
  display: none;
  background-color: #120c08;
  background-image: radial-gradient(ellipse at 50% -15%, rgba(190, 120, 50, 0.28), transparent 60%), radial-gradient(ellipse at 50% 125%, rgba(130, 25, 12, 0.4), transparent 60%), linear-gradient(180deg, #1d140d, #0e0906);
}
.sg-root.menu-art:is(${MENU_SCREENS}) .sg-art-bg.menu { display: block; }
.sg-art-bg.menu img { filter: blur(6px) saturate(0.85) brightness(0.5); transform: scale(1.05); }
.sg-art-bg.menu::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 80% 70% at 50% 42%, rgba(14, 9, 6, 0.2), rgba(10, 6, 4, 0.78) 100%), var(--grain); }
.sg-root.menu-art :is(.sg-single, .sg-online, .sg-lobby, .sg-roles, .sg-select, .sg-gallery, .sg-help) {
  background: radial-gradient(ellipse at 50% -15%, rgba(190, 120, 50, 0.16), transparent 60%), linear-gradient(180deg, rgba(14, 9, 6, 0.15), rgba(14, 9, 6, 0.45));
}

/* match loading: kingdom battle scene, content along the bottom */
.sg-loading.art { padding: 0; align-items: flex-end; justify-content: center; background: #0c0806; overflow: hidden; }
.sg-art-bg.loading img { object-position: 50% 35%; }
.sg-art-bg.loading::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(0deg, rgba(8, 5, 3, 0.95) 0%, rgba(8, 5, 3, 0.82) 20%, rgba(8, 5, 3, 0.3) 46%, transparent 64%),
    linear-gradient(90deg, rgba(8, 5, 3, 0.5) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 40%, transparent 55%, rgba(0, 0, 0, 0.5) 100%);
}
.sg-loading.art .load-inner { position: relative; z-index: 1; width: 100%; max-width: 78em; flex-wrap: nowrap; align-items: flex-end; justify-content: flex-start; gap: 2.4em; padding: 2em 3.4em 2.4em; }
.sg-loading.art .load-card { width: clamp(8em, 25vmin, 15em); filter: drop-shadow(0 10px 26px rgba(0, 0, 0, 0.7)); }
.sg-loading.art .load-text { flex: 1 1 auto; max-width: 44em; gap: 0.75em; }
.sg-loading.art .load-hero .nm { font-size: 3.2em; letter-spacing: 0.06em; text-shadow: 0 2px 0 #1a0e06, 0 0 22px rgba(0, 0, 0, 0.9); }
.sg-loading.art .load-hero .ttl { font-size: 1.05em; opacity: 0.85; text-shadow: 0 1px 3px #000; }
.sg-loading.art h1 { font-size: 1.35em; letter-spacing: 0.3em; color: var(--gold); text-shadow: 0 1px 3px #000; margin-top: 0.3em; }
.sg-loading.art .load-stage { text-shadow: 0 1px 2px #000; }
.sg-loading.art .tip { background: rgba(16, 10, 6, 0.72); }
.load-role { display: flex; align-items: center; gap: 0.55em; flex-wrap: wrap; margin-top: -0.2em; text-shadow: 0 1px 3px #000; }
.load-role b { font-family: var(--font-display); font-size: 1.3em; color: var(--gold-hi); letter-spacing: 0.12em; }
.load-role span { color: rgba(250, 238, 212, 0.88); }
@media (max-width: 640px) {
  .sg-loading.art .load-inner { flex-direction: column; align-items: flex-start; gap: 1em; padding: 1.2em 1.2em 1.6em; }
  .sg-loading.art .load-card { width: 7.5em; }
  .sg-loading.art .load-text { width: 100%; }
  .sg-loading.art .load-hero .nm { font-size: 2.4em; }
}
@media (max-height: 520px) {
  .sg-loading.art .load-inner { padding: 1em 1.6em 1.2em; gap: 1.4em; }
  .sg-loading.art .load-hero .nm { font-size: 2.2em; }
  .sg-loading.art .load-text { gap: 0.45em; }
  .sg-loading.art .tip { padding: 0.5em 0.8em; font-size: 0.9em; }
}

/* ── hero detail ───────────────────────────────────────── */
/* hero select: painted face medallion with the kingdom seal on its rim (same footprint as the header) */
/* the margin keeps the rings inside the scrolling .detail-body (which clips at its edges) */
.hd-medal { position: relative; flex: none; display: inline-block; width: 2.9em; height: 2.9em; margin: 5px 0.1em 5px 5px; }
.hd-medal .hd-ava { --sz: 2.9em; display: block; box-shadow: 0 0 0 2px var(--kc), 0 0 0 3.5px #e2bd68, 0 0 0 4.5px rgba(90, 60, 20, 0.45), 0 3px 10px rgba(40, 20, 5, 0.45); }
.hd-medal .sg-kd { --sz: 1.3em; position: absolute; right: -0.3em; bottom: -0.2em; z-index: 1; box-shadow: 0 0 0 1.5px #e9c874, 0 0 0 2.5px rgba(0, 0, 0, 0.45), 0 1px 4px rgba(0, 0, 0, 0.5); }
.hd-visual.paint { background: #1a120c; aspect-ratio: 2 / 1; }
.hd-visual.duo { display: flex; aspect-ratio: 16 / 9; }
.hd-visual.duo .hd-paint { position: relative; flex: none; height: 100%; aspect-ratio: 3 / 4; overflow: hidden; box-shadow: 1px 0 0 var(--gold-lo), 3px 0 12px rgba(0, 0, 0, 0.35); z-index: 1; }
.hd-visual.duo .hd-paint .portrait { position: absolute; inset: 0; }
.hd-visual.duo .hd-stage { position: relative; flex: 1; min-width: 0; overflow: hidden; isolation: isolate; }
.hd-visual.duo .hd-stage::before { content: ''; position: absolute; inset: -24px; z-index: -1; background: var(--art, none) 50% 18% / cover no-repeat; filter: blur(14px) saturate(0.9) brightness(0.62); }
.hd-visual.duo .hd-stage::after { content: ''; position: absolute; inset: 0; z-index: -1; background: radial-gradient(ellipse at 50% 42%, transparent 35%, rgba(10, 6, 4, 0.5) 100%); }

/* pick-strip thumbnails: just the painted face + kingdom badge (the name is printed below) */
.pick .thumb .sg-hcard:has(.portrait.art) :is(.vname, .bottom, .sg-mags, .crown) { display: none; }
.pick .thumb .sg-hcard:has(.portrait.art) .shade { background: linear-gradient(180deg, rgba(0, 0, 0, 0.35), transparent 30%); }
.lord-flash .flash-ava { --sz: 2.1em; margin: -0.3em 0.55em -0.3em 0; }

/* ── HUD ───────────────────────────────────────────────── */
.kf .kf-ava { --sz: ${u(24)}; margin: ${u(3)} ${u(6)} ${u(3)} ${u(2)}; }
.kf .who.has-ava small { margin-left: ${u(5)}; }
.hud-spectate :is(.killer, .target) { display: inline-flex; align-items: center; justify-content: center; gap: ${u(8)}; }
.hud-spectate .face:empty { display: none; }
.hud-spectate .face .sg-ava { --sz: ${u(38)}; }
.hud-spectate .killer .face .sg-ava { --sz: ${u(30)}; }
.hud-killstamp .ks-face:empty { display: none; }
.hud-killstamp .ks-face { order: -1; }
.hud-killstamp .ks-face .sg-ava { --sz: ${u(84)}; box-shadow: 0 0 0 ${u(3)} var(--kc), 0 0 0 ${u(5)} #e2bd68, 0 ${u(4)} ${u(18)} rgba(0, 0, 0, 0.6); }
.hud-killstamp:has(.ks-face .sg-ava) .sg-seal { order: 0; margin: ${u(-38)} 0 0 ${u(66)}; position: relative; z-index: 1; }
`;
