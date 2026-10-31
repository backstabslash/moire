import { useEffect, useRef, useState } from "react";
import type { Screenshot } from "../../../shared/types";

const srcOf = (root: string, { file, version }: Screenshot) => `moire://media/?root=${encodeURIComponent(root)}&file=${encodeURIComponent(file)}&v=${version}`;

export function Screenshots({ root, shots }: { root: string; shots: Screenshot[] }) {
  const [open, setOpen] = useState<Screenshot | null>(null);
  return (
    <div className="shots">
      {shots.map((shot) => (
        <figure key={shot.file} className="shot">
          {shot.missing ? (
            <p className="shot-problem">{`Screenshot not found: ${shot.file}`}</p>
          ) : (
            <button aria-label={`Enlarge ${shot.caption ?? shot.file}`} onClick={() => setOpen(shot)}>
              <img src={srcOf(root, shot)} alt={shot.caption ?? shot.file} />
            </button>
          )}
          {shot.caption && <figcaption>{shot.caption}</figcaption>}
          {shot.stale && <p className="shot-problem">The code changed after this was taken</p>}
        </figure>
      ))}
      {open && <Enlarged src={srcOf(root, open)} shot={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Enlarged({ src, shot, onClose }: { src: string; shot: Screenshot; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="shot-view" aria-label={shot.caption ?? shot.file} onClose={onClose} onClick={onClose} onKeyDown={(e) => e.stopPropagation()}>
      <img src={src} alt={shot.caption ?? shot.file} />
      {shot.caption && <p>{shot.caption}</p>}
    </dialog>
  );
}
