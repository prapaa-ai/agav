---
name: data-clean
description: Clean up and analyze CSV/Excel data for non-analysts
version: 1.0.0
invocation: both
allowed-tools: read_file write_file run_command find_files list_directory
tags:
  - data
  - spreadsheets
---

# Data Clean

Clean up messy CSV/Excel data and answer simple questions about it, explained in plain language.

## Instructions

1. Read the file first (head and tail, row/column counts) and describe what you found before changing anything: column names, apparent types, row count, and obvious problems.
2. Detect and report data problems:
   - **Types stored as text**: numbers with currency symbols or thousands separators, inconsistent date formats.
   - **Inconsistent categories**: "USA" vs "United States", trailing whitespace, case mismatches.
   - **Missing values**: count them per column and show where they cluster.
   - **Duplicates**: exact-duplicate rows and suspicious near-duplicates.
   - **Structural issues**: merged cells, multi-row headers, totals embedded in the data.
3. Propose the cleanup plan and get approval: one bullet per transformation, in the order applied. Typical fixes — parse types, normalize categories to one spelling, trim whitespace, ISO-format dates, mark (not drop) missing values, flag duplicates.
4. Apply transformations with Python (csv module or openpyxl/pandas if available). Work on a copy: write the cleaned data to a new file (`-cleaned` suffix), never over the original.
5. After cleaning, produce a before/after summary: rows in/out, values changed per fix, columns added or renamed.
6. For questions ("which month had the highest sales?"), answer in one plain sentence, then show the small supporting table or aggregate behind it. State the denominator and any filtering you applied ("excluding 12 rows with no date").
7. Flag anything the data cannot answer honestly. Correlation is not causation; say so when the user asks "why".
