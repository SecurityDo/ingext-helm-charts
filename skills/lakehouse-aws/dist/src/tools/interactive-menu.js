import { inferState, formatStateDescription } from "./state-inference.js";
import { createInterface } from "node:readline";
/**
 * Show interactive menu for lakehouse operations
 */
export async function showInteractiveMenu(env, namespace) {
    const state = await inferState(env);
    console.error("=".repeat(60));
    console.error("Ingext Lakehouse (AWS)");
    console.error("=".repeat(60));
    console.error("");
    console.error(`Config: lakehouse_${namespace}.env`);
    console.error(`Cluster: ${env.CLUSTER_NAME}`);
    console.error(`Region: ${env.AWS_REGION}`);
    console.error("");
    // Show current state
    console.error("Current Status:");
    console.error(`  ${formatStateDescription(state.state)}`);
    // Show evidence summary
    if (state.evidence.clusterExists) {
        console.error(`  Cluster: ${state.evidence.clusterStatus}`);
        if (state.evidence.helmReleases.length > 0) {
            console.error(`  Releases: ${state.evidence.helmReleases.length} deployed`);
        }
        if (state.evidence.podsTotal > 0) {
            console.error(`  Pods: ${state.evidence.podsReady}/${state.evidence.podsTotal} ready`);
        }
    }
    console.error("");
    // Show recommendation
    console.error("Recommended Action:");
    console.error(`  ${state.recommendation.action}: ${state.recommendation.reason}`);
    console.error(`  Command: ${state.recommendation.command}`);
    console.error("");
    // Show menu
    console.error("Available Actions:");
    console.error("  1) Install (continue from current phase)");
    console.error("  2) Status (detailed view)");
    console.error("  3) Diagnose (AI-powered diagnostics)");
    console.error("  4) Logs (view component logs)");
    console.error("  5) Skills (list all skills and what they do)");
    console.error("  6) Cleanup (tear down)");
    console.error("  q) Quit");
    console.error("");
    const choice = await prompt("Select action [1]: ");
    return choice || "1";
}
/**
 * Prompt user for input using readline
 */
export async function prompt(message) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr
    });
    return new Promise((resolve) => {
        rl.question(message, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
/**
 * Prompt user to select from multiple env files
 */
export async function selectEnvPrompt(namespaces) {
    console.error("\nMultiple lakehouse configurations found:");
    console.error("");
    namespaces.forEach((ns, idx) => {
        console.error(`  ${idx + 1}) ${ns}`);
    });
    console.error("");
    const choice = await prompt(`Select configuration [1]: `);
    const index = parseInt(choice || "1", 10) - 1;
    if (index >= 0 && index < namespaces.length) {
        return namespaces[index];
    }
    // Default to first
    return namespaces[0];
}
/**
 * Show first-time setup guidance
 */
export async function showFirstTimeSetup() {
    console.error("=".repeat(60));
    console.error("Welcome to Ingext Lakehouse (AWS)");
    console.error("=".repeat(60));
    console.error("");
    console.error("No lakehouse configuration found.");
    console.error("");
    console.error("This appears to be your first time setting up a lakehouse.");
    console.error("");
    console.error("Next step: Preflight");
    console.error("  Preflight will gather your AWS/cluster config and validate");
    console.error("  prerequisites before installation.");
    console.error("");
    const choice = await prompt("Run preflight now? [Y/n] ");
    return choice.toLowerCase() !== "n";
}
