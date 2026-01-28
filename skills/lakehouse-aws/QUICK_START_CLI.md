# Lakehouse CLI Quick Start Guide

## Installation

### Option 1: Local Development (Recommended)

```bash
cd skills/lakehouse-aws
npm install
npm link
```

Now you can run `lakehouse` from anywhere.

### Option 2: Run Directly with npm

```bash
cd skills/lakehouse-aws
npm run dev -- [command]
```

Example:
```bash
npm run dev -- help
npm run dev -- status
```

## First-Time Setup

### Step 1: Run Preflight

```bash
lakehouse preflight --root-domain example.com
```

This will:
- Validate AWS credentials
- Check for existing resources
- Discover or prompt for ACM certificate
- Create `lakehouse_ingext.env` file

### Step 2: Start Installation

```bash
lakehouse install
```

Or use the interactive menu:
```bash
lakehouse
```

The CLI will:
- Auto-detect which phase you're in
- Show what's already deployed
- Recommend next action
- Continue from where you left off

## Common Commands

### Interactive Menu (Zero Config)

```bash
lakehouse
```

Shows current state and available actions. Best for first-time users.

### Quick Status Check

```bash
lakehouse status
```

Displays detailed status of all components.

### Continue Installation

```bash
lakehouse install
```

Intelligently continues from current phase. Safe to run multiple times.

### Get Help

```bash
lakehouse help              # General help
lakehouse help install      # Detailed help for install
lakehouse help preflight    # Detailed help for preflight
```

### Cleanup

```bash
lakehouse cleanup
```

Safely tears down all resources. Will prompt for confirmation unless `--approve` is used.

## Advanced Usage

### Multi-Environment Support

Create multiple lakehouse deployments:

```bash
# Create production environment
lakehouse preflight --namespace production --root-domain prod.example.com

# Create staging environment
lakehouse preflight --namespace staging --root-domain staging.example.com

# Switch between them
lakehouse status --namespace production
lakehouse status --namespace staging
```

The CLI auto-discovers all `lakehouse_*.env` files.

### Non-Interactive Mode (Automation)

```bash
# Preflight with auto-approve
lakehouse preflight --root-domain example.com --approve

# Install with auto-approve
lakehouse install --approve

# Status as JSON
lakehouse status --json
```

### Override Environment Variables

```bash
lakehouse status --region us-west-2 --cluster my-cluster
```

CLI args override env file values.

### Docker Execution Mode

```bash
lakehouse install --exec docker
```

Runs tools (kubectl, helm, eksctl) in Docker containers.

## Typical Workflow

### New Deployment

```bash
# 1. Validate prerequisites
lakehouse preflight --root-domain example.com

# 2. Start installation (creates cluster)
lakehouse install --approve

# 3. Check status
lakehouse status

# 4. Continue installation (if paused)
lakehouse install

# 5. Final status check
lakehouse status
```

### Checking Existing Deployment

```bash
# Quick status
lakehouse

# Or detailed status
lakehouse status
```

### Resuming Interrupted Installation

```bash
# CLI auto-detects current phase
lakehouse install
```

### Cleaning Up

```bash
# Interactive (will prompt for confirmation)
lakehouse cleanup

# Non-interactive
lakehouse cleanup --approve
```

## State Detection

The CLI automatically detects your lakehouse state:

- **NO_CLUSTER**: Cluster doesn't exist → Run `lakehouse install`
- **PHASE_X_COMPLETE**: Phase X done → Run `lakehouse install` to continue
- **PHASE_7_COMPLETE**: Fully deployed → Run `lakehouse status` to verify
- **HEALTH_DEGRADED**: Issues detected → Run `lakehouse diagnose`
- **DNS_PENDING**: ALB ready but DNS not configured → Run `configure-dns`

## Troubleshooting

### "No configuration found"

Run preflight first:
```bash
lakehouse preflight --root-domain example.com
```

### "Cluster not reachable"

Check AWS credentials:
```bash
aws sts get-caller-identity
```

Update kubeconfig:
```bash
aws eks update-kubeconfig --name <cluster-name> --region <region>
```

### "Multiple env files found"

Specify namespace:
```bash
lakehouse status --namespace production
```

Or use interactive menu and select from list.

### Installation Paused/Stuck

Check current state:
```bash
lakehouse status
```

Resume installation:
```bash
lakehouse install
```

Force continue (if safe to do so):
```bash
lakehouse install --force
```

## Tips

1. **Always run preflight first** - It validates prerequisites and creates config
2. **Use interactive menu** when learning - Shows state and recommendations
3. **Use direct commands** for automation - Faster and scriptable
4. **Check status often** - Shows what's deployed and what's pending
5. **Multiple environments** - Use different namespaces for isolation

## Examples

### Example 1: Fresh Installation

```bash
$ lakehouse preflight --root-domain ingext.io
✓ AWS credentials valid
✓ Certificate found: *.k8.ingext.io
✓ Route53 zone found: ingext.io
✓ Environment file written: lakehouse_ingext.env

$ lakehouse install --approve
[Phase 1: Foundation]
Creating EKS cluster...
✓ Cluster created (12m 34s)

[Phase 2: Storage]
Creating S3 bucket...
✓ S3 bucket created

[Phase 3: Compute]
Installing Karpenter...
✓ Karpenter installed

[Phase 4: Core Services]
Installing Redis, OpenSearch, etcd...
✓ Core services deployed

[Phase 5: Stream]
Installing API, Platform, Fluency...
✓ Stream services deployed

[Phase 6: Datalake]
Installing Lake Manager, Workers...
✓ Datalake deployed

[Phase 7: Ingress]
Installing ALB Ingress Controller...
✓ Ingress deployed

$ lakehouse status
Lakehouse Status: ingext-lakehouse
COMPONENT                          STATUS
EKS Cluster                        ACTIVE
Ingress                           Installed
AWS Load Balancer                  alb-ingext-1234.us-east-2.elb.amazonaws.com

✓ All components healthy
```

### Example 2: Multi-Environment

```bash
$ lakehouse preflight --namespace dev --root-domain dev.example.com
$ lakehouse preflight --namespace staging --root-domain staging.example.com
$ lakehouse preflight --namespace prod --root-domain prod.example.com

$ lakehouse
Multiple lakehouse configurations found:

  1) dev
  2) staging
  3) prod

Select configuration [1]: 1

[Shows dev environment status and menu]

$ lakehouse status --namespace prod
[Shows prod environment status]
```

### Example 3: Resume After Interruption

```bash
$ lakehouse status
Current Status:
  Phase 4 complete: Core services deployed
  Cluster: ACTIVE
  Releases: 8 deployed

Recommended Action:
  install: Continue with Phase 5 (Stream).
  Command: lakehouse install

$ lakehouse install
[Phase 5: Stream]
Installing API, Platform, Fluency...
✓ Stream services deployed

[Phase 6: Datalake]
Installing Lake Manager, Workers...
✓ Datalake deployed

[Phase 7: Ingress]
Installing ALB Ingress Controller...
✓ Ingress deployed

✓ Installation complete!
```

## Need Help?

- Run `lakehouse help` for command list
- Run `lakehouse help <command>` for detailed help
- Check `CLI_IMPLEMENTATION_SUMMARY.md` for architecture details
- See main README for cloud provider setup
