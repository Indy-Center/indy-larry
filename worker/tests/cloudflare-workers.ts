/** Stands in for `cloudflare:workers` in tests (vitest.config.ts), so the entrypoint can be driven directly. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

/** The Durable Object base class, which only keeps its state and env, as Cloudflare's does. */
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
