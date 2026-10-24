import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { money, moneyCompact, monthLabel, monthTick, plural } from '../lib/format';

/** Round an axis maximum up to 1/2/5 x 10^n so ticks land on clean numbers. */
function niceMax(max: number, ticks: number): number {
  if (max <= 0) return ticks;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  return step * ticks;
}

type Tip = { x: number; y: number; content: ReactNode } | null;

/** Tooltip positioned in the chart's own coordinate space, anchored to the hovered mark. */
function useTip() {
  const root = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const show = (el: HTMLElement, content: ReactNode) => {
    const box = root.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (box) setTip({ x: r.left + r.width / 2 - box.left, y: r.top - box.top, content });
  };
  const node = tip && (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  );
  return { root, show, hide: () => setTip(null), node };
}

// ---------------------------------------------------------------------------

export function MonthlySpendChart({
  data,
  selected,
  onSelect,
}: {
  data: { month: string; paise: number }[];
  selected: string;
  onSelect: (month: string) => void;
}) {
  const TICKS = 4;
  const max = niceMax(Math.max(0, ...data.map((d) => d.paise)), TICKS);
  const tip = useTip();

  return (
    <div className="chart" ref={tip.root}>
      <div className="cols">
        <svg className="cols-grid" width="100%" height="100%" aria-hidden style={{ position: 'absolute', inset: 0 }}>
          {Array.from({ length: TICKS + 1 }, (_, i) => (
            <line key={i} x1="0" x2="100%" y1={`${(i / TICKS) * 100}%`} y2={`${(i / TICKS) * 100}%`} className={i === TICKS ? 'baseline' : ''} />
          ))}
        </svg>
        <div className="cols-ticks num" aria-hidden>
          {Array.from({ length: TICKS + 1 }, (_, i) => (
            <span key={i} style={{ top: `${(i / TICKS) * 100}%` }}>
              {moneyCompact(max - (max / TICKS) * i)}
            </span>
          ))}
        </div>
        <div className="cols-plot">
          {data.map((d) => {
            const content = (
              <>
                <strong>{monthLabel(d.month)}</strong>
                <span className="num">{money(d.paise)} spent</span>
              </>
            );
            return (
              <button
                key={d.month}
                type="button"
                className={`col${d.month === selected ? ' selected' : ''}`}
                aria-pressed={d.month === selected}
                aria-label={`${monthLabel(d.month)}: ${money(d.paise)} spent`}
                onClick={() => onSelect(d.month)}
                onMouseEnter={(e) => tip.show(e.currentTarget.firstElementChild as HTMLElement, content)}
                onFocus={(e) => tip.show(e.currentTarget.firstElementChild as HTMLElement, content)}
                onMouseLeave={tip.hide}
                onBlur={tip.hide}
              >
                <span className="col-bar" style={{ height: `${(d.paise / max) * 100}%` }} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="cols-x" aria-hidden>
        {data.map((d) => (
          <span key={d.month} className={d.month === selected ? 'selected' : ''}>
            {monthTick(d.month)}
          </span>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

// ---------------------------------------------------------------------------

export type CategorySpend = { category: string; paise: number; count: number };

export function CategoryBars({ rows, linkFor }: { rows: CategorySpend[]; linkFor: (category: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.paise));
  const total = rows.reduce((s, r) => s + r.paise, 0);
  const tip = useTip();

  return (
    <div className="chart" ref={tip.root}>
      <div className="hbars">
        {rows.map((r) => {
          const share = total ? Math.round((r.paise / total) * 100) : 0;
          const content = (
            <>
              <strong>{r.category}</strong>
              <span className="num">
                {money(r.paise)} · {share}% · {plural(r.count, 'transaction')}
              </span>
            </>
          );
          return (
            <Link
              key={r.category}
              to={linkFor(r.category)}
              className="hbar"
              aria-label={`${r.category}: ${money(r.paise)}, ${share}% of spend. Show transactions`}
              onMouseEnter={(e) => tip.show(e.currentTarget.querySelector('.hbar-fill')!, content)}
              onFocus={(e) => tip.show(e.currentTarget.querySelector('.hbar-fill')!, content)}
              onMouseLeave={tip.hide}
              onBlur={tip.hide}
            >
              <span className="hbar-label">{r.category}</span>
              <span className="hbar-track">
                <span className="hbar-fill" style={{ width: `calc((100% - 96px) * ${(r.paise / max).toFixed(4)})` }} />
                <span className="hbar-value num">{moneyCompact(r.paise)}</span>
              </span>
            </Link>
          );
        })}
      </div>
      {tip.node}
    </div>
  );
}
