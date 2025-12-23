# Hypothesis Arena - Monorepo Migration Plan

## Overview

Transform Hypothesis Arena into a monorepo with backend + frontend, deployable via single `npm start`.

---

## Monorepo Structure

```
hypothesis-arena/
├── package.json              # Root package.json (workspaces)
├── .env                      # Shared environment variables
├── .env.example
├── packages/
│   ├── frontend/             # Current Vite React app
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── components/
│   │       ├── services/
│   │       │   ├── api/      # NEW: API client layer
│   │       │   │   ├── client.ts
│   │       │   │   ├── auth.ts
│   │       │   │   ├── trading.ts
│   │       │   │   └── websocket.ts
│   │       │   ├── trading/  # Existing (paper trading)
│   │       │   └── storage/  # Existing (localStorage)
│   │       └── types/
│   │
│   ├── backend/              # NEW: Express/Node backend
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app.ts
│   │       ├── server.ts
│   │       ├── api/
│   │       │   ├── routes/
│   │       │   ├── controllers/
│   │       │   └── middleware/
│   │       ├── services/
│   │       │   ├── weex/
│   │       │   ├── trading/
│   │       │   ├── analysis/
│   │       │   └── compliance/
│   │       ├── jobs/
│   │       ├── models/
│   │       └── config/
│   │
│   └── shared/               # Shared types & utilities
│       ├── package.json
│       └── src/
│           ├── types/
│           │   ├── trading.ts
│           │   ├── analysis.ts
│           │   └── weex.ts
│           └── utils/
│               ├── validation.ts
│               └── constants.ts
│
├── Dockerfile                # Production build
└── docs/                     # WEEX API documentation
```

---

## Root package.json

```json
{
  "name": "hypothesis-arena",
  "version": "2.0.0",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "concurrently \"npm run dev:backend\" \"npm run dev:frontend\"",
    "dev:frontend": "npm run dev -w packages/frontend",
    "dev:backend": "npm run dev -w packages/backend",
    "build": "npm run build -w packages/shared && npm run build -w packages/backend && npm run build -w packages/frontend",
    "start": "node packages/backend/dist/server.js",
    "start:dev": "npm run dev",
    "db:migrate": "npm run migrate -w packages/backend",
    "db:seed": "npm run seed -w packages/backend",
    "test": "npm run test --workspaces",
    "lint": "npm run lint --workspaces",
    "typecheck": "npm run typecheck --workspaces",
    "clean": "rm -rf node_modules packages/*/node_modules packages/*/dist"
  },
  "devDependencies": {
    "concurrently": "^8.2.0",
    "typescript": "^5.8.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

---

## Backend Package (packages/backend/package.json)

```json
{
  "name": "@hypothesis-arena/backend",
  "version": "1.0.0",
  "private": true,
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "migrate": "node-pg-migrate up",
    "migrate:down": "node-pg-migrate down",
    "seed": "tsx src/scripts/seed.ts",
    "test": "vitest",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hypothesis-arena/shared": "*",
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "compression": "^1.7.4",
    "express-rate-limit": "^7.1.0",
    "jsonwebtoken": "^9.0.0",
    "bcryptjs": "^2.4.3",
    "pg": "^8.11.0",
    "redis": "^4.6.0",
    "bullmq": "^5.0.0",
    "axios": "^1.6.0",
    "ws": "^8.16.0",
    "winston": "^3.11.0",
    "dotenv": "^16.3.0",
    "zod": "^3.22.0",
    "uuid": "^9.0.0",
    "@google/genai": "^1.31.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/cors": "^2.8.0",
    "@types/compression": "^1.7.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/bcryptjs": "^2.4.0",
    "@types/pg": "^8.10.0",
    "@types/ws": "^8.5.0",
    "@types/uuid": "^9.0.0",
    "tsx": "^4.7.0",
    "vitest": "^1.2.0",
    "node-pg-migrate": "^6.2.0"
  }
}
```

---

## Frontend Package (packages/frontend/package.json)

```json
{
  "name": "@hypothesis-arena/frontend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hypothesis-arena/shared": "*",
    "@google/genai": "^1.31.0",
    "react": "^19.2.1",
    "react-dom": "^19.2.1",
    "framer-motion": "^12.23.0",
    "recharts": "^3.5.0",
    "lucide-react": "^0.556.0",
    "dompurify": "^3.3.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@types/dompurify": "^3.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^6.2.0",
    "typescript": "^5.8.0",
    "vitest": "^1.2.0"
  }
}
```

---

## Single `npm start` - Production Server

The backend serves both API and static frontend:

```typescript
// packages/backend/src/server.ts
import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config";
import { apiRouter } from "./api/routes";
import { WebSocketManager } from "./services/weex/WebSocketManager";
import { logger } from "./utils/logger";

