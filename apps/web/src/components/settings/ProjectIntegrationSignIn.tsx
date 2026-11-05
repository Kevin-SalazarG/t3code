import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectIntegrationSignInPrompt,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { supabaseIcon } from "@t3tools/client-runtime/state/project-integrations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { projectIntegrations } from "../../state/project-integrations";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SourceControlIconArtwork } from "../SourceControlIconArtwork";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";

type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly prompt: ProjectIntegrationSignInPrompt }
  | { readonly status: "failed"; readonly message: string };

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const githubIcon = sourceControlClients.get("github").icon;

export function IntegrationTitle({
  provider,
  children,
}: {
  readonly provider: "supabase" | "github";
  readonly children: ReactNode;
}) {
  const icon = provider === "supabase" ? supabaseIcon : githubIcon;
  return (
    <span className="flex items-center gap-2">
      {icon ? <SourceControlIconArtwork icon={icon} className="size-4 shrink-0" /> : null}
      {children}
    </span>
  );
}

export function ProjectIntegrationSignInRow({
  environmentId,
  projectId,
  provider,
  title,
  description,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly provider: "supabase" | "github";
  readonly title: string;
  readonly description: ReactNode;
  readonly disabled: boolean;
}) {
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const allowed = useAtomValue(projectIntegrations.signIn.permissionAtom(environmentId));
  const start = useAtomCommand(projectIntegrations.signIn, { reportFailure: false });
  const wait = useAtomCommand(projectIntegrations.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(projectIntegrations.cancelSignIn, { reportFailure: false });
  const [state, setState] = useState<SignInState>({ status: "idle" });
  const active = useRef<string | null>(null);
  const name = provider === "supabase" ? "Supabase" : "GitHub";

  const signIn = async () => {
    if (!baseUrl || active.current) return;
    active.current = "starting";
    setState({ status: "starting" });
    const started = await start({
      environmentId,
      input: {
        projectId,
        provider,
        redirectUri: new URL(
          "api/project-integrations/oauth/callback",
          baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
        ).href,
      },
    });
    if (started._tag === "Failure") {
      active.current = null;
      setState({
        status: "failed",
        message: failureMessage(squashAtomCommandFailure(started), "Could not start sign-in."),
      });
      return;
    }
    const prompt = started.value;
    active.current = prompt.id;
    setState({ status: "waiting", prompt });
    window.open(prompt.url, "_blank", "noopener,noreferrer");
    const finished = await wait({ environmentId, input: { projectId, id: prompt.id } });
    // A cancel or a newer attempt owns the state by now.
    if (active.current !== prompt.id) return;
    active.current = null;
    setState(
      finished._tag === "Failure"
        ? {
            status: "failed",
            message: failureMessage(
              squashAtomCommandFailure(finished),
              "Sign-in did not complete.",
            ),
          }
        : { status: "idle" },
    );
  };

  const waiting = state.status === "waiting" ? state.prompt : null;

  return (
    <SettingsRow
      title={<IntegrationTitle provider={provider}>{title}</IntegrationTitle>}
      description={waiting ? `Finish signing in to ${name} in your browser.` : description}
      status={
        waiting?.userCode ? (
          <span className="font-mono text-sm font-medium text-foreground">{waiting.userCode}</span>
        ) : state.status === "failed" ? (
          <span role="alert" className="text-destructive">
            {state.message}
          </span>
        ) : null
      }
      control={
        waiting ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                active.current = null;
                setState({ status: "idle" });
                void cancel({ environmentId, input: { projectId, id: waiting.id } });
              }}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="outline"
              render={<a href={waiting.url} target="_blank" rel="noreferrer noopener" />}
            >
              Open {name}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            disabled={disabled || !allowed || !baseUrl || state.status === "starting"}
            onClick={() => void signIn()}
          >
            {state.status === "starting" ? <Spinner /> : null}
            {state.status === "failed" ? "Try again" : `Sign in with ${name}`}
          </Button>
        )
      }
    />
  );
}
