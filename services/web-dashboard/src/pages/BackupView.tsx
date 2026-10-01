import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BalancesData, TransactionRow } from '@ivy/contracts';
import { useReport } from '../api/hooks';
import { useParams } from '../state/params';
import { ErrorBox } from '../components/ErrorBox';
import { Warnings } from '../components/Warnings';
import { RatesTable } from '../components/RatesTable';
import { TransactionsTable } from '../components/TransactionsTable';
import { fmtMoney } from '../format';

const TABS = ['Transactions', 'Balances', 'Income & expense', 'Trends', 'Budgets', 'Planned', 'Tags', 'Payees', 'Rates & timezone'] as const;
type Tab = (typeof TABS)[number];

/** Flows 3–7 for one opened backup. */
export function BackupView({ fileId, onBack }: { fileId: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('Transactions');
  const rates = useReport<null>(fileId, 'rates'); // also warms the dataset in analytics

  return (
    <section className="card">
      <button className="link" onClick={onBack}>← All backups</button>
      {rates.error && <ErrorBox error={rates.error} />}
      {rates.data && <Warnings warnings={rates.data.warnings} />}
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      {tab === 'Transactions' && <TransactionsTab fileId={fileId} />}
      {tab === 'Balances' && <BalancesTab fileId={fileId} />}
      {tab === 'Income & expense' && <Pending fileId={fileId} report="summary" />}
      {tab === 'Trends' && <Pending fileId={fileId} report="timeseries" />}
      {tab === 'Budgets' && <Pending fileId={fileId} report="budgets" />}
      {tab === 'Planned' && <Pending fileId={fileId} report="planned" />}
      {tab === 'Tags' && (
        <>
          <p className="muted">A transaction with several tags counts once under each tag, so tag totals can exceed the overall total.</p>
          <Pending fileId={fileId} report="tags" />
        </>
      )}
      {tab === 'Payees' && <Pending fileId={fileId} report="payees" />}
      {tab === 'Rates & timezone' && rates.data && <SettingsTab base={rates.data.baseCurrency} rates={rates.data.ratesUsed} />}
    </section>
  );
}

function TransactionsTab({ fileId }: { fileId: string }) {
  const r = useReport<TransactionRow[]>(fileId, 'transactions');
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  return <TransactionsTable rows={r.data.data} base={r.data.baseCurrency} tz={r.data.tz} />;
}

function BalancesTab({ fileId }: { fileId: string }) {
  const [asOf, setAsOf] = useState('');
  const r = useReport<BalancesData>(fileId, 'balances', { asOf: asOf ? String(Date.parse(`${asOf}T23:59:59.999Z`)) : undefined });
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const { data, baseCurrency } = r.data;
  const chart = data.accounts.filter((a) => a.includeInBalance && a.base != null).map((a) => ({ name: a.name, value: a.base }));
  return (
    <>
      <label>As of <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
      <h3>Net worth: {fmtMoney(data.netWorth, baseCurrency)}</h3>
      {data.unconverted.length > 0 && (
        <div className="callout warn">Excluded from net worth (no rate): {data.unconverted.join(', ')}. Add an override under “Rates & timezone”.</div>
      )}
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <BarChart data={chart}><XAxis dataKey="name" /><YAxis /><Tooltip /><Bar dataKey="value" fill="#4f6bed" /></BarChart>
        </ResponsiveContainer>
      </div>
      <table className="grid">
        <thead><tr><th>Account</th><th>Native</th><th>In {baseCurrency}</th><th>Counts toward net worth</th></tr></thead>
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.accountId}>
              <td>{a.name}</td>
              <td>{fmtMoney(a.native, a.currency)}</td>
              <td>{a.base == null ? '—' : fmtMoney(a.base, baseCurrency)}</td>
              <td>{a.includeInBalance ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Placeholder for reports whose analytics endpoint still answers 501 (see plan, section 7). */
function Pending({ fileId, report }: { fileId: string; report: string }) {
  const r = useReport<unknown>(fileId, report);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  return <pre className="scroll">{JSON.stringify(r.data.data, null, 2)}</pre>;
}

function SettingsTab({ base, rates }: { base: string; rates: Parameters<typeof RatesTable>[0]['rates'] }) {
  const { tz, setTz } = useParams();
  const [draft, setDraft] = useState(tz);
  return (
    <>
      <label>
        Timezone (UTC offset){' '}
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setTz(draft || '+03:00')} placeholder="+03:00" />
      </label>
      <p className="muted">Days, Monday-start weeks, months and years follow this offset. Changes recalculate immediately and are not saved.</p>
      <h3>Exchange rates into {base}</h3>
      <RatesTable base={base} rates={rates} />
      <p className="muted">Known approximation: historical transactions are converted at today’s rate.</p>
    </>
  );
}
