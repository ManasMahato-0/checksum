import { Router, type Request, type RequestHandler, type Response } from 'express';
import { Credentials, NewAccount, parseOr400 } from '../http/validate';
import { DUMMY_HASH, hashPassword, hashToken, newSessionToken, verifyPassword } from './passwords';
import type { AuthStore } from './store';
import type { User } from './types';

export const SESSION_COOKIE = 'checksum_session';
const SESSION_DAYS = 30;

export interface AuthOptions {
  /** Set the cookie's Secure flag. Turn on whenever the app is served over HTTPS. */
  secureCookies?: boolean;
}

/** The signed-in user, set by `loadSession`. */
export const currentUser = (res: Response): User | undefined => res.locals.user;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Fixed-window counter per key (IP). In-memory: fine for one API process; use Redis when scaling out. */
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; false once the key is over its limit for the current window. */
  hit(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      return true;
    }
    return ++h.count <= this.max;
  }
}

/** Attaches res.locals.user when the request carries a valid session cookie. Never rejects. */
export function loadSession(store: AuthStore): RequestHandler {
  return (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next();
    store
      .findSessionUser(hashToken(token))
      .then((user) => {
        if (user) res.locals.user = user;
        next();
      })
      .catch(next);
  };
}

export const requireUser: RequestHandler = (_req, res, next) =>
  currentUser(res) ? next() : void res.status(401).json({ error: 'sign in required' });

/**
 * CSRF defence in depth (the cookie is already SameSite=Lax): a state-changing request that
 * names an Origin must come from this same host.
 */
export const sameOrigin: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, tests) don't send one
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch {
    /* malformed Origin: reject below */
  }
  res.status(403).json({ error: 'cross-origin request rejected' });
};

/** /auth/* and /accounts (list + create). Per-account routes live in app.ts. */
export function authRoutes(store: AuthStore, opts: AuthOptions = {}): Router {
  const r = Router();
  const loginLimit = new RateLimiter(10, 15 * 60_000);
  const registerLimit = new RateLimiter(10, 60 * 60_000);

  async function startSession(res: Response, user: User) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600_000);
    await store.createSession(user.id, hashToken(token), expiresAt);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      path: '/',
      expires: expiresAt,
    });
  }

  const me = async (user: User) => ({ user, accounts: await store.listAccounts(user.id) });

  r.post('/auth/register', async (req, res, next) => {
    try {
      if (!registerLimit.hit(req.ip ?? '')) return res.status(429).json({ error: 'too many sign-ups, try again later' });
      const creds = parseOr400(Credentials, req.body, res);
      if (!creds) return;
      const user = await store.createUser(creds.email, await hashPassword(creds.password));
      if (!user) return res.status(409).json({ error: 'an account with this email already exists' });
      await store.createAccount(user.id, 'Personal');
      await startSession(res, user);
      return res.status(201).json(await me(user));
    } catch (e) {
      return next(e);
    }
  });

  r.post('/auth/login', async (req, res, next) => {
    try {
      const creds = parseOr400(Credentials, req.body, res);
      if (!creds) return;
      // Count every attempt, not just failures: a wrong-password loop can't reset its own window.
      if (!loginLimit.hit(req.ip ?? '')) return res.status(429).json({ error: 'too many attempts, try again later' });
      const found = await store.findUserByEmail(creds.email);
      const ok = await verifyPassword(creds.password, found?.passwordHash ?? DUMMY_HASH);
      if (!found || !ok) return res.status(401).json({ error: 'wrong email or password' });
      const { passwordHash: _p, ...user } = found;
      await startSession(res, user);
      return res.json(await me(user));
    } catch (e) {
      return next(e);
    }
  });

  r.post('/auth/logout', async (req, res, next) => {
    try {
      const token = readCookie(req, SESSION_COOKIE);
      if (token) await store.deleteSession(hashToken(token));
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return res.status(204).end();
    } catch (e) {
      return next(e);
    }
  });

  r.get('/auth/me', requireUser, async (_req, res, next) => {
    try {
      return res.json(await me(currentUser(res)!));
    } catch (e) {
      return next(e);
    }
  });

  r.get('/accounts', requireUser, async (_req, res, next) => {
    try {
      return res.json(await store.listAccounts(currentUser(res)!.id));
    } catch (e) {
      return next(e);
    }
  });

  r.post('/accounts', requireUser, async (req, res, next) => {
    try {
      const body = parseOr400(NewAccount, req.body, res);
      if (!body) return;
      return res.status(201).json(await store.createAccount(currentUser(res)!.id, body.name));
    } catch (e) {
      return next(e);
    }
  });

  return r;
}
