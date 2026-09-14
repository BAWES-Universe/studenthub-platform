#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: image-smoke.sh IMAGE}
: "${DATABASE_URL:?set DATABASE_URL to a disposable Postgres database}"
# Optional Docker network lets the same assertion run against a CI service or a
# local disposable Postgres container. The image's real entrypoint runs migrations.
network=${IMAGE_SMOKE_NETWORK:-host}
container=""
assertion='IMAGE_SMOKE: /health must return 200 from the built image'
cleanup() {
  status=$?
  if (( status != 0 )); then
    echo "FAIL: $assertion" >&2
    if [[ -n "$container" ]]; then docker logs "$container" >&2 || true; fi
  fi
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null || true; fi
}
trap cleanup EXIT
container=$(docker run --detach --network "$network" \
  -e HOST=0.0.0.0 -e PORT=3000 \
  -e DATABASE_URL -e PLATFORM_DATABASE_HOSTS="${PLATFORM_DATABASE_HOSTS:-localhost}" \
  -e OIDC_ISSUER=https://auth.example.test/application/o/studenthub/ \
  -e OIDC_CLIENT_ID=studenthub -e OIDC_CLIENT_SECRET=ci-only-placeholder \
  -e OIDC_CALLBACK_URL=https://studenthub.example.test/login/callback \
  -e OIDC_AUTHORIZATION_URL=https://auth.example.test/application/o/authorize/ \
  -e OIDC_TOKEN_URL=https://auth.example.test/application/o/token/ \
  -e OIDC_JWKS_URL=https://auth.example.test/application/o/studenthub/jwks/ \
  -e LOGIN_ALLOWED_RETURN_URLS=https://studenthub.example.test/,https://studenthub.example.test/profile \
  "$image")
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  if [[ $(docker inspect --format '{{.State.Running}}' "$container") != true ]]; then
    break
  fi
  # Probe inside this container so another service on the runner cannot pass it.
  code=$(docker exec "$container" curl --silent --output /dev/null \
    --write-out '%{http_code}' --max-time 2 http://127.0.0.1:3000/health) || code=000
  if [[ "$code" == 200 ]]; then
    echo "PASS: $assertion"
    exit 0
  fi
  sleep 1
done
exit 1
