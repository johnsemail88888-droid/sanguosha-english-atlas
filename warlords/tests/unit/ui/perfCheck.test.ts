// 性能体检: which browser / OS a user agent is, how to turn its GPU on, the
// integrated-GPU tip, which desktop build to offer, and the verdict line; the
// first-run tier from the device's hints (GPU / CPU / memory) and the 自动 flag of
// profiles saved before it existed.
import { afterEach, describe, expect, it } from 'vitest';
import { defaultQuality, defaultRenderScale, loadSettingsForTest } from '../../../src/game/settings';
import { overrideLang } from '../../../src/ui/i18n';
import { desktopGpuSoftware } from '../../../src/ui/desktop';
import { desktopDownload, desktopPcTip, detectBrowser, detectOs, detectOsFrom, gpuChipName, gpuChipStatus, gpuWarnText, integratedTip, isDesktopOs, isMac, macArch, nvidiaPanelTip, perfVerdict, softwareFix, verdictText } from '../../../src/ui/perfcheck';

afterEach(() => overrideLang(null));

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.52',
  operaWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  electron: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SanguoWarlords/0.1.0 Chrome/128.0.6613.186 Electron/32.1.2 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

const GPU = {
  swiftshader: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  rtx: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  uhd: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  apu: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  rx: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  m1: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  mali: 'Mali-G78 MC24',
};

describe('browser / OS from the user agent', () => {
  it('browsers (Edge / Opera say Chrome too; our desktop app says Electron)', () => {
    expect(detectBrowser(UA.chromeWin)).toBe('chrome');
    expect(detectBrowser(UA.edgeWin)).toBe('edge');
    expect(detectBrowser(UA.operaWin)).toBe('opera');
    expect(detectBrowser(UA.firefoxLinux)).toBe('firefox');
    expect(detectBrowser(UA.safariMac)).toBe('safari');
    expect(detectBrowser(UA.chromeMac)).toBe('chrome');
    expect(detectBrowser(UA.electron)).toBe('desktop');
    expect(detectBrowser('')).toBe('other');
  });

  it('operating systems (an iPad asking for the desktop site is a touch "Mac")', () => {
    expect(detectOs(UA.chromeWin)).toBe('windows');
    expect(detectOs(UA.firefoxLinux)).toBe('linux');
    expect(detectOs(UA.safariMac)).toBe('mac');
    expect(detectOs(UA.safariMac, 5)).toBe('ios');
    expect(detectOs(UA.android)).toBe('android');
    expect(detectOs(UA.iphone)).toBe('ios');
    expect(detectOs(UA.chromeOs)).toBe('chromeos');
    expect(['windows', 'mac', 'linux'].every((o) => isDesktopOs(o as never))).toBe(true);
    expect(['android', 'ios', 'chromeos', 'other'].some((o) => isDesktopOs(o as never))).toBe(false);
  });
});

