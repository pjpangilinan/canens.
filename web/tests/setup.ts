/**
 * Dexie needs an IndexedDB implementation. The store tests exercise real
 * queries against a real table rather than a hand-written mock, so the
 * completion rule is verified rather than re-asserted.
 */
import "fake-indexeddb/auto";

/**
 * The backup module records whether this browser has ever backed up, in
 * localStorage so the record survives losing the database - which is the
 * common way to end up with an empty one. The tests run in a Node environment,
 * so it needs a stand-in. A Map is enough: nothing else touches it.
 */
const store = new Map<string, string>();

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
    configurable: true,
  });
}
