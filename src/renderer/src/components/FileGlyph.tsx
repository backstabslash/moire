import { type ReactNode, useId } from "react";
import type { FileDiff } from "../../../shared/types";
import { type Family, familyOf } from "../model/family";
import { markOf } from "../model/marks";

export const HATCH = Array.from({ length: 21 }, (_, i) => `M-8 ${-8 + i * 1.5}h30`).join("");
const DROP = "M7 2.2C5.2 4.6 3.5 6.6 3.5 8.6a3.5 3.5 0 0 0 7 0C10.5 6.6 8.8 4.6 7 2.2Z";
const BRACES =
  "M5.3 2.5C4.2 2.5 3.9 3.1 3.9 4.2v1.6c0 .8-.4 1.2-1.2 1.2.8 0 1.2.4 1.2 1.2v1.6c0 1.1.3 1.7 1.4 1.7M8.7 2.5c1.1 0 1.4.6 1.4 1.7v1.6c0 .8.4 1.2 1.2 1.2-.8 0-1.2.4-1.2 1.2v1.6c0 1.1-.3 1.7-1.4 1.7";
const BITS = [4, 7, 10].flatMap((y) => [4, 7, 10].map((x) => [x, y])).filter(([x, y]) => x !== 7 || y !== 7);

const GLYPHS: Record<Family, { base: ReactNode; spot: ReactNode; region?: ReactNode }> = {
  code: {
    base: <path d={BRACES} />,
    spot: <circle className="dot" cx="7" cy="7" r="1" />,
    region: <circle cx="7" cy="7" r="2.2" />,
  },
  markup: {
    base: <path d="M4.6 4 1.8 7l2.8 3M9.4 4l2.8 3-2.8 3" />,
    spot: <path d="M8 3 6 11" />,
  },
  styles: {
    base: <path d={DROP} />,
    spot: <path d="M5.6 9.1c.2.8.8 1.3 1.5 1.4" />,
    region: <path d={DROP} />,
  },
  config: {
    base: <path d="M4.7 3.5h6.8M7.2 7h4.3M7.2 10.5h2.8" />,
    spot: (
      <>
        <circle className="dot" cx="2.6" cy="3.5" r=".9" />
        <circle className="dot" cx="5.1" cy="7" r=".9" />
        <circle className="dot" cx="5.1" cy="10.5" r=".9" />
      </>
    ),
  },
  docs: {
    base: <path d="M2.5 6h9M2.5 8.5h9M2.5 11h5.5" />,
    spot: <path className="thick" d="M2.5 3h5" />,
  },
  shell: {
    base: <path d="M2.6 3.8 6 7l-3.4 3.2" />,
    spot: <path className="thick" d="M7.6 10.6h4" />,
  },
  data: {
    base: (
      <>
        <rect x="2.2" y="2.5" width="9.6" height="9" rx="1.5" />
        <path d="M2.2 8.6h9.6M6 5.6v5.9" />
      </>
    ),
    spot: <path d="M2.2 5.6h9.6" />,
    region: <path d="M2.2 5.6V4a1.5 1.5 0 0 1 1.5-1.5h6.6A1.5 1.5 0 0 1 11.8 4v1.6Z" />,
  },
  build: {
    base: <path d="M7 1.9l4.6 2.4v5.4L7 12.1 2.4 9.7V4.3ZM7 6.7v5.4" />,
    spot: <path d="M2.4 4.3 7 6.7l4.6-2.4" />,
    region: <path d="M2.4 4.3 7 1.9l4.6 2.4L7 6.7Z" />,
  },
  lock: {
    base: (
      <>
        <rect x="3" y="6.3" width="8" height="5.7" rx="1.3" />
        <path d="M4.9 6.3V4.9a2.1 2.1 0 0 1 4.2 0v1.4" />
      </>
    ),
    spot: (
      <>
        <circle className="dot" cx="7" cy="8.7" r=".85" />
        <path d="M7 9.2v1.2" />
      </>
    ),
    region: <rect x="3" y="6.3" width="8" height="5.7" rx="1.3" />,
  },
  image: {
    base: (
      <>
        <rect x="2" y="2.5" width="10" height="9" rx="1.5" />
        <path d="M2.4 10.4 5.3 7.6l2.4 2.3 1.4-1.3 2.5 2.2" />
      </>
    ),
    spot: <circle className="dot" cx="9.1" cy="5.3" r="1.15" />,
    region: <path d="M2.4 10.4 5.3 7.6l2.4 2.3 1.4-1.3 2.5 2.2v1.1H2.4Z" />,
  },
  binary: {
    base: BITS.map(([x, y]) => <circle key={`${x},${y}`} className="dot" cx={x} cy={y} r=".85" />),
    spot: <rect x="5.9" y="5.9" width="2.2" height="2.2" rx=".4" />,
    region: <rect x="5.9" y="5.9" width="2.2" height="2.2" rx=".4" />,
  },
  git: {
    base: (
      <>
        <circle cx="4.5" cy="3.4" r="1.4" />
        <circle cx="4.5" cy="10.6" r="1.4" />
        <path d="M4.5 4.8v4.4" />
      </>
    ),
    spot: (
      <>
        <circle cx="9.6" cy="4.9" r="1.4" />
        <path d="M9.6 6.3c0 2.1-2.4 2.3-4.2 3.2" />
      </>
    ),
    region: <circle cx="9.6" cy="4.9" r="1.4" />,
  },
  other: {
    base: <path d="M7.9 1.8H3.5v10.4h7V4.4" />,
    spot: <path d="M7.9 1.8l2.6 2.6H7.9Z" />,
    region: <path d="M7.9 1.8l2.6 2.6H7.9Z" />,
  },
};

export function FileGlyph({ path, diff }: { path: string; diff?: FileDiff }) {
  const mark = markOf(path, diff);
  return mark ? <span className="glyph glyph-lang" data-mark={mark} aria-hidden="true" /> : <RoleGlyph path={path} diff={diff} />;
}

function RoleGlyph({ path, diff }: { path: string; diff?: FileDiff }) {
  const family = familyOf(path, diff);
  const clip = useId();
  const { base, spot, region } = GLYPHS[family];
  return (
    <svg className="glyph" viewBox="0 0 14 14" aria-hidden="true">
      {base}
      <g className="glyph-spot">
        {region && (
          <>
            <clipPath id={clip}>{region}</clipPath>
            <g clipPath={`url(#${clip})`}>
              <path className="hatch" d={HATCH} transform="rotate(-45 7 7)" />
            </g>
          </>
        )}
        {spot}
      </g>
    </svg>
  );
}

const FOLDER_BACK = "a1.5 1.5 0 0 1 1.5-1.5h2.4l1.5 1.6h3.5a1.5 1.5 0 0 1 1.5 1.5";

export function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg className="glyph glyph-folder" viewBox="0 0 14 14" aria-hidden="true">
      {open ? (
        <path d={`M1.8 12.2V4.3${FOLDER_BACK}v.7M3.6 6.6h9.3L11 12.2H1.8Z`} />
      ) : (
        <path d={`M1.8 4.3${FOLDER_BACK}v4.8a1.5 1.5 0 0 1-1.5 1.5H3.3a1.5 1.5 0 0 1-1.5-1.5ZM1.8 6.4h10.4`} />
      )}
    </svg>
  );
}
