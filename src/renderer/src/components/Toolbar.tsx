import { useEffect, useRef, useState } from "react";
import type { CommitInfo, CompareMode, SideInfo } from "../../../shared/types";
import type { Layout, Scope } from "../model/rows";
import { Mark } from "./Mark";
import { type ThemeId, ThemePicker } from "./ThemePicker";

export type PickerState = null | "main" | "commit" | "branches";

export const MODE_NAMES: Record<CompareMode["kind"], string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  all: "All since last commit",
  commit: "Commit",
  branches: "Branch vs branch",
};

interface Props {
  root: string | null;
  mode: CompareMode;
  a?: SideInfo;
  b?: SideInfo;
  layout: Layout;
  scope: Scope;
  theme: ThemeId;
  cvd: boolean;
  picker: PickerState;
  onPicker(picker: PickerState): void;
  onMode(mode: CompareMode): void;
  onLayout(layout: Layout): void;
  onScope(scope: Scope): void;
  onTheme(theme: ThemeId): void;
  onCvd(on: boolean): void;
}

export function Toolbar(props: Props) {
  const { root, mode, a, b, layout, scope } = props;
  return (
    <header className="toolbar">
      <div className="brand">
        <Mark />
        moire
      </div>
      {root && (
        <div className="picker">
          <button className="picker-btn" aria-haspopup="listbox" aria-expanded={!!props.picker} onClick={() => props.onPicker(props.picker ? null : "main")}>
            <span>{MODE_NAMES[mode.kind]}</span>
            <svg viewBox="0 0 10 6">
              <path d="M1 1l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.4" />
            </svg>
          </button>
          {a && (
            <span className="slot" title={a.label}>
              <span className="plate-tag tag-a">A</span>
              {a.label}
            </span>
          )}
          {b && (
            <span className="slot" title={b.label}>
              <span className="plate-tag tag-b">B</span>
              {b.label}
            </span>
          )}
          {props.picker && <PickerPop key={props.picker} initial={props.picker} root={root} mode={mode} onMode={props.onMode} onClose={() => props.onPicker(null)} />}
        </div>
      )}
      <div className="spacer" />
      <div className="seg" role="group" aria-label="Scope">
        <button aria-pressed={scope === "changed"} onClick={() => props.onScope("changed")}>
          Changes only
        </button>
        <button aria-pressed={scope === "full"} onClick={() => props.onScope("full")}>
          Full file
        </button>
      </div>
      <div className="seg" role="group" aria-label="Layout">
        <button aria-pressed={layout === "split"} onClick={() => props.onLayout("split")}>
          Split
        </button>
        <button aria-pressed={layout === "unified"} onClick={() => props.onLayout("unified")}>
          Unified
        </button>
      </div>
      <ThemePicker theme={props.theme} cvd={props.cvd} onTheme={props.onTheme} onCvd={props.onCvd} />
    </header>
  );
}

interface PickerPopProps {
  initial: PickerState;
  root: string;
  mode: CompareMode;
  onMode(m: CompareMode): void;
  onClose(): void;
}

function PickerPop({ initial, root, mode, onMode, onClose }: PickerPopProps) {
  const [sub, setSub] = useState<"commit" | "branches" | null>(initial === "commit" || initial === "branches" ? initial : null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!popRef.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const pick = (m: CompareMode) => {
    onMode(m);
    onClose();
  };
  const simple = (kind: "unstaged" | "staged" | "all", key: string, hint: string) => (
    <button role="option" aria-selected={mode.kind === kind} onClick={() => pick({ kind })}>
      {MODE_NAMES[kind]}
      <kbd>{key}</kbd>
      <small>{hint}</small>
    </button>
  );

  return (
    <div className="picker-pop" role="listbox" ref={popRef}>
      {simple("unstaged", "1", "A index, B working tree")}
      {simple("staged", "2", "A HEAD, B index")}
      {simple("all", "3", "A HEAD, B working tree")}
      <div className="sep" />
      <button role="option" aria-selected={mode.kind === "commit"} className={sub === "commit" ? "is-hot" : ""} onClick={() => setSub(sub === "commit" ? null : "commit")}>
        {MODE_NAMES.commit}
        <kbd>4</kbd>
        <small>A parent, B the commit</small>
      </button>
      <button role="option" aria-selected={mode.kind === "branches"} className={sub === "branches" ? "is-hot" : ""} onClick={() => setSub(sub === "branches" ? null : "branches")}>
        {MODE_NAMES.branches}
        <kbd>5</kbd>
        <small>A merge base, B the branch, like a pull request</small>
      </button>
      {sub === "commit" && <CommitList root={root} selected={mode.kind === "commit" ? mode.sha : null} onPick={(sha) => pick({ kind: "commit", sha })} />}
      {sub === "branches" && <BranchForm root={root} mode={mode} onPick={(base, head) => pick({ kind: "branches", base, head })} />}
    </div>
  );
}

function CommitList({ root, selected, onPick }: { root: string; selected: string | null; onPick(sha: string): void }) {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  useEffect(() => {
    window.moire.commits(root, 60).then(setCommits, () => setCommits([]));
  }, [root]);
  return (
    <div className="picker-sub">
      <div className="commit-list">
        {commits === null && <div className="picker-sub-head">Loading commits…</div>}
        {commits?.length === 0 && <div className="picker-sub-head">No commits yet.</div>}
        {commits?.map((c) => (
          <button key={c.sha} role="option" aria-selected={selected === c.sha} onClick={() => onPick(c.sha)}>
            <code>{c.short}</code>
            <span>{c.subject}</span>
            <small>
              {c.author}, {new Date(c.date).toLocaleDateString()}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

function BranchForm({ root, mode, onPick }: { root: string; mode: CompareMode; onPick(base: string, head: string): void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState(mode.kind === "branches" ? mode.base : "");
  const [head, setHead] = useState(mode.kind === "branches" ? mode.head : "");
  useEffect(() => {
    window.moire.branches(root).then((list) => {
      setBranches(list);
      setHead((h) => h || list[0] || "");
      setBase((b) => b || list.find((n) => n === "main" || n === "master") || list.find((n) => n !== list[0]) || list[0] || "");
    });
  }, [root]);
  return (
    <div className="picker-sub">
      <div className="branch-form">
        <span className="plate-tag tag-a">A</span>
        <select value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch">
          {branches.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <span className="plate-tag tag-b">B</span>
        <select value={head} onChange={(e) => setHead(e.target.value)} aria-label="Branch to review">
          {branches.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <button className="btn" disabled={!base || !head} onClick={() => onPick(base, head)}>
          Compare
        </button>
      </div>
    </div>
  );
}
