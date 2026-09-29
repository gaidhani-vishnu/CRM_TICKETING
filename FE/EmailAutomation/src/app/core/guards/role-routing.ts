/**
 * The one place a role's landing page is spelled out. Reused by homeGuard
 * (route ''), roleGuard (redirecting a wrong-role visitor to their own
 * page rather than a dead end), and Login (going straight there after a
 * successful sign-in instead of bouncing through '').
 */

/** Roles that get the New Dashboard: they land on it and see it in the side bar. */
export const ADMIN_ROLES = ['Admin', 'Post_Admin', 'Pre_Admin'];

/** Roles that work tickets only: the ticketing screen, and no New Dashboard. */
export const TICKET_USER_ROLES = ['Pre_User', 'Pos_User'];

export const ROLE_HOME: Record<string, string> = {
  Admin: '/new-dashboard',
  Post_Admin: '/new-dashboard',
  Pre_Admin: '/new-dashboard',
  Pos_User: '/email-ticket-system',
  Pre_User: '/email-ticket-system',
};

/** The route a role lands on. Falls back to '/login' for an unknown/missing role. */
export function roleHomePath(role: string | null | undefined): string {
  return (role && ROLE_HOME[role]) || '/login';
}

/** Whether a role may open the New Dashboard. */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.indexOf(role) !== -1;
}
