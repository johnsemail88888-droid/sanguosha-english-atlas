// Audio Lab dev page (audio-dev.html): buttons for every sound, music and
// loop, a positional test rig, a live firefight simulation through the real
// event router, and offline render checks. Exposes `window.__audioDev`.
import { forwardFromYaw } from '../core/math';
import type { Vec3 } from '../core/math';
import type { GameEvent, ViewEntity } from '../core/types';
import { VF_FIRING, VF_OPENED, VF_RELOADING } from '../core/types';
import { settings } from '../game/settings';
import type { Quality } from '../game/settings';
import { SFX, SFX_NAMES } from './catalog';
import type { SfxName } from './catalog';
import { audio } from './index';
import { MUSIC_TRACKS } from './music';
import type { MusicTrack } from './music';
import { LOOP_NAMES } from './recipes/loops';
import type { LoopName } from './recipes/loops';
import { UI_SOUNDS } from './recipes/ui';
import type { UiSound } from './recipes/ui';
import { analyze, bakedBank, fakeView, renderCalibration, renderLoop, renderMusic, renderOffline, renderScenario, renderSfx, SCENARIOS } from './render';
import type { RenderStats, Scenario } from './render';

declare global {
  interface Window {
    __audioDev?: typeof devApi;
  }
}

const app = document.getElementById('app') as HTMLElement;
const stateEl = document.getElementById('state') as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function section(title: string, wide = false): HTMLElement {
  const s = el('section', wide ? { class: 'wide' } : {});
  s.appendChild(el('h2', {}, title));
  app.appendChild(s);
  return s;
}

