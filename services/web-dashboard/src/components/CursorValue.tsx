import { useEffect, useRef, useState } from 'react';
import { usePlotArea, useYAxisScale } from 'recharts';
import { fmtMoney } from '../format';

/**
 * Horizontal guide that follows the mouse and labels the exact money value of the Y axis under it.
 * Render inside a chart; use one per Y axis (pass `line={false}` on extras so the guide is drawn once).
 */
export function CursorValue({ base, yAxisId, side = 'left', line = true }: {
  base: string;
  yAxisId?: string;
  side?: 'left' | 'right';
  line?: boolean;
}) {
  const y = useYAxisScale(yAxisId);
  const area = usePlotArea();
  const anchor = useRef<SVGGElement>(null);
  const [py, setPy] = useState<number | null>(null);

  useEffect(() => {
    const svg = anchor.current?.ownerSVGElement;
    if (!svg) return;
    const move = (e: MouseEvent) => {
      const box = svg.getBoundingClientRect();
      setPy(e.clientY - box.top);
    };
    const leave = () => setPy(null);
    svg.addEventListener('mousemove', move);
    svg.addEventListener('mouseleave', leave);
    return () => {
      svg.removeEventListener('mousemove', move);
      svg.removeEventListener('mouseleave', leave);
    };
  }, []);

  let content = null;
  if (y && area && py != null && py >= area.y && py <= area.y + area.height) {
    // Axis scales are linear: recover the value from two reference points rather than rely on invert().
    const y0 = y(0);
    const y1 = y(1);
    if (y0 != null && y1 != null && y1 !== y0) {
      const value = (py - y0) / (y1 - y0);
      const text = fmtMoney(value, base);
      const w = text.length * 7 + 12;
      const x = side === 'left' ? area.x + 4 : area.x + area.width - w - 4;
      content = (
        <>
          {line && <line x1={area.x} x2={area.x + area.width} y1={py} y2={py} stroke="var(--viz-muted)" strokeDasharray="3 3" />}
          <rect x={x} y={py - 10} width={w} height={20} rx={4} fill="var(--card)" stroke="var(--border)" />
          <text x={x + w / 2} y={py} textAnchor="middle" dominantBaseline="central" fontSize={12} fill="var(--fg)">{text}</text>
        </>
      );
    }
  }
  return <g ref={anchor} pointerEvents="none" aria-hidden>{content}</g>;
}
