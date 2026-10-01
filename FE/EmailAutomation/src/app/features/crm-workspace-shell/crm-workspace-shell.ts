import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { DashboardTicket } from '../user-dashboard/models/user-dashboard.model';
import { PortalHandoffService } from '../customer-payment-receipt/services/portal-handoff.service';
import { SideNavScreen } from '../../shared/components/side-nav/side-nav';

/** The screens the workspace switches between. */
export type WorkspaceScreen = 'automation' | 'dashboard' | 'payment-receipt';

/**
 * Holds the screens of the workspace and the pair of pill buttons that
 * switch between them.
 *
 * The switch is in-page rather than routed: the Email Automation screen owns
 * the whole viewport and keeps a lot of live state (the selected thread, its
 * pipeline, an open popup), and a route change would throw all of it away
 * every time someone glanced at the dashboard and came back.
 *
 * `*ngIf` rather than a hidden class, so the dashboard issues no HTTP at all
 * until it is first opened. UserDashboardService caches per date, so coming
 * back to it a second time costs nothing.
 */
@Component({
  selector: 'app-crm-workspace-shell',
  standalone: false,
  templateUrl: './crm-workspace-shell.html',
  styleUrl: './crm-workspace-shell.scss',
})
export class CrmWorkspaceShell implements OnInit {
  screen: WorkspaceScreen = 'automation';

  /**
   * The thread the Email Automation screen should open on, when it was
   * reached by clicking Open on a dashboard ticket.
   *
   * Set before the screen switches, so the receipts panel already has it as
   * its wanted thread by the time its first load settles and it never opens
   * on the wrong row first.
   */
  pendingThreadId: string | null = null;

  /**
   * PortalHandoffService is injected here only so it exists from the moment the
   * workspace loads: after a reload mid-hand-off it resumes waiting for the
   * Customer Payment Portal's result, whichever screen is showing.
   */
  constructor(
    private readonly route: ActivatedRoute,
    private readonly portalHandoff: PortalHandoffService
  ) {}

  ngOnInit(): void {
    // ?screen=payment-receipt — the side bar's way in from the New Dashboard page.
    if (this.route.snapshot.queryParamMap.get('screen') === 'payment-receipt') {
      this.screen = 'payment-receipt';
    }
  }

  navigateTo(screen: SideNavScreen): void {
    if (screen === 'dashboard') {
      this.showDashboard();
    } else if (screen === 'payment-receipt') {
      this.showPaymentReceipt();
    } else {
      this.showAutomation();
    }
  }

  showDashboard(): void {
    this.screen = 'dashboard';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  showAutomation(): void {
    // Cleared, or the nav button would keep reopening whichever ticket was
    // last drilled into rather than the newest thread.
    this.pendingThreadId = null;
    this.screen = 'automation';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  showPaymentReceipt(): void {
    this.screen = 'payment-receipt';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Open, from a dashboard ticket: the automation screen, on that thread. */
  showTicketInWorkflow(ticket: DashboardTicket): void {
    this.pendingThreadId = ticket.threadId || null;
    this.screen = 'automation';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
