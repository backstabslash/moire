import { useEffect, useState } from "react";
import type { CompareMode, FileTree, RepoInfo } from "../../shared/types";

const sameList = (x: string[], y: string[]) => x.length === y.length && x.every((p, i) => p === y[i]);

export function useTree(repo: RepoInfo | null, mode: CompareMode, modeKey: string, refreshTick: number, enabled: boolean, onError: (e: unknown) => void) {
  const [tree, setTree] = useState<{ view: string; data: FileTree } | null>(null);
  const view = `${repo?.root}:${modeKey}`;
  useEffect(() => {
    if (!repo || !enabled) return;
    let stale = false;
    window.moire.tree(repo.root, mode).then(
      (data) => {
        if (stale) return;
        setTree((cur) => (cur?.view === view && sameList(cur.data.files, data.files) && sameList(cur.data.ignored, data.ignored) ? cur : { view, data }));
      },
      (e) => !stale && onError(e),
    );
    return () => {
      stale = true;
    };
  }, [repo, modeKey, refreshTick, enabled]);
  return enabled && tree?.view === view ? tree.data : null;
}
