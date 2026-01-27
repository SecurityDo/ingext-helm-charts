/**
 * Show general help or command-specific help
 */
export function showHelp(command) {
    if (!command) {
        showGeneralHelp();
        return;
    }
    // Handle "skills" as a special command
    if (command === "skills") {
        showSkills();
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
    console.error("  skills          List all skills and what they do");
    console.error("  preflight       Validate AWS access and gather config");
    console.error("  install         Start or continue installation");
    console.error("  status          Show current lakehouse status");
    console.error("  diagnose        AI-powered diagnostics (coming soon)");
    console.error("  logs [comp]     View component logs");
    console.error("  cleanup         Tear down lakehouse resources");
    console.error("");
    console.error("Examples:");
    console.error("  lakehouse                 # Interactive menu");
    console.error("  lakehouse skills          # List all skills");
    console.error("  lakehouse status         # Quick status check");
    console.error("  lakehouse help install   # Detailed help for install");
    console.error("");
    console.error("For detailed help on a command: lakehouse help <command>");
}
/**
 * Get help text for a specific command
 */
function getCommandHelp(command) {
    const helpTexts = {
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
`,
        skills: `
lakehouse skills - List all skills and what they do

Description:
  Displays all available lakehouse CLI skills/commands with detailed
  descriptions of what each one does. This is useful for understanding
  the capabilities of the lakehouse CLI.

Example:
  lakehouse skills
`
    };
    return helpTexts[command] || null;
}
/**
 * Show all available processes and AI skills
 */
export function showSkills() {
    console.error("Ingext Lakehouse CLI - Processes & AI Skills");
    console.error("=".repeat(60));
    console.error("");
    const processes = [
        {
            name: "preflight",
            description: "Validate AWS access and gather configuration",
            whatItDoes: "Checks AWS credentials, discovers existing resources (EKS cluster, S3 bucket, Route53 zones, ACM certificates), validates prerequisites, and creates a lakehouse_<namespace>.env configuration file. This is the first step before installation.",
            aiSkills: [
                {
                    name: "lakehouse-preflight",
                    description: "The AI can invoke this skill to validate prerequisites and create configuration. Used when user needs to set up or verify their AWS environment before installation."
                }
            ]
        },
        {
            name: "install",
            description: "Start or continue installation",
            whatItDoes: "Intelligently installs or continues installation from the current phase. Automatically detects which phases are complete (Foundation, Storage, Compute, Core Services, Stream, Datalake, Ingress) and resumes from where you left off. Safe to run multiple times.",
            aiSkills: [
                {
                    name: "lakehouse-install",
                    description: "The AI can invoke this skill to install or continue installation. Used when user wants to deploy, install, or continue a deployment."
                },
                {
                    name: "get-alb-address",
                    description: "Retrieves the AWS Application Load Balancer DNS address from Kubernetes ingress. Used during Phase 7 (Ingress) to get the ALB hostname for DNS configuration."
                },
                {
                    name: "configure-dns",
                    description: "Configures Route53 DNS records to point the lakehouse domain to the ALB. Automatically creates or updates DNS A records (alias) after ALB is provisioned in Phase 7."
                }
            ]
        },
        {
            name: "status",
            description: "Show current lakehouse status",
            whatItDoes: "Displays comprehensive status of all lakehouse components including EKS cluster health, S3 bucket status, Kubernetes deployments and pods, ingress/ALB configuration, DNS setup, and TLS certificate status. Provides a complete health overview.",
            aiSkills: [
                {
                    name: "lakehouse-status",
                    description: "The AI can invoke this skill to check lakehouse health and component status. Used when user wants to verify deployment, check health, or see what's running."
                },
                {
                    name: "get-alb-address",
                    description: "Retrieves the ALB DNS address from ingress to display in status output. Shows the load balancer hostname when ingress is installed."
                }
            ]
        },
        {
            name: "diagnose",
            description: "AI-powered diagnostics (coming soon)",
            whatItDoes: "Analyzes lakehouse health using AI to interpret logs, identify issues, and provide intelligent remediation recommendations. Will automatically detect problems and suggest fixes.",
            aiSkills: [
                {
                    name: "lakehouse-diagnose",
                    description: "The AI can invoke this skill to analyze issues and provide recommendations. Used when user reports problems, errors, or needs troubleshooting help."
                },
                {
                    name: "lakehouse-status",
                    description: "Gets current state before diagnosing issues."
                },
                {
                    name: "lakehouse-logs",
                    description: "Retrieves component logs for error analysis."
                },
                {
                    name: "get-alb-address",
                    description: "Retrieves ALB address to verify ingress configuration and diagnose networking issues."
                },
                {
                    name: "configure-dns",
                    description: "Can automatically configure DNS if ALB is ready but DNS is not set up, resolving DNS_PENDING state issues."
                }
            ]
        },
        {
            name: "logs",
            description: "View component logs",
            whatItDoes: "Streams logs from lakehouse components (API, Platform, Fluency, Lake Manager, Lake Worker, Search, Redis, etcd). Can view logs from a specific component or all components simultaneously for troubleshooting.",
            aiSkills: [
                {
                    name: "lakehouse-logs",
                    description: "The AI can invoke this skill to view component logs for debugging. Used when user needs to see logs, debug issues, or check component output."
                }
            ]
        },
        {
            name: "cleanup",
            description: "Tear down lakehouse resources",
            whatItDoes: "Safely removes all lakehouse resources including EKS cluster, S3 bucket (optional), IAM roles and policies, and Helm releases. Provides confirmation prompts to prevent accidental deletion. WARNING: This is destructive and cannot be undone.",
            aiSkills: [
                {
                    name: "lakehouse-cleanup",
                    description: "The AI can invoke this skill to remove lakehouse resources. Used when user wants to delete, remove, or clean up the deployment. WARNING: Destructive operation."
                }
            ]
        }
    ];
    processes.forEach((process, index) => {
        console.error(`${index + 1}. ${process.name.toUpperCase()} - Process`);
        console.error(`   ${process.description}`);
        console.error("");
        console.error(`   What it does:`);
        console.error(`   ${process.whatItDoes}`);
        console.error("");
        if (process.aiSkills.length > 0) {
            console.error(`   AI Skills available in this process:`);
            process.aiSkills.forEach((skill, skillIndex) => {
                console.error(`   ${String.fromCharCode(97 + skillIndex)}) ${skill.name}`);
                console.error(`      ${skill.description}`);
            });
            console.error("");
        }
        else {
            console.error(`   AI Skills: None (this process does not use AI skills)`);
            console.error("");
        }
        if (index < processes.length - 1) {
            console.error("-".repeat(60));
            console.error("");
        }
    });
    console.error("=".repeat(60));
    console.error("");
    console.error("Available AI Skills:");
    console.error("  • lakehouse-preflight  - Validate AWS access and gather configuration");
    console.error("  • lakehouse-install     - Start or continue installation");
    console.error("  • lakehouse-status      - Show comprehensive component status");
    console.error("  • lakehouse-diagnose    - AI-powered diagnostics and troubleshooting");
    console.error("  • lakehouse-logs        - View component logs for debugging");
    console.error("  • lakehouse-cleanup     - Tear down all lakehouse resources");
    console.error("  • get-alb-address      - Retrieve ALB DNS address from Kubernetes ingress");
    console.error("  • configure-dns        - Configure Route53 DNS records for lakehouse domain");
    console.error("");
    console.error("For detailed help on a specific process:");
    console.error("  lakehouse help <process-name>");
    console.error("");
    console.error("Examples:");
    console.error("  lakehouse help install    # Detailed help for install");
    console.error("  lakehouse help status    # Detailed help for status");
}
