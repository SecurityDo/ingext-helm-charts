#!/usr/bin/env bash

set -uo pipefail
# Don't use 'set -e' - we want to continue even if some tests fail

###############################################################################
# Comprehensive Test Suite - All Backend Components
#
# Tests all components systematically with clear PASS/FAIL results.
# Identifies all issues at once to eliminate guesswork.
#
# Usage:
#   ./test-all.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
Comprehensive Test Suite - All Backend Components

Usage:
  ./test-all.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./test-all.sh --namespace ingext --domain gcp.k8.ingext.io
EOF
}

# -------- Defaults --------
NAMESPACE="${NAMESPACE:-ingext}"
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
WARNINGS=0

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --domain)
      SITE_DOMAIN="$2"
      shift 2
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# -------- Helper functions --------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

log() {
  echo ""
  echo "==> $*"
}

test_pass() {
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  PASSED_TESTS=$((PASSED_TESTS + 1))
  echo -e "  \033[0;32m✓ PASS\033[0m: $*"
}

test_fail() {
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  FAILED_TESTS=$((FAILED_TESTS + 1))
  echo -e "  \033[0;31m✗ FAIL\033[0m: $*"
}

test_warn() {
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  WARNINGS=$((WARNINGS + 1))
  echo -e "  \033[0;33m⚠ WARN\033[0m: $*"
}

color_green() {
  echo -e "\033[0;32m$*\033[0m"
}

color_yellow() {
  echo -e "\033[0;33m$*\033[0m"
}

color_red() {
  echo -e "\033[0;31m$*\033[0m"
}

# -------- Dependency checks --------
need kubectl

# -------- Load environment file if available --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/ingext-gke.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  [[ -n "${NAMESPACE:-}" ]] && NAMESPACE="${NAMESPACE}"
  [[ -n "${SITE_DOMAIN:-}" ]] && SITE_DOMAIN="${SITE_DOMAIN}"
fi

# -------- Validate required variables --------
if [[ -z "${SITE_DOMAIN:-}" ]]; then
  echo "ERROR: SITE_DOMAIN is required"
  exit 1
fi

# -------- Check kubectl connectivity --------
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to Kubernetes cluster"
  exit 1
fi

echo ""
echo "=========================================="
echo "Comprehensive Backend Test Suite"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo "Timestamp: $(date)"
echo ""

# ============================================================================
# SECTION 1: CLUSTER & NAMESPACE
# ============================================================================
log "SECTION 1: Cluster & Namespace"

if kubectl cluster-info >/dev/null 2>&1; then
  test_pass "Kubernetes cluster accessible"
else
  test_fail "Cannot connect to Kubernetes cluster"
  echo "ERROR: Cannot continue without cluster access"
  exit 1
fi

if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  test_pass "Namespace '$NAMESPACE' exists"
else
  test_fail "Namespace '$NAMESPACE' does not exist"
  echo "WARNING: Continuing tests, but some may fail without namespace"
fi

# ============================================================================
# SECTION 2: PODS
# ============================================================================
log "SECTION 2: Pod Status"

# API Pod
API_PODS=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api" --no-headers 2>/dev/null 2>&1 | wc -l || echo "0")
if [[ "$API_PODS" -gt 0 ]]; then
  API_RUNNING=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api" --no-headers 2>/dev/null | grep -c "Running" || echo "0")
  if [[ "$API_RUNNING" -gt 0 ]]; then
    test_pass "API pods running ($API_RUNNING/$API_PODS)"
  else
    test_fail "API pods exist but none are Running"
  fi
else
  test_fail "No API pods found"
fi

# Platform Pod
PLATFORM_PODS=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=platform" --no-headers 2>/dev/null | wc -l || echo "0")
if [[ "$PLATFORM_PODS" -gt 0 ]]; then
  PLATFORM_RUNNING=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=platform" --no-headers 2>/dev/null | grep -c "Running" || echo "0")
  if [[ "$PLATFORM_RUNNING" -gt 0 ]]; then
    test_pass "Platform pods running ($PLATFORM_RUNNING/$PLATFORM_PODS)"
  else
    test_fail "Platform pods exist but none are Running"
  fi
else
  test_fail "No Platform pods found"