const app = express();
const server = createServer(app);

// Security & Performance
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json());

// API Routes
app.use("/api", apiRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Serve frontend in production
if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendPath));

  // SPA fallback
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
}

// WebSocket for real-time updates
const wss = new WebSocketServer({ server, path: "/ws" });
const wsManager = new WebSocketManager(wss);

// Start server
const PORT = config.port || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
});

export { app, server, wsManager };
```

---

## Frontend API Client

```typescript
// packages/frontend/src/services/api/client.ts
const API_BASE = import.meta.env.VITE_API_URL || "/api";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: any;
  headers?: Record<string, string>;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, headers = {} } = options;

    const config: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
        ...headers,
      },
    };

    if (body) {
      config.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE}${endpoint}`, config);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(response.status, error.message || "Request failed");
    }

    return response.json();
  }

  // Convenience methods
  get<T>(endpoint: string) {
    return this.request<T>(endpoint);
  }

  post<T>(endpoint: string, body: any) {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  put<T>(endpoint: string, body: any) {
    return this.request<T>(endpoint, { method: "PUT", body });
  }

  delete<T>(endpoint: string) {
    return this.request<T>(endpoint, { method: "DELETE" });
  }
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export const apiClient = new ApiClient();
```

---

## Trading Mode Toggle

```typescript
// packages/frontend/src/services/api/trading.ts
import { apiClient } from "./client";
import { tradingService } from "../trading/tradingService";
import type { TradeDecision, Trade, Portfolio } from "@hypothesis-arena/shared";

// Feature flag from env or user preference
const USE_LIVE_TRADING = () => {
  const stored = localStorage.getItem("trading_mode");
  return stored === "live";
};

export const tradingAdapter = {
  async executeTrade(decision: TradeDecision): Promise<Trade | null> {
    if (USE_LIVE_TRADING()) {
      // Live mode: Use backend → WEEX
      return apiClient.post<Trade>("/trading/execute", decision);
    }
    // Paper mode: Use localStorage
    const state = tradingService.loadTradingState();
    const portfolio = state.portfolios[decision.thesisId];
    return tradingService.executeTrade(portfolio, decision, state);
  },

  async getPortfolio(agentId: string): Promise<Portfolio> {
    if (USE_LIVE_TRADING()) {
      return apiClient.get<Portfolio>(`/portfolio/${agentId}`);
    }
    const state = tradingService.loadTradingState();
    return state.portfolios[agentId];
  },

  async getPositions(agentId: string) {
    if (USE_LIVE_TRADING()) {
      return apiClient.get(`/portfolio/${agentId}/positions`);
    }
    const state = tradingService.loadTradingState();
    return state.portfolios[agentId].positions;
  },

  setTradingMode(mode: "paper" | "live") {
    localStorage.setItem("trading_mode", mode);
  },

  getTradingMode(): "paper" | "live" {
    return USE_LIVE_TRADING() ? "live" : "paper";
  },
};
```

---

## Environment Variables

```env
# .env (root)

# Server
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hypothesis_arena

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRY=7d

# WEEX API (for live trading)
WEEX_API_KEY=
WEEX_SECRET_KEY=
WEEX_PASSPHRASE=
WEEX_BASE_URL=https://api-contract.weex.com
WEEX_WS_URL=wss://ws-contract.weex.com/v2/ws

# Gemini API
GEMINI_API_KEY=

# FMP API (optional)
FMP_API_KEY=demo

# Frontend (Vite uses VITE_ prefix)
VITE_API_URL=/api
VITE_WS_URL=/ws

# Trading Config
MAX_POSITION_SIZE=0.2
MAX_TOTAL_INVESTED=0.8
DRAWDOWN_PAUSE_THRESHOLD=0.3

# Compliance
REQUIRE_AI_LOGS=true
```

