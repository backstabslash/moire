import { useEffect, useState } from "react";
import type { CompareMode, FileTree, RepoInfo } from "../../shared/types";

const sameList = (x: string[], y: string[]) => x.length === y.length && x.every((p, i) => p === y[i]);

export function useTree(repo: RepoInfo | null, mode: CompareMode, modeKey: string, refreshTick: number, enabled: boolean, onError: (e: unknown) => void) {
  const [tree, setTree] = useState<{ root: string; data: FileTree } | null>(null);
  useEffect(() => {
    if (!repo || !enabled) return;
    let stale = false;
    window.moire.tree(repo.root, mode).then(
      (data) => {
        if (stale) return;
        const same = (cur: FileTree) =>
          sameList(cur.files, data.files) && sameList(cur.ignored, data.ignored) && sameList(cur.unlisted ?? [], data.unlisted ?? []);
        setTree((cur) => (cur?.root === repo.root && same(cur.data) ? cur : { root: repo.root, data }));
      },
      (e) => !stale && onError(e),
    );
    return () => {
      stale = true;
    };
  }, [repo, modeKey, refreshTick, enabled]);
  return enabled && tree && tree.root === repo?.root ? tree.data : null;
}
