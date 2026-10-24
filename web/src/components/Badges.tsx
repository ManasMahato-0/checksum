import type { ImportListItem } from '../lib/api';
import { plural } from '../lib/format';
import { Icon, type IconName } from './Icon';

// Status always pairs an icon with a word: color is never the only signal.
const STATUS: Record<ImportListItem['status'], { icon: IconName; tone: string; label: string }> = {
  queued: { icon: 'clock', tone: '', label: 'Queued' },
  processing: { icon: 'spinner', tone: 'badge-accent', label: 'Processing' },
  done: { icon: 'check', tone: 'badge-good', label: 'Done' },
  failed: { icon: 'x', tone: 'badge-critical', label: 'Failed' },
};

export function StatusBadge({ status }: { status: ImportListItem['status'] }) {
  const s = STATUS[status];
  return (
    <span className={`badge ${s.tone}`}>
      <Icon name={s.icon} size={13} />
      {s.label}
    </span>
  );
}

/** Balance walk result: balanced, N gaps, or nothing yet. */
export function ReconBadge({ ok, breaks }: { ok: boolean | null; breaks: number }) {
  if (ok === null) return <span className="muted">—</span>;
  if (ok) {
    return (
      <span className="badge badge-good">
        <Icon name="check" size={13} />
        Balanced
      </span>
    );
  }
  return (
    <span className="badge badge-warning">
      <Icon name="alert" size={13} />
      {plural(breaks, 'gap')}
    </span>
  );
}