---

## Cloud Database Setup

### PostgreSQL (Free Tier Options)

| Provider     | Free Tier           | Link                 |
| ------------ | ------------------- | -------------------- |
| **Neon**     | 0.5 GB, always free | https://neon.tech    |
| **Supabase** | 500 MB, 2 projects  | https://supabase.com |
| **Railway**  | $5 credit/month     | https://railway.app  |
| **Render**   | 90 days free        | https://render.com   |

**Recommended: Neon** - Serverless PostgreSQL, generous free tier, instant provisioning.

### Redis (Free Tier Options)

| Provider        | Free Tier                     | Link                       |
| --------------- | ----------------------------- | -------------------------- |
| **Upstash**     | 10K commands/day, always free | https://upstash.com        |
| **Redis Cloud** | 30 MB                         | https://redis.com/try-free |
| **Railway**     | $5 credit/month               | https://railway.app        |

**Recommended: Upstash** - Serverless Redis, pay-per-request, great free tier.

### Quick Setup

1. **Neon PostgreSQL:**

   - Sign up at https://neon.tech
   - Create project → Copy connection string
   - Add to `.env`: `DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require`

2. **Upstash Redis:**
   - Sign up at https://upstash.com
   - Create database → Copy REST URL + Token
   - Add to `.env`: `REDIS_URL=rediss://default:xxx@xxx.upstash.io:6379`

---

## Dockerfile (Production)

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/backend/package*.json ./packages/backend/
COPY packages/frontend/package*.json ./packages/frontend/

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build all packages
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

# Copy built files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/frontend/dist ./packages/frontend/dist

# Install production dependencies only
RUN npm ci --omit=dev --workspaces

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
```

---

## Migration Steps

### Step 1: Create Monorepo Structure

```bash
# From project root
mkdir -p packages/frontend packages/backend packages/shared

# Move current frontend code
mv src packages/frontend/
mv index.html packages/frontend/
mv vite.config.ts packages/frontend/
mv tsconfig.json packages/frontend/

# Create package.json files
# (as shown above)
```

### Step 2: Setup Cloud Databases

1. **PostgreSQL** - Create at https://neon.tech
2. **Redis** - Create at https://upstash.com
3. Copy connection strings to `.env`

### Step 3: Install & Migrate

```bash
npm install
npm run db:migrate
```

### Step 4: Development

```bash
npm run dev  # Starts both frontend + backend
```

### Step 5: Production Build & Run

```bash
npm run build
npm start  # Single server on port 3000
```

---

## API Routes Summary

| Method | Endpoint                          | Description          |
| ------ | --------------------------------- | -------------------- |
| POST   | /api/auth/register                | Register user        |
| POST   | /api/auth/login                   | Login                |
| GET    | /api/auth/me                      | Get current user     |
| POST   | /api/weex/connect                 | Connect WEEX account |
| GET    | /api/portfolio/:agentId           | Get portfolio        |
| GET    | /api/portfolio/:agentId/positions | Get positions        |
| POST   | /api/trading/execute              | Execute trade        |
| GET    | /api/trading/orders               | Get orders           |
| POST   | /api/analysis/create              | Run analysis         |
| GET    | /api/analysis/:id                 | Get analysis         |
| POST   | /api/ai-logs/upload               | Upload AI log        |
| GET    | /api/leaderboard                  | Get leaderboard      |

---

## Timeline

| Week | Tasks                                                |
| ---- | ---------------------------------------------------- |
| 1    | Monorepo setup, move frontend, create shared package |
| 2    | Backend scaffolding, database schema, migrations     |
| 3    | Auth system, user management                         |
| 4    | WEEX client, signature, rate limiting                |
| 5    | Trading service, order management                    |
| 6    | WebSocket integration, real-time updates             |
| 7    | Analysis service migration, Gemini integration       |
| 8    | AI log compliance, job scheduling                    |
| 9    | Frontend API integration, trading mode toggle        |
| 10   | Testing, bug fixes                                   |
| 11   | Docker, deployment, monitoring                       |
| 12   | Documentation, final testing                         |

---

## Quick Start Commands

```bash
# Development
npm install
npm run db:migrate
npm run dev

