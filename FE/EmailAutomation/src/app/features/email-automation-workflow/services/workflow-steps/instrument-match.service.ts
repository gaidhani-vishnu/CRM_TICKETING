import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import {
  InstrumentMatchPayment,
  InstrumentMatchResponse,
} from '../../models/instrument-match.model';
import { EmailAutomationService } from '../email-automation.service';
import {
  HumanGateWorkflowStep,
  WorkflowStepContext,
  WorkflowStepDecision,
  WorkflowStepResult,
  notImplemented,
} from './workflow-step.model';

/**
 * Node 4 — Instrument Match (HUMAN GATE).
 *
 * Run after Unit Match passes, and only when the reviewer clicks through. It asks
 * two things of every payment on the thread, and writes two columns:
 *
 *   • Is it already receipted? The instrument number and amount are looked up in
 *     SALES_RECEIPT, narrowed by the Pride account once the row carries one. A
 *     hit is a duplicate entry ("Dublicate Match" = Match) unless the receipt is
 *     Cancelled; a miss is a new entry. A row with no Pride account takes the
 *     matched receipt's BANKHEADER, which is what fills the Pride Account No
 *     dropdown on the card.
 *
 *   • Is the row complete? Instrument number, amount, payment mode, customer
 *     bank, a full (unmasked) customer account number and a Pride account all
 *     have to be there — that is what "Instrument Match" now records.
 *
 * No bank statement is opened here; the workbooks belong to Bank Reconciliation.
 * The step is DONE only when every payment on the thread is complete.
 */
@Injectable({ providedIn: 'root' })
export class InstrumentMatchService implements HumanGateWorkflowStep {
  readonly id = 'node-4' as const;
  readonly title = 'Instrument Match';
  readonly subtitle = 'Confirm instrument; Duplicate Check';
  readonly tag = 'HUMAN GATE' as const;

  constructor(private readonly api: EmailAutomationService) {}

  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    const threadId = context.row?.threadId;

    if (!context.date || !threadId) {
      return of(this.blocked('No thread selected.', {}));
    }

    return this.api.matchInstrument(context.date, threadId).pipe(
      map((response) => this.toResult(response)),
      catchError((error) => of(this.blocked(this.readErrorMessage(error), {})))
    );
  }

  /** TODO: apply the reviewer's instrument correction, or raise a customer query. */
  submitDecision(
    context: WorkflowStepContext,
    decision: WorkflowStepDecision
  ): Observable<WorkflowStepResult> {
    return notImplemented('InstrumentMatchService', 'submitDecision');
  }

  private toResult(response: InstrumentMatchResponse): WorkflowStepResult {
    const incomplete = (response.payments || []).filter((p) => !p.matched);

    const meta: { [key: string]: string } = {
      'Master Database': 'SALES_RECEIPT',
      'Payments Checked': String(response.totalCount),
      'Complete': `${response.matchedCount} of ${response.totalCount}`,
      'Already Receipted': `${response.duplicateCount} of ${response.totalCount}`,
      'Workflow Status': response.workflowStatus || '—',
      'Status': response.allMatched ? 'DONE' : 'WAITING',
    };

    if (response.accountsFilledCount > 0) {
      meta['Pride Accounts Filled'] = String(response.accountsFilledCount);
    }

    if (response.allMatched) {
      meta['Next Step'] = response.nextStep || 'Bank Reconciliation';

      // Every payment already receipted: nothing to reconcile, no receipt to
      // raise and no receipt number to confirm, so the thread ends at the reply.
      if (response.allDuplicates) {
        meta['Money Steps'] = 'Skipped — every payment is already on the books';
      }
    } else {
      // Name the payments still missing something — that is what a reviewer fixes.
      meta['Incomplete'] = incomplete
        .slice(0, 3)
        .map((p) => `#${p.paymentNo || '?'} ${p.instrumentNumber || '(no instrument no)'}`)
        .join(', ');

      const missing = this.distinctMissingFields(incomplete);
      if (missing) {
        meta['Missing'] = missing;
      }
    }

    return {
      stepId: this.id,
      status: response.allMatched ? 'DONE' : 'WAITING',
      detail: response.message,
      blockingReason: response.allMatched ? undefined : response.message,
      // The latest stamp across the thread's payment rows — see
      // WorkflowStepResult. Carried even on a WAITING run: some payments may
      // have matched, and the card prints the last one that did.
      matchDate: response.matchDate,
      meta,
      skipsNextStep: response.allMatched && response.allDuplicates,
    };
  }

  /** Every field the incomplete payments are short of, named once each. */
  private distinctMissingFields(payments: InstrumentMatchPayment[]): string {
    const fields: string[] = [];

    for (const payment of payments) {
      for (const field of payment.missingFields || []) {
        if (fields.indexOf(field) === -1) {
          fields.push(field);
        }
      }
    }

    return fields.join(', ');
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
    return error?.error?.message || error?.message || 'Instrument match failed.';
  }
}
