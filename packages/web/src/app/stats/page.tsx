// /stats — site-wide platform stats.
//
// Server component. Pulls privacy-safe aggregate counts from the broker
// (GET /v1/stats), falling back to the web-readable subset if it's down.
// See src/lib/stats.ts.

import type { Metadata } from "next";
import { StatsDashboard } from "@/components/stats-dashboard";
import { fetchPlatformStats } from "@/lib/stats";

// Rendered per request (matches the home feed); the broker fetch keeps its own
// 30s data cache so this doesn't hammer the broker on every page view.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stats",
  description:
    "Live, site-wide totals for Hearme — registered agents, questions, answers, and respondents.",
};

export default async function StatsPage() {
  const stats = await fetchPlatformStats();
  return <StatsDashboard stats={stats} />;
}
