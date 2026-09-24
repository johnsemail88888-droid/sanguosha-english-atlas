// Dev-only: portrait grid + a gallery turntable (render-dev.html?mode=portraits).
import { HEROES } from '../../data';
import { renderHeroPortrait } from '../portrait';
import { mountHeroTurntable } from '../turntable';

export async function startPortraitsPreview(canvas: HTMLCanvasElement, params: URLSearchParams): Promise<void> {
  canvas.style.display = 'none';
  document.body.style.overflow = 'auto';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:12px;padding:12px;background:#2a2018;min-height:100vh;box-sizing:border-box';
  document.body.appendChild(wrap);
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,110px);gap:6px;align-content:start';
  wrap.appendChild(grid);
  const tt = document.createElement('div');
  tt.style.cssText = 'width:360px;height:520px;background:radial-gradient(#5a4a38,#1a1410);border:2px solid #d8ac4c';
  wrap.appendChild(tt);
  const size = Number(params.get('size') ?? 128);
  const heroes = HEROES.slice(0, Number(params.get('n') ?? 32));
  for (const h of heroes) {
    const img = document.createElement('img');
    img.width = 110;
    img.height = 110;
    img.title = h.nameZh;
    img.style.cssText = 'border:2px solid #d8ac4c;background:#000';
    grid.appendChild(img);
    img.src = await renderHeroPortrait(h.id, size);
  }
  mountHeroTurntable(tt, params.get('hero') ?? 'guanyu');
  setTimeout(() => ((window as unknown as { __ready: boolean }).__ready = true), 800);
}
