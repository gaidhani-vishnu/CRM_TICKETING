/**
 * One selectable entry in the "Email Date" dropdown.
 * Mirrors EmailDateDropdownItem returned by
 * GET {apiBaseUrl}/emailautomation/dates on the backend.
 */
export interface EmailDateDropdownItem {
  /** Machine value, e.g. '2026-05-13'. Send this back to other API calls for this date. */
  date: string;
  /** Human-friendly value shown in the dropdown, e.g. '13-05-2026'. */
  displayDate: string;
}
