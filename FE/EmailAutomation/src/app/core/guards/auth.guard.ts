import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';

/**
 * Guards the CRM shell (route ''): a live session lets the visitor through,
 * anything else redirects to /login.
 *
 * Functional guard (CanActivateFn) rather than a class — no module wiring
 * beyond listing it in the route's `canActivate`.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.isLoggedIn() ? true : router.createUrlTree(['/login']);
};
