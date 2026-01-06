/*
  Migration: v5_exit_plan_tracking
  
  IMPORTANT: This migration adds `entry_price` as a required column.
  For existing rows, we copy the value from `price` (see INSERT statement below).
  This is safe because `price` always contained the entry price for existing trades.
  
  New columns added:
  - entry_price (required): Canonical entry price field
  - rationale, entry_thesis, exit_plan: Trade documentation
  - take_profit, stop_loss: Exit targets
  - leverage, allocation_usd: Position sizing
  - entry_confidence, cooldown_until: Anti-churn tracking
  - invalidated_at, invalidation_reason: Exit plan invalidation
  - champion: Analyst name (display-friendly version of champion_id)
  - action: Trade action type (BUY, SELL, HOLD, CLOSE, REDUCE)
*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_trades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolio_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "action" TEXT,
    "size" REAL NOT NULL,
    "entry_price" REAL NOT NULL,
    "price" REAL NOT NULL,
    "fee" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "rationale" TEXT,
    "analysis_id" TEXT,
    "confidence" REAL,
    "champion_id" TEXT,
    "champion" TEXT,
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
INSERT INTO "new_trades" ("analysis_id", "champion_id", "client_order_id", "confidence", "created_at", "executed_at", "fee", "id", "portfolio_id", "price", "entry_price", "realized_pnl", "realized_pnl_percent", "reason", "side", "size", "status", "symbol", "type", "weex_order_id") SELECT "analysis_id", "champion_id", "client_order_id", "confidence", "created_at", "executed_at", "fee", "id", "portfolio_id", "price", "price", "realized_pnl", "realized_pnl_percent", "reason", "side", "size", "status", "symbol", "type", "weex_order_id" FROM "trades";
-- NOTE: entry_price is populated from price (both get the same value from old price column)
-- This is semantically correct: the old "price" field always stored the entry price
DROP TABLE "trades";
ALTER TABLE "new_trades" RENAME TO "trades";
CREATE UNIQUE INDEX "trades_client_order_id_key" ON "trades"("client_order_id");
CREATE INDEX "trades_portfolio_id_idx" ON "trades"("portfolio_id");
CREATE INDEX "trades_symbol_idx" ON "trades"("symbol");
CREATE INDEX "trades_status_idx" ON "trades"("status");
CREATE INDEX "trades_created_at_idx" ON "trades"("created_at");
CREATE INDEX "trades_executed_at_idx" ON "trades"("executed_at");
CREATE INDEX "trades_champion_id_idx" ON "trades"("champion_id");
CREATE INDEX "trades_champion_idx" ON "trades"("champion");
CREATE INDEX "trades_symbol_status_executed_at_idx" ON "trades"("symbol", "status", "executed_at");
CREATE INDEX "trades_status_side_executed_at_idx" ON "trades"("status", "side", "executed_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
