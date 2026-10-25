import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { api } from '../lib/api';
import { keys } from '../lib/queries';

type Mode = 'login' | 'register';

export function AuthPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = useMutation({
    mutationFn: () => (mode === 'login' ? api.login(email, password) : api.register(email, password)),
    onSuccess: (me) => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); // nothing from a previous user lingers
      qc.setQueryData(keys.me, me);
    },
  });

  const switchTo = (m: Mode) => {
    setMode(m);
    submit.reset();
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card card">
        <div className="brand auth-brand">
          <img src="/favicon.svg" alt="" className="brand-mark" />
          Checksum
        </div>
        <h1>{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
        <p className="secondary auth-sub">
          {mode === 'login'
            ? 'Welcome back. Your statements are waiting.'
            : 'Upload bank statements, get clean, categorized transactions and a balance check.'}
        </p>

        <form
          className="stack auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <label className="auth-field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'register' && <small className="muted">At least 8 characters.</small>}
          </label>

          {submit.error && (
            <div className="alert alert-critical" role="alert">
              <Icon name="x" />
              <div>{submit.error.message}</div>
            </div>
          )}

          <button type="submit" className="btn btn-primary auth-submit" disabled={submit.isPending}>
            {submit.isPending && <Icon name="spinner" />}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="auth-switch secondary">
          {mode === 'login' ? (
            <>
              New here?{' '}
              <button type="button" className="link-btn" onClick={() => switchTo('register')}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" className="link-btn" onClick={() => switchTo('login')}>
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
