import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/http';
import { hashPassword, hashToken, verifyPassword } from '../src/auth/passwords';
import { csv, L, makeHarness, PASSWORD, signIn, stores } from './helpers/harness';

const sessionCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('hunter2hunter2');
    const b = await hashPassword('hunter2hunter2');
    expect(a).not.toBe(b);
    expect(a).not.toContain('hunter2');
    expect(await verifyPassword('hunter2hunter2', a)).toBe(true);
    expect(await verifyPassword('hunter2hunter3', a)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });
});

describe.each(stores)('auth [%s]', (_name, makeRepo) => {
  it('sign-up creates a user with a first account and an HttpOnly session cookie', async () => {
    const { app } = await makeHarness(await makeRepo());
    const res = await request(app).post('/auth/register').send({ email: '  New@Example.com ', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('new@example.com');
    expect(res.body.accounts).toEqual([expect.objectContaining({ name: 'Personal' })]);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('rejects duplicate emails (case-insensitive) and weak input', async () => {
    const { app } = await makeHarness(await makeRepo()); // already registered me@example.com
    expect((await request(app).post('/auth/register').send({ email: 'ME@example.com', password: PASSWORD })).status).toBe(409);
    expect((await request(app).post('/auth/register').send({ email: 'nope', password: PASSWORD })).status).toBe(400);
    expect((await request(app).post('/auth/register').send({ email: 'a@b.co', password: 'short' })).status).toBe(400);
  });

  it('login: right password signs in; wrong password and unknown email look the same', async () => {
    const { app } = await makeHarness(await makeRepo());
    const wrong = await request(app).post('/auth/login').send({ email: 'me@example.com', password: 'not the password' });
    const unknown = await request(app).post('/auth/login').send({ email: 'who@example.com', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(sessionCookie(wrong)).toBeUndefined();

    const agent = request.agent(app);
    const ok = await agent.post('/auth/login').send({ email: 'Me@Example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await agent.get('/auth/me')).body.user.email).toBe('me@example.com');
  });

  it('everything account-scoped requires a session', async () => {
    const { app } = await makeHarness(await makeRepo());
    for (const url of ['/auth/me', '/accounts', '/accounts/1/transactions', '/accounts/1/summary', '/accounts/1/imports']) {
      expect((await request(app).get(url)).status).toBe(401);
    }
    expect((await request(app).post('/accounts/1/imports').attach('file', csv(L.salary), 'a.csv')).status).toBe(401);
    // public
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/categories')).status).toBe(200);
  });

  it("one user can't see or touch another user's account (404, not 403)", async () => {
    const h = await makeHarness(await makeRepo());
    const { post } = await h.uploadAndWait(csv(L.salary, L.swiggy));
    const mallory = await signIn(h.app, 'mallory@example.com'); // owns account 2

    for (const url of ['/accounts/1/transactions', '/accounts/1/summary', '/accounts/1/imports', `/accounts/1/imports/${post.body.importId}`]) {
      expect((await mallory.get(url)).status).toBe(404);
    }
    expect((await mallory.post('/accounts/1/imports').attach('file', csv(L.uber), 'x.csv')).status).toBe(404);
    expect((await mallory.put('/accounts/1/merchants/SWIGGY/category').send({ category: 'Hacked' })).status).toBe(404);
    expect((await mallory.get('/accounts')).body.map((a: any) => a.id)).toEqual(['2']);

    // the owner's data is untouched
    const txns = (await h.api.get('/accounts/1/transactions')).body;
    expect(txns).toHaveLength(2);
    expect(txns.every((t: any) => t.category.category !== 'Hacked')).toBe(true);
  });

  it('users can create more accounts and use them', async () => {
    const h = await makeHarness(await makeRepo());
    const created = await h.api.post('/accounts').send({ name: 'Joint' });
    expect(created.status).toBe(201);
    expect((await h.api.get('/accounts')).body.map((a: any) => a.name)).toEqual(['Personal', 'Joint']);
    const up = await h.api.post(`/accounts/${created.body.id}/imports`).attach('file', csv(L.salary), 'a.csv');
    expect(up.status).toBe(202);
    expect((await h.api.post('/accounts').send({ name: '' })).status).toBe(400);
  });

  it('logout ends the session server-side, not just the cookie', async () => {
    const h = await makeHarness(await makeRepo());
    const cookie = sessionCookie(await request(h.app).post('/auth/login').send({ email: 'me@example.com', password: PASSWORD }))!;
    const pair = cookie.split(';')[0]!;
    expect((await request(h.app).get('/auth/me').set('cookie', pair)).status).toBe(200);
    expect((await request(h.app).post('/auth/logout').set('cookie', pair)).status).toBe(204);
    expect((await request(h.app).get('/auth/me').set('cookie', pair)).status).toBe(401); // replaying the old token fails
  });

  it('expired sessions are rejected', async () => {
    const h = await makeHarness(await makeRepo());
    await h.auth.createSession('1', hashToken('old-token'), new Date(Date.now() - 1000));
    expect((await request(h.app).get('/auth/me').set('cookie', `${SESSION_COOKIE}=old-token`)).status).toBe(401);
  });
});

describe('abuse protection', () => {
  it('rejects state-changing requests from another origin', async () => {
    const h = await makeHarness((await stores[0]![1]()));
    const evil = await h.api.put('/accounts/1/merchants/SWIGGY/category').set('origin', 'https://evil.example').send({ category: 'x' });
    expect(evil.status).toBe(403);
    const same = await h.api
      .put('/accounts/1/merchants/SWIGGY/category')
      .set('host', 'checksum.local')
      .set('origin', 'http://checksum.local')
      .send({ category: 'x' });
    expect(same.status).toBe(200);
  });

  it('rate-limits login attempts per client', async () => {
    const { app } = await makeHarness((await stores[0]![1]()));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(app).post('/auth/login').send({ email: 'me@example.com', password: 'wrong password' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // even the right password is refused until the window resets
    expect((await request(app).post('/auth/login').send({ email: 'me@example.com', password: PASSWORD })).status).toBe(429);
  });
});
