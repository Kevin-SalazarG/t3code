import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { FileCodeIcon } from "lucide-react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { DiffStatLabel } from "./DiffStatLabel";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { threadResultFiles } from "./threadResultFiles";

const MAX_RESULT_FILES = 8;

/** Files the agent edited in this thread. Hidden until it edits one. */
export function ThreadResultsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const items = useQuietThreadVisibleTurnItems(threadRef);
  const files = threadResultFiles(items);
  if (files.length === 0) return null;
  const root = props.workspaceRoot ?? undefined;
  const open = (path: string) => {
    useRightPanelStore
      .getState()
      .openFile(threadRef, workspaceRelativeFilePath(path, root) ?? path);
  };
  return (
    <ThreadDetailsSection headingId="thread-details-results-heading" title="Results">
      <ul className="m-0 list-none p-0">
        {files.slice(0, MAX_RESULT_FILES).map((file) => (
          <li key={file.path}>
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              title={formatWorkspaceRelativePath(file.path, root)}
              onClick={() => open(file.path)}
            >
              <FileCodeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/85">
                {fileBasename(file.path)}
              </span>
              {file.counted ? (
                <DiffStatLabel
                  additions={file.additions}
                  deletions={file.deletions}
                  layout="inline"
                  className="shrink-0 text-xs"
                />
              ) : null}
            </ThreadDetailsControl>
          </li>
        ))}
      </ul>
      {files.length > MAX_RESULT_FILES ? (
        <p className="m-0 px-2.5 pt-1 text-2xs text-muted-foreground">
          {files.length - MAX_RESULT_FILES} more files
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
