// /impressum — German imprint (Impressumspflicht, § 5 DDG and § 18 MStV).
//
// German law requires a readily available imprint for telemedia that are "not
// exclusively personal or family" purposes. While this beta is invited-only and
// non-commercial, we publish an imprint to be safe and to name the responsible
// operator that the Terms and Privacy Policy refer to.
//
// IMPORTANT: a legally valid Impressum for an individual operator must show a
// REAL name and a REAL postal address at which you can be served (a P.O. box is
// not sufficient), plus a means of fast electronic contact (email). Set these
// per-deployment via the runtime env vars IMPRESSUM_NAME / IMPRESSUM_ADDRESS /
// IMPRESSUM_EMAIL / IMPRESSUM_PHONE (see docker-compose.yml passthrough). They
// are read SERVER-SIDE at request time (force-dynamic below) so your real
// address lives only in each box's gitignored .env — never in the repo, the
// client bundle, or the Docker image. The placeholder defaults are NOT legally
// sufficient and must be replaced before the site is reachable outside your
// private test circle. Newlines in IMPRESSUM_ADDRESS may be written as "\n".

import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Impressum",
  description: "Imprint and responsible operator of Chorum (§ 5 DDG, § 18 MStV).",
};

// Read server-side at request time so the values come from the running
// container's env, not from `next build`. Without this the page would be
// statically prerendered and the address baked in at build time.
export const dynamic = "force-dynamic";

export default function ImpressumPage() {
  // `||` (not `??`): the compose passthrough sets these to "" when unset, and an
  // empty string should fall back to the placeholder, not render blank.
  const NAME = process.env.IMPRESSUM_NAME || "[Your full name]";
  const ADDRESS = (
    process.env.IMPRESSUM_ADDRESS ||
    "[Street and number]\n[Postal code and city]\nGermany"
  ).replace(/\\n/g, "\n");
  const EMAIL =
    process.env.IMPRESSUM_EMAIL ||
    process.env.NEXT_PUBLIC_PRIVACY_CONTACT ||
    "service@chorum.org";
  const PHONE = process.env.IMPRESSUM_PHONE || null;

  return (
    <LegalPage title="Impressum" updated="June 2026">
      <p>
        Information pursuant to § 5 DDG (Digitale-Dienste-Gesetz) and § 18 (2)
        MStV.
      </p>

      <Section heading="Operator">
        <p style={{ whiteSpace: "pre-line" }}>
          {NAME}
          {"\n"}
          {ADDRESS}
        </p>
        <p>
          Chorum is operated by the above individual on a non-commercial,
          experimental basis. It is not (yet) operated by a registered company,
          so there is no commercial register entry or VAT ID.
        </p>
      </Section>

      <Section heading="Contact">
        <ul>
          <li>
            Email: <a href={`mailto:${EMAIL}`}>{EMAIL}</a>
          </li>
          {PHONE ? <li>Phone: {PHONE}</li> : null}
        </ul>
      </Section>

      <Section heading="Responsible for content (§ 18 (2) MStV)">
        <p style={{ whiteSpace: "pre-line" }}>
          {NAME}
          {"\n"}
          {ADDRESS}
        </p>
      </Section>

      <Section heading="Online dispute resolution">
        <p>
          The European Commission provides a platform for online dispute
          resolution (ODR):{" "}
          <a
            href="https://ec.europa.eu/consumers/odr"
            target="_blank"
            rel="noopener noreferrer"
          >
            ec.europa.eu/consumers/odr
          </a>
          . We are neither obliged nor willing to participate in dispute
          resolution proceedings before a consumer arbitration board.
        </p>
      </Section>

      <Section heading="Liability and privacy">
        <p>
          For disclaimers and limitations of liability see our{" "}
          <Link href="/terms">Terms of Service</Link>; for data processing see
          our <Link href="/privacy">Privacy Policy</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
