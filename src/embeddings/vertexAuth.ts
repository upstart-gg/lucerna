import { GoogleAuth } from "google-auth-library";

export interface VertexAuthOptions {
  /** Path to a service account JSON key file. Uses ADC if omitted. */
  keyFile?: string;
}

// Module-level cache: one GoogleAuth instance per configuration key.
// GoogleAuth handles token caching and refresh internally.
const clientCache = new Map<string, GoogleAuth>();

/**
 * Returns a valid Bearer token for Vertex AI API calls.
 *
 * - With no options: uses Application Default Credentials (ADC).
 *   Run `gcloud auth application-default login` once for local dev.
 *   In CI/CD, set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON path.
 * - With `keyFile`: uses the specified service account JSON key file.
 *
 * Tokens are refreshed automatically by google-auth-library before expiry.
 */
export async function getVertexAccessToken(
  opts: VertexAuthOptions,
): Promise<string> {
  const cacheKey = opts.keyFile ?? "__adc__";
  let auth = clientCache.get(cacheKey);
  if (!auth) {
    auth = new GoogleAuth({
      ...(opts.keyFile ? { keyFilename: opts.keyFile } : {}),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    clientCache.set(cacheKey, auth);
  }

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error(
      "VertexAI: failed to obtain an access token from Application Default Credentials.\n" +
        "For local development, run: gcloud auth application-default login\n" +
        "For CI/CD, set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON key file path,\n" +
        "or pass keyFile in the vertex provider config.",
    );
  }
  return tokenResponse.token;
}

/** Clears the module-level GoogleAuth cache. Exposed for testing only. */
export function _clearVertexAuthCache(): void {
  clientCache.clear();
}
