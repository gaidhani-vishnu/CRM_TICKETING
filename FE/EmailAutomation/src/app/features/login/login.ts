import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { roleHomePath } from '../../core/guards/role-routing';

/** How long each hero quote stays up before the carousel advances. */
const QUOTE_INTERVAL_MS = 5000;

/**
 * The one screen a visitor sees before CrmWorkspaceShell: a full-screen
 * split layout — brand hero on the left, the sign-in card on the right —
 * matching the reference design. See login.html/login.scss for the visual
 * detail; this class only holds the form state and the login round-trip.
 *
 * Template-driven (ngModel), like the rest of the app's forms — no
 * ReactiveFormsModule import needed for two fields and a checkbox.
 */
@Component({
  selector: 'app-login',
  standalone: false,
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login implements OnInit, OnDestroy {
  username = '';
  password = '';
  rememberMe = false;
  showPassword = false;
  showForgotNote = false;

  /** Flips true on the first submit attempt, so field errors don't show before that. */
  submitted = false;
  submitting = false;
  errorMessage: string | null = null;

  readonly currentYear = new Date().getFullYear();

  /**
   * Rotated by the hero's quote carousel. Only one quote was specified by
   * the reference design; two more in the same voice are included so the
   * carousel (dots + progress bar) has something to rotate between.
   */
  readonly quotes: string[] = [
    'Building stronger relationships with our customers, every day.',
    'Transparent updates, from booking to possession.',
    'Every thread tracked, every promise kept.',
  ];

  /**
   * Monotonically increasing rather than wrapped, so `tick % 2` always
   * flips on every advance — that parity flip is what remounts the
   * progress-bar fill in the template and restarts its CSS animation.
   */
  tick = 0;

  private quoteTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly router: Router,
    private readonly cdr: ChangeDetectorRef
  ) {
    if (this.auth.isLoggedIn()) {
      this.router.navigateByUrl(roleHomePath(this.auth.currentUser?.role));
    }
  }

  ngOnInit(): void {
    // This app runs zoneless — setInterval's callback lands outside any
    // Angular-scheduled event, so nothing repaints the quote/dots on its own
    // without markForCheck() (same reasoning as EmailDateDropdown.loadDates).
    this.quoteTimer = setInterval(() => {
      this.tick++;
      this.cdr.markForCheck();
    }, QUOTE_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.quoteTimer !== null) {
      clearInterval(this.quoteTimer);
    }
  }

  get activeQuoteIndex(): number {
    return this.tick % this.quotes.length;
  }

  get usernameInvalid(): boolean {
    return this.submitted && !this.username.trim();
  }

  get passwordInvalid(): boolean {
    return this.submitted && !this.password;
  }

  selectQuote(index: number): void {
    this.tick = index;
  }

  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  toggleForgotNote(): void {
    this.showForgotNote = !this.showForgotNote;
  }

  // Every await below crosses an HTTP round-trip, which — like the quote
  // timer — lands outside any Angular-scheduled event in this zoneless app.
  // markForCheck() after each state change is what makes the spinner, the
  // error banner and the re-enabled button actually repaint.
  async submit(): Promise<void> {
    this.submitted = true;
    this.errorMessage = null;

    const username = this.username.trim();

    if (!username || !this.password) {
      this.cdr.markForCheck();
      return;
    }

    this.submitting = true;
    this.cdr.markForCheck();

    try {
      const user = await this.auth.login(username, this.password, this.rememberMe);
      await this.router.navigateByUrl(roleHomePath(user.role));
    } catch (err) {
      this.errorMessage = this.resolveErrorMessage(err);
    } finally {
      this.submitting = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Maps a failed login to the banner text: the server's own message for a
   * 400/401/403/500 (see UserMasterController.Login), or a network-specific
   * fallback when the request never reached it (status 0).
   */
  private resolveErrorMessage(err: unknown): string {
    const httpError = err as { status?: number; error?: { message?: string } };

    if (httpError?.status === 0) {
      return 'Unable to reach the server. Please check your connection and try again.';
    }

    const serverMessage = httpError?.error?.message;

    return typeof serverMessage === 'string' && serverMessage.trim()
      ? serverMessage
      : 'Unable to sign in right now. Please try again.';
  }
}
