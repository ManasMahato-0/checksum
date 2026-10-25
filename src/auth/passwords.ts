import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt from node:crypto: memory-hard, no native dependency. Parameters are stored with each
// hash ("scrypt$N$r$p$salt$hash") so they can be raised later without breaking old passwords.
// SCRYPT_LOG_N exists only so the test suite can hash cheaply; leave it unset in real deployments.
const PARAMS = { N: 2 ** Number(process.env.SCRYPT_LOG_N ?? 15), r: 8, p: 1 };
const KEYLEN = 64;

function derive(password: string, salt: Buffer, o: { N: number; r: number; p: number }): Promise<Buffer> {
  const opts: ScryptOptions = { N: o.N, r: o.r, p: o.p, maxmem: 128 * o.N * o.r * 2 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Verifying against this when the email is unknown keeps login timing the same either way. */
export const DUMMY_HASH = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${'A'.repeat(22)}==$${'A'.repeat(86)}==`;

/** Session tokens: 256 random bits for the cookie; only the SHA-256 is stored, so a DB leak can't be replayed. */
export const newSessionToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
