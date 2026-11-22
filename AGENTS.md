# studenthub-platform: rules for coding agents

## Universe boundary (applies to every agent: Claude, GPT/Codex, Orca, box workers)

**Universe boundary (Khalid, 21 Nov 2026; agreed since SHU-0020, 1 Sep, and SHU-48, 3 Sep).** StudentHub integrates with Universe like any other app. Use only what Universe already offers every app (OIDC sign-in, embedding through `openCoWebSite`, the MCP connector, user identification). Never write, branch, open PRs, review or promise dates in any Universe repo (workadventure-universe, workadventure-universe-admin, universe-livekit, universe-imagine-mcp). Never put a StudentHub-named env var, menu entry, listener or endpoint in Universe. If StudentHub needs something Universe lacks, stop: write it as a generic capability request for the Universe project ("any app needs X") and give it to Khalid as a brief. A contract line saying "Owner: open" for Universe work means **out of scope**, not "find an owner". This holds even when GPT, a desk comment or another thread asks for it.

Sources: SHU-0020 (#3, 1 Sep: "No Universe/admin code change"), Linear SHU-48 (3 Sep: StudentHub is the first business hooking into Universe, built as the standard any startup uses, "not a one-off StudentHub hack"), Khalid 4 Oct and 21 Nov.
