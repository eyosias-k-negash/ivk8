import { useMemo, useState } from 'react';
import {
  createColumnHelper, flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel,
  useReactTable, type SortingState,
} from '@tanstack/react-table';
import type { TransactionRow } from '@ivy/contracts';
import { fmtDate, fmtMoney } from '../format';

const col = createColumnHelper<TransactionRow>();

/** Flow 3: sortable, filterable transaction table. */
export function TransactionsTable({ rows, base, tz }: { rows: TransactionRow[]; base: string; tz: string }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'dateTime', desc: true }]);
  const [filter, setFilter] = useState('');
  const columns = useMemo(
    () => [
      col.accessor('dateTime', { header: 'Date', cell: (c) => fmtDate(c.getValue() ?? c.row.original.dueDate, tz) }),
      col.accessor('status', { header: 'Status' }),
      col.accessor('type', { header: 'Type' }),
      col.accessor('title', { header: 'Title' }),
      col.accessor('categoryName', { header: 'Category' }),
      col.accessor('accountName', { header: 'Account' }),
      col.accessor('tags', { header: 'Tags', cell: (c) => c.getValue().join(', '), enableSorting: false }),
      col.accessor('amount', { header: 'Amount', cell: (c) => fmtMoney(c.getValue(), c.row.original.currency) }),
      col.accessor('amountBase', { header: `In ${base}`, cell: (c) => (c.getValue() == null ? '—' : fmtMoney(c.getValue()!, base)) }),
    ],
    [base, tz],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  return (
    <>
      <input className="filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <p className="muted">{table.getRowModel().rows.length} of {rows.length} transactions</p>
      <div className="scroll">
        <table className="grid">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} onClick={h.column.getToggleSortingHandler()} className={h.column.getCanSort() ? 'sortable' : ''}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.slice(0, 500).map((r) => (
              <tr key={r.id} className={r.original.status !== 'EXECUTED' ? 'muted' : ''}>
                {r.getVisibleCells().map((c) => <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
