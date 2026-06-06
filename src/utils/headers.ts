import { DEFAULT_HEADERS } from "./constants";
import md5 from "md5";

export interface SDKOptions {
  authToken: string; // WEB authentication token from browser
  userAgent?: string;
  customHeaders?: Record<string, string>; // Additional custom headers
}

/**
 * Generate MEXC crypto signature using the MD5 scheme.
 * NOTE: this is MEXC's server-dictated web-client signing scheme (reverse-engineered), not a
 * security control — MD5 is weak and the nonce is a millisecond timestamp. It cannot be changed
 * without breaking auth; treat the WEB `authToken` as the real bearer credential.
 * @param key WEB authentication key
 * @param obj Request object to sign
 * @returns Object with timestamp and signature
 */
function mexcCrypto(key: string, obj: any): { time: string; sign: string } {
  const dateNow = String(Date.now());
  const g = md5(key + dateNow).substring(7);
  const s = JSON.stringify(obj);
  const sign = md5(dateNow + s + g);

  return { time: dateNow, sign: sign };
}

/**
 * Generate HTTP headers for API requests
 * @param options SDK configuration options
 * @param includeAuth Whether to include authentication headers
 * @param requestBody Request body for signature (optional)
 * @returns Record of HTTP headers
 */
export function generateHeaders(
  options: SDKOptions,
  includeAuth: boolean = true,
  requestBody?: any
): Record<string, string> {
  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
  };

  // Override user agent if provided
  if (options.userAgent) {
    headers["user-agent"] = options.userAgent;
  }

  // Add custom headers if provided
  if (options.customHeaders) {
    Object.assign(headers, options.customHeaders);
  }

  // Add authentication headers for private endpoints
  if (includeAuth) {
    // Use WEB token for authentication
    headers["authorization"] = options.authToken;

    // Add MEXC signature for POST requests with body
    if (requestBody) {
      const signature = mexcCrypto(options.authToken, requestBody);

      headers["x-mxc-nonce"] = signature.time;
      headers["x-mxc-sign"] = signature.sign;
      // NOTE: the signature/nonce are request secrets and must never be logged.
      // The request method/URL/body are already logged at debug level by the client's
      // request interceptor (gated by logLevel), so nothing useful is lost here.
    }
  }

  return headers;
}
