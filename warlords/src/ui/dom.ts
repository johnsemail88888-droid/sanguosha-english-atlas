// Minimal DOM helpers (no framework). `h()` builds elements, `Bag` collects
// disposers so every screen/widget tears down listeners it added.

export type Child = Node | string | number | null | undefined | false | readonly Child[];

export interface Props {
  class?: string;
  style?: string;
  title?: string;
  id?: string;
  role?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  src?: string;
  alt?: string;
  disabled?: boolean;
  checked?: boolean;
  tabindex?: number;
  maxlength?: number;
  min?: number;
  max?: number;
  step?: number;
  for?: string;
  autocomplete?: string;
  draggable?: boolean;
  /** data-* attributes */
  data?: Record<string, string | number | boolean>;
  /** aria-* attributes */
  aria?: Record<string, string | number | boolean>;
  /** event listeners */
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
}

function append(el: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child as readonly Child[]) append(el, c);
    return;
  }
  if (child instanceof Node) el.appendChild(child);
  else el.appendChild(document.createTextNode(String(child)));
}

/** Append children (strings, nodes, arrays; null/false are skipped). */
export function appendChildren(el: Node, ...children: Child[]): void {
  for (const c of children) append(el, c);
}

/** Create an element: h('div', { class: 'x' }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

function applyProps(el: HTMLElement, p: Props): void {
  if (p.class) el.className = p.class;
  if (p.style) el.setAttribute('style', p.style);
  if (p.title !== undefined) el.title = p.title;
  if (p.id) el.id = p.id;
  if (p.role) el.setAttribute('role', p.role);
  if (p.type !== undefined) el.setAttribute('type', p.type);
  if (p.value !== undefined) (el as HTMLInputElement).value = p.value;
  if (p.placeholder !== undefined) el.setAttribute('placeholder', p.placeholder);
  if (p.href !== undefined) el.setAttribute('href', p.href);
  if (p.src !== undefined) el.setAttribute('src', p.src);
  if (p.alt !== undefined) el.setAttribute('alt', p.alt);
  if (p.disabled) (el as HTMLButtonElement).disabled = true;
  if (p.checked) (el as HTMLInputElement).checked = true;
  if (p.tabindex !== undefined) el.tabIndex = p.tabindex;
  if (p.maxlength !== undefined) el.setAttribute('maxlength', String(p.maxlength));
  if (p.min !== undefined) el.setAttribute('min', String(p.min));
  if (p.max !== undefined) el.setAttribute('max', String(p.max));
  if (p.step !== undefined) el.setAttribute('step', String(p.step));
  if (p.for !== undefined) el.setAttribute('for', p.for);
  if (p.autocomplete !== undefined) el.setAttribute('autocomplete', p.autocomplete);
  if (p.draggable !== undefined) el.draggable = p.draggable;
  if (p.data) for (const [k, v] of Object.entries(p.data)) el.dataset[k] = String(v);
  if (p.aria) for (const [k, v] of Object.entries(p.aria)) el.setAttribute(`aria-${k}`, String(v));
  if (p.on) {
    for (const [k, fn] of Object.entries(p.on)) {
      if (fn) el.addEventListener(k, fn as EventListener);
    }
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element with attributes. */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number> | null,
  ...children: (SVGElement | null | undefined | false)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Collects teardown callbacks. */
export class Bag {
  private fns: (() => void)[] = [];
  private disposed = false;

  add(fn: (() => void) | { dispose(): void }): void {
    const f = typeof fn === 'function' ? fn : () => fn.dispose();
    if (this.disposed) {
      f();
      return;
    }
    this.fns.push(f);
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (ev: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (ev: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (ev: Event) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (ev: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.add(() => target.removeEventListener(type, fn, opts));
  }

  timeout(fn: () => void, ms: number): void {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
  }

  interval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.add(() => clearInterval(id));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const fns = this.fns;
    this.fns = [];
    for (let i = fns.length - 1; i >= 0; i--) {
      try {
        fns[i]();
      } catch (err) {
        console.error('[ui] dispose failed', err);
      }
    }
  }
}

/** Write text only when it changed (avoids needless layout/style work in the HUD). */
export function setText(el: HTMLElement | SVGElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toggle a class only when it changes. */
export function setClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Copy text to the clipboard with a legacy fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
