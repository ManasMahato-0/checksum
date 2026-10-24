import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ReconBadge, StatusBadge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { ErrorState, Loading } from '../components/QueryState';
import { UploadZone } from '../components/UploadZone';
import { api, isUnfinished, type ImportRecord } from '../lib/api';
import { useAccount } from '../lib/account';
import { dateTimeLabel, money, plural, signedMoney } from '../lib/format';
import { keys, useImports } from '../lib/queries';

export function ImportsPage() {
  const { importId } = useParams();
  const navigate = useNavigate();
  const imports = useImports();

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Imports</h1>
          <p>Upload statements and see how each one was processed.</p>
        </div>
      </div>

      <div className={importId ? 'grid grid-2' : 'stack'}>
        <div className="stack">
          <UploadZone onUploaded={(id) => navigate(`/imports/${id}`)} />
          <section className="card">
            {imports.error ? (
              <div className="card-pad">
                <ErrorState error={imports.error} retry={imports.refetch} />
              </div>
            ) : imports.isPending ? (
              <div className="card-pad">
                <Loading rows={4} />
              </div>
            ) : imports.data.length === 0 ? (
              <div className="empty">
                <h2>No imports yet</h2>
                <p>Your upload history will show up here.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Status</th>
                      <th>Balance check</th>
                      <th className="right">Rows</th>
                      <th className="hide-sm">Uploaded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imports.data.map((i) => (
                      <tr
                        key={i.id}
                        className={`clickable${i.id === importId ? ' selected' : ''}`}
                        onClick={() => navigate(`/imports/${i.id}`)}
                      >
                        <td>
                          <Link to={`/imports/${i.id}`} onClick={(e) => e.stopPropagation()}>
                            {i.filename}
                          </Link>
                          {i.bank && <span className="muted"> · {i.bank}</span>}
                        </td>
                        <td>
                          <StatusBadge status={i.status} />
                        </td>
                        <td>
                          <ReconBadge ok={i.reconciliationOk} breaks={i.breakCount} />
                        </td>
                        <td className="right num">
                          {i.status === 'done' ? (
                            <>
                              {i.rowsInserted}
                              {i.rowsDuplicate > 0 && <span className="muted"> +{i.rowsDuplicate} dup</span>}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="muted hide-sm">{dateTimeLabel(i.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {importId && <ImportDetail importId={importId} onClose={() => navigate('/imports')} />}
      </div>
    </div>
  );
}

function ImportDetail({ importId, onClose }: { importId: string; onClose: () => void }) {
  const { account } = useAccount();
  const q = useQuery({
    queryKey: keys.importDetail(account, importId),
    queryFn: () => api.importDetail(account, importId),
    refetchInterval: (query) => (query.state.data && isUnfinished(query.state.data) ? 1000 : false),
  });

  return (
    <section className="card card-pad" aria-label="Import details" style={{ alignSelf: 'start' }}>
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ overflowWrap: 'anywhere' }}>{q.data?.filename ?? `Import #${importId}`}</h2>
          <p>Import #{importId}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close details">
          <Icon name="x" />
        </button>
      </div>
      {q.error ? (
        <ErrorState error={q.error} retry={q.refetch} />
      ) : q.isPending ? (
        <Loading rows={5} />
      ) : (
        <DetailBody rec={q.data} />
      )}
    </section>
  );
}

function DetailBody({ rec }: { rec: ImportRecord }) {
  const r = rec.reconciliation;
  return (
    <div className="stack">
      <dl className="kv">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={rec.status} />
          </dd>
        </div>
        <div>
          <dt>Bank</dt>
          <dd>{rec.bank ?? '—'}</dd>
        </div>
        <div>
          <dt>Rows in file</dt>
          <dd className="num">{rec.status === 'done' ? rec.rowsTotal : '—'}</dd>
        </div>
        <div>
          <dt>New / already known</dt>
          <dd className="num">{rec.status === 'done' ? `${rec.rowsInserted} / ${rec.rowsDuplicate}` : '—'}</dd>
        </div>
        <div>
          <dt>Uploaded</dt>
          <dd>{dateTimeLabel(rec.createdAt)}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd className="num">{rec.attempts}</dd>
        </div>
      </dl>

      {rec.status === 'failed' && (
        <div className="alert alert-critical" role="alert">
          <Icon name="x" />
          <div>
            <strong>Import failed.</strong> {rec.error}
          </div>
        </div>
      )}

      {isUnfinished(rec) && (
        <div className="alert">
          <Icon name="spinner" />
          <div>Parsing, de-duplicating and categorizing. This page updates on its own.</div>
        </div>
      )}

      {r && (
        <>
          <div>
            <h2 style={{ marginBottom: 10 }}>Balance check</h2>
            <div className="recon-flow num">
              <div>
                <span>Opening</span>
                {r.openingPaise === null ? '—' : money(r.openingPaise)}
              </div>
              <div>
                <span>Credits</span>+{money(r.totalCreditsPaise)}
              </div>
              <div>
                <span>Debits</span>−{money(r.totalDebitsPaise)}
              </div>
              <div>
                <span>Closing</span>
                {r.closingPaise === null ? '—' : money(r.closingPaise)}
              </div>
            </div>
          </div>
          {r.ok ? (
            <div className="alert alert-good">
              <Icon name="check" />
              <div>Every row’s balance follows from the one before it. No transactions are missing.</div>
            </div>
          ) : (
            <>
              <div className="alert alert-warning">
                <Icon name="alert" />
                <div>
                  <strong>{plural(r.breaks.length, 'gap')} in the running balance.</strong> The statement is missing
                  transactions just before these rows. Upload an overlapping statement to fill them in.
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th className="right">Expected</th>
                      <th className="right">Bank says</th>
                      <th className="right">Missing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.breaks.map((b) => (
                      <tr key={b.rowNumber}>
                        <td className="num">{b.rowNumber}</td>
                        <td className="right num">{money(b.expectedPaise)}</td>
                        <td className="right num">{money(b.actualPaise)}</td>
                        <td className="right num" title={b.diffPaise < 0 ? 'Money left with no debit row' : 'Money arrived with no credit row'}>
                          {signedMoney(b.diffPaise)} {b.diffPaise < 0 ? 'debit' : 'credit'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
