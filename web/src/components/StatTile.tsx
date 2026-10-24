import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function StatTile({
  label,
  value,
  foot,
  to,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  /** Makes the whole tile a link (e.g. "needs review" -> filtered transactions). */
  to?: string;
}) {
  const body = (
    <>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {foot && <div className="tile-foot">{foot}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="card tile">
      {body}
    </Link>
  ) : (
    <div className="card tile">{body}</div>
  );
}
