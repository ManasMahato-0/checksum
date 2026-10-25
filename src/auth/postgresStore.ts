import type { Db } from '../db/db';
import type { AuthStore } from './store';
import type { Account, User } from './types';

const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type Row = Record<string, string | number | null>;
const toUser = (r: Row): User => ({ id: String(r.id), email: String(r.email), createdAt: String(r.created_at) });
const toAccount = (r: Row): Account => ({ id: String(r.id), name: String(r.name), createdAt: String(r.created_at) });

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: Db) {}

  async createUser(email: string, passwordHash: string) {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, ${iso('created_at')} AS created_at`,
      [email, passwordHash],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findUserByEmail(email: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT id, email, password_hash, ${iso('created_at')} AS created_at FROM users WHERE email = $1`,
      [email],
    );
    const r = rows[0];
    return r ? { ...toUser(r), passwordHash: String(r.password_hash) } : null;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    await this.db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
      tokenHash,
      userId,
      expiresAt.toISOString(),
    ]);
  }

  async findSessionUser(tokenHash: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT u.id, u.email, ${iso('u.created_at')} AS created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async deleteSession(tokenHash: string) {
    await this.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
  }

  async createAccount(userId: string, name: string) {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO accounts (user_id, name) VALUES ($1, $2) RETURNING id, name, ${iso('created_at')} AS created_at`,
      [userId, name],
    );
    return toAccount(rows[0]!);
  }

  async listAccounts(userId: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT id, name, ${iso('created_at')} AS created_at FROM accounts WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return rows.map(toAccount);
  }

  async ownsAccount(userId: string, accountId: string) {
    const { rows } = await this.db.query(`SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2`, [accountId, userId]);
    return rows.length > 0;
  }
}