# Production
npm run build
npm start

# Docker (optional)
docker build -t hypothesis-arena .
docker run -p 3000:3000 --env-file .env hypothesis-arena
```

---

**Status:** Ready for Implementation  
**Last Updated:** December 23, 2025

---

# 🔴 CRITICAL ANALYSIS & FIXES

## Issues Found in Plan.md Code

### Issue 1: Server.ts - Memory Leak in WebSocket Manager

**Problem:** `wsManager` is created but never cleaned up on server shutdown.

**Fix:**

```typescript
// packages/backend/src/server.ts
import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config";
import { apiRouter } from "./api/routes";
import { WebSocketManager } from "./services/weex/WebSocketManager";
import { logger } from "./utils/logger";

const app = express();
const server = createServer(app);

// Security & Performance
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: "10mb" })); // ADD: Request size limit

// API Routes
app.use("/api", apiRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Serve frontend in production
if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendPath));

  // SPA fallback - but exclude /api routes
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(frontendPath, "index.html"));
  });
}

// WebSocket for real-time updates
const wss = new WebSocketServer({ server, path: "/ws" });
const wsManager = new WebSocketManager(wss);

// Start server
const PORT = config.port || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
});

// ADDED: Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // Close WebSocket connections
  wsManager.closeAll();
  wss.close();

  // Close HTTP server
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  // Force exit after 30s
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, wsManager };
```

---

### Issue 2: API Client - No Timeout, No Retry, No Abort Controller

**Problem:** Fetch requests can hang forever, no retry logic, can't cancel requests.

**Fix:**

```typescript
// packages/frontend/src/services/api/client.ts
const API_BASE = import.meta.env.VITE_API_URL || "/api";
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 3;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
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
  }

  getToken(): string | null {
    return this.token;
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = "GET",
      body,
      headers = {},
      timeout = DEFAULT_TIMEOUT,
      retries = method === "GET" ? MAX_RETRIES : 0, // Only retry GET by default
      signal,
    } = options;

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Combine external signal with timeout
    const combinedSignal = signal
      ? this.combineSignals(signal, controller.signal)
      : controller.signal;

    const config: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
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
          // Token expired, try refresh
          await this.refreshToken();
          // Retry with new token
          config.headers = {
            ...(config.headers as Record<string, string>),
            Authorization: `Bearer ${this.token}`,
          };
          const retryResponse = await fetch(`${API_BASE}${endpoint}`, config);
          if (!retryResponse.ok) {
            throw new ApiError(retryResponse.status, "Unauthorized");
          }
          return retryResponse.json();
        }

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new ApiError(
            response.status,
            error.message || "Request failed",
            error.code
          );
        }

        // Handle empty responses
        const text = await response.text();
        return text ? JSON.parse(text) : (null as T);
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof ApiError) throw error;

        if (error.name === "AbortError") {
          throw new ApiError(408, "Request timeout");
        }

        lastError = error as Error;

        // Retry with exponential backoff
        if (attempt < retries) {
          await this.delay(Math.pow(2, attempt) * 1000);
          continue;
        }
      }
    }

    throw new ApiError(0, lastError?.message || "Network error");
  }

  private combineSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        break;
      }
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
    return controller.signal;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async refreshToken(): Promise<void> {
    // Prevent multiple simultaneous refresh attempts
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = this.doRefreshToken();
    try {
      const newToken = await this.refreshPromise;
      this.token = newToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<string> {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include", // Send refresh token cookie
    });

    if (!response.ok) {
      this.token = null;
      throw new ApiError(401, "Session expired");
    }

    const data = await response.json();
    return data.token;
  }

  // Convenience methods
  get<T>(endpoint: string, options?: Omit<RequestOptions, "method" | "body">) {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  post<T>(
    endpoint: string,
    body: any,
    options?: Omit<RequestOptions, "method" | "body">
  ) {
    return this.request<T>(endpoint, { ...options, method: "POST", body });
  }

  put<T>(
    endpoint: string,
    body: any,
    options?: Omit<RequestOptions, "method" | "body">
  ) {
    return this.request<T>(endpoint, { ...options, method: "PUT", body });
  }

  delete<T>(
    endpoint: string,
    options?: Omit<RequestOptions, "method" | "body">
  ) {
    return this.request<T>(endpoint, { ...options, method: "DELETE" });
  }
}

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "ApiError";
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
export { ApiError };
```

---

### Issue 3: Trading Adapter - Race Condition & Missing Error Handling

**Problem:** `USE_LIVE_TRADING()` called multiple times, no error handling, state can desync.

**Fix:**

```typescript
// packages/frontend/src/services/api/trading.ts
import { apiClient, ApiError } from "./client";
import { tradingService } from "../trading/tradingService";
import type { TradeDecision, Trade, Portfolio } from "@hypothesis-arena/shared";

