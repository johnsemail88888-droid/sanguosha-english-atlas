// h() / slider() prop order: a browser sanitizes an <input type=range> value
// against min / max / step the moment it is set (and again when they change),
// so `value` must be applied after them. The node test environment has no DOM:
// a tiny fake implements exactly that part of the HTML spec.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { h } from '../../../src/ui/dom';
import { slider } from '../../../src/ui/widgets';

class FakeNode {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  appendChild<T extends FakeNode>(c: T): T {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes.length = 0;
    this.appendChild(new FakeText(v));
  }
}

class FakeText extends FakeNode {
  constructor(private readonly text: string) {
    super();
  }
  override get textContent(): string {
    return this.text;
  }
}

const num = (s: string | undefined, def: number): number => {
  const v = s === undefined ? NaN : Number.parseFloat(s);
  return Number.isFinite(v) ? v : def;
};

class FakeElement extends FakeNode {
  className = '';
  title = '';
  tabIndex = -1;
  draggable = false;
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly style = { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } };
  private raw = '';
  constructor(readonly tagName: string) {
    super();
  }
  addEventListener(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    // min / max / step changes re-run the value sanitization of a range input
    if (this.isRange() && (k === 'min' || k === 'max' || k === 'step')) this.raw = this.sanitize(this.raw);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  get value(): string {
    return this.raw;
  }
  set value(v: string) {
    this.raw = this.isRange() ? this.sanitize(v) : v;
  }
  private isRange(): boolean {
    return this.tagName === 'INPUT' && this.attrs.type === 'range';
  }
  /** HTML spec value sanitization for type=range (defaults min 0, max 100, step 1, step base = min). */
  private sanitize(raw: string): string {
    const min = num(this.attrs.min, 0);
    const max = Math.max(min, num(this.attrs.max, 100));
    const stepAttr = num(this.attrs.step, 1);
    const step = stepAttr > 0 ? stepAttr : 1;
    let v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) v = min + (max - min) / 2;
    v = Math.min(max, Math.max(min, v));
    v = min + Math.round((v - min) / step) * step;
    if (v > max + 1e-12) v -= step;
    return String(Number(v.toPrecision(12)));
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeAll(() => {
  for (const k of ['document', 'Node']) saved[k] = g[k];
  g.Node = FakeNode;
  g.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    createTextNode: (text: string) => new FakeText(text),
  };
});

afterAll(() => {
  for (const k of ['document', 'Node']) g[k] = saved[k];
});

const rangeOf = (wrap: HTMLElement): FakeElement => (wrap as unknown as FakeElement).childNodes[0] as FakeElement;

describe('h(): value is applied after min / max / step', () => {
  it('the fake reproduces the browser bug when value comes first', () => {
    const el = new FakeElement('INPUT');
    el.setAttribute('type', 'range');
    el.value = '0.6';
    el.setAttribute('min', '0.2');
    el.setAttribute('max', '1.5');
    el.setAttribute('step', '0.05');
    expect(el.value).toBe('1.2');
  });

  it('keeps fractional range values', () => {
    const el = h('input', { type: 'range', min: 0.2, max: 1.5, step: 0.05, value: '0.6' }) as unknown as FakeElement;
    expect(el.value).toBe('0.6');
  });
});

describe('slider()', () => {
  it('ADS sensitivity 0.6 on 0.2..1.5 step 0.05 stays 0.6', () => {
    const wrap = slider(0.6, 0.2, 1.5, 0.05, () => undefined, (v) => `${v.toFixed(2)}×`);
    const input = rangeOf(wrap);
    expect(input.value).toBe('0.6');
    // the fill and the label agree with the knob
    expect(input.style.props['--p']).toBe(`${((0.6 - 0.2) / 1.3) * 100}%`);
    expect((wrap as unknown as FakeElement).childNodes[1].textContent).toBe('0.60×');
  });

  it('volume 0.8 on 0..1 step 0.01 stays 0.8', () => {
    const input = rangeOf(slider(0.8, 0, 1, 0.01, () => undefined));
    expect(input.value).toBe('0.8');
    expect(input.style.props['--p']).toBe('80%');
  });

  it('an out-of-range stored value is shown where the knob really is', () => {
    const wrap = slider(5, 0.2, 3, 0.05, () => undefined, (v) => `${v}`);
    expect(rangeOf(wrap).value).toBe('3');
    expect((wrap as unknown as FakeElement).childNodes[1].textContent).toBe('3');
  });
});
