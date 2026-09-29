/**
 * Shape of `public/config.json`.
 *
 * This file is copied as-is into the build output (see angular.json assets)
 * and fetched by ConfigService at app startup, so its values can be edited
 * directly on the deployed server at any time (no rebuild required) —
 * just refresh the browser to pick up changes.
 *
 * Besides the app settings, it also carries the business master data
 * (`users` and `projectMappings`) for exactly that reason: the CRM team needs
 * to add projects and reassign mailboxes in production without a redeploy.
 */

/**
 * Which stage of the customer journey a CRM user handles.
 *
 * The booking's own BOOKING_STATUS_NAME says which stage a thread is at (see
 * AppConfig.bookingStatusSlots), and that is what decides who owns it.
 */
export type CrmSlot = 'Pre-Agreement' | 'Post-Agreement' | 'Post-Possession';

/** The three slots, in journey order. */
export const CRM_SLOTS: CrmSlot[] = ['Pre-Agreement', 'Post-Agreement', 'Post-Possession'];

/** A CRM user and the mailbox their project correspondence goes to. */
export interface MasterUser {
  /** Display name exactly as maintained in the master sheet, e.g. 'KAILASH D'. */
  name: string;
  /** CRM mailbox address, e.g. 'CRM2@PRIDEWORLDCITY.COM'. */
  emailId: string;
  /**
   * The stage this user handles, e.g. 'Post-Agreement'.
   *
   * Capital S because that is how the key is spelled in config.json, which the
   * CRM team edits by hand on the server — the property matches the file rather
   * than the TS convention so nothing has to translate between the two. Read it
   * through ConfigService.slotOf(), which also tolerates the lower-case key and
   * stray casing in the value.
   *
   * Optional: a user with no slot is simply never picked by the slot rules, and
   * a config.json written before slots existed still boots.
   */
  Slot?: string;
  /** Tolerated alias for a hand-edited file that used the lower-case key. */
  slot?: string;
}

/** One project and the users responsible for it, grouped under its owning company. */
export interface ProjectMapping {
  company: string;
  projectName: string;
  /** Names referencing MasterUser.name. May be empty when nobody is assigned yet. */
  users: string[];
}

export interface AppConfig {
  /** Base URL for all backend API calls, e.g. https://api.pridegroup.co.in/api */
  apiBaseUrl: string;
  /** Human-readable environment label (e.g. 'development', 'staging', 'production'). */
  environmentName: string;
  /** Display name of the application. */
  appName: string;
  /** App version shown in footer/about; bump manually on release. */
  version: string;
  /**
   * Master user → CRM email list. Optional so a server still running an older
   * config.json (without these sections) boots instead of failing at startup.
   */
  users?: MasterUser[];
  /** Master company → project → assigned users mapping. */
  projectMappings?: ProjectMapping[];
  /**
   * The booking statuses of SALES_BOOKING_DETAILS.BOOKING_STATUS_NAME, grouped
   * by the slot each one belongs to — the 23 steps of the CRM journey, kept here
   * so a status can be re-staged in production without a rebuild.
   *
   * A status written with a spaced slash ('ALLOTMENT LETTER / LOI') matches
   * either side of it as well as the whole line; an unspaced one
   * ('BSL/OWN CONT. COLLECTED') is a single name. Optional: without this section
   * no status resolves to a slot, and every matched thread asks the reviewer who
   * should own it.
   */
  bookingStatusSlots?: { [slot: string]: string[] };
  /**
   * Who owns a receipt when its Project/Sub Project cannot be matched to any
   * mapping above — the CRM head, so no email is left without an owner.
   * Optional: ConfigService falls back to a built-in default if absent.
   */
  fallbackUser?: MasterUser;
  /**
   * Name stamped on the audit log's UpdatedBy for every reviewer correction.
   *
   * Static until the app has a sign-in: there is no user identity to send, and a
   * blank column would be worse than a known label. Kept here so it can be
   * changed on the deployed server without a rebuild.
   */
  updatedBy?: string;
}
