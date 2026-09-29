using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;

namespace EmailAutomation.Services
{
    /// <summary>
    /// Searches a month's bank statement workbooks for a payment's instrument
    /// number, and highlights the Description cell it was found in.
    ///
    /// The workbooks come in two layouts — the header row sits on a different
    /// row in each, and the amount column is "Transaction Amount(INR)" in one and
    /// "Deposit" in the other — but both label the narration column "Description",
    /// so the header row is found by looking for that label rather than by a fixed
    /// row number. Matching is a case-insensitive "contains", mirroring the SQL
    /// LIKE the pipeline uses elsewhere.
    ///
    /// The files are macro-enabled (.xlsm). Cells are edited in place through the
    /// Open XML SDK, which rewrites only the parts it touches, so the workbook's
    /// VBA project and every other sheet survive untouched.
    /// </summary>
    public static class BankStatementMatcher
    {
        /// <summary>Header label that marks the narration column in both layouts.</summary>
        private const string DescriptionHeader = "Description";

        /// <summary>Header label for the statement's own transaction date column.</summary>
        private const string ValueDateHeader = "Value Date";

        /// <summary>How far down to look for the header row before giving up.</summary>
        private const int HeaderSearchRowLimit = 40;

        /// <summary>Green fill applied to a Description cell that matched.</summary>
        private const string MatchFillColor = "FF92D050";

        /// <summary>Yellow fill applied to the amount cell once bank reco matches.</summary>
        private const string ReconciledFillColor = "FFFFFF00";

        /// <summary>
        /// Header labels the amount sits under. The two statement layouts name it
        /// differently — "Deposit" on the Kotak sheets, "Transaction Amount(INR)"
        /// on the ICICI ones — while both label the narration "Description".
        /// </summary>
        private static readonly string[] AmountHeaders =
        {
            "Deposit",
            "Transaction Amount(INR)",
            "Transaction Amount"
        };

        /// <summary>Two amounts are the same payment if they agree to the paisa.</summary>
        private const decimal AmountTolerance = 0.01m;

        /// <summary>Outcome of searching the statements for one payment.</summary>
        public class InstrumentSearchResult
        {
            public bool Matched { get; set; }
            /// <summary>Workbook searched, file name only. Empty when none was found.</summary>
            public string FileName { get; set; }
            public string SheetName { get; set; }
            /// <summary>Cells highlighted, e.g. "F377". Empty when nothing matched.</summary>
            public List<string> MatchedCells { get; set; }
            /// <summary>Description text of the first hit, for the UI.</summary>
            public string MatchedDescription { get; set; }
            /// <summary>Why no match was possible, when that is the reason rather than "not present".</summary>
            public string Reason { get; set; }

            public InstrumentSearchResult()
            {
                FileName = string.Empty;
                SheetName = string.Empty;
                MatchedCells = new List<string>();
                MatchedDescription = string.Empty;
                Reason = string.Empty;
            }
        }

        /// <summary>
        /// Month sub-folder names a thread's email date could be filed under, most
        /// likely first: the full month name as the statement folders are actually
        /// named ("SEPTEMBER_2026", "AUGUST_2026"), then the short form
        /// ("SEP_2026"). Only the short form used to be tried, which happened to
        /// work for MAY and missed every month whose name is longer than three
        /// letters. Empty when the date cannot be read.
        /// </summary>
        public static List<string> MonthFolderCandidates(string emailDate)
        {
            DateTime parsed;

            var formats = new[]
            {
                "dd-MMM-yy", "dd-MMM-yyyy", "d-MMM-yy", "d-MMM-yyyy",
                "dd-MM-yyyy", "d-M-yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy"
            };

            if (!DateTime.TryParseExact((emailDate ?? string.Empty).Trim(), formats,
                    CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed) &&
                !DateTime.TryParse(emailDate, CultureInfo.InvariantCulture, DateTimeStyles.None, out parsed))
            {
                return new List<string>();
            }

            var year = "_" + parsed.ToString("yyyy", CultureInfo.InvariantCulture);

            return new[] { "MMMM", "MMM" }
                .Select(format => parsed.ToString(format, CultureInfo.InvariantCulture).ToUpperInvariant() + year)
                .Distinct()
                .ToList();
        }