const TRADING_MODE_KEY = "trading_mode";

// Cache the mode to avoid repeated localStorage reads
let cachedMode: "paper" | "live" | null = null;

const getTradingMode = (): "paper" | "live" => {
  if (cachedMode === null) {
    const stored = localStorage.getItem(TRADING_MODE_KEY);
    cachedMode = stored === "live" ? "live" : "paper";
  }
  return cachedMode;
};

const isLiveTrading = (): boolean => getTradingMode() === "live";

export const tradingAdapter = {
  async executeTrade(decision: TradeDecision): Promise<Trade | null> {
    const mode = getTradingMode(); // Read once

    if (mode === "live") {
      try {
        return await apiClient.post<Trade>("/trading/execute", decision);
      } catch (error) {
        if (error instanceof ApiError) {
          // Log for debugging but rethrow
          console.error(`Trade execution failed: ${error.message}`, {
            status: error.status,
            code: error.code,
          });
        }
        throw error;
      }
    }

    // Paper mode: Use localStorage
    try {
      const state = tradingService.loadTradingState();
      const portfolio = state.portfolios[decision.thesisId];

      if (!portfolio) {
        throw new Error(`Portfolio not found for agent: ${decision.thesisId}`);
      }

      return await tradingService.executeTrade(portfolio, decision, state);
    } catch (error) {
      console.error("Paper trade execution failed:", error);
      throw error;
    }
  },

  async getPortfolio(agentId: string): Promise<Portfolio> {
    if (isLiveTrading()) {
      return apiClient.get<Portfolio>(`/portfolio/${agentId}`);
    }

    const state = tradingService.loadTradingState();
    const portfolio = state.portfolios[agentId];

    if (!portfolio) {
      throw new Error(`Portfolio not found for agent: ${agentId}`);
    }

    return portfolio;
  },

  async getPositions(agentId: string) {
    if (isLiveTrading()) {
      return apiClient.get(`/portfolio/${agentId}/positions`);
    }

    const state = tradingService.loadTradingState();
    const portfolio = state.portfolios[agentId];

    return portfolio?.positions || [];
  },

  setTradingMode(mode: "paper" | "live") {
    localStorage.setItem(TRADING_MODE_KEY, mode);
    cachedMode = mode; // Update cache
  },

  getTradingMode,

  // Clear cache (useful for testing or logout)
  clearCache() {
    cachedMode = null;
  },
};
```

---

### Issue 4: Dockerfile - Missing node_modules in Production

**Problem:** `npm ci --omit=dev --workspaces` won't work because package.json files are copied but not the workspace structure.

**Fix:**

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy all package files first
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/backend/package*.json ./packages/backend/
COPY packages/frontend/package*.json ./packages/frontend/

# Install ALL dependencies (needed for build)
RUN npm ci

# Copy source code
COPY . .

# Build all packages in order
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

# Copy package files for production install
COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/frontend/dist ./packages/frontend/dist

# Install production dependencies
# Note: We only need backend deps in production since frontend is static
RUN npm ci --omit=dev -w packages/shared -w packages/backend

# Security: Run as non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 appuser
USER appuser

ENV NODE_ENV=production
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "packages/backend/dist/server.js"]
```

