import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from './auth.service';
import { AssigneeFilterService } from './assignee-filter.service';
import { UserDashboardService } from '../../features/user-dashboard/services/user-dashboard.service';
import { ALL_USERS } from '../../shared/models/user-filter.model';

/**
 * Signs the user out, from wherever the button is — the header's account
 * menu or the workspace side bar. One place, so both clear the same state.
 */
@Injectable({ providedIn: 'root' })
export class LogoutService {
  constructor(
    private readonly auth: AuthService,
    private readonly dashboard: UserDashboardService,
    private readonly assigneeFilter: AssigneeFilterService,
    private readonly router: Router
  ) {}

  logout(): void {
    this.auth.logout();
    // The loaded tickets were scoped to this user — drop them and the owner
    // choice, so whoever signs in next on this tab starts clean.
    this.dashboard.reset();
    this.assigneeFilter.select(ALL_USERS);
    this.router.navigateByUrl('/login');
  }
}
