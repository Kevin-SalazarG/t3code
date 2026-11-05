import type { GarrsModelDecision, ModelSelection } from "@t3tools/contracts";

import { effectiveModelLabel, humanize } from "./garrs.logic";

function optionLabel(selection: ModelSelection): string | null {
  return (
    selection.options?.map((option) => `${option.id}: ${String(option.value)}`).join(" · ") || null
  );
}

export function GarrsDecisionDetails({
  decision,
  showEffectiveModel = true,
}: {
  readonly decision: GarrsModelDecision;
  readonly showEffectiveModel?: boolean;
}) {
  const options = optionLabel(decision.requested);
  const candidates = decision.candidates.slice(0, 30);
  return (
    <div className="space-y-2 break-words text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Requested account</dt>
        <dd>{decision.requested.instanceId}</dd>
        <dt className="text-muted-foreground">Requested model</dt>
        <dd>{decision.requested.model}</dd>
        {options ? (
          <>
            <dt className="text-muted-foreground">Options</dt>
            <dd>{options}</dd>
          </>
        ) : null}
        {showEffectiveModel ? (
          <>
            <dt className="text-muted-foreground">Effective model</dt>
            <dd>
              {effectiveModelLabel(decision)}
              {decision.effectiveModelSource === "provider_response" &&
              decision.effectiveModel !== null
                ? " · provider response confirmed"
                : ""}
            </dd>
          </>
        ) : null}
        {showEffectiveModel &&
        decision.effectiveModelSource === "provider_session" &&
        decision.effectiveModel !== null ? (
          <>
            <dt className="text-muted-foreground">Session metadata</dt>
            <dd>{decision.effectiveModel} · response identity unconfirmed</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Decision</dt>
        <dd>
          {humanize(decision.source)}
          {decision.fallbackUsed ? " · alternative used" : ""}
        </dd>
        <dt className="text-muted-foreground">Why</dt>
        <dd className="whitespace-pre-wrap">{decision.reason}</dd>
      </dl>
      {decision.userInstruction ? (
        <div className="space-y-1 border-l pl-3">
          <p className="font-medium">User instruction · source verified</p>
          <blockquote className="whitespace-pre-wrap">{decision.userInstruction.quote}</blockquote>
          <p className="text-muted-foreground">Message: {decision.userInstruction.messageId}</p>
          <p className="text-muted-foreground">
            T3 verified the quote's source. Garras interpreted the requested model and account.
          </p>
        </div>
      ) : null}
      {decision.constraints.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium text-muted-foreground">Restrictions and known limits</p>
          <ul className="list-disc space-y-1 pl-4">
            {decision.constraints.map((constraint, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- immutable decision snapshot
              <li key={index}>{constraint}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-muted-foreground">
            Candidates considered ({decision.candidates.length})
          </summary>
          <ul className="space-y-2 border-l pl-3">
            {candidates.map((candidate, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- candidates can share a model with different options
              <li key={index} className="space-y-0.5">
                <p>
                  {candidate.selection.instanceId} · {candidate.selection.model}
                </p>
                <p className="text-muted-foreground">
                  {candidate.available ? "Eligible" : "Unavailable"}: {candidate.note}
                </p>
                {optionLabel(candidate.selection) ? (
                  <p className="text-muted-foreground">{optionLabel(candidate.selection)}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {decision.candidates.length > candidates.length ? (
            <p className="text-muted-foreground">
              Showing the first {candidates.length} candidates in this decision.
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