fi

# Fluency Pod
FLUENCY_PODS=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=fluency8" --no-headers 2>/dev/null | wc -l || echo "0")
if [[ "$FLUENCY_PODS" -gt 0 ]]; then
  FLUENCY_RUNNING=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=fluency8" --no-headers 2>/dev/null | grep -c "Running" || echo "0")
  if [[ "$FLUENCY_RUNNING" -gt 0 ]]; then
    test_pass "Fluency pods running ($FLUENCY_RUNNING/$FLUENCY_PODS)"
  else
    test_fail "Fluency pods exist but none are Running"
  fi
else
  test_fail "No Fluency pods found"
fi

# ============================================================================
# SECTION 3: SERVICES
# ============================================================================
log "SECTION 3: Service Configuration"

# API Service
if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  test_pass "API service exists"
  
  API_ENDPOINTS=$(kubectl get endpoints api -n "$NAMESPACE" -o jsonpath='{.subsets[0].addresses[*].ip}' 2>/dev/null || echo "")
  if [[ -n "$API_ENDPOINTS" ]]; then
    test_pass "API service has endpoints: $API_ENDPOINTS"
  else
    test_fail "API service has NO endpoints (pods not ready or selector mismatch)"
  fi
  
  API_PORT=$(kubectl get service api -n "$NAMESPACE" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "")
  if [[ "$API_PORT" == "8002" ]]; then
    test_pass "API service port is 8002"
  else
    test_fail "API service port is $API_PORT (expected 8002)"
  fi
else
  test_fail "API service not found"
fi

# Platform Service
if kubectl get service platform-service -n "$NAMESPACE" >/dev/null 2>&1; then
  test_pass "Platform service exists"
else
  test_fail "Platform service not found"
fi

# Fluency Service
if kubectl get service fluency8 -n "$NAMESPACE" >/dev/null 2>&1; then
  test_pass "Fluency service exists"
else
  test_fail "Fluency service not found"
fi

# ============================================================================
# SECTION 4: BACKEND CONFIG
# ============================================================================
log "SECTION 4: BackendConfigs (GKE Health Checks)"

check_backend_config() {
  local name="$1"
  local port="$2"
  local path="$3"
  
  if kubectl get backendconfig "$name" -n "$NAMESPACE" >/dev/null 2>&1; then
    test_pass "BackendConfig '$name' exists"
    
    local type=$(kubectl get backendconfig "$name" -n "$NAMESPACE" -o jsonpath='{.spec.healthCheck.type}' 2>/dev/null || echo "")
    if [[ "$type" == "HTTP" ]] || [[ "$type" == "HTTPS" ]] || [[ "$type" == "HTTP2" ]]; then
      test_pass "  - '$name' uses HTTP/HTTPS/HTTP2"
    else
      test_fail "  - '$name' uses $type (GKE L7 requires HTTP/HTTPS/HTTP2)"
    fi
    
    local actual_path=$(kubectl get backendconfig "$name" -n "$NAMESPACE" -o jsonpath='{.spec.healthCheck.requestPath}' 2>/dev/null || echo "")
    if [[ "$actual_path" == "$path" ]]; then
      test_pass "  - '$name' has correct requestPath: $actual_path"
    else
      test_fail "  - '$name' has requestPath '$actual_path' (expected '$path')"
    fi

    local actual_port=$(kubectl get backendconfig "$name" -n "$NAMESPACE" -o jsonpath='{.spec.healthCheck.port}' 2>/dev/null || echo "")
    if [[ "$actual_port" == "$port" ]]; then
      test_pass "  - '$name' has correct port: $actual_port"
    else
      test_fail "  - '$name' has port '$actual_port' (expected '$port')"
    fi
  else
    test_fail "BackendConfig '$name' not found"
  fi
}

check_backend_config "api-backend-config" "8002" "/health-check"
check_backend_config "platform-backend-config" "28180" "/health-check"
check_backend_config "fluency-backend-config" "8004" "/health-check"

