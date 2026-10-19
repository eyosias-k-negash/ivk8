import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '@ivy/contracts';
import { api } from '../api/client';
import { emptyRules, type GroupDraft, type ReportConfig, type RuleDraft } from '../reports';

/** The part of a report config that narrows it; display settings (interval, split, net) are not saved. */
export type FilterSet = Pick<ReportConfig, 'accounts' | 'categories' | 'rules'>;
export interface SavedFilter extends FilterSet {
  name: string;
}

const key = (email: string) => `ivy.savedFilters.${email}`;

function load(email: string): SavedFilter[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key(email)) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (f): f is SavedFilter =>
        !!f && typeof f.name === 'string' && (f.accounts === null || Array.isArray(f.accounts)) &&
        (f.categories === null || Array.isArray(f.categories)) && !!f.rules && f.rules.kind === 'group' && Array.isArray(f.rules.rules),
    );
  } catch {
    return [];
  }
}

/** Rule ids only serve React and edits; a loaded filter gets fresh ones so they can't clash with new rules. */
let loaded = 0;
export function reid(g: GroupDraft): GroupDraft {
  const walk = (r: RuleDraft): RuleDraft => {
    const id = `s${++loaded}`;
    return r.kind === 'group' ? { ...r, id, rules: r.rules.map(walk) } : { ...r, id };
  };
  return { ...(walk(g) as GroupDraft), id: 'root' };
}

/** Filters with ids left out, so two filters with the same settings compare equal. */
export function signature(f: FilterSet): string {
  const strip = (r: RuleDraft): unknown => {
    const { id: _id, ...rest } = r;
    return r.kind === 'group' ? { ...rest, rules: r.rules.map(strip) } : rest;
  };
  return JSON.stringify([f.accounts, f.categories, strip(f.rules)]);
}

export const toConfigPatch = (f: SavedFilter): FilterSet => ({
  accounts: f.accounts ? [...f.accounts] : null,
  categories: f.categories ? [...f.categories] : null,
  rules: reid(f.rules ?? emptyRules()),
});

/** Named filters kept in this browser per signed-in user (localStorage, nothing server-side). */
export function useSavedFilters() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const email = me?.signedIn ? me.email : undefined;
  const [list, setList] = useState<SavedFilter[]>([]);
  useEffect(() => setList(email ? load(email) : []), [email]);

  const commit = useCallback(
    (next: SavedFilter[]) => {
      setList(next);
      if (!email) return;
      try {
        localStorage.setItem(key(email), JSON.stringify(next));
      } catch {
        /* storage unavailable: the filter lasts for this session only */
      }
    },
    [email],
  );
  const save = (name: string, f: FilterSet) => {
    const entry: SavedFilter = { name, accounts: f.accounts, categories: f.categories, rules: f.rules };
    commit(list.some((x) => x.name === name) ? list.map((x) => (x.name === name ? entry : x)) : [...list, entry]);
  };
  const remove = (name: string) => commit(list.filter((x) => x.name !== name));
  return { list, save, remove };
}
