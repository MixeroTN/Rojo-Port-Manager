const MAX_SUMMARY = 400;

/** Removes ANSI color codes (an old Rojo, or a tool manager, may print them even with NO_COLOR). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * A short reason from the output of a Rojo server that stopped: the first line that reports an error, with the lines
 * that continue it, else the last lines. Long text is cut.
 */
export function summarizeLog(text: string): string {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const first = lines.findIndex((line) => /\berror\b/i.test(line));
  const picked = first === -1 ? lines.slice(-3) : lines.slice(first, first + 3);
  const summary = picked
    .map((line) => line.replace(/^\[ERROR[^\]]*\]\s*/i, '').replace(/^error:\s*/i, ''))
    .join(' ')
    .trim();

  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
}
