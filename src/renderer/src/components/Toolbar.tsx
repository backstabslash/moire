import { useEffect, useRef, useState } from "react";
import type { CommitInfo, CompareMode, Refs, SideInfo } from "../../../shared/types";
import type { Layout, Scope } from "../model/rows";
import { timeAgo } from "../model/time";
import { AgentChip, Avatar } from "./Avatar";
import { Icon, type IconName } from "./Icon";
import { Key, keyText, useKeymap } from "./Key";
import { Mark } from "./Mark";
import { type ThemeId, ThemePicker } from "./ThemePicker";

export type PickerState = null | "main" | "commit" | "branches";
type BranchesMode = Extract<CompareMode, { kind: "branches" }>;
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

const MODE_ICONS: Record<CompareMode["kind"], IconName> = {
  unstaged: "unstage",
  staged: "stage",
  all: "all",
  commit: "commit",
  branches: "branch",
};

interface Props {
  root: string | null;
  folder: boolean;
  mode: CompareMode;
  a?: SideInfo;
  b?: SideInfo;
  layout: Layout;
  autoLayout: boolean;
  scope: Scope;
  theme: ThemeId;
  themeMenu: boolean;
  onThemeMenu(open: boolean): void;
  cvd: boolean;
  followSystem: boolean;
  codeFont: string;
  codeSize: number;
  onCodeFont(font: string): void;
  onCodeSize(size: number): void;
  picker: PickerState;
  lastPicked: LastPicked;
  onPicker(picker: PickerState): void;
  onMode(mode: CompareMode): void;
  onLayout(layout: Layout): void;
  onScope(scope: Scope): void;
  onTheme(theme: ThemeId): void;
  onCvd(on: boolean): void;
  onFollowSystem(on: boolean): void;
  onSearch(): void;
  notes: { open: boolean } | null;
  onNotes(): void;
}

export function Toolbar(props: Props) {
  const { root, folder, mode, a, b, layout, scope, onPicker } = props;
  const searchKey = keyText(useKeymap(), "search");
  const searchTip = searchKey ? `Search (${searchKey})` : "Search";
  return (
    <header className="toolbar">
      <div className="brand">
        <Mark />
        moire
      </div>
      {root && folder && (
        <div className="picker">
          <span className="picker-btn is-off" data-tip="Unstaged, Staged, commits and branches need a git repository">
            Not a git repository
          </span>
        </div>
      )}
      {root && !folder && (
        <div className="picker">
          <button className="picker-btn" aria-haspopup="listbox" aria-expanded={!!props.picker} onClick={() => props.onPicker(props.picker ? null : "main")}>
            <Icon name={MODE_ICONS[mode.kind]} />
            <span>{MODE_NAMES[mode.kind]}</span>
            <svg viewBox="0 0 10 6">
              <path d="M1 1l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.4" />
            </svg>
          </button>
          {a && (
            <span className="slot" data-tip={a.label}>
              <span className="plate-tag tag-a">A</span>
              {a.label}
            </span>
          )}
          {b && (
            <span className="slot" data-tip={b.label}>
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
              onClose={() => onPicker(null)}
            />
          )}
        </div>
      )}
      <div className="spacer" />
      {root && (
        <>
          <button className="tool-btn" aria-label={searchTip} data-tip={searchTip} onClick={props.onSearch}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="6.8" cy="6.8" r="4.6" />
              <path d="M10.3 10.3L14 14" />
            </svg>
          </button>
          {!folder && (
            <>
              <div className="seg" role="group" aria-label="Scope">
                <button aria-pressed={scope === "changed"} onClick={() => props.onScope("changed")}>
                  <Icon name="changes" />
                  <span className="lbl">Changes only</span>
                </button>
                <button aria-pressed={scope === "full"} onClick={() => props.onScope("full")}>
                  <Icon name="file" />
                  <span className="lbl">Full file</span>
                </button>
              </div>
              <div
                className="seg"
                role="group"
                aria-label="Layout"
                data-tip={props.autoLayout ? "Unified while the window is narrow. Click Split to use it anyway." : undefined}
              >
                <button aria-pressed={layout === "split"} onClick={() => props.onLayout("split")}>
                  <Icon name="split" />
                  <span className="lbl">Split</span>
                </button>
                <button aria-pressed={layout === "unified"} className={props.autoLayout ? "is-auto" : undefined} onClick={() => props.onLayout("unified")}>
                  <Icon name="unified" />
                  <span className="lbl">Unified</span>
                </button>
              </div>
            </>
          )}
          {props.notes && (
            <div className="seg">
              <button aria-pressed={props.notes.open} data-tip={props.notes.open ? "Hide agent notes" : "Show agent notes"} onClick={props.onNotes}>
                <Icon name="notes" />
                <span className="lbl">Notes</span>
                <Key id="notes" />
              </button>
            </div>
          )}
        </>
      )}
      <ThemePicker
        open={props.themeMenu}
        onOpen={props.onThemeMenu}
        theme={props.theme}
        cvd={props.cvd}
        follow={props.followSystem}
        codeFont={props.codeFont}
        codeSize={props.codeSize}
        onTheme={props.onTheme}
        onCvd={props.onCvd}
        onFollow={props.onFollowSystem}
        onCodeFont={props.onCodeFont}
        onCodeSize={props.onCodeSize}
      />
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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!popRef.current?.parentElement?.contains(event.target as Node)) onCloseRef.current();
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  useEffect(() => {
    if (initial !== "main") return;
    const pop = popRef.current;
    const start = pop?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? pop?.querySelector<HTMLElement>('[role="option"]');
    start?.focus({ preventScroll: true });
  }, [initial]);

  const pick = (m: CompareMode) => {
    onMode(m);
    onClose();
  };
  const moveFocus = (event: React.KeyboardEvent) => {
    const edge = event.key === "Home" || event.key === "End";
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp" && !edge) || event.target instanceof HTMLSelectElement) return;
    if (edge && event.target instanceof HTMLInputElement) return;
    const stops = [...popRef.current!.querySelectorAll<HTMLElement>('[role="option"], .commit-filter')];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const to = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : at + (event.key === "ArrowDown" ? 1 : -1);
    event.preventDefault();
    stops[Math.max(0, Math.min(to, stops.length - 1))]?.focus();
  };
  const simple = (kind: "unstaged" | "staged" | "all", hint: string) => (
    <button role="option" aria-selected={mode.kind === kind} onClick={() => pick({ kind })}>
      <Icon name={MODE_ICONS[kind]} />
      {MODE_NAMES[kind]}
      <Key id={kind} />
      <small>{hint}</small>
    </button>
  );

  return (
    <div className="picker-pop" role="listbox" ref={popRef} onKeyDown={moveFocus}>
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
        <Icon name={MODE_ICONS.commit} />
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
        <Icon name={MODE_ICONS.branches} />
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
            <Avatar name={c.author} email={c.email} />
            <span>{c.subject}</span>
            <code>{c.short}</code>
            <small>
              <em data-tip={new Date(c.date).toLocaleString()}>
                {c.author}, {timeAgo(Date.parse(c.date))}
              </em>
              <AgentChip commit={c} />
              {c.refs?.map((r) => (
                <i key={r.name} className={`ref ref-${r.kind}`}>
                  {r.name}
                </i>
              ))}
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
  const select = (value: string, onChange: (value: string) => void, label: string, autoFocus = false) => (
    <select autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
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
        {select(base, setBase, "Base branch", true)}
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