describe('how to turn the GPU on', () => {
  it('Chrome / Edge: copy the settings address (pages cannot open chrome://), turn on graphics acceleration, relaunch', () => {
    const c = softwareFix('chrome');
    expect(c.url).toBe('chrome://settings/system');
    expect(c.steps).toHaveLength(3);
    expect(c.steps[0]).toContain('复制设置地址');
    expect(c.steps[1]).toContain('使用图形加速功能');
    expect(c.steps[2]).toContain('重新启动');
    expect(softwareFix('edge').url).toBe('edge://settings/system');
    expect(softwareFix('opera').url).toBe('opera://settings/system');
  });

  it('Firefox: about:preferences → 性能 → untick the recommended settings, tick hardware acceleration', () => {
    const f = softwareFix('firefox');
    expect(f.url).toMatch(/^about:preferences/);
    expect(f.steps.join(' ')).toContain('性能');
    expect(f.steps.join(' ')).toContain('取消「使用推荐的性能设置」');
    expect(f.steps.join(' ')).toContain('自动启用硬件加速');
  });

  it('the desktop app on a software renderer: the driver; other browsers: their own switch', () => {
    expect(softwareFix('desktop').url).toBeNull();
    expect(softwareFix('desktop').steps[0]).toContain('驱动');
    expect(softwareFix('safari').url).toBeNull();
    expect(softwareFix('safari').steps.length).toBeGreaterThan(0);
  });

  it('English', () => {
    overrideLang('en');
    expect(softwareFix('chrome').steps[1]).toContain('Use graphics acceleration when available');
    expect(softwareFix('firefox').steps[1]).toContain('Use hardware acceleration when available');
  });

  it('the integrated-GPU tip: Windows only, Intel UHD / Iris and Radeon APUs (not RX cards)', () => {
    const tip = integratedTip('windows', GPU.uhd, false);
    expect(tip).not.toBeNull();
    expect(tip!.join(' ')).toMatch(/系统 → 屏幕 → 显示卡/);
    expect(tip!.join(' ')).toContain('浏览器');
    expect(tip!.join(' ')).toContain('高性能');
    expect(integratedTip('windows', GPU.apu, true)!.join(' ')).toContain('SanguoWarlords');
    expect(integratedTip('windows', GPU.rx, false)).toBeNull();
    expect(integratedTip('windows', GPU.rtx, false)).toBeNull();
    expect(integratedTip('mac', GPU.uhd, false)).toBeNull();
    expect(integratedTip('windows', GPU.swiftshader, false)).toBeNull();
  });

  // (it took the GPU class before; now the renderer string + Chromium's architecture hint, so
  // Safari's "Apple GPU" — Apple silicon and Intel Macs alike — offers both .dmg files)
  it('the desktop build for the OS (Apple silicon: arm64; Intel Mac: x64; can\'t tell: both)', () => {
    const files = (d: ReturnType<typeof desktopDownload>): string[] => d!.files.map((f) => f.file);
    expect(files(desktopDownload('windows', GPU.rtx))).toEqual([expect.stringMatching(/Windows-portable\.exe$/)]);
    expect(files(desktopDownload('mac', GPU.m1))).toEqual([expect.stringMatching(/macOS-arm64\.dmg$/)]);
    expect(files(desktopDownload('mac', 'Apple M3 Pro'))).toEqual([expect.stringMatching(/macOS-arm64\.dmg$/)]);
    expect(files(desktopDownload('mac', 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)'))).toEqual([expect.stringMatching(/macOS-x64\.dmg$/)]);
    expect(files(desktopDownload('mac', 'AMD Radeon Pro 5500M OpenGL Engine'))).toEqual([expect.stringMatching(/macOS-x64\.dmg$/)]);
    // Safari: "Apple GPU" on every Mac → both, labelled; Chromium's hint settles it
    const both = desktopDownload('mac', 'Apple GPU')!;
    expect(files(both)).toEqual([expect.stringMatching(/macOS-arm64\.dmg$/), expect.stringMatching(/macOS-x64\.dmg$/)]);
    expect(both.files.map((f) => f.label)).toEqual([expect.stringContaining('Apple 芯片'), expect.stringContaining('Intel')]);
    expect(files(desktopDownload('mac', 'Apple GPU', 'arm'))).toEqual([expect.stringMatching(/macOS-arm64\.dmg$/)]);
    expect(files(desktopDownload('mac', 'Apple GPU', 'x86'))).toEqual([expect.stringMatching(/macOS-x64\.dmg$/)]);
    expect(macArch('', null)).toBeNull();
    // the renderer names the hardware: an x86 Chrome in Rosetta on an M1 still gets the arm64 build
    expect(macArch(GPU.m1, 'x86')).toBe('arm64');
    expect(files(desktopDownload('linux', ''))).toEqual([expect.stringMatching(/Linux\.AppImage$/)]);
    expect(desktopDownload('android', GPU.mali)).toBeNull();
    expect(desktopDownload('ios', 'Apple GPU')).toBeNull();
  });

  it('a strong PC on its integrated GPU (Windows): the desktop PC\'s cable, the laptop\'s Windows and NVIDIA settings', () => {
    const pc = desktopPcTip('windows', GPU.uhd)!.join(' ');
    expect(pc).toContain('显示器线要插在独立显卡（机箱下方的显卡接口）上，不要插主板');
    const nv = nvidiaPanelTip('windows', GPU.uhd, false)!.join(' ');
    expect(nv).toContain('NVIDIA 控制面板 → 管理 3D 设置 → 程序设置');
    expect(nv).toContain('高性能 NVIDIA 处理器');
    expect(nvidiaPanelTip('windows', GPU.uhd, true)!.join(' ')).toContain('SanguoWarlords');
    for (const g of [GPU.rtx, GPU.rx, GPU.swiftshader]) {
      expect(desktopPcTip('windows', g)).toBeNull();
      expect(nvidiaPanelTip('windows', g, false)).toBeNull();
    }
    expect(desktopPcTip('mac', GPU.uhd)).toBeNull();
  });
});

describe('verdict', () => {
  const pick = (quality: 'potato' | 'low' | 'medium' | 'high' | 'ultra', fps: number | null) => ({ quality, maxPixelRatio: 1, fps });

  it('✅ the GPU is in use (with the estimated frame rate once benchmarked)', () => {
    const v = perfVerdict({ webgl2: true, renderer: GPU.rtx, pick: pick('ultra', 190) });
    expect(v).toMatchObject({ kind: 'ok', gpu: 'NVIDIA GeForce RTX 5090', fps: 190, tier: 'ultra' });
    expect(verdictText(v)).toBe('✅ 显卡已启用：NVIDIA GeForce RTX 5090，预计帧率 190');
    expect(verdictText(perfVerdict({ webgl2: true, renderer: GPU.rtx, pick: pick('ultra', 400) }))).toContain('预计帧率 240+');
    expect(verdictText(perfVerdict({ webgl2: true, renderer: GPU.rtx, pick: null }))).toBe('✅ 显卡已启用：NVIDIA GeForce RTX 5090');
  });

  it('⚠ a software renderer, whatever it measured', () => {
    const v = perfVerdict({ webgl2: true, renderer: GPU.swiftshader, pick: pick('potato', 9) });
    expect(v.kind).toBe('software');
    expect(verdictText(v)).toBe('⚠ 浏览器没用上显卡（当前：SwiftShader），游戏会非常卡');
  });

  it('⚠ low frame rate: the best fit is 极速, or its estimate is under 40 fps', () => {
    const v = perfVerdict({ webgl2: true, renderer: GPU.uhd, pick: pick('potato', 52) });
    expect(v).toMatchObject({ kind: 'slow', tier: 'potato' });
    expect(verdictText(v)).toBe('⚠ 帧率偏低：Intel(R) UHD Graphics 620 较弱，只有「极速」画质能流畅运行');
    const low = perfVerdict({ webgl2: true, renderer: GPU.uhd, pick: pick('low', 35) });
    expect(low.kind).toBe('slow');
    expect(verdictText(low)).toBe('⚠ 帧率偏低：Intel(R) UHD Graphics 620（「流畅」预计约 35 帧）');
    expect(perfVerdict({ webgl2: true, renderer: GPU.uhd, pick: pick('low', 45) }).kind).toBe('ok');
  });

  it('no WebGL 2 at all', () => {
    const v = perfVerdict({ webgl2: false, renderer: '', pick: null });
    expect(v.kind).toBe('nowebgl');
    expect(verdictText(v)).toContain('WebGL 2');
  });

  it('✅ on a Mac: its browser always draws on the Apple GPU (a low estimate is no "fix your GPU")', () => {
    for (const r of [GPU.m1, 'Apple GPU', 'Apple M2 Max']) {
      const v = perfVerdict({ webgl2: true, renderer: r, pick: pick('low', 32) });
      expect(v.kind).toBe('ok');
      expect(verdictText(v)).toMatch(/^✅ 显卡已启用：Apple/);
    }
  });

  it('English', () => {
    overrideLang('en');
    expect(verdictText(perfVerdict({ webgl2: true, renderer: GPU.rtx, pick: pick('high', 120) }))).toBe('✅ Graphics card in use: NVIDIA GeForce RTX 5090, about 120 fps expected');
    expect(verdictText(perfVerdict({ webgl2: true, renderer: GPU.swiftshader, pick: null }))).toMatch(/^⚠ The browser is not using the graphics card/);
  });
});

describe('the GPU chip (title, lobby)', () => {
  it('short names: no GeForce / (R) / (TM) filler, capped', () => {
    expect(gpuChipName(GPU.rtx)).toBe('NVIDIA RTX 5090');
    expect(gpuChipName(GPU.uhd)).toBe('Intel UHD Graphics 620');
    expect(gpuChipName(GPU.m1)).toBe('Apple M1');
    expect(gpuChipName('NVIDIA GeForce GTX 980, or similar')).toBe('NVIDIA GTX 980');
    expect(gpuChipName('A Very Long Graphics Adapter Name Of Some Vendor', 20)).toHaveLength(20);
  });

  it('green ✓ on a card / Apple / phone GPU, red on a software renderer, amber on an integrated one', () => {
    expect(gpuChipStatus({ renderer: GPU.rtx, software: false })).toEqual({ kind: 'ok', text: '显卡：NVIDIA RTX 5090 ✓' });
    expect(gpuChipStatus({ renderer: GPU.m1, software: false })!.kind).toBe('ok');
    expect(gpuChipStatus({ renderer: GPU.mali, software: false })!.kind).toBe('ok');
    expect(gpuChipStatus({ renderer: GPU.swiftshader, software: true })).toEqual({ kind: 'soft', text: '⚠ 浏览器没用显卡' });
    expect(gpuChipStatus({ renderer: GPU.uhd, software: false })).toEqual({ kind: 'integrated', text: '集成显卡：Intel UHD Graphics 620' });
    expect(gpuChipStatus({ renderer: GPU.apu, software: false })!.kind).toBe('integrated');
    expect(gpuChipStatus({ renderer: 'Weird Adapter', software: false })!.kind).toBe('unknown');
    // nothing to say: no renderer string, or no WebGL 2 (the title explains that itself)
    expect(gpuChipStatus({ renderer: '', software: false })).toBeNull();
    expect(gpuChipStatus({ renderer: GPU.rtx, software: false }, false)).toBeNull();
    overrideLang('en');
    expect(gpuChipStatus({ renderer: GPU.rtx, software: false })!.text).toBe('GPU: NVIDIA RTX 5090 ✓');
  });

  it('a Mac from the client hints / navigator.platform when the user agent says nothing useful', () => {
    expect(detectOsFrom({ userAgent: UA.safariMac })).toBe('mac');
    expect(detectOsFrom({ userAgent: UA.safariMac, maxTouchPoints: 5 })).toBe('ios');
    expect(detectOsFrom({ userAgent: 'Mozilla/5.0', userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectOsFrom({ userAgent: '', platform: 'MacIntel' })).toBe('mac');
    expect(detectOsFrom({ userAgent: '', platform: 'Win32' })).toBe('windows');
    expect(detectOsFrom({ userAgent: UA.chromeWin, platform: 'MacIntel' })).toBe('windows');
    expect(isMac({ userAgent: UA.chromeMac })).toBe(true);
    expect(isMac({ userAgent: UA.chromeWin })).toBe(false);
  });

});

describe('first-run tier from the device (before the benchmark)', () => {
  const desk = { coarse: false, minSide: 1080, cores: 16, memoryGb: 8 };
  it('a discrete card or Apple silicon → 均衡', () => {
    expect(defaultQuality({ ...desk, gpu: GPU.rtx })).toBe('medium');
    expect(defaultQuality({ ...desk, gpu: GPU.rx })).toBe('medium');
    expect(defaultQuality({ ...desk, gpu: GPU.m1 })).toBe('medium');
  });

  it('integrated, mobile, software or unknown GPUs → 流畅', () => {
    for (const gpu of [GPU.uhd, GPU.apu, GPU.mali, GPU.swiftshader, '']) expect(defaultQuality({ ...desk, gpu })).toBe('low');
  });

  it('≤ 4 CPU cores or ≤ 4 GB of memory → 流畅, whatever the GPU', () => {
    expect(defaultQuality({ ...desk, gpu: GPU.rtx, cores: 4 })).toBe('low');
    expect(defaultQuality({ ...desk, gpu: GPU.rtx, memoryGb: 4 })).toBe('low');
    expect(defaultQuality({ ...desk, gpu: GPU.rtx, cores: 6, memoryGb: 8 })).toBe('medium');
  });

  it('Apple silicon: 均衡, but its Retina screen capped at 1.25× until the benchmark says otherwise', () => {
    expect(defaultRenderScale({ ...desk, gpu: GPU.m1 })).toBe(1.25);
    expect(defaultRenderScale({ ...desk, gpu: GPU.rtx })).toBe(0);
    expect(defaultRenderScale({ coarse: false, minSide: 0 })).toBe(0);
  });

  it('phones / small screens → 流畅; no page to probe (node) → 均衡', () => {
    expect(defaultQuality({ coarse: true, minSide: 1080, gpu: GPU.rtx })).toBe('low');
    expect(defaultQuality({ coarse: false, minSide: 0, cores: 2 })).toBe('medium');
  });
});

describe('自动 on profiles saved before it existed', () => {
  const withStore = (saved: object | null, fn: () => void): void => {
    const g = globalThis as unknown as Record<string, unknown>;
    const before = g.localStorage;
    const data = new Map<string, string>();
    if (saved) data.set('sgwl.settings.v1', JSON.stringify(saved));
    g.localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) };
    try {
      fn();
    } finally {
      g.localStorage = before;
    }
  };

  it('a fresh profile, or the old first-run tier → 自动; another tier was the player’s pick', () => {
    withStore(null, () => expect(loadSettingsForTest()).toMatchObject({ qualityAuto: true, autoAdjust: true }));
    withStore({ lang: 'en' }, () => expect(loadSettingsForTest().qualityAuto).toBe(true));
    withStore({ quality: 'medium' }, () => expect(loadSettingsForTest()).toMatchObject({ quality: 'medium', qualityAuto: true }));
    withStore({ quality: 'high' }, () => expect(loadSettingsForTest()).toMatchObject({ quality: 'high', qualityAuto: false }));
    withStore({ quality: 'low' }, () => expect(loadSettingsForTest()).toMatchObject({ quality: 'low', qualityAuto: false }));
    // saved since: as stored
    withStore({ quality: 'high', qualityAuto: true }, () => expect(loadSettingsForTest().qualityAuto).toBe(true));
    withStore({ quality: 'medium', qualityAuto: false }, () => expect(loadSettingsForTest().qualityAuto).toBe(false));
  });
});

describe('desktop app: Chromium says WebGL is not on the GPU', () => {
  const g = globalThis as unknown as { sgwlDesktop?: unknown };
  afterEach(() => delete g.sgwlDesktop);

  it('its GPU feature status (not "enabled…") flags a software renderer; the warning names the driver fix', () => {
    expect(desktopGpuSoftware()).toBe(false);
    g.sgwlDesktop = { isDesktop: true, lanUrls: [], port: 8787, webgl: 'enabled' };
    expect(desktopGpuSoftware()).toBe(false);
    g.sgwlDesktop = { isDesktop: true, lanUrls: [], port: 8787, webgl: 'enabled_readback' };
    expect(desktopGpuSoftware()).toBe(false);
    g.sgwlDesktop = { isDesktop: true, lanUrls: [], port: 8787, webgl: '' };
    expect(desktopGpuSoftware()).toBe(false);
    for (const webgl of ['unavailable_software', 'software', 'disabled_software', 'disabled_off']) {
      g.sgwlDesktop = { isDesktop: true, lanUrls: [], port: 8787, webgl };
      expect(desktopGpuSoftware()).toBe(true);
    }
    expect(gpuWarnText(GPU.swiftshader).fix).toContain('更新显卡驱动');
    delete g.sgwlDesktop;
    expect(gpuWarnText(GPU.swiftshader).fix).toContain('使用图形加速功能');
  });
});
