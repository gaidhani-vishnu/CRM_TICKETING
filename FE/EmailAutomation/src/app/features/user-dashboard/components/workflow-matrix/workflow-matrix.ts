import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import {
  ACTION_COLUMNS,
  ActionColumn,
  DrillRequest,
  IntentGroup,
  MatrixCell,
  MatrixRow,
  StepRow,
} from '../../models/user-dashboard.model';

/**
 * Where the open queue is stuck: every intent, its sub-intents, and the step
 * each ticket is on, against what that step is waiting for — the machine, a
 * reviewer's confirmation, or a reviewer's correction — with the overdue
 * count riding beside each figure.
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

  /** The count columns, left to right. */
  readonly columns: ActionColumn[] = ACTION_COLUMNS;

  /** Set of expanded intent names. Initially empty so intents start collapsed. */
  expandedIntents = new Set<string>();

  /**
   * Set of expanded sub-intents, keyed intent + sub-intent: the same sub-intent
   * name can sit under two intents, and opening one must not open the other.
   */
  expandedSubIntents = new Set<string>();

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

  /** Check if a sub-intent's step rows are currently shown. */
  isSubIntentExpanded(row: MatrixRow): boolean {
    return this.expandedSubIntents.has(this.subIntentKey(row));
  }

  /** Toggle a sub-intent's step rows. */
  toggleSubIntent(row: MatrixRow, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    const key = this.subIntentKey(row);

    if (this.expandedSubIntents.has(key)) {
      this.expandedSubIntents.delete(key);
    } else {
      this.expandedSubIntents.add(key);
    }
  }

  private subIntentKey(row: MatrixRow): string {
    return row.intent + '|' + row.subIntent;
  }

  /** Expand every intent and every sub-intent, down to the steps. */
  expandAll(): void {
    for (const group of this.groups) {
      this.expandedIntents.add(group.intent);

      for (const row of group.rows) {
        this.expandedSubIntents.add(this.subIntentKey(row));
      }
    }
  }

  /** Collapse back to the intent rows. */
  collapseAll(): void {
    this.expandedIntents.clear();
    this.expandedSubIntents.clear();
  }

  /** Returns true if every intent and every sub-intent is currently expanded. */
  allExpanded(): boolean {
    return (
      this.groups.length > 0 &&
      this.groups.every(
        (group) => this.isExpanded(group) && group.rows.every((row) => this.isSubIntentExpanded(row))
      )
    );
  }

  /** Toggle between expand all and collapse all. */
  toggleAll(): void {
    if (this.allExpanded()) {
      this.collapseAll();
    } else {
      this.expandAll();
    }
  }

  /** A whole intent — every sub-intent, every step, every column. */
  onIntentClick(group: IntentGroup): void {
    this.drillRequested.emit({ intent: group.intent, subIntent: 'ALL', step: 'ALL', column: 'ALL' });
  }

  /** Drill-down click directly from the intent row hint button. */
  onIntentDrillClick(group: IntentGroup, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.onIntentClick(group);
  }

  /** Click on a parent Intent-level count cell or total cell. */
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
      step: 'ALL',
      column: cell.column,
    });
  }

  /** One sub-intent cell: every step of it under this column, or all of it for Total. */
  onCellClick(row: MatrixRow, cell: MatrixCell, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    if (cell.total === 0) {
      return;
    }

    this.drillRequested.emit({
      intent: row.intent,
      subIntent: row.subIntent,
      step: 'ALL',
      column: cell.column,
    });
  }

  /** One step cell: this step of this sub-intent under this column. */
  onStepCellClick(step: StepRow, cell: MatrixCell): void {
    if (cell.total === 0) {
      return;
    }

    this.drillRequested.emit({
      intent: step.intent,
      subIntent: step.subIntent,
      step: step.step,
      column: cell.column,
    });
  }

  /** True for the one sub-intent cell the drill-down below is currently showing. */
  isActive(row: MatrixRow, cell: MatrixCell): boolean {
    const drill = this.activeDrill;

    return (
      drill !== null &&
      drill.intent === row.intent &&
      drill.subIntent === row.subIntent &&
      drill.step === 'ALL' &&
      drill.column === cell.column
    );
  }

  /** True for the one step cell the drill-down below is currently showing. */
  isStepActive(step: StepRow, cell: MatrixCell): boolean {
    const drill = this.activeDrill;

    return (
      drill !== null &&
      drill.intent === step.intent &&
      drill.subIntent === step.subIntent &&
      drill.step === step.step &&
      drill.column === cell.column
    );
  }

  /** True for an Intent-level count cell the drill-down below is currently showing. */
  isGroupCellActive(group: IntentGroup, cell: MatrixCell): boolean {
    const drill = this.activeDrill;

    return (
      drill !== null &&
      drill.intent === group.intent &&
      drill.subIntent === 'ALL' &&
      drill.column === cell.column
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

  trackByStep(index: number, step: StepRow): string {
    return step.step;
  }

  trackByCell(index: number, cell: MatrixCell): string {
    return cell.column;
  }

  trackByColumn(index: number, column: ActionColumn): string {
    return column.key;
  }
}
