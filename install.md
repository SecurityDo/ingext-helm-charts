# 🛠️ Multi-Cloud Kubernetes Deployment Toolbox

Welcome! To simplify the installation of our Multi-Cloud K8s Application, we have prepared a **pre-configured Deployment Toolbox**.

Instead of manually installing, updating, and troubleshooting multiple command-line tools (`kubectl`, `aws`, `az`, `eksctl`, etc.) on your local machine, you can run a single command to launch a Docker container that has everything pre-installed and verified to work together.

## 📋 Prerequisites

1.  **Docker:** You must have Docker installed and running.
    * [Download Docker Desktop](https://www.docker.com/products/docker-desktop)

## 🚀 Quick Start

We provide wrapper scripts to launch the environment effortlessly. These scripts ensure your local credentials (AWS profiles, Azure logins, Kubeconfig) are saved to your local machine, so you don't lose them when the container exits.

### 🍎 macOS & 🐧 Linux

1.  Download the `ingext-shell.sh` script to your project directory.
2.  Make the script executable:
    ```bash
    chmod +x ingext-shell.sh
    ```
3.  Run the shell:
    ```bash
    ./ingext-shell.sh
    ```
4. OR run the scipit in one line
    ```bash
    bash <(curl -fsSL https://raw.githubusercontent.com/SecurityDo/ingext-helm-charts/main/ingext-shell.sh)
    ```
5. If it asks for a password, run 'docker logout public.ecr.aws' first."

### 🪟 Windows (PowerShell)

1.  Download the `ingext-shell.ps1` script to your project directory.
2.  Run the script in PowerShell:
    ```powershell
    .\ingext-shell.ps1
    ```
    *(Note: If you receive a security error, you may need to run `Set-ExecutionPolicy -ExecutionPolicy Unrestricted -Scope CurrentUser` to allow the script to run).*

---

## 💻 How it Works

When you run the script, it pulls the latest image from our public registry (`public.ecr.aws/ingext/ingext-shell`) and drops you into a bash prompt inside the container.

**The Magic of Volume Mapping:**
Even though the tools run inside Docker, **your data persists on your laptop.** We automatically map the following folders:

| Local Folder | Container Folder | Purpose |
| :--- | :--- | :--- |
| `Current Directory` | `/workspace` | Access your project files (YAMLs, scripts) inside the container. |
| `~/.aws/` | `/root/.aws` | Persist AWS credentials (run `aws configure` once). |
| `~/.azure/` | `/root/.azure` | Persist Azure credentials (run `az login` once). |
| `~/.kube/` | `/root/.kube` | Persist Kubernetes config (run `kubectl` commands). |
| `~/.ssh/` | `/root/.ssh` | **Read-only** access to your SSH keys. |

### Example Workflow
1. Run `./ingext-shell.sh`.
2. You see the welcome message:
   ```text
   🛠️  Multi-Cloud K8s Toolbox Ready
   Tool Versions:
     • kubectl: v1.30.0
     • aws cli: 2.15.0
     ...