# Service Annotations
check_service_ann() {
  local svc="$1"
  local config="$2"
  local ann=$(kubectl get service "$svc" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cloud\.google\.com/backend-config}' 2>/dev/null || echo "")
  if echo "$ann" | grep -q "$config"; then
    test_pass "Service '$svc' has correct BackendConfig annotation"
  else
    test_fail "Service '$svc' missing or incorrect BackendConfig annotation (found: $ann)"
  fi
  
  local neg=$(kubectl get service "$svc" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cloud\.google\.com/neg}' 2>/dev/null || echo "")
  if echo "$neg" | grep -q "ingress.:.true"; then
    test_pass "Service '$svc' has NEG annotation enabled"
  else
    test_fail "Service '$svc' missing NEG annotation"
  fi
}

check_service_ann "api" "api-backend-config"
check_service_ann "platform-service" "platform-backend-config"
check_service_ann "fluency8" "fluency-backend-config"

# ============================================================================
# SECTION 5: INGRESS CONFIGURATION
# ============================================================================
log "SECTION 5: Ingress Configuration"

if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  test_pass "Ingress exists"
  
  # Check for single rule (GKE requirement)
  RULE_COUNT=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[*].host}' 2>/dev/null | tr ' ' '\n' | grep -c "$SITE_DOMAIN" || echo "0")
  if [[ "$RULE_COUNT" -eq 1 ]]; then
    test_pass "Ingress has single rule (GKE requirement)"
  else
    test_fail "Ingress has $RULE_COUNT rules (should be 1 - all paths must be under single rule)"
  fi
  
  # Check paths
  PATHS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].http.paths[*].path}' 2>/dev/null || echo "")
  
  if echo "$PATHS" | grep -q "/api"; then
    test_pass "Ingress has /api path"
  else
    test_fail "Ingress missing /api path"
  fi
  
  if echo "$PATHS" | grep -q "/services"; then
    test_pass "Ingress has /services path"
  else
    test_fail "Ingress missing /services path"
  fi
  
  # Check for / path (can be exact match or in the list)
  if echo "$PATHS" | grep -qE "(^| )/( |$)"; then
    test_pass "Ingress has / path"
  else
    # Double-check by looking at the actual YAML
    ROOT_PATH_EXISTS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o yaml 2>/dev/null | grep -A 5 "path: /" | grep -q "pathType: Prefix" && echo "yes" || echo "no")
    if [[ "$ROOT_PATH_EXISTS" == "yes" ]]; then
      test_pass "Ingress has / path (verified in YAML)"
    else
      test_fail "Ingress missing / path"
    fi
  fi
  
  # Check ingress IP
  ING_IP=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [[ -n "$ING_IP" ]]; then
    test_pass "Ingress has IP address: $ING_IP"
  else
    test_fail "Ingress has no IP address (may take 2-5 minutes to assign)"
  fi
  
  # Check annotations
  CERT_ISSUER=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/cluster-issuer}' 2>/dev/null || echo "")
  if [[ -n "$CERT_ISSUER" ]]; then
    test_pass "Ingress has cert-manager cluster-issuer annotation"
  else
    test_fail "Ingress missing cert-manager cluster-issuer annotation"
  fi
else
  test_fail "Ingress not found"
fi

# ============================================================================
# SECTION 6: INGRESS BACKEND HEALTH
# ============================================================================
log "SECTION 6: Ingress Backend Health"

