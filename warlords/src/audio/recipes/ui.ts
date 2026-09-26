// Interface sounds: wooden, paper and bell textures to match the
// parchment-and-ink UI. All short, soft-edged and non-fatiguing.
import { midiToFreq } from '../composition';
import { bell, burst, tone, whoosh } from './common';
import { gong, pad, taiko, woodblock } from './instruments';
import type { Recipe } from './types';

export type UiSound = 'click' | 'hover' | 'confirm' | 'back' | 'flip' | 'error' | 'countdown' | 'reveal';

export const UI_SOUNDS: readonly UiSound[] = ['click', 'hover', 'confirm', 'back', 'flip', 'error', 'countdown', 'reveal'];

const chime = (freq: number): { freq: number; ratios: number[]; levels: number[]; decays: number[] } => ({
  freq,
  ratios: [1, 2, 2.76, 4.07],
  levels: [0.7, 0.18, 0.1, 0.04],
  decays: [0.55, 0.3, 0.2, 0.1],
});

export const ui: Recipe = (v, o) => {
  const t = v.t;
  switch (o.variant as UiSound) {
    case 'hover':
      tone(v, { freq: 2100, to: 2300, glide: 0.02, peak: 0.11, attack: 0.002, decay: 0.03 });
      return;
    case 'confirm':
      bell(v, { ...chime(midiToFreq(76)), peak: 0.22, attack: 0.002 });
      bell(v, { ...chime(midiToFreq(81)), start: t + 0.075, peak: 0.24, attack: 0.002 });
      woodblock(v, { vel: 0.35 });
      return;
    case 'back':
      bell(v, { ...chime(midiToFreq(81)), peak: 0.18, attack: 0.002 });
      bell(v, { ...chime(midiToFreq(76)), start: t + 0.07, peak: 0.16, attack: 0.002 });
      return;
    case 'flip':
      whoosh(v, { lo: 900, hi: 4200, dur: 0.16, peak: 0.35, q: 1, color: 'white' });
      burst(v, { type: 'bandpass', freq: 2600, q: 2, start: t + 0.13, peak: 0.3, decay: 0.02 });
      return;
    case 'error':
      for (const dt of [0, 0.11]) {
        const lp = v.filter('lowpass', 900, 1);
        const g = v.gain(0);
        g.gain.setValueAtTime(0, t + dt);
        g.gain.linearRampToValueAtTime(0.14, t + dt + 0.005);
        g.gain.setValueAtTime(0.14, t + dt + 0.06);
        g.gain.linearRampToValueAtTime(0, t + dt + 0.08);
        v.osc('square', 146.8, t + dt, t + dt + 0.09).connect(lp);
        lp.connect(g).connect(v.out);
      }
      return;
    case 'countdown':
      woodblock(v, { vel: 0.9, pitch: o.pitch });
      taiko(v, { vel: 0.4, pitch: 1.5 });
      return;
    case 'reveal':
      taiko(v, { vel: 0.9 });
      taiko(v, { start: t + 0.16, vel: 0.65, pitch: 1.1 });
      gong(v, { start: t + 0.3, freq: 98, dur: 3.2, vel: 0.55 });
      pad(v, { start: t + 0.3, midis: [45, 52, 57], dur: 1.2, vel: 0.6, bright: 0.3 });
      return;
    default:
      // click: 木鱼-like wooden tock
      woodblock(v, { vel: 0.7, pitch: o.pitch });
      burst(v, { color: 'white', type: 'highpass', freq: 4000, peak: 0.05, decay: 0.01 });
  }
};

export const headshot: Recipe = (v, o) => {
  bell(v, { freq: 1760 * o.pitch, ratios: [1, 1.5, 2.67], levels: [0.6, 0.35, 0.12], decays: [0.5, 0.35, 0.15], peak: 0.45, attack: 0.001 });
  burst(v, { type: 'highpass', freq: 5000, peak: 0.25, decay: 0.008 });
};

export const hitmarker: Recipe = (v, o) => {
  burst(v, { type: 'bandpass', freq: 5200 * o.pitch, q: 1.2, peak: 0.45, attack: 0.0005, decay: 0.014 });
  tone(v, { freq: 3100 * o.pitch, peak: 0.12, decay: 0.022 });
};

export const chat: Recipe = (v) => {
  tone(v, { freq: 1318.5, to: 1760, glide: 0.04, peak: 0.25, attack: 0.003, decay: 0.12 });
};

export const announce: Recipe = (v, o) => {
  const t = v.t;
  if (o.variant === 'warn') {
    woodblock(v, { vel: 0.7 });
    woodblock(v, { start: t + 0.14, vel: 0.8, pitch: 1.12 });
    return;
  }
  taiko(v, { vel: 0.9 });
  gong(v, { start: t + 0.04, freq: 196, dur: 1.6, vel: 0.4, glide: 1.04 });
};
