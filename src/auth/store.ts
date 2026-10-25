import type { Account, User } from './types';

export interface AuthStore {
  /** Returns null when the email is already registered (emails are stored lower-cased). */
  createUser(email: string, passwordHash: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null>;

  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** The session's user, or null if the session is unknown or expired. */
  findSessionUser(tokenHash: string): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;

  createAccount(userId: string, name: string): Promise<Account>;
  listAccounts(userId: string): Promise<Account[]>;
  ownsAccount(userId: string, accountId: string): Promise<boolean>;
}

interface MemUser extends User {
  passwordHash: string;
}

export class InMemoryAuthStore implements AuthStore {
  private users: MemUser[] = [];
  private sessions = new Map<string, { userId: string; expiresAt: number }>();
  private accounts: (Account & { userId: string })[] = [];
  private userSeq = 0;
  private accountSeq = 0;

  async createUser(email: string, passwordHash: string) {
    if (this.users.some((u) => u.email === email)) return null;
    const user = { id: String(++this.userSeq), email, createdAt: new Date().toISOString() };
    this.users.push({ ...user, passwordHash });
    return user;
  }

  async findUserByEmail(email: string) {
    const u = this.users.find((x) => x.email === email);
    return u ? { ...u } : null;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    this.sessions.set(tokenHash, { userId, expiresAt: expiresAt.getTime() });
  }

  async findSessionUser(tokenHash: string) {
    const s = this.sessions.get(tokenHash);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    const u = this.users.find((x) => x.id === s.userId);
    return u ? { id: u.id, email: u.email, createdAt: u.createdAt } : null;
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async createAccount(userId: string, name: string) {
    const account = { id: String(++this.accountSeq), name, createdAt: new Date().toISOString() };
    this.accounts.push({ ...account, userId });
    return account;
  }

  async listAccounts(userId: string) {
    return this.accounts.filter((a) => a.userId === userId).map(({ userId: _u, ...a }) => a);
  }

  async ownsAccount(userId: string, accountId: string) {
    return this.accounts.some((a) => a.id === accountId && a.userId === userId);
  }
}
