import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import {
  AutomatedWorkflowStep,
  WorkflowStepContext,
  WorkflowStepResult,
  notImplemented,
} from './workflow-step.model';

/**
 * Node 1 — Ticket Acknowledgement (AUTO).
 *
 * Sends the customer an immediate acknowledgement carrying the ticket number and
 * the SLA commitment, then marks the step DONE.
 *
 * Inspector meta to produce: Ticket No, Customer Email, SLA Commitment, Status.
 *
 * Scaffolding only — no logic implemented.
 */
@Injectable({ providedIn: 'root' })
export class TicketAcknowledgementService implements AutomatedWorkflowStep {
  readonly id = 'node-1' as const;
  readonly title = 'Ticket Acknowledgement';
  readonly subtitle = 'Notify customer: ticket no + SLA';
  readonly tag = 'AUTO' as const;

  /** TODO: report whether an acknowledgement has already gone out for this thread. */
  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    return notImplemented('TicketAcknowledgementService', 'evaluate');
  }

  /** TODO: allocate the ticket number and dispatch the acknowledgement mail. */
  execute(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    return notImplemented('TicketAcknowledgementService', 'execute');
  }
}
