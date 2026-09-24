// Minimal typed event emitter. Listener exceptions are isolated so a faulty UI
// handler can never break the network / simulation loop.

export class Emitter<M extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof M, Set<(payload: never) => void>>();

  on<K extends keyof M>(ev: K, cb: (payload: M[K]) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(cb as (payload: never) => void);
    return () => {
      set.delete(cb as (payload: never) => void);
    };
  }

  emit<K extends keyof M>(ev: K, payload: M[K]): void {
    const set = this.listeners.get(ev);
    if (!set || set.size === 0) return;
    for (const cb of [...set]) {
      try {
        (cb as (p: M[K]) => void)(payload);
      } catch (err) {
        console.error(`[net] listener for "${String(ev)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
