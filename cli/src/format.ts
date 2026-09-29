/** A plain-text table: columns padded to their widest cell, no colour, safe to pipe. */
export function table(rows: Array<Record<string, string>>, columns: Array<{ key: string; title: string }>): string {
  if (rows.length === 0) return '';
  const widths = columns.map((c) => Math.max(c.title.length, ...rows.map((r) => (r[c.key] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(columns.map((c) => c.title.toUpperCase())), ...rows.map((r) => line(columns.map((c) => r[c.key] ?? '')))].join('\n') + '\n';
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(s)) return '-';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
