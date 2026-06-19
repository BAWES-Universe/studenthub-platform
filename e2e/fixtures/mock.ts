/**
 * Mock fixtures for E2E tests — no database dependency.
 *
 * Generates HMAC-signed session cookies using the configured AUTH_SECRET.
 * All roles are self-contained: no DB queries, no seed data required.
 */

import * as crypto from "node:crypto";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export interface SessionUser {
  role: string;
  id: string;
  name: string;
  email: string;
  issuedAt: number;
}

function signSession(user: Omit<SessionUser, "issuedAt">): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, issuedAt: Date.now() }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", requireEnv("AUTH_SECRET"))
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export interface MockFixtureUser {
  role: string;
  id: string;
  name: string;
  email: string;
  cookie: string;
}

export type MockRole = "admin" | "staff" | "candidate" | "company" | "inspector";

const MOCK_USERS: Record<MockRole, { id: string; name: string; email: string }> = {
  admin: {
    id: "999999",
    name: "Test Admin",
    email: "test.admin@studenthub.test",
  },
  staff: {
    id: "999998",
    name: "Test Staff",
    email: "test.staff@studenthub.test",
  },
  candidate: {
    id: "999997",
    name: "Test Candidate",
    email: "test.candidate@studenthub.test",
  },
  company: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Test Company",
    email: "test.company@studenthub.test",
  },
  inspector: {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Test Inspector",
    email: "test.inspector@studenthub.test",
  },
};

export function getMockFixtures(): Map<string, MockFixtureUser> {
  const map = new Map<string, MockFixtureUser>();
  for (const [role, user] of Object.entries(MOCK_USERS)) {
    map.set(role, {
      ...user,
      role,
      cookie: signSession({ role, id: user.id, name: user.name, email: user.email }),
    });
  }
  return map;
}
