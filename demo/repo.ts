import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const before: Record<string, string> = {
  "CHANGELOG.md": `# Changelog

## 1.0.0

- Fixed window limiter
`,
  "README.md": `# ratelimit

Tiny rate limiter for HTTP handlers.

## Over the limit

\`\`\`mermaid
flowchart LR
  R[Request] --> T{Over the limit?}
  T -- no --> N[Handler]
  T -- yes --> W[429]
\`\`\`

> [!TIP]
> Clients get a **429** and retry at once.

## Usage

\`\`\`ts
app.use(limit({ max: 100, windowMs: 60_000 }));
\`\`\`

| Option | Default | Meaning |
| --- | --- | --- |
| \`max\` | 100 | Requests in a window |
| \`windowMs\` | 60000 | Length of a window |
`,
  "src/client.ts": `export function clientIp(forwarded: string, peer: string) {
  const first = forwarded.split(",")[1]?.trim();
  return first || peer;
}
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
  "src/routes/auth.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function auth(router: Router) {
  router.use("/login", limit({ max: 5, windowMs: 60_000 }));
}
`,
  "src/routes/billing.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function billing(router: Router) {
  router.use("/invoices", limit({ max: 30, windowMs: 60_000 }));
}
`,
  "src/routes/search.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function search(router: Router) {
  router.use("/search", limit({ max: 60, windowMs: 60_000 }));
}
`,
  "src/routes/uploads.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function uploads(router: Router) {
  router.use("/uploads", limit({ max: 10, windowMs: 60_000 }));
}
`,
  "src/routes/webhooks.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function webhooks(router: Router) {
  router.use("/hooks", limit({ max: 500, windowMs: 60_000 }));
}
`,
  "src/server.ts": `import { createServer } from "./serve";
import { limit } from "./limiter";

const app = createServer();

app.use(limit({ max: 100, windowMs: 60_000 }));

app.get("/health", (_req, res) => res.send("ok"));

app.listen(3000);
`,
  "tests/limit.test.ts": `import { describe, expect, it } from "vitest";
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
  "CHANGELOG.md": `# Changelog

## 2.0.0

- Token bucket replaces the fixed window
- \`limit\` takes \`capacity\` and \`refillPerSec\`
`,
  "README.md": `# ratelimit

Tiny token-bucket rate limiter for HTTP handlers.

## Over the limit

\`\`\`mermaid
flowchart LR
  R[Request] --> T{Over the limit?}
  T -- no --> N[Handler]
  T -- yes --> W[429]
\`\`\`

> [!TIP]
> Clients get a **429** and wait for \`Retry-After\`.

## Usage

\`\`\`ts
app.use(limit({ capacity: 20, refillPerSec: 5 }));
\`\`\`

| Option | Default | Meaning |
| --- | --- | --- |
| \`capacity\` | 20 | Requests in a burst |
| \`refillPerSec\` | 5 | Tokens back per second |
`,
  "src/client.ts": `export function clientIp(forwarded: string, peer: string) {
  const first = forwarded.split(",")[0]?.trim();
  return first || peer;
}
`,
  "src/limiter.ts": `import type { Next, Req, Res } from "./http";

export interface Options {
  capacity: number;
  refillPerSec: number;
  keyOf?: (req: Req) => string;
}

interface Bucket {
  tokens: number;
  at: number;
}

const byIp = (req: Req) => req.ip;

export function byHeader(name: string) {
  return (req: Req): string => {
    const value = req.headers[name.toLowerCase()];
    return value ?? req.ip;
  };
}

export function tokenBucket(opts: Options) {
  const { capacity, refillPerSec } = opts;
  const buckets = new Map<string, Bucket>();

  return (key: string): number => {
    const now = Date.now();
    const full = { tokens: capacity, at: now };
    const b = buckets.get(key) ?? full;
    const refill = ((now - b.at) / 1000) * refillPerSec;
    b.tokens = Math.min(capacity, b.tokens + refill);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return (1 - b.tokens) / refillPerSec;
    b.tokens -= 1;
    return 0;
  };
}

export function exempt(paths: string[]) {
  const skipped = new Set(paths);
  return (req: Req): boolean => {
    if (skipped.has(req.path)) return true;
    if (req.path === "/login") return true;
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
  "src/routes/auth.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function auth(router: Router) {
  router.use("/login", limit({ capacity: 5, refillPerSec: 0.1 }));
}
`,
  "src/routes/billing.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function billing(router: Router) {
  router.use("/invoices", limit({ capacity: 30, refillPerSec: 0.5 }));
}
`,
  "src/routes/search.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function search(router: Router) {
  router.use("/search", limit({ capacity: 20, refillPerSec: 1 }));
}
`,
  "src/routes/uploads.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function uploads(router: Router) {
  router.use("/uploads", limit({ capacity: 4, refillPerSec: 0.2 }));
}
`,
  "src/routes/webhooks.ts": `import { limit } from "../limiter";
