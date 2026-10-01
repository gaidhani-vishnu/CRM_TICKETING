import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';

import { DashboardTicket } from '../../models/user-dashboard.model';

/** One key/value tile in the drawer's overview grid. */
interface DrawerField {
  label: string;
  value: string;
}

/** One line of the drawer's pipeline history. */
interface DrawerStep {
  title: string;
  note: string;
  /** 'done' | 'current' | 'waiting' — drives the dot and the dimming. */
  state: string;
}

/**
 * One ticket in full, opened from the drill-down.
 *
 * Follows the popup convention the workflow screen already uses: always
 * mounted, shows while its `ticket` input is set, and the parent closes it by
 * setting that input back to null.
 *
 * Both grids are built in ngOnChanges rather than read through getters, so
 * *ngFor is handed the same arrays on every change-detection pass.
 */
@Component({
  selector: 'app-ticket-drawer',
  standalone: false,
  templateUrl: './ticket-drawer.html',
  styleUrl: './ticket-drawer.scss',
})
export class TicketDrawer implements OnChanges {
  /** The ticket to show. The drawer is visible while this is set. */
  @Input() ticket: DashboardTicket | null = null;

  @Output() closed = new EventEmitter<void>();

  fields: DrawerField[] = [];
  steps: DrawerStep[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['ticket']) {
      return;
    }

    this.fields = this.buildFields();
    this.steps = this.buildSteps();
  }

  onClose(): void {
    this.closed.emit();
  }

  /** Clicking the dimmed backdrop closes; clicking inside the panel does not. */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.onClose();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.ticket) {
      this.onClose();
    }
  }

  private buildFields(): DrawerField[] {
    const ticket = this.ticket;

    if (!ticket) {
      return [];
    }

    return [
      { label: 'Intent', value: ticket.intent },
      { label: 'Sub-Intent', value: ticket.subIntent },
      { label: 'Category', value: ticket.category },
      { label: 'Current Step', value: ticket.step },
      { label: 'Ticket Status', value: ticket.ticketStatus },
      { label: 'Received On', value: ticket.receivedOn || '—' },
      { label: 'Raised On', value: ticket.createdDate || '—' },
      { label: 'SLA Due', value: ticket.slaDue || '—' },
      { label: 'SLA', value: ticket.slaStatus },
      { label: 'Email', value: ticket.customerEmail || '—' },
      { label: 'Assigned To', value: ticket.assignedTo },
      { label: 'Project', value: ticket.project || '—' },
      { label: 'Unit', value: ticket.unit || '—' },
    ];
  }

  /**
   * The pipeline, with this thread's position marked.
   *
   * Steps before the current one are shown as completed because that is what
   * reaching this stage means — [Workflow Status] only ever advances once the
   * step before it has settled.
   */
  private buildSteps(): DrawerStep[] {
    const ticket = this.ticket;

    if (!ticket) {
      return [];
    }

    // The thread's own route — an agreement thread's thirteen stages, a
    // system thread's two steps — rather than one list for every ticket.
    const current = ticket.route.indexOf(ticket.step);

    return ticket.route.map((title, index) => {
      if (index < current) {
        return { title, note: 'Completed', state: 'done' };
      }

      if (index === current) {
        return {
          title,
          note: ticket.actionStatus !== '' ? ticket.actionStatus : 'In progress',
          state: 'current',
        };
      }

      return { title, note: 'Waiting for the previous step', state: 'waiting' };
    });
  }
}
