import { useEffect, useMemo, useState } from "react";
import { strokeLabel } from "../../../shared/keymap";
import type { ClashChoice, ClashDiff, FileTree, SideInfo } from "../../../shared/types";
import { highlight } from "../highlight/client";
import type { TokLines } from "../highlight/types";
import { langFor } from "../model/lang";
import { buildRows, type Layout, type Row, type Scope } from "../model/rows";
import type { Clash, Drag, Slot } from "../useFilesIn";
import { DiffView } from "./DiffView";
import { MAC } from "./Key";
import { formatBytes } from "./Preview";

const A_SIDE: SideInfo = { kind: "worktree", label: "In the repository" };
const B_SIDE: SideInfo = { kind: "worktree", label: "Incoming" };
const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_SIDES = { a: null, b: null };
const GHOST_LIMIT = 400;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shown = (dir: string) => dir || "the repository root";
const items = (n: number) => (n ? plural(n, "item") : "files");
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const attr = (value: string) => `"${CSS.escape(value)}"`;
const noop = () => {};

function keepName(name: string) {
  const dot = name.indexOf(".", 1);
  return dot > 0 ? `${name.slice(0, dot)} copy${name.slice(dot)}` : `${name} copy`;
}

export function ghostTree(tree: FileTree | null, clash: Clash | null): FileTree | null {
  if (!tree || !clash) return tree;
  const have = new Set(tree.files);
  const incoming = clash.plan.items.filter((i) => !have.has(i.dest)).map((i) => i.dest);
  return incoming.length ? { ...tree, files: [...tree.files, ...incoming] } : tree;
}

interface FootProps {
  drag: Drag | null;
  clash: Clash | null;
  writable: boolean;
  ignored: boolean;
  onCancel(): void;
}

export function DropFoot({ drag, clash, writable, ignored, onCancel }: FootProps) {
  if (clash) {
    const left = clash.clashes.length - clash.at;
    return (
      <div className="drop-foot" role="status">
        <span className="drop-note">Copying {plural(clash.plan.items.length, "file")} into</span>
        <span className="drop-to">{shown(clash.plan.dir)}</span>
        <span className="drop-note">{left === 1 ? "1 name clash" : `${left} name clashes`} to decide in the diff.</span>
        <div className="drop-btns">
          <button className="btn" onClick={onCancel}>
            Cancel<kbd>{strokeLabel("Escape", MAC)}</kbd>
          </button>
        </div>
      </div>
    );
  }
  if (!drag) return null;
  if (!writable || drag.target === null) {
    return (
      <div className="drop-foot is-none" role="status">
        <span className="drop-note">{writable ? `Drop on a folder to copy ${items(drag.count)} there.` : "Switch to Unstaged to copy files in"}</span>
      </div>
    );
  }
  return (
    <div className={`drop-foot${ignored ? " is-ignored" : ""}`} role="status">
      <span className="drop-note">Drop to copy {items(drag.count)} into</span>
      <span className="drop-to">{shown(drag.target)}</span>
      <span className="drop-note">{ignored ? "Git ignores this folder, so the copies won't show in Changed." : "The originals stay where they are."}</span>
    </div>
  );
}

export function DropSlots({ drag, slots, writable }: { drag: Drag | null; slots: Slot[]; writable: boolean }) {
  if (drag?.over !== "main") return null;
  return (
    <div className="drop-slots">
      {writable ? (
        <>
          <h2>Copy {items(drag.count)} into…</h2>
          {slots.map((s) => (
            <div key={s.dir} className={`drop-slot${drag.target === s.dir ? " is-hot" : ""}`} data-slot={s.dir}>
              <b>{s.label}</b>
              <code>{s.dir || "/"}</code>
            </div>
          ))}
          <p>Or drop on any folder in the sidebar.</p>
        </>
      ) : (
        <h2>Switch to Unstaged to copy files in</h2>
      )}
    </div>
  );
}

const BAND = "background: var(--b-line); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--b) 45%, transparent);";
const TARGET = "background: var(--b-line); box-shadow: inset 3px 0 0 var(--b); color: var(--b-ink);";
const IGNORED_BAND = "background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--rule) 55%, transparent) 5px 6px);";
const IGNORED_TARGET = "box-shadow: inset 3px 0 0 var(--faint);";
const ROOT = "box-shadow: inset 0 0 0 2px var(--b); background: color-mix(in srgb, var(--b-line) 55%, transparent);";

