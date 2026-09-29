import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';
import { roleHomePath } from './role-routing';

/**
 * Guards route '' — never renders anything, just sends a visitor on to
 * where they belong: /login when logged out, otherwise their role's page
 * (roleHomePath). Pair this with a componentless route (no `component`),
 * since it always redirects before the router would need one.
 */
export const homeGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return router.createUrlTree([roleHomePath(auth.currentUser?.role)]);
};

/**
 * Guards a role-specific page (/new-dashboard, /email-ticket-system).
 * Reads the allowed roles off the route's own `data.roles`, so the guard
 * stays generic and every route just declares its own list.
 *
 * Chain this after authGuard in `canActivate` — it assumes a logged-in
 * session, but still fails closed (redirects to /login) if that
 * assumption is somehow wrong rather than throwing.
 *
 * A logged-in user whose role isn't on the list is sent to *their own*
 * home page, not to /login and not left on a dead end — manually typing
 * another role's URL must not read as "access denied, nothing further,"
 * it should just land them back where they belong.
 */
export const roleGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const allowedRoles = (route.data['roles'] as string[] | undefined) ?? [];
  const role = auth.currentUser?.role ?? null;

  if (!role) {
    return router.createUrlTree(['/login']);
  }

  return allowedRoles.includes(role) ? true : router.createUrlTree([roleHomePath(role)]);
};
