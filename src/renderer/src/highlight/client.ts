import type { HighlightRequest, HighlightResponse, TokLines } from "./types";

type Sides = [TokLines | null, TokLines | null];

interface Job {
  request: HighlightRequest;
  background: boolean;
  resolve: ((sides: Sides | null) => void)[];
  partial: ((sides: Sides) => void)[];
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
// One job at a time, so a file the user skipped past can still be dropped before it starts.
const queue: Job[] = [];
const warmed = new Set<string>();
let running: Job | null = null;
let nextId = 0;

worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
  const sides: Sides = [event.data.sides[0] ?? null, event.data.sides[1] ?? null];
  if (!event.data.done) return void running?.partial.forEach((show) => show(sides));
  for (const resolve of running?.resolve ?? []) resolve(sides);
  running = null;
  pump();
};

function pump() {
  if (running) return;
  const urgent = queue.findLastIndex((j) => !j.background);
  [running] = queue.splice(urgent >= 0 ? urgent : 0, 1);
  if (running) worker.postMessage(running.request);
}

interface Options {
  signal?: AbortSignal;
  background?: boolean;
  onPartial?: (sides: Sides) => void;
}

export function highlight(lang: string, a: string | null, b: string | null, opts: Options = {}) {
  return new Promise<Sides | null>((resolve) => {
    const same = running?.request;
    if (same && same.lang === lang && same.texts[0] === a && same.texts[1] === b) {
      running!.resolve.push(resolve);
      if (opts.onPartial) running!.partial.push(opts.onPartial);
      return;
    }
    const job: Job = {
      request: { id: nextId++, lang, texts: [a, b], partial: !!opts.onPartial },
      background: !!opts.background,
      resolve: [resolve],
      partial: opts.onPartial ? [opts.onPartial] : [],
    };
    opts.signal?.addEventListener("abort", () => {
      const i = queue.indexOf(job);
      if (i < 0) return;
      queue.splice(i, 1);
      resolve(null);
    });
    queue.push(job);
    pump();
  });
}

export function warm(lang: string) {
  if (warmed.has(lang)) return;
  warmed.add(lang);
  queue.push({ request: { id: nextId++, lang, texts: [] }, background: true, resolve: [], partial: [] });
  pump();
}
