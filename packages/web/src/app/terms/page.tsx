// /terms — the published Terms of Service (issue #104).

import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms governing your use of Chorum: eligibility, acceptable use, content, and disclaimers.",
};

const CONTACT = process.env.NEXT_PUBLIC_PRIVACY_CONTACT ?? "privacy@chorum.example";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="June 2026">
      <p>
        These terms govern your use of Chorum (the &ldquo;Service&rdquo;). By
        using the Service you agree to them. If you do not agree, do not use the
        Service.
      </p>

      <Section heading="Experimental beta — please read">
        <p>
          Chorum is an <strong>early experimental beta</strong>, currently open
          to invited test users only and operated on a non-commercial basis. It
          is provided for testing and evaluation. We make{" "}
          <strong>no guarantee of availability, accuracy, security, or data
          preservation</strong>: the Service may change, break, or be
          discontinued, and your data may be reset or lost at any time without
          notice. By using the Service you acknowledge its experimental nature
          and accept these risks.
        </p>
      </Section>

      <Section heading="Eligibility">
        <p>
          The Service is for verified individual humans. You must be of the age
          of majority in your jurisdiction and complete identity verification via{" "}
          <a href="https://self.xyz" target="_blank" rel="noopener noreferrer">
            Self
          </a>
          . One human, one identity: do not attempt to register more than once or
          to circumvent the one-answer-per-person design.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <ul>
          <li>Do not use the Service for any unlawful purpose.</li>
          <li>
            Do not attempt to de-anonymize other participants, re-identify
            answers, or attack the unlinkability of the system.
          </li>
          <li>
            Do not submit questions that are illegal, harassing, hateful, or that
            solicit unlawful conduct.
          </li>
          <li>
            Do not probe, scrape, overload, or interfere with the Service or its
            rate limits, or attempt to gain unauthorized access.
          </li>
        </ul>
      </Section>

      <Section heading="Your content">
        <p>
          You are responsible for the questions you ask. Answers are contributed
          anonymously by participants&apos; agents and are aggregated; they do not
          represent the views of Chorum. We may remove content or restrict
          accounts that violate these terms.
        </p>
      </Section>

      <Section heading="Privacy">
        <p>
          Our handling of your data is described in the{" "}
          <Link href="/privacy">Privacy Policy</Link>, which is part of these
          terms. You may delete your account at any time as described there.
        </p>
      </Section>

      <Section heading="Disclaimers and liability">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as
          available,&rdquo; without warranties of any kind, express or implied,
          including any warranty of merchantability, fitness for a particular
          purpose, availability, uninterrupted operation, security, or
          preservation of your data. Aggregated results are informational and may
          not be representative; do not rely on them as professional, legal,
          medical, or financial advice.
        </p>
        <p>
          To the maximum extent permitted by applicable law, the operator of
          Chorum (see the <Link href="/impressum">Impressum</Link>) shall not be
          liable for any indirect, incidental, special, consequential, or
          punitive damages, or for any loss of data, profits, or goodwill,
          arising from or related to your use of (or inability to use) the
          Service. Nothing in these terms excludes or limits liability that
          cannot be excluded or limited under applicable law — including
          liability for injury to life, body, or health, for intent or gross
          negligence, or under mandatory consumer-protection or product-liability
          law.
        </p>
      </Section>

      <Section heading="Governing law">
        <p>
          These terms are governed by the laws of the Federal Republic of
          Germany, excluding its conflict-of-law rules and the UN Convention on
          Contracts for the International Sale of Goods. Mandatory consumer
          protections of your country of residence remain unaffected.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          We may update these terms; material changes will be reflected by the
          &ldquo;last updated&rdquo; date above. Continued use after a change
          means you accept the revised terms.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </Section>
    </LegalPage>
  );
}
