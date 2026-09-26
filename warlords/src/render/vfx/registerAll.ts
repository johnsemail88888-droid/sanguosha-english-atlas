// Registers every bespoke VFX module that exists (per-kingdom ability VFX and
// item VFX added in wave 2). Uses a glob so missing modules are simply skipped;
// each module exports one or more `register…Vfx()` functions.
type VfxModule = Record<string, unknown>;

const modules = import.meta.glob<VfxModule>(['./abilities-*.ts', './items-vfx.ts'], { eager: true });

let done = false;

export function registerAllVfx(): void {
  if (done) return;
  done = true;
  for (const [path, mod] of Object.entries(modules)) {
    for (const [name, fn] of Object.entries(mod)) {
      if (!/^register\w*Vfx$/.test(name) || typeof fn !== 'function') continue;
      try {
        (fn as () => void)();
      } catch (err) {
        console.error(`[vfx] ${path}:${name} failed`, err);
      }
    }
  }
}
