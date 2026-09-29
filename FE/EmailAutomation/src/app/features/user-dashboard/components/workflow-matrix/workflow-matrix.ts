import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import {
  DrillRequest,
  IntentGroup,
  MatrixCell,
  MatrixRow,
  WORKFLOW_STAGES,
  WorkflowStage,
} from '../../models/user-dashboard.model';

/**
 * Where the open queue is stuck: every intent's sub-intents against every
 * pipeline stage, with the overdue count riding beside each figure.
 *
 * Every number is a button. The table answers "how many", and clicking answers
 * "which ones" by opening the drill-down underneath it — the two never
 * disagree because both are counted from the same list.
 */
@Component({
  selector: 'app-workflow-matrix',
  standalone: false,
  templateUrl: './workflow-matrix.html',
  styleUrl: './workflow-matrix.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowMatrix {
  @Input() groups: IntentGroup[] = [];

  /** What the drill-down is currently showing, so this table can mark it. */
  @Input() activeDrill: DrillRequest | null = null;

  @Output() drillRequested = new EventEmitter<DrillRequest>();

  /** The stage columns, in pipeline order. */
  readonly stages: WorkflowStage[] = WORKFLOW_STAGES;

  /** Set of expanded intent names. Initially empty so intents start collapsed. */
  expandedIntents = new Set<string>();

  /** Check if a specific intent group is currently expanded. */
  isExpanded(group: IntentGroup): boolean {
    return this.expandedIntents.has(group.intent);
  }

  /** Toggle the expanded / collapsed state of an intent group. */
  toggleIntent(group: IntentGroup, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    if (this.expandedIntents.has(group.intent)) {
      this.expandedIntents.delete(group.intent);
    } else {
      this.expandedIntents.add(group.intent);
    }
  }

  /** Expand all intent groups. */
  expandAll(): void {
    for (const group of this.groups) {
      this.expandedIntents.add(group.intent);
    }
  }

  /** Collapse all intent groups. */
  collapseAll(): void {
    this.expandedIntents.clear();
  }

  /** Returns true if all intent groups are currently expanded. */
  allExpanded(): boolean {
    return this.groups.length > 0 && this.expandedIntents.size === this.groups.length;
  }

  /** Toggle between expand all and collapse all. */
  toggleAll(): void {
    if (this.allExpanded()) {
      this.collapseAll();
    } else {
      this.expandAll();
    }
  }

  /** A whole intent — every sub-intent, every stage. */
  onIntentClick(group: IntentGroup): void {
    this.drillRequested.emit({ intent: group.intent, subIntent: 'ALL', stage: 'ALL' });
  }

  /** Drill-down click directly from the intent row hint button. */
  onIntentDrillClick(group: IntentGroup, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.onIntentClick(group);
  }

  /** Click on a parent Intent-level stage cell or total cell. */
  onGroupCellClick(group: IntentGroup, cell: MatrixCell, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    if (cell.total === 0) {
      return;
    }

    this.drillRequested.emit({
      intent: group.intent,
      subIntent: 'ALL',
      stage: cell.stage,
    });
  }

  /** One cell: this sub-intent at this stage, or its whole row for the Total column. */
  onCellClick(row: MatrixRow, cell: MatrixCell): void {
    if (cell.total === 0) {
      return;
    }

    this.drillRequested.emit({
      intent: row.intent,
      subIntent: row.subIntent,
      stage: cell.stage,
    });
  }

  /** True for the one cell the drill-down below is currently showing. */
  isActive(row: MatrixRow, cell: MatrixCell): boolean {
    const drill = this.activeDrill;

    return (
      drill !== null &&
      drill.intent === row.intent &&
      drill.subIntent === row.subIntent &&
      drill.stage === cell.stage
    );
  }

  /** True for an Intent-level stage cell the drill-down below is currently showing. */
  isGroupCellActive(group: IntentGroup, cell: MatrixCell): boolean {
    const drill = this.activeDrill;

    return (
      drill !== null &&
      drill.intent === group.intent &&
      drill.subIntent === 'ALL' &&
      drill.stage === cell.stage
    );
  }

  /** True while the drill-down is showing this whole intent. */
  isIntentActive(group: IntentGroup): boolean {
    const drill = this.activeDrill;

    return drill !== null && drill.intent === group.intent && drill.subIntent === 'ALL';
  }

  trackByIntent(index: number, group: IntentGroup): string {
    return group.intent;
  }

  trackBySubIntent(index: number, row: MatrixRow): string {
    return row.subIntent;
  }

  trackByStage(index: number, cell: MatrixCell): string {
    return cell.stage;
  }

  trackByStageColumn(index: number, stage: WorkflowStage): string {
    return stage.key;
  }
}
