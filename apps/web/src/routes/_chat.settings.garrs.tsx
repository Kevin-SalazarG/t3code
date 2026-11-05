import { createFileRoute } from "@tanstack/react-router";

import { GarrsSettings } from "../components/settings/GarrsSettings";

export const Route = createFileRoute("/_chat/settings/garrs")({
  component: GarrsSettings,
});
