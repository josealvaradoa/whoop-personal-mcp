import { randomBytes, createHash } from "node:crypto";

/** Generate a real PKCE pair: challenge = base64url(sha256(verifier)), S256. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url"); // 43-char high-entropy verifier
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Extract the single-use consentId embedded as a hidden input in the consent form. */
export function extractConsentId(html: string): string | null {
  const m = html.match(/name="consentId"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

/** Parse the JSON-RPC messages out of a Streamable-HTTP SSE response body. */
export function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean)
    .map((json) => JSON.parse(json) as Record<string, unknown>);
}
