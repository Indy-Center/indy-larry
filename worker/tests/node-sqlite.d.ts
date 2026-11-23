// The part of Node's built-in `node:sqlite` the Durable Object's SQL stand-in (fake-cloudflare.ts) and the
// TeamSpeak seed script (scripts/seed-ts-links.ts) use.
// Declared here because the Worker's tsconfig has Cloudflare's types, not Node's.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...bindings: unknown[]): Record<string, string | number | bigint | null>[];
      setReadBigInts(enabled: boolean): void;
    };
  }
}

// What the seed script's test uses to make a temporary database file.
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
