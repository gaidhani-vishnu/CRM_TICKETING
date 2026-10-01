import { ChangeDetectionStrategy, Component } from '@angular/core';

import { Toast, ToastService } from '../../../core/services/toast.service';

/** Renders ToastService's messages, top right, above every screen. */
@Component({
  selector: 'app-toast-host',
  standalone: false,
  templateUrl: './toast-host.html',
  styleUrl: './toast-host.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHost {
  constructor(readonly toast: ToastService) {}

  trackById(index: number, item: Toast): number {
    return item.id;
  }
}
