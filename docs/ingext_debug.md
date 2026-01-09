# ingext k8s debug

## utility scripts

```bash
# set default namespace
kubens ns-datalake
# view service log
scripts/ingextlog.sh api|stream|mgr|worker|search
# reset service
scripts/ingextreset.sh ui|api|stream|mgr|worker|search
# login to the pod
scripts/ingextbash.sh stream|mgr
# view pod log
scripts/podlog.sh <pod-name>
```

## API service

```bash
## view logs
kubectl logs -l "ingext.io/app=api" -n <namespace> -f
## restart 
kubectl rollout restart statefulset/api -n <namespace>
```

## Stream service

```bash
## view logs
kubectl logs -l "ingext.io/app=platform" -n <namespace> -f
## restart 
kubectl rollout restart statefulset/platform -n <namespace>
## bash 
kubectl exec -it -n <namespace> platform-0 -- bash
```

## Management Console

```bash
## restart 
kubectl rollout restart deployment/fluency8 -n <namespace>
```

## Datalake manager

```bash
## view logs
kubectl logs -l "ingext.io/app=lake-mgr" -n <namespace> -f
## restart 
kubectl rollout restart statefulset/lake-mgr -n <namespace>
## bash 
kubectl exec -it -n <namespace> lake-mgr-0 -- bash
```

## Datalake worker

```bash
## view logs
kubectl logs -l "ingext.io/app=lake-worker" -n <namespace> -f
## restart 
kubectl rollout restart deployment/lake-worker -n <namespace>
```

## Datalake search

```bash
## view logs
kubectl logs -l "ingext.io/app=search-service" -n <namespace> -f
## restart 
kubectl rollout restart deployment/search-service -n <namespace>
```

## Karpenter logs

```bash
kubectl logs -l app.kubernetes.io/instance=karpenter -n kube-system
```
