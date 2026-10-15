import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { shell } from "electron";

const RUNNABLE = new Set(
  "app appimage bat cmd com command cpl desktop exe fileloc hta inetloc jar jnlp js jse lnk mpkg msi pif pkg ps1 py pyw reg run scr sh terminal tool url vbe vbs webloc workflow ws wsf"
    .split(" ")
    .map((ext) => `.${ext}`),
);

export function openRefusal(file: string): string | null {
  const name = file.split(/[\\/]/).pop();
  if (!existsSync(file)) return `${name} isn't on disk`;
  const real = realpathSync(file);
  const stat = statSync(real);
  const runs = `${name} could run as a program, so moire won't open it`;
  if ([file, real].some((p) => RUNNABLE.has(extname(p).toLowerCase()))) return runs;
  if (stat.isDirectory()) return `${name} is a folder`;
  if (!stat.isFile()) return `${name} isn't a regular file`;
  const head = readHead(real);
  // Desktops sniff Windows programs by content, and Wine runs them whatever the extension.
  if (head.startsWith("MZ")) return runs;
  // exFAT, NTFS and FAT mounts mark every file executable, so the bit alone refuses ordinary documents there.
  if (process.platform !== "win32" && stat.mode & 0o111 && (!extname(real) || MAGIC.some((m) => head.startsWith(m)))) {
    return `${name} is executable, so moire won't open it`;
  }
  return null;
}

const MAGIC = ["#!", "\x7fELF", "\xfe\xed\xfa\xce", "\xfe\xed\xfa\xcf", "\xce\xfa\xed\xfe", "\xcf\xfa\xed\xfe", "\xca\xfe\xba\xbe"];

function readHead(path: string): string {
  const head = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    return head.subarray(0, readSync(fd, head, 0, 4, 0)).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

export function revealFile(root: string, path: string): void {
  const abs = join(root, path);
  if (!existsSync(abs)) throw new Error(`${path.split("/").pop()} isn't on disk`);
  shell.showItemInFolder(abs);
}

export async function openWithDefault(root: string, path: string): Promise<void> {
  const abs = join(root, path);
  const refusal = openRefusal(abs);
  if (refusal) throw new Error(refusal);
  const error = await shell.openPath(abs);
  if (error) throw new Error(error);
}
