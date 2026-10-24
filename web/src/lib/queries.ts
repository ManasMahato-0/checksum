import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, isUnfinished } from './api';
import { useAccount } from './account';

export const keys = {
  imports: (a: string) => ['imports', a] as const,
  importDetail: (a: string, id: string) => ['imports', a, id] as const,
  txns: (a: string) => ['txns', a] as const,
  summary: (a: string) => ['summary', a] as const,
  categories: ['categories'] as const,
};

/**
 * Import history. Polls while anything is queued/processing, and when the last job finishes
 * refreshes transactions and summary so every page shows the new rows without a reload.
 */
export function useImports() {
  const { account } = useAccount();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: keys.imports(account),
    queryFn: () => api.imports(account),
    refetchInterval: (query) => (query.state.data?.some(isUnfinished) ? 1000 : false),
  });

  const pending = q.data?.filter(isUnfinished).length ?? 0;
  const prev = useRef(pending);
  useEffect(() => {
    if (prev.current > 0 && pending < prev.current) {
      void qc.invalidateQueries({ queryKey: keys.txns(account) });
      void qc.invalidateQueries({ queryKey: keys.summary(account) });
    }
    prev.current = pending;
  }, [pending, account, qc]);

  return { ...q, pending };
}

export function useTransactions() {
  const { account } = useAccount();
  return useQuery({ queryKey: keys.txns(account), queryFn: () => api.transactions(account) });
}

export function useSummary() {
  const { account } = useAccount();
  return useQuery({ queryKey: keys.summary(account), queryFn: () => api.summary(account) });
}

export function useCategories() {
  return useQuery({ queryKey: keys.categories, queryFn: api.categories, staleTime: Infinity });
}
