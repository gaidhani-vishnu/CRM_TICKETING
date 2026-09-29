/**
 * One row of PRIDE_PROJECT_BANK_ACCOUNT_MASTER: the two accounts payments on a
 * project (and wing) are receipted against.
 *
 * Mirrors ProjectBankAccountItem returned by
 * GET {apiBaseUrl}/emailautomation/project-bank-accounts.
 */
export interface ProjectBankAccount {
  projectBankAccountId: string;

  /**
   * Project and its wings as one string, in whichever shape the master was typed
   * in: 'MONTREAL-A-B-C-D', 'WELLINGTON - E-H-J-K', 'BOSTON - A B C', or just
   * 'RIO TOWER' where the project has no wings. Split by ProjectBankAccountService.
   */
  projectName: string;

  collectionBankAccount: string;
  sdrMnglGstBankAccount: string;
}
