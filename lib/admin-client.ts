/**
 * Admin API Client
 *
 * Client-side wrapper for calling admin APIs.
 * Handles authentication, error handling, and request caching.
 */

interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  cache?: RequestCache;
}

interface ApiResponse<T> {
  data: T | null;
  error: string | null;
  status: number;
}

// Response types for each endpoint
interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: string;
  status: string;
  last_login_at?: string;
}

interface AdminTransfer {
  id: number;
  user_id: number;
  amount: string;
  currency: string;
  status: string;
  provider: string;
  correlation_id?: string;
  created_at: string;
}

interface LedgerEntry {
  id: number;
  user_id: number;
  currency: string;
  entry_type: string;
  debit: string;
  credit: string;
  created_at: string;
}

interface ProviderEvent {
  id: number;
  provider: string;
  event_type: string;
  processing_status: string;
  correlation_id?: string;
  created_at: string;
}

interface Webhook {
  id: number;
  provider: string;
  event_type: string;
  status: string;
  processing_attempts: number;
  correlation_id?: string;
  created_at: string;
}

interface AuditLog {
  id: number;
  admin_user_id: number;
  action: string;
  resource_type: string;
  status: 'success' | 'failed';
  correlation_id?: string;
  created_at: string;
  request_duration_ms?: number;
}

interface Settlement {
  id: number;
  user_id: number;
  recipient_id: number;
  amount: string;
  currency: string;
  status: string;
  created_at: string;
}

interface PaginatedResponse<T> {
  data: T[];
  total_count: number;
}

type NamedListResponse<T, Key extends string> = {
  [P in Key]: T[];
} & {
  total_count: number | string;
  page: number;
  page_size: number;
};

type NormalizedListResponse<T, Key extends string> = {
  [P in Key]: T[];
} & {
  data: T[];
  total_count: number;
  page: number;
  page_size: number;
};

function normalizeNamedListResponse<T, Key extends string>(
  response: ApiResponse<NamedListResponse<T, Key>>,
  key: Key
): ApiResponse<NormalizedListResponse<T, Key>> {
  if (!response.data) {
    return { ...response, data: null };
  }

  return {
    ...response,
    data: {
      ...response.data,
      data: response.data[key],
      total_count: Number(response.data.total_count),
    },
  };
}

interface AuditStatsResponse {
  total_events: number;
  success_rate: number;
  by_status: {
    success: number;
    failed: number;
  };
}

const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function fetchFromApi<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<ApiResponse<T>> {
  const url = new URL(endpoint, typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

  // Check cache for GET requests
  if (options.method !== 'POST' && cache.has(endpoint)) {
    const cached = cache.get(endpoint);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return { data: cached.data as T, error: null, status: 200 };
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: options.cache || 'no-cache',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        data: null,
        error: errorData.error || `API error: ${response.status}`,
        status: response.status,
      };
    }

    const data = await response.json();

    // Cache successful GET responses
    if (options.method !== 'POST') {
      cache.set(endpoint, { data, timestamp: Date.now() });
    }

    return { data, error: null, status: response.status };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 0,
    };
  }
}

