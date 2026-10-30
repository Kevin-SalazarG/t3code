import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  titleTooltip = false,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
  titleTooltip?: boolean;
}) {
  const heading = (
    <h3
      id={headingId}
      tabIndex={titleTooltip ? 0 : undefined}
      className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
    >
      {title}
    </h3>
  );
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      // A row can still render nothing (a fresh draft quiets Git actions), so an empty section
      // collapses, and a divider only follows a section that has content.
      className={cn(
        "px-2 pt-2 pb-2.5 has-[>div:last-child:empty]:hidden",
        separated && "border-border/65 [section:not(:has(>div:last-child:empty))~&]:border-t",
      )}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-2.5",
          !showHeading && "hidden",
        )}
      >
        {titleTooltip ? (
          <Tooltip>
            <TooltipTrigger render={heading} />
            <TooltipPopup side="left" sideOffset={16}>
              {title}
            </TooltipPopup>
          </Tooltip>
        ) : (
          heading
        )}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
