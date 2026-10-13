import type { Metadata } from "next";
import { MockPayerPage } from "@/components/MockPayerPage";

export const metadata: Metadata = { title: "Pay invoice (demo) · Sorted", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MockPayerPage id={decodeURIComponent(id)} />;
}