        /// <summary>
        /// The month sub-folder of <paramref name="basePath"/> that actually exists
        /// for a thread's email date, matched without case. When none does, the
        /// full-month candidate is returned so the "does not exist" message names
        /// the folder a person would be expected to create. Empty when the date
        /// cannot be read.
        /// </summary>
        public static string ResolveMonthFolder(string basePath, string emailDate)
        {
            var candidates = MonthFolderCandidates(emailDate);

            if (candidates.Count == 0)
            {
                return string.Empty;
            }

            if (Directory.Exists(basePath))
            {
                var existing = Directory.GetDirectories(basePath).Select(Path.GetFileName).ToList();

                foreach (var candidate in candidates)
                {
                    var match = existing.FirstOrDefault(name =>
                        string.Equals(name, candidate, StringComparison.OrdinalIgnoreCase));

                    if (match != null)
                    {
                        return match;
                    }
                }
            }

            return candidates[0];
        }

        /// <summary>
        /// Last 4 digits of an account number. The receipts data masks these in
        /// several ways — "XX5968", "XXXXXXXX8250", "000505038250" — so everything
        /// that is not a digit is dropped first.
        /// </summary>
        public static string LastFourDigits(string accountNumber)
        {
            var digits = new string((accountNumber ?? string.Empty).Where(char.IsDigit).ToArray());

            return digits.Length < 4 ? string.Empty : digits.Substring(digits.Length - 4);
        }

