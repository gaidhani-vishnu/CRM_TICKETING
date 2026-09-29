import { Injectable } from '@angular/core';
import { Observable, map, of, shareReplay, catchError } from 'rxjs';

import { EmailAutomationService } from '../../features/email-automation-workflow/services/email-automation.service';
import { ProjectBankAccount } from '../../features/email-automation-workflow/models/project-bank-account.model';

/** One master row with its project name already split into base + wings. */
interface ParsedAccount {
  account: ProjectBankAccount;
  base: string;
  wings: string[];
}

/**
 * Which collection accounts a payment may be receipted against, resolved from
 * PRIDE_PROJECT_BANK_ACCOUNT_MASTER by the thread's Project + Sub Project.
 *
 * The master writes a project and its wings as one string, in whichever shape it
 * was typed in — 'MONTREAL-A-B-C-D', 'WELLINGTON - E-H-J-K', 'BOSTON - A B C',
 * or plain 'RIO TOWER' — while the receipt rows keep them apart
 * (project 'Wellington', subProject 'H'). The splitting rule here is the same one
 * ProjectAssignmentService uses on config.json's projectMappings; the two are not
 * shared because that service does not export it, so a change to how the master
 * spells its wings has to be made in both.
 */
@Injectable({ providedIn: 'root' })
export class ProjectBankAccountService {
  /**
   * The master, fetched once per app run.
   *
   * Unlike the CRM mapping this is a network call, and every payment card of
   * every thread asks for it, so the response is shared rather than re-requested.
   * A failed load resolves to an empty master: the dropdowns then read "no
   * account mapped", which is the same as a project the master does not carry.
   */
  private readonly accounts$: Observable<ParsedAccount[]>;

  constructor(private readonly emailAutomation: EmailAutomationService) {
    this.accounts$ = this.emailAutomation.getProjectBankAccounts().pipe(
      map((accounts) => accounts.map((account) => this.parse(account))),
      catchError(() => of([] as ParsedAccount[])),
      shareReplay(1)
    );
  }

  /**
   * The accounts offered for one payment row: the matched master row's
   * collection account and its SDR/MNGL/GST account, in that order.
   *
   * Empty when the project is unknown to the master — the card then shows a
   * disabled dropdown rather than guessing an account.
   */
  optionsFor(project: string | undefined, subProject: string | undefined): Observable<string[]> {
    return this.accounts$.pipe(map((accounts) => this.resolve(accounts, project, subProject)));
  }

  /**
   * First hit wins, over three rules in order:
   *
   *   1. base + wing — 'Wellington' + 'H' → 'WELLINGTON - E-H-J-K'.
   *   2. base alone, for a master row with no wings at all — RIO TOWER,
   *      ATLANTIC and SOHO have no sub project, so whatever the row carries in
   *      that column is ignored.
   *   3. prefix, for a name whose trailing token is a word rather than a wing
   *      code: 'SRIDHAM - L BUILDING' never yields 'L' as a wing under rule 1,
   *      so it is matched on the project name plus the wing appearing anywhere
   *      in the string.
   */
  private resolve(
    accounts: ParsedAccount[],
    project: string | undefined,
    subProject: string | undefined
  ): string[] {
    const projectKey = this.normalize(project);

    if (projectKey === '' || accounts.length === 0) {
      return [];
    }

    const wingKey = this.normalize(subProject);

    const onProject = accounts.filter((parsed) => parsed.base === projectKey);

    const hit =
      onProject.find((parsed) => wingKey !== '' && parsed.wings.indexOf(wingKey) !== -1) ||
      onProject.find((parsed) => parsed.wings.length === 0) ||
      accounts.find((parsed) => this.matchesByPrefix(parsed, projectKey, wingKey));

    if (!hit) {
      return [];
    }

    // Blanks dropped, and duplicates with them: several projects share one
    // SDR/MNGL/GST account, and a few rows repeat their collection account there.
    const options = [hit.account.collectionBankAccount, hit.account.sdrMnglGstBankAccount]
      .map((value) => (value || '').trim())
      .filter((value) => value !== '');

    return options.filter((value, index) => options.indexOf(value) === index);
  }

  /** Rule 3: the name starts with the project, and carries the wing if there is one. */
  private matchesByPrefix(parsed: ParsedAccount, projectKey: string, wingKey: string): boolean {
    const tokens = this.tokenize(parsed.account.projectName);
    const projectTokens = projectKey.split(' ');

    const startsWithProject = projectTokens.every((token, index) => tokens[index] === token);

    if (!startsWithProject) {
      return false;
    }

    return wingKey === '' || tokens.indexOf(wingKey) !== -1;
  }

  /** Splits one master row's project name into its base project and wing codes. */
  private parse(account: ProjectBankAccount): ParsedAccount {
    const tokens = this.tokenize(account.projectName);

    // Walk backwards taking short alphanumeric codes (A, D, F, A1, B2) as wings.
    // Stops at the first real word, so 'RIO TOWER' and 'SRIDHAM L BUILDING' keep
    // every token in the base and match on project name alone.
    const wings: string[] = [];
    let end = tokens.length;

    while (end > 1 && /^[A-Z]\d?$/.test(tokens[end - 1])) {
      wings.unshift(tokens[end - 1]);
      end--;
    }

    return { account, base: tokens.slice(0, end).join(' '), wings };
  }

  /** 'WELLINGTON - E-H-J-K' → ['WELLINGTON', 'E', 'H', 'J', 'K']. */
  private tokenize(value: string | undefined): string[] {
    return (value || '')
      .toUpperCase()
      .split(/[-\s]+/)
      .filter((token) => token !== '');
  }

  private normalize(value: string | undefined): string {
    return this.tokenize(value).join(' ');
  }
}
