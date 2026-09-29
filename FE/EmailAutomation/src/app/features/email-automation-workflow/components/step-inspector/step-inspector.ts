import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { WorkflowNode } from '../../models/workflow-node.model';

/**
 * Step Inspector — the fixed panel pinned below the Workflow Pipeline that details
 * whichever pipeline-node-card is currently selected.
 *
 * Purely presentational: it renders the node handed to it and emits the action the
 * user clicked. It owns no selection state and triggers no side effects itself, so
 * the parent stays the single place that decides what an action actually does.
 */
@Component({
  selector: 'app-step-inspector',
  standalone: false,
  templateUrl: './step-inspector.html',
  styleUrl: './step-inspector.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StepInspector {
  /** The selected pipeline node. Nothing renders while this is null. */
  @Input() node: WorkflowNode | null = null;

  /** Emits the id of the node's primary action, e.g. 'start-unit-match'. */
  @Output() primaryActionTriggered = new EventEmitter<string>();

  onPrimaryAction(): void {
    if (this.node?.primaryAction) {
      this.primaryActionTriggered.emit(this.node.primaryAction.id);
    }
  }
}
