import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { ConfigService } from './config.service';
import { LoginUser, UserDirectoryEntry } from '../models/auth.model';

/**
 * PRIDE_USER_MASTER's active users, read once from GET api/usermaster/users
 * at startup (see provideAppInitializer in AppModule).
 *
 * [Assigned To] on a receipt row holds either a CRM mailbox
 * ('CRMHEAD@PRIDEWORLDCITY.COM') or a config.json name ('PRINC JAIN') — Unit
 * Match writes the latter, the mail pipeline the former. This service turns
 * either back into the person: a name to show, and whether it is the
 * signed-in user.
 *
 * A failed load leaves the list empty rather than failing startup: names then
 * fall back to config.json, then to the raw value, and nothing breaks.
 */
@Injectable({ providedIn: 'root' })
export class UserDirectoryService {
  private users: UserDirectoryEntry[] = [];

  constructor(
    private readonly http: HttpClient,
    private readonly config: ConfigService
  ) {}

  async load(): Promise<void> {
    try {
      this.users = await firstValueFrom(
        this.http.get<UserDirectoryEntry[]>(`${this.config.apiBaseUrl}/usermaster/users`)
      );
    } catch {
      this.users = [];
    }
  }

  /**
   * The name to show for an [Assigned To] value: the user master's
   * EmployeeName when the value is their mailbox, username or name; the
   * config.json name when only config knows it; otherwise the value as is.
   */
  displayName(value: string | null | undefined): string {
    const raw = (value || '').trim();
    const key = raw.toLowerCase();

    if (key === '') {
      return raw;
    }

    const direct = this.users.find((user) => this.keysOf(user).indexOf(key) !== -1);

    if (direct && (direct.employeeName || '').trim()) {
      return direct.employeeName.trim();
    }

    // Config names the mailbox or the name; the user master may still know
    // the person by the mailbox config pairs it with.
    const configured = this.config.users.find(
      (user) => this.lower(user.emailId) === key || this.lower(user.name) === key
    );

    if (configured) {
      const byEmail = this.users.find(
        (user) => this.lower(user.email) !== '' && this.lower(user.email) === this.lower(configured.emailId)
      );

      return byEmail && (byEmail.employeeName || '').trim()
        ? byEmail.employeeName.trim()
        : configured.name;
    }

    return raw;
  }

  /**
   * Every lower-cased [Assigned To] value that means this user: their
   * mailbox, username and name, plus the config.json name paired with their
   * mailbox — the spelling Unit Match writes when it assigns a thread.
   */
  identityKeys(user: LoginUser | null | undefined): Set<string> {
    const keys = new Set<string>();

    if (!user) {
      return keys;
    }

    const email = this.lower(user.email);

    for (const value of [email, this.lower(user.username), this.lower(user.employeeName)]) {
      if (value !== '') {
        keys.add(value);
      }
    }

    if (email !== '') {
      for (const configured of this.config.users) {
        if (this.lower(configured.emailId) === email && this.lower(configured.name) !== '') {
          keys.add(this.lower(configured.name));
        }
      }
    }

    return keys;
  }

  private keysOf(user: UserDirectoryEntry): string[] {
    return [this.lower(user.email), this.lower(user.username), this.lower(user.employeeName)].filter(
      (value) => value !== ''
    );
  }

  private lower(value: string | null | undefined): string {
    return (value || '').trim().toLowerCase();
  }
}
