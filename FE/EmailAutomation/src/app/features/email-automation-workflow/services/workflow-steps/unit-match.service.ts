import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { UnitMatchResponse } from '../../models/unit-match.model';
import { EmailAutomationService } from '../email-automation.service';
import {
  HumanGateWorkflowStep,
  WorkflowStepContext,
  WorkflowStepDecision,
  WorkflowStepResult,
  notImplemented,
} from './workflow-step.model';

/**
 * Node 3 — Unit Match (HUMAN GATE).
 *
 * Run only after Customer Email Verification passes, and only when the reviewer
 * clicks through. Looks for a SALES_BOOKING_DETAILS booking matching the thread's
 * Unit, Customer Sender and Project all at once:
 *   • match    → DONE, and the pipeline moves on to Instrument Match.
 *   • no match → WAITING, and the backend parks the thread by writing
 *     "AI pipline recorde not match" into the Remark column of
 *     main_email_receipts_{date}.csv for this Thread ID.
 *
 * NOTE: as with node 2, evaluate() is not side-effect free — parking an unmatched
 * thread is part of the check itself, and is done by the backend.
 */
@Injectable({ providedIn: 'root' })
export class UnitMatchService implements HumanGateWorkflowStep {
  readonly id = 'node-3' as const;
  readonly title = 'Unit Match';
  readonly subtitle = 'Match unit; edit or ask customer';
  readonly tag = 'HUMAN GATE' as const;

  constructor(private readonly api: EmailAutomationService) {}

  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    const threadId = context.row?.threadId;

    if (!context.date || !threadId) {
      return of(this.blocked('No thread selected.', {}));
    }

    return this.api.matchUnit(context.date, threadId).pipe(
      map((response) => this.toResult(response)),
      catchError((error) =>
        of(
          this.blocked(this.readErrorMessage(error), {
            'Unit': context.row?.unit || '—',
            'Project': context.row?.project || '—',
          })
        )
      )
    );
  }

  /** TODO: apply the reviewer's unit correction, or raise a customer query. */
  submitDecision(
    context: WorkflowStepContext,
    decision: WorkflowStepDecision
  ): Observable<WorkflowStepResult> {
    return notImplemented('UnitMatchService', 'submitDecision');
  }

  private toResult(response: UnitMatchResponse): WorkflowStepResult {
    const booking = response.bookings?.[0];

    if (response.matched && booking) {
      return {
        stepId: this.id,
        status: 'DONE',
        detail: response.message,
        // The instant the backend stamped on the row — see WorkflowStepResult.
        matchDate: response.matchDate,
        // Carried through rather than left in `meta`: the booking's stage is
        // what decides who owns the thread, and meta is a display map whose
        // miss value is the em-dash the card prints.
        bookings: response.bookings,
        meta: {
          'Unit': response.unit || '—',
          'Master UNIT_NO': booking.unitNo || '—',
          'Project': booking.projectName || response.project || '—',
          'Sub Project': booking.subProjectName || '—',
          'Booking No': booking.accountItemNo || '—',
          'Booking Status': booking.bookingStatusName || '—',
          'Bookings Found': String(response.bookings.length),
          'Workflow Status': response.workflowStatus || '—',
          'Next Step': response.nextStep || 'Instrument Match',
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
        'Unit': response.unit || '—',
        'Master UNIT_NO': 'No match',
        'Project': response.project || '—',
        'Sender Email': response.senderEmail || '—',
        'Excel Remark': response.remarkWritten || '—',
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
    return error?.error?.message || error?.message || 'Unit match failed.';
  }
}
