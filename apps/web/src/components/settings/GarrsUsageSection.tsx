import {
  GARRS_AGENT_IDS,
  ProviderInstanceId,
  type EnvironmentId,
  type GarrsUsageInput,
  type GarrsUsageRow,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery } from "../../state/query";
import {
  dateInputToIso,
  formatCount,
  formatDurationMs,
  humanize,
  reportedModelsLabel,
  usageRowsToCsv,
  usageRowsForExport,
  conversationUsageExport,
  conversationUsageRowsToCsv,
} from "../garrs/garrs.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { GarrsProviderCost } from "../garrs/GarrsProviderCost";

const ALL_PROJECTS = "all";
const LIMIT_OPTIONS = [100, 500, 1_000, 5_000] as const;

function download(filename: string, type: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Delay revocation so browsers can open the download stream.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function qualityVariant(quality: GarrsUsageRow["usage"]["quality"]) {
  if (quality === "reported") return "success";
  if (quality === "partial") return "warning";
  return "outline";
}

export function GarrsUsageSection({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}) {
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS);
  const filteredProject = projects.find((project) => project.id === projectFilter) ?? null;
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const filteredAgent = GARRS_AGENT_IDS.find((agent) => agent === agentFilter);
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [limit, setLimit] = useState<(typeof LIMIT_OPTIONS)[number]>(500);
  const sinceIso = dateInputToIso(since, "start");
  const untilIso = dateInputToIso(until, "end");
  const input: GarrsUsageInput = {
    limit,
    ...(filteredProject ? { projectId: filteredProject.id } : {}),
    ...(sinceIso ? { since: sinceIso } : {}),
    ...(untilIso ? { until: untilIso } : {}),
    ...(filteredAgent ? { agentId: filteredAgent } : {}),
    ...(providerFilter.trim()
      ? { providerInstanceId: ProviderInstanceId.make(providerFilter.trim()) }
      : {}),
    ...(modelFilter.trim() ? { model: modelFilter.trim() } : {}),
  };
  const query = useEnvironmentQuery(garrsEnvironment.usage({ environmentId, input }));
  const rows = query.data?.rows ?? [];
  return (
    <SettingsSection title="Usage" id="garrs-usage">
      <SettingsRow
        title="Attempts"
        description="One row per agent attempt. Unknown values were not reported. Native provider estimates and standard-price estimates are shown separately. Subscription charges remain unknown."
        control={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={query.error !== null || rows.length === 0}
              onClick={() =>
                download(
                  "garrs-usage.csv",
                  "text/csv",
                  `${usageRowsToCsv(rows, query.data?.truncated ?? false)}\n`,
                )
              }
            >
              CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={query.error !== null || rows.length === 0}
              onClick={() =>
                download(
                  "garrs-usage.json",
                  "application/json",
                  `${JSON.stringify({ rows: usageRowsForExport(rows), truncated: query.data?.truncated ?? false }, null, 2)}\n`,
                )
              }
            >
              JSON
            </Button>
          </>
        }
      >
        <p className="pb-3 text-xs text-muted-foreground">
          Native provider estimates cover query deltas reported by the CLI; partial values do not
          cover all queries. Standard-price estimates use tokens and the requested model. Neither
          value confirms a subscription charge. Parallel attempts have separate run times; these are
          not added together.
        </p>
        <div className="flex flex-wrap items-end gap-3 pb-3">
          <div className="space-y-1.5">
            <Label render={<div />}>Agent</Label>
            <Select value={agentFilter} onValueChange={(value) => setAgentFilter(value ?? "all")}>
              <SelectTrigger size="sm" aria-label="Agent">
                <SelectValue>
                  {agentFilter === "all" ? "All agents" : humanize(agentFilter)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="all">All agents</SelectItem>
                {GARRS_AGENT_IDS.map((agent) => (
                  <SelectItem key={agent} value={agent}>
                    {humanize(agent)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="garrs-usage-provider">Provider instance</Label>
            <Input
              id="garrs-usage-provider"
              size="sm"
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value)}
              placeholder="Exact instance ID"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="garrs-usage-model">Requested model</Label>
            <Input
              id="garrs-usage-model"
              size="sm"
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              placeholder="Exact model ID"
            />
          </div>
          <div className="space-y-1.5">
            <Label render={<div />}>Project</Label>
            <Select
              value={filteredProject?.id ?? ALL_PROJECTS}
              onValueChange={(value) => setProjectFilter(value ?? ALL_PROJECTS)}
            >
              <SelectTrigger size="sm" aria-label="Project">
                <SelectValue>{filteredProject?.title ?? "All projects"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="garrs-usage-since">From</Label>
            <Input
              id="garrs-usage-since"
              type="date"
              size="sm"
              value={since}
              onChange={(event) => setSince(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="garrs-usage-until">To</Label>
            <Input
              id="garrs-usage-until"
              type="date"
              size="sm"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label render={<div />}>Rows</Label>
            <Select
              value={String(limit)}
              onValueChange={(value) => {
                const next = LIMIT_OPTIONS.find((option) => String(option) === value);
                if (next) setLimit(next);
              }}
            >
              <SelectTrigger size="sm" aria-label="Rows">
                <SelectValue>{limit.toLocaleString("en-US")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {LIMIT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option.toLocaleString("en-US")}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        {query.error ? (
          <p className="pb-3 text-xs text-muted-foreground">Could not load usage: {query.error}</p>
        ) : query.data === null ? (
          <p className="pb-3 text-xs text-muted-foreground">Loading usage…</p>
        ) : rows.length === 0 ? (
          <p className="pb-3 text-xs text-muted-foreground">No attempts match these filters.</p>
        ) : (
          <div className="pb-3">
            {query.data.truncated ? (
              <p className="pb-2 text-xs text-muted-foreground">
                Showing the first {rows.length.toLocaleString("en-US")} attempts. Narrow the filters
                or raise the row limit to see more.
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Work item</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Requested account</TableHead>
                  <TableHead>Requested model</TableHead>
                  <TableHead>Effective model</TableHead>
                  <TableHead>Reported models</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Quality</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Cached</TableHead>
                  <TableHead>Cache write</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Reasoning</TableHead>
                  <TableHead>Turns</TableHead>
                  <TableHead>Queued</TableHead>
                  <TableHead>Ran</TableHead>
                  <TableHead>Standard-price estimate</TableHead>
                  <TableHead>Native provider estimate</TableHead>
                  <TableHead>Subscription charge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.attemptId}>
                    <TableCell>
                      {new Date(row.startedAt ?? row.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {projects.find((project) => project.id === row.projectId)?.title ??
                        row.projectId}
                    </TableCell>
                    <TableCell>{row.workItemTitle}</TableCell>
                    <TableCell>
                      {humanize(row.agentId)}
                      {row.helper ? " (temporary helper)" : ""}
                    </TableCell>
                    <TableCell>
                      {row.taskId}
                      {row.helper ? (
                        <div>
                          Requested by task {row.helper.parentTaskId}, attempt{" "}
                          {row.helper.parentAttemptId}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>{row.attemptId}</TableCell>
                    <TableCell>{row.providerInstanceId}</TableCell>
                    <TableCell>{row.model}</TableCell>
                    <TableCell>{row.effectiveModel ?? "Not verifiable"}</TableCell>
                    <TableCell>{reportedModelsLabel(row.usage)}</TableCell>
                    <TableCell>{humanize(row.status)}</TableCell>
                    <TableCell>
                      <Badge variant={qualityVariant(row.usage.quality)} size="sm">
                        {humanize(row.usage.quality)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatCount(row.usage.inputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.cachedInputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.cacheCreationTokens ?? null)}</TableCell>
                    <TableCell>{formatCount(row.usage.outputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.reasoningOutputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.providerTurns)}</TableCell>
                    <TableCell>{formatDurationMs(row.usage.queueWaitMs)}</TableCell>
                    <TableCell>{formatDurationMs(row.usage.runDurationMs)}</TableCell>
                    <TableCell>
                      {row.estimatedCostUsd == null
                        ? "Unknown"
                        : `$${row.estimatedCostUsd.toFixed(6)} (${row.estimatePriceSource ?? "unknown"})`}
                    </TableCell>
                    <TableCell>
                      <GarrsProviderCost cost={row.usage.reportedCost} />
                    </TableCell>
                    <TableCell>Unknown</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        title="Garras conversations"
        description="Each row is a conversation run; work-item attribution is unavailable. Filters apply to both tables. Provider and standard-price estimates are separate; subscription charges are unknown."
        control={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={query.error !== null || !query.data?.conversations?.length}
              onClick={() =>
                download(
                  "garras-conversations.csv",
                  "text/csv",
                  `${conversationUsageRowsToCsv(query.data?.conversations ?? [], query.data?.conversationsTruncated ?? null, query.data?.conversationEvidenceTruncated ?? null)}\n`,
                )
              }
            >
              CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={query.error !== null || !query.data?.conversations?.length}
              onClick={() =>
                download(
                  "garras-conversations.json",
                  "application/json",
                  `${JSON.stringify(conversationUsageExport(query.data?.conversations ?? [], query.data?.conversationsTruncated ?? null, query.data?.conversationEvidenceTruncated ?? null), null, 2)}\n`,
                )
              }
            >
              JSON
            </Button>
          </>
        }
      >
        {query.data?.conversationEvidenceTruncated ? (
          <p className="pb-2 text-xs text-muted-foreground" role="status">
            Some turn data was omitted; usage is partial. Narrow the filters.
          </p>
        ) : null}
        {query.data?.conversations !== undefined &&
        query.data.conversationEvidenceTruncated === undefined ? (
          <p className="pb-2 text-xs text-muted-foreground">
            The environment did not report whether all turn data was included.
          </p>
        ) : null}
        {query.error ? (
          <p className="pb-3 text-xs text-muted-foreground">
            Could not load conversation usage: {query.error}
          </p>
        ) : query.data === null ? (
          <p className="pb-3 text-xs text-muted-foreground">Loading conversation usage…</p>
        ) : query.data.conversations === undefined ? (
          <p className="pb-3 text-xs text-muted-foreground">
            Conversation usage is unavailable from this environment.
          </p>
        ) : query.data.conversations.length === 0 ? (
          <p className="pb-3 text-xs text-muted-foreground">
            No conversation runs match these filters.
          </p>
        ) : (
          <div className="pb-3">
            {query.data.conversationsTruncated ? (
              <p className="pb-2 text-xs text-muted-foreground">
                Showing the first {query.data.conversations.length.toLocaleString("en-US")}{" "}
                conversation runs. Narrow the filters or raise the row limit to see more.
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Conversation</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Requested account</TableHead>
                  <TableHead>Requested model</TableHead>
                  <TableHead>Effective model</TableHead>
                  <TableHead>Reported models</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Quality</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Cached</TableHead>
                  <TableHead>Cache write</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Reasoning</TableHead>
                  <TableHead>Turns</TableHead>
                  <TableHead>Queued</TableHead>
                  <TableHead>Ran</TableHead>
                  <TableHead>Standard-price estimate</TableHead>
                  <TableHead>Native provider estimate</TableHead>
                  <TableHead>Subscription charge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.conversations.map((row) => (
                  <TableRow key={`${row.threadId}:${row.runId}`}>
                    <TableCell>
                      {new Date(row.startedAt ?? row.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {projects.find((project) => project.id === row.projectId)?.title ??
                        row.projectId}
                    </TableCell>
                    <TableCell>{row.threadId}</TableCell>
                    <TableCell>{row.runId}</TableCell>
                    <TableCell>{row.providerInstanceId}</TableCell>
                    <TableCell>{row.model}</TableCell>
                    <TableCell>{row.effectiveModel ?? "Not verifiable"}</TableCell>
                    <TableCell>{reportedModelsLabel(row.usage)}</TableCell>
                    <TableCell>{humanize(row.status)}</TableCell>
                    <TableCell>
                      <Badge variant={qualityVariant(row.usage.quality)} size="sm">
                        {humanize(row.usage.quality)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatCount(row.usage.inputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.cachedInputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.cacheCreationTokens ?? null)}</TableCell>
                    <TableCell>{formatCount(row.usage.outputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.reasoningOutputTokens)}</TableCell>
                    <TableCell>{formatCount(row.usage.providerTurns)}</TableCell>
                    <TableCell>{formatDurationMs(row.usage.queueWaitMs)}</TableCell>
                    <TableCell>{formatDurationMs(row.usage.runDurationMs)}</TableCell>
                    <TableCell>
                      {row.estimatedCostUsd == null
                        ? "Unknown"
                        : `$${row.estimatedCostUsd.toFixed(6)} (${row.estimatePriceSource ?? "unknown"})`}
                    </TableCell>
                    <TableCell>
                      <GarrsProviderCost cost={row.usage.reportedCost} />
                    </TableCell>
                    <TableCell>Unknown</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
