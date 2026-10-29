// REST client (PLAN 5.2). Errors come back as {"error":{"code","message"}}.
import type { Attachment, Channel, Me, Member, Message, Relationship, User } from '../shared/protocol';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};

export function setToken(t: string | null) {
  token = t;
}

export function setUnauthorizedHandler(cb: () => void) {
  onUnauthorized = cb;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Sem conexão com o servidor.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data?.error?.code ?? 'http_' + res.status, data?.error?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  googleStartUrl: () => `${API_URL}/v1/auth/google/start`,
  devLogin: (email: string, name: string) => request<{ code: string }>('POST', '/v1/auth/dev', { email, name }),
  exchange: (code: string) => request<{ token: string; user: Me }>('POST', '/v1/auth/exchange', { code }),
  logout: () => request<void>('POST', '/v1/auth/logout'),
  me: () => request<Me>('GET', '/v1/me'),

  users: () => request<Member[]>('GET', '/v1/users'),
  setRole: (id: string, role: User['role']) => request<User>('PATCH', `/v1/users/${id}`, { role }),

  friends: () => request<Relationship[]>('GET', '/v1/friends'),
  /** Sends a request to a username, or accepts theirs if they already asked. */
  addFriend: (username: string) => request<Relationship>('POST', '/v1/friends', { username }),
  acceptFriend: (userId: string) => request<Relationship>('PUT', `/v1/friends/${userId}`),
  /** Removes a friend, declines a request or cancels one we sent. */
  removeFriend: (userId: string) => request<void>('DELETE', `/v1/friends/${userId}`),

  createChannel: (kind: Channel['kind'], name: string) => request<Channel>('POST', '/v1/channels', { kind, name }),
  updateChannel: (id: string, patch: { name?: string; position?: number }) =>
    request<Channel>('PATCH', `/v1/channels/${id}`, patch),
  deleteChannel: (id: string) => request<void>('DELETE', `/v1/channels/${id}`),

  messages: (channelId: string, before?: string, limit = 50) =>
    request<Message[]>(
      'GET',
      `/v1/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
    ),
  sendMessage: (channelId: string, content: string, attachments: Attachment[]) =>
    request<Message>('POST', `/v1/channels/${channelId}/messages`, { content, attachments }),
  editMessage: (id: string, content: string) => request<Message>('PATCH', `/v1/messages/${id}`, { content }),
  deleteMessage: (id: string) => request<void>('DELETE', `/v1/messages/${id}`),
  presign: (name: string, content_type: string, size: number) =>
    request<{ key: string; url: string; method: string; headers: Record<string, string> }>(
      'POST',
      '/v1/uploads/presign',
      { name, content_type, size },
    ),

  iceServers: () => request<{ ice_servers: RTCIceServer[] }>('GET', '/v1/rtc/ice-servers'),
  voiceToken: (channelId: string, kind: 'user' | 'screen' = 'user') =>
    request<{ token: string }>('GET', `/v1/channels/${channelId}/voice-token?kind=${kind}`),
};

/** PUT a file to a pre-signed URL, reporting progress in [0, 1]. */
export function uploadFile(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'upload_failed', 'Falha no envio.')));
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Falha no envio.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Envio cancelado.'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}
