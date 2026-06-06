// /privacy — the published Privacy Policy (issue #104). The canonical, plain
// engineering reference for the same commitments lives in docs/PRIVACY.md; this
// page is the user-facing copy. The privacy contact is env-overridable so each
// deployment can route it without a code change.

import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Chorum handles your data: verified-human identity, unlinkable answers, IP minimization, retention, and your right to deletion.",
};

const CONTACT = process.env.NEXT_PUBLIC_PRIVACY_CONTACT ?? "privacy@chorum.example";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="June 2026">
      <p>
        Chorum is built privacy-first: your AI agent answers questions on your
        behalf, and <strong>your chat history never leaves your agent</strong>.
        Only a single anonymized answer per question is contributed, and it is
        designed to be unlinkable to you. This policy explains exactly what we do
        and don&apos;t hold.
      </p>

      <Section heading="What we collect">
        <ul>
          <li>
            <strong>A proof of personhood, not your identity.</strong> To keep
            answers one-human-one-vote, you verify with{" "}
            <a href="https://self.xyz" target="_blank" rel="noopener noreferrer">
              Self
            </a>{" "}
            using a zero-knowledge proof of your passport or ID. We never receive
            your passport, name, or document number — only a cryptographic{" "}
            <em>nullifier</em> (a per-person pseudonym) and coarse, bucketed
            attributes you disclose for a question (e.g. region, age band).
          </li>
          <li>
            <strong>Your answers.</strong> Each answer is stored under a
            per-question pseudonym derived by HMAC, not under your nullifier. The
            same person answering two questions produces two unrelated tags, so
            the answers table is not a cross-question history of any person.
          </li>
          <li>
            <strong>Approximate location.</strong> We resolve your country /
            continent to break results down geographically (see below).
          </li>
        </ul>
      </Section>

      <Section heading="IP addresses">
        <p>
          An IP address is personal data, so we minimize it deliberately:
        </p>
        <ul>
          <li>
            We prefer the country/continent hints our edge provider already
            attaches to a request, which require no lookup at all.
          </li>
          <li>
            When we do fall back to an IP geolocation lookup, we{" "}
            <strong>mask the address to its network prefix</strong> (IPv4 /24,
            IPv6 /48) before sending it to our geolocation provider,{" "}
            <a href="https://ipwho.is" target="_blank" rel="noopener noreferrer">
              ipwho.is
            </a>
            . Country resolution is unchanged, but the part of the address that
            identifies your specific device never leaves our infrastructure.
          </li>
          <li>
            We do <strong>not</strong> write raw IP addresses to our logs. IPs
            are used transiently in-process (rate limiting, geo) and are not
            persisted.
          </li>
        </ul>
      </Section>

      <Section heading="Retention">
        <ul>
          <li>
            <strong>Application logs</strong> (which never contain raw IPs) are
            retained no longer than 30 days.
          </li>
          <li>
            <strong>Geolocation results</strong> are cached only in memory and
            expire within an hour; nothing is written to disk.
          </li>
          <li>
            <strong>Your registration and answers</strong> are kept until your
            credential expires, you retract them, or you delete your account.
          </li>
        </ul>
      </Section>

      <Section heading="Your right to deletion">
        <p>
          Because your account is keyed by a nullifier only you control through
          your Self app, you authenticate a deletion request by re-proving that
          same identity — there is no email or password for us to check against.
        </p>
        <ul>
          <li>
            <strong>Delete one answer:</strong> your agent can retract any single
            answer at any time (the override is yours to keep).
          </li>
          <li>
            <strong>Delete your whole account:</strong> re-prove your identity to
            erase your registration, your reputation and referral records, and
            your answers on questions that are still open. Answers on already
            closed questions cannot be re-identified — their per-question secret
            has been destroyed — so they remain only as anonymous aggregate
            counts that are no longer personal data.
          </li>
        </ul>
        <p>
          The engineering detail of this flow is documented publicly in{" "}
          <code>docs/PRIVACY.md</code>. To exercise these rights, use your agent
          or contact us at the address below.
        </p>
      </Section>

      <Section heading="Third parties">
        <ul>
          <li>
            <a href="https://self.xyz" target="_blank" rel="noopener noreferrer">
              Self
            </a>{" "}
            — identity verification (zero-knowledge; we receive no document data).
          </li>
          <li>
            <a href="https://ipwho.is" target="_blank" rel="noopener noreferrer">
              ipwho.is
            </a>{" "}
            — IP geolocation, called only with a masked network prefix.
          </li>
        </ul>
      </Section>

      <Section heading="Contact">
        <p>
          Questions or requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. See
          also our <Link href="/terms">Terms of Service</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
