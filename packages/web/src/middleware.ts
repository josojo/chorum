// Optional site-wide HTTP Basic Auth gate for the invited beta.
//
// Controlled entirely by env (rendered from SSM via the per-env overlays):
//   SITE_GATE_USER + SITE_GATE_PASSWORD set  -> login required
//   either unset / empty                     -> site is public
//
// Gates only the Next.js web UI. Caddy routes /self/* and /v1/* to other
// containers, which never reach this middleware, so the Self callback and the
// agent API stay open regardless. /api/healthz is excluded so the container
// liveness probe (which sends no credentials) isn't blocked.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/healthz).*)"],
};

// Compare without an early-out on the first differing byte, to avoid leaking
// the secret via timing. A length difference alone fails. (charCodeAt past the
// end is NaN, which coerces to 0 in the bitwise XOR — harmless, since the
// length mismatch already forces a non-zero result.)
function safeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function middleware(req: NextRequest) {
  const user = process.env.SITE_GATE_USER;
  const pass = process.env.SITE_GATE_PASSWORD;

  // Opt-in: the gate is only enforced when BOTH are configured and non-empty.
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice("Basic ".length));
    } catch {
      decoded = "";
    }
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      // Compute both before AND-ing so a wrong username doesn't short-circuit
      // the password check.
      const userOk = safeEqual(decoded.slice(0, sep), user);
      const passOk = safeEqual(decoded.slice(sep + 1), pass);
      if (userOk && passOk) return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Chorum beta", charset="UTF-8"' },
  });
}
