/**
 * Simple spinner utility for showing process activity
 */
let spinnerInterval = null;
let spinnerFrame = 0;
const spinnerFrames = ["|", "/", "-", "\\"];
/**
 * Start a spinner on stderr
 */
export function startSpinner(message) {
    if (spinnerInterval) {
        stopSpinner();
    }
    spinnerFrame = 0;
    const prefix = message ? `${message} ` : "";
    spinnerInterval = setInterval(() => {
        process.stderr.write(`\r${prefix}${spinnerFrames[spinnerFrame]} `);
        spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
    }, 100);
}
/**
 * Stop the spinner and clear the line
 */
export function stopSpinner() {
    if (spinnerInterval) {
        clearInterval(spinnerInterval);
        spinnerInterval = null;
        // Clear the spinner line
        process.stderr.write("\r" + " ".repeat(80) + "\r");
    }
}
/**
 * Show a completed message (replaces spinner)
 */
export function showComplete(message) {
    stopSpinner();
    process.stderr.write(`\r✓ ${message}\n`);
}
/**
 * Show an error message (replaces spinner)
 */
export function showError(message) {
    stopSpinner();
    process.stderr.write(`\r✗ ${message}\n`);
}
