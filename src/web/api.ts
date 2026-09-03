interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const jsonBody = init?.body && !(init.body instanceof FormData);
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(jsonBody ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ApiError(
      body.error?.message ?? `Request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  return body;
}
