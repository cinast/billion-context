/** #4313: UTC wall-clock rendering for ref tags and summary footers.
 *  Minute precision, ISO-like "YYYY-MM-DD HH:mm" — human-readable beats
 *  epoch seconds for the model (no arithmetic to misread) at negligible
 *  token cost. */
export function formatUtcMinute(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}
