import { Injectable } from '@angular/core';

import { ProjectMapping } from '../models/app-config.model';
import { ConfigService } from './config.service';

/** One resolved assignee: the master-sheet name plus the CRM mailbox it maps to. */
export interface AssignedUser {
  name: string;
  /** '' when the user has no entry in the master users list (e.g. PIYUSH). */
  emailId: string;
}

/**
 * How confidently the row was matched to the master sheet:
 * - 'wing'     — matched project *and* sub-project (e.g. Wellington + E -> WELLINGTON - E-H-J-K),
 *                or matched a mapping that covers the whole project because it lists no wings
 * - 'fallback' — could not be matched, so the CRM head owns it. Covers all three gaps:
 *                project known but sub-project missing/unlisted, sub-project given but project
 *                unknown, and neither one present.
 * - 'none'     — nothing has been resolved yet (initial state before a row is selected).
 *                getAssignment() never returns this.
 */
export type AssignmentMatchLevel = 'wing' | 'fallback' | 'none';

export interface ProjectAssignment {
  users: AssignedUser[];
  matchLevel: AssignmentMatchLevel;
  /** projectName values from config.json that produced this result. */
  matchedProjects: string[];
}

/** A projectName from config.json split into its base name and its wing codes. */
interface ParsedMapping {
  mapping: ProjectMapping;
  /** e.g. 'WELLINGTON', 'RIO TOWER'. Upper-cased. */
  base: string;
  /**
   * The entry's subProject, e.g. ['H']; for an entry without one, the codes in its
   * name, e.g. ['E','H','J','K']. Empty = mapping covers the whole project.
   */
  wings: string[];
}

/**
 * Resolves which CRM users own an email receipt, from its Project + Sub Project.
 *
 * The master sheet writes the wing into the project name itself — 'WELLINGTON - E-H-J-K',
 * 'BOSTON - A B C', 'MONTREAL-A-B-C-D', 'MIAMI - A1-A2-A3-B2' — while the receipts CSV keeps
 * them in separate columns ('Wellington' + 'E'). So the name is split back into a base plus
 * a set of wing codes before matching.
 *
 * Anything the mapping cannot place lands on the configured CRM head rather than on nobody.
 */
@Injectable({ providedIn: 'root' })
export class ProjectAssignmentService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Returns the users assigned to a receipt row's project/sub-project.
   *
   * Only an exact project+wing hit resolves to the mapped CRM executives. Every
   * other outcome routes to the CRM head, so a receipt is never left unowned:
   *   1. project matched but its sub-project is blank or not listed for it,
   *   2. a sub-project was given but the project is unknown/unlisted,
   *   3. neither project nor sub-project is present.
   */
  getAssignment(project: string | undefined, subProject: string | undefined): ProjectAssignment {
    const projectKey = this.normalize(project);
    const wingKey = this.normalize(subProject);

    if (!projectKey) {
      return this.fallbackAssignment();
    }

    const onProject = this.parsedMappings().filter((p) => p.base === projectKey);
    if (onProject.length === 0) {
      return this.fallbackAssignment();
    }

    // A mapping that covers this exact wing — or covers the whole project
    // because it lists no wings at all (SOHO, RIO TOWER), in which case the
    // project name alone is already a complete match.
    const exact = onProject.filter(
      (p) => p.wings.length === 0 || (wingKey !== '' && p.wings.indexOf(wingKey) !== -1)
    );

    if (exact.length === 0) {
      return this.fallbackAssignment();
    }

    return {
      users: this.toUsers(exact),
      matchLevel: 'wing',
      matchedProjects: exact.map((p) => p.mapping.projectName),
    };
  }

  /** The CRM head, as the sole owner of anything the master mapping cannot place. */
  private fallbackAssignment(): ProjectAssignment {
    const head = this.config.fallbackUser;

    return {
      users: [{ name: head.name, emailId: head.emailId }],
      matchLevel: 'fallback',
      matchedProjects: [],
    };
  }

  /** Dedupes user names across the matched mappings and attaches each one's email. */
  private toUsers(hits: ParsedMapping[]): AssignedUser[] {
    const seen: string[] = [];
    const users: AssignedUser[] = [];

    for (const hit of hits) {
      for (const name of hit.mapping.users) {
        const key = this.normalize(name);
        if (key === '' || seen.indexOf(key) !== -1) {
          continue;
        }
        seen.push(key);
        users.push({ name: name.trim(), emailId: this.config.getEmailForUser(name) });
      }
    }

    return users;
  }

  /**
   * Splits every configured projectName into base + wings. An entry's own
   * subProject, when it has one, is its only wing — the codes in projectName
   * then just name the building group and are not used for matching.
   *
   * Not cached: config.json is re-read on every app start and the mapping list is tiny,
   * so recomputing keeps edits to the file live without any invalidation logic.
   */
  private parsedMappings(): ParsedMapping[] {
    return this.config.projectMappings.map((mapping) => {
      const parsed = this.parseProjectName(mapping);
      const subProject = this.normalize(mapping.subProject);

      return subProject ? { ...parsed, wings: [subProject] } : parsed;
    });
  }

  private parseProjectName(mapping: ProjectMapping): ParsedMapping {
    const tokens = (mapping.projectName || '')
      .toUpperCase()
      .split(/[-\s]+/)
      .filter((t) => t !== '');

    // Walk backwards taking short alphanumeric codes (A, D, F, A1, B2) as wings.
    // Stops at the first real word, so 'RIO TOWER' and 'SHRIDHAM L BUILDING'
    // keep all their tokens in the base and match on project name alone.
    const wings: string[] = [];
    let end = tokens.length;
    while (end > 1 && /^[A-Z]\d?$/.test(tokens[end - 1])) {
      wings.unshift(tokens[end - 1]);
      end--;
    }

    return { mapping, base: tokens.slice(0, end).join(' '), wings };
  }

  private normalize(value: string | undefined): string {
    return (value || '').trim().toUpperCase();
  }
}
