import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = { title: "Chase — Dashboard" };

export default function AppPage() {
  return <Dashboard />;
}
