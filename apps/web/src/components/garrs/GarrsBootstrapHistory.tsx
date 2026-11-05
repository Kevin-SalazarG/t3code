import type { GarrsBootstrapDecision } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { GarrsDecisionDetails } from "./GarrsDecisionDetails";
import { humanize } from "./garrs.logic";

export function GarrsBootstrapHistory({
  decisions,
}: {
  readonly decisions: ReadonlyArray<GarrsBootstrapDecision>;
}) {
  if (decisions.length === 0) return null;
  return (
    <details className="space-y-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Startup recovery history ({decisions.length})
      </summary>
      <ol className="space-y-3 border-l pl-3">
        {decisions.toReversed().map((entry) => (
          <li key={`${entry.runId}:${entry.attemptNumber}`} className="space-y-1 break-words">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Attempt {entry.attemptNumber}</span>
              <Badge variant={entry.status === "blocked" ? "warning" : "info"} size="sm">
                {humanize(entry.status)}
              </Badge>
              <span className="text-muted-foreground">
                {formatRelativeTimeLabel(entry.observedAt)}
              </span>
            </div>
            <p>
              Failed request: {entry.failedSelection.instanceId} · {entry.failedSelection.model}
            </p>
            <p className="text-muted-foreground">
              {humanize(entry.failure.class)}: {entry.failure.message}
            </p>
            <p>{entry.reason}</p>
            <p className="text-muted-foreground">
              {entry.status === "queued"
                ? "Accepted by T3's queue; provider start remains unconfirmed here."
                : entry.status === "selected"
                  ? "Alternative selected; acceptance by T3's queue is pending."
                  : "No permitted alternative was queued."}
            </p>
            {entry.queuedAt ? (
              <p className="text-muted-foreground">Queued: {entry.queuedAt}</p>
            ) : null}
            <p className="text-muted-foreground">User message: {entry.userMessageId}</p>
            {entry.decision ? (
              <details className="space-y-2">
                <summary className="cursor-pointer text-muted-foreground">Selected request</summary>
                <GarrsDecisionDetails decision={entry.decision} showEffectiveModel={false} />
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
