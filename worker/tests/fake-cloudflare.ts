import { DatabaseSync } from 'node:sqlite';

/** Hand-written stand-ins for the Worker's KV namespace, queue producers and Durable Objects. */

export type FakeKv = KVNamespace & { store: Map<string, string>; ttls: Map<string, number | undefined> };

/**
 * A KV namespace in memory. `ttls` records each put's `expirationTtl`. With `expire`, a key is also gone once
 * its TTL has passed by `Date.now()` (for a test that moves the clock); without it keys never expire.
 */
export function fakeKv({ expire = false }: { expire?: boolean } = {}): FakeKv {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const expiresAt = new Map<string, number>();
  const live = (key: string) => {
    const at = expiresAt.get(key);
    if (expire && at !== undefined && Date.now() >= at) {
      store.delete(key);
      expiresAt.delete(key);
    }
    return store.get(key) ?? null;
  };
  return {
    store,
    ttls,
    async get(key: string, type?: unknown) {
      const value = live(key);
      return value !== null && (type === 'json' || (type as { type?: string })?.type === 'json') ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }) {
      store.set(key, value);
      ttls.set(key, options?.expirationTtl);
      if (options?.expiration !== undefined) expiresAt.set(key, options.expiration * 1000);
      else if (options?.expirationTtl === undefined) expiresAt.delete(key);
      else expiresAt.set(key, Date.now() + options.expirationTtl * 1000);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      return { keys: [...store.keys()].filter((name) => name.startsWith(options?.prefix ?? '')).map((name) => ({ name })), list_complete: true };
    },
  } as unknown as FakeKv;
}

export type FakeQueue<Body> = Queue<Body> & { sent: Body[] };

export function fakeQueue<Body>(): FakeQueue<Body> {
  const sent: Body[] = [];
  return {
    sent,
    async send(body: Body) {
      sent.push(body);
    },
    async sendBatch(messages: Iterable<{ body: Body }>) {
      for (const message of messages) sent.push(message.body);
    },
  } as unknown as FakeQueue<Body>;
}

/** A batch as Queues delivers it to a consumer, with each message's ack and retry recorded. */
export function batchOf<Body>(queue: string, bodies: Body[]) {
  const messages = bodies.map((body, i) => ({ id: `message-${i}`, body, attempts: 1, acked: false, retried: false, ack() { this.acked = true; }, retry() { this.retried = true; } }));
  return { batch: { queue, messages } as unknown as MessageBatch<Body>, messages };
}

/**
 * A Durable Object's SQL storage (`ctx.storage.sql`), backed by a real SQLite database in memory
 * (Node's `node:sqlite`), so the object's own queries run as written. Only `exec` with its cursor's
 * `toArray()` and `one()` is there: what the objects use.
 */
export function fakeSqlStorage(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one() {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
}

/**
 * A Durable Object namespace binding: `idFromName(name)` and `get(id)` hand back one instance per name,
 * made by `make` over its own in-memory SQL storage, so every call by that name reaches the same object.
 * The stub is the instance itself; callers await its methods, as they do over RPC.
 */
export function fakeDurableObjects<T>(make: (ctx: DurableObjectState) => T) {
  const instances = new Map<string, T>();
  return {
    instances,
    idFromName: (name: string) => ({ name, toString: () => name }),
    get(id: { name: string }) {
      let instance = instances.get(id.name);
      if (!instance) {
        instance = make({ storage: { sql: fakeSqlStorage() } } as unknown as DurableObjectState);
        instances.set(id.name, instance);
      }
      return instance;
    },
  };
}
