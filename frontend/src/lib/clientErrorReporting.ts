import { readCsrfToken } from '../api/csrf';

export interface ClientErrorReport {
  readonly component: string;
  readonly operation: string;
  readonly message: string;
}

export type ClientErrorReportResult =
  | { status: 'reported' }
  | { status: 'failed'; error: string };

export async function reportClientError(
  event: ClientErrorReport,
): Promise<ClientErrorReportResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const token = readCsrfToken();
  if (token.status === 'available') headers['X-CSRF-Token'] = token.token;

  try {
    const res = await fetch('/api/client-errors', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      return { status: 'failed', error: `client error report failed with ${res.status}` };
    }
    return { status: 'reported' };
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
