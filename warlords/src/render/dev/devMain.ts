// Dev harness entry (render-dev.html). Modes:
//   ?mode=models     character lineup preview (&set=troops, &anim=dance, &speed=4 ...)
//   ?mode=portraits  portrait grid (renderHeroPortrait) + gallery turntable (&hero=)
//   ?mode=mounts     mount lineup: every horse coat + the war elephant (&speed=, &cam=, &bones=1)
//   default       full GameRenderer on a synthetic DevView (&hero=<id>, &cam=free, &quality=)
import { startModelsPreview } from './modelsPreview';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const mode = params.get('mode');
if (mode === 'models') startModelsPreview(canvas, params);
else if (mode === 'mounts') void import('./mountsPreview').then((m) => m.startMountsPreview(canvas, params));
else if (mode === 'portraits') void import('./portraitsPreview').then((m) => m.startPortraitsPreview(canvas, params));
else void import('./devGame').then((m) => m.startDevGame(canvas, params));
