// Plain data shapes shared by the API and the web frontend. No runtime code, no Node types.

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

/** A bank account a user tracks. Statements are imported into an account. */
export interface Account {
  id: string;
  name: string;
  createdAt: string;
}

export interface Me {
  user: User;
  accounts: Account[];
}
