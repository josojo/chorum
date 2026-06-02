"use server";

// /ask server action.
//
// Inserts an asker display row and a question, then redirects to /q/[id].
// The web role is allowed INSERT on `askers` and `questions` only (see
// db/init/02-roles.sh).
//
// This action MUST NOT write to envelopes or aggregates. The DB grants
// enforce that, but we don't even attempt it here.
//
// Pure validation lives in ./validate-question.ts so non-server code can
// import it (the "use server" rule forces every export of this module to
// be an async function).
//
// Spam mitigation: per-IP sliding-window cap on question creation. Asker auth
// is deferred to v0.2 (ARCHITECTURE §11) so the display name is freely chosen
// and unusable as an identifier — the IP, behind Caddy, is the only stable
// per-client signal. See `lib/rate-limit.ts` for the policy + caveats.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db/client";
import { askers, questions } from "@/db/schema";
import { checkRateLimit, clientIdFromHeaders } from "@/lib/rate-limit";
import { checkAskerEligibility, checkAskerSession } from "@/lib/asker-auth";
import {
  validateCreateQuestion,
  type CreateQuestionInput,
} from "./validate-question";

// Asker auth gate (ARCHITECTURE_V0.md §14.2): require a verified participant
// credential to open a question. On by default; set ASKER_AUTH_REQUIRED=false
// for local demos with no broker / onboarding, in which case asks are anonymous
// (unique_identifier stays NULL) exactly as in pre-gate v0.
function askerAuthRequired(): boolean {
  return (process.env.ASKER_AUTH_REQUIRED ?? "true") !== "false";
}

export type CreateQuestionResult =
  | { ok: true; questionId: string }
  | { ok: false; errors: Record<string, string> };

/**
 * Pure DB insertion helper. Exposed so tests can exercise the happy path
 * without going through the form-action signature.
 */
export async function createQuestion(
  input: CreateQuestionInput,
  dbi: typeof db = db,
  uniqueIdentifier: string | null = null,
): Promise<{ questionId: string }> {
  // v0 display names are not identity. Create one display row per question
  // so two humans choosing the same name are not collapsed together. When the
  // asker authenticated (§15.3), stamp their verified Self nullifier on the row;
  // it comes from the broker, never from user input.
  const askerRows = await dbi
    .insert(askers)
    .values({ displayName: input.displayName, uniqueIdentifier })
    .returning({ id: askers.id });
  const askerId = askerRows[0].id;

  const inserted = await dbi
    .insert(questions)
    .values({
      askerId,
      text: input.text,
      // topic is deliberately NOT set here. The classifier service
      // (packages/classifier) assigns it from the question text after insert.
      // Until it has, list_open_questions on the broker filters this row out,
      // so the asker can't bypass the skill's sensitive-topic gate. See
      // ARCHITECTURE_V0.md and packages/proto/topics.json for the taxonomy.
      options: input.options,
      closesAt: input.closesAt,
      scope: input.scope,
      country: input.country,
      continent: input.continent,
      // status defaults to 'open'; nonce defaults to a random base64 blob.
    })
    .returning({ id: questions.id });

  return { questionId: inserted[0].id };
}

/**
 * Server action invoked by `<form action={...}>`. Validates the FormData,
 * inserts the row, then redirects.
 */
export async function createQuestionAction(
  _prevState: unknown,
  formData: FormData,
): Promise<CreateQuestionResult> {
  // Per-IP rate limit BEFORE validation/DB work: a flooder that sends bogus
  // forms shouldn't burn DB writes or validation cycles. The "_form" pseudo
  // field surfaces this as a form-level error rather than under any one input.
  const requestHeaders = await headers();
  const limit = checkRateLimit(clientIdFromHeaders(requestHeaders));
  if (!limit.ok) {
    return {
      ok: false,
      errors: {
        _form: `Too many questions from this address. Try again in ${limit.retryAfterSeconds}s.`,
      },
    };
  }

  const closesAtIso = (formData.get("closesAtIso") ?? "").toString();
  const closesAtRaw = (formData.get("closesAt") ?? "").toString();
  const parsedDate = closesAtIso
    ? new Date(closesAtIso)
    : closesAtRaw
      ? new Date(closesAtRaw)
      : null;

  const scopeRaw = (formData.get("scope") ?? "worldwide").toString();
  const countryRaw = (formData.get("country") ?? "").toString();
  const continentRaw = (formData.get("continent") ?? "").toString();
  // The form renders one <input name="options"> per row, so getAll() gives us
  // the option list in DOM order.
  const optionsRaw = formData
    .getAll("options")
    .map((o) => (o == null ? "" : o.toString()));

  const parsed = validateCreateQuestion({
    displayName: (formData.get("displayName") ?? "").toString(),
    text: (formData.get("text") ?? "").toString(),
    // No `topic` field: the asker no longer chooses it; the classifier does.
    options: optionsRaw,
    closesAt: parsedDate ?? undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scope: scopeRaw as any,
    country: countryRaw,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    continent: continentRaw as any,
  });

  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }

  // Asker gate (§15.3). Runs AFTER form validation (cheap, local) so a malformed
  // form never burns a broker round-trip. The broker re-verifies the credential
  // and reports the asker's identity + whether they've earned the right to ask.
  // Two credential types, both re-checked server-side here (the browser cannot
  // forge either): an asker session from a "Sign in with Self" login (the
  // default web path) or a pasted DelegationToken (the agent path). No
  // credential + auth required ⇒ blocked. The session field carries the gate
  // error since that's what the form posts.
  let uniqueIdentifier: string | null = null;
  const sessionRaw = (formData.get("askerSession") ?? "").toString().trim();
  const tokenRaw = (formData.get("delegationToken") ?? "").toString().trim();
  if (sessionRaw) {
    const auth = await checkAskerSession(sessionRaw);
    if (!auth.ok) {
      return { ok: false, errors: { askerSession: auth.message } };
    }
    uniqueIdentifier = auth.uniqueIdentifier;
  } else if (tokenRaw) {
    const auth = await checkAskerEligibility(tokenRaw);
    if (!auth.ok) {
      return { ok: false, errors: { delegationToken: auth.message } };
    }
    uniqueIdentifier = auth.uniqueIdentifier;
  } else if (askerAuthRequired()) {
    return {
      ok: false,
      errors: {
        askerSession:
          "Asking requires verification. Verify you're a unique human with Self, or paste the DelegationToken your agent received when it onboarded.",
      },
    };
  }

  const { questionId } = await createQuestion(parsed.value, db, uniqueIdentifier);

  // Force the home feed to refetch so the new question shows up immediately.
  revalidatePath("/");
  redirect(`/q/${questionId}`);
}
