import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { AppConfig, CRM_SLOTS, CrmSlot, MasterUser, ProjectMapping } from '../models/app-config.model';

/**
 * Loads runtime configuration from `public/config.json` once, at app startup
 * (see `provideAppInitializer` in AppModule). Because the file is fetched at
 * runtime rather than baked into the JS bundle, it can be edited on the
 * deployed server at any time — no rebuild/redeploy needed, just a browser
 * refresh.
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private config: AppConfig | null = null;

  /**
   * Booking status → slot, built once from bookingStatusSlots on first use and
   * dropped whenever a new config.json is loaded. Keyed by statusKey(), so a
   * lookup never re-walks the 23 statuses.
   */
  private statusSlots: Map<string, CrmSlot> | null = null;

  constructor(private readonly http: HttpClient) {}

  /**
   * Fetches and caches config.json. Call once, before the app renders.
   *
   * The `?v=` timestamp busts the browser's HTTP cache — without it, a
   * browser that already loaded the app once can keep serving an old cached
   * copy of config.json indefinitely, silently ignoring edits made on the
   * server. That would defeat the whole point of this file being editable
   * post-deployment without a rebuild.
   */
  async loadConfig(): Promise<void> {
    this.config = await firstValueFrom(
      this.http.get<AppConfig>(`/config.json?v=${Date.now()}`)
    );
    this.statusSlots = null;
  }

  /** Returns the loaded config. Throws if called before loadConfig() resolves. */
  get(): AppConfig {
    if (!this.config) {
      throw new Error(
        'ConfigService: config.json has not been loaded yet. Ensure the app initializer has completed.'
      );
    }
    return this.config;
  }

  get apiBaseUrl(): string {
    return this.get().apiBaseUrl;
  }

  get environmentName(): string {
    return this.get().environmentName;
  }

  /** Master user list from config.json. Empty array if the section is absent. */
  get users(): MasterUser[] {
    return this.get().users ?? [];
  }

  /** Master company → project → users mapping. Empty array if absent. */
  get projectMappings(): ProjectMapping[] {
    return this.get().projectMappings ?? [];
  }

  /**
   * The catch-all owner for receipts whose project/sub-project cannot be
   * matched. Hard-coded default so a server still running an older config.json
   * (without the section) keeps routing unmatched rows somewhere real.
   */
  get fallbackUser(): MasterUser {
    return (
      this.get().fallbackUser ?? { name: 'CRM_Head', emailId: 'gaidhanivishnu34@gmail.com' }
    );
  }

  /**
   * config.json's FromEmail.emailId: the default From address for every reply.
   * '' when the section is absent, so callers fall back to the thread's owner.
   */
  get fromEmail(): string {
    return (this.get().FromEmail?.emailId ?? '').trim();
  }

  /**
   * Who reviewer corrections are logged against. Hard-coded default so an older
   * config.json still stamps something meaningful rather than a blank column.
   */
  get updatedBy(): string {
    return this.get().updatedBy ?? 'CRM UI';
  }

  /**
   * Looks up a user's CRM email by name (case-insensitive). Returns '' if unknown.
   *
   * The fallback owner is checked after the master list because it lives in its
   * own `fallbackUser` section rather than in `users[]` — without this, a thread
   * Unit Match routed to the catch-all (CRM_Head) resolves to no mailbox at all,
   * even though the config gives it one.
   *
   * A value that already is a mailbox comes back as it stands: [Assigned To]
   * stores the emailId, so callers may hand either spelling in.
   */
  getEmailForUser(name: string): string {
    const raw = (name ?? '').trim();

    if (raw.indexOf('@') !== -1) {
      return raw;
    }

    const target = raw.toLowerCase();
    const match = this.users.find((u) => u.name.toLowerCase() === target);

    if (match) {
      return match.emailId;
    }

    const fallback = this.fallbackUser;

    return target && fallback.name.trim().toLowerCase() === target ? fallback.emailId : '';
  }

  /**
   * The mailbox an [Assigned To] value stands for — what the column stores.
   * Rows written before it stored the emailId hold the config.json name; this
   * folds them onto the same mailbox so one person is never two owners. A
   * value config.json does not know comes back as it stands.
   */
  mailboxOf(value: string | null | undefined): string {
    const raw = (value ?? '').trim();

    return this.getEmailForUser(raw) || raw;
  }

  /**
   * Booking status → slot, exactly as config.json groups them. Empty object if
   * the section is absent.
   */
  get bookingStatusSlots(): { [slot: string]: string[] } {
    return this.get().bookingStatusSlots ?? {};
  }

  /**
   * The slot a master user handles, or null when they have none or it is spelt
   * as no known slot.
   *
   * Reads the capital-S key config.json uses and the lower-case alias, so a
   * hand-edit either way still works, and matches the value loosely enough that
   * 'pre-agreement' and 'Pre Agreement' both land on 'Pre-Agreement'.
   */
  slotOf(user: MasterUser | null | undefined): CrmSlot | null {
    const written = this.statusKey(user?.Slot ?? user?.slot ?? '');

    if (!written) {
      return null;
    }

    return CRM_SLOTS.find((slot) => this.statusKey(slot) === written) ?? null;
  }

  /**
   * Every master user in one slot, in config.json order.
   *
   * Never includes fallbackUser: the catch-all owner lives outside users[] and
   * carries no slot, so a slot rule can never pick it by accident — it is only
   * ever chosen deliberately, when nothing else resolves.
   */
  usersInSlot(slot: CrmSlot): MasterUser[] {
    return this.users.filter((user) => this.slotOf(user) === slot);
  }

  /**
   * The slot a booking status belongs to, or null when the status is blank, the
   * '—' the pipeline card shows for a missing value, or a name config.json does
   * not list.
   *
   * Null is the "ask a human" answer, not an error: BOOKING_STATUS_NAME is
   * master data this app does not own, so a status nobody has staged yet must be
   * visible rather than guessed at.
   */
  slotForBookingStatus(status: string | null | undefined): CrmSlot | null {
    const key = this.statusKey(status ?? '');

    return key ? this.statusSlotMap().get(key) ?? null : null;
  }

  /**
   * Comparison form of a status or slot name: upper case, and every run of
   * punctuation or space collapsed to one space.
   *
   * The statuses carry '/', '&' and '.' ("BSL/OWN CONT. COLLECTED"), and the
   * exports are not consistent about the spacing around them, so comparing the
   * raw text would miss on a stray full stop. An em-dash normalises to '',
   * which is what makes the card's "—" placeholder read as "no status".
   */
  private statusKey(value: string): string {
    return (value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  }

  private statusSlotMap(): Map<string, CrmSlot> {
    if (this.statusSlots) {
      return this.statusSlots;
    }

    const map = new Map<string, CrmSlot>();
    const grouped = this.bookingStatusSlots;

    for (const slot of CRM_SLOTS) {
      for (const status of grouped[slot] ?? []) {
        // The whole line, plus — when it joins two names with a spaced slash,
        // "ALLOTMENT LETTER / LOI" — each name on its own, since the booking
        // holds one of them rather than the pair. An unspaced slash is part of
        // the name itself ("BSL/OWN CONT. COLLECTED") and is left alone.
        for (const name of [status, ...status.split(' / ')]) {
          const key = this.statusKey(name);

          if (key && !map.has(key)) {
            map.set(key, slot);
          }
        }
      }
    }

    this.statusSlots = map;

    return map;
  }
}
