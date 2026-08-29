---
name: xlsx
description: Create, read, and edit Excel .xlsx spreadsheets and CSV files
version: 1.0.0
invocation: both
allowed-tools: read_file write_file edit_file run_command find_files list_directory
tags:
  - spreadsheets
  - data
  - office
---

# Excel Spreadsheets (xlsx)

Create, read, edit, and analyze Excel .xlsx workbooks and CSV files.

## Instructions

1. Check that the `openpyxl` library is available: run `python -c "import openpyxl"`. If it fails, install it with `pip install openpyxl` (requires user approval) and tell the user if installation is not possible.
2. Determine the task:
   - **Create**: a new workbook from provided data or a description.
   - **Read/Analyze**: summarize contents, compute totals, or answer questions about the data.
   - **Edit**: modify an existing workbook.
3. For new workbooks, apply proper types and formatting: real numbers (not text) for numeric columns, ISO or locale-consistent date formats, bold header rows, sensible column widths, and freeze the header row. Use real Excel formulas (e.g. `=SUM(B2:B10)`) rather than precomputed values when the user may edit the data later.
4. When reading values from a workbook that contains formulas, load with `data_only=True` to get cached results; when editing, load without it so formulas are preserved. Never open a file for editing with `data_only=True`.
5. To add a chart, use openpyxl's chart module (Bar, Line, Pie) anchored next to the data. Keep charts simple and labeled.
6. Never overwrite the original file when producing a modified copy — write to a new file (e.g. `budget-updated.xlsx`) unless the user explicitly asks to modify in place.
7. After writing, verify by reloading the file and reporting: sheet names, used ranges (rows x columns), and a short sample of the data so the user can confirm it looks right.
8. For messy CSV or Excel data needing cleanup (deduplication, type fixing), the data-clean skill may be a better fit.
