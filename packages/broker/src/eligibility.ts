// Question eligibility checks derived from signed delegation predicates.

function norm(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const stripped = value.trim();
  return stripped ? stripped.toUpperCase() : null;
}

export interface QuestionScope {
  scope?: string | null;
  country?: string | null;
  continent?: string | null;
}

// Whether this token is eligible to answer this question. v0 supports the
// geographic scopes in the questions table: worldwide, continent, country. The
// signed DelegationToken predicates are the trust source. We accept `continent`
// or legacy `region` for continent-level matching.
export function isScopeEligible(args: {
  question: QuestionScope;
  disclosedPredicates: Record<string, string>;
}): boolean {
  const scope = (args.question.scope ?? "worldwide").trim().toLowerCase();
  if (scope === "worldwide") return true;

  const country = norm(args.disclosedPredicates.country);
  const continent = norm(
    args.disclosedPredicates.continent ?? args.disclosedPredicates.region,
  );

  if (scope === "country") {
    const expectedCountry = norm(args.question.country);
    return Boolean(expectedCountry && country === expectedCountry);
  }

  if (scope === "continent") {
    const expectedContinent = norm(args.question.continent);
    return Boolean(expectedContinent && continent === expectedContinent);
  }

  return false;
}
