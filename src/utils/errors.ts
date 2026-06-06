/**
 * Base error class for MEXC Futures SDK
 */
export class MexcFuturesError extends Error {
  public readonly code?: string | number;
  public readonly statusCode?: number;
  public readonly originalError?: any;
  public readonly timestamp: Date;

  constructor(
    message: string,
    code?: string | number,
    statusCode?: number,
    originalError?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.originalError = originalError;
    this.timestamp = new Date();

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Get a user-friendly error message
   */
  getUserFriendlyMessage(): string {
    return this.message;
  }

  /**
   * Get error details for logging
   */
  getDetails(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

/**
 * Authentication related errors
 */
export class MexcAuthenticationError extends MexcFuturesError {
  constructor(message?: string, originalError?: any) {
    const defaultMessage =
      "Authentication failed. Please check your authorization token.";
    super(message || defaultMessage, "AUTH_ERROR", 401, originalError);
  }

  getUserFriendlyMessage(): string {
    switch (this.code) {
      case 401:
        return "Authentication failed. Your authorization token may be expired or invalid. Please update your WEB token from browser Developer Tools.";
      default:
        return `Authentication error: ${this.message}`;
    }
  }
}

/**
 * API related errors (4xx, 5xx responses)
 */
export class MexcApiError extends MexcFuturesError {
  public readonly endpoint?: string;
  public readonly method?: string;
  public readonly responseData?: any;

  constructor(
    message: string,
    code: string | number,
    statusCode: number,
    endpoint?: string,
    method?: string,
    responseData?: any,
    originalError?: any
  ) {
    super(message, code, statusCode, originalError);
    this.endpoint = endpoint;
    this.method = method;
    this.responseData = responseData;
  }

  getUserFriendlyMessage(): string {
    switch (this.statusCode) {
      case 400:
        return `Bad Request: ${this.message}. Please check your request parameters.`;
      case 401:
        return `Unauthorized: ${this.message}. Your authorization token may be expired.`;
      case 403:
        return `Forbidden: ${this.message}. You don't have permission for this operation.`;
      case 404:
        return `Not Found: ${this.message}. The requested resource was not found.`;
      case 429:
        return `Rate Limit Exceeded: ${this.message}. Please reduce request frequency.`;
      case 500:
        return `Server Error: ${this.message}. MEXC server is experiencing issues.`;
      case 502:
      case 503:
      case 504:
        return `Service Unavailable: ${this.message}. MEXC service is temporarily unavailable.`;
      default:
        return `API Error (${this.statusCode}): ${this.message}`;
    }
  }

  getDetails(): Record<string, any> {
    return {
      ...super.getDetails(),
      endpoint: this.endpoint,
      method: this.method,
      responseData: this.responseData,
    };
  }
}

/**
 * Network related errors (timeouts, connection issues)
 */
export class MexcNetworkError extends MexcFuturesError {
  constructor(message: string, originalError?: any) {
    super(message, "NETWORK_ERROR", undefined, originalError);
  }

  getUserFriendlyMessage(): string {
    if (this.message.includes("timeout")) {
      return "Request timeout. Please check your internet connection and try again.";
    }
    if (
      this.message.includes("ENOTFOUND") ||
      this.message.includes("ECONNREFUSED")
    ) {
      return "Connection failed. Please check your internet connection.";
    }
    return `Network error: ${this.message}`;
  }
}

/**
 * Validation errors for request parameters
 */
export class MexcValidationError extends MexcFuturesError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, "VALIDATION_ERROR");
    this.field = field;
  }

  getUserFriendlyMessage(): string {
    if (this.field) {
      return `Validation error for field '${this.field}': ${this.message}`;
    }
    return `Validation error: ${this.message}`;
  }
}

/**
 * Signature related errors
 */
export class MexcSignatureError extends MexcFuturesError {
  constructor(message?: string, originalError?: any) {
    const defaultMessage = "Request signature verification failed";
    super(message || defaultMessage, "SIGNATURE_ERROR", 602, originalError);
  }

  getUserFriendlyMessage(): string {
    return "Signature verification failed. This usually means your authorization token is invalid or expired. Please get a fresh WEB token from your browser.";
  }
}

/**
 * Rate limiting errors
 */
export class MexcRateLimitError extends MexcFuturesError {
  public readonly retryAfter?: number;

  constructor(message: string, retryAfter?: number, originalError?: any) {
    super(message, "RATE_LIMIT", 429, originalError);
    this.retryAfter = retryAfter;
  }

  getUserFriendlyMessage(): string {
    const retryMsg = this.retryAfter
      ? ` Please retry after ${this.retryAfter} seconds.`
      : "";
    return `Rate limit exceeded: ${this.message}.${retryMsg}`;
  }
}

/**
 * Strip request secrets from a raw axios error before it is retained on `originalError`.
 * The axios error carries the WEB token and signature in `config.headers` (and embedded in the
 * raw `request` object), so a consumer doing `console.log(err)` / `JSON.stringify(err)` would
 * otherwise leak the credential. Best-effort, mutates the about-to-be-wrapped error in place.
 */
const SENSITIVE_HEADERS = ["authorization", "x-mxc-sign", "x-mxc-nonce"];
export function redactAxiosError<T = any>(error: T): T {
  if (!error || typeof error !== "object") return error;
  const e = error as any;
  const scrub = (headers: any) => {
    if (headers && typeof headers === "object") {
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_HEADERS.includes(key.toLowerCase())) headers[key] = "[REDACTED]";
      }
    }
  };
  try {
    scrub(e.config?.headers);
    scrub(e.response?.config?.headers);
    // The raw ClientRequest embeds the Authorization line in `_header` (a string) and is circular;
    // drop it entirely — consumers don't need it and it would re-expose the token.
    if (e.request) delete e.request;
  } catch {
    /* best-effort redaction; never throw from error handling */
  }
  return error;
}

/**
 * Parse axios error and convert to appropriate MEXC error
 */
export function parseAxiosError(
  error: any,
  endpoint?: string,
  method?: string
): MexcFuturesError {
  // Redact request secrets (WEB token / signature) before this error is retained as originalError.
  redactAxiosError(error);

  // Network errors (no response)
  if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
    return new MexcNetworkError(error.message, error);
  }

  // Timeout errors
  if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
    return new MexcNetworkError("Request timeout", error);
  }

  // Response errors
  if (error.response) {
    const { status, data } = error.response;
    const message = data?.message || error.message || "Unknown API error";
    const code = data?.code || status;

    // Specific error types
    switch (status) {
      case 401:
        return new MexcAuthenticationError(message, error);
      case 429:
        const retryAfter = error.response.headers?.["retry-after"];
        return new MexcRateLimitError(
          message,
          retryAfter ? parseInt(retryAfter) : undefined,
          error
        );
      default:
        // Check for signature error by code
        if (
          code === 602 ||
          message.includes("signature") ||
          message.includes("Signature")
        ) {
          return new MexcSignatureError(message, error);
        }
        return new MexcApiError(
          message,
          code,
          status,
          endpoint,
          method,
          data,
          error
        );
    }
  }

  // Fallback for unknown errors
  return new MexcFuturesError(
    error.message || "Unknown error",
    "UNKNOWN_ERROR",
    undefined,
    error
  );
}

/**
 * Format error for logging
 */
export function formatErrorForLogging(error: MexcFuturesError): string {
  const details = error.getDetails();
  return `${error.getUserFriendlyMessage()}\nDetails: ${JSON.stringify(
    details,
    null,
    2
  )}`;
}
