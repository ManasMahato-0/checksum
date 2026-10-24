import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ReconBadge, StatusBadge } from '../components/Badges';
import { CategoryBars, MonthlySpendChart, type CategorySpend } from '../components/charts';
import { Icon } from '../components/Icon';
import { ErrorState, Loading } from '../components/QueryState';
import { StatTile } from '../components/StatTile';
import { UploadZone } from '../components/UploadZone';
import type { Txn } from '../lib/api';
import { dateTimeLabel, moneyWhole, monthLabel, plural, previousMonth, signedMoney } from '../lib/format';
import { useImports, useSummary, useTransactions } from '../lib/queries';

/** Every month from first to last, so gaps show as empty columns instead of disappearing. */
function monthRange(months: string[]): string[] {
  if (!months.length) return [];
  const sorted = [...months].sort();
  const out: string[] = [];
  for (let m = sorted[sorted.length - 1]!; m >= sorted[0]!; m = previousMonth(m)) out.unshift(m);
  return out;
}

function monthStats(txns: Txn[], month: string) {
  const rows = txns.filter((t) => t.date.startsWith(month));
  const spent = rows.reduce((s, t) => s + t.debitPaise, 0);
  const received = rows.reduce((s, t) => s + t.creditPaise, 0);
  const uncategorized = rows.filter((t) => t.category.category === 'Uncategorized').length;

  const byCat = new Map<string, CategorySpend>();
  for (const t of rows) {
    if (!t.debitPaise) continue;
    const c = byCat.get(t.category.category) ?? { category: t.category.category, paise: 0, count: 0 };
    c.paise += t.debitPaise;
    c.count++;
    byCat.set(c.category, c);
  }
  const categories = [...byCat.values()].sort((a, b) => b.paise - a.paise);
  return { count: rows.length, spent, received, uncategorized, categories };
}

export function OverviewPage() {
  const txnsQ = useTransactions();
  const summaryQ = useSummary();
  const importsQ = useImports();
  const [params, setParams] = useSearchParams();

  const months = useMemo(() => {
    const set = new Set(Object.keys(summaryQ.data ?? {}));
    for (const t of txnsQ.data ?? []) set.add(t.date.slice(0, 7));
    return monthRange([...set]).slice(-12);
  }, [summaryQ.data, txnsQ.data]);

  const latest = months[months.length - 1];
  const month = params.get('month') && months.includes(params.get('month')!) ? params.get('month')! : latest;

  if (txnsQ.error || summaryQ.error) {
    return <ErrorState error={(txnsQ.error ?? summaryQ.error)!} retry={() => (txnsQ.refetch(), summaryQ.refetch())} />;
  }
  if (txnsQ.isPending || summaryQ.isPending) {
    return (
      <div className="stack">
        <Loading rows={1} height={28} />
        <div className="grid grid-tiles">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card tile">
              <Loading rows={2} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!month) {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <h1>Welcome to Checksum</h1>
            <p>Upload a bank statement to see where your money goes.</p>
          </div>
        </div>
        <UploadZone />
        <div className="card card-pad secondary" style={{ fontSize: 13 }}>
          Every row is de-duplicated across overlapping statements, categorized with an explanation, and the
          running balance is checked so you know if a transaction is missing. Need sample data? Run{' '}
          <code>npm run gen:statement -- --bank sbi &gt; sample.csv</code>.
        </div>
      </div>
    );
  }

  const stats = monthStats(txnsQ.data, month);
  const prev = monthStats(txnsQ.data, previousMonth(month));
  const net = stats.received - stats.spent;
  const delta = prev.spent ? Math.round(((stats.spent - prev.spent) / prev.spent) * 100) : null;
  const spendSeries = months.map((m) => ({
    month: m,
    paise: Object.values(summaryQ.data[m] ?? {}).reduce((s, v) => s + v, 0),
  }));
  const recent = (importsQ.data ?? []).slice(0, 5);
  const txnLink = (extra: Record<string, string>) => `/transactions?${new URLSearchParams({ month, ...extra })}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{monthLabel(month)}</h1>
          <p>{plural(stats.count, 'transaction')} this month</p>
        </div>
        <label className="field">
          Month
          <select
            className="select"
            value={month}
            onChange={(e) => setParams(e.target.value === latest ? {} : { month: e.target.value }, { replace: true })}
          >
            {[...months].reverse().map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-tiles">
        <StatTile
          label="Spent"
          value={moneyWhole(stats.spent)}
          foot={
            delta === null ? (
              'No previous month to compare'
            ) : (
              <span className={delta > 0 ? 'delta-bad' : 'delta-good'}>
                <Icon name={delta > 0 ? 'arrowUp' : 'arrowDown'} size={12} /> {Math.abs(delta)}% vs{' '}
                {monthLabel(previousMonth(month)).split(' ')[0]}
              </span>
            )
          }
        />
        <StatTile label="Received" value={moneyWhole(stats.received)} />
        <StatTile label="Net" value={signedMoney(net).replace(/\.\d\d$/, '')} foot={net >= 0 ? 'Saved this month' : 'Spent more than received'} />
        <StatTile
          label="Needs review"
          value={stats.uncategorized}
          foot={stats.uncategorized ? 'Uncategorized. Click to label' : 'Everything is categorized'}
          to={stats.uncategorized ? txnLink({ category: 'Uncategorized' }) : undefined}
        />
      </div>

      <div className="grid grid-2">
        <section className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Monthly spend</h2>
              <p>Debits per month. Click a month to inspect it.</p>
            </div>
          </div>
          <MonthlySpendChart
            data={spendSeries}
            selected={month}
            onSelect={(m) => setParams(m === latest ? {} : { month: m }, { replace: true })}
          />
        </section>

        <section className="card card-pad">
          <div className="card-head">
            <div>
              <h2>Where it went</h2>
              <p>Spend by category in {monthLabel(month)}</p>
            </div>
          </div>
          {stats.categories.length ? (
            <CategoryBars rows={stats.categories} linkFor={(c) => txnLink({ category: c, dir: 'debit' })} />
          ) : (
            <p className="muted">No spending this month.</p>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head card-pad" style={{ marginBottom: 0, paddingBottom: 12 }}>
          <div>
            <h2>Recent imports</h2>
            <p>Each upload is checked against the bank’s running balance.</p>
          </div>
          <Link to="/imports" className="btn">
            <Icon name="upload" /> Upload statement
          </Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>Balance check</th>
                <th className="right hide-sm">New rows</th>
                <th className="hide-sm">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/imports/${i.id}`}>{i.filename}</Link>
                    {i.bank && <span className="muted"> · {i.bank}</span>}
                  </td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                  <td>
                    <ReconBadge ok={i.reconciliationOk} breaks={i.breakCount} />
                  </td>
                  <td className="right num hide-sm">{i.status === 'done' ? i.rowsInserted : '—'}</td>
                  <td className="muted hide-sm">{dateTimeLabel(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
