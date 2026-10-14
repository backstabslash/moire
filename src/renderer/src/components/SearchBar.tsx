import { forwardRef } from "react";
import { MAX_HITS, type SearchOptions, type SearchSide } from "../model/search";

interface Props {
  options: SearchOptions;
  invalid: boolean;
  loading: boolean;
  total: number;
  index: number;
  onOptions(options: SearchOptions): void;
  onStep(delta: number): void;
  onClose(): void;
}

const SIDES: [SearchSide, string, string][] = [
  ["a", "A", "Search side A only"],
  ["b", "B", "Search side B only"],
  ["both", "A+B", "Search both sides"],
];

export const SearchBar = forwardRef<HTMLInputElement, Props>(function SearchBar({ options, invalid, loading, total, index, onOptions, onStep, onClose }, ref) {
  const set = (patch: Partial<SearchOptions>) => onOptions({ ...options, ...patch });
  const status = invalid
    ? "Invalid pattern"
    : !options.query
      ? ""
      : loading
        ? "Searching…"
        : total === 0
        ? "No results"
        : `${index + 1} of ${total}${total >= MAX_HITS ? "+" : ""}`;
  return (
    <div className="search" role="search">
      <input
        ref={ref}
        value={options.query}
        placeholder="Search in this comparison"
        aria-label="Search"
        spellCheck={false}
        onChange={(e) => set({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className={`search-status${invalid ? " is-error" : ""}`} aria-live="polite">
        {status}
      </span>
      <button className="search-opt" aria-pressed={options.matchCase} title="Match case" onClick={() => set({ matchCase: !options.matchCase })}>
        Aa
      </button>
      <button className="search-opt" aria-pressed={options.regex} title="Regular expression" onClick={() => set({ regex: !options.regex })}>
        .*
      </button>
      <span className="search-sides">
        {SIDES.map(([side, label, title]) => (
          <button key={side} className="search-opt" aria-pressed={options.side === side} title={title} onClick={() => set({ side })}>
            {label}
          </button>
        ))}
      </span>
      <button className="search-nav" title="Previous (Shift+Enter)" disabled={!total} onClick={() => onStep(-1)}>
        ↑
      </button>
      <button className="search-nav" title="Next (Enter)" disabled={!total} onClick={() => onStep(1)}>
        ↓
      </button>
      <button className="search-nav" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
});
