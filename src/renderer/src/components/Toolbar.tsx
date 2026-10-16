import { useEffect, useRef, useState } from "react";
import type { CommitInfo, CompareMode, Refs, SideInfo } from "../../../shared/types";
import type { Layout, Scope } from "../model/rows";
import { Key, keyText, useKeymap } from "./Key";
import { Mark } from "./Mark";
import { type ThemeId, ThemePicker } from "./ThemePicker";

export type PickerState = null | "main" | "commit" | "branches";
type BranchesMode = Extract<CompareMode, { kind: "branches" }>;
// The commit and branches last compared, so 4 and 5 go back to them instead of asking again.
export interface LastPicked {
  commit?: Extract<CompareMode, { kind: "commit" }>;
  branches?: BranchesMode;
}

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
  autoLayout: boolean;
  scope: Scope;
  theme: ThemeId;
  cvd: boolean;
  picker: PickerState;
  lastPicked: LastPicked;
  onPicker(picker: PickerState): void;
  onMode(mode: CompareMode): void;
  onLayout(layout: Layout): void;
  onScope(scope: Scope): void;
  onTheme(theme: ThemeId): void;
  onCvd(on: boolean): void;
  onSearch(): void;
  // Unset when the repo has no agent notes.
  notes: { open: boolean } | null;
  onNotes(): void;
}

export function Toolbar(props: Props) {
  const { root, mode, a, b, layout, scope } = props;
  const searchKey = keyText(useKeymap(), "search");
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
          {props.picker && (
            <PickerPop
              key={props.picker}
              initial={props.picker}
              root={root}
              mode={mode}
              lastPicked={props.lastPicked}
              onMode={props.onMode}
              onClose={() => props.onPicker(null)}
            />
          )}
        </div>
      )}
      <div className="spacer" />
      {root && (
        <>
          <button className="tool-btn" title={searchKey ? `Search (${searchKey})` : "Search"} onClick={props.onSearch}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="6.8" cy="6.8" r="4.6" />
              <path d="M10.3 10.3L14 14" />
            </svg>
          </button>
          <div className="seg" role="group" aria-label="Scope">
            <button aria-pressed={scope === "changed"} onClick={() => props.onScope("changed")}>
              Changes only
            </button>
            <button aria-pressed={scope === "full"} onClick={() => props.onScope("full")}>
              Full file
            </button>
          </div>
          <div
            className="seg"
            role="group"
            aria-label="Layout"
            title={props.autoLayout ? "Unified while the window is narrow. Click Split to use it anyway." : undefined}
          >
            <button aria-pressed={layout === "split"} onClick={() => props.onLayout("split")}>
              Split
            </button>
            <button aria-pressed={layout === "unified"} className={props.autoLayout ? "is-auto" : undefined} onClick={() => props.onLayout("unified")}>
              Unified
            </button>
          </div>
          {props.notes && (
            <div className="seg">
              <button aria-pressed={props.notes.open} title={props.notes.open ? "Hide agent notes" : "Show agent notes"} onClick={props.onNotes}>
                Notes
                <Key id="notes" />
              </button>
            </div>
          )}
        </>
      )}
      <ThemePicker theme={props.theme} cvd={props.cvd} onTheme={props.onTheme} onCvd={props.onCvd} />
    </header>
  );
}

interface PickerPopProps {
  initial: PickerState;
  root: string;
  mode: CompareMode;
  lastPicked: LastPicked;
  onMode(m: CompareMode): void;
  onClose(): void;
}

