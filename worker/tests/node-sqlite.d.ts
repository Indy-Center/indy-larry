// The part of Node's built-in `node:sqlite` the Durable Object's SQL stand-in uses (fake-cloudflare.ts).
// Declared here because the Worker's tsconfig has Cloudflare's types, not Node's.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): { all(...bindings: unknown[]): Record<string, string | number | null>[] };
  }
}
