import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { ConfigService } from './config.service';
import { LoginResponse, LoginUser, StoredSession } from '../models/auth.model';

/** Web Storage key the session is written under, in either store. */
const STORAGE_KEY = 'pride.auth.session';

/**
 * Talks to POST api/usermaster/login
 * (BE/EmailAutomation/EmailAutomation/Controllers/UserMasterController.cs)
 * and holds the signed-in session in whichever Web Storage Remember Me
 * picked — localStorage so it survives closing the browser, sessionStorage
 * so it doesn't.
 *
 * Every storage access is wrapped in try/catch: a browser with storage
 * disabled (private mode, a locked-down policy) must still let the app run
 * — it just means the visitor is asked to log in again on the next visit.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(
    private readonly http: HttpClient,
    private readonly config: ConfigService
  ) {}

  /**
   * POST api/usermaster/login. On success, stores the session and resolves
   * with the signed-in user. On failure, rejects with the HttpErrorResponse
   * — the login screen reads `.error.message` off it for the banner text.
   */
  async login(username: string, password: string, rememberMe: boolean): Promise<LoginUser> {
    const response = await firstValueFrom(
      this.http.post<LoginResponse>(`${this.config.apiBaseUrl}/usermaster/login`, {
        username,
        password,
      })
    );

    this.save(response, rememberMe);

    return response.user;
  }

  /** True when a session is stored and its expiresAt has not passed. */
  isLoggedIn(): boolean {
    return this.liveSession() !== null;
  }

  /** The signed-in user, or null when logged out / the session has expired. */
  get currentUser(): LoginUser | null {
    return this.liveSession()?.user ?? null;
  }

  /**
   * The signed login token, or null when logged out / expired. Sent as
   * `Authorization: Bearer` by the few calls the backend checks it on — the
   * Customer Payment Portal hand-off, for now.
   */
  get token(): string | null {
    return this.liveSession()?.token ?? null;
  }

  logout(): void {
    this.clear();
  }

  /** The stored session, but only if it hasn't expired — null otherwise. */
  private liveSession(): StoredSession | null {
    const session = this.read();

    if (!session) {
      return null;
    }

    return new Date(session.expiresAt).getTime() > Date.now() ? session : null;
  }

  private save(response: LoginResponse, rememberMe: boolean): void {
    const session: StoredSession = {
      token: response.token,
      expiresAt: response.expiresAt,
      user: response.user,
    };

    // Cleared from both stores first, so a stale copy left in the other one
    // never resurrects a session the visitor chose not to remember.
    this.clear();

    try {
      const store = rememberMe ? localStorage : sessionStorage;
      store.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage unavailable — the login still succeeded for this request;
      // it just won't survive a refresh.
    }
  }

  private read(): StoredSession | null {
    const stores: Storage[] = [];

    try {
      stores.push(localStorage);
    } catch {
      // Unavailable — skip it.
    }

    try {
      stores.push(sessionStorage);
    } catch {
      // Unavailable — skip it.
    }

    for (const store of stores) {
      try {
        const raw = store.getItem(STORAGE_KEY);

        if (raw) {
          return JSON.parse(raw) as StoredSession;
        }
      } catch {
        // Corrupt entry or storage access denied — treated as "no session".
      }
    }

    return null;
  }

  private clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }

    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }
}
