/**
 * Simple spinner utility for showing process activity.
 * Only use in-place updates when stderr is a TTY; otherwise skip spinner to avoid appended output.
 */

const SPINNER_LINE_WIDTH = 80;
const SPINNER_PREFIX_MAX_LEN = 60;

let spinnerInterval: NodeJS.Timeout | null = null;
let spinnerFrame = 0;
const spinnerFrames = ["|", "/", "-", "\\"];

/**
 * Start a spinner on stderr. No-op if stderr is not a TTY.
 */
export function startSpinner(message?: string): void {
  if (typeof process.stderr.isTTY !== "boolean" || !process.stderr.isTTY) {
    return;
  }
  if (spinnerInterval) {
    stopSpinner();
  }
  
  spinnerFrame = 0;
  let prefix = message ? `${message} ` : "";
  if (prefix.length > SPINNER_PREFIX_MAX_LEN) {
    prefix = prefix.slice(0, SPINNER_PREFIX_MAX_LEN - 2) + ".. ";
  }
  
  spinnerInterval = setInterval(() => {
    const frame = spinnerFrames[spinnerFrame];
    const line = `${prefix}${frame}`;
    const padded = line.padEnd(SPINNER_LINE_WIDTH);
    process.stderr.write(`\r${padded}\r`);
    spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
  }, 100);
}

/**
 * Stop the spinner and clear the line
 */
export function stopSpinner(): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    if (typeof process.stderr.isTTY === "boolean" && process.stderr.isTTY) {
      process.stderr.write("\r" + " ".repeat(SPINNER_LINE_WIDTH) + "\r");
    }
  }
}

/**
 * Show a completed message (replaces spinner)
 */
export function showComplete(message: string): void {
  stopSpinner();
  process.stderr.write(`\r✓ ${message}\n`);
}

/**
 * Show an error message (replaces spinner)
 */
export function showError(message: string): void {
  stopSpinner();
  process.stderr.write(`\r✗ ${message}\n`);
}
