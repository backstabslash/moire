import type { HighlightRequest, HighlightResponse, TokLines } from "./types";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, (sides: (TokLines | null)[]) => void>();
let nextId = 0;

worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
  pending.get(event.data.id)?.(event.data.sides);
  pending.delete(event.data.id);
};

export function highlight(lang: string, a: string | null, b: string | null) {
  const id = nextId++;
  return new Promise<[TokLines | null, TokLines | null]>((resolve) => {
    pending.set(id, (sides) => resolve([sides[0], sides[1]]));
    worker.postMessage({ id, lang, texts: [a, b] } satisfies HighlightRequest);
  });
}
