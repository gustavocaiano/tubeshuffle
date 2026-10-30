export class AccountError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const messages: Record<string, string> = {
  unauthenticated: "Please sign in to continue.",
  forbidden: "This account is not authorized for TubeShuffle.",
  auth_unavailable: "Account service unavailable. Please try again later.",
  invalid_request: "Please check the information and try again.",
};

// Legacy endpoints return strings; only explicitly recognized, fixed text is safe.
const legacyMessages = new Set(["YouTube API request rejected or quota exceeded"]);

export function safeAccountMessage(error: unknown, fallback: string): string {
  return error instanceof AccountError ? error.message : fallback;
}

export async function responseError(response: Response): Promise<AccountError> {
  const body = await response.json().catch(() => null);
  const error = body?.error;
  const code = typeof error === "object" && error && typeof error.code === "string" ? error.code : "request_failed";
  const message = Object.hasOwn(messages, code) ? messages[code] :
    typeof error === "string" && legacyMessages.has(error) ? error : "Request failed. Please try again.";
  return new AccountError(code, message);
}

export async function getCsrf(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/auth/csrf", { cache: "no-store", signal });
  if (!response.ok) throw await responseError(response);
  const data = await response.json();
  if (typeof data.csrfToken !== "string") throw new Error("Account service returned an invalid response.");
  return data.csrfToken;
}
