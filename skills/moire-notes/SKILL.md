---
name: moire-notes
description: Write moire notes, chapters that walk a human reviewer through your changes beside the diff in moire. Use after changing code in a git repo the user reviews in moire, which a `moire` folder in its git directory shows, before committing or handing back, even if nobody mentions notes. Also use when asked to write or update moire notes or chapters.
---

# moire notes

Notes walk a person through a change you made, beside the diff. They open with a brief: what was asked, what changed, what you decided, what to check. Then come chapters, each one behaviour of the change, made of steps. A step is one sentence and the code it's about: moire shows the sentence above the code while the reviewer presses `.` to walk, and they can stage a chapter once they've read it.

That reviewer often doesn't know this code, and they tire quickly. If they'd have to read a sentence twice, rewrite it.

## Writing them

The notes describe one finished change against its base, not the session that produced it. They should read as if written once, so a bug introduced and fixed before committing goes unmentioned.

- Lead with what changes for someone using this, in plain words. Then name the function, the value or the number where it helps them find it.
- Split by behaviour, not by file: "retrying failed requests", "showing the error to the user". Small imports, renames and formatting go in the chapter that uses them, and a sweeping one gets its own `skim` chapter.
- Write at most seven chapters, counted across the whole file on every update. If the work won't fit, it's several changes: merge chapters, and tell the user it would read better as separate commits.
- Order chapters the way you'd explain the change at a desk: the data or entry point first, then what builds on it, tests last.
- Give each chapter one sentence of text, on why it exists or what it means from the outside, then one to four steps.
- Keep each step to one sentence of 25 words at most. Write what the reader can't get from the code: why, what it relies on, what you ruled out.
- Put steps in reading order. They may jump between files.
- Point at lines. A whole-file range gives no guidance inside it, so use one only for new or small files.
- Keep the summary to one or two sentences: what changed and why, as you'd tell a colleague.
- Warn about weakened tests, turned-off lint or type checks, hardcoded credentials, behaviour changes nobody asked for, guesses about data you didn't check, and anything risky to run. moire doesn't check for these, so your warning is the only one the reviewer gets.

| Instead of | Write |
| --- | --- |
| Updates the cache logic to improve performance. | Caches for 60s: the sidebar polls every 5s and the API allows 60 requests a minute. |
| This function validates the input and returns an error. | Rejects empty paths here, not in the caller, because three callers skip the check. |

## When and where

Write notes when you've finished a change, before committing or handing back. If you commit as you go, write them before each commit: moire moves finished chapters onto the commit that lands them, and a branch review stitches them back together in commit order.

Get the path from inside the repo. It's in the git folder, so it never shows up as a change.

```sh
git rev-parse --git-path moire/notes.json
```

Create the `moire` folder if it's missing. Write the whole file to a temporary file in the same folder, check that it parses, because one bad escape hides every note, then rename it over this one, because moire reloads on every change and shouldn't read half of it.

The file covers everything uncommitted, not just your last task. If it exists, read all of it, then rewrite it:

- Fold fixes and review rounds into the chapter that owns that code, and add a chapter only for a new behaviour.
- Keep what's true about code you didn't touch.
- Remove chapters whose changes were discarded, or moire keeps them, marked "No changes left".
- Leave committed work alone. moire moves it by itself.

## Format

```json
{
  "format": 2,
  "asked": "Fetches keep failing under load, can we retry them?",
  "summary": "Retries failed fetches with backoff, because the API drops about 1 in 50 requests under load.",
  "decisions": ["Only GETs retry. A POST that timed out may have gone through, so retrying could submit an order twice."],
  "chapters": [
    {
      "title": "Retrying failed requests",
      "text": "Callers see the same errors as before, just less often.",
      "ranges": [
        { "path": "src/api/retry.ts", "lines": [8, 30], "code": "export async function withRetry<T>(run: () => Promise<T>) {", "note": "Tries 3 times with backoff, then rethrows the last error unchanged." },
        { "path": "src/api/retry.ts", "lines": [34, 41], "code": "function isRetryable(e: unknown) {" },
        { "path": "src/api/client.ts", "lines": [46, 55], "code": "export async function getJson<T>(path: string) {", "note": "Every GET now goes through `withRetry`, so no caller changes." },
        { "path": "src/api/client.ts", "lines": [61, 61], "code": "  return post(path, body);", "note": "`postJson` stays as it was. Check this matches what you wanted.", "warn": true }
      ]
    },
    { "title": "Tests", "text": "Backoff timing with fake timers, and that a 4xx isn't retried.", "skim": true, "ranges": ["src/api/retry.test.ts"] }
  ]
}
```