function button(parent: HTMLElement, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls ? { class: cls } : {}, label);
  b.addEventListener('click', () => {
    void audio.unlock().then(onClick);
  });
  parent.appendChild(b);
  return b;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, fmt = (v: number) => v.toFixed(2)): HTMLInputElement {
  const l = el('label');
  l.appendChild(el('span', {}, label));
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('output', {}, fmt(value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  l.append(input, out);
  parent.appendChild(l);
  return input;
}

// ── Listener + positional rig ────────────────────────────────────────────────
const LISTENER: Vec3 = { x: 0, y: 1.6, z: 0 };
let rigDist = 0;
let rigAzimuth = 0;

function rigPos(): Vec3 | undefined {
  if (rigDist <= 0.01) return undefined;
  // azimuth 0 = straight ahead (-Z), positive = to the right
  const a = (rigAzimuth * Math.PI) / 180;
  const f = forwardFromYaw(-a);
  return { x: LISTENER.x + f.x * rigDist, y: LISTENER.y, z: LISTENER.z + f.z * rigDist };
}

function playAtRig(name: SfxName, variant: string): void {
  const pos = rigPos();
  const d = SFX[name];
  if (name === 'ui') {
    audio.ui(variant as UiSound);
    return;
  }
  if (name === 'plane') {
    const p = pos ?? { x: 0, y: 0, z: -40 };
    audio.play('plane', { path: { from: { x: p.x - 420, y: 110, z: p.z }, to: { x: p.x + 420, y: 110, z: p.z }, duration: 9 } });
    return;
  }
  audio.play(name, { variant, pos: d.bus === 'world' ? pos : undefined, local: !pos, size: name === 'explosion' ? 1.4 : 1 });
}

// ── Header ───────────────────────────────────────────────────────────────────
document.getElementById('unlock')?.addEventListener('click', () => {
  void audio.unlock().then(() => {
    audio.setListener(LISTENER, 0, 0);
  });
});

setInterval(() => {
  const s = audio.stats();
  stateEl.textContent = `audio: ${s.state} · voices ${s.voices} · loops ${s.loops} · music ${s.music ?? '—'} · heat ${s.heat.toFixed(2)} · baked ${s.baked} (${s.bakedMB.toFixed(1)} MB)`;
}, 250);

// ── Mixer ────────────────────────────────────────────────────────────────────
{
  const s = section('调音 Mixer');
  const cur = settings.get();
  slider(s, 'Master', 0, 1, 0.01, cur.masterVolume, (v) => settings.update({ masterVolume: v }));
  slider(s, 'Music', 0, 1, 0.01, cur.musicVolume, (v) => settings.update({ musicVolume: v }));
  slider(s, 'SFX', 0, 1, 0.01, cur.sfxVolume, (v) => settings.update({ sfxVolume: v }));
  const l = el('label');
  l.appendChild(el('span', {}, 'Quality'));
  const sel = el('select');
  for (const q of ['low', 'medium', 'high'] as Quality[]) {
    const o = el('option', { value: q }, q);
    if (q === cur.quality) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => settings.update({ quality: sel.value as Quality }));
  l.appendChild(sel);
  s.appendChild(l);
  const vl = el('label');
  vl.appendChild(el('span', {}, 'Voice lines'));
  const cb = el('input', { type: 'checkbox' });
  cb.checked = cur.voiceLines;
  cb.addEventListener('change', () => settings.update({ voiceLines: cb.checked }));
  vl.appendChild(cb);
  s.appendChild(vl);
  s.appendChild(el('p', { class: 'note' }, 'HRTF panning on "high", equal-power otherwise; "low" disables reverb and caps voices at 20.'));
}

// ── Music ────────────────────────────────────────────────────────────────────
{
  const s = section('乐曲 Music');
  const row = el('div');
  for (const t of MUSIC_TRACKS) button(row, t, () => audio.music(t as MusicTrack));
  button(row, 'stop', () => audio.music(null));
  s.appendChild(row);
  slider(s, 'Intensity', 0, 1, 0.01, 0, (v) => audio.setIntensity(v));
  const row2 = el('div');
  let downed = false;
  const db = button(row2, '濒死 Downed: off', () => {
    downed = !downed;
    audio.setDowned(downed);
    db.textContent = `濒死 Downed: ${downed ? 'on' : 'off'}`;
    db.classList.toggle('on', downed);
  });
  s.appendChild(row2);
  s.appendChild(el('p', { class: 'note' }, 'Battle layers: drums + pad → bass (0.3) → 古筝 arps (0.4) → 二胡 lead (0.55) → 唢呐 doubling (0.8). Nearby combat adds "heat" on top.'));
}

// ── Positional rig ───────────────────────────────────────────────────────────
{
  const s = section('方位 Positional rig');
  slider(s, 'Distance (m)', 0, 250, 1, 0, (v) => (rigDist = v), (v) => (v <= 0 ? 'local' : `${v.toFixed(0)} m`));
  slider(s, 'Azimuth (°)', -180, 180, 5, 0, (v) => (rigAzimuth = v), (v) => `${v.toFixed(0)}°`);
  s.appendChild(el('p', { class: 'note' }, 'Distance 0 plays sounds as the local player (non-positional). Listener faces −Z; positive azimuth is to the right. World sounds below use this position.'));
  const row = el('div');
  button(row, 'Orbit rifle', () => {
    for (let i = 0; i < 16; i++) {
      setTimeout(() => {
        const a = (i / 16) * Math.PI * 2;
        audio.play('gun', { variant: 'rifle', pos: { x: Math.sin(a) * 15, y: 1.6, z: -Math.cos(a) * 15 } });
      }, i * 180);
    }
  });
  button(row, 'Distance sweep', () => {
    [5, 20, 50, 100, 170, 240].forEach((d, i) => setTimeout(() => audio.play('gun', { variant: 'sniper', pos: { x: 0, y: 1.6, z: -d } }), i * 900));
  });
  s.appendChild(row);
}

// ── SFX catalog ──────────────────────────────────────────────────────────────
{
  const s = section('音效 Sound effects', true);
  const singles = SFX_NAMES.filter((n) => n !== 'ui' && !SFX[n].variants);
  const h = el('h3', {}, 'single sounds');
  s.appendChild(h);
  const singleRow = el('div');
  for (const name of singles) button(singleRow, name, () => playAtRig(name, ''));
  s.appendChild(singleRow);
  for (const name of SFX_NAMES) {
    if (name === 'ui' || !SFX[name].variants) continue;
    const d = SFX[name];
    s.appendChild(el('h3', {}, name));
    const row = el('div');
    const variants: readonly string[] = d.variants ?? [''];
    for (const v of variants) {
      const b = button(row, v || name, () => playAtRig(name, v));
      if (name === 'abilityCast') b.classList.add(`k-${v}`);
    }
    if (name === 'abilityCast') {
      button(row, 'shu lord (G)', () => audio.play('abilityCast', { variant: 'shu', size: 1.5 }));
      for (const f of ['thunder', 'fire', 'guqin', 'summon', 'shout', 'dash', 'heal']) {
        button(row, `wei+${f}`, () => audio.play('abilityCast', { variant: 'wei', flavor: f, pos: rigPos() }));
      }
    }
    if (name === 'gun') {
      button(row, 'rifle ice', () => audio.play('gun', { variant: 'rifle', flavor: 'ice', pos: rigPos(), local: !rigPos() }));
      button(row, 'auto burst', () => {
        for (let i = 0; i < 10; i++) setTimeout(() => audio.localFire('qinglong'), i * 110);
      });
    }
    s.appendChild(row);
  }
}

// ── UI ───────────────────────────────────────────────────────────────────────
{
  const s = section('界面 UI');
  const row = el('div');
  for (const u of UI_SOUNDS) {
    const b = el('button', {}, u);
    b.addEventListener('mouseenter', () => audio.ui('hover'));
    b.addEventListener('click', () => void audio.unlock().then(() => audio.ui(u)));
    row.appendChild(b);
  }
  s.appendChild(row);
  const l = el('label');
  const input = el('input', { type: 'text', value: '关羽在此，尔等受死！' });
  l.appendChild(input);
  s.appendChild(l);
  button(s, '语音 Speak (zh-CN)', () => audio.speak(input.value));
}

// ── Loops ────────────────────────────────────────────────────────────────────
const activeLoops = new Map<LoopName, ReturnType<typeof setInterval>>();
{
  const s = section('循环 Loops');
  const row = el('div');
  for (const name of LOOP_NAMES) {
    const b = button(row, name, () => {
      const t = activeLoops.get(name);
      if (t) {
        clearInterval(t);
        activeLoops.delete(name);
        b.classList.remove('on');
        return;
      }
      b.classList.add('on');
      activeLoops.set(
        name,
        setInterval(() => audio.loop(`dev:${name}`, name, { pos: rigPos(), keepAlive: 0.3 }), 100),
      );
    });
  }
  s.appendChild(row);
  s.appendChild(el('p', { class: 'note' }, 'Loops follow the positional rig; they fade out ~0.3 s after being toggled off.'));
}

// ── Live simulation through the real router ──────────────────────────────────
function simulateFirefight(seconds: number, withMusic: boolean): void {
  const weapons = ['qinglong', 'pistol', 'smg', 'zhangba', 'qilin', 'fangtian', 'huben', 'liegong', 'zhuque'];
  const ents: ViewEntity[] = weapons.map((w, i) => {
    const a = (i / weapons.length) * Math.PI * 2;
    const r = 8 + i * 7;
    return { id: i + 1, kind: 'hero', sub: 'guanyu', x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0, weapon: w };
  });
  ents.push({ id: 50, kind: 'crate', sub: '2', x: 4, y: 0, z: -4, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 });
  ents.push({ id: 60, kind: 'hazard', sub: 'fire', x: -6, y: 0, z: -3, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0, radius: 4 });
  const view = fakeView(ents, 1);
  if (withMusic) {
    audio.music('battle');
    audio.setIntensity(0.6);
  }
  audio.setListener(LISTENER, 0, 0);
  const t0 = performance.now();
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    const t = (performance.now() - t0) / 1000;
    const events: GameEvent[] = [];
    ents.forEach((e, i) => {
      if (e.kind !== 'hero') return;
      e.speed = i % 3 === 0 ? 4.5 : 0;
      e.x += e.speed * 0.033 * 0.3;
      const rate = [9, 4, 12, 1.2, 0.6, 0.8, 11, 1, 15][i];
      const firing = i === 8 && t % 3 < 1.5;
      e.flags = (firing ? VF_FIRING : 0) | (i === 1 && t % 4 > 3 ? VF_RELOADING : 0);
      if (i > 0 && Math.random() < rate / 30) {
        events.push({ t: 'shot', src: e.id, weapon: e.weapon ?? 'carbine', from: { x: e.x, y: 1.4, z: e.z }, to: { x: Math.random() * 3 - 1.5, y: 1.2, z: Math.random() * 3 - 1.5 } });
      }
    });
    if (frame % 25 === 0) events.push({ t: 'hit', target: 3, src: 1, amount: 35, dtype: 'normal', pos: { x: ents[2].x, y: 1.4, z: ents[2].z }, head: frame % 50 === 0 });
    if (frame % 70 === 20) events.push({ t: 'explosion', pos: { x: 10, y: 0, z: -12 }, radius: 6, kind: frame % 140 === 20 ? 'fire' : 'rocket' });
    if (frame === 40) ents[9].flags |= VF_OPENED;
    if (frame % 90 === 45) events.push({ t: 'ability', src: 4, ability: 'zhangfei_paoxiao' });
    if (frame % 8 === 0) audio.localFire('qinglong');
    audio.handleEvents(events, view);
    if (t > seconds) {
      clearInterval(timer);
      if (withMusic) audio.setIntensity(0.2);
    }
  }, 33);
}

