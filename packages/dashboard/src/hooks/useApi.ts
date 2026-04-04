import { useCallback } from 'react';

export interface ApiError {
  status: number;
  message: string;
}

export function useApi() {
  const baseUrl = import.meta.env.VITE_API_URL || '';

  const request = useCallback(
    async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const url = `${baseUrl}${path}`;
      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const errorBody = await response.text();
        let message: string;
        try {
          const parsed = JSON.parse(errorBody);
          message = parsed.message || parsed.error || errorBody;
        } catch {
          message = errorBody || response.statusText;
        }
        throw { status: response.status, message } as ApiError;
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json();
    },
    [baseUrl],
  );

  const get = useCallback(<T>(path: string): Promise<T> => request<T>('GET', path), [request]);

  const post = useCallback(
    <T>(path: string, body: unknown): Promise<T> => request<T>('POST', path, body),
    [request],
  );

  const patch = useCallback(
    <T>(path: string, body: unknown): Promise<T> => request<T>('PATCH', path, body),
    [request],
  );

  const del = useCallback(
    (path: string): Promise<void> => request<void>('DELETE', path),
    [request],
  );

  return { get, post, patch, del, baseUrl };
}
