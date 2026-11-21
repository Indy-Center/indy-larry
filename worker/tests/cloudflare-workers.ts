/** Stands in for `cloudflare:workers` in tests (vitest.config.ts), so the entrypoint can be driven directly. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
