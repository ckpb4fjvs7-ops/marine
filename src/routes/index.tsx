import { createFileRoute } from "@tanstack/react-router";
import { SurveyExplorer } from "@/components/survey-explorer";

export const Route = createFileRoute("/")({ component: SurveyExplorer });
