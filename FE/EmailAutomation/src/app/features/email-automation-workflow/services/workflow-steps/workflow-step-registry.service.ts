import { Injectable } from '@angular/core';

import { AgreementStepService } from './agreement-step.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { CustomerEmailVerificationService } from './customer-email-verification.service';
import { InstrumentMatchService } from './instrument-match.service';
import { RpaTriggerService } from './rpa-trigger.service';
import { TicketAcknowledgementService } from './ticket-acknowledgement.service';
import { UnitMatchService } from './unit-match.service';
import { WorkflowStep, WorkflowStepId } from './workflow-step.model';

/**
 * Single place that knows the pipeline's shape: which service backs which
 * pipeline-node-card, and in what order the cards run.
 *
 * The visualizer can walk `getSteps()` to render the cards and call
 * `getStep(id)` when a card is clicked, instead of holding the node list inline.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowStepRegistryService {
  /** Pipeline order, top to bottom, as drawn in the Workflow Pipeline panel. */
  private readonly steps: WorkflowStep[];

  constructor(
    ticketAcknowledgement: TicketAcknowledgementService,
    customerEmailVerification: CustomerEmailVerificationService,
    unitMatch: UnitMatchService,
    agreement: AgreementStepService,
    instrumentMatch: InstrumentMatchService,
    bankReconciliation: BankReconciliationService,
    rpaTrigger: RpaTriggerService
  ) {
    this.steps = [
      ticketAcknowledgement,
      customerEmailVerification,
      unitMatch,
      // The Agreement Workflow's thirteen stages run after Unit Match, for the
      // threads that have them. They sit here so getNextStep() reads the order
      // an agreement thread actually takes; a thread without them never asks
      // for one. Which threads have them is decided by the visualizer's own
      // route filter, not here — this list is the pipeline's full shape.
      ...agreement.asWorkflowSteps(),
      instrumentMatch,
      bankReconciliation,
      rpaTrigger,
    ];
  }

  /** All steps in pipeline order. */
  getSteps(): WorkflowStep[] {
    return this.steps;
  }

  /** The step backing one card, or undefined for an unknown id. */
  getStep(id: WorkflowStepId): WorkflowStep | undefined {
    return this.steps.find((step) => step.id === id);
  }

  /** The step that follows `id` in pipeline order, or undefined at the end. */
  getNextStep(id: WorkflowStepId): WorkflowStep | undefined {
    const index = this.steps.findIndex((step) => step.id === id);
    return index === -1 ? undefined : this.steps[index + 1];
  }
}
