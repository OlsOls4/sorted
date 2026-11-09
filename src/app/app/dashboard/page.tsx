import type { Metadata } from "next";
import { MoneyOwedBoard } from "@/components/studio/MoneyOwedBoard";
import { MoneyOwedStudio } from "@/components/studio/MoneyOwedStudio";
import { chooseDashboard } from "@/lib/studio/licence";

// Re-checked hourly, so the page follows the date of AG_STUDIO_LICENSE_KEY without a redeploy.
export const revalidate = 3600;

const which = () => chooseDashboard({ key: process.env.AG_STUDIO_LICENSE_KEY, forceOff: process.env.SORTED_FORCE_STUDIO_OFF });

export function generateMetadata(): Metadata {
  return { title: which() === "studio" ? "Sorted — Money owed (AG Studio)" : "Sorted — Money owed" };
}

// AG Studio while AG_STUDIO_LICENSE_KEY is set and in date (Europe/London); otherwise the same
// money-owed view built from Sorted's own components. SORTED_FORCE_STUDIO_OFF=1 forces the latter.
export default function MoneyOwedPage() {
  if (which() === "board") return <MoneyOwedBoard />;
  return <MoneyOwedStudio licenseKey={process.env.AG_STUDIO_LICENSE_KEY || undefined} />;
}
