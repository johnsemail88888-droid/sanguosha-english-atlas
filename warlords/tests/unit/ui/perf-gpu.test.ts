// Graphics diagnostics: which GPU a WebGL renderer string names (a software
// renderer gets the "browser is not using the graphics card" warning), its display
// name, the one-time WebGL probe (fake contexts) and the F3 panel's lines.
import { afterEach, describe, expect, it } from 'vitest';
import { classifyGpu, isSoftwareGpu, probeGpu, setGpuInfoForTests } from '../../../src/game/settings';
import { overrideLang } from '../../../src/ui/i18n';
import { gpuShortName, perfLines } from '../../../src/ui/perfcheck';

afterEach(() => {
  overrideLang(null);
  setGpuInfoForTests(null);
});

// renderer strings as browsers report them (UNMASKED_RENDERER_WEBGL)
const R = {
  swiftshader: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  swiftshaderOld: 'Google SwiftShader',
  basicRender: 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  llvmpipe: 'llvmpipe (LLVM 15.0.7, 256 bits)',
  rtx5090: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  gtx1050: 'NVIDIA GeForce GTX 1050/PCIe/SSE2',
  rx6700: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  radeonPro: 'AMD Radeon Pro 560X OpenGL Engine',
  radeonApu: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  radeon780m: 'ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  vegaApu: 'ANGLE (AMD, AMD Radeon(TM) RX Vega 10 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  uhd620: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  irisXe: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  mesaIntel: 'Mesa Intel(R) HD Graphics 520 (SKL GT2)',
  arc: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  m1: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  appleGpu: 'Apple GPU',
  mali: 'Mali-G78 MC24',
  adreno: 'Adreno (TM) 650',
  tegra: 'NVIDIA Tegra X1',
};

describe('GPU classifier', () => {
  it('software renderers (hardware acceleration off / blocklisted GPU)', () => {
    for (const r of [R.swiftshader, R.swiftshaderOld, R.basicRender, R.llvmpipe, 'softpipe', 'GDI Generic']) {
      expect(isSoftwareGpu(r), r).toBe(true);
      expect(classifyGpu(r), r).toBe('software');
    }
    for (const r of [R.rtx5090, R.uhd620, R.m1, R.mali, '']) expect(isSoftwareGpu(r), r).toBe(false);
  });

  it('discrete cards, integrated GPUs / APUs, Apple silicon, phones', () => {
    for (const r of [R.rtx5090, R.gtx1050, R.rx6700, R.radeonPro, R.arc]) expect(classifyGpu(r), r).toBe('discrete');
    for (const r of [R.radeonApu, R.radeon780m, R.vegaApu, R.uhd620, R.irisXe, R.mesaIntel]) expect(classifyGpu(r), r).toBe('integrated');
    for (const r of [R.m1, R.appleGpu]) expect(classifyGpu(r), r).toBe('apple');
    for (const r of [R.mali, R.adreno, R.tegra]) expect(classifyGpu(r), r).toBe('mobile');
    expect(classifyGpu('')).toBe('unknown');
    expect(classifyGpu('WebKit WebGL')).toBe('unknown');
  });

  it('display names drop ANGLE’s wrapping and the driver details', () => {
    expect(gpuShortName(R.rtx5090)).toBe('NVIDIA GeForce RTX 5090');
    expect(gpuShortName(R.uhd620)).toBe('Intel(R) UHD Graphics 620');
    expect(gpuShortName(R.radeonApu)).toBe('AMD Radeon(TM) Graphics');
    expect(gpuShortName(R.m1)).toBe('Apple M1');
    expect(gpuShortName(R.gtx1050)).toBe('NVIDIA GeForce GTX 1050');
    expect(gpuShortName(R.radeonPro)).toBe('AMD Radeon Pro 560X');
    expect(gpuShortName(R.swiftshader)).toBe('SwiftShader');
    expect(gpuShortName(R.basicRender)).toBe('Microsoft Basic Render Driver');
    expect(gpuShortName(R.llvmpipe)).toBe('llvmpipe');
    expect(gpuShortName(R.mali)).toBe('Mali-G78 MC24');
    expect(gpuShortName('')).toBe('');
  });
});

/** A document whose canvases answer with a fake WebGL context. */
function fakeDoc(opts: { webgl2: boolean; renderer: string; masked?: boolean; webgl1?: boolean }): { doc: Document; lost: number } {
  const state = { lost: 0 };
  const DEBUG = { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 };
  const gl = {
    RENDERER: 0x1f01,
    VENDOR: 0x1f00,
    getParameter(p: number): string {
      if (p === 0x1f01) return opts.masked ? 'WebKit WebGL' : opts.renderer;
      if (p === 0x1f00) return 'WebKit';
      if (p === DEBUG.UNMASKED_RENDERER_WEBGL) return opts.renderer;
      if (p === DEBUG.UNMASKED_VENDOR_WEBGL) return 'Vendor Inc.';
      return '';
    },
    getExtension(name: string): unknown {
      if (name === 'WEBGL_debug_renderer_info') return DEBUG;
      if (name === 'WEBGL_lose_context') return { loseContext: () => state.lost++ };
      return null;
    },
  };
  const doc = {
    createElement: () => ({
      getContext: (kind: string) => (kind === 'webgl2' ? (opts.webgl2 ? gl : null) : kind === 'webgl' && opts.webgl1 ? gl : null),
    }),
  } as unknown as Document;
  return {
    doc,
    get lost() {
      return state.lost;
    },
  };
}

describe('one-time WebGL probe', () => {
  it('no DOM (node / workers): no WebGL 2, unknown GPU, nothing cached', () => {
    const g = probeGpu(undefined);
    expect(g).toMatchObject({ webgl2: false, renderer: '' });
  });

  it('reads the unmasked renderer behind Chrome’s "WebKit WebGL", frees the context, caches the answer', () => {
    const f = fakeDoc({ webgl2: true, renderer: R.rtx5090, masked: true });
    const g = probeGpu(f.doc);
    expect(g).toEqual({ webgl2: true, reason: null, renderer: R.rtx5090, vendor: 'Vendor Inc.' });
    expect(f.lost).toBe(1);
    // read once: a second call does not create another context
    expect(probeGpu(fakeDoc({ webgl2: true, renderer: 'other' }).doc)).toBe(g);
  });

  it('Firefox gives the real (sanitized) name in gl.RENDERER itself', () => {
    const g = probeGpu(fakeDoc({ webgl2: true, renderer: 'Intel(R) HD Graphics, or similar' }).doc);
    expect(g.renderer).toBe('Intel(R) HD Graphics, or similar');
    expect(g.vendor).toBe('WebKit');
  });

  it('no WebGL 2: the reason, and the renderer WebGL 1 fell back to', () => {
    const g = probeGpu(fakeDoc({ webgl2: false, webgl1: true, renderer: R.basicRender }).doc);
    expect(g.webgl2).toBe(false);
    expect(g.reason).toMatch(/WebGL 2/);
    expect(isSoftwareGpu(g.renderer)).toBe(true);
  });
});

describe('F3 panel lines', () => {
  const p = { fps: 58.6, frameMs: 17.04, jsMs: 4.26, drawCalls: 312, triangles: 1_234_567, pixelRatio: 1, pixelRatioMin: 1, pixelRatioMax: 1.25, quality: 'medium' as const, applying: false };

  it('frame rate / time, JS time, draw calls, triangles, render scale with its range, tier, GPU', () => {
    overrideLang('zh');
    expect(perfLines(p, { fps: 60, ms: 16.7 }, R.rtx5090)).toEqual([
      '59 FPS · 17.0 ms · JS 4.3 ms',
      '312 DC · 1.23M △ · 渲染 1.00× (1.00–1.25) · 均衡',
      `GPU ${R.rtx5090}`,
    ]);
    overrideLang('en');
    expect(perfLines({ ...p, pixelRatioMax: 1, triangles: 84_200, applying: true, quality: 'high' }, { fps: 0, ms: 0 }, '')[1]).toBe('312 DC · 84k △ · scale 1.00× · High…');
    // the GPU's own time where the browser can measure it (timer queries)
    expect(perfLines({ ...p, gpuMs: 3.14 }, { fps: 0, ms: 0 }, '')[0]).toBe('59 FPS · 17.0 ms · JS 4.3 ms · GPU 3.1 ms');
    expect(perfLines({ ...p, gpuMs: -1 }, { fps: 0, ms: 0 }, '')[0]).toBe('59 FPS · 17.0 ms · JS 4.3 ms');
  });

  it('before the 3D view has numbers: the HUD’s own frame rate', () => {
    overrideLang('en');
    expect(perfLines(null, { fps: 30.2, ms: 33.1 }, '')).toEqual(['30 FPS · 33.1 ms', 'GPU unknown']);
  });
});
