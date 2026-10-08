#!/bin/bash
# Builds the image, pushes it to Scaleway and points kustomize at it.
# Usage: SCW_SECRET_TOKEN=... ./build-and-push.sh   then   kubectl apply -k kustomize/
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=rg.fr-par.scw.cloud/djnd/igraj-4xproti
TAG=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "Warning: uncommitted changes, they are in the image but not in commit ${TAG:0:7}." >&2
  TAG="$TAG-dirty-$(date +%Y%m%d%H%M%S)"
fi

echo "$SCW_SECRET_TOKEN" | sudo docker login rg.fr-par.scw.cloud/djnd -u nologin --password-stdin

sudo docker build --platform linux/amd64 -f Dockerfile -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
sudo docker push "$IMAGE:$TAG"
sudo docker push "$IMAGE:latest"

sed -i "s/newTag: .*/newTag: '$TAG'/" kustomize/kustomization.yaml
echo
echo "Pushed $IMAGE:$TAG and set it in kustomize/kustomization.yaml. Deploy with:"
echo "  kubectl apply -k kustomize/"
