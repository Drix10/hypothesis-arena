-- CreateTable
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
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolio_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "action" TEXT,
    "size" REAL NOT NULL,
    "entry_price" REAL,
    "price" REAL,
    "fee" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "rationale" TEXT,
    "analysis_id" TEXT,
    "confidence" REAL,
    "champion_id" TEXT,
    "executed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weex_order_id" TEXT,
    "client_order_id" TEXT,
    "realized_pnl" REAL,
    "realized_pnl_percent" REAL,
    "entry_thesis" TEXT,
    "exit_plan" TEXT,
    "take_profit" REAL,
    "stop_loss" REAL,
    "leverage" REAL,
    "allocation_usd" REAL,
    "entry_confidence" REAL,
    "cooldown_until" DATETIME,
    "invalidated_at" DATETIME,
    "invalidation_reason" TEXT,
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
CREATE TABLE "performance_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolio_id" TEXT NOT NULL,
    "total_value" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "performance_snapshots_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trade_journals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trade_id" TEXT NOT NULL,
    "entry_regime" TEXT,
    "entry_z_score" REAL,
    "entry_funding" REAL,
    "entry_sentiment" REAL,
    "entry_signals" TEXT,
    "analyst_scores" TEXT,
    "judge_reasoning" TEXT,
    "outcome" TEXT,
    "hold_time_hours" REAL,
    "exit_reason" TEXT,
    "lessons_learned" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trade_journals_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
CREATE UNIQUE INDEX "performance_snapshots_portfolio_id_timestamp_key" ON "performance_snapshots"("portfolio_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "trade_journals_trade_id_key" ON "trade_journals"("trade_id");

-- CreateIndex
CREATE INDEX "trade_journals_outcome_idx" ON "trade_journals"("outcome");

-- CreateIndex
CREATE INDEX "trade_journals_entry_regime_idx" ON "trade_journals"("entry_regime");

-- CreateIndex
CREATE INDEX "trade_journals_created_at_idx" ON "trade_journals"("created_at");
