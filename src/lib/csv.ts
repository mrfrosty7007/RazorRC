/**
 * CSV writing for the audit export.
 *
 * Kept out of the page so the escaping rules can be tested on their own: an
 * export is the one artefact from this app that leaves it, and a merchant may
 * hand it to an auditor or open it in Excel.
 */

/**
 * RFC 4180 quoting, plus a guard against spreadsheet formula injection.
 *
 * Audit summaries carry customer names and raw gateway text, so they contain
 * commas, quotation marks and newlines. A value that starts with `=`, `+`, `-`
 * or `@` would be evaluated as a formula on open, so it gets a leading tab —
 * the cell still reads correctly and is forced to be treated as text.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return /["',\n\r\t]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** CRLF line endings, which is what RFC 4180 specifies and Excel expects. */
export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