{
  const s = section('演练 Live simulation');
  button(s, 'Firefight 6 s (router)', () => simulateFirefight(6, false));
  button(s, 'Firefight + battle music', () => simulateFirefight(10, true));
  button(s, 'Airdrop event', () => {
    const view = fakeView([], null);
    audio.setListener(LISTENER, 0, 0);
    audio.handleEvents([{ t: 'airdrop', pos: { x: 30, y: 0, z: -60 }, id: 777 }], view);
    const t0 = performance.now();
    const tm = setInterval(() => {
      audio.handleEvents([], view);
      if (performance.now() - t0 > 14000) clearInterval(tm);
    }, 50);
  });
  button(s, 'Tesla volley + arcs (router)', () => {
    // 张角 fires; the sim reports each chain jump as an extra shot from the previous victim
    const zj: ViewEntity = { id: 30, kind: 'hero', sub: 'zhangjiao', x: -12, y: 0, z: -10, yaw: 0, pitch: 0, speed: 0, hp: 300, maxHp: 300, shield: 0, flags: 0, weapon: 'taiping' };
    const v1: ViewEntity = { ...zj, id: 31, sub: 'guanyu', x: 2, z: -14, weapon: 'qinglong' };
    const v2: ViewEntity = { ...v1, id: 32, x: 6, z: -9 };
    const v3: ViewEntity = { ...v1, id: 33, x: 9, z: -4 };
    audio.setListener(LISTENER, 0, 0);
    audio.handleEvents(
      [
        { t: 'shot', src: 30, weapon: 'taiping', from: { x: -12, y: 1.6, z: -10 }, to: { x: 2, y: 1.3, z: -14 }, hit: 31 },
        { t: 'shot', src: 30, weapon: 'taiping', from: { x: 2, y: 0.9, z: -14 }, to: { x: 6, y: 0.9, z: -9 }, hit: 32 },
        { t: 'shot', src: 30, weapon: 'taiping', from: { x: 6, y: 0.9, z: -9 }, to: { x: 9, y: 0.9, z: -4 }, hit: 33 },
      ],
      fakeView([zj, v1, v2, v3], 1),
    );
  });
  button(s, 'Crate open (sim event, bronze)', () => {
    const crate: ViewEntity = { id: 40, kind: 'crate', sub: '2', x: 3, y: 0, z: -5, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 };
    audio.setListener(LISTENER, 0, 0);
    audio.handleEvents([{ t: 'sfx', name: 'crateOpen', pos: { x: 3, y: 0, z: -5 } }], fakeView([crate], null));
  });
  button(s, 'Shield hum 3 s (local)', () => {
    const me: ViewEntity = { id: 1, kind: 'hero', sub: 'zhaoyun', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 80, flags: 0 };
    const view = fakeView([me], 1);
    const t0 = performance.now();
    const tm = setInterval(() => {
      audio.handleEvents([], view);
      if (performance.now() - t0 > 3000) clearInterval(tm);
    }, 50);
  });
  button(s, 'Zone phase 2', () => audio.handleEvents([{ t: 'zone', phase: 2, center: { x: 0, y: 0, z: 0 }, radius: 100, targetRadius: 55, shrinkStart: 0, shrinkEnd: 40 }], fakeView([], null)));
  button(s, 'Role reveal', () => audio.ui('reveal'));
  button(s, 'Kill feed: hero death', () => audio.handleEvents([{ t: 'death', target: 5, killer: 1, kind: 'hero' }], fakeView([], 1)));
  s.appendChild(el('p', { class: 'note' }, 'The simulation feeds synthetic GameEvents through audio.handleEvents() with a fake ViewSource, exercising dedupe of local shots, chain-lightning arcs, flybys, impacts, crates, fire loops, shield hums and reloads. Music intensity follows the zone phase automatically (plus nearby combat heat).'));
}