if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  # Use describe to get backend statuses
  DESCRIBE_OUTPUT=$(kubectl describe ingress ingext-ingress -n "$NAMESPACE" 2>/dev/null)
  
  check_backend_health() {
    local svc="$1"
    local port="$2"
    
    # GKE Ingress status is often in the annotations as JSON
    local backend_json=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.ingress\.kubernetes\.io/backends}' 2>/dev/null || echo "")
    
    # Try to find the specific backend in the JSON status first
    if [[ -n "$backend_json" ]]; then
      # Look for a key that contains the service name and port
      local status=$(echo "$backend_json" | grep -o "\"k8s1-[^\"]*-$svc-$port-[^\"]*\":\"[^\"]*\"" | cut -d: -f2 | tr -d '"' || echo "")
      if [[ "$status" == "HEALTHY" ]]; then
        test_pass "Backend '$svc:$port' is HEALTHY (from annotation)"
        return
      elif [[ "$status" == "UNHEALTHY" ]]; then
        test_fail "Backend '$svc:$port' is UNHEALTHY (from annotation)"
        return
      fi
    fi

    # Fallback to grep describe output
    if echo "$DESCRIBE_OUTPUT" | grep -q "$svc:$port.*HEALTHY"; then
      test_pass "Backend '$svc:$port' is HEALTHY"
    elif echo "$DESCRIBE_OUTPUT" | grep -q "$svc:$port.*UNHEALTHY"; then
      test_fail "Backend '$svc:$port' is UNHEALTHY"
    elif echo "$DESCRIBE_OUTPUT" | grep -q "$svc:$port"; then
      test_warn "Backend '$svc:$port' status unknown"
    else
      test_fail "Backend '$svc:$port' not found in ingress description"
    fi
  }

  check_backend_health "api" "8002"
  check_backend_health "platform-service" "28180"
  check_backend_health "fluency8" "8004"
  
  # Check for errors in events
  INGRESS_ERRORS=$(kubectl get events -n "$NAMESPACE" --field-selector involvedObject.name=ingext-ingress --sort-by='.lastTimestamp' 2>/dev/null | grep -i "error\|warning" | tail -3 || echo "")
  if [[ -n "$INGRESS_ERRORS" ]]; then
    if echo "$INGRESS_ERRORS" | grep -qi "tcp.*not valid"; then
      test_fail "Ingress error: TCP health check not supported (must use HTTP/HTTPS/HTTP2)"
    elif echo "$INGRESS_ERRORS" | grep -qi "error"; then
      test_fail "Ingress has errors (check events)"
    else
      test_warn "Ingress has warnings (check events)"
    fi
  else
    test_pass "No ingress errors found"
  fi
fi

# ============================================================================
# SECTION 7: DNS
# ============================================================================
log "SECTION 7: DNS Configuration"

if [[ -n "${ING_IP:-}" ]]; then
  if command -v nslookup >/dev/null 2>&1; then
    DNS_RESULT=$(nslookup "$SITE_DOMAIN" 2>&1 | grep -A 2 "Name:" || echo "")
    if echo "$DNS_RESULT" | grep -q "$ING_IP"; then
      test_pass "DNS resolves correctly to ingress IP"
    else
      ACTUAL_IP=$(nslookup "$SITE_DOMAIN" 2>&1 | grep "Address:" | tail -1 | awk '{print $2}' || echo "unknown")
      test_fail "DNS does not resolve to ingress IP (resolves to: $ACTUAL_IP, expected: $ING_IP)"
    fi
  else
    test_warn "nslookup not available, skipping DNS check"
  fi
else
  test_warn "Cannot check DNS - ingress has no IP"
fi

# ============================================================================
# SECTION 8: CERTIFICATE
# ============================================================================
log "SECTION 8: Certificate Status"

# cert-manager
if kubectl get namespace cert-manager >/dev/null 2>&1; then
  CERT_MANAGER_PODS=$(kubectl get pods -n cert-manager --no-headers 2>/dev/null | grep -c "Running" || echo "0")
  if [[ "$CERT_MANAGER_PODS" -gt 0 ]]; then
    test_pass "cert-manager is running"
  else
    test_fail "cert-manager namespace exists but no pods running"
  fi
else
  test_fail "cert-manager namespace not found"
fi

