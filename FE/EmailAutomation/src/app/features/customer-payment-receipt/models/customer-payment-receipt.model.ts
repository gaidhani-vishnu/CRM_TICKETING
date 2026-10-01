/** A customer of one unit, with the booking (ACCOUNT_ITEM_NO) the name stands for. */
export interface CustomerOption {
  accountItemNo: string;
  customerName: string;
}

/** POST api/customerpaymentreceipt/handoff-token */
export interface HandoffTokenResponse {
  handoffId: string;
  token: string;
  /** The portal page to open, the token already in its #fragment. */
  portalUrl: string;
  expiresAt: string;
}

/** GET api/customerpaymentreceipt/handoff-status */
export interface HandoffStatusResponse {
  handoffId: string;
  status: 'PENDING' | 'RECORD_SAVED' | 'SESSION_EXPIRED';
  accountItemNo: string;
  ticketNumber: string;
}

// ── Cross-tab contract with the Customer Payment Portal ─────────
//
// Must match the portal's models/portal-handoff.model.ts: the portal posts
// { channel, event } to this tab with window.opener.postMessage, and on a
// BroadcastChannel of the same name.

export const PORTAL_HANDOFF_CHANNEL = 'customer-payment-receipt';

export interface RecordSavedEvent {
  type: 'RECORD_SAVED';
  handoffId: string | null;
  accountItemNo: string;
  ticketNumber: string | null;
  message: string;
}

export interface SessionExpiredEvent {
  type: 'SESSION_EXPIRED';
  handoffId: string | null;
  message: string;
}

export type PortalHandoffEvent = RecordSavedEvent | SessionExpiredEvent;

export interface PortalHandoffMessage {
  channel: typeof PORTAL_HANDOFF_CHANNEL;
  event: PortalHandoffEvent;
}

/**
 * Everything PortalHandoffService reports to the screen: the portal's two
 * events, plus the portal tab having been closed by hand with neither.
 */
export type HandoffOutcome =
  | PortalHandoffEvent
  | { type: 'PORTAL_CLOSED'; handoffId: string };