function PickerPop({ initial, root, mode, lastPicked, onMode, onClose }: PickerPopProps) {
  const commit = mode.kind === "commit" ? mode : lastPicked.commit;
  const branches = mode.kind === "branches" ? mode : lastPicked.branches;
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
  const simple = (kind: "unstaged" | "staged" | "all", hint: string) => (
    <button role="option" aria-selected={mode.kind === kind} onClick={() => pick({ kind })}>
      {MODE_NAMES[kind]}
      <Key id={kind} />
      <small>{hint}</small>
    </button>
  );

  return (
    <div className="picker-pop" role="listbox" ref={popRef}>
      {simple("unstaged", "A index, B working tree")}
      {simple("staged", "A HEAD, B index")}
      {simple("all", "A HEAD, B working tree")}
      <div className="sep" />
      <button
        role="option"
        aria-selected={mode.kind === "commit"}
        className={sub === "commit" ? "is-hot" : ""}
        onClick={() => setSub(sub === "commit" ? null : "commit")}
      >
        {MODE_NAMES.commit}
        <Key id="commit" />
        <small>A parent, B the commit</small>
      </button>
      <button
        role="option"
        aria-selected={mode.kind === "branches"}
        className={sub === "branches" ? "is-hot" : ""}
        onClick={() => setSub(sub === "branches" ? null : "branches")}
      >
        {MODE_NAMES.branches}
        <Key id="branches" />
        <small>A merge base, B the branch</small>
      </button>
      {sub === "commit" && <CommitList root={root} selected={commit?.sha ?? null} onPick={(sha) => pick({ kind: "commit", sha })} />}
      {sub === "branches" && <BranchForm root={root} last={branches} onPick={(base, head) => pick({ kind: "branches", base, head })} />}
    </div>
  );
}

const COMMIT_LIMIT = 1000;

function CommitList({ root, selected, onPick }: { root: string; selected: string | null; onPick(sha: string): void }) {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    window.moire.commits(root, COMMIT_LIMIT).then(setCommits, () => setCommits([]));
  }, [root]);
  const query = filter.trim().toLowerCase();
  const shown = query ? commits?.filter((c) => c.sha.startsWith(query) || c.subject.toLowerCase().includes(query)) : commits;
  return (
    <div className="picker-sub">
      {!!commits?.length && (
        <input
          autoFocus
          className="commit-filter"
          value={filter}
          placeholder="Filter by subject or sha"
          aria-label="Filter commits"
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown?.[0]) onPick(shown[0].sha);
          }}
        />
      )}
      <div className="commit-list">
        {commits === null && <div className="picker-sub-head">Loading commits…</div>}
        {commits?.length === 0 && <div className="picker-sub-head">No commits yet.</div>}
        {!!commits?.length && !shown?.length && <div className="picker-sub-head">No commits match.</div>}
        {shown?.map((c) => (
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

function BranchForm({ root, last, onPick }: { root: string; last?: BranchesMode; onPick(base: string, head: string): void }) {
  const [refs, setRefs] = useState<Refs | null>(null);
  const [base, setBase] = useState(last?.base ?? "");
  const [head, setHead] = useState(last?.head ?? "");
  useEffect(() => {
    void window.moire.branches(root).then((r) => {
      setRefs(r);
      const head = r.current ?? r.branches[0] ?? "";
      const main = r.branches.find((n) => n !== head && (n === "main" || n === "master"));
      setHead((h) => h || head);
      setBase((b) => b || r.upstream || main || r.branches.find((n) => n !== head) || head);
    });
  }, [root]);
  const select = (value: string, onChange: (value: string) => void, label: string) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {refs && !known(refs, value) && value && <option>{value}</option>}
      {refs?.branches.map((n) => (
        <option key={n}>{n}</option>
      ))}
      {!!refs?.remotes.length && (
        <optgroup label="Remote branches">
          {refs.remotes.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </optgroup>
      )}
      {!!refs?.tags.length && (
        <optgroup label="Tags">
          {refs.tags.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
  return (
    <div className="picker-sub">
      <div className="branch-form">
        <span className="plate-tag tag-a">A</span>
        {select(base, setBase, "Base branch")}
        <span className="plate-tag tag-b">B</span>
        {select(head, setHead, "Branch to review")}
        <button className="btn" disabled={!base || !head} onClick={() => onPick(base, head)}>
          Compare
        </button>
      </div>
    </div>
  );
}

function known(refs: Refs, name: string) {
  return refs.branches.includes(name) || refs.remotes.includes(name) || refs.tags.includes(name);
}
