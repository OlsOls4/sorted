// QR codes for invoice pay links (server-only).
import "server-only";
import QRCode from "qrcode";

/** Demo mode / fallback: draw a QR for any URL locally. */
export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { width: 240, margin: 1, errorCorrectionLevel: "M" });
}

/**
 * PayPal's generate-qr-code returns multipart/form-data whose "image" part is a
 * base64 PNG; the Agent Toolkit hands that body back as a string. Pull the PNG out.
 */
export function qrFromToolkitOutput(out: unknown): string {
  const text = typeof out === "string" ? out : JSON.stringify(out ?? "");
  const m = text.match(/\r?\n\r?\n(iVBOR[A-Za-z0-9+/=\r\n]+?)\r?\n--/) ?? text.match(/(iVBOR[A-Za-z0-9+/=]{100,})/);
  if (!m) throw new Error("PayPal returned no QR image");
  return `data:image/png;base64,${m[1].replace(/\s+/g, "")}`;
}