export const adminApi = {
  // Users
  async getUsers(page: number = 1, pageSize: number = 50) {
    const response = await fetchFromApi<NamedListResponse<AdminUser, 'admins'>>(
      `/api/admin/users?page=${page}&page_size=${pageSize}`
    );
    return normalizeNamedListResponse(response, 'admins');
  },

  async getUsersByRole(role: string) {
    const response = await fetchFromApi<NamedListResponse<AdminUser, 'admins'>>(
      `/api/admin/users?role=${encodeURIComponent(role)}`
    );
    return normalizeNamedListResponse(response, 'admins');
  },

  // Transfers
  async searchTransfers(
    filters: Record<string, unknown> = {},
    page: number = 1,
    pageSize: number = 50
  ) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    });
    const response = await fetchFromApi<NamedListResponse<AdminTransfer, 'transfers'>>(
      `/api/admin/transfers?${params}`
    );
    return normalizeNamedListResponse(response, 'transfers');
  },

  async getTransferById(id: number) {
    return fetchFromApi<AdminTransfer>(`/api/admin/transfers/${id}`);
  },

  async traceTransfer(correlationId: string) {
    return fetchFromApi<{ transfers: AdminTransfer[] }>(`/api/admin/transfers/trace?correlation_id=${encodeURIComponent(correlationId)}`);
  },

  // Ledger
  async searchLedger(
    filters: Record<string, unknown> = {},
    page: number = 1,
    pageSize: number = 50
  ) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    });
    const response = await fetchFromApi<NamedListResponse<LedgerEntry, 'entries'>>(
      `/api/admin/ledger?${params}`
    );
    return normalizeNamedListResponse(response, 'entries');
  },

  async getUserLedger(userId: number) {
    const response = await fetchFromApi<NamedListResponse<LedgerEntry, 'entries'>>(
      `/api/admin/ledger/${userId}`
    );
    return normalizeNamedListResponse(response, 'entries');
  },

  async getUserBalance(userId: number, currency: string) {
    return fetchFromApi<{ balance: string; currency: string }>(`/api/admin/ledger/${userId}?currency=${currency}`);
  },

  // Provider Events
  async searchProviderEvents(
    filters: Record<string, unknown> = {},
    page: number = 1,
    pageSize: number = 50
  ) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    });
    const response = await fetchFromApi<NamedListResponse<ProviderEvent, 'events'>>(
      `/api/admin/events?${params}`
    );
    return normalizeNamedListResponse(response, 'events');
  },

  async getProviderEventById(id: number) {
    return fetchFromApi<ProviderEvent>(`/api/admin/events/${id}`);
  },

  async traceProviderEvents(correlationId: string) {
    return fetchFromApi<{ events: ProviderEvent[] }>(`/api/admin/events/trace?correlation_id=${encodeURIComponent(correlationId)}`);
  },

  // Webhooks
  async searchWebhooks(
    filters: Record<string, unknown> = {},
    page: number = 1,
    pageSize: number = 50
  ) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    });
    const response = await fetchFromApi<NamedListResponse<Webhook, 'webhooks'>>(
      `/api/admin/webhooks?${params}`
    );
    return normalizeNamedListResponse(response, 'webhooks');
  },

  async getWebhookById(id: number) {
    return fetchFromApi<Webhook>(`/api/admin/webhooks/${id}`);
  },

  async traceWebhooks(correlationId: string) {
    return fetchFromApi<{ webhooks: Webhook[] }>(`/api/admin/webhooks/trace?correlation_id=${encodeURIComponent(correlationId)}`);
  },

  // Audit Logs
  async searchAuditLogs(
    filters: Record<string, unknown> = {},
    page: number = 1,
    pageSize: number = 50
  ) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    });
    const response = await fetchFromApi<NamedListResponse<AuditLog, 'events'>>(
      `/api/admin/audit-logs?${params}`
    );
    return normalizeNamedListResponse(response, 'events');
  },

  async traceAuditLog(correlationId: string) {
    return fetchFromApi<{ audit_logs: AuditLog[] }>(`/api/admin/audit-logs/trace?correlation_id=${encodeURIComponent(correlationId)}`);
  },

  async getAuditTimeline(resourceType: string, resourceId: number) {
    return fetchFromApi<{ timeline: AuditLog[] }>(
      `/api/admin/audit-logs/timeline?resource_type=${encodeURIComponent(resourceType)}&resource_id=${resourceId}`
    );
  },

  async getAuditStats(type: 'summary' | 'performance' | 'suspicious' = 'summary', filters?: Record<string, string>) {
    const params = new URLSearchParams({ type, ...filters });
    return fetchFromApi<AuditStatsResponse>(`/api/admin/audit-logs/stats?${params}`);
  },

  async getMyActivity(limit: number = 100) {
    return fetchFromApi<{ audit_logs: AuditLog[] }>(`/api/admin/audit-logs/me?limit=${limit}`);
  },

  // Settlements
  async searchSettlements(
    filters: Record<string, unknown> = {},
    page: number = 1,
    pageSize: number = 50
  ) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      ...Object.fromEntries(
        Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    });
    const response = await fetchFromApi<NamedListResponse<Settlement, 'settlements'>>(
      `/api/admin/settlements?${params}`
    );
    return normalizeNamedListResponse(response, 'settlements');
  },

  async getSettlementById(id: number) {
    return fetchFromApi<Settlement>(`/api/admin/settlements/${id}`);
  },

  async traceSettlement(correlationId: string) {
    return fetchFromApi<{ settlements: Settlement[] }>(`/api/admin/settlements/trace?correlation_id=${encodeURIComponent(correlationId)}`);
  },
};

export function clearApiCache() {
  cache.clear();
}
