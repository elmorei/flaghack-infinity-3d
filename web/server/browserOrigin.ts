/** Browser origin checks shared by HTTP discovery and WebSocket admission. */
import type { IncomingMessage } from 'node:http';

/**
 * Only serialized HTTP(S) origins are accepted, never wildcard rules, credentials or URL paths.
 * Browser Origin headers use exactly this form. Requiring it also rejects opaque `null` origins
 * and multiple joined headers rather than accidentally treating one as trusted.
 */
function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !value.includes('*') && value === url.origin ? url : null;
  } catch {
    return null;
  }
}

/** Fail at startup for an unsafe/mistyped allowlist instead of silently opening access. */
export function browserOriginPolicy(origins: readonly string[] = []): (req: IncomingMessage) => boolean {
  const allowed = new Set<string>();
  for (const origin of origins) {
    if (!parseOrigin(origin)) throw new Error(`Invalid allowed browser origin: ${origin}. Use an exact http(s) origin without a path or wildcard.`);
    allowed.add(origin);
  }
  return (req) => {
    const raw = req.headers.origin;
    // Native clients and CLI/test tools have no browser Origin. Password/build checks still apply.
    if (raw === undefined) return true;
    const origin = parseOrigin(raw);
    if (!origin) return false;
    if (allowed.has(raw)) return true;

    // Directly served clients remain supported. A reverse proxy must preserve the public Host,
    // or its public browser origin must be explicitly allowed. Never trust forwarded-host/proto.
    // The public scheme can be HTTPS even though the proxy's final hop to this server is HTTP.
    const host = req.headers.host;
    if (!host || /[\s/@\\?#*]/.test(host)) return false;
    try {
      return new URL(`${origin.protocol}//${host}`).origin === origin.origin;
    } catch {
      return false;
    }
  };
}
