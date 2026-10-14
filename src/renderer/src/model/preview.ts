import type { FileDiff, SideInfo } from "../../../shared/types";

export type PreviewKind = "image" | "markdown";

const RASTER = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const MARKDOWN = new Set(["md", "markdown"]);

// What a file can be previewed as; forced when there's no text diff to fall back to.
export function previewOf(file: FileDiff): { kind: PreviewKind; forced: boolean } | null {
  const ext = file.path.split("/").pop()!.toLowerCase().split(".").slice(1).pop() ?? "";
  if (RASTER.has(ext)) return file.binary ? { kind: "image", forced: true } : null;
  if (ext === "svg") return file.binary ? null : { kind: "image", forced: !!file.tooLarge };
  if (MARKDOWN.has(ext) && !file.binary && !file.tooLarge) return { kind: "markdown", forced: false };
  return null;
}

// Paths of the file on each side, or null where it doesn't exist.
export function sidePaths(file: Pick<FileDiff, "path" | "oldPath" | "status">): [string | null, string | null] {
  const isNew = file.status === "added" || file.status === "untracked";
  return [isNew ? null : (file.oldPath ?? file.path), file.status === "deleted" ? null : file.path];
}

// A URL for <img> that serves one side of a file; version changes whenever the diff does, so stale images aren't reused.
export function blobUrl(root: string, side: SideInfo, path: string, version: string): string | null {
  if (side.kind === "empty") return null;
  const q = new URLSearchParams({ root, side: side.kind, path, v: version });
  if (side.rev) q.set("rev", side.rev);
  return `moire://blob/?${q}`;
}

// Resolves a link in a Markdown file against the file's folder; null for anything that isn't a plain relative path.
export function resolveRelative(from: string, link: string): string | null {
  if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/") || link.startsWith("#")) return null;
  const parts = from.split("/").slice(0, -1);
  let path: string;
  try {
    path = decodeURI(link.split(/[?#]/)[0]);
  } catch {
    // a malformed escape like %E9 from a Latin-1 file name
    return null;
  }
  for (const part of path.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

export interface ChangeMarks {
  // new-side line number of each added line, with its hunk
  added: Map<number, number>;
  // new-side line each run of removed lines sat just before, with its hunk
  cuts: Map<number, number>;
}

export function changeMarks(file: FileDiff): ChangeMarks {
  const added = new Map<number, number>();
  const cuts = new Map<number, number>();
  file.hunks.forEach((hunk, h) => {
    let next = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "del") {
        if (!cuts.has(next)) cuts.set(next, h);
        continue;
      }
      if (line.kind === "add") added.set(line.newNo!, h);
      next = line.newNo! + 1;
    }
  });
  return { added, cuts };
}
