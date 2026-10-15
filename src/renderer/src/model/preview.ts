import type { FileDiff, SideInfo } from "../../../shared/types";

export type PreviewKind = "image" | "markdown";

const RASTER = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const MARKDOWN = new Set(["md", "markdown"]);

export function previewOf(file: FileDiff): { kind: PreviewKind; forced: boolean } | null {
  const ext = file.path.split("/").pop()!.toLowerCase().split(".").slice(1).pop() ?? "";
  if (RASTER.has(ext)) return file.binary ? { kind: "image", forced: true } : null;
  if (ext === "svg") return file.binary ? null : { kind: "image", forced: !!file.tooLarge };
  if (MARKDOWN.has(ext) && !file.binary && !file.tooLarge) return { kind: "markdown", forced: false };
  return null;
}

export function sidePaths(file: Pick<FileDiff, "path" | "oldPath" | "status">): [string | null, string | null] {
  const isNew = file.status === "added" || file.status === "untracked" || file.status === "unchanged";
  return [isNew ? null : (file.oldPath ?? file.path), file.status === "deleted" ? null : file.path];
}

export function blobUrl(root: string, side: SideInfo, path: string, version: string): string | null {
  if (side.kind === "empty") return null;
  const q = new URLSearchParams({ root, side: side.kind, path, v: version });
  if (side.rev) q.set("rev", side.rev);
  return `moire://blob/?${q}`;
}

export function resolveRelative(from: string, link: string): string | null {
  if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/") || link.startsWith("#")) return null;
  const parts = from.split("/").slice(0, -1);
  let path: string;
  try {
    path = decodeURI(link.split(/[?#]/)[0]);
  } catch {
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
  added: Map<number, number>;
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