// ── Offline checks ───────────────────────────────────────────────────────────
interface CheckRow {
  label: string;
  stats: RenderStats;
}

async function renderAll(): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const name of SFX_NAMES) {
    const d = SFX[name];
    for (const v of d.variants ?? ['']) {
      if (name === 'plane') continue;
      rows.push({ label: `${name}${v ? ':' + v : ''} local`, stats: await renderSfx(name, { variant: v, local: true, seconds: 2.5 }) });
      if (d.bus === 'world' && (name === 'gun' || name === 'explosion' || name === 'impact')) {
        rows.push({ label: `${name}${v ? ':' + v : ''} @8m`, stats: await renderSfx(name, { variant: v, pos: { x: 3, y: 1.6, z: -7 }, seconds: 2.5 }) });
      }
    }
  }
  rows.push({ label: 'plane flyover', stats: await renderSfx('plane', { path: { from: { x: -300, y: 110, z: -20 }, to: { x: 300, y: 110, z: -20 }, duration: 6 }, seconds: 7 }) });
  for (const l of LOOP_NAMES) rows.push({ label: `loop:${l}`, stats: await renderLoop(l, { pos: { x: 2, y: 1, z: -4 } }, 2) });
  for (const t of MUSIC_TRACKS) rows.push({ label: `music:${t}`, stats: await renderMusic(t, t === 'battle' || t === 'menu' ? 12 : 8, 1) });
  for (const sc of SCENARIOS) rows.push({ label: `scenario:${sc}`, stats: await renderScenario(sc, 4) });
  return rows;
}

