import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GarrsMemoryEntry, ProjectId } from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { humanize } from "../garrs/garrs.logic";
import { commandFailureMessage, toastCommandFailure } from "../garrs/useGarrsCommand";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type MemoryKind = GarrsMemoryEntry["kind"];
const MEMORY_KINDS: ReadonlyArray<MemoryKind> = [
  "fact",
  "decision",
  "preference",
  "hypothesis",
  "obsolete",
];

interface MemoryDraft {
  readonly id: GarrsMemoryEntry["id"] | undefined;
  readonly kind: MemoryKind;
  readonly body: string;
  readonly provenance: string;
  readonly scope: string;
}

export function GarrsMemorySection({
  environmentId,
  project,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: { readonly id: ProjectId; readonly title: string };
}) {
  const query = useEnvironmentQuery(
    garrsEnvironment.memory({ environmentId, input: { projectId: project.id } }),
  );
  const canMutate = useAtomValue(garrsEnvironment.mutateMemory.permissionAtom(environmentId));
  const mutate = useAtomCommand(garrsEnvironment.mutateMemory, {
    label: "garrs memory mutate",
    reportFailure: false,
  });
  const [editing, setEditing] = useState<MemoryDraft | null>(null);
  const remove = async (entry: GarrsMemoryEntry) => {
    const confirmed =
      (await requestConfirmDialog("Delete this memory?", { variant: "destructive" })) ??
      window.confirm("Delete this memory?");
    if (!confirmed) return;
    const result = await mutate({
      environmentId,
      input: { type: "delete", id: entry.id, projectId: entry.projectId },
    });
    if (result._tag === "Failure") toastCommandFailure("Could not delete memory", result);
  };
  const entries = query.data?.entries ?? [];
  return (
    <SettingsSection
      title={`Memory · ${project.title}`}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canMutate}
          onClick={() =>
            setEditing({ id: undefined, kind: "fact", body: "", provenance: "user", scope: "" })
          }
        >
          <PlusIcon className="size-3" />
          Add memory
        </Button>
      }
    >
      {query.error ? (
        <SettingsRow title="Could not load memory" description={query.error} />
      ) : query.data === null ? (
        <SettingsRow title="Loading memory…" />
      ) : entries.length === 0 ? (
        <SettingsRow
          title="No memory yet"
          description="Facts, decisions and preferences the team keeps about this project."
        />
      ) : (
        entries.map((entry) => (
          <SettingsRow
            key={entry.id}
            title={<span className="whitespace-pre-wrap">{entry.body}</span>}
            description={[entry.provenance, entry.scope].filter(Boolean).join(" · ") || undefined}
            status={
              <Badge variant={entry.kind === "obsolete" ? "outline" : "info"} size="sm">
                {humanize(entry.kind)}
              </Badge>
            }
            control={
              <>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Edit memory"
                  disabled={!canMutate}
                  onClick={() =>
                    setEditing({
                      id: entry.id,
                      kind: entry.kind,
                      body: entry.body,
                      provenance: entry.provenance,
                      scope: entry.scope,
                    })
                  }
                >
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label="Delete memory"
                  disabled={!canMutate}
                  onClick={() => void remove(entry)}
                >
                  <Trash2Icon />
                </Button>
              </>
            }
          />
        ))
      )}
      {editing ? (
        <MemoryDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const result = await mutate({
              environmentId,
              input: {
                type: "upsert",
                ...(draft.id ? { id: draft.id } : {}),
                projectId: project.id,
                kind: draft.kind,
                body: draft.body,
                provenance: draft.provenance,
                scope: draft.scope,
              },
            });
            if (result._tag === "Success") setEditing(null);
            return commandFailureMessage(result);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function MemoryDialog({
  initial,
  onClose,
  onSave,
}: {
  readonly initial: MemoryDraft;
  readonly onClose: () => void;
  readonly onSave: (draft: MemoryDraft) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={async (event) => {
            event.preventDefault();
            if (draft.body.trim().length === 0 || saving) return;
            setSaving(true);
            const message = await onSave({ ...draft, body: draft.body.trim() });
            setSaving(false);
            setError(message);
          }}
        >
          <DialogHeader>
            <DialogTitle>{initial.id ? "Edit memory" : "Add memory"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-1.5">
              <Label render={<div />}>Kind</Label>
              <Select
                value={draft.kind}
                onValueChange={(value) => {
                  const kind = MEMORY_KINDS.find((entry) => entry === value);
                  if (kind) setDraft((current) => ({ ...current, kind }));
                }}
              >
                <SelectTrigger size="sm" aria-label="Kind">
                  <SelectValue>{humanize(draft.kind)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {MEMORY_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {humanize(kind)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="garrs-memory-body">Memory</Label>
              <Textarea
                id="garrs-memory-body"
                value={draft.body}
                maxLength={2_000}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, body: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="garrs-memory-provenance">Source</Label>
              <Input
                id="garrs-memory-provenance"
                value={draft.provenance}
                maxLength={2_000}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, provenance: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="garrs-memory-scope">Applies to</Label>
              <Input
                id="garrs-memory-scope"
                value={draft.scope}
                maxLength={2_000}
                placeholder="e.g. apps/web"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, scope: event.target.value }))
                }
              />
            </div>
            {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Close</DialogClose>
            <Button type="submit" disabled={saving || draft.body.trim().length === 0}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
