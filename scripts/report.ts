/**
 * Terminal output shared by the scripts. Every one of them is something a
 * person watches for a minute or two, so they all want the same things:
 * colour that degrades when piped, and a progress line with a real ETA.
 */

export const color = process.stdout.isTTY
  ? {
      green: (s: string) => `\x1b[32m${s}\x1b[0m`,
      red: (s: string) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    }
  : {
      green: (s: string) => s,
      red: (s: string) => s,
      yellow: (s: string) => s,
      dim: (s: string) => s,
      bold: (s: string) => s,
    };

/** A single-line progress reporter that degrades to periodic lines when piped. */
export function progressReporter(task: string, total: number) {
  const start = Date.now();
  let lastPrint = 0;

  return (done: number) => {
    const finished = done >= total;
    const now = Date.now();
    if (!finished && now - lastPrint < 250) return;
    lastPrint = now;

    const elapsed = (now - start) / 1000;
    const rate = done / Math.max(elapsed, 0.001);
    const eta = rate > 0 ? (total - done) / rate : 0;
    const line = `  ${task}: ${done}/${total} · ${rate.toFixed(1)}/s · eta ${formatDuration(eta)}`;

    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line.padEnd(78)}${finished ? "\n" : ""}`);
    } else if (finished || done % 500 === 0) {
      process.stdout.write(`${line}\n`);
    }
  };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
