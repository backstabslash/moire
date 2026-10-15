import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const before: Record<string, string> = {
  "README.md": `# ratelimit

Tiny rate limiter for HTTP handlers.

## Usage

\`\`\`ts
app.use(limit({ max: 100, windowMs: 60_000 }));
\`\`\`

Requests over the limit get a 429.
`,
  "src/http.ts": `export interface Req {
  ip: string;
  path: string;
  headers: Record<string, string | undefined>;
}

export interface Res {
  status(code: number): Res;
  set(name: string, value: string): Res;
  send(body: string): void;
}

export type Next = () => void;
`,
  "src/limiter.ts": `import type { Next, Req, Res } from "./http";

export interface Options {
  max: number;
  windowMs: number;
  keyOf?: (req: Req) => string;
}

const byIp = (req: Req) => req.ip;

export function byHeader(name: string) {
  return (req: Req): string => {
    const value = req.headers[name.toLowerCase()];
    return value ?? req.ip;
  };
}

export function fixedWindow(opts: Options) {
  const hits = new Map<string, number>();
  let started = Date.now();

  return (key: string): boolean => {
    const now = Date.now();
    if (now - started > opts.windowMs) {
      hits.clear();
      started = now;
    }
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    return count <= opts.max;
  };
}

export function exempt(paths: string[]) {
  const skipped = new Set(paths);
  return (req: Req): boolean => {
    if (skipped.has(req.path)) return true;
    return req.path.startsWith("/internal/");
  };
}

export function limit(opts: Options) {
  const allow = fixedWindow(opts);
  const keyOf = opts.keyOf ?? byIp;

  return (req: Req, res: Res, next: Next) => {
    if (allow(keyOf(req))) return next();
    res.status(429).send("Too many requests");
  };
}
`,
  "src/server.ts": `import { createServer } from "./serve";
import { limit } from "./limiter";

const app = createServer();

app.use(limit({ max: 100, windowMs: 60_000 }));

app.get("/health", (_req, res) => res.send("ok"));

app.listen(3000);
`,
  "tests/limiter.test.ts": `import { describe, expect, it } from "vitest";
import { fixedWindow } from "../src/limiter";

describe("fixedWindow", () => {
  it("allows up to max requests", () => {
    const allow = fixedWindow({ max: 2, windowMs: 1000 });
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
  });
});
`,
};

const after: Record<string, string> = {
  "README.md": `# ratelimit

Tiny token-bucket rate limiter for HTTP handlers.

## Usage

\`\`\`ts
app.use(limit({ capacity: 20, refillPerSec: 5 }));
\`\`\`

Each client gets a bucket of \`capacity\` tokens that refills
at \`refillPerSec\`, so short bursts go through.

## Over the limit

Requests get a **429** with a \`Retry-After\` header saying
how many seconds until a token is free.
`,
  "src/limiter.ts": `import type { Next, Req, Res } from "./http";

export interface Options {
  capacity: number;
  refillPerSec: number;
  keyOf?: (req: Req) => string;
}

const byIp = (req: Req) => req.ip;

export function byHeader(name: string) {
  return (req: Req): string => {
    const value = req.headers[name.toLowerCase()];
    return value ?? req.ip;
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

function full(cap: number): Bucket {
  return { tokens: cap, at: 0 };
}

export function tokenBucket(opts: Options) {
  const buckets = new Map<string, Bucket>();
  const cap = opts.capacity;
  const rate = opts.refillPerSec;

  return (key: string): number => {
    const now = Date.now();
    const b = buckets.get(key) ?? full(cap);
    const refill = ((now - b.at) / 1000) * rate;
    b.tokens = Math.min(cap, b.tokens + refill);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return (1 - b.tokens) / rate;
    b.tokens -= 1;
    return 0;
  };
}

export function exempt(paths: string[]) {
  const skipped = new Set(paths);
  return (req: Req): boolean => {
    if (skipped.has(req.path)) return true;
    return req.path.startsWith("/internal/");
  };
}

export function limit(opts: Options) {
  const wait = tokenBucket(opts);
  const keyOf = opts.keyOf ?? byIp;

  return (req: Req, res: Res, next: Next) => {
    const seconds = Math.ceil(wait(keyOf(req)));
    if (seconds === 0) return next();
    res.set("Retry-After", String(seconds));
    res.status(429).send("Too many requests");
  };
}
`,
  "src/server.ts": `import { createServer } from "./serve";
import { limit } from "./limiter";

const app = createServer();

app.use(limit({ capacity: 20, refillPerSec: 5 }));

app.get("/health", (_req, res) => res.send("ok"));

app.listen(3000);
`,
  "tests/limiter.test.ts": `import { describe, expect, it, vi } from "vitest";
import { tokenBucket } from "../src/limiter";

describe("tokenBucket", () => {
  it("lets a burst through, then asks to wait", () => {
    const wait = tokenBucket({ capacity: 2, refillPerSec: 1 });
    expect(wait("a")).toBe(0);
    expect(wait("a")).toBe(0);
    expect(wait("a")).toBeCloseTo(1);
  });

  it("refills over time", () => {
    vi.useFakeTimers();
    const wait = tokenBucket({ capacity: 1, refillPerSec: 2 });
    wait("a");
    vi.advanceTimersByTime(500);
    expect(wait("a")).toBe(0);
  });
});
`,
};

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

export function makeDemoRepo(root: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  mkdirSync(root, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "demo@example.com");
  git("config", "user.name", "demo");
  write(root, before);
  git("add", "-A");
  git("commit", "-qm", "fixed-window limiter");
  git("checkout", "-qb", "agent/token-bucket");
  write(root, after);
}
