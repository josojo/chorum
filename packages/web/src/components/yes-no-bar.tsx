// Back-compat shim. All real logic now lives in ./options-bar.tsx because
// questions can carry an arbitrary N-option list; yes/no is the 2-option
// special case. Existing call sites can keep importing YesNoLegend etc.

import {
  OptionsBar,
  OptionsCount,
  OptionsLegend,
  YES_GRADIENT as _YES_GRADIENT,
  NO_GRADIENT as _NO_GRADIENT,
} from "./options-bar";

export const YES_GRADIENT = _YES_GRADIENT;
export const NO_GRADIENT = _NO_GRADIENT;

const YES_NO_OPTIONS = ["yes", "no"] as const;

export function YesNoBar({
  yes,
  no,
  widthPct,
}: {
  yes: number;
  no: number;
  widthPct: number;
}) {
  return (
    <OptionsBar
      tally={{ yes, no }}
      options={YES_NO_OPTIONS}
      widthPct={widthPct}
    />
  );
}

export function YesNoCount({ yes, no }: { yes: number; no: number }) {
  return <OptionsCount tally={{ yes, no }} options={YES_NO_OPTIONS} />;
}

export function YesNoLegend() {
  return <OptionsLegend options={YES_NO_OPTIONS} />;
}
