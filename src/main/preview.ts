import { extname } from "node:path";
import { protocol } from "electron";
import type { SideInfo } from "../shared/types";
import { readBlob } from "./git";

const IMAGE_LIMIT = 50 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

// Only repos the user opened are served: a URL in a reviewed Markdown file could otherwise run git in any folder,
// and a folder's own git config can make git run commands.
const roots = new Set<string>();

export function allowPreviews(root: string): void {
  roots.add(root);
}

// Must run before the app is ready.
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: "moire", privileges: { standard: true, secure: true } }]);
}

// moire://blob/?root=…&side=worktree|index|commit&rev=…&path=… serves one side of an image, for <img> only.
export function handlePreviewProtocol(): void {
  protocol.handle("moire", async (req) => {
    const url = new URL(req.url);
    const q = url.searchParams;
    const type = TYPES[extname(q.get("path") ?? "").toLowerCase()];
    const kind = q.get("side");
    const root = q.get("root") ?? "";
    const rev = q.get("rev") ?? undefined;
    const sideOk = kind === "worktree" || kind === "index" || (kind === "commit" && !!rev && /^[0-9a-f]{40,64}$/.test(rev));
    if (url.host !== "blob" || !type || !roots.has(root) || !sideOk) return new Response(null, { status: 404 });
    const side: SideInfo = { kind, rev, label: "" };
    const buf = await readBlob(root, side, q.get("path") ?? "", IMAGE_LIMIT);
    if (!buf) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" },
    });
  });
}