- `format` is always 2. Without it, each `note` applies only to its own range, as in notes from older versions of this skill.
- `asked` is the request in the user's own words, one or two sentences.
- `decisions` lists calls the reviewer might have made differently, at most four. Leave it out if you made none.
- A chapter with no `title` or no range is skipped.
- A range is a path, relative to the repo root, for all of that file's changes, or an object as above. `lines` are first and last, counted from 1, in the new version, and a range with anything else there is left out. A deletion belongs to the line after it, so point at that line and copy it as `code`, or at the last line if the deletion ends the file. Use a bare path for a deleted file, and the new path for a renamed one.
- `code` is the range's first line, copied exactly. moire uses it to find the range again when lines above it change.
- `note` starts a step, and carries over the ranges after it until the next `note`. Before the first `note`, moire shows the chapter's `text`. `.` moves by step and `>` by place inside a step. Ranges without a `note` that start within about a screen below the last place in one file share it, and anything else adds a place, so put the lines that matter first and keep a step to one or two files.
- `warn` marks what the reviewer must check themselves, and moire lists these in the brief. Use it once or twice per change, or it stops meaning anything. A `warn` on lines nobody changed keeps its chapter open until it's committed, since staging can't finish it.
- `skim` folds a chapter that needs only a quick look, like tests, docs, generated files or mechanical renames, and `.` passes over it. Don't set it on code you'd want read. A `warn` overrides it, and moire spots whitespace-only chapters by itself.
- Cover every changed line, in one chapter only. moire lists lines in no chapter, but not overlaps.
- Outside sections, backticks are the only formatting, and `asked` shows as written.

## If a change needs more than chapters

Add `sections` for what the fields above can't hold. At the top level they show in the brief, and on a chapter they show in the brief and beside its code. Most changes need none or one, and a section has to teach something the diff can't.

```json
{
  "sections": [
    { "title": "A client over the limit", "before": "```\nHTTP/1.1 429\n```", "after": "```\nHTTP/1.1 429\nRetry-After: 2\n```" },
    { "title": "What retries and what doesn't", "body": "| Request | Retries |\n| --- | --- |\n| GET | 3 |\n| POST | 0 |\n" }
  ]
}
```

- `title` is optional, then give a `body`, a `before` and `after`, or both. `body`, `before` and `after` are Markdown, including images as `![caption](name.png)` from the media folder.
- Use `before` and `after` to show a change in behaviour: command output, an API response, a pair of screenshots. Paste real output you ran, and never make it up.
- Use `body` for what has no home elsewhere: a table of cases, a rollout order, what you ruled out.
- Images in sections get no out-of-date flag. Use `screenshots` when that matters.

## If a chapter changes what someone sees

Show it instead of describing it. Save images in the media folder, then list them on the chapter:

```sh
echo "$(git rev-parse --git-common-dir)/moire/media"
```

```json
{ "title": "Empty state", "text": "...", "ranges": ["src/Empty.tsx"], "screenshots": [{ "file": "empty-dark.png", "caption": "No repo open, dark theme" }] }
```

- `file` is a bare name of letters, digits, `_`, `.` or `-`, in PNG, JPEG, GIF or WebP. The folder is shared, so pick a name unique across chapters.
- Take them from the real app, after your last edit to that chapter's files. moire flags a screenshot as out of date when those files change later.
- `caption` says what to look at, in one line. One or two per chapter is enough.
- Screenshots stay on this machine, but don't capture secrets or personal data.

## If the commit is already made

Write notes for a commit you made without them. Skip commits you didn't make. The format is the same, but the file is per commit and the line numbers are that commit's:

```sh
echo "$(git rev-parse --git-common-dir)/moire/commits/$(git rev-parse HEAD).json"
```

Create the `commits` folder if it's missing. Use the full hash of the commit you're describing, which isn't always `HEAD`. If the file exists, read it first and add to it.
