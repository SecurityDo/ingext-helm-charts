/**
 * Show general help or command-specific help
 */
export function showHelp(command?: string) {
  if (!command) {
    showGeneralHelp();
    return;
  }

  const helpText = getCommandHelp(command);
  if (!helpText) {
    console.error(`Unknown command: ${command}`);
    console.error("Run 'lakehouse help' to see all commands");
    process.exit(1);
    return; // TypeScript needs this for type narrowing
  }

  console.error(helpText.trim());
}

/**
 * Show general help listing all commands
 */
function showGeneralHelp() {
  console.error("Ingext Lakehouse CLI");
  console.error("=".repeat(60));
  console.error("");
  console.error("Usage:");
  console.error("  lakehouse [command] [options]");
  console.error("");
  console.error("Commands:");
  console.error("  (no command)    Interactive menu");
  console.error("  help [cmd]      Show help for command");
  console.error("  preflight       Validate AWS access and gather config");
  console.error("  install         Start or continue installation");
  console.error("  status          Show current lakehouse status");
  console.error("  diagnose        AI-powered diagnostics (coming soon)");
  console.error("  logs [comp]     View component logs");
  console.error("  cleanup         Tear down lakehouse resources");
  console.error("");
  console.error("Examples:");
  console.error("  lakehouse                 # Interactive menu");
  console.error("  lakehouse status          # Quick status check");
  console.error("  lakehouse help install    # Detailed help for install");
  console.error("");
  console.error("For detailed help on a command: lakehouse help <command>");
}

/**
 * Get help text for a specific command
 */
function getCommandHelp(command: string): string | null {
  const helpTexts: Record<string, string> = {
    preflight: `
lakehouse preflight - Validate prerequisites and gather configuration

Description:
  Validates AWS access, checks for existing resources (EKS cluster, S3 bucket),
  and creates a lakehouse_<namespace>.env file with your configuration.
  
  This is typically the first command you run.

Options:
  --namespace <name>    Namespace for k8s resources (default: ingext)
  --cluster <name>      EKS cluster name (default: ingext-lakehouse)
  --region <region>     AWS region (default: us-east-2)
  --root-domain <dom>   Your root domain (e.g., example.com)
  --approve             Auto-approve without prompts

Example:
  lakehouse preflight --root-domain example.com --approve
`,
    install: `
lakehouse install - Start or continue installation

Description:
  Intelligently continues installation from the current phase.
  Detects which phases are complete and resumes from where you left off.
  
  Installation phases:
    1. Foundation (EKS cluster)
    2. Storage (S3 + IAM)
    3. Compute (Karpenter autoscaling)
    4. Core Services (Redis, OpenSearch, etcd)
    5. Stream (API, Platform services)
    6. Datalake (Lake manager, workers)
    7. Ingress (ALB + TLS)

Options:
  --namespace <name>    Which lakehouse to install (if multiple)
  --force               Continue even if health checks fail
  --approve             Auto-approve without prompts

Example:
  lakehouse install
`,
    status: `
lakehouse status - Show current lakehouse status

Description:
  Displays detailed status of all lakehouse components:
    - EKS cluster health
    - S3 bucket
    - Kubernetes deployments and pods
    - Ingress/ALB status
    - DNS configuration
    - TLS certificate

Options:
  --namespace <name>    Which lakehouse to check (if multiple)
  --json                Output raw JSON

Example:
  lakehouse status
`,
    diagnose: `
lakehouse diagnose - AI-powered diagnostics (coming soon)

Description:
  Analyzes lakehouse health and provides intelligent recommendations.
  Uses AI to interpret logs, identify issues, and suggest remediation.

Example:
  lakehouse diagnose
`,
    logs: `
lakehouse logs [component] - View component logs

Description:
  View logs from lakehouse components. If no component is specified,
  shows logs from all components.

Components:
  api, platform, fluency, lake-mgr, lake-worker, search, redis, etcd

Example:
  lakehouse logs api
  lakehouse logs           # All components
`,
    cleanup: `
lakehouse cleanup - Tear down lakehouse resources

Description:
  Safely removes all lakehouse resources:
    - Deletes EKS cluster
    - Removes S3 bucket (optional)
    - Cleans up IAM roles and policies
    - Removes Helm releases

  WARNING: This is destructive and cannot be undone.

Options:
  --namespace <name>    Which lakehouse to clean up
  --approve             Skip confirmation prompt
  --keep-bucket         Don't delete S3 bucket

Example:
  lakehouse cleanup
`
  };

  return helpTexts[command] || null;
}
