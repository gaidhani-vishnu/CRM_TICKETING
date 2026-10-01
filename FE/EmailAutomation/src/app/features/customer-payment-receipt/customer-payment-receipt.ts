import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Subscription } from 'rxjs';

import { ToastService } from '../../core/services/toast.service';
import { CustomerOption, HandoffOutcome } from './models/customer-payment-receipt.model';
import { CustomerPaymentReceiptService } from './services/customer-payment-receipt.service';
import { PortalHandoffService } from './services/portal-handoff.service';

type Level = 'project' | 'subProject' | 'unit' | 'customer';

/**
 * The Customer Payment Receipt screen, open to every role.
 *
 * Project → Sub Project → Unit → Customer, each a typeable list (<datalist>)
 * filled from the live rows of SALES_BOOKING_DETAILS and narrowed by the level
 * above it. Picking the customer settles the booking, and Create Record opens
 * the Customer Payment Portal in a new tab on that booking's attachment
 * screen, email verification skipped.
 *
 * The portal reports back through PortalHandoffService: a save clears the
 * choices here for the next one, an expiry leaves them so Create Record can
 * simply be pressed again.
 */
@Component({
  selector: 'app-customer-payment-receipt',
  standalone: false,
  templateUrl: './customer-payment-receipt.html',
  styleUrl: './customer-payment-receipt.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerPaymentReceipt implements OnInit, OnDestroy {
  // What is typed in each box.
  project = '';
  subProject = '';
  unit = '';
  customer = '';

  // What each datalist offers.
  projects: string[] = [];
  subProjects: string[] = [];
  units: string[] = [];
  customers: CustomerOption[] = [];

  /** Which list is being fetched, for the field's own "loading" hint. */
  loading: Record<Level, boolean> = { project: false, subProject: false, unit: false, customer: false };

  /** The booking Create Record will open, or null until a customer is picked. */
  selectedBooking: CustomerOption | null = null;

  /** Set while the hand-off token is being signed. */
  creating = false;

  private readonly subscriptions = new Subscription();
  private readonly levelLoads: Partial<Record<Level, Subscription>> = {};

  constructor(
    private readonly api: CustomerPaymentReceiptService,
    readonly handoff: PortalHandoffService,
    private readonly toast: ToastService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.subscriptions.add(
      this.handoff.outcomes$.subscribe((outcome) => this.onHandoffOutcome(outcome))
    );

    this.loadProjects();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();

    for (const load of Object.values(this.levelLoads)) {
      load?.unsubscribe();
    }
  }

  // ── View state ───────────────────────────────────────────────

  get canCreate(): boolean {
    return !!this.selectedBooking && !this.creating && !this.handoff.isPending;
  }

  get hasAnyFilter(): boolean {
    return !!(this.project || this.subProject || this.unit || this.customer);
  }

  // ── The four levels ──────────────────────────────────────────
  //
  // A level only counts once its text is one of the offered values — typing
  // half a project name loads nothing below it.

  onProjectChange(value: string): void {
    this.project = value;
    this.clearBelow('project');

    if (this.projects.includes(value)) {
      this.loadSubProjects();
    }
  }

  onSubProjectChange(value: string): void {
    this.subProject = value;
    this.clearBelow('subProject');

    if (this.subProjects.includes(value)) {
      this.loadUnits();
    }
  }

  onUnitChange(value: string): void {
    this.unit = value;
    this.clearBelow('unit');

    if (this.units.includes(value)) {
      this.loadCustomers();
    }
  }

  /** The customer is the last level: a name from the list is a booking. */
  onCustomerChange(value: string): void {
    this.customer = value;
    this.selectedBooking = this.customers.find((option) => option.customerName === value) ?? null;
    this.cdr.markForCheck();
  }

  clearAll(): void {
    this.project = '';
    this.clearBelow('project');
  }

  private clearBelow(level: Level): void {
    const order: Level[] = ['project', 'subProject', 'unit', 'customer'];

    for (const below of order.slice(order.indexOf(level) + 1)) {
      this.levelLoads[below]?.unsubscribe();
      this.loading[below] = false;
      this[below] = '';
    }

    if (level === 'project') this.subProjects = [];
    if (level === 'project' || level === 'subProject') this.units = [];
    this.customers = [];

    this.selectedBooking = null;
    this.cdr.markForCheck();
  }

  private loadProjects(): void {
    this.loading.project = true;

    this.api.getProjects().subscribe({
      next: (values) => {
        this.projects = values;
        this.loading.project = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.projects = [];
        this.loading.project = false;
        this.toast.error('Could not load the project list.', 'Customer Payment Receipt');
        this.cdr.markForCheck();
      },
    });
  }

  // Each list below fills itself in when it has exactly one value — a unit
  // with one live customer has no choice to make.

  private loadSubProjects(): void {
    this.levelLoads.subProject?.unsubscribe();
    this.loading.subProject = true;

    this.levelLoads.subProject = this.api.getSubProjects(this.project).subscribe({
      next: (values) => {
        this.subProjects = values;
        this.loading.subProject = false;

        if (values.length === 1) {
          this.onSubProjectChange(values[0]);
        }

        this.cdr.markForCheck();
      },
      error: () => this.onLevelFailed('subProject'),
    });
  }

  private loadUnits(): void {
    this.levelLoads.unit?.unsubscribe();
    this.loading.unit = true;

    this.levelLoads.unit = this.api.getUnits(this.project, this.subProject).subscribe({
      next: (values) => {
        this.units = values;
        this.loading.unit = false;

        if (values.length === 1) {
          this.onUnitChange(values[0]);
        }

        this.cdr.markForCheck();
      },
      error: () => this.onLevelFailed('unit'),
    });
  }

  private loadCustomers(): void {
    this.levelLoads.customer?.unsubscribe();
    this.loading.customer = true;

    this.levelLoads.customer = this.api
      .getCustomers(this.project, this.subProject, this.unit)
      .subscribe({
        next: (values) => {
          this.customers = values;
          this.loading.customer = false;

          if (values.length === 1) {
            this.onCustomerChange(values[0].customerName);
          }

          this.cdr.markForCheck();
        },
        error: () => this.onLevelFailed('customer'),
      });
  }

  private onLevelFailed(level: Level): void {
    this.loading[level] = false;
    this.toast.error('Could not load the list. Please try again.', 'Customer Payment Receipt');
    this.cdr.markForCheck();
  }

  // ── Create Record ────────────────────────────────────────────

  /**
   * Opens the Customer Payment Portal on the chosen booking, in a new tab.
   *
   * The tab is opened first, synchronously inside the click, because a popup
   * blocker only lets a click open one; it is pointed at the portal once the
   * hand-off token is signed. It keeps its opener — the portal reports its
   * result back through it — and is navigated with location.replace so its
   * history stays one entry long and the portal may close it when done.
   */
  createRecord(): void {
    const booking = this.selectedBooking;

    if (!booking || !this.canCreate) {
      return;
    }

    const portal = window.open('', '_blank');

    if (!portal) {
      this.toast.error(
        'The browser blocked the new tab. Allow pop-ups for this site and press Create Record again.',
        'Create Record'
      );
      return;
    }

    try {
      portal.document.title = 'Opening Customer Payment Portal…';
      portal.document.body.textContent = 'Opening the Customer Payment Portal…';
    } catch {
      // Cosmetic only.
    }

    this.creating = true;
    this.cdr.markForCheck();

    this.api.createHandoff(booking.accountItemNo).subscribe({
      next: (response) => {
        this.creating = false;
        this.handoff.start(portal, response, booking.accountItemNo);
        portal.location.replace(response.portalUrl);
        this.cdr.markForCheck();
      },
      error: (error) => {
        this.creating = false;

        try {
          portal.close();
        } catch {
          // Already gone.
        }

        this.toast.error(
          error?.error?.message || 'Could not open the Customer Payment Portal. Please try again.',
          'Create Record'
        );
        this.cdr.markForCheck();
      },
    });
  }

  private onHandoffOutcome(outcome: HandoffOutcome): void {
    if (outcome.type === 'RECORD_SAVED') {
      // Filed: start the next one from a clean screen, with a fresh list in
      // case the save changed what is live.
      this.clearAll();
      this.loadProjects();
    }

    // SESSION_EXPIRED and PORTAL_CLOSED keep the choices, so the same booking
    // is one press of Create Record away.
    this.cdr.markForCheck();
  }
}
