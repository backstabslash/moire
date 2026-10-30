import { type ReactNode, useId } from "react";
import { HATCH } from "./FileGlyph";

const SHEET = <rect x="2.8" y="1.8" width="8.4" height="10.4" rx="1.2" />;
const WIDE = <rect x="1.8" y="2.5" width="10.4" height="9" rx="1.5" />;
const DISC = <circle cx="7" cy="7" r="5.2" />;
const TRASH = "M3.8 4l.6 7.8h5.2l.6-7.8Z";
const PENCIL = "M9.2 2.6l2.2 2.2-6.8 6.8-2.8.6.6-2.8Z";
const LENS = "M7 4.12A3.4 3.4 0 0 1 7 9.88 3.4 3.4 0 0 1 7 4.12Z";
const TOP_PLATE = "M7 2 1.8 4.7 7 7.4l5.2-2.7Z";

interface Shape {
  base: ReactNode;
  region?: ReactNode;
  inside?: ReactNode;
  tint?: string;
}

const ICONS = {
  split: {
    base: (
      <>
        {WIDE}
        <path d="M7 2.5v9" />
      </>
    ),
    region: <rect x="7" y="2.5" width="5.2" height="9" />,
  },
  unified: {
    base: (
      <>
        {WIDE}
        <path d="M1.8 7h10.4" />
      </>
    ),
    region: <rect x="1.8" y="7" width="10.4" height="4.5" />,
  },
  changes: { base: SHEET, region: <rect x="2.8" y="5" width="8.4" height="4" /> },
  file: { base: SHEET, region: SHEET },
  notes: {
    base: <path d="M3 3.2A1.2 1.2 0 0 1 4.2 2H11v10H4.2A1.2 1.2 0 0 1 3 10.8ZM3 10.8a1.2 1.2 0 0 1 1.2-1.2H11" />,
    region: <path d="M4.2 2H11v7.6H4.2A1.2 1.2 0 0 0 3 10.8V3.2A1.2 1.2 0 0 1 4.2 2Z" />,
  },
  stage: {
    base: (
      <>
        <circle className="plate-a bold" cx="7" cy="7" r="4.8" />
        <circle className="plate-b dot" cx="7" cy="7" r="2.3" />
      </>
    ),
  },
  unstage: {
    base: (
      <>
        <circle className="plate-a bold" cx="7" cy="7" r="4.8" />
        <circle className="plate-b dot" cx="10.4" cy="10.4" r="2.3" />
      </>
    ),
  },
  discard: { base: <path d={`M2.6 4h8.8M5.4 4V2.7h3.2V4${TRASH}`} />, region: <path d={TRASH} /> },
  blink: {
    base: (
      <>
        <circle className="plate-a" cx="5.2" cy="7" r="3.4" />
        <circle className="plate-b" cx="8.8" cy="7" r="3.4" />
      </>
    ),
    region: <path d={LENS} />,
  },
  copy: {
    base: (
      <>
        <rect x="4.7" y="4.7" width="7.5" height="7.5" rx="1.2" />
        <path d="M9.3 4.7V3a1.2 1.2 0 0 0-1.2-1.2H3A1.2 1.2 0 0 0 1.8 3v5.1a1.2 1.2 0 0 0 1.2 1.2h1.7" />
      </>
    ),
    region: <path d="M9.3 4.7V1.8H1.8v7.5h2.9V4.7Z" />,
  },
  markdown: { base: <path d="M1.8 10V4l2.4 2.8L6.6 4v6M10.2 4v6M8.4 8.2l1.8 1.9 1.8-1.9" /> },
  preview: {
    base: (
      <>
        <path d="M1.5 7S3.5 3.2 7 3.2 12.5 7 12.5 7 10.5 10.8 7 10.8 1.5 7 1.5 7Z" />
        <circle cx="7" cy="7" r="2.1" />
      </>
    ),
    region: <circle cx="7" cy="7" r="2.1" />,
  },
  folder: {
    base: <path d="M1.8 4.3a1.5 1.5 0 0 1 1.5-1.5h2.4l1.5 1.6h3.5a1.5 1.5 0 0 1 1.5 1.5v4.8a1.5 1.5 0 0 1-1.5 1.5H3.3a1.5 1.5 0 0 1-1.5-1.5ZM1.8 6.4h10.4" />,
    region: <path d="M1.8 6.4h10.4v4.8a1.5 1.5 0 0 1-1.5 1.5H3.3a1.5 1.5 0 0 1-1.5-1.5Z" />,
  },
  editor: { base: <path d={PENCIL} />, region: <path d={PENCIL} /> },
  open: {
    base: <path d="M6 2.5H3.7a1.2 1.2 0 0 0-1.2 1.2v6.6a1.2 1.2 0 0 0 1.2 1.2h6.6a1.2 1.2 0 0 0 1.2-1.2V8M8 2.5h3.5V6M11.5 2.5 6.8 7.2" />,
    region: <path d="M2.5 7h5v4.5H3.7a1.2 1.2 0 0 1-1.2-1.2Z" />,
  },
  paste: {
    base: (
      <>
        <path d="M7 1.6v6.6M4.4 5.6 7 8.2l2.6-2.6" />
        <rect x="2.2" y="9.6" width="9.6" height="2.8" rx=".8" />
      </>
    ),
    region: <rect x="2.2" y="9.6" width="9.6" height="2.8" rx=".8" />,
  },
  all: {
    base: (
      <>
        <path className="plate-b bold" d={TOP_PLATE} />
        <path className="plate-a bold" d="M1.8 7.2 7 9.9l5.2-2.7M1.8 9.6 7 12.3l5.2-2.7" />
      </>
    ),
    region: <path d={TOP_PLATE} />,
    tint: "plate-b",
  },
  commit: {
    base: (
      <>
        <path className="plate-a bold" d="M1.2 7h3.2" />
        <path className="plate-b bold" d="M9.6 7h3.2" />
        <circle className="plate-b bold" cx="7" cy="7" r="2.6" />
      </>
    ),
    region: <circle cx="7" cy="7" r="2.6" />,
    tint: "plate-b",
  },
  branch: {
    base: (
      <>
        <circle className="plate-a bold" cx="4.5" cy="3.4" r="1.6" />
        <circle className="plate-a bold" cx="4.5" cy="10.6" r="1.6" />
        <path className="plate-a bold" d="M4.5 5v4" />
        <circle className="plate-b bold" cx="9.8" cy="4.9" r="1.6" />
        <path className="plate-b bold" d="M9.8 6.5c0 2-2.6 2.2-4.2 3" />
      </>
    ),
  },
  browse: {
    base: (
      <>
        <circle cx="6" cy="6" r="3.9" />
        <path d="M8.9 8.9 12 12" />
      </>
    ),
    region: <circle cx="6" cy="6" r="3.9" />,
  },
  system: { base: DISC, region: <path d="M7 1.8a5.2 5.2 0 0 1 0 10.4Z" /> },
} satisfies Record<string, Shape>;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  const clip = useId();
  const { base, region, inside, tint } = ICONS[name] as Shape;
  return (
    <svg className="icon" viewBox="0 0 14 14" aria-hidden="true">
      {region && (
        <>
          <clipPath id={clip}>{region}</clipPath>
          <g clipPath={`url(#${clip})`}>{inside ?? <path className={`hatch ${tint ?? ""}`} d={HATCH} transform="rotate(-45 7 7)" />}</g>
        </>
      )}
      {base}
    </svg>
  );
}
