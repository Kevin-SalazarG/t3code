import type { TurnTokenUsage } from "@t3tools/contracts";

export function GarrsProviderCost({ cost }: { readonly cost: TurnTokenUsage["reportedCost"] }) {
  if (cost === undefined) return <>Unknown</>;
  return (
    <span>
      ${cost.amountUsd.toFixed(6)} · {cost.status}
    </span>
  );
}
