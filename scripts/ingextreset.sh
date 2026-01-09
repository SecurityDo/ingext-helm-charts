#!/bin/bash

# 1. Validate arguments (Must be 1 or 2)
if [ $# -lt 1 ] || [ $# -gt 2 ]; then
    echo "Usage: $0 <name> [namespace]"
    exit 1
fi

service_name="$1"
ns_arg=""

# 2. Handle optional namespace
# If arg2 exists, format the flag. Otherwise, it remains empty (default context).
if [ -n "$2" ]; then
    ns_arg="-n $2"
fi

# 3. Map input name to Kubernetes Label Selector
# We store the selector in a variable to keep the kubectl command DRY at the end.
case "$service_name" in
    "api")
        label="statefulset/api"
        ;;
    "stream")
        label="statefulset/platform"
        ;;
    "platform")
        label="statefulset/platform"
        ;;	
    "mgr")
        label="statefulset/lake-mgr"
        ;;
    "worker")
        label="deployment/lake-worker"
        ;;
    "search")
        label="deployment/search-service"
        ;;
    "ui")
        label="deployment/fluency8"
        ;;	
    *)
        # Default catch-all for unknown services
        echo "Error: unknown service '$service_name'"
        echo "Supported services: api, stream, ui, mgr, worker, search"
        exit 1
        ;;
esac

# 4. Execute the command
# We use the $label variable we set above and the $ns_arg (if it was set).
# Note: $ns_arg is unquoted so the shell sees the flag correctly if it exists.
kubectl rollout restart "$label" $ns_arg