// Rows match the target by path prefix, which only a stylesheet can say without the tree knowing about drops.
export function DropStyle({ drag, clash, ignored }: { drag: Drag | null; clash: Clash | null; ignored: boolean }) {
  const css = useMemo(() => {
    const rules: string[] = [];
    const target = drag?.over === "side" ? drag.target : null;
    if (target === "") rules.push(`.sidebar .files { ${ROOT} }`);
    else if (target !== null) {
      const q = attr(target);
      rules.push(`.sidebar .files .tree-dir[data-dir^=${q}], .sidebar .files .file[data-path^=${q}] { ${ignored ? IGNORED_BAND : BAND} }`);
      rules.push(`.sidebar .files .tree-dir[data-dir=${q}] { ${ignored ? IGNORED_TARGET : TARGET} }`);
    }
    if (clash) {
      const rows = (clashing: boolean) =>
        clash.plan.items
          .filter((i) => i.clash === clashing)
          .slice(0, GHOST_LIMIT)
          .map((i) => `.sidebar .files .file[data-path=${attr(i.dest)}]`)
          .join(", ");
      const ghost = (list: string, ink: string, kind: string) => {
        if (!list) return;
        rules.push(`:is(${list}) .name { font-style: italic; color: ${ink}; }`);
        rules.push(`:is(${list}) .kind { font-size: 0; } :is(${list}) .kind::before { content: "${kind}"; font-size: 11px; color: ${ink}; }`);
      };
      const fresh = rows(false);
      ghost(fresh, "var(--b-ink)", "+");
      if (fresh) rules.push(`:is(${fresh}) { pointer-events: none; }`);
      ghost(rows(true), "var(--a-ink)", "!");
    }
    return rules.join("\n");
  }, [drag, clash, ignored]);
  return css ? <style>{css}</style> : null;
}

interface BarProps {
  clash: Clash;
  onDecide(choice: ClashChoice, rest: boolean): void;
  onCancel(): void;
}

export function ClashBar({ clash, onDecide, onCancel }: BarProps) {
  const [rest, setRest] = useState(false);
  const item = clash.clashes[clash.at];
  const others = clash.clashes.length - clash.at - 1;
  const name = nameOf(item.dest);
  const all = rest && others > 0;

  // A decision is pending, so other keys would act on the file hidden behind it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const onControl = e.target instanceof HTMLElement && !!e.target.closest("button, input");
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !onControl) {
        e.preventDefault();
        if (!e.repeat) onDecide("replace", all);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onDecide, onCancel, all]);

  return (
    <div className="clash-bar" role="group" aria-label="Name clash">
      <span className="clash-q">
        <code>{name}</code> already exists in <code>{shown(dirOf(item.dest))}</code>
        <small>
          {clash.at + 1} of {clash.clashes.length}
        </small>
      </span>
      {others > 0 && (
        <label>
          <input type="checkbox" checked={rest} onChange={(e) => setRest(e.target.checked)} />
          Same for the other {others}
        </label>
      )}
      <button className="btn" onClick={() => onDecide("skip", all)}>
        Skip
      </button>
      <button className="btn" title={`Copies it as ${keepName(name)}`} onClick={() => onDecide("keep", all)}>
        Keep both
      </button>
      <button className="btn primary" onClick={() => onDecide("replace", all)}>
        Replace<kbd>{strokeLabel("Enter", MAC)}</kbd>
      </button>
    </div>
  );
}

interface ViewProps {
  clash: Clash;
  layout: Layout;
  scope: Scope;
}

export function ClashView({ clash, layout, scope }: ViewProps) {
  const item = clash.clashes[clash.at];
  const [diff, setDiff] = useState<ClashDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusHunk, setFocusHunk] = useState(0);
  const [tokens, setTokens] = useState<[TokLines | null, TokLines | null] | null>(null);

  useEffect(() => {
    let stale = false;
    window.moire.clashDiff(clash.root, item.source, item.dest).then(
      (d) => !stale && setDiff(d),
      (e) => !stale && setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e)),
    );
    return () => {
      stale = true;
    };
  }, [clash.root, item.source, item.dest]);

  useEffect(() => {
    const c = diff?.contents;
    if (!c) return;
    const abort = new AbortController();
    void highlight(langFor(item.dest, c.b ?? c.a), c.a, c.b, { signal: abort.signal }).then((data) => {
      if (data && !abort.signal.aborted) setTokens(data);
    });
    return () => abort.abort();
  }, [diff, item.dest]);

  const rows = useMemo((): Row[] => {
    if (!diff) return [];
    const note = (text: string): Row[] => [{ t: "note", key: "note", text }];
    const sizes = `In the repository, ${formatBytes(diff.sizes[0])}. Incoming, ${formatBytes(diff.sizes[1])}.`;
    if (diff.file.binary) return note(`Binary file, contents not shown. ${sizes}`);
    if (diff.file.tooLarge) return note(`Over 2 MB, contents not shown. ${sizes}`);
    if (!diff.file.hunks.length) return note("The two files are identical.");
    return buildRows(diff.file, diff.contents, { layout, scope, expanded });
  }, [diff, layout, scope, expanded]);

  if (!diff) return <div className="clash-wait">{error}</div>;
  return (
    <DiffView
      file={diff.file}
      rows={rows}
      layout={layout}
      a={A_SIDE}
      b={B_SIDE}
      tokens={tokens}
      focusHunk={focusHunk}
      selection={NO_SELECTION}
      selCol={null}
      wholeHunks={false}
      selLines={0}
      sideLines={NO_SIDES}
      hits={null}
      currentHit={null}
      find={null}
      actions={null}
      onExpand={(key) => setExpanded((cur) => new Set(cur).add(key))}
      onFocusHunk={setFocusHunk}
      onSelect={noop}
      onAct={noop}
      onCopy={noop}
      onCopyLines={noop}
      onCopySide={noop}
      onPickHunk={noop}
      onTextSelect={noop}
      onDiscardFile={noop}
      preview={null}
      onTogglePreview={null}
      blink={null}
      onBlink={noop}
      onMenu={noop}
    />
  );
}
