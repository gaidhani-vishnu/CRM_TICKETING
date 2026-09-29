import { Component } from '@angular/core';

/**
 * Landing page for Admin / Post_Admin / Pre_Admin (see core/guards/role-routing.ts).
 * Not implemented yet — a "Coming Soon" placeholder, styled like the rest
 * of the CRM app (same glass header/canvas as email-automation-workflow
 * and user-dashboard) rather than a bare unstyled page.
 */
@Component({
  selector: 'app-new-dashboard',
  standalone: false,
  templateUrl: './new-dashboard.html',
  styleUrl: './new-dashboard.scss',
})
export class NewDashboard {}
