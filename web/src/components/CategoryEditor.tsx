import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type Txn } from '../lib/api';
import { useAccount } from '../lib/account';
import { plural, titleCase } from '../lib/format';
import { keys, useCategories } from '../lib/queries';
import { useToast } from './Toast';

/**
 * The category pill. For rows with a merchant it opens a picker that sets a merchant-wide
 * override: every past and future transaction with that merchant gets the new label.
 */
export function CategoryEditor({ txn, extraCategories }: { txn: Txn; extraCategories: string[] }) {
  const { account } = useAccount();
  const qc = useQueryClient();
  const toast = useToast();
  const categories = useCategories();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  const { category, source, reason } = txn.category;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const save = useMutation({
    mutationFn: (next: string) => api.setMerchantCategory(account, txn.merchantKey!, next),
    onSuccess: (res) => {
      setOpen(false);
      setCustom('');
      void qc.invalidateQueries({ queryKey: keys.txns(account) });
      void qc.invalidateQueries({ queryKey: keys.summary(account) });
      toast('good', (
        <>
          {plural(res.relabelled, 'transaction')} from <strong>{titleCase(res.merchantKey)}</strong> now labelled{' '}
          <strong>{res.category}</strong>. Future imports will match too.
        </>
      ));
    },
    onError: (e) => toast('critical', `Could not save: ${e.message}`),
  });

  const cls = `pill${source === 'none' ? ' pill-none' : ''}${source === 'override' ? ' pill-override' : ''}`;
  const title = source === 'override' ? 'Your label' : (reason ?? 'No rule matched');

  if (!txn.merchantKey) {
    return (
      <span className={cls} title={title}>
        {category}
      </span>
    );
  }

  const options = [...new Set([...(categories.data ?? []), ...extraCategories])].filter((c) => c !== 'Uncategorized');

  return (
    <span className="popover-anchor" ref={root}>
      <button
        type="button"
        className={cls}
        title={`${title}. Click to change`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {category}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label={`Category for ${titleCase(txn.merchantKey)}`}>
          <p>
            Label every <strong>{titleCase(txn.merchantKey)}</strong> transaction as:
          </p>
          <div className="popover-list">
            {options.map((c) => (
              <button
                key={c}
                type="button"
                className="pill"
                aria-pressed={c === category}
                disabled={save.isPending}
                onClick={() => save.mutate(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) save.mutate(custom.trim());
            }}
          >
            <input
              className="input"
              placeholder="New category…"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              maxLength={40}
              autoFocus
            />
            <button type="submit" className="btn btn-primary" disabled={!custom.trim() || save.isPending}>
              Save
            </button>
          </form>
        </div>
      )}
    </span>
  );
}
