import { Injectable } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subject, Subscription, interval } from 'rxjs';

import { ToastService } from '../../../core/services/toast.service';
import {
  HandoffOutcome,
  HandoffStatusResponse,
  HandoffTokenResponse,
  PORTAL_HANDOFF_CHANNEL,
  PortalHandoffEvent,
} from '../models/customer-payment-receipt.model';
import { CustomerPaymentReceiptService } from './customer-payment-receipt.service';

/** The hand-off this tab is waiting on. */
interface PendingHandoff {
  handoffId: string;
  accountItemNo: string;
  /** The portal's origin — the only one a postMessage is accepted from. */
  portalOrigin: string;
  /** The tab Create Record opened. Null after this tab was reloaded mid-hand-off. */
  win: Window | null;
}

/** sessionStorage key, so a reloaded ticketing tab picks the wait back up. */
const STORAGE_KEY = 'pride.portal.handoff';

const POLL_MS = 5000;

/**
 * Status polls a closed portal tab may still be PENDING for before it counts
 * as closed without saving. The portal notifies before it closes itself and
 * closes out its own hand-off row, so this grace only covers that last write
 * still being on its way.
 */
const CLOSED_GRACE_TICKS = 2;

const EXPIRED_MESSAGE = 'Customer Payment Portal session expired. Please create the record again.';

/**
 * The Email Ticketing side of the Customer Payment Portal hand-off: waits for
 * the portal tab Create Record opened to report RECORD_SAVED or
 * SESSION_EXPIRED, shows the result, and tells the screen.
 *
 * Three channels, because the portal is a separately hosted app:
 *
 *  1. window.postMessage from the portal tab (window.opener). Works across
 *     origins; accepted only from the portal's origin AND from the very
 *     window this tab opened.
 *  2. A poll of GET handoff-status every 5 s. The portal backend writes the
 *     outcome to PRIDE_PORTAL_HANDOFF, so this still lands when the opener
 *     link is gone — this tab was reloaded, or the browser severed it.
 *  3. BroadcastChannel('customer-payment-receipt'). Same-origin only, so it
 *     only ever fires if both apps are deployed on one origin.
 *
 * Whichever arrives first is processed, exactly once; the rest are dropped.
 *
 * App-lifetime (providedIn root) rather than owned by the screen, so a result
 * that arrives while the user is on another screen is still shown.
 */
@Injectable({ providedIn: 'root' })
export class PortalHandoffService {
  private pending: PendingHandoff | null = null;

  /** Hand-offs already reported, so a late duplicate on another channel is ignored. */
  private readonly processed = new Set<string>();

  private readonly outcomes = new Subject<HandoffOutcome>();
  readonly outcomes$: Observable<HandoffOutcome> = this.outcomes.asObservable();

  private poll: Subscription | null = null;
  private channel: BroadcastChannel | null = null;
  private closedTicks = 0;
  private polling = false;

  private readonly onWindowMessage = (event: MessageEvent): void => this.handleWindowMessage(event);

  constructor(
    private readonly api: CustomerPaymentReceiptService,
    private readonly toast: ToastService
  ) {
    this.resume();
  }

  /** True while a portal tab is open on a hand-off and has not reported back. */
  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Called by Create Record once the hand-off is signed, before the tab is navigated. */
  start(win: Window, response: HandoffTokenResponse, accountItemNo: string): void {
    this.stop();

    let portalOrigin = '';

    try {
      portalOrigin = new URL(response.portalUrl, window.location.href).origin;
    } catch {
      // Unparseable portal URL: postMessage is never accepted, the poll still works.
    }

    this.pending = { handoffId: response.handoffId, accountItemNo, portalOrigin, win };
    this.persist();
    this.listen();
  }

  // ── Listening ────────────────────────────────────────────────

  private listen(): void {
    window.addEventListener('message', this.onWindowMessage);

    if ('BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel(PORTAL_HANDOFF_CHANNEL);
        this.channel.onmessage = (event: MessageEvent) => this.handleChannelMessage(event);
      } catch {
        this.channel = null;
      }
    }