# ClusterIssuer
if kubectl get clusterissuer letsencrypt-prod >/dev/null 2>&1; then
  ISSUER_READY=$(kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
  if [[ "$ISSUER_READY" == "True" ]]; then
    test_pass "ClusterIssuer is Ready"
  else
    test_fail "ClusterIssuer status: $ISSUER_READY"
  fi
else
  test_fail "ClusterIssuer 'letsencrypt-prod' not found"
fi

# Certificate
CERT_NAME=$(kubectl get certificate -n "$NAMESPACE" -o name 2>/dev/null | head -1 || echo "")
if [[ -n "$CERT_NAME" ]]; then
  test_pass "Certificate resource exists"
  
  CERT_READY=$(kubectl get "$CERT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
  if [[ "$CERT_READY" == "True" ]]; then
    test_pass "Certificate is Ready"
  else
    CERT_REASON=$(kubectl get "$CERT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null || echo "")
    test_fail "Certificate not ready (reason: $CERT_REASON)"
  fi
else
  test_warn "Certificate resource not found (cert-manager will create it when DNS resolves)"
fi

# ============================================================================
# SECTION 9: DIRECT API ACCESS
# ============================================================================
log "SECTION 9: Direct API Access (port-forward test)"

if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1 && [[ -n "${API_ENDPOINTS:-}" ]]; then
  # Try port-forward test
  kubectl port-forward -n "$NAMESPACE" service/api 8002:8002 >/dev/null 2>&1 &
  PF_PID=$!
  sleep 2
  
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8002/api/auth/login -X POST -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo "000")
  
  kill $PF_PID 2>/dev/null || true
  wait $PF_PID 2>/dev/null || true
  
  if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "401" ]] || [[ "$HTTP_CODE" == "400" ]]; then
    test_pass "API responds via direct access (HTTP $HTTP_CODE)"
  elif [[ "$HTTP_CODE" == "404" ]]; then
    test_fail "API returns 404 via direct access (API routing issue)"
  elif [[ "$HTTP_CODE" == "000" ]]; then
    test_fail "Cannot connect to API via direct access (API not listening)"
  else
    test_warn "API returned HTTP $HTTP_CODE via direct access"
  fi
else
  test_warn "Cannot test direct API access (service or endpoints missing)"
fi

# ============================================================================
# SECTION 10: INGRESS API ACCESS
# ============================================================================
log "SECTION 10: Ingress API Access (via load balancer)"

if [[ -n "${ING_IP:-}" ]]; then
  HTTP_CODE=$(curl -s -k -o /dev/null -w "%{http_code}" "https://$SITE_DOMAIN/api/auth/login" -X POST -H "Content-Type: application/json" -H "Host: $SITE_DOMAIN" -d '{}' 2>/dev/null || echo "000")
  
  if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "401" ]] || [[ "$HTTP_CODE" == "400" ]]; then
    test_pass "API accessible via ingress (HTTP $HTTP_CODE)"
  elif [[ "$HTTP_CODE" == "404" ]]; then
    test_fail "API returns 404 via ingress (routing issue - check ingress paths and backend health)"
  elif [[ "$HTTP_CODE" == "000" ]]; then
    test_fail "Cannot connect via ingress (DNS or load balancer issue)"
  else
    test_warn "API returned HTTP $HTTP_CODE via ingress"
  fi
else
  test_warn "Cannot test ingress API access (no ingress IP)"
fi

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "=========================================="
echo "TEST SUMMARY"
echo "=========================================="
echo "Total Tests: $TOTAL_TESTS"
color_green "Passed: $PASSED_TESTS"
color_red "Failed: $FAILED_TESTS"
if [[ $WARNINGS -gt 0 ]]; then
  color_yellow "Warnings: $WARNINGS"
fi
echo ""

if [[ $FAILED_TESTS -eq 0 ]]; then
  color_green "✓ ALL CRITICAL TESTS PASSED!"
  echo ""
  echo "Your backend should be working correctly."
  exit 0
else
  color_red "✗ SOME TESTS FAILED"
  echo ""
  echo "Review the failures above and run the appropriate fix scripts:"
  echo ""
  
  # Suggest fixes based on failures
  if kubectl get backendconfig -n "$NAMESPACE" -o jsonpath='{.items[*].spec.healthCheck.type}' 2>/dev/null | grep -q "TCP"; then
    echo "  - One or more BackendConfigs use TCP: check BackendConfigs in templates"
  fi
  
  if [[ "$RULE_COUNT" -gt 1 ]] 2>/dev/null; then
    echo "  - Ingress has multiple rules: ./fix-ingress-paths.sh"
  fi
  
  if echo "$DESCRIBE_OUTPUT" 2>/dev/null | grep -q "UNHEALTHY"; then
    echo "  - One or more backends are unhealthy: Check /health-check responds with 200 OK (wait 10-15 min for sync)"
  fi
  
  if [[ -z "${ING_IP:-}" ]]; then
    echo "  - Ingress has no IP: Wait 2-5 minutes or ./recreate-ingress.sh"
  fi
  
  echo ""
  exit 1
fi

