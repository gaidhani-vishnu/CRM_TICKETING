import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { CustomerEmailVerificationResponse } from '../../models/customer-email-verification.model';
import { EmailAutomationService } from '../email-automation.service';
import {
  HumanGateWorkflowStep,
  WorkflowStepContext,
  WorkflowStepDecision,
  WorkflowStepResult,
  notImplemented,
} from './workflow-step.model';

/**
 * Node 2 — Customer Email Verification (HUMAN GATE).
 *
 * Takes the thread's Customer Sender and looks it up in SALES_BOOKING_DETAILS
 * against EMAIL1, EMAIL2 and EMAIL3:
 *   • a hit on any one of the three → DONE, and the pipeline moves on to Unit Match.
 *   • no hit → WAITING, and the backend parks the thread by writing
 *     "Ticketed Pending CRM head" into the Status column of
 *     main_email_receipts_{date}.csv for this Thread ID.
 *
 * NOTE: unlike the other steps, evaluate() is not side-effect free — parking an
 * unverified thread is part of the check itself, and is done by the backend.
 */
@Injectable({ providedIn: 'root' })
export class CustomerEmailVerificationService implements HumanGateWorkflowStep {
  readonly id = 'node-2' as const;
  readonly title = 'Customer Email Verification';
  readonly subtitle = 'Match customer email vs master';
  readonly tag = 'HUMAN GATE' as const;

  /**
   * What the sender is verified against. Shown in the Step Inspector.
   *
   * The procedure searches the booking master first and falls back to the
   * co-applicant table when the sender is on no booking there, so a
   * co-applicant verifies on their own address. It does not report which of
   * the two answered, so neither does this step.
   */
  private readonly masterDatabase = 'PRIDE_CUSTOMER_PORTAL_BOOKED_UNITS';

  constructor(private readonly api: EmailAutomationService) {}

  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    const threadId = context.row?.threadId;

    if (!context.date || !threadId) {
      return of(this.blocked('No thread selected.', {}));
    }

    return this.api.verifyCustomerEmail(context.date, threadId).pipe(
      map((response) => this.toResult(response)),
      catchError((error) =>
        of(
          this.blocked(this.readErrorMessage(error), {
            'Sender Email': context.row?.customerSender || '—',
            'Master Database': this.masterDatabase,
          })
        )
      )
    );
  }

  /** TODO: persist the reviewer's confirmed/corrected customer email and release the gate. */
  submitDecision(
    context: WorkflowStepContext,
    decision: WorkflowStepDecision
  ): Observable<WorkflowStepResult> {
    return notImplemented('CustomerEmailVerificationService', 'submitDecision');
  }

  private toResult(response: CustomerEmailVerificationResponse): WorkflowStepResult {
    const booking = response.bookings?.[0];

    if (response.matched && booking) {
      const candidates = response.candidates?.length ? response.candidates : response.bookings;

      return {
        stepId: this.id,
        status: 'DONE',
        detail: response.message,
        // The instant the backend stamped on the row, so the card can print it
        // without the row being fetched again.
        matchDate: response.matchDate,
        // Unit Match runs against one of these: the only one, or the one the
        // reviewer picks in the Project & Unit card.
        bookings: candidates,
        meta: {
          'Sender Email': response.senderEmail || '—',
          'Master Database': this.masterDatabase,
          'Bookings Found': String(response.bookings.length),
          'Bookings To Choose From': String(candidates.length),
          'Customer': booking.customerName || '—',
          'Unit No': booking.unitNo || '—',
          'Project': [booking.projectName, booking.subProjectName].filter(Boolean).join(' / ') || '—',
          'Verification Gate': 'Verified against master',
          'Workflow Status': response.workflowStatus || '—',
          'Next Step': response.nextStep || 'Unit Match',
          'Status': 'DONE',
        },
      };
    }

    return {
      stepId: this.id,
      status: 'WAITING',
      detail: response.message,
      blockingReason: response.message,
      meta: {
        'Sender Email': response.senderEmail || '—',
        'Master Database': this.masterDatabase,
        'Verification Gate': 'Human Review Active',
        'Excel Status': response.statusWritten || '—',
        'Workflow Status': response.workflowStatus || '—',
        'Status': 'WAITING',
      },
    };
  }

  private blocked(reason: string, meta: { [key: string]: string }): WorkflowStepResult {
    return {
      stepId: this.id,
      status: 'WAITING',
      detail: reason,
      blockingReason: reason,
      meta: { ...meta, 'Status': 'WAITING' },
    };
  }

  private readErrorMessage(error: any): string {
    return error?.error?.message || error?.message || 'Customer email verification failed.';
  }
}
