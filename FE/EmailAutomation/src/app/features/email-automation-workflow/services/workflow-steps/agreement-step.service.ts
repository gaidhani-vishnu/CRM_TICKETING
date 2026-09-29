import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { AgreementStep, AGREEMENT_STEPS } from '../../models/agreement-step.model';
import { AgreementStepResponse } from '../../models/agreement-step-response.model';
import { EmailAutomationService } from '../email-automation.service';
import {
  HumanGateWorkflowStep,
  WorkflowStepContext,
  WorkflowStepResult,
} from './workflow-step.model';

/**
 * Nodes a1-a13 — the Agreement Workflow (HUMAN GATE).
 *
 * One service for all thirteen stages rather than thirteen near-identical
 * classes: the stages differ only in which column they record, and none of them
 * has a master-data lookup of its own. They are back-office stages a reviewer
 * works through — draft the agreement, pay the challan, attend the appointment —
 * so verifying one is that reviewer confirming it happened, which the backend
 * records as a 'Match' with a timestamp and then opens the stage after it.
 *
 * NOTE: as with nodes 2 and 3, verify() is not side-effect free. Recording the
 * confirmation IS the step, and it is the backend that does it.
 *
 * Strictly in order. The backend refuses a stage whose predecessor has not
 * passed (409), so the sequence holds even if something on this side offered a
 * button it should not have.
 */
@Injectable({ providedIn: 'root' })
export class AgreementStepService {
  constructor(private readonly api: EmailAutomationService) {}

  /**
   * Verifies one stage for the selected thread.
   *
   * The stage is passed in rather than fixed on the service, which is the whole
   * reason one service serves thirteen nodes.
   */
  verify(context: WorkflowStepContext, step: AgreementStep): Observable<WorkflowStepResult> {
    const threadId = context.row?.threadId;

    if (!context.date || !threadId) {
      return of(this.blocked(step, 'No thread selected.'));
    }

    return this.api.verifyAgreementStep(context.date, threadId, step.stepKey).pipe(
      map((response) => this.toResult(step, response)),
      catchError((error) => of(this.blocked(step, this.readErrorMessage(step, error))))
    );
  }

  /**
   * The thirteen stages as WorkflowStep records, so the registry can hold the
   * pipeline's full shape.
   *
   * Thin adapters over verify() above: a WorkflowStep carries one id and one
   * title, which is exactly what a stage adds to this service.
   */
  asWorkflowSteps(): HumanGateWorkflowStep[] {
    return AGREEMENT_STEPS.map((step) => this.asWorkflowStep(step));
  }

  private asWorkflowStep(step: AgreementStep): HumanGateWorkflowStep {
    const service = this;

    return {
      id: step.nodeId,
      title: step.title,
      subtitle: step.keyActivity,
      tag: 'HUMAN GATE' as const,
      evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
        return service.verify(context, step);
      },
      submitDecision(context: WorkflowStepContext): Observable<WorkflowStepResult> {
        // A decision here is the confirmation itself — there is no correction to
        // apply and no lookup to re-run, so approving IS verifying.
        return service.verify(context, step);
      },
    };
  }

  private toResult(step: AgreementStep, response: AgreementStepResponse): WorkflowStepResult {
    return {
      stepId: step.nodeId,
      status: 'DONE',
      detail: response.message,
      // The instant the backend stamped on the row — see WorkflowStepResult.
      matchDate: response.matchDate,
      meta: {
        'Step': response.stepTitle || step.title,
        'Verified': 'Yes',
        'Workflow Status': response.workflowStatus || '—',
        'Next Step': response.nextStep || '—',
        'Status': 'DONE',
      },
    };
  }

  private blocked(step: AgreementStep, reason: string): WorkflowStepResult {
    return {
      stepId: step.nodeId,
      status: 'WAITING',
      detail: reason,
      blockingReason: reason,
      meta: {
        'Step': step.title,
        'Verified': 'No',
        'Status': 'WAITING',
      },
    };
  }

  private readErrorMessage(step: AgreementStep, error: any): string {
    return error?.error?.message || error?.message || `${step.title} could not be verified.`;
  }
}
