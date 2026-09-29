import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

import {
  WorkflowEditField,
  WorkflowEditGroup,
  WorkflowEditRequest,
  WorkflowEditSubmission,
} from './workflow-edit-dialog.model';

/**
 * The reviewer-edit popup used by every pipeline edit gate.
 *
 * Purely presentational, the same way <app-step-inspector> is: it renders the
 * fields it is handed and emits what the reviewer typed. It never calls the API
 * and never decides what happens next — the visualizer stays the single place
 * that saves the edit and re-runs the blocked step.
 */
@Component({
  selector: 'app-workflow-edit-dialog',
  standalone: false,
  templateUrl: './workflow-edit-dialog.html',
  styleUrl: './workflow-edit-dialog.scss',
})
export class WorkflowEditDialog implements OnChanges {
  /** The edit to render. Nothing shows while this is null. */
  @Input() request: WorkflowEditRequest | null = null;

  /** True while the save is in flight; the buttons and inputs lock. */
  @Input() isSaving = false;

  /** Set when the save (or the step re-run after it) came back with a problem. */
  @Input() errorMessage = '';

  @Output() save = new EventEmitter<WorkflowEditSubmission>();
  @Output() cancel = new EventEmitter<void>();

  /**
   * The dialog's own copy of the fields.
   *
   * Edited in place by the inputs, so the caller's request object is never
   * mutated — cancelling has to leave the pipeline exactly as it was.
   */
  groups: WorkflowEditGroup[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['request']) {
      this.groups = this.copyOf(this.request);
    }
  }

  /**
   * A required field the reviewer has not filled in yet — drawn with a red
   * border to say what the step is still waiting on.
   *
   * It does not hold Save shut. Filling four payments in from four different
   * places takes more than one sitting, and a dialog that refuses to keep what
   * has been typed until every last field is answered loses the work.
   */
  isBlank(field: WorkflowEditField): boolean {
    return !!field.required && field.value.trim().length === 0;
  }

  /** Save is offered at all times, except while a save is already running. */
  canSave(): boolean {
    return !this.isSaving;
  }

  /**
   * Emits what the reviewer actually filled in.
   *
   * Blank fields are left out rather than sent as empty strings: an omitted
   * field is not written at all, so saving one corrected value cannot wipe the
   * others — and in particular cannot overwrite a masked account number, which
   * the form deliberately shows as an empty box.
   */
  onSave(): void {
    if (!this.request || !this.canSave()) {
      return;
    }

    const values: WorkflowEditSubmission['values'] = {};

    for (const group of this.groups) {
      const fields: { [key: string]: string } = {};

      for (const field of group.fields) {
        const value = field.value.trim();

        if (value.length > 0) {
          fields[field.key] = value;
        }
      }

      if (Object.keys(fields).length > 0) {
        values[group.id] = fields;
      }
    }

    this.save.emit({ gate: this.request.gate, values });
  }

  onCancel(): void {
    this.cancel.emit();
  }

  /** Deep-copies just enough of the request for the inputs to bind to. */
  private copyOf(request: WorkflowEditRequest | null): WorkflowEditGroup[] {
    if (!request) {
      return [];
    }

    return request.groups.map((group) => ({
      ...group,
      fields: group.fields.map((field) => ({ ...field })),
    }));
  }
}
