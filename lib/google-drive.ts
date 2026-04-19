import type { AppState } from './staffing';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_BACKUP_FILE_NAME = 'Staffing Board Backup.json';

type TokenResponse = {
  access_token?: string;
  error?: string;
};

type TokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type TokenClientConfig = {
  client_id: string;
  callback: (response: TokenResponse) => void;
  include_granted_scopes?: boolean;
  scope: string;
};

type DriveFile = {
  id: string;
  name: string;
  modifiedTime?: string;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: TokenClientConfig) => TokenClient;
        };
      };
    };
  }
}

let googleIdentityScriptPromise: Promise<void> | null = null;

function getClientId() {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('Missing NEXT_PUBLIC_GOOGLE_CLIENT_ID');
  }
  return clientId;
}

export async function ensureGoogleIdentityScript() {
  if (typeof window === 'undefined') {
    throw new Error('Google Drive sign-in is only available in the browser.');
  }

  if (window.google?.accounts?.oauth2) {
    return;
  }

  if (!googleIdentityScriptPromise) {
    googleIdentityScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-google-gsi="true"]');
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services.')));
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleGsi = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Google Identity Services.'));
      document.head.appendChild(script);
    });
  }

  await googleIdentityScriptPromise;
}

export async function requestGoogleDriveAccessToken() {
  await ensureGoogleIdentityScript();

  return new Promise<string>((resolve, reject) => {
    const client = window.google?.accounts?.oauth2?.initTokenClient({
      client_id: getClientId(),
      scope: GOOGLE_DRIVE_SCOPE,
      include_granted_scopes: true,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error ?? 'Google Drive authorization failed.'));
          return;
        }
        resolve(response.access_token);
      },
    });

    if (!client) {
      reject(new Error('Google Drive authorization is unavailable.'));
      return;
    }

    client.requestAccessToken({ prompt: 'consent' });
  });
}

function buildMultipartBody(metadata: Record<string, unknown>, content: string, boundary: string) {
  return [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export async function upsertDriveBackup(params: {
  accessToken: string;
  state: AppState;
  existingFileId?: string | null;
}) {
  const boundary = `staffing-board-${Date.now().toString(36)}`;
  const body = JSON.stringify(params.state, null, 2);
  const metadata = {
    name: DRIVE_BACKUP_FILE_NAME,
    mimeType: 'application/json',
    description: 'Staffing Board backup created from the iPad-friendly web app.',
    appProperties: {
      app: 'staffing-board',
      kind: 'backup',
    },
  };

  const url = params.existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${params.existingFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  const response = await fetch(url, {
    method: params.existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: buildMultipartBody(metadata, body, boundary),
  });

  if (!response.ok) {
    throw new Error(`Google Drive backup failed (${response.status}).`);
  }

  const result = (await readJsonResponse(response)) as DriveFile;
  return result;
}

export async function findLatestDriveBackup(accessToken: string) {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', `name contains 'Staffing Board Backup' and trashed = false`);
  url.searchParams.set('corpora', 'user');
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('fields', 'files(id,name,modifiedTime)');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not list Drive backups (${response.status}).`);
  }

  const result = (await readJsonResponse(response)) as { files?: DriveFile[] };
  return result.files?.[0] ?? null;
}

export async function downloadDriveBackup(accessToken: string, fileId: string) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not download Drive backup (${response.status}).`);
  }

  const text = await response.text();
  return JSON.parse(text) as AppState;
}
