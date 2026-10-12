import { parseNotes } from "@/lib/ai/parse";
import { readJSON, sanitizeSettings } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJSON(req);
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (!notes) return Response.json({ error: "Paste or dictate some job notes first." }, { status: 400 });
  if (notes.length > 5000) return Response.json({ error: "Notes are too long (5,000 characters max)." }, { status: 413 });
  const result = await parseNotes(notes, sanitizeSettings(body.settings));
  return Response.json(result);
}
