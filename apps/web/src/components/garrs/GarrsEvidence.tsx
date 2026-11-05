import type { GarrsPreparationCheck, GarrsVerificationCheck } from "@t3tools/contracts";
import { humanize } from "./garrs.logic";

export function PreparationEvidence({
  checks,
}: {
  readonly checks: ReadonlyArray<GarrsPreparationCheck>;
}) {
  return (
    <ul className="space-y-2 text-xs text-muted-foreground">
      {checks.map((check) => (
        <li key={`${check.projectId}:${check.message}`}>
          <span className="font-medium">{humanize(check.status)}</span> · {check.message}
        </li>
      ))}
    </ul>
  );
}

export function VerificationEvidence({
  checks,
}: {
  readonly checks: ReadonlyArray<GarrsVerificationCheck>;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">Reported verification</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {checks.map((check) => (
          <li key={`${check.name}:${check.status}:${check.evidence}`}>
            <span className="font-medium">
              {check.name} · {humanize(check.status)}
            </span>
            <p className="break-words">{check.evidence}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
