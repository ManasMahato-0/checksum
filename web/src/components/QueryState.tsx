import { Icon } from './Icon';

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="alert alert-critical" role="alert">
      <Icon name="x" />
      <div style={{ flex: 1 }}>
        <strong>Something went wrong.</strong> {error.message}
      </div>
      {retry && (
        <button type="button" className="btn" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ rows = 3, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div className="stack" style={{ gap: 10 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}
