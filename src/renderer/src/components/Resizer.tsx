import { useRef } from "react";

interface Props {
  className: string;
  label: string;
  width: number;
  limits: { initial: number; min: number; max: number };
  growsLeft?: boolean;
  onWidth(width: number): void;
}

export function Resizer({ className, label, width, limits, growsLeft, onWidth }: Props) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      data-tip="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        const from = drag.current;
        if (!from) return;
        const moved = e.clientX - from.x;
        onWidth(Math.round(Math.min(limits.max, Math.max(limits.min, from.width + (growsLeft ? -moved : moved)))));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onWidth(limits.initial)}
    />
  );
}
