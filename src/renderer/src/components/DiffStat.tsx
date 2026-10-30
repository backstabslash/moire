import { diffBlocks, gaugeWidth, shortCount } from "../model/diffstat";

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  const words = `${additions} added, ${deletions} removed`;
  return (
    <span className="diffstat" role="img" aria-label={words} data-tip={words}>
      {diffBlocks(additions, deletions).map((block, i) => (
        <i key={i} className={`block-${block}`} />
      ))}
    </span>
  );
}

export function LineGauge({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return (
    <>
      <span className="gauge" aria-hidden="true">
        <i className={additions ? "gauge-b" : undefined} style={additions ? { width: gaugeWidth(additions) } : undefined} />
        <i className={deletions ? "gauge-a" : undefined} style={deletions ? { width: gaugeWidth(deletions) } : undefined} />
      </span>
      <span className="line-stack">
        {!!additions && <span className="s-add">+{shortCount(additions)}</span>}
        {!!deletions && <span className="s-del">−{shortCount(deletions)}</span>}
      </span>
    </>
  );
}
