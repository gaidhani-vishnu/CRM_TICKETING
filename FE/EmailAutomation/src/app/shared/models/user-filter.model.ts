/**
 * The owner filter both screens carry in their header.
 *
 * One model and one component for the two, because the picker is the same
 * question on both — whose threads am I looking at — and it used to be asked
 * twice in two different shapes: a menu inside the Email Receipts panel on
 * one screen, a header pill on the other.
 */

/** The "every CRM executive" choice. Not a name, so it collides with none. */
export const ALL_USERS = 'ALL';

/** One row of the picker. */
export interface UserFilterOption {
  /** ALL_USERS, or the owner's name exactly as the rows spell it. */
  value: string;
  label: string;
  /** Up to two letters for the avatar; blank for the "all users" row. */
  initials: string;
  /** How many threads sit behind the row — why one owner is picked over another. */
  count: number;
}

/**
 * Up to two letters for an avatar: 'KAILASH D' → 'KD', 'RITA' → 'RI'.
 *
 * Split on the separators these names actually use — 'CRM_Head' is one word
 * to a space-only split and would read 'CR' rather than 'CH'.
 */
export function userInitials(name: string): string {
  const parts = (name || '').split(/[\s_.-]+/).filter((part) => part !== '');

  if (parts.length === 0) {
    return '?';
  }

  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }

  return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

/**
 * Who a thread is filed under, given its [Assigned To] and the configured CRM head.
 *
 * A blank [Assigned To] is the CRM head's: the head holds every thread Unit
 * Match has not settled. Matched without case so "CRM head" and "CRM_Head"
 * are one person, always named the way config.json spells it.
 *
 * Shared by both screens so their pickers can never file the same thread
 * under two different people.
 *
 * `keyOf` folds the spellings of one person into one — ConfigService.mailboxOf
 * turns an older row's 'KAILASH D' into the 'CRM2@…' the column now stores.
 */
export function ownerOf(
  assignedTo: string | undefined,
  crmHead: string,
  keyOf?: (value: string) => string
): string {
  const raw = (assignedTo || '').trim();
  const name = keyOf && raw !== '' ? keyOf(raw) : raw;

  return name === '' || name.toLowerCase() === crmHead.toLowerCase() ? crmHead : name;
}

/**
 * The picker's rows for a set of receipt rows: everyone first, then each
 * owner alphabetically with how many threads they hold.
 *
 * Both screens build their menu through this one function over the same
 * receipt rows, which is what keeps the two menus' figures identical.
 *
 * `labelOf` turns an owner into what the row reads — 'Namrata' for
 * 'CRMHEAD@PRIDEWORLDCITY.COM'. Only the label changes: `value` stays the
 * owner as the rows spell it, so filtering and counts are untouched.
 */
export function buildOwnerOptions(
  rows: { assignedTo?: string }[],
  crmHead: string,
  labelOf?: (name: string) => string,
  keyOf?: (value: string) => string
): UserFilterOption[] {
  const counts: { [name: string]: number } = {};

  for (const row of rows) {
    const name = ownerOf(row.assignedTo, crmHead, keyOf);

    counts[name] = (counts[name] || 0) + 1;
  }

  const everyone: UserFilterOption = {
    value: ALL_USERS,
    label: 'All users',
    initials: '',
    count: rows.length,
  };

  const owners = Object.keys(counts).map((name) => {
    const label = (labelOf ? labelOf(name) : name) || name;

    return {
      value: name,
      label,
      initials: userInitials(label),
      count: counts[name],
    };
  });

  return [everyone].concat(owners.sort((a, b) => a.label.localeCompare(b.label)));
}