---

### Issue 5: Missing WebSocketManager Implementation

**Problem:** Plan references `WebSocketManager` but doesn't show implementation. Missing heartbeat, reconnection, memory cleanup.

**Fix:**

```typescript
// packages/backend/src/services/weex/WebSocketManager.ts
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../../utils/logger";

interface Client {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;
  lastPing: number;
  isAlive: boolean;
}

export class WebSocketManager {
  private clients: Map<string, Client> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CLIENT_TIMEOUT = 60000; // 60 seconds

  constructor(private wss: WebSocketServer) {
    this.setupServer();
    this.startHeartbeat();
  }

  private setupServer() {
    this.wss.on("connection", (ws: WebSocket, req) => {
      const clientId = this.generateClientId();

      const client: Client = {
        ws,
        userId: "", // Set after auth
        subscriptions: new Set(),
        lastPing: Date.now(),
        isAlive: true,
      };

      this.clients.set(clientId, client);
      logger.info(`WebSocket client connected: ${clientId}`);

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(clientId, message);
        } catch (error) {
          logger.error("Invalid WebSocket message:", error);
        }
      });

      ws.on("pong", () => {
        const client = this.clients.get(clientId);
        if (client) {
          client.isAlive = true;
          client.lastPing = Date.now();
        }
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
        logger.info(`WebSocket client disconnected: ${clientId}`);
      });

      ws.on("error", (error) => {
        logger.error(`WebSocket error for ${clientId}:`, error);
        this.clients.delete(clientId);
      });
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      this.clients.forEach((client, clientId) => {
        if (!client.isAlive || now - client.lastPing > this.CLIENT_TIMEOUT) {
          logger.info(`Terminating inactive client: ${clientId}`);
          client.ws.terminate();
          this.clients.delete(clientId);
          return;
        }

        client.isAlive = false;
        client.ws.ping();
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  private handleMessage(clientId: string, message: any) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case "auth":
        client.userId = message.userId;
        break;
      case "subscribe":
        client.subscriptions.add(message.channel);
        break;
      case "unsubscribe":
        client.subscriptions.delete(message.channel);
        break;
      default:
        logger.warn(`Unknown message type: ${message.type}`);
    }
  }

  broadcast(channel: string, data: any) {
    const message = JSON.stringify({ channel, data, timestamp: Date.now() });

    this.clients.forEach((client) => {
      if (
        client.subscriptions.has(channel) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(message);
      }
    });
  }

  sendToUser(userId: string, data: any) {
    const message = JSON.stringify({ data, timestamp: Date.now() });

    this.clients.forEach((client) => {
      if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  closeAll() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.clients.forEach((client, clientId) => {
      client.ws.close(1000, "Server shutting down");
      this.clients.delete(clientId);
    });

    logger.info("All WebSocket connections closed");
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private generateClientId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

---

### Issue 6: Missing Database Connection Pool & Cleanup

**Problem:** No database connection management shown. Connections can leak.

**Fix:**

```typescript
// packages/backend/src/config/database.ts
import { Pool, PoolConfig } from "pg";
import { logger } from "../utils/logger";

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20, // Max connections
  min: 2, // Min connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail if can't connect in 5s
  maxUses: 7500, // Recycle connection after 7500 queries
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
};

export const pool = new Pool(poolConfig);

// Log pool errors
pool.on("error", (err) => {
  logger.error("Unexpected database pool error:", err);
});

pool.on("connect", () => {
  logger.debug("New database connection established");
});

// Health check
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch (error) {
    logger.error("Database health check failed:", error);
    return false;
  }
}

// Graceful shutdown
export async function closeDatabasePool(): Promise<void> {
  logger.info("Closing database pool...");
  await pool.end();
  logger.info("Database pool closed");
}

// Query helper with automatic release
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    logger.warn(`Slow query (${duration}ms): ${text.substring(0, 100)}`);
  }

  return result.rows;
}

