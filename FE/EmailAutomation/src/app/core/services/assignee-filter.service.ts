import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

import { ALL_USERS } from '../../shared/models/user-filter.model';

/**
 * Which CRM executive the workspace is currently scoped to.
 *
 * Held here rather than on either screen because the picker now sits in both
 * headers and has to mean one thing: narrowing to KAILASH D on the dashboard
 * and switching to Email Automation must land on KAILASH D's threads, not on
 * everyone's. The shell mounts the screens with *ngIf, so a screen's own field
 * would be thrown away on every switch.
 *
 * A name, not an id — it is matched against [Assigned To] on the receipts rows
 * and against the dashboard's resolved owner, and both of those are names.
 */
@Injectable({ providedIn: 'root' })
export class AssigneeFilterService {
  private readonly selectedSubject = new BehaviorSubject<string>(ALL_USERS);

  /** The chosen owner, or ALL_USERS. */
  readonly selected$: Observable<string> = this.selectedSubject.asObservable();

  get selected(): string {
    return this.selectedSubject.value;
  }

  select(value: string): void {
    const next = value || ALL_USERS;

    if (next !== this.selectedSubject.value) {
      this.selectedSubject.next(next);
    }
  }

  /**
   * Drops the choice when the owner it names is no longer on offer.
   *
   * The two screens read different sets of dates, so an executive who holds
   * threads on one may hold none on the other; without this the picker would
   * sit on a name nothing matches and the list underneath would read empty
   * for no visible reason.
   */
  keepIfPresent(names: string[]): void {
    if (this.selected !== ALL_USERS && names.indexOf(this.selected) === -1) {
      this.select(ALL_USERS);
    }
  }
}
