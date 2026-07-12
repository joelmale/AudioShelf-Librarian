import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type Role = "viewer" | "curator" | "librarian" | "administrator";
const rank: Record<Role, number> = { viewer: 0, curator: 1, librarian: 2, administrator: 3 };

declare global {
  namespace Express { interface Request { principal?: { subject: string; role: Role; libraries: string[]; claims: JWTPayload } } }
}

const enabled = process.env.AUTH_ENABLED?.toLowerCase() === "true";
const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
const audience = process.env.OIDC_AUDIENCE;
const groupsClaim = process.env.OIDC_GROUPS_CLAIM || "groups";
const roleGroups: Record<Role, string> = {
  viewer: process.env.OIDC_VIEWER_GROUP || "audioshelf-viewer",
  curator: process.env.OIDC_CURATOR_GROUP || "audioshelf-curator",
  librarian: process.env.OIDC_LIBRARIAN_GROUP || "audioshelf-librarian",
  administrator: process.env.OIDC_ADMIN_GROUP || "audioshelf-admin",
};
if (enabled && (!issuer || !audience)) throw new Error("AUTH_ENABLED requires OIDC_ISSUER and OIDC_AUDIENCE");
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet> | null> {
  if (!issuer) return null;
  if (jwks) return jwks;
  const configured = process.env.OIDC_JWKS_URI;
  if (configured) return (jwks = createRemoteJWKSet(new URL(configured)));
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!discovery.ok) throw new Error('OIDC discovery failed');
  const metadata = await discovery.json() as { jwks_uri?: string };
  if (!metadata.jwks_uri) throw new Error('OIDC discovery did not provide jwks_uri');
  return (jwks = createRemoteJWKSet(new URL(metadata.jwks_uri)));
}

export function authEnabled(): boolean { return enabled; }

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === "/webhooks/abs") { next(); return; }
  if (!enabled) { req.principal = { subject: "internal", role: "administrator", libraries: [], claims: {} }; next(); return; }
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !issuer || !audience) { res.status(401).json({ error: "Authentication required" }); return; }
  try {
    const keySet = await getJwks();
    if (!keySet) throw new Error('OIDC is not configured');
    const { payload } = await jwtVerify(token, keySet, { issuer, audience });
    const groups = Array.isArray(payload[groupsClaim]) ? payload[groupsClaim] as string[] : [];
    const role = (Object.keys(rank) as Role[]).filter((r) => groups.includes(roleGroups[r])).sort((a,b) => rank[b]-rank[a])[0];
    if (!role || !payload.sub) { res.status(403).json({ error: "AudioShelf access has not been assigned" }); return; }
    const libraries = Array.isArray(payload.audioshelf_libraries) ? payload.audioshelf_libraries.filter((v): v is string => typeof v === "string") : [];
    req.principal = { subject: payload.sub, role, libraries, claims: payload }; next();
  } catch { res.status(401).json({ error: "Invalid or expired access token" }); }
}

export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.principal || rank[req.principal.role] < rank[minimum]) { res.status(403).json({ error: "Insufficient permission" }); return; }
    next();
  };
}