{
  const s = section('离线检测 Offline render checks', true);
  const out = el('div');
  button(s, 'Render everything offline', () => {
    out.textContent = 'rendering…';
    void renderAll().then((rows) => {
      const table = el('table');
      table.innerHTML = '<tr><th>sound</th><th>peak dB</th><th>rms dB</th><th>finite</th><th>audible</th></tr>';
      for (const r of rows) {
        const tr = el('tr');
        const bad = r.stats.peak >= 1 || !r.stats.finite || r.stats.silent;
        tr.innerHTML = `<td>${r.label}</td><td class="${r.stats.peak >= 1 ? 'bad' : ''}">${r.stats.peakDb.toFixed(1)}</td><td>${r.stats.rmsDb.toFixed(1)}</td><td class="${r.stats.finite ? '' : 'bad'}">${r.stats.finite}</td><td class="${r.stats.silent ? 'bad' : ''}">${!r.stats.silent}</td>`;
        if (bad) tr.style.background = '#f6d0c8';
        table.appendChild(tr);
      }
      out.textContent = '';
      out.appendChild(table);
    });
  });
  s.appendChild(out);
}

// ── Test/automation hook ─────────────────────────────────────────────────────
const devApi = {
  engine: audio,
  sfxNames: SFX_NAMES,
  variants: (name: SfxName): readonly string[] => SFX[name]?.variants ?? [''],
  loops: LOOP_NAMES,
  tracks: MUSIC_TRACKS,
  scenarios: SCENARIOS,
  renderSfx,
  renderLoop,
  renderMusic,
  renderScenario: (name: Scenario, seconds?: number) => renderScenario(name, seconds),
  /** same scenario, but playing from the baked sample bank (as the live engine does after warm-up) */
  renderScenarioBaked: async (name: Scenario, seconds?: number) => renderScenario(name, seconds, { bank: await bakedBank() }),
  renderMusicBaked: async (track: MusicTrack, seconds: number, intensity?: number) => renderMusic(track, seconds, intensity, { bank: await bakedBank() }),
  bankStats: async () => {
    const b = await bakedBank();
    return { count: b.count, mb: (b.frames * 4) / 1048576 };
  },
  renderCalibration,
  renderAll,
  renderOffline,
  analyze,
  simulateFirefight,
};

window.__audioDev = devApi;
