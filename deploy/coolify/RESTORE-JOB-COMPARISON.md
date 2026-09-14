# Exact deploy jobs, side by side

Reference: PR #104 parent `50db30ee3c48b9fe4a056a253cd13992cfaba772`.
The supplied `6a09ecb36aa0ef136a375f69efe838674bf7f5c4` is already post-#104.
Both job bodies below are quoted verbatim; no secret values are included.

<table><tr><th>Pre-#104</th><th>Restored</th></tr><tr><td valign="top"><pre>  deploy:
    if: ${{ github.event_name == &#x27;push&#x27; &amp;&amp; github.ref == &#x27;refs/heads/main&#x27; }}
    needs: build-push
    runs-on: ubuntu-latest
    env:
      COOLIFY_BASE: ${{ secrets.COOLIFY_BASE }}
      COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}
      COOLIFY_STUDENTHUB_GATEWAY_UUID: ${{ secrets.COOLIFY_STUDENTHUB_GATEWAY_UUID }}
    steps:
      - name: Trigger Coolify deploy
        run: |
          curl -sSf -X POST &quot;${COOLIFY_BASE}/api/v1/deploy?uuid=${COOLIFY_STUDENTHUB_GATEWAY_UUID}&quot; \
            -H &quot;Authorization: Bearer ${COOLIFY_TOKEN}&quot; || echo &quot;deploy trigger failed (uuid secret not set yet)&quot;
</pre></td><td valign="top"><pre>  deploy:
    # Only runtime main pushes whose exact published digest passed image smoke.
    if: ${{ github.event_name == &#x27;push&#x27; &amp;&amp; github.ref == &#x27;refs/heads/main&#x27; }}
    needs: build-push
    runs-on: ubuntu-latest
    timeout-minutes: 20
    outputs:
      outcome: ${{ steps.rollout.outputs.outcome }}
    permissions:
      contents: read
      packages: write
      issues: write
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_HOST_AUTH_METHOD: trust
          POSTGRES_DB: studenthub_authz
        ports:
          - 55432:5432
        options: &gt;-
          --health-cmd &quot;pg_isready -U postgres&quot;
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Record smoke-tested artifact
        env:
          DIGEST: ${{ needs.build-push.outputs.digest }}
        run: |
          node --input-type=module &lt;&lt;&#x27;JS&#x27;
          import { writeFileSync } from &#x27;node:fs&#x27;;
          import { selectArtifact } from &#x27;./deploy/coolify/select-artifact.mjs&#x27;;
          const selection = selectArtifact(process.env.GITHUB_SHA);
          if (selection.digest !== process.env.DIGEST) throw new Error(&#x27;artifact differs from smoke-tested digest&#x27;);
          writeFileSync(&#x27;selected-artifact.json&#x27;, JSON.stringify(selection) + &#x27;\n&#x27;);
          JS
      - uses: actions/upload-artifact@v4
        with:
          name: selected-artifact-${{ github.run_id }}-${{ github.run_attempt }}
          path: selected-artifact.json
          if-no-files-found: error
      - name: Automatically deploy and verify staging with rollback and freeze
        id: rollout
        env:
          COOLIFY_BASE: ${{ secrets.COOLIFY_BASE }}
          COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}
          COOLIFY_STUDENTHUB_GATEWAY_UUID: ${{ secrets.COOLIFY_STUDENTHUB_GATEWAY_UUID }}
          GH_TOKEN: ${{ github.token }}
          DATABASE_URL: postgres://postgres@localhost:55432/studenthub_authz
        run: node deploy/coolify/automatic-staging.mjs
      - uses: actions/upload-artifact@v4
        if: ${{ always() }}
        with:
          name: deployment-receipt-${{ github.run_id }}-${{ github.run_attempt }}
          path: deployment-receipt.json
          if-no-files-found: warn
</pre></td></tr></table>
