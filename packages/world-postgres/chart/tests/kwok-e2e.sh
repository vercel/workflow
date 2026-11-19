#!/usr/bin/env bash
# Installs the chart into a Kubernetes API server, upgrades it to a new image
# tag, and runs pruning as the chart's own prune ServiceAccount (so the API
# server enforces its RBAC), with backlogs served by `createBacklogEndpoints`
# against a real Postgres.
#
#   KUBE_CONTEXT=kwok WORKFLOW_POSTGRES_URL=postgres://... ./chart/tests/kwok-e2e.sh
#
# Needs: helm, kubectl, an API server with RBAC and the KEDA CRDs (kwok with
# `--secure-port --kube-authorization` works), and a built package
# (`pnpm build`). The database is bootstrapped by the script.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${KUBE_CONTEXT:?}" "${WORKFLOW_POSTGRES_URL:?}"
NS=workflow-chart-e2e
SERVICE=wf-e2e
# Its own job prefix per run, so runs of earlier runs of the script don't count.
PREFIX=wf_e2e_$(openssl rand -hex 4)_
PORT=${BACKLOG_PORT:-3600}
SHA1=$(openssl rand -hex 20)
SHA2=$(openssl rand -hex 20)
SHA3=$(openssl rand -hex 20)
k() { kubectl --context "$KUBE_CONTEXT" -n "$NS" "$@"; }
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  helm --kube-context "$KUBE_CONTEXT" -n "$NS" uninstall demo >/dev/null 2>&1 || true
  kubectl --context "$KUBE_CONTEXT" delete ns "$NS" --wait=false >/dev/null 2>&1 || true
  kubectl config delete-context workflow-prune-e2e >/dev/null 2>&1 || true
  kubectl config delete-user workflow-prune-e2e >/dev/null 2>&1 || true
}
trap cleanup EXIT
# A previous run's namespace may still be terminating.
kubectl --context "$KUBE_CONTEXT" wait --for=delete "ns/$NS" --timeout=120s >/dev/null 2>&1 || true

WORKFLOW_POSTGRES_URL=$WORKFLOW_POSTGRES_URL node bin/setup.js >/dev/null
WORKFLOW_POSTGRES_URL=$WORKFLOW_POSTGRES_URL JOB_PREFIX=$PREFIX PORT=$PORT node test/fixtures/backlog-server.mjs &
pids+=($!)
for _ in $(seq 1 60); do curl -sf "localhost:$PORT/internal/workflow/versions" >/dev/null && break; sleep 0.25; done
run_on() { curl -sf -XPOST "localhost:$PORT/runs/$1" | sed -E 's/.*"runId":"([^"]+)".*/\1/'; }

# kwok runs pods only on nodes it fakes.
kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Node
metadata:
  name: kwok-node-0
  annotations: { kwok.x-k8s.io/node: fake }
  labels: { type: kwok }
spec:
  taints: []
YAML

workers() { k get deployments -l "workflow.vercel.com/service=$SERVICE" -o jsonpath='{range .items[*]}{.metadata.labels.workflow\.vercel\.com/version}{"\n"}{end}' | sort | tr '\n' ' '; }
install() { # tag
  helm --kube-context "$KUBE_CONTEXT" -n "$NS" upgrade --install demo chart --create-namespace --wait --timeout 120s \
    --set serviceName=$SERVICE --set jobPrefix=$PREFIX --set image.repository=registry.example/$SERVICE --set image.tag="$1" \
    --set "env.WORKFLOW_POSTGRES_URL=$WORKFLOW_POSTGRES_URL" >/dev/null
}
prune() { # deploying-version
  node bin/prune.js --context workflow-prune-e2e --namespace "$NS" --service $SERVICE \
    --min-age-minutes 0 --backlog-url "http://localhost:$PORT/internal/workflow" --version "$1" --skip-image-check
}
expect() { [ "$(workers)" = "$1" ] || { echo "FAIL: workers are '$(workers)', expected '$1'" >&2; exit 1; }; }
sorted() { printf '%s\n' "$@" | sort | tr '\n' ' '; }

echo "--- install $SHA1, and start a run pinned to it"
install "$SHA1"
RUN=$(run_on "$SHA1")

echo "--- upgrade to $SHA2: helm keeps $SHA1's workers (resource-policy: keep)"
install "$SHA2"
expect "$(sorted "$SHA1" "$SHA2")"

echo "--- pruning runs as the chart's prune ServiceAccount"
TOKEN=$(k create token $SERVICE-workflow-prune)
CLUSTER=$(kubectl config view -o jsonpath="{.contexts[?(@.name=='$KUBE_CONTEXT')].context.cluster}")
kubectl config set-credentials workflow-prune-e2e --token="$TOKEN" >/dev/null
kubectl config set-context workflow-prune-e2e --cluster="$CLUSTER" --user=workflow-prune-e2e --namespace="$NS" >/dev/null
[ "$(kubectl --context workflow-prune-e2e auth can-i delete secrets || true)" = no ] || { echo "FAIL: prune SA can delete secrets" >&2; exit 1; }
[ "$(kubectl --context workflow-prune-e2e auth can-i delete deployments.apps)" = yes ]

echo "--- $SHA1 has an unfinished run: kept"
prune "$SHA2"
expect "$(sorted "$SHA1" "$SHA2")"

echo "--- the run finishes: the next prune deletes $SHA1 and its ScaledObject"
curl -sf -XPOST "localhost:$PORT/finish/$RUN" >/dev/null
prune "$SHA2"
expect "$SHA2 "
[ -z "$(k get scaledobjects -l "workflow.vercel.com/version=$SHA1" -o name)" ]

echo "--- $SHA3 has a run but no workers: prune restores them from $SHA2's"
run_on "$SHA3" >/dev/null
prune "$SHA2"
expect "$(sorted "$SHA2" "$SHA3")"
[ -n "$(k get scaledobjects -l "workflow.vercel.com/version=$SHA3" -o name)" ]
k get deployment "$SERVICE-wf-$SHA3" -o jsonpath='{.spec.template.spec.containers[0].image}' | grep -q ":$SHA3$"
echo "ok   chart install, upgrade, RBAC, pruning and restore"
