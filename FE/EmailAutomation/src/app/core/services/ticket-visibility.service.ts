import { Injectable } from '@angular/core';

import { AuthService } from './auth.service';
import { TICKET_USER_ROLES } from '../guards/role-routing';
import { ConfigService } from './config.service';
import { UserDirectoryService } from './user-directory.service';

/**
 * The admins that, like the ticket users, see only the threads assigned to
 * them — none assigned reads as zero tickets, not a blank screen.
 */
const ASSIGNED_ONLY_ADMIN_ROLES = ['Admin', 'Pre_Admin'];

/**
 * The roles that see only the threads assigned to them. Every other role —
 * Post_Admin — keeps seeing everything, as before.
 */
const OWN_TICKETS_ONLY_ROLES = [...TICKET_USER_ROLES, ...ASSIGNED_ONLY_ADMIN_ROLES];

/**
 * Whether the signed-in user may see a thread, from its [Assigned To].
 *
 *   Blank / whitespace / CRM head  → Post_Admin only (unassigned work)
 *   Assigned to a Pre_User         → that Pre_User (and Post_Admin)
 *   Assigned to a Pos_User         → that Pos_User (and Post_Admin)
 *   Assigned to an Admin/Pre_Admin → that user (and Post_Admin)
 *
 * Applied where each screen loads its rows — the receipts table's
 * listedRows() and the dashboard's join() — so every list, count and picker
 * built from those rows already agrees.
 */
@Injectable({ providedIn: 'root' })
export class TicketVisibilityService {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly directory: UserDirectoryService
  ) {}

  /** Whether the signed-in user is an Admin / Pre_Admin scoped to their own threads. */
  isAssignedOnlyAdmin(): boolean {
    const user = this.auth.currentUser;

    return !!user && ASSIGNED_ONLY_ADMIN_ROLES.indexOf(user.role) !== -1;
  }

  canSee(assignedTo: string | null | undefined): boolean {
    const user = this.auth.currentUser;

    if (!user || OWN_TICKETS_ONLY_ROLES.indexOf(user.role) === -1) {
      return true;
    }

    const owner = (assignedTo || '').trim().toLowerCase();
    const head = this.config.fallbackUser;

    // Unassigned: blank, or filed under the CRM head the same way ownerOf()
    // does — by its emailId, which [Assigned To] stores, or its older name.
    if (
      owner === '' ||
      owner === (head.emailId || '').trim().toLowerCase() ||
      owner === (head.name || '').trim().toLowerCase()
    ) {
      return false;
    }

    return this.directory.identityKeys(user).has(owner);
  }
}
