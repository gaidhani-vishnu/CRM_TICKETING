import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message: string;
}

/**
 * App-wide notifications, shown by <app-toast-host> in the root template so a
 * message lands whichever screen the user is on.
 *
 * Added for the Customer Payment Portal hand-off: its result can arrive while
 * the user is on another screen, which a toast owned by one screen (like the
 * Email Automation screen's own action notice) would never show.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private static readonly DURATION_MS = 7000;

  private readonly toasts = new BehaviorSubject<Toast[]>([]);
  private nextId = 1;

  readonly items$: Observable<Toast[]> = this.toasts.asObservable();

  success(message: string, title = 'Done'): void {
    this.show('success', message, title);
  }

  info(message: string, title = 'Notice'): void {
    this.show('info', message, title);
  }

  warning(message: string, title = 'Attention'): void {
    this.show('warning', message, title);
  }

  error(message: string, title = 'Something went wrong'): void {
    this.show('error', message, title);
  }

  dismiss(id: number): void {
    this.toasts.next(this.toasts.value.filter((toast) => toast.id !== id));
  }

  private show(kind: ToastKind, message: string, title: string): void {
    const toast: Toast = { id: this.nextId++, kind, title, message };

    this.toasts.next([...this.toasts.value, toast]);

    setTimeout(() => this.dismiss(toast.id), ToastService.DURATION_MS);
  }
}
