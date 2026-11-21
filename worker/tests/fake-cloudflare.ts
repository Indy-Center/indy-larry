/** Hand-written stand-ins for the Worker's KV namespace and queue producers. */

export type FakeKv = KVNamespace & { store: Map<string, string>; ttls: Map<string, number | undefined> };

export function fakeKv(): FakeKv {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    ttls,
    async get(key: string, type?: unknown) {
      const value = store.get(key) ?? null;
      return value !== null && (type === 'json' || (type as { type?: string })?.type === 'json') ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    async delete(key: string) {
      store.delete(key);
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
