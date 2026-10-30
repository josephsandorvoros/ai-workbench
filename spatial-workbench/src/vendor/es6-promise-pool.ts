class PromisePoolShim {
  private instance: unknown;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor(generator?: unknown, concurrency?: unknown) {
    let pool: unknown[] = [];
    if (typeof generator === "function") {
      let res: unknown;
      while ((res = (generator as () => unknown)()) !== null && res !== undefined) {
        pool.push(res);
      }
    }
    this.instance = Promise.all(
      pool.map((p, index) =>
        Promise.resolve(typeof p === "function" ? (p as () => unknown)() : p).then((value) => {
          this.emit("fulfilled", { result: [index, value] });
          return value;
        }),
      ),
    );
  }

  start() {
    return this.instance;
  }

  addEventListener(type: string, listener: Function) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Function) {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }

  on(type: string, listener: Function) {
    this.addEventListener(type, listener);
  }

  static PromisePool = PromisePoolShim;
  static PromisePoolEvent = class {};
}

export default PromisePoolShim;
export { PromisePoolShim as PromisePool };