    this.closedTicks = 0;
    this.poll = interval(POLL_MS).subscribe(() => this.tick());
  }

  private stop(): void {
    window.removeEventListener('message', this.onWindowMessage);

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.poll?.unsubscribe();
    this.poll = null;
    this.polling = false;
    this.closedTicks = 0;

    this.pending = null;
    this.forget();
  }

  /** postMessage from the portal tab. */
  private handleWindowMessage(event: MessageEvent): void {
    const pending = this.pending;

    if (!pending || !pending.portalOrigin || event.origin !== pending.portalOrigin) {
      return;
    }

    const handoffEvent = this.readEvent(event.data);

    if (!handoffEvent) {
      return;
    }

    if (pending.win) {
      // The window this tab opened, and no other. A null handoffId is the portal
      // saying it could not even read the token; it is only trusted from there.
      if (event.source !== pending.win) {
        return;
      }

      if (handoffEvent.handoffId && handoffEvent.handoffId !== pending.handoffId) {
        return;
      }
    } else if (handoffEvent.handoffId !== pending.handoffId) {
      // Reloaded mid-hand-off: no window to compare against, so the id must match.
      return;
    }

    this.complete(handoffEvent);
  }

  /** BroadcastChannel: same origin only, and no sender to check, so the id must match. */
  private handleChannelMessage(event: MessageEvent): void {
    const pending = this.pending;
    const handoffEvent = this.readEvent(event.data);

    if (pending && handoffEvent && handoffEvent.handoffId === pending.handoffId) {
      this.complete(handoffEvent);
    }
  }

  /** The event inside a { channel, event } message, or null for anything else. */
  private readEvent(data: unknown): PortalHandoffEvent | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const message = data as { channel?: unknown; event?: unknown };

    if (message.channel !== PORTAL_HANDOFF_CHANNEL || !message.event || typeof message.event !== 'object') {
      return null;
    }

    const event = message.event as Partial<PortalHandoffEvent>;
    const handoffId = typeof event.handoffId === 'string' ? event.handoffId : null;

    if (event.type === 'RECORD_SAVED') {
      const saved = event as Partial<Extract<PortalHandoffEvent, { type: 'RECORD_SAVED' }>>;

      return {
        type: 'RECORD_SAVED',
        handoffId,
        accountItemNo: typeof saved.accountItemNo === 'string' ? saved.accountItemNo : '',
        ticketNumber: typeof saved.ticketNumber === 'string' ? saved.ticketNumber : null,
        message: '',
      };
    }

    if (event.type === 'SESSION_EXPIRED') {
      return { type: 'SESSION_EXPIRED', handoffId, message: '' };
    }

    return null;
  }

  /** One status poll: the backstop for a message that never arrived. */
  private tick(): void {
    const pending = this.pending;

    if (!pending || this.polling) {
      return;
    }

    const portalClosed = pending.win !== null && pending.win.closed;

    if (portalClosed) {
      this.closedTicks++;
    }

    this.polling = true;

    this.api.getHandoffStatus(pending.handoffId).subscribe({
      next: (status: HandoffStatusResponse) => {
        this.polling = false;

        if (this.pending !== pending) {
          return;
        }

        if (status.status === 'RECORD_SAVED') {
          this.complete({
            type: 'RECORD_SAVED',
            handoffId: pending.handoffId,
            accountItemNo: status.accountItemNo || pending.accountItemNo,
            ticketNumber: status.ticketNumber || null,
            message: '',
          });
        } else if (status.status === 'SESSION_EXPIRED') {
          this.complete({ type: 'SESSION_EXPIRED', handoffId: pending.handoffId, message: '' });
        } else if (portalClosed && this.closedTicks >= CLOSED_GRACE_TICKS) {
          this.abandon();
        }
      },
      error: (error: HttpErrorResponse) => {
        this.polling = false;

        if (this.pending !== pending) {
          return;
        }

        // Not ours to read any more (signed out, another user, row gone):
        // stop waiting quietly rather than poll a 401 forever.
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          this.stop();
          this.outcomes.next({ type: 'PORTAL_CLOSED', handoffId: pending.handoffId });
          return;
        }

        if (portalClosed && this.closedTicks >= CLOSED_GRACE_TICKS) {
          this.abandon();
        }
      },
    });
  }

  // ── Finishing ────────────────────────────────────────────────

  /** Reports a hand-off's result. Runs once per hand-off, whichever channel got here first. */
  private complete(event: PortalHandoffEvent): void {
    const pending = this.pending;

    if (!pending || this.processed.has(pending.handoffId)) {
      return;
    }

    this.processed.add(pending.handoffId);
    this.stop();

    // The text is built here, never taken from the message: a posted string is
    // only as trustworthy as whoever posted it.
    if (event.type === 'RECORD_SAVED') {
      const ticket = (event.ticketNumber ?? '').trim().slice(0, 50);
      const message = ticket
        ? `Record saved successfully. Ticket ${ticket} generated.`
        : 'Record saved successfully.';

      this.toast.success(message, 'Customer Payment Receipt');
      this.outcomes.next({ ...event, handoffId: pending.handoffId, ticketNumber: ticket || null, message });
    } else {
      this.toast.warning(EXPIRED_MESSAGE, 'Customer Payment Receipt');
      this.outcomes.next({ type: 'SESSION_EXPIRED', handoffId: pending.handoffId, message: EXPIRED_MESSAGE });
    }
  }

  /** The portal tab was closed by hand with nothing saved. */
  private abandon(): void {
    const pending = this.pending;

    if (!pending || this.processed.has(pending.handoffId)) {
      return;
    }

    this.processed.add(pending.handoffId);
    this.stop();

    this.toast.info('Customer Payment Portal was closed without saving.', 'Customer Payment Receipt');
    this.outcomes.next({ type: 'PORTAL_CLOSED', handoffId: pending.handoffId });
  }

  // ── Surviving a reload ───────────────────────────────────────

  private persist(): void {
    if (!this.pending) {
      return;
    }

    const { handoffId, accountItemNo, portalOrigin } = this.pending;

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ handoffId, accountItemNo, portalOrigin }));
    } catch {
      // Storage unavailable: a reload just stops waiting.
    }
  }

  private forget(): void {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }

  /** Picks up a hand-off this tab was waiting on before it was reloaded. */
  private resume(): void {
    let saved: { handoffId?: unknown; accountItemNo?: unknown; portalOrigin?: unknown } | null = null;

    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }

    if (!saved || typeof saved.handoffId !== 'string' || !saved.handoffId) {
      this.forget();
      return;
    }

    this.pending = {
      handoffId: saved.handoffId,
      accountItemNo: typeof saved.accountItemNo === 'string' ? saved.accountItemNo : '',
      portalOrigin: typeof saved.portalOrigin === 'string' ? saved.portalOrigin : '',
      win: null,
    };

    this.listen();
  }
}
