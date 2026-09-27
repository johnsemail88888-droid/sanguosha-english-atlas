// 性能体检: which browser / OS a user agent is, how to turn its GPU on, the
// integrated-GPU tip, which desktop build to offer, and the verdict line; the
// first-run tier from the device's hints (GPU / CPU / memory) and the 自动 flag of
// profiles saved before it existed.
import { afterEach, describe, expect, it } from 'vitest';
import { defaultQuality, loadSettingsForTest } from '../../../src/game/settings';
import { overrideLang } from '../../../src/ui/i18n';
import { desktopDownload, detectBrowser, detectOs, integratedTip, isDesktopOs, perfVerdict, softwareFix, verdictText } from '../../../src/ui/perfcheck';

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

  it('the desktop build for the OS (Apple silicon: arm64)', () => {
    expect(desktopDownload('windows', 'discrete')!.file).toMatch(/Windows-portable\.exe$/);
    expect(desktopDownload('mac', 'apple')!.file).toMatch(/macOS-arm64\.dmg$/);
    expect(desktopDownload('mac', 'integrated')!.file).toMatch(/macOS-x64\.dmg$/);
    expect(desktopDownload('linux', 'unknown')!.file).toMatch(/Linux\.AppImage$/);
    expect(desktopDownload('android', 'mobile')).toBeNull();
    expect(desktopDownload('ios', 'apple')).toBeNull();
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
    const v = perfVerdict({ webgl2: true, renderer: GPU.uhd, pick: pick('potato', 52), lowFps: 31 });
    expect(v).toMatchObject({ kind: 'slow', tier: 'potato', lowFps: 31 });
    expect(verdictText(v)).toBe('⚠ 帧率偏低：Intel(R) UHD Graphics 620（「流畅」约 31 帧，建议「极速」，约 52 帧）');
    expect(perfVerdict({ webgl2: true, renderer: GPU.uhd, pick: pick('low', 35) }).kind).toBe('slow');
    expect(perfVerdict({ webgl2: true, renderer: GPU.uhd, pick: pick('low', 45) }).kind).toBe('ok');
  });

  it('no WebGL 2 at all', () => {
    const v = perfVerdict({ webgl2: false, renderer: '', pick: null });
    expect(v.kind).toBe('nowebgl');
    expect(verdictText(v)).toContain('WebGL 2');
  });

  it('English', () => {
    overrideLang('en');
    expect(verdictText(perfVerdict({ webgl2: true, renderer: GPU.rtx, pick: pick('high', 120) }))).toBe('✅ Graphics card in use: NVIDIA GeForce RTX 5090, about 120 fps expected');
    expect(verdictText(perfVerdict({ webgl2: true, renderer: GPU.swiftshader, pick: null }))).toMatch(/^⚠ The browser is not using the graphics card/);
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
