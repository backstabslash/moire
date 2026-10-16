---
name: moire-notes
description: Write moire notes, chapters that walk a reviewer through your uncommitted changes beside the diff in moire. Use after making code changes in a git repo the user reviews in moire, before handing back, or when asked to write or update moire notes or chapters.
---

# moire notes

Notes walk a reviewer through a change you made, as a few chapters. Each chapter is one behaviour of the change and lists the code that makes it up, across files. moire shows the chapters beside the diff in your order, and the reviewer can stage a chapter once they've read it. Every changed line should belong to exactly one chapter. moire lists lines that don't.

## When

Write notes when you've finished a change, before handing back to the user. Skip them if nothing is left uncommitted.

## File

Find the path from inside the repo:

```sh
git rev-parse --git-path moire/notes.json
```

It's in the git folder, so it never shows up as a change, and moire reloads it as soon as it changes. Create the `moire` folder if it's missing, and write the whole file each time, ideally to a temporary file renamed over it, so moire never reads half of it.

The file tells the story of everything uncommitted, not just your last task. If it exists, read it first and update it: keep chapters that are still true, rewrite the ones your work changed, and add chapters for new work. Don't delete chapters about code you didn't touch, but do remove ones whose changes were discarded: moire keeps them, marked "No changes left". Leave committed work alone: when a commit lands, moire moves the chapters it finished onto that commit by itself.

```json
{
  "summary": "Retries failed fetches with backoff, because the API drops about 1 in 50 requests under load.",
  "chapters": [
    {
      "title": "Retrying failed requests",
      "text": "GET requests retry 3 times with backoff, then rethrow the last error unchanged, so callers see the same errors as before.",
      "ranges": [
        "src/api/retry.ts",
        { "path": "src/api/client.ts", "lines": [46, 55], "code": "export async function getJson<T>(path: string) {" },
        { "path": "src/api/client.ts", "lines": [61, 61], "code": "  return withRetry(() => post(path, body));", "note": "A POST that timed out may have gone through, so retrying it can submit an order twice.", "warn": true }
      ]
    },
    { "title": "Tests", "text": "Covers backoff timing with fake timers, and that a 4xx isn't retried.", "ranges": ["src/api/retry.test.ts"] }
  ]
}
```

- Every chapter needs a `title` and at least one range, or moire skips it.
- A range is a path, relative to the repo root, for all of that file's changes, or `path` with `lines` (first and last, in the new version) when a file's changes are split across chapters.
- `code` is the range's first line, copied exactly. moire uses it to find the range again when lines above it change.
- `note` pins a sentence to just those lines, for the one thing a reader wouldn't guess. Most ranges have none.
- `warn` marks something the reviewer must check themselves. Use it once or twice per change at most.

## Writing them

- Split by behaviour, not by file or function: "retrying failed requests", "showing the error to the user". One chapter usually touches several files.
- Order chapters the way you'd explain the change at a desk: the data or entry point first, then what builds on it, tests last.
- A chapter's text is two or three sentences. Say what the code now does from the outside, then what it relies on or what you chose not to do. Never walk through the lines.
- Three to seven chapters for a typical change. Imports, renames and formatting go in the chapter that uses them, not a chapter of their own.
- Name things: the function, the value, the number. Skip "ensure", "handle", "robust", "improve", "clean" and other words that fit any code.
- The summary is one or two sentences: what changed and why, as you'd tell a colleague.
- Warn about weakened tests, behaviour changes nobody asked for, guesses about data you didn't check, and anything risky to run.

| Instead of | Write |
| --- | --- |
| Adds a retry loop that handles errors robustly. | Retries 3 times because the API drops about 1 in 50 requests under load. |
| Updates the cache logic to improve performance. | Caches for 60s: the sidebar polls every 5s and the API allows 60 requests a minute. |
| This function validates the input and returns an error. | Rejects empty paths here, not in the caller, because three callers skip the check. |
| Chapter "client.ts changes" | Chapter "Retrying failed requests" |
