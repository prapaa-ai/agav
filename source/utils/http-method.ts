/** Shared wire-method normalization; whitespace is not a valid HTTP token. */
export function normalizeHttpMethod(method: unknown): string {
	return String(method ?? "GET").toUpperCase();
}

/** Only GET and HEAD are read-only; unknown or invalid methods fail closed. */
export function isReadOnlyHttpMethod(method: unknown): boolean {
	const normalized = normalizeHttpMethod(method);
	return normalized === "GET" || normalized === "HEAD";
}

export function isMutatingFetchCall(name: string, input: Record<string, unknown>): boolean {
	return name === "fetch_url" && !isReadOnlyHttpMethod(input.method);
}
