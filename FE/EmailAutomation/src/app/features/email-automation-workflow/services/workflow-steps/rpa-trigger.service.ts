import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import {
  AutomatedWorkflowStep,
  WorkflowStepContext,
  WorkflowStepResult,
  notImplemented,
} from './workflow-step.model';

/**
 * Node 10 — RPA Trigger (AUTO, parallel).
 *
 * Hands the thread to the RPA bot to punch the receipt into the ERP ledger and read
 * back the confirmed receipt number. Runs in parallel with the draft step, so it must
 * not assume the draft has been finalised.
 *
 * Inspector meta to produce: RPA Bot Status, Ledger Integration, Status.
 *
 * Scaffolding only — no logic implemented.
 */
@Injectable({ providedIn: 'root' })
export class RpaTriggerService implements AutomatedWorkflowStep {
  readonly id = 'node-10' as const;
  readonly title = 'In4 Receipt';
  readonly subtitle = 'Confirm receipt number (parallel)';
  readonly tag = 'AUTO' as const;

  /** TODO: report the bot's queue state and any receipt number already returned. */
  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    return notImplemented('RpaTriggerService', 'evaluate');
  }

  /** TODO: queue the RPA job and poll until the ERP receipt number comes back. */
  execute(context: WorkflowStepContext): Observable<WorkflowStepResult> {
    return notImplemented('RpaTriggerService', 'execute');
  }
}
