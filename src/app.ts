import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import multer from 'multer';
import { pinoHttp } from 'pino-http';
import { authRoutes, currentUser, loadSession, sameOrigin, type AuthOptions } from './auth/http';
import type { AuthStore } from './auth/store';
import { categorize, DEFAULT_RULES } from './categorize/categorizer';
import { CategoryBody, ImportListQuery, NarrationBody, parseOr400, TransactionsQuery } from './http/validate';
import { submitImport } from './import/importService';
import type { Repository } from './import/repository';
import { logger } from './logger';
import { parseNarration, toMerchantKey } from './normalize/narration';
import type { JobQueue } from './queue/queue';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Express 4 ignores rejected promises; forward them to the error handler instead of hanging. */
const wrap =
  (fn: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit` });
  }
  // body-parser (bad JSON) and Express (malformed URL params) attach a 4xx status
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.expose === false ? 'bad request' : err.message });
  }
  req.log.error({ err }, 'unhandled error');
  return res.status(500).json({ error: 'internal error' });
};

export interface AppDeps {
  repo: Repository;
  queue: JobQueue;
  auth: AuthStore;
}

export interface AppOptions extends AuthOptions {
  /** Built frontend (web/dist). When set, it is served with an SPA fallback for page routes. */
  staticDir?: string;
  /** Express "trust proxy" setting, so req.ip (rate limits) is the client's when behind a proxy. */
  trustProxy?: boolean | number | string;
}

export function createApp({ repo, queue, auth }: AppDeps, opts: AppOptions = {}) {
  const app = express();
  if (opts.trustProxy !== undefined) app.set('trust proxy', opts.trustProxy);
  // One line per request with a request id (taken from x-request-id or generated, and echoed
  // back) so a user-reported failure can be found in the logs.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w.-]{1,100}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url?.startsWith('/assets/') === true },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customProps: (_req, res) => ({ userId: (res as express.Response).locals?.user?.id }),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json());
  app.use(sameOrigin);
  app.use(loadSession(auth));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

  // Every route with :accountId: signed in, a numeric id, and an account this user owns, all
  // checked before any handler (or multer) runs. Someone else's account is a 404, not a 403,
  // so ids can't be probed for existence.
  app.param('accountId', (req, res, next, id: string) => {
    const user = currentUser(res);
    if (!user) return res.status(401).json({ error: 'sign in required' });
    if (!/^\d{1,15}$/.test(id)) return res.status(400).json({ error: 'accountId must be a positive integer' });
    auth
      .ownsAccount(user.id, id)
      .then((owns) => (owns ? next() : res.status(404).json({ error: 'account not found' })))
      .catch(next);
  });

  app.use(authRoutes(auth, opts));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Categories the rules can assign, for pickers in the UI. Overrides may add others.
  app.get('/categories', (_req, res) => {
    res.json([...new Set([...DEFAULT_RULES.map((r) => r.category), 'Uncategorized'])]);
  });

  // Upload a statement: stage it, enqueue, answer immediately. Poll the status URL for progress.
  app.post('/accounts/:accountId/imports', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file field "file" is required' });
    if (!/\.(csv|txt)$/i.test(req.file.originalname)) {
      return res.status(415).json({ error: 'only CSV statements are supported right now' });
    }
    try {
      const accountId = req.params.accountId!;
      const out = await submitImport(repo, queue, accountId, req.file.originalname, req.file.buffer);
      if (out.status === 'unsupported_format') {
        return res.status(422).json({ error: 'could not recognise this bank statement format' });
      }
      const statusUrl = `/accounts/${accountId}/imports/${out.importId}`;
      // 202: accepted, work continues in the background. 200 for a replayed file (no side effects).
      return res
        .status(out.status === 'queued' ? 202 : 200)
        .location(statusUrl)
        .json({ ...out, statusUrl });
    } catch (e) {
      req.log.error({ err: e }, 'upload failed');
      return res.status(500).json({ error: 'could not accept upload' });
    }
  });

  // Import history, newest first.
  app.get('/accounts/:accountId/imports', wrap(async (req, res) => {
    const q = parseOr400(ImportListQuery, req.query, res);
    if (!q) return;
    res.json(await repo.listImports(req.params.accountId!, q.limit));
  }));

  // Progress of one import: queued -> processing -> done | failed.
  app.get('/accounts/:accountId/imports/:importId', wrap(async (req, res) => {
    const { accountId, importId } = req.params;
    if (!/^\d{1,15}$/.test(importId!)) return res.status(400).json({ error: 'importId must be a positive integer' });
    const rec = await repo.getImport(accountId!, importId!);
    if (!rec) return res.status(404).json({ error: 'import not found' });
    return res.json(rec);
  }));

  app.get('/accounts/:accountId/transactions', wrap(async (req, res) => {
    const q = parseOr400(TransactionsQuery, req.query, res);
    if (!q) return;
    const all = await repo.listTransactions(req.params.accountId!);
    const rows = q.category === undefined ? all : all.filter((t) => t.category.category === q.category);
    res.json(
      rows
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(({ fingerprint: _fp, ...t }) => t),
    );
  }));

  // Spend per month per category (debits only), in paise.
  app.get('/accounts/:accountId/summary', wrap(async (req, res) => {
    const all = await repo.listTransactions(req.params.accountId!);
    const out: Record<string, Record<string, number>> = {};
    for (const t of all) {
      if (t.debitPaise === 0) continue;
      const month = t.date.slice(0, 7);
      const bucket = (out[month] ??= {});
      bucket[t.category.category] = (bucket[t.category.category] ?? 0) + t.debitPaise;
    }
    res.json(out);
  }));

  // Teach the categorizer: "always label this merchant as X". Re-labels history too.
  app.put('/accounts/:accountId/merchants/:merchant/category', wrap(async (req, res) => {
    const body = parseOr400(CategoryBody, req.body, res);
    if (!body) return;
    const { category } = body;
    const key = toMerchantKey(req.params.merchant!);
    if (!key) return res.status(400).json({ error: 'invalid merchant' });

    const accountId = req.params.accountId!;
    await repo.setOverride(accountId, key, category);
    const relabelled = await repo.recategorize(
      accountId,
      key,
      categorize({ channel: 'OTHER', merchantRaw: key, merchantKey: key, reference: null }, new Map([[key, category]])),
    );
    res.json({ merchantKey: key, category, relabelled });
  }));

  // Dev helper: see how a narration would be parsed.
  if (process.env.NODE_ENV !== 'production') {
    app.post('/debug/narration', (req, res) => {
      const body = parseOr400(NarrationBody, req.body, res);
      if (body) res.json(parseNarration(body.narration));
    });
  }

  if (opts.staticDir) {
    const index = path.join(opts.staticDir, 'index.html');
    app.use(express.static(opts.staticDir, { index: false }));
    // Client-side routes (/imports, /transactions, ...) load the app; API misses stay JSON 404s.
    app.get('*', (req, res, next) => (req.accepts(['json', 'html']) === 'html' ? res.sendFile(index) : next()));
  }

  app.use(errorHandler);
  return app;
}
