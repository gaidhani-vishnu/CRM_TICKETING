import { Injectable } from '@angular/core';

import { CrmSlot } from '../models/app-config.model';
import { ConfigService } from './config.service';
import { AssignedUser, ProjectAssignmentService } from './project-assignment.service';

/** Everything the rule needs to name a thread's owner. */
export interface SlotAssignmentInput {
  /** Unit Match's verdict. False keeps the old rule: the CRM head owns it. */
  unitMatched: boolean;
  /**
   * BOOKING_STATUS_NAME off the matched booking, raw.
   *
   * Blank and undefined are meaningful — they mean the stage is unknown, which
   * is what puts the thread in front of a reviewer rather than on a guess.
   */
  bookingStatusName?: string | null;
  project?: string;
  subProject?: string;
}

/** Why the owner below is the owner — the card prints a line from this. */
export type SlotAssignmentReason =
  /** Unit Match said Unmatch; nothing about the booking was read. */
  | 'unit-unmatched'
  /** The first of the project's owners who works the booking's stage. */
  | 'slot-mapping'
  /** The slot is known but nobody holds it here, so the CRM head does. */
  | 'no-slot-user'
  /** The booking status is blank or unlisted — a reviewer has to say who owns it. */
  | 'unknown-status';

export interface SlotAssignmentDecision {
  /** Never null: the CRM head owns whatever the rules cannot place. */
  user: AssignedUser;
  /** null when the booking status did not resolve to one. */
  slot: CrmSlot | null;
  reason: SlotAssignmentReason;
  /** True only for 'unknown-status' — the card asks the reviewer to pick. */
  needsIntervention: boolean;
  /** The names that were in the running, for the card's meta line. */
  pool: string[];
}

/**
 * Decides which CRM user owns a thread once its unit has been matched.
 *
 * The booking's own stage is what picks the owner. Every booking status is
 * staged in config.json under one of three slots — Pre-Agreement,
 * Post-Agreement, Post-Possession — and all three are worked the same way: the
 * project + sub-project mapping says who this project's executives are, the
 * slot narrows them to whoever works that stage, and the first of those owns
 * the thread. First, as it was before slots existed; the slot only shortens the
 * list the mapping already puts in order.
 *
 * Anything that does not resolve — the unit did not match, the status is not
 * staged, or nobody on this project works the stage — goes to the CRM head, so
 * a thread is never left unowned.
 *
 * Lives in its own service rather than in the pipeline component: the rule is
 * config-driven and worth testing on its own, and the component already carries
 * enough. The project + wing matching is not re-implemented — that stays in
 * ProjectAssignmentService, which this calls.
 */
@Injectable({ providedIn: 'root' })
export class SlotAssignmentService {
  constructor(
    private readonly config: ConfigService,
    private readonly projectAssignment: ProjectAssignmentService
  ) {}

  resolve(input: SlotAssignmentInput): SlotAssignmentDecision {
    // Unchanged from before slots existed: an unmatched unit cannot be placed
    // against a booking, so there is no stage to read and the head owns it.
    if (!input.unitMatched) {
      return this.head('unit-unmatched', null);
    }

    const slot = this.config.slotForBookingStatus(input.bookingStatusName);

    if (!slot) {
      return { ...this.head('unknown-status', null), needsIntervention: true };
    }

    return this.byMapping(slot, input);
  }

  /**
   * The project's own people, minus anyone who does not work this stage.
   *
   * The mapping's order is kept, so "the first of them" means what it meant
   * before slots existed — the executive the project lists first. Every slot
   * takes any number of users; which of them wins is a config.json question,
   * not a code one, and re-ordering a mapping is how the CRM team moves a
   * project's threads to somebody else.
   */
  private byMapping(slot: CrmSlot, input: SlotAssignmentInput): SlotAssignmentDecision {
    const mapped = this.projectAssignment.getAssignment(input.project, input.subProject);

    // 'fallback' means the project/sub-project matched no mapping at all — its
    // users list is the CRM head, not anybody this slot could narrow.
    if (mapped.matchLevel === 'fallback') {
      return this.head('no-slot-user', slot);
    }

    const inSlot = this.config.usersInSlot(slot).map((user) => this.nameKey(user.name));
    const eligible = mapped.users.filter((user) => inSlot.indexOf(this.nameKey(user.name)) !== -1);
    const pool = mapped.users.map((user) => user.name);

    if (eligible.length === 0) {
      return this.head('no-slot-user', slot, pool);
    }

    return {
      user: eligible[0],
      slot,
      reason: 'slot-mapping',
      needsIntervention: false,
      pool,
    };
  }

  /** The CRM head as owner, with the reason it came to that. */
  private head(
    reason: SlotAssignmentReason,
    slot: CrmSlot | null,
    pool: string[] = []
  ): SlotAssignmentDecision {
    const owner = this.config.fallbackUser;

    return {
      user: { name: owner.name, emailId: owner.emailId },
      slot,
      reason,
      needsIntervention: false,
      pool,
    };
  }

  /** Names are compared the way the rest of the config layer compares them. */
  private nameKey(name: string): string {
    return (name || '').trim().toUpperCase();
  }
}
