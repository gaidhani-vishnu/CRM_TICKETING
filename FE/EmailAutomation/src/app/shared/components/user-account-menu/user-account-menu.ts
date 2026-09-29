import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Input,
} from '@angular/core';

import { AuthService } from '../../../core/services/auth.service';
import { LogoutService } from '../../../core/services/logout.service';
import { LoginUser } from '../../../core/models/auth.model';

/**
 * The signed-in user's own menu — as it appears in every header, next to
 * (but distinct from) <app-user-filter>'s "whose threads" picker. Mirrors
 * that component's shape exactly (OnPush, ChangeDetectorRef, the two
 * HostListeners for outside-click/Escape) since it is the one existing
 * "dropdown living in a header" pattern in this app.
 *
 * Self-contained: owns the My Profile modal's open/closed state itself, so
 * every header that drops in <app-user-account-menu> gets both My Profile
 * and Logout with no extra wiring from the page around it.
 */
@Component({
  selector: 'app-user-account-menu',
  standalone: false,
  templateUrl: './user-account-menu.html',
  styleUrl: './user-account-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserAccountMenu {
  /**
   * Avatar + chevron only, name/role label hidden — for the two CRM
   * screens' headers, which already carry a status badge, a screen-switch
   * button and <app-user-filter> in the same row and have no width left
   * for a 4th labelled control. new-dashboard's header has room to spare,
   * so it leaves this at the default (full label shown).
   */
  @Input() compact = false;

  isOpen = false;
  showProfileModal = false;

  constructor(
    private readonly auth: AuthService,
    private readonly logoutService: LogoutService,
    private readonly cdr: ChangeDetectorRef,
    private readonly elementRef: ElementRef<HTMLElement>
  ) {}

  get user(): LoginUser | null {
    return this.auth.currentUser;
  }

  /** Two-letter initials off the employee name, e.g. "Princ Jain" -> "PJ". */
  get initials(): string {
    const name = this.user?.employeeName?.trim();

    if (!name) {
      return '?';
    }

    const parts = name.split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';

    return (first + second).toUpperCase();
  }

  /** Role name as a readable label, e.g. "Post_Admin" -> "Post Admin". */
  get roleLabel(): string {
    return (this.user?.role ?? '').replace(/_/g, ' ');
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    this.cdr.markForCheck();
  }

  openProfile(): void {
    this.isOpen = false;
    this.showProfileModal = true;
    this.cdr.markForCheck();
  }

  closeProfile(): void {
    this.showProfileModal = false;
    this.cdr.markForCheck();
  }

  logout(): void {
    this.isOpen = false;
    this.logoutService.logout();
  }

  /** Shuts the menu on a click outside it — same rule as <app-user-filter>. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.isOpen) {
      return;
    }

    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.isOpen = false;
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) {
      this.isOpen = false;
      this.cdr.markForCheck();
    }
  }
}
