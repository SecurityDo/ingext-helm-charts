#!/bin/bash


if [ $# -lt 1 ] || [ $# -gt 2 ]; then
    echo "Usage: $0 <pod> [namespace]"
    exit 1
fi

pod="$1"
# Initialize an empty string for the namespace argument
ns_arg=""

# If specific namespace is provided, format the argument
if [ -n "$2" ]; then
    ns_arg="-n $2"
fi

# Run the command once using the variable
# Note: $ns_arg must be unquoted here so bash recognizes the flag
kubectl logs $ns_arg -f "$pod"
