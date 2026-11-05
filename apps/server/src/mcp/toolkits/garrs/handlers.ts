import {
  GarrsDeliverInput,
  GarrsModelsInput,
  GarrsSelectModelInput,
  type GarrsError,
  GarrsReportInput,
  GarrsProposeCommitInput,
  GarrsProposePushInput,
  GarrsRequestHelperInput,
  GarrsReviseInput,
  GarrsSendMessageInput,
  GarrsStartWorkInput,
  GarrsStatusInput,
  GarrsWorkItemInput,
  GarrsSubmitPlanInput,
  GarrsSubmitReviewInput,
  type GarrsToolResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GarrsService from "../../../garrs/GarrsService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GarrsToolkit, type GARRS_TOOL_ACTIONS } from "./tools.ts";

const failure = (error: GarrsError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "forbidden" || error.code === "disabled"
        ? "capability_denied"
        : error.code === "unavailable"
          ? "provider_unavailable"
          : error.code === "persistence"
            ? "orchestration_error"
            : "invalid_request",
    message: error.message,
  });

type Service = GarrsService.GarrsService["Service"];
type Run = (
  garrs: Service,
  caller: GarrsService.GarrsCaller,
  input: unknown,
) => Effect.Effect<GarrsToolResult, GarrsError | OrchestratorMcpFailure>;

/** Decode an action's input with its contract schema; a mismatch explains itself. */
const action =
  <A, I>(
    schema: Schema.Codec<A, I>,
    call: (
      garrs: Service,
      caller: GarrsService.GarrsCaller,
      input: A,
    ) => Effect.Effect<GarrsToolResult, GarrsError>,
  ): Run =>
  (garrs, caller, input) =>
    Schema.decodeUnknownEffect(schema)(input ?? {}).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Invalid input: ${error.message}`.slice(0, 2_000),
          }),
      ),
      Effect.flatMap((decoded) => call(garrs, caller, decoded)),
    );

const actions: Record<(typeof GARRS_TOOL_ACTIONS)[number], Run> = {
  status: action(GarrsStatusInput, (garrs, caller, input) => garrs.status(caller, input)),
  models: action(GarrsModelsInput, (garrs, caller, input) => garrs.models(caller, input)),
  select_model: action(GarrsSelectModelInput, (garrs, caller, input) =>
    garrs.selectTaskModel(caller, input),
  ),
  start_work: action(GarrsStartWorkInput, (garrs, caller, input) => garrs.startWork(caller, input)),
  resume: action(GarrsWorkItemInput, (garrs, caller, input) => garrs.resume(caller, input)),
  revise: action(GarrsReviseInput, (garrs, caller, input) => garrs.revise(caller, input)),
  deliver: action(GarrsDeliverInput, (garrs, caller, input) => garrs.deliver(caller, input)),
  submit_plan: action(GarrsSubmitPlanInput, (garrs, caller, input) =>
    garrs.submitPlan(caller, input),
  ),
  report: action(GarrsReportInput, (garrs, caller, input) => garrs.report(caller, input)),
  request_helper: action(GarrsRequestHelperInput, (garrs, caller, input) =>
    garrs.requestHelper(caller, input),
  ),
  propose_commit: action(GarrsProposeCommitInput, (garrs, caller, input) =>
    garrs.proposeCommit(caller, input),
  ),
  propose_push: action(GarrsProposePushInput, (garrs, caller, input) =>
    garrs.proposePush(caller, input),
  ),
  send_message: action(GarrsSendMessageInput, (garrs, caller, input) =>
    garrs.sendMessage(caller, input),
  ),
  submit_review: action(GarrsSubmitReviewInput, (garrs, caller, input) =>
    garrs.submitReview(caller, input),
  ),
};

export const layer = McpToolAccess.toLayer(GarrsToolkit, {
  // The service checks the caller's Garrs role for every action.
  garrs: McpToolAccess.actsAsCaller(
    Effect.fnUntraced(function* (params: {
      readonly action: (typeof GARRS_TOOL_ACTIONS)[number];
      readonly input?: unknown;
    }) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "Garrs");
      const garrs = yield* GarrsService.GarrsService;
      return yield* actions[params.action](
        garrs,
        { threadId: thread.thread.threadId },
        params.input,
      ).pipe(Effect.mapError((error) => (error._tag === "GarrsError" ? failure(error) : error)));
    }),
  ),
});
