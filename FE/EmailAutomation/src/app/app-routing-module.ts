import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { CrmWorkspaceShell } from './features/crm-workspace-shell/crm-workspace-shell';
import { Login } from './features/login/login';
import { NewDashboard } from './features/new-dashboard/new-dashboard';
import { authGuard } from './core/guards/auth.guard';
import { homeGuard, roleGuard } from './core/guards/role.guard';
import { ADMIN_ROLES, TICKET_USER_ROLES } from './core/guards/role-routing';

// The shell renders the Email Automation screen first and switches to the
// User Dashboard in place, so neither screen's state is lost to a
// navigation when the other is glanced at — that in-page switch is why
// there is still only one real screen behind /email-ticket-system.
//
// '' never renders anything itself — homeGuard always redirects, to
// /login when logged out or to the visitor's own role page otherwise —
// so a bookmark or a bare app URL still lands somewhere sensible.
const routes: Routes = [
  { path: 'login', component: Login },
  {
    path: 'new-dashboard',
    component: NewDashboard,
    canActivate: [authGuard, roleGuard],
    data: { roles: ADMIN_ROLES },
  },
  {
    // Every role: the admins reach it from the side bar, the ticket users
    // land on it and have nothing else.
    path: 'email-ticket-system',
    component: CrmWorkspaceShell,
    canActivate: [authGuard, roleGuard],
    data: { roles: [...ADMIN_ROLES, ...TICKET_USER_ROLES] },
  },
  { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
  { path: '**', redirectTo: '' },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
