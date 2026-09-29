import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../../core/services/auth.service';
import { LogoutService } from '../../../core/services/logout.service';
import { isAdminRole } from '../../../core/guards/role-routing';

/**
 * Where the side bar can take you: the New Dashboard page (admin roles only),
 * or one of the workspace shell's two screens.
 */
export type SideNavScreen = 'new-dashboard' | 'automation' | 'dashboard';

/**
 * The left-hand menu: New Dashboard (admin roles only), Ticket Automation,
 * and Logout pinned to the bottom. The User Dashboard screen is reached from
 * the ticket screen's own header button, not from here.
 *
 * Opens collapsed — icons only, the label on hover — so the screens keep
 * nearly all of their width; the toggle at the top widens it to show labels.
 *
 * Inside the workspace shell, a switch between its two screens is handed to
 * the shell through (navigate), which swaps them in place without losing their
 * state. Anywhere else — the New Dashboard page — the side bar routes there
 * itself.
 */
@Component({
  selector: 'app-side-nav',
  standalone: false,
  templateUrl: './side-nav.html',
  styleUrl: './side-nav.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SideNav {
  @Input() active: SideNavScreen = 'automation';

  @Output() navigate = new EventEmitter<SideNavScreen>();

  collapsed = true;

  constructor(
    private readonly auth: AuthService,
    private readonly logoutService: LogoutService,
    private readonly router: Router
  ) {}

  /** Admin, Post_Admin and Pre_Admin get the New Dashboard; ticket users do not. */
  get showNewDashboard(): boolean {
    return isAdminRole(this.auth.currentUser?.role);
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
  }

  go(screen: SideNavScreen): void {
    if (screen === this.active) {
      return;
    }

    if (screen === 'new-dashboard') {
      this.router.navigateByUrl('/new-dashboard');
      return;
    }

    if (this.active !== 'new-dashboard' && this.navigate.observed) {
      this.navigate.emit(screen);
      return;
    }

    this.router.navigateByUrl('/email-ticket-system');
  }

  logout(): void {
    this.logoutService.logout();
  }
}
