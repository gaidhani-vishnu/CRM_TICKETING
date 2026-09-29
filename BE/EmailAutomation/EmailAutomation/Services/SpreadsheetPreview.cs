using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;

namespace EmailAutomation.Services
{
    /// <summary>
    /// Reads a spreadsheet attachment into rows of text, so the Attachments popup
    /// can show it in place.
    ///
    /// The browser renders images, PDFs and plain text on its own; a workbook it
    /// can only download. That left the reviewer opening a tranche sheet in Excel
    /// to read four numbers, and losing the thread it belonged to on the way.
    ///
    /// Deliberately text, not formatting: this is a reading of the file, not a
    /// rendering of it. Formulas come back as their last calculated value, which
    /// is what the sheet was showing when it was saved.
    /// </summary>
    public static class SpreadsheetPreview
    {
        /// <summary>Extensions this can read. .xls is the old binary format, which Open XML cannot open.</summary>
        private static readonly string[] ReadableExtensions = { "csv", "xlsx", "xlsm" };

        /// <summary>Rows returned at most — a statement can run to thousands.</summary>
        public const int MaxRows = 300;

        /// <summary>Columns returned at most.</summary>
        public const int MaxColumns = 40;

        public static bool CanRead(string extension)
        {
            return ReadableExtensions.Contains((extension ?? string.Empty).ToLowerInvariant());
        }

        /// <summary>What one sheet holds, as far down as MaxRows.</summary>
        public class SheetContent
        {
            /// <summary>Every sheet in the workbook, so the popup can offer tabs. One entry for a CSV.</summary>
            public List<string> SheetNames { get; set; }

            /// <summary>The sheet actually read.</summary>
            public string SheetName { get; set; }

            /// <summary>Rows of cell text, each padded to the width of the widest.</summary>
            public List<List<string>> Rows { get; set; }

            /// <summary>True when the sheet holds more rows than were returned.</summary>
            public bool Truncated { get; set; }

            public SheetContent()
            {
                SheetNames = new List<string>();
                Rows = new List<List<string>>();
                SheetName = string.Empty;
            }
        }

        /// <summary>
        /// Reads <paramref name="sheetName"/> from the file, or its first sheet
        /// when none is named.
        /// </summary>
        public static SheetContent Read(string filePath, string extension, string sheetName)
        {
            return (extension ?? string.Empty).ToLowerInvariant() == "csv"
                ? ReadCsv(filePath)
                : ReadWorkbook(filePath, sheetName);
        }

        /// <summary>
        /// A CSV, split on commas with quoted fields honoured — a narration
        /// carrying a comma is one cell, not two.
        /// </summary>
        private static SheetContent ReadCsv(string filePath)
        {
            var content = new SheetContent { SheetName = "Sheet1" };
            content.SheetNames.Add("Sheet1");

            using (var reader = new StreamReader(filePath, Encoding.UTF8, true))
            {
                string line;

                while ((line = reader.ReadLine()) != null)
                {
                    if (content.Rows.Count >= MaxRows)
                    {
                        content.Truncated = true;
                        break;
                    }

                    content.Rows.Add(SplitCsvLine(line));
                }
            }

            Square(content.Rows);

            return content;
        }

        private static List<string> SplitCsvLine(string line)
        {
            var cells = new List<string>();
            var cell = new StringBuilder();
            var inQuotes = false;

            for (var i = 0; i < line.Length && cells.Count < MaxColumns; i++)
            {
                var character = line[i];

                if (character == '"')
                {
                    // A doubled quote inside a quoted field is one literal quote.
                    if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        cell.Append('"');
                        i++;
                    }
                    else
                    {
                        inQuotes = !inQuotes;
                    }

                    continue;
                }

                if (character == ',' && !inQuotes)
                {
                    cells.Add(cell.ToString().Trim());
                    cell.Clear();
                    continue;
                }

                cell.Append(character);
            }

            if (cells.Count < MaxColumns)
            {
                cells.Add(cell.ToString().Trim());
            }

            return cells;
        }

        /// <summary>
        /// One sheet of an .xlsx / .xlsm workbook.
        ///
        /// Cells are placed by their own column letter rather than by the order
        /// they appear in: Excel omits empty cells entirely, so reading them in
        /// sequence would shift every value after a gap one column to the left.
        /// </summary>
        private static SheetContent ReadWorkbook(string filePath, string sheetName)
        {
            var content = new SheetContent();

            using (var document = SpreadsheetDocument.Open(filePath, false))
            {
                var workbookPart = document.WorkbookPart;

                if (workbookPart == null)
                {
                    return content;
                }

                var sheets = workbookPart.Workbook.Descendants<Sheet>().ToList();
                content.SheetNames = sheets.Select(s => (s.Name == null ? string.Empty : s.Name.Value)).ToList();

                var wanted = string.IsNullOrWhiteSpace(sheetName)
                    ? sheets.FirstOrDefault()
                    : sheets.FirstOrDefault(s => s.Name != null &&
                          string.Equals(s.Name.Value, sheetName, StringComparison.OrdinalIgnoreCase))
                      ?? sheets.FirstOrDefault();

                if (wanted == null)
                {
                    return content;
                }

                content.SheetName = wanted.Name == null ? string.Empty : wanted.Name.Value;

                var worksheetPart = workbookPart.GetPartById(wanted.Id) as WorksheetPart;

                if (worksheetPart == null)
                {
                    return content;
                }

                var sharedStrings = BankStatementMatcher.ReadSharedStrings(workbookPart);

                foreach (var row in worksheetPart.Worksheet.Descendants<Row>())
                {
                    if (content.Rows.Count >= MaxRows)
                    {
                        content.Truncated = true;
                        break;
                    }

                    var cells = new List<string>();

                    foreach (var cell in row.Elements<Cell>())
                    {
                        var index = ColumnIndex(BankStatementMatcher.ColumnOf(cell.CellReference));

                        if (index < 0 || index >= MaxColumns)
                        {
                            continue;
                        }

                        while (cells.Count <= index)
                        {
                            cells.Add(string.Empty);
                        }

                        cells[index] = BankStatementMatcher.CellText(cell, sharedStrings);
                    }

                    content.Rows.Add(cells);
                }
            }

            Square(content.Rows);

            return content;
        }

        /// <summary>"A" → 0, "B" → 1, "AA" → 26. -1 when the reference is unusable.</summary>
        private static int ColumnIndex(string columnLetters)
        {
            if (string.IsNullOrEmpty(columnLetters))
            {
                return -1;
            }

            var index = 0;

            foreach (var letter in columnLetters.ToUpperInvariant())
            {
                if (letter < 'A' || letter > 'Z')
                {
                    return -1;
                }

                index = index * 26 + (letter - 'A' + 1);
            }

            return index - 1;
        }

        /// <summary>
        /// Pads every row to the width of the widest, and drops the trailing
        /// columns nothing uses — a sheet whose cells stop at D should not be
        /// drawn with forty empty columns after it.
        /// </summary>
        private static void Square(List<List<string>> rows)
        {
            var width = 0;

            foreach (var row in rows)
            {
                var used = row.FindLastIndex(cell => !string.IsNullOrWhiteSpace(cell)) + 1;

                if (used > width)
                {
                    width = used;
                }
            }

            for (var i = 0; i < rows.Count; i++)
            {
                var row = rows[i];

                if (row.Count > width)
                {
                    row.RemoveRange(width, row.Count - width);
                }

                while (row.Count < width)
                {
                    row.Add(string.Empty);
                }
            }
        }
    }
}
