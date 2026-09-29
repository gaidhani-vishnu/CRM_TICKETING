/** One signed-in identity, as returned by POST api/usermaster/login. */
export interface LoginUser {
  userId: number;
  username: string;
  employeeName: string;
  /** Null when PRIDE_USER_MASTER.Email is not set for this user. */
  email: string | null;
  role: string;
}

/** Body of the 200 response from POST api/usermaster/login. */
export interface LoginResponse {
  token: string;
  /** ISO-8601 UTC instant (Newtonsoft's default DateTime serialization). */
  expiresAt: string;
  user: LoginUser;
}

/** One active user, as returned by GET api/usermaster/users. */
export interface UserDirectoryEntry {
  username: string;
  employeeName: string;
  /** Null when PRIDE_USER_MASTER.Email is not set for this user. */
  email: string | null;
  role: string | null;
}

/** What AuthService keeps in Web Storage — the same shape as LoginResponse. */
export interface StoredSession {
  token: string;
  expiresAt: string;
  user: LoginUser;
}
