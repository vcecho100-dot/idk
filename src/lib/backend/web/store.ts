/** A tiny key-value store: IndexedDB in browsers, in-memory in tests / private mode. */

export type StoreName = "projects" | "versions" | "jobs" | "blobs";
const STORES: StoreName[] = ["projects", "versions", "jobs", "blobs"];

export interface KV {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  all<T>(store: StoreName): Promise<T[]>;
  clear(): Promise<void>;
}

export function memoryKV(): KV {
  const data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  return {
    get: async <T>(s: StoreName, k: string) => data.get(s)!.get(k) as T | undefined,
    put: async (s, k, v) => void data.get(s)!.set(k, v),
    del: async (s, k) => void data.get(s)!.delete(k),
    all: async <T>(s: StoreName) => [...data.get(s)!.values()] as T[],
    clear: async () => STORES.forEach((s) => data.get(s)!.clear()),
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function indexedKV(name = "shift3d-web"): Promise<KV> {
  if (typeof indexedDB === "undefined") return memoryKV();
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  } catch {
    return memoryKV();
  }
  const tx = (s: StoreName, mode: IDBTransactionMode) => db.transaction(s, mode).objectStore(s);
  return {
    get: <T>(s: StoreName, k: string) => req(tx(s, "readonly").get(k)) as Promise<T | undefined>,
    put: async (s, k, v) => void (await req(tx(s, "readwrite").put(v, k))),
    del: async (s, k) => void (await req(tx(s, "readwrite").delete(k))),
    all: <T>(s: StoreName) => req(tx(s, "readonly").getAll()) as Promise<T[]>,
    clear: async () => {
      for (const s of STORES) await req(tx(s, "readwrite").clear());
    },
  };
}
