import { useEffect, useMemo, useRef, useState } from "react";
import type { ClashChoice, CopyItem, CopyPlan, FileTree, RepoInfo } from "../../shared/types";
import type { FilesView } from "./components/Sidebar";

const OPEN_MS = 500;
const DRAG_QUIET_MS = 300;

export interface Drag {
  count: number;
  over: "side" | "main" | null;
  target: string | null;
}

export interface Clash {
  root: string;
  plan: CopyPlan;
  clashes: CopyItem[];
  at: number;
  decisions: Record<string, ClashChoice>;
}

export interface Slot {
  label: string;
  dir: string;
}

interface Options {
  repo: RepoInfo | null;
  writable: boolean;
  tree: FileTree | null;
  view: FilesView;
  onView(view: FilesView): void;
  open: string | null;
  notify(text: string, undo?: boolean): void;
  startActing(): void;
  settle(): void;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
const chain = (dir: string) => dir.split("/").flatMap((_, i, parts) => (i < parts.length - 1 ? [parts.slice(0, i + 1).join("/") + "/"] : []));

function rowHoldingFolder(dir: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.sidebar .files [data-dir="${CSS.escape(dir)}"]`)?.closest<HTMLElement>(".tree-dir") ?? null;
}

function openFolders(dir: string, frames = 60) {
  for (const d of chain(dir)) {
    const row = rowHoldingFolder(d);
    if (row?.getAttribute("aria-expanded") === "true") continue;
    if (row) row.click();
    if (frames > 0) requestAnimationFrame(() => openFolders(dir, frames - 1));
    return;
  }
}

export function isIgnored(tree: FileTree | null, dir: string): boolean {
  return !!dir && !!tree?.ignored.some((d) => d.endsWith("/") && dir.startsWith(d));
}

export function useFilesIn(opts: Options) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [clash, setClash] = useState<Clash | null>(null);
  const [lastDir, setLastDir] = useState<string | null>(null);
  const latest = useRef({ opts, drag, clash });
  latest.current = { opts, drag, clash };
  const sprung = useRef(false);

  const springBack = (stay = false) => {
    if (sprung.current && !stay) latest.current.opts.onView("changed");
    sprung.current = false;
  };

  const finish = async (root: string, plan: CopyPlan, decisions: Record<string, ClashChoice>) => {
    const { notify, startActing, settle } = latest.current.opts;
    startActing();
    try {
      const result = await window.moire.copyIn(root, plan, decisions);
      notify(result.text, result.copied > 0);
      springBack(plan.ignored && result.copied > 0);
    } catch (e) {
      notify(errorText(e));
      springBack();
    }
    settle();
  };

  const start = async (sources: string[], dir: string) => {
    const { repo, writable, notify, view, onView } = latest.current.opts;
    if (latest.current.clash) return;
    if (!repo || !sources.length) return springBack();
    if (!writable) {
      notify("Switch to Unstaged to copy files in");
      return springBack();
    }
    let plan: CopyPlan;
    try {
      plan = await window.moire.planCopy(repo.root, sources, dir);
    } catch (e) {
      notify(errorText(e));
      return springBack();
    }
    setLastDir(dir);
    const clashes = plan.items.filter((i) => i.clash);
    if (!clashes.length) return finish(repo.root, plan, {});
    if (view === "changed") {
      sprung.current = true;
      onView("all");
    }
    setClash({ root: repo.root, plan, clashes, at: 0, decisions: {} });
    openFolders(dirOf(clashes[0].dest));
  };

  const decide = (choice: ClashChoice, rest: boolean) => {
    const c = latest.current.clash;
    if (!c) return;
    const decisions = { ...c.decisions };
    for (const item of rest ? c.clashes.slice(c.at) : [c.clashes[c.at]]) decisions[item.dest] = choice;
    const at = rest ? c.clashes.length : c.at + 1;
    if (at < c.clashes.length) return setClash({ ...c, at, decisions });
    setClash(null);
    void finish(c.root, c.plan, decisions);
  };

  const cancel = () => {
    setClash(null);
    latest.current.opts.notify("Nothing was copied.");
    springBack();
  };

  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    let depth = 0;
    let hover: { dir: string | null; timer: number } = { dir: null, timer: 0 };
    let draggingOwnRowOut = false;
    let lastOut = "";
    let lastOver = 0;
    const update = (next: Drag | null) => setDrag((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    const holdOver = (dir: string | null) => {
      if (dir === hover.dir) return;
      clearTimeout(hover.timer);
      const open = () => {
        const row = dir === null ? null : rowHoldingFolder(dir);
        if (row?.getAttribute("aria-expanded") === "false") row.click();
      };
      hover = { dir, timer: dir === null ? 0 : window.setTimeout(open, OPEN_MS) };
    };
    const end = () => {
      depth = 0;
      holdOver(null);
      update(null);
    };
    const takes = (e: DragEvent) => hasFiles(e) && !draggingOwnRowOut && !latest.current.clash;
    const outside = (e: DragEvent) => e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight;

    const enter = (e: DragEvent) => {
      if (!takes(e)) return;
      e.preventDefault();
      lastOver = performance.now();
      if (depth++ === 0 && !latest.current.drag) update({ count: e.dataTransfer!.items.length, over: null, target: null });
    };
    // Counting can miss a leave when a hovered row re-renders, so leaving through the window's edge also ends the drag.
    const leave = (e: DragEvent) => {
      if (!takes(e) || (--depth > 0 && !outside(e))) return;
      end();
      springBack();
    };
    // A mouse move once drag events stop means the drag ended elsewhere; macOS also sends them mid-drag.
    const moved = () => {
      if (!latest.current.drag || performance.now() - lastOver < DRAG_QUIET_MS) return;
      end();
      springBack();
    };
    const aim = (e: DragEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      let aimed: Pick<Drag, "over" | "target"> = { over: null, target: null };
      let row: HTMLElement | null = null;
      if (el?.closest(".sidebar")) {
        row = el.closest<HTMLElement>(".files [data-dir], .files .file[data-path]");
        aimed = { over: "side", target: row ? (row.dataset.dir ?? dirOf(row.dataset.path!)) : el.closest(".files") ? "" : null };
      } else if (el?.closest(".drop-slots, .main, .empty-state, .loading")) {
        aimed = { over: "main", target: el.closest<HTMLElement>("[data-slot]")?.dataset.slot ?? null };
      }
      if (!latest.current.opts.writable) aimed.target = null;
      return { ...aimed, row };
    };
    const over = (e: DragEvent) => {
      e.preventDefault();
      const { drag } = latest.current;
      if (!takes(e) || !drag) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
        return;
      }
      lastOver = performance.now();
      const { over: where, target, row } = aim(e);
      const { view, onView } = latest.current.opts;
      if (where === "side" && view === "changed") {
        sprung.current = true;
        onView("all");
      }
      holdOver(row?.closest(".tree-dir")?.getAttribute("aria-expanded") === "false" ? row.dataset.dir! : null);
      e.dataTransfer!.dropEffect = target === null ? "none" : "copy";
      update({ ...drag, over: where, target });
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      if (draggingOwnRowOut) {
        draggingOwnRowOut = false;
        return;
      }
      if (!takes(e)) return;
      const { target } = aim(e);
      end();
      if (target === null) return springBack();
      let paths: string[];
      try {
        paths = window.moire.droppedPaths([...e.dataTransfer!.files]);
      } catch (err) {
        latest.current.opts.notify(errorText(err));
        return springBack();
      }
      if (paths.length === 1 && paths[0] === lastOut) return springBack();
      void startRef.current(paths, target);
    };
    const dragOut = (e: DragEvent) => {
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>(".sidebar .file[data-path]") : null;
      const repo = latest.current.opts.repo;
      if (!row || !repo) return;
      e.preventDefault();
      draggingOwnRowOut = true;
      lastOut = `${repo.root}/${row.dataset.path}`;
      void window.moire
        .dragFile(repo.root, row.dataset.path!)
        .catch(() => {})
        .finally(() => {
          if (window.moire.platform !== "darwin") draggingOwnRowOut = false;
        });
    };
    const settled = () => {
      draggingOwnRowOut = false;
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    document.addEventListener("dragstart", dragOut);
    window.addEventListener("mousemove", moved);
    // macOS hands the drag to the system and returns at once, so the next click or focus change ends it.
    window.addEventListener("pointerdown", settled);
    window.addEventListener("blur", settled);
    return () => {
      end();
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
      document.removeEventListener("dragstart", dragOut);
      window.removeEventListener("mousemove", moved);
      window.removeEventListener("pointerdown", settled);
      window.removeEventListener("blur", settled);
    };
  }, []);

  useEffect(() => {
    if (clash && clash.root !== opts.repo?.root) setClash(null);
  }, [clash, opts.repo?.root]);

  const open = opts.open;
  const slots = useMemo(() => {
    const near = open === null ? null : dirOf(open);
    const out: Slot[] = near === null ? [] : [{ label: "Next to the open file", dir: near }];
    if (lastDir !== null && lastDir !== near) out.push({ label: "Last used", dir: lastDir });
    if (!out.some((s) => s.dir === "")) out.push({ label: "Repository root", dir: "" });
    return out;
  }, [open, lastDir]);

  const paste = async () => {
    const paths = await window.moire.clipboardFiles().catch(() => []);
    if (!paths.length) return;
    const focused = document.activeElement?.closest<HTMLElement>(".sidebar .tree-dir[data-dir]")?.dataset.dir;
    const active = latest.current.opts.open;
    await startRef.current(paths, focused ?? (active ? dirOf(active) : ""));
  };

  const pickInto = async (dir: string) => {
    const paths = await window.moire.pickFiles();
    if (paths.length) await startRef.current(paths, dir);
  };

  return { drag, clash, slots, paste, pickInto, decide, cancel };
}