// Transaction helper
export async function withTransaction<T>(
  fn: (client: any) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

---

### Issue 7: Missing Redis Connection & Cleanup

**Problem:** Redis connection not shown, no reconnection logic.

**Fix:**

```typescript
// packages/backend/src/config/redis.ts
import { createClient, RedisClientType } from "redis";
import { logger } from "../utils/logger";

let redisClient: RedisClientType | null = null;
let isConnecting = false;

export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (isConnecting) {
    // Wait for existing connection attempt
    await new Promise((resolve) => setTimeout(resolve, 100));
    return getRedisClient();
  }

  isConnecting = true;

  try {
    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error("Redis max reconnection attempts reached");
            return new Error("Max reconnection attempts");
          }
          return Math.min(retries * 100, 3000);
        },
      },
    });

    redisClient.on("error", (err) => {
      logger.error("Redis error:", err);
    });

    redisClient.on("reconnecting", () => {
      logger.info("Redis reconnecting...");
    });

    redisClient.on("ready", () => {
      logger.info("Redis connected");
    });

    await redisClient.connect();
    return redisClient;
  } finally {
    isConnecting = false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient?.isOpen) {
    logger.info("Closing Redis connection...");
    await redisClient.quit();
    redisClient = null;
    logger.info("Redis connection closed");
  }
}

// Cache helpers
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  const value = await client.get(key);
  return value ? JSON.parse(value) : null;
}

export async function cacheSet(
  key: string,
  value: any,
  ttlSeconds: number = 300
): Promise<void> {
  const client = await getRedisClient();
  await client.setEx(key, ttlSeconds, JSON.stringify(value));
}

export async function cacheDelete(key: string): Promise<void> {
  const client = await getRedisClient();
  await client.del(key);
}
```

---

### Issue 8: Updated Server with Proper Cleanup

**Fix:**

```typescript
// packages/backend/src/server.ts (COMPLETE VERSION)
import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config";
import { apiRouter } from "./api/routes";
import { WebSocketManager } from "./services/weex/WebSocketManager";
import {
  pool,
  closeDatabasePool,
  checkDatabaseHealth,
} from "./config/database";
import { closeRedis, getRedisClient } from "./config/redis";
import { logger } from "./utils/logger";

const app = express();
const server = createServer(app);

// Security
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
});
app.use("/api", limiter);

// Performance
app.use(compression());
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`Slow request: ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  next();
});

// API Routes
app.use("/api", apiRouter);

// Health check with dependencies
app.get("/health", async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();

  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? "ok" : "degraded",
    timestamp: Date.now(),
    database: dbHealthy ? "connected" : "disconnected",
    websockets: wsManager.getClientCount(),
  });
});

// Serve frontend in production
if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendPath, { maxAge: "1d" }));

  // SPA fallback
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      return next();
    }
    res.sendFile(path.join(frontendPath, "index.html"));
  });
}

// Error handler
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    logger.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

// WebSocket
const wss = new WebSocketServer({ server, path: "/ws" });
const wsManager = new WebSocketManager(wss);

// Start server
const PORT = config.port || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
});

// Graceful shutdown
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // Close WebSocket connections
  wsManager.closeAll();
  wss.close();

  // Close database pool
  await closeDatabasePool();

  // Close Redis
  await closeRedis();

  logger.info("Graceful shutdown complete");
  process.exit(0);
};

// Force exit after 30s
const forceExit = () => {
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30000);
};

process.on("SIGTERM", () => {
  forceExit();
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  forceExit();
  shutdown("SIGINT");
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});

export { app, server, wsManager };
```

---

## Summary of Fixes

| Issue | Problem                        | Fix                         |
| ----- | ------------------------------ | --------------------------- |
| 1     | Server memory leak             | Added graceful shutdown     |
| 2     | API client hangs               | Added timeout, retry, abort |
| 3     | Trading adapter race condition | Cached mode, error handling |
| 4     | Dockerfile broken              | Fixed workspace install     |
| 5     | Missing WebSocketManager       | Full implementation         |
| 6     | Database connection leak       | Pool with cleanup           |
| 7     | Redis connection leak          | Client with reconnect       |
| 8     | No error handling              | Global error handlers       |

---

**Status:** Ready for Implementation  
**Last Updated:** December 23, 2025
