import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';

import { LoginUser } from '../../../core/models/auth.model';

/**
 * Read-only "My Profile" view of the logged-in session — no form, nothing
 * to save. Shows only what the login response already carries
 * (LoginUser); no extra API call or DB column was added to back this.
 *
 * Visual language borrowed from <app-alert-popup> (the app's one existing
 * modal): a full-cover scrim behind a rounded white dialog. `position:
 * fixed` rather than that popup's `absolute`, since this menu — and so this
 * modal — can be opened from any page's header, not just one container
 * that is guaranteed full-viewport-positioned.
 *
 * Moves its own host to `document.body` on init (and back out on destroy).
 * Every header in this app sets `backdrop-filter` on `.top-app-header` for
 * its glass look, and a `backdrop-filter` ancestor creates a new containing
 * block for `position: fixed` descendants — without this move, the modal
 * would render pinned to that header's small box instead of the viewport,
 * with the dialog off-screen. No @angular/cdk dependency needed for one modal.
 */
@Component({
  selector: 'app-profile-modal',
  standalone: false,
  templateUrl: './profile-modal.html',
  styleUrl: './profile-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileModal implements OnInit, OnDestroy {
  @Input() user: LoginUser | null = null;
  @Output() closed = new EventEmitter<void>();

  constructor(private readonly elementRef: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    document.body.appendChild(this.elementRef.nativeElement);
  }

  ngOnDestroy(): void {
    this.elementRef.nativeElement.remove();
  }

  /** Role name as a readable label, e.g. "Post_Admin" -> "Post Admin". */
  get roleLabel(): string {
    return (this.user?.role ?? '').replace(/_/g, ' ');
  }

  onClose(): void {
    this.closed.emit();
  }
}
