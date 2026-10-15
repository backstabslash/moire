const GRATING = "M-6 1.5h36M-6 4.5h36M-6 7.5h36M-6 10.5h36M-6 13.5h36M-6 16.5h36M-6 19.5h36M-6 22.5h36";

export function Mark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <clipPath id="mark-disc">
          <circle cx="12" cy="12" r="11" />
        </clipPath>
      </defs>
      <g clipPath="url(#mark-disc)" strokeWidth="1.1">
        <path d={GRATING} stroke="var(--a)" />
        <path d={GRATING} stroke="var(--b)" transform="rotate(11 12 12)" className="mark-b" />
      </g>
    </svg>
  );
}

const RADII = Array.from({ length: 34 }, (_, i) => 5 + i * 6.2);

export function Rings() {
  return (
    <svg viewBox="-160 -160 320 320" aria-hidden="true">
      <defs>
        <clipPath id="rings-clip">
          <circle r="156" />
        </clipPath>
      </defs>
      <g clipPath="url(#rings-clip)" fill="none" strokeWidth="2.6">
        <g stroke="var(--a)" className="rings-a">
          {RADII.map((r) => (
            <circle key={r} cx={-14} cy={0} r={r} />
          ))}
        </g>
        <g stroke="var(--b)" className="rings-b">
          {RADII.map((r) => (
            <circle key={r} cx={14} cy={0} r={r} />
          ))}
        </g>
      </g>
    </svg>
  );
}
