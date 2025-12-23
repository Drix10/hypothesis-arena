const API_BASE = import.meta.env.VITE_API_URL || '/api';
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;

interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: any;
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
    signal?: AbortSignal;
}

class ApiClient {
    private token: string | null = null;
    private refreshPromise: Promise<string> | null = null;

    setToken(token: string | null) {
        this.token = token;
        if (token) {
            localStorage.setItem('auth_token', token);
        } else {
            localStorage.removeItem('auth_token');
        }
    }

    getToken(): string | null {
        if (!this.token) {
            this.token = localStorage.getItem('auth_token');
        }
        return this.token;
    }

    async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
        const {
            method = 'GET',
            body,
            headers = {},
            timeout = DEFAULT_TIMEOUT,
            retries = method === 'GET' ? MAX_RETRIES : 0,
            signal
        } = options;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const combinedSignal = signal
            ? this.combineSignals(signal, controller.signal)
            : controller.signal;

        const config: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(this.getToken() && { Authorization: `Bearer ${this.getToken()}` }),
                ...headers,
            },
            signal: combinedSignal,
        };

        if (body) {
            config.body = JSON.stringify(body);
        }

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetch(`${API_BASE}${endpoint}`, config);
                clearTimeout(timeoutId);

                if (response.status === 401 && this.token) {
                    // Check if caller already aborted before attempting refresh
                    if (signal?.aborted) {
                        throw new ApiError(408, 'Request aborted');
                    }

                    // Create new timeout for retry request, respecting caller's signal
                    const retryController = new AbortController();
                    const retryTimeoutId = setTimeout(() => retryController.abort(), timeout);

                    // Abort retry if caller's signal fires
                    const abortHandler = () => retryController.abort();
                    signal?.addEventListener('abort', abortHandler, { once: true });

                    try {
                        await this.refreshToken();
                        const retryConfig: RequestInit = {
                            ...config,
                            signal: retryController.signal,
                            headers: {
                                ...config.headers as Record<string, string>,
                                Authorization: `Bearer ${this.token}`,
                            },
                        };
                        const retryResponse = await fetch(`${API_BASE}${endpoint}`, retryConfig);
                        clearTimeout(retryTimeoutId);
                        signal?.removeEventListener('abort', abortHandler);

                        if (!retryResponse.ok) {
                            this.setToken(null);
                            const retryError = await retryResponse.json().catch(() => ({}));
                            throw new ApiError(retryResponse.status, retryError.error || 'Session expired', retryError.code);
                        }
                        return this.parseResponse<T>(retryResponse);
                    } catch (refreshError: any) {
                        clearTimeout(retryTimeoutId);
                        signal?.removeEventListener('abort', abortHandler);
                        this.setToken(null);
                        // Preserve original error details if it's already an ApiError
                        if (refreshError instanceof ApiError) {
                            throw refreshError;
                        }
                        throw new ApiError(401, refreshError.message || 'Session expired');
                    }
                }

                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    throw new ApiError(response.status, error.error || 'Request failed', error.code);
                }

                return this.parseResponse<T>(response);

            } catch (error: any) {
                clearTimeout(timeoutId);

                if (error instanceof ApiError) throw error;

                if (error.name === 'AbortError') {
                    throw new ApiError(408, 'Request timeout');
                }

                lastError = error;

                if (attempt < retries) {
                    await this.delay(Math.pow(2, attempt) * 1000);
                    continue;
                }
            }
        }

        throw new ApiError(0, lastError?.message || 'Network error');
    }

    private async parseResponse<T>(response: Response): Promise<T> {
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            // Non-JSON response - return undefined cast (safer than null for generic T)
            return undefined as unknown as T;
        }
        const text = await response.text();
        if (!text || text.trim() === '') {
            return undefined as unknown as T;
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            return undefined as unknown as T;
        }
    }

    private combineSignals(...signals: AbortSignal[]): AbortSignal {
        const controller = new AbortController();
        for (const signal of signals) {
            if (signal.aborted) {
                controller.abort();
                break;
            }
            signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        return controller.signal;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async refreshToken(): Promise<void> {
        if (this.refreshPromise) {
            await this.refreshPromise;
            return;
        }

        this.refreshPromise = this.doRefreshToken();
        try {
            const newToken = await this.refreshPromise;
            this.setToken(newToken);
        } catch {
            this.setToken(null);
        } finally {
            this.refreshPromise = null;
        }
    }

    private async doRefreshToken(): Promise<string> {
        const refreshToken = localStorage.getItem('refresh_token');
        if (!refreshToken) {
            throw new Error('No refresh token');
        }

        const response = await fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
        });

        if (!response.ok) {
            throw new ApiError(401, 'Session expired');
        }

        const data = await response.json();
        if (data.refreshToken) {
            localStorage.setItem('refresh_token', data.refreshToken);
        }
        return data.accessToken;
    }

    get<T>(endpoint: string, options?: Omit<RequestOptions, 'method' | 'body'>) {
        return this.request<T>(endpoint, { ...options, method: 'GET' });
    }

    post<T>(endpoint: string, body: any, options?: Omit<RequestOptions, 'method' | 'body'>) {
        return this.request<T>(endpoint, { ...options, method: 'POST', body });
    }

    put<T>(endpoint: string, body: any, options?: Omit<RequestOptions, 'method' | 'body'>) {
        return this.request<T>(endpoint, { ...options, method: 'PUT', body });
    }

    delete<T>(endpoint: string, options?: Omit<RequestOptions, 'method' | 'body'>) {
        return this.request<T>(endpoint, { ...options, method: 'DELETE' });
    }

    isAuthenticated(): boolean {
        return !!this.getToken();
    }

    logout() {
        this.setToken(null);
        localStorage.removeItem('refresh_token');
    }
}

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
        public code?: string
    ) {
        super(message);
        this.name = 'ApiError';
    }

    isNetworkError(): boolean {
        return this.status === 0;
    }

    isTimeout(): boolean {
        return this.status === 408;
    }

    isUnauthorized(): boolean {
        return this.status === 401;
    }

    isServerError(): boolean {
        return this.status >= 500;
    }
}

export const apiClient = new ApiClient();