import type { Router } from "../serve";

export function webhooks(router: Router) {
  router.use("/hooks", limit({ capacity: 100, refillPerSec: 10 }));
}
`,
  "src/server.ts": `import { createServer } from "./serve";
import { limit } from "./limiter";

const app = createServer();

app.use(limit({ capacity: 20, refillPerSec: 5 }));

app.get("/health", (_req, res) => res.send("ok"));

app.listen(3000);
`,
  "tests/limit.test.ts": `import { describe, expect, it, vi } from "vitest";
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

const linesOf = (path: string) => after[path].split("\n");
export const lineOf = (path: string, code: string) => linesOf(path).findIndex((l) => l.includes(code)) + 1;
const range = (path: string, firstLineHas: string, lastLineHas: string, linesAfterLast = 0, extra: object = {}) => {
  const start = lineOf(path, firstLineHas);
  return { path, lines: [start, lineOf(path, lastLineHas) + linesAfterLast], code: linesOf(path)[start - 1], ...extra };
};

const notes = {
  format: 2,
  asked: "Clients behind our proxy keep getting blocked after short bursts, can the limiter let those through?",
  summary: "Swaps the limiter for a token bucket, so short bursts get through.",
  sections: [
    {
      title: "A client over the limit",
      before: "```\nHTTP/1.1 429 Too Many Requests\n```\nNo hint when to come back, so clients retry at once.",
      after: "```\nHTTP/1.1 429 Too Many Requests\nRetry-After: 2\n```\nWaiting that long always gets through.",
    },
  ],
  decisions: [
    "Renamed the options to capacity and refillPerSec, because max and windowMs mean nothing for a bucket.",
    "Kept one bucket per process, since nothing here runs more than one.",
  ],
  chapters: [
    {
      title: "A token bucket per client",
      text: "Short bursts pass, because tokens build up while a client is quiet.",
      ranges: [
        range("src/limiter.ts", "export interface Options", "at: number;", 1, {
          note: "Two numbers replace the window: burst size and refill rate.",
        }),
        range("src/limiter.ts", "export function tokenBucket", "return 0;", 2, {
          note: "An empty bucket says how long to wait.",
        }),
      ],
    },
    {
      title: "The real client address",
      text: "Every client behind the proxy was sharing one bucket.",
      ranges: [
        range("src/client.ts", "const first", "const first", 0, {
          note: "The client comes first, so check your proxy overwrites this header.",
          warn: true,
        }),
      ],
    },
    {
      title: "Telling clients when to retry",
      text: "A client that waits as told always gets through.",
      ranges: [
        range("src/limiter.ts", "export function limit", "res.status(429)", 2, {
          note: "Retry-After rounds up to whole seconds, so waiting it out can't land just short.",
        }),
        range("README.md", "## Over the limit", "Retry-After"),
      ],
    },
    {
      title: "New options for callers",
      text: "The server, every route and the README move from max and windowMs to capacity and refillPerSec.",
      skim: true,
      ranges: [
        range("src/server.ts", "app.use(limit", "app.use(limit"),
        "src/routes/auth.ts",
        "src/routes/billing.ts",
        "src/routes/search.ts",
        "src/routes/uploads.ts",
        "src/routes/webhooks.ts",
        range("README.md", "Tiny token-bucket", "Tiny token-bucket"),
        range("README.md", "app.use(limit", "Tokens back per second"),
        "CHANGELOG.md",
      ],
    },
    { title: "Tests", text: "Covers a burst followed by a wait, and refilling with fake timers.", skim: true, ranges: ["tests/limit.test.ts"] },
  ],
};

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
  const path = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "moire/notes.json"], { encoding: "utf8" }).trim();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(notes, null, 2));
}
