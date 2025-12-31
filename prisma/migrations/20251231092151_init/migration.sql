-- CreateTable
-- NOTE: SQLite uses REAL (8-byte IEEE 754 floating point) for all numeric types.
-- While DECIMAL/NUMERIC would be preferred for financial precision, SQLite doesn't support them.
-- 
-- PRECISION WARNING: IEEE 754 double precision provides ~15-17 significant decimal digits.
-- For crypto trading with 8 decimal places (e.g., 0.00000001 BTC), this is generally sufficient
-- for values up to ~$100 million. However, be aware of:
-- - Rounding errors in repeated calculations
-- - Loss of precision when adding very large and very small numbers
-- - Comparison issues (use epsilon for equality checks)
-- 
-- For critical financial calculations, consider using integer cents in application code
-- or Decimal libraries (e.g., decimal.js, big.js) for exact arithmetic.
-- Prisma schema uses Float type which maps to REAL in SQLite.
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "initial_balance" REAL NOT NULL,
    "current_balance" REAL NOT NULL,
    "total_value" REAL NOT NULL DEFAULT 0,
    "total_return" REAL NOT NULL DEFAULT 0,
    "total_return_dollar" REAL NOT NULL DEFAULT 0,
    "win_rate" REAL NOT NULL DEFAULT 0,
    "sharpe_ratio" REAL,
    "max_drawdown" REAL NOT NULL DEFAULT 0,
    "current_drawdown" REAL NOT NULL DEFAULT 0,
    "total_trades" INTEGER NOT NULL DEFAULT 0,
    "winning_trades" INTEGER NOT NULL DEFAULT 0,
    "losing_trades" INTEGER NOT NULL DEFAULT 0,
    "tournament_wins" INTEGER NOT NULL DEFAULT 0,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- FIXED: Added DEFAULT for updated_at
);

-- CreateTable
-- NOTE: SQLite REAL type used for financial values (size, price, fee, P&L).
-- While not ideal for financial precision, SQLite doesn't support DECIMAL/NUMERIC.
-- Application code should handle rounding and precision as needed.
CREATE TABLE "trades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolio_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" REAL NOT NULL,
    "price" REAL NOT NULL,
    "fee" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "analysis_id" TEXT,
    "confidence" REAL,
    "champion_id" TEXT,
    "executed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weex_order_id" TEXT,
    "client_order_id" TEXT,
    "realized_pnl" REAL,
    "realized_pnl_percent" REAL,
    CONSTRAINT "trades_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trade_id" TEXT,
    "order_id" TEXT,
    "stage" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_to_weex" BOOLEAN NOT NULL DEFAULT false,
    "weex_log_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_logs_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
-- NOTE: SQLite REAL type used for total_value. DATETIME type already used for timestamp fields.
CREATE TABLE "performance_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolio_id" TEXT NOT NULL,
    "total_value" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "performance_snapshots_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
-- NOTE: 'date' field stored as TEXT in YYYY-MM-DD format (SQLite doesn't have native DATE type).
-- Financial metrics use REAL type (see note above about precision limitations).
CREATE TABLE "performance_metrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolio_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "portfolio_value" REAL NOT NULL,
    "daily_return" REAL NOT NULL,
    "cumulative_return" REAL NOT NULL,
    "sharpe_ratio" REAL,
    "max_drawdown" REAL NOT NULL,
    "win_rate" REAL NOT NULL,
    "trades_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "performance_metrics_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_agent_id_key" ON "portfolios"("agent_id");

-- CreateIndex
CREATE INDEX "portfolios_status_idx" ON "portfolios"("status");

-- CreateIndex
CREATE UNIQUE INDEX "trades_client_order_id_key" ON "trades"("client_order_id");

-- CreateIndex
CREATE INDEX "trades_portfolio_id_idx" ON "trades"("portfolio_id");

-- CreateIndex
CREATE INDEX "trades_symbol_idx" ON "trades"("symbol");

-- CreateIndex
CREATE INDEX "trades_status_idx" ON "trades"("status");

-- CreateIndex
CREATE INDEX "trades_created_at_idx" ON "trades"("created_at");

-- CreateIndex
CREATE INDEX "trades_executed_at_idx" ON "trades"("executed_at");

-- CreateIndex
CREATE INDEX "trades_champion_id_idx" ON "trades"("champion_id");

-- CreateIndex
CREATE INDEX "trades_symbol_status_executed_at_idx" ON "trades"("symbol", "status", "executed_at");

-- CreateIndex
CREATE INDEX "trades_status_side_executed_at_idx" ON "trades"("status", "side", "executed_at");

-- CreateIndex
CREATE INDEX "ai_logs_trade_id_idx" ON "ai_logs"("trade_id");

-- CreateIndex
CREATE INDEX "ai_logs_order_id_idx" ON "ai_logs"("order_id");

-- CreateIndex
CREATE INDEX "ai_logs_timestamp_idx" ON "ai_logs"("timestamp");

-- CreateIndex
CREATE INDEX "ai_logs_uploaded_to_weex_idx" ON "ai_logs"("uploaded_to_weex");

-- CreateIndex
CREATE INDEX "performance_snapshots_portfolio_id_idx" ON "performance_snapshots"("portfolio_id");

-- CreateIndex
CREATE INDEX "performance_snapshots_timestamp_idx" ON "performance_snapshots"("timestamp");

-- CreateIndex
CREATE INDEX "performance_snapshots_portfolio_id_timestamp_idx" ON "performance_snapshots"("portfolio_id", "timestamp");

-- CreateIndex
CREATE INDEX "performance_metrics_portfolio_id_idx" ON "performance_metrics"("portfolio_id");

-- CreateIndex
CREATE INDEX "performance_metrics_date_idx" ON "performance_metrics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metrics_portfolio_id_date_key" ON "performance_metrics"("portfolio_id", "date");