        /// <summary>
        /// Every workbook in <paramref name="monthFolder"/> whose file name carries
        /// <paramref name="lastFour"/>, e.g. 4089 → "KOTAK_WELLINGTON_E-H-J-K-4089.xlsm".
        /// Empty when the folder has none.
        ///
        /// All of them, not the first: a month folder can hold two accounts whose
        /// numbers end in the same four digits - "ICICI 8100 Collection.xlsm"
        /// (...978100) and "ICICI 8100 Sridham Collection.xlsm" (...968100) - and
        /// taking whichever sorted first meant a payment could be called Unmatch
        /// against one workbook while its row sat in the other, never opened. The
        /// caller searches them in turn and stops at the first hit.
        /// </summary>
        public static List<string> FindStatementFiles(string monthFolder, string lastFour)
        {
            if (!Directory.Exists(monthFolder) || string.IsNullOrEmpty(lastFour))
            {
                return new List<string>();
            }

            return Directory.GetFiles(monthFolder, "*.xls*")
                .Where(path => !Path.GetFileName(path).StartsWith("~$")) // skip Excel lock files
                .Where(path => Path.GetFileNameWithoutExtension(path).Contains(lastFour))
                .OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        /// <summary>
        /// The workbook's first sheet, as a sequence so the callers' loops read
        /// unchanged - empty when the file has no sheet at all.
        ///
        /// Every statement workbook keeps the current month on its first tab.
        /// Whatever sits behind it is an older statement someone left in the file,
        /// so it is never searched, never highlighted, and never read for the
        /// account's last record.
        /// </summary>
        private static IEnumerable<Sheet> FirstSheet(WorkbookPart workbookPart)
        {
            var sheet = workbookPart == null || workbookPart.Workbook == null
                ? null
                : workbookPart.Workbook.Descendants<Sheet>().FirstOrDefault();

            if (sheet != null)
            {
                yield return sheet;
            }
        }

        /// <summary>
        /// Whether the block above <paramref name="headerRow"/> names an account
        /// other than the one ending in <paramref name="lastFour"/>.
        ///
        /// Both layouts print the account on a "Transactions List - ... -
        /// 777705978100" line a few rows above the column headers. A sheet naming
        /// no account at all is not treated as another account's: it is still the
        /// workbook's first tab, which is this month's statement.
        /// </summary>
        private static bool SheetNamesAnotherAccount(
            List<Row> rows, List<string> sharedStrings, uint headerRow, string lastFour)
        {
            var namedAnAccount = false;

            foreach (var row in rows)
            {
                if (row.RowIndex != null && row.RowIndex.Value >= headerRow)
                {
                    break; // rows come in document order; the block is above the headers
                }

                foreach (var cell in row.Elements<Cell>())
                {
                    var text = CellText(cell, sharedStrings);

                    if (text.Length == 0)
                    {
                        continue;
                    }

                    var digits = new string(text.Where(char.IsDigit).ToArray());

                    // Only an account-length run counts. A date or an amount in the
                    // same block can end in the same four digits by chance, and it
                    // is "... - 777705978100" this is looking for.
                    if (digits.Length < 8)
                    {
                        continue;
                    }

                    if (digits.EndsWith(lastFour, StringComparison.Ordinal))
                    {
                        return false; // this is the account being searched
                    }

                    namedAnAccount = true;
                }
            }

            return namedAnAccount;
        }

        /// <summary>
        /// Searches one workbook for every instrument number in
        /// <paramref name="instrumentNumbers"/> at once — the file is opened a
        /// single time however many payments point at it — and paints the
        /// Description cell of each hit green.
        /// </summary>
        /// <returns>Result per instrument number, keyed as supplied.</returns>
        public static Dictionary<string, InstrumentSearchResult> SearchAndHighlight(
            string filePath, IEnumerable<string> instrumentNumbers)
        {
            var wanted = instrumentNumbers
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var results = wanted.ToDictionary(
                value => value,
                value => new InstrumentSearchResult { FileName = Path.GetFileName(filePath) },
                StringComparer.OrdinalIgnoreCase);

            if (wanted.Count == 0)
            {
                return results;
            }

            using (var document = SpreadsheetDocument.Open(filePath, true))
            {
                var workbookPart = document.WorkbookPart;
                var sharedStrings = ReadSharedStrings(workbookPart);
                var greenStyles = new FillStyleCache(workbookPart, MatchFillColor);
                var anythingHighlighted = false;
                var foundDescriptionColumn = false;

                // The first sheet only. This month's statement is always the
                // workbook's first tab; anything behind it is an older statement
                // left in the file - "ICICI 8100 Collection.xlsm" carries a 2023
                // one on Sheet1 - and searching that reports a hit on a row from
                // another month, or another account entirely.
                foreach (var sheet in FirstSheet(workbookPart))
                {
                    var worksheetPart = workbookPart.GetPartById(sheet.Id) as WorksheetPart;

                    if (worksheetPart == null)
                    {
                        continue;
                    }

                    var rows = worksheetPart.Worksheet.Descendants<Row>().ToList();
                    var descriptionColumn = FindDescriptionColumn(rows, sharedStrings);

                    if (descriptionColumn == null)
                    {
                        continue; // not a statement sheet — no Description header on it
                    }

                    foundDescriptionColumn = true;
                    var sheetName = sheet.Name == null ? string.Empty : sheet.Name.Value;

                    foreach (var row in rows)
                    {
                        if (row.RowIndex != null && row.RowIndex.Value <= descriptionColumn.HeaderRow)
                        {
                            continue; // header row and everything above it
                        }

                        var cell = row.Elements<Cell>()
                            .FirstOrDefault(c => ColumnOf(c.CellReference) == descriptionColumn.Column);

                        if (cell == null)
                        {
                            continue;
                        }

                        var text = CellText(cell, sharedStrings);

                        if (string.IsNullOrWhiteSpace(text))
                        {
                            continue;
                        }

                        foreach (var instrument in wanted)
                        {
                            if (text.IndexOf(instrument, StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                continue;
                            }

                            var result = results[instrument];
                            result.Matched = true;
                            result.SheetName = sheetName;
                            result.MatchedCells.Add(cell.CellReference == null ? string.Empty : cell.CellReference.Value);

                            if (result.MatchedDescription.Length == 0)
                            {
                                result.MatchedDescription = text;
                            }

                            cell.StyleIndex = greenStyles.FilledVariantOf(cell.StyleIndex);
                            anythingHighlighted = true;
                        }
                    }

                    if (anythingHighlighted)
                    {
                        worksheetPart.Worksheet.Save();
                    }
                }

                if (!foundDescriptionColumn)
                {
                    foreach (var result in results.Values)
                    {
                        result.Reason = $"No \"{DescriptionHeader}\" column found in {Path.GetFileName(filePath)}.";
                    }
                }

                if (anythingHighlighted)
                {
                    greenStyles.Save();
                    workbookPart.Workbook.Save();
                }
            }

            return results;
        }

        // ── Bank reconciliation ──────────────────────────────────────

        /// <summary>One payment to reconcile against the statement.</summary>
        public class PaymentToReconcile
        {
            public string InstrumentNumber { get; set; }
            /// <summary>Amount from the receipt details row.</summary>
            public decimal Amount { get; set; }
        }

        /// <summary>Outcome of reconciling one payment.</summary>
        public class ReconcileResult
        {
            /// <summary>True when a statement row carries this instrument AND this amount.</summary>
            public bool Matched { get; set; }
            /// <summary>True when more than one statement row carries the same instrument and amount.</summary>
            public bool DuplicateFound { get; set; }
            /// <summary>How many statement rows matched on instrument + amount.</summary>
            public int MatchCount { get; set; }
            public string FileName { get; set; }
            public string SheetName { get; set; }
            /// <summary>Amount cells filled yellow, e.g. "G205".</summary>
            public List<string> MatchedCells { get; set; }
            /// <summary>The statement's amount for the first hit.</summary>
            public decimal StatementAmount { get; set; }
            public string Reason { get; set; }

            /// <summary>
            /// The "Value Date" cell of the statement sheet's last real transaction
            /// row, exactly as the workbook holds it — no date parsing, no
            /// reformatting, whatever CellText reads back. How current the sheet's
            /// data is, so a reviewer looking at an Unmatch verdict can tell
            /// whether the payment is genuinely missing or simply dated after what
            /// has been uploaded so far. Empty when the sheet has no "Value Date"
            /// column, or every row of it was blank.
            /// </summary>
            public string LastValueDate { get; set; }

            public ReconcileResult()
            {
                FileName = string.Empty;
                SheetName = string.Empty;
                MatchedCells = new List<string>();
                Reason = string.Empty;
                LastValueDate = string.Empty;
            }
        }

        /// <summary>
        /// Reconciles payments against one workbook: a payment matches when a
        /// statement row's Description carries its instrument number AND that row's
        /// amount equals the payment's amount. Every matching row's amount cell is
        /// filled yellow; the Description cell keeps whatever the Instrument Match
        /// step painted on it, since only the amount column is touched here.
        ///
        /// Finding the same instrument and amount on more than one row is what
        /// flags a duplicate entry.
        /// </summary>
        public static Dictionary<string, ReconcileResult> ReconcileAndHighlight(
            string filePath, IEnumerable<PaymentToReconcile> payments, string accountLastFour)
        {
            var wanted = payments
                .Where(p => p != null && !string.IsNullOrWhiteSpace(p.InstrumentNumber))
                .GroupBy(p => p.InstrumentNumber.Trim(), StringComparer.OrdinalIgnoreCase)
                .Select(g => g.First())
                .ToList();

            var results = wanted.ToDictionary(
                p => p.InstrumentNumber.Trim(),
                p => new ReconcileResult { FileName = Path.GetFileName(filePath) },
                StringComparer.OrdinalIgnoreCase);

            if (wanted.Count == 0)
            {
                return results;
            }

            // The account's last four, as the caller found the file by. Passed in
            // rather than read back off the file name, which cannot be picked apart
            // reliably - "KOTAK_MIAMI-A1-A2-A3-B2- 4100.xlsm" yields "1232" from the
            // unit letters before the number as readily as it yields "4100". ''
            // turns the sheet check off, and then every sheet is read as before.
            var accountMarker = (accountLastFour ?? string.Empty).Trim();

            using (var document = SpreadsheetDocument.Open(filePath, true))
            {
                var workbookPart = document.WorkbookPart;
                var sharedStrings = ReadSharedStrings(workbookPart);
                var yellowStyles = new FillStyleCache(workbookPart, ReconciledFillColor);
                var anythingHighlighted = false;
                var foundAmountColumn = false;

                // The first sheet only - see SearchAndHighlight. The tabs behind
                // it are last year's statements, and reconciling against one both
                // matched rows that are not this month's and reported its last row
                // as this account's most recent record.
                foreach (var sheet in FirstSheet(workbookPart))
                {
                    var worksheetPart = workbookPart.GetPartById(sheet.Id) as WorksheetPart;

                    if (worksheetPart == null)
                    {
                        continue;
                    }

                    var rows = worksheetPart.Worksheet.Descendants<Row>().ToList();
                    var descriptionColumn = FindDescriptionColumn(rows, sharedStrings);

                    if (descriptionColumn == null)
                    {
                        continue; // not a statement sheet
                    }

                    // The sheet names its own account in the block above the
                    // header ("Transactions List - ... - 777705978100"). When it
                    // names one that is not this payment's, the workbook is not
                    // the one being searched and its rows are left alone; a sheet
                    // naming no account at all is read as before, since the first
                    // tab is this month's statement whatever its header block says.
                    if (accountMarker.Length > 0 &&
                        SheetNamesAnotherAccount(rows, sharedStrings, descriptionColumn.HeaderRow, accountMarker))
                    {
                        continue;
                    }

                    var amountColumn = FindAmountColumn(rows, sharedStrings, descriptionColumn.HeaderRow);

                    if (amountColumn == null)
                    {
                        continue; // no amount column to reconcile against
                    }

                    foundAmountColumn = true;
                    var sheetName = sheet.Name == null ? string.Empty : sheet.Name.Value;
                    var sheetTouched = false;
                    var valueDateColumn = FindValueDateColumn(rows, sharedStrings, descriptionColumn.HeaderRow);
                    var lastValueDateText = string.Empty;

                    foreach (var row in rows)
                    {
                        if (row.RowIndex != null && row.RowIndex.Value <= descriptionColumn.HeaderRow)
                        {
                            continue;
                        }

                        var descriptionCell = row.Elements<Cell>()
                            .FirstOrDefault(c => ColumnOf(c.CellReference) == descriptionColumn.Column);

                        var description = CellText(descriptionCell, sharedStrings);

                        if (string.IsNullOrWhiteSpace(description))
                        {
                            continue;
                        }

                        // The date as Excel itself shows it. `rows` comes from the
                        // sheet in document order, so simply overwriting on every
                        // real transaction row (deposit or withdrawal alike) leaves
                        // this holding whichever one is physically last once the
                        // loop ends.
                        if (valueDateColumn != null)
                        {
                            var valueDateCell = row.Elements<Cell>()
                                .FirstOrDefault(c => ColumnOf(c.CellReference) == valueDateColumn);

                            var valueDateText = ReadValueDateDisplayText(valueDateCell, sharedStrings);

                            if (valueDateText.Length > 0)
                            {
                                lastValueDateText = valueDateText;
                            }
                        }

                        var amountCell = row.Elements<Cell>()
                            .FirstOrDefault(c => ColumnOf(c.CellReference) == amountColumn);

                        decimal rowAmount;

                        if (!TryReadAmount(amountCell, sharedStrings, out rowAmount))
                        {
                            continue; // blank or non-numeric (e.g. the Withdrawal side)
                        }

                        foreach (var payment in wanted)
                        {
                            var instrument = payment.InstrumentNumber.Trim();

                            if (description.IndexOf(instrument, StringComparison.OrdinalIgnoreCase) < 0 ||
                                Math.Abs(rowAmount - payment.Amount) > AmountTolerance)
                            {
                                continue;
                            }

                            var result = results[instrument];

                            result.MatchCount++;
                            result.Matched = true;
                            result.DuplicateFound = result.MatchCount > 1;
                            result.SheetName = sheetName;
                            result.MatchedCells.Add(amountCell.CellReference == null
                                ? string.Empty
                                : amountCell.CellReference.Value);

                            if (result.MatchCount == 1)
                            {
                                result.StatementAmount = rowAmount;
                            }

                            amountCell.StyleIndex = yellowStyles.FilledVariantOf(amountCell.StyleIndex);
                            anythingHighlighted = true;
                            sheetTouched = true;
                        }
                    }

                    if (sheetTouched)
                    {
                        worksheetPart.Worksheet.Save();
                    }

                    // Sheet-level, not per-payment: every instrument this call was
                    // asked about was searched against this same sheet, so all of
                    // them learn which one and how current it is — matched or not,
                    // an Unmatch result still says where the search looked. Left
                    // alone for a result already matched here: it keeps the sheet
                    // its own match block set, rather than a later qualifying sheet
                    // (the workbook can have more than one) overwriting it.
                    foreach (var result in results.Values)
                    {
                        if (!result.Matched)
                        {
                            result.SheetName = sheetName;
                        }

                        if (lastValueDateText.Length > 0)
                        {
                            result.LastValueDate = lastValueDateText;
                        }
                    }
                }

                if (!foundAmountColumn)
                {
                    foreach (var result in results.Values)
                    {
                        result.Reason = $"No amount column ({string.Join(" / ", AmountHeaders)}) found in {Path.GetFileName(filePath)}.";
                    }
                }

                if (anythingHighlighted)
                {
                    yellowStyles.Save();
                    workbookPart.Workbook.Save();
                }
            }

            return results;
        }

        /// <summary>
        /// Column letters of the amount on the statement's header row, or null when
        /// none of the known amount headers is present.
        /// </summary>
        private static string FindAmountColumn(List<Row> rows, List<string> sharedStrings, uint headerRow)
        {
            var header = rows.FirstOrDefault(r => r.RowIndex != null && r.RowIndex.Value == headerRow);

            if (header == null)
            {
                return null;
            }

            foreach (var cell in header.Elements<Cell>())
            {
                var text = CellText(cell, sharedStrings).Trim();

                if (AmountHeaders.Any(h => string.Equals(h, text, StringComparison.OrdinalIgnoreCase)))
                {
                    return ColumnOf(cell.CellReference);
                }
            }

            return null;
        }

        /// <summary>Reads an amount cell. False for blanks and anything non-numeric.</summary>
        private static bool TryReadAmount(Cell cell, List<string> sharedStrings, out decimal amount)
        {
            amount = 0m;

            var text = CellText(cell, sharedStrings);

            return !string.IsNullOrWhiteSpace(text) &&
                   decimal.TryParse(text, NumberStyles.Any, CultureInfo.InvariantCulture, out amount);
        }

        /// <summary>
        /// Column letters of "Value Date" on the statement's header row, or null
        /// when the layout has no such column.
        /// </summary>
        private static string FindValueDateColumn(List<Row> rows, List<string> sharedStrings, uint headerRow)
        {
            var header = rows.FirstOrDefault(r => r.RowIndex != null && r.RowIndex.Value == headerRow);

            if (header == null)
            {
                return null;
            }

            foreach (var cell in header.Elements<Cell>())
            {
                var text = CellText(cell, sharedStrings).Trim();

                if (string.Equals(ValueDateHeader, text, StringComparison.OrdinalIgnoreCase))
                {
                    return ColumnOf(cell.CellReference);
                }
            }

            return null;
        }

        /// <summary>
        /// The date layouts a Value Date cell is written in when it holds text
        /// rather than a real date. ICICI's export writes "01/09/2026", and the
        /// posted-date column adds a time to it; Kotak's writes the day first too.
        /// All of them are day-first - never month-first - which is why the list is
        /// explicit rather than left to the culture's own parsing.
        /// </summary>
        private static readonly string[] ValueDateTextFormats =
        {
            "dd-MM-yyyy", "dd/MM/yyyy", "dd.MM.yyyy",
            "d-M-yyyy", "d/M/yyyy",
            "dd-MM-yy", "dd/MM/yy",
            "dd-MMM-yyyy", "dd/MMM/yyyy", "dd-MMM-yy",
            "yyyy-MM-dd",
            "dd-MM-yyyy HH:mm:ss", "dd/MM/yyyy HH:mm:ss",
            "dd-MM-yyyy hh:mm:ss tt", "dd/MM/yyyy hh:mm:ss tt",
            "dd-MM-yyyy HH:mm", "dd/MM/yyyy HH:mm"
        };

        /// <summary>
        /// Reads a statement date, whether it is an Excel serial number, one of the
        /// text layouts the exports use, or a date already written the way
        /// ReadValueDateDisplayText writes them.
        ///
        /// One parser for both sides: the note's date is produced here, and the
        /// comparison that decides which workbook the note names reads it back
        /// here, so a layout this understands can never be written and then fail to
        /// be read.
        /// </summary>
        public static bool TryParseStatementDate(string text, out DateTime date)
        {
            date = DateTime.MinValue;

            var value = (text ?? string.Empty).Trim();

            if (value.Length == 0)
            {
                return false;
            }

            double serial;

            // An OLE Automation serial ("46173") - what the SDK hands back for a
            // real date cell, since it does not apply number formatting for you.
            if (double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out serial))
            {
                try
                {
                    date = DateTime.FromOADate(serial);

                    return true;
                }
                catch (ArgumentException)
                {
                    // Out of the range a real date could ever fall in - not
                    // actually a serial date, so try it as text instead.
                }
            }

            return DateTime.TryParseExact(
                value, ValueDateTextFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out date);
        }

        /// <summary>
        /// A "Value Date" cell as dd-MM-yyyy - the reading a person looking at the
        /// sheet sees - whether the cell holds a real date, a serial number or the
        /// export's own text. Text that is no date at all is returned exactly as it
        /// reads, unparsed.
        ///
        /// Normalising here rather than passing the cell's text through is what
        /// lets the caller compare two workbooks' last records: ICICI writes
        /// "01/09/2026" and Kotak a serial, and a note carrying the raw text was
        /// treated as undated, so a workbook with rows lost to one with none.
        /// </summary>
        private static string ReadValueDateDisplayText(Cell cell, List<string> sharedStrings)
        {
            var text = CellText(cell, sharedStrings).Trim();

            if (text.Length == 0)
            {
                return string.Empty;
            }

            DateTime date;

            return TryParseStatementDate(text, out date)
                ? date.ToString("dd-MM-yyyy", CultureInfo.InvariantCulture)
                : text;
        }

        /// <summary>Parses an amount from the receipts data, e.g. "598000.0".</summary>
        public static bool TryParseAmount(string value, out decimal amount)
        {
            var cleaned = (value ?? string.Empty).Replace(",", string.Empty).Trim();

            return decimal.TryParse(cleaned, NumberStyles.Any, CultureInfo.InvariantCulture, out amount);
        }

        // ── Workbook plumbing ────────────────────────────────────────

        /// <summary>Where the Description column sits on one sheet.</summary>
        private class DescriptionColumn
        {
            public string Column;
            public uint HeaderRow;
        }

        /// <summary>
        /// Finds the header row by its "Description" label rather than a fixed row
        /// number, which is what lets one code path read both statement layouts.
        /// </summary>
        private static DescriptionColumn FindDescriptionColumn(List<Row> rows, List<string> sharedStrings)
        {
            foreach (var row in rows)
            {
                var rowIndex = row.RowIndex == null ? 0u : row.RowIndex.Value;

                if (rowIndex > HeaderSearchRowLimit)
                {
                    break;
                }

                foreach (var cell in row.Elements<Cell>())
                {
                    var text = CellText(cell, sharedStrings);

                    if (string.Equals(text.Trim(), DescriptionHeader, StringComparison.OrdinalIgnoreCase))
                    {
                        return new DescriptionColumn
                        {
                            Column = ColumnOf(cell.CellReference),
                            HeaderRow = rowIndex
                        };
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// Shared with SpreadsheetPreview, which reads the same workbooks for a
        /// different reason — showing them to the reviewer rather than searching
        /// them. Internal rather than private so there is one implementation of
        /// "what does this cell say", not two that can drift.
        /// </summary>
        internal static List<string> ReadSharedStrings(WorkbookPart workbookPart)
        {
            var part = workbookPart.SharedStringTablePart;

            return part == null
                ? new List<string>()
                : part.SharedStringTable.Elements<SharedStringItem>().Select(item => item.InnerText).ToList();
        }

        /// <summary>Shared with SpreadsheetPreview — see ReadSharedStrings.</summary>
        internal static string CellText(Cell cell, List<string> sharedStrings)
        {
            if (cell == null)
            {
                return string.Empty;
            }

            if (cell.DataType != null && cell.DataType.Value == CellValues.SharedString)
            {
                int index;

                if (cell.CellValue != null && int.TryParse(cell.CellValue.Text, out index) &&
                    index >= 0 && index < sharedStrings.Count)
                {
                    return sharedStrings[index];
                }

                return string.Empty;
            }

            if (cell.InlineString != null)
            {
                return cell.InlineString.InnerText;
            }

            return cell.CellValue == null ? string.Empty : cell.CellValue.Text;
        }

        /// <summary>Column letters of a cell reference, e.g. "F377" → "F".</summary>
        /// <summary>Shared with SpreadsheetPreview — see ReadSharedStrings.</summary>
        internal static string ColumnOf(StringValue cellReference)
        {
            if (cellReference == null || string.IsNullOrEmpty(cellReference.Value))
            {
                return string.Empty;
            }

            return new string(cellReference.Value.TakeWhile(char.IsLetter).ToArray());
        }

        /// <summary>
        /// Hands out "same formatting, but green" style indexes.
        ///
        /// A matched cell must keep its own borders/number format, so the green fill
        /// cannot be one shared style: each distinct source style gets its own green
        /// clone, created once and reused.
        /// </summary>
        private class FillStyleCache
        {
            private readonly WorkbookStylesPart stylesPart;
            private readonly Dictionary<uint, uint> greenBySource = new Dictionary<uint, uint>();
            private readonly string fillColor;
            private uint greenFillId;
            private bool dirty;

            public FillStyleCache(WorkbookPart workbookPart, string fillColor)
            {
                this.fillColor = fillColor;

                stylesPart = workbookPart.WorkbookStylesPart ??
                             workbookPart.AddNewPart<WorkbookStylesPart>();

                if (stylesPart.Stylesheet == null)
                {
                    stylesPart.Stylesheet = new Stylesheet();
                }

                EnsureFill();
            }

            private void EnsureFill()
            {
                var stylesheet = stylesPart.Stylesheet;

                if (stylesheet.Fills == null)
                {
                    stylesheet.Fills = new Fills(
                        new Fill(new PatternFill { PatternType = PatternValues.None }),
                        new Fill(new PatternFill { PatternType = PatternValues.Gray125 }));
                    stylesheet.Fills.Count = 2;
                    dirty = true;
                }

                // Reuse the green fill if a previous run already added it.
                var existing = stylesheet.Fills.Elements<Fill>()
                    .Select((fill, index) => new { fill, index })
                    .FirstOrDefault(entry =>
                        entry.fill.PatternFill != null &&
                        entry.fill.PatternFill.ForegroundColor != null &&
                        entry.fill.PatternFill.ForegroundColor.Rgb != null &&
                        entry.fill.PatternFill.ForegroundColor.Rgb.Value == fillColor);

                if (existing != null)
                {
                    greenFillId = (uint)existing.index;
                    return;
                }

                stylesheet.Fills.Append(new Fill(new PatternFill
                {
                    PatternType = PatternValues.Solid,
                    ForegroundColor = new ForegroundColor { Rgb = fillColor },
                    BackgroundColor = new BackgroundColor { Indexed = 64U }
                }));

                greenFillId = (uint)(stylesheet.Fills.Count() - 1);
                stylesheet.Fills.Count = (uint)stylesheet.Fills.Count();
                dirty = true;
            }

            /// <summary>The green counterpart of a cell's current style index.</summary>
            public uint FilledVariantOf(UInt32Value sourceStyleIndex)
            {
                var source = sourceStyleIndex == null ? 0u : sourceStyleIndex.Value;

                uint cached;
                if (greenBySource.TryGetValue(source, out cached))
                {
                    return cached;
                }

                var stylesheet = stylesPart.Stylesheet;

                if (stylesheet.CellFormats == null)
                {
                    stylesheet.CellFormats = new CellFormats(new CellFormat());
                    stylesheet.CellFormats.Count = 1;
                }

                var formats = stylesheet.CellFormats.Elements<CellFormat>().ToList();
                var template = source < formats.Count ? formats[(int)source] : formats.FirstOrDefault();

                var green = template == null
                    ? new CellFormat()
                    : (CellFormat)template.CloneNode(true);

                green.FillId = greenFillId;
                green.ApplyFill = true;

                stylesheet.CellFormats.Append(green);
                var newIndex = (uint)(stylesheet.CellFormats.Count() - 1);
                stylesheet.CellFormats.Count = (uint)stylesheet.CellFormats.Count();

                greenBySource[source] = newIndex;
                dirty = true;

                return newIndex;
            }

            public void Save()
            {
                if (dirty)
                {
                    stylesPart.Stylesheet.Save();
                }
            }
        }
    }
}
