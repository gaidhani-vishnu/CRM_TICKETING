import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { BankReconciliationResponse } from '../../models/bank-reconciliation.model';
import { EmailAutomationService } from '../email-automation.service';
import {
  AutomatedWorkflowStep,
  WorkflowStepContext,
  WorkflowStepResult,
} from './workflow-step.model';

/**
 * Node 5 — Bank Reconciliation (AUTO).
 *
 * Run after Instrument Match passes, and only when the reviewer clicks through.
 * Each payment is checked against the statement workbook picked by the last 4
 * digits of its account number, this time requiring the row to carry BOTH the
 * instrument number and the same amount:
 *   • reconciled → the statement's amount cell is filled yellow (the Description
 *     cell keeps the green from Instrument Match) and "Bank Reco Match" is set
 *     to "Match" on that payment row.
 *   • the same instrument and amount on more than one row → "Dublicate Match"
 *     is set to "Match", flagging a duplicate entry.
 *
 * The step is DONE only when every payment on the thread reconciled.
 */
@Injectable({ providedIn: 'root' })
export class BankReconciliationService implements AutomatedWorkflowStep {
  readonly id = 'node-5' as const;
  readonly title = 'Bank Reconciliation';
  readonly subtitle = 'Run bank-reco; stop if duplicate';
  readonly tag = 'AUTO' as const;

  constructor(private readonly api: EmailAutomationService) {}

  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    return this.execute(context);
  }

  execute(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    const threadId = context.row?.threadId;

    if (!context.date || !threadId) {
      return of(this.blocked('No thread selected.'));
    }

    return this.api.reconcileBank(context.date, threadId).pipe(
      map((response) => this.toResult(response)),
      catchError((error) => of(this.blocked(this.readErrorMessage(error))))
    );
  }

  private toResult(response: BankReconciliationResponse): WorkflowStepResult {
    const unmatched = (response.payments || []).filter((p) => !p.matched);

    const meta: { [key: string]: string } = {
      'Statement Folder': response.monthFolder || '—',
      'Payments Checked': String(response.totalCount),
      'Reconciled': `${response.matchedCount} of ${response.totalCount}`,
      'Duplicate Entries': String(response.duplicateCount),
      'Workflow Status': response.workflowStatus || '—',
      'Status': response.allMatched ? 'DONE' : 'WAITING',
    };

    if (response.allMatched) {
      meta['Next Step'] = response.nextStep || 'Email Response';
    } else {
      // Name the first few unreconciled instruments — that is what a reviewer chases.
      meta['Unreconciled'] = unmatched
        .slice(0, 3)
        .map((p) => p.instrumentNumber || '(no instrument no)')
        .join(', ');

      const firstReason = unmatched.find((p) => p.reason)?.reason;
      if (firstReason) {
        meta['Reason'] = firstReason;
      }
    }

    return {
      stepId: this.id,
      status: response.allMatched ? 'DONE' : 'WAITING',
      detail: response.message,
      blockingReason: response.allMatched ? undefined : response.message,
      // The latest stamp across the thread's payment rows — see
      // WorkflowStepResult. Carried even on a WAITING run: some payments may
      // have reconciled, and the card prints the last one that did.
      matchDate: response.matchDate,
      meta,
    };
  }

  private blocked(reason: string): WorkflowStepResult {
    return {
      stepId: this.id,
      status: 'WAITING',
      detail: reason,
      blockingReason: reason,
      meta: { 'Status': 'WAITING' },
    };
  }

  private readErrorMessage(error: any): string {
    return error?.error?.message || error?.message || 'Bank reconciliation failed.';
  }
}
