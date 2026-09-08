import { pathToFileURL } from "node:url";
import pg from "pg";

export async function checkReadiness({
  databaseUrl = process.env.DATABASE_URL,
  port = process.env.PORT ?? "3000",
  fetchImplementation = fetch,
  connect = async (connectionString) => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
    await client.connect();
    return client;
  },
} = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = await connect(databaseUrl);
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end();
  }

  const response = await fetchImplementation(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`gateway health returned ${response.status}`);
  const body = await response.json();
  if (body?.status !== "ok" || body?.component !== "gateway") {
    throw new Error("gateway health payload is invalid");
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    await checkReadiness();
  } catch (error) {
    process.stderr.write(`gateway is not ready: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
