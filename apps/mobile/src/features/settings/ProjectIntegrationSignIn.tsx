import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectIntegrationSignInPrompt,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { supabaseIcon } from "@t3tools/client-runtime/state/project-integrations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useRef, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import { projectIntegrations } from "../../state/project-integrations";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SourceControlIcon } from "../projects/SourceControlIcon";
import { SettingsRow } from "./components/SettingsRow";

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Sign-in did not complete.";

const githubIcon = sourceControlClients.get("github").icon;

export function IntegrationMark(props: { readonly provider: "supabase" | "github" }) {
  return (
    <SourceControlIcon
      icon={props.provider === "supabase" ? supabaseIcon : githubIcon}
      size={Platform.OS === "android" ? 24 : 20}
      colorClassName="accent-icon"
    />
  );
}

const openUrl = (url: string) => void Linking.openURL(url).catch(() => undefined);

export function ProjectIntegrationSignInRow({
  environmentId,
  projectId,
  provider,
  label,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly provider: "supabase" | "github";
  readonly label: string;
  readonly disabled: boolean;
}) {
  const connection = usePreparedConnection(environmentId);
  const baseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const allowed = useAtomValue(projectIntegrations.signIn.permissionAtom(environmentId));
  const start = useAtomCommand(projectIntegrations.signIn, { reportFailure: false });
  const wait = useAtomCommand(projectIntegrations.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(projectIntegrations.cancelSignIn, { reportFailure: false });
  // The attempt a pending `wait` belongs to; a cancel or a newer attempt makes its outcome stale.
  const attempt = useRef<ProjectIntegrationSignInPrompt | null>(null);
  const [pending, setPending] = useState<ProjectIntegrationSignInPrompt | "starting" | null>(null);
  const name = provider === "supabase" ? "Supabase" : "GitHub";

  const showPrompt = (prompt: ProjectIntegrationSignInPrompt) =>
    Alert.alert(
      prompt.userCode ?? `Sign in with ${name}`,
      `Finish signing in to ${name} in your browser.`,
      [
        {
          text: "Cancel",
          style: "cancel",
          onPress: () => {
            attempt.current = null;
            setPending(null);
            void cancel({ environmentId, input: { projectId, id: prompt.id } });
          },
        },
        { text: `Open ${name}`, onPress: () => openUrl(prompt.url) },
      ],
    );

  const signIn = async () => {
    if (!baseUrl) return;
    setPending("starting");
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
      setPending(null);
      Alert.alert("Could not start the sign-in", failureMessage(squashAtomCommandFailure(started)));
      return;
    }
    const prompt = started.value;
    attempt.current = prompt;
    setPending(prompt);
    openUrl(prompt.url);
    const finished = await wait({ environmentId, input: { projectId, id: prompt.id } });
    if (attempt.current !== prompt) return;
    attempt.current = null;
    setPending(null);
    if (finished._tag === "Failure") {
      Alert.alert("Sign-in did not finish", failureMessage(squashAtomCommandFailure(finished)));
    }
  };

  return (
    <SettingsRow
      icon="person.crop.circle"
      leading={<IntegrationMark provider={provider} />}
      label={label}
      value={
        pending === "starting"
          ? "Starting…"
          : pending !== null
            ? (pending.userCode ?? "Waiting…")
            : "Sign in"
      }
      disabled={disabled || !allowed || !baseUrl}
      onPress={() => {
        if (pending === null) void signIn();
        else if (pending !== "starting") showPrompt(pending);
      }}
    />
  );
}
