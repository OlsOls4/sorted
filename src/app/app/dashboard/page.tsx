import type { Metadata } from "next";
import { MoneyOwedStudio } from "@/components/studio/MoneyOwedStudio";

export const metadata: Metadata = { title: "Sorted — Money owed (AG Studio)" };

// AG_STUDIO_LICENSE_KEY is optional: without it AG Studio runs with a watermark and console
// warnings, which is fine for local testing and the demo.
export default function MoneyOwedPage() {
  return <MoneyOwedStudio licenseKey={process.env.AG_STUDIO_LICENSE_KEY || undefined} />;
}
