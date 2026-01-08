-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- DEFENSIVE: Handle duplicate client_order_id values before creating unique index
-- Set duplicates to NULL (keeping only the most recent one per client_order_id)
-- NOTE: ROW_NUMBER() window function requires SQLite 3.25.0+ (released 2018-09-15)
-- Prisma's bundled SQLite and most modern systems meet this requirement.
-- If targeting older SQLite, use a subquery with GROUP BY instead.
UPDATE trades SET client_order_id = NULL 
WHERE id NOT IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY client_order_id ORDER BY created_at DESC) as rn
        FROM trades 
        WHERE client_order_id IS NOT NULL
    ) WHERE rn = 1
) AND client_order_id IS NOT NULL;

CREATE TABLE "new_trades" (
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
INSERT INTO "new_trades" ("action", "allocation_usd", "analysis_id", "champion_id", "client_order_id", "confidence", "cooldown_until", "created_at", "entry_confidence", "entry_price", "entry_thesis", "executed_at", "exit_plan", "fee", "id", "invalidated_at", "invalidation_reason", "leverage", "portfolio_id", "price", "rationale", "realized_pnl", "realized_pnl_percent", "reason", "side", "size", "status", "stop_loss", "symbol", "take_profit", "type", "weex_order_id") SELECT "action", "allocation_usd", "analysis_id", "champion_id", "client_order_id", "confidence", "cooldown_until", "created_at", "entry_confidence", "entry_price", "entry_thesis", "executed_at", "exit_plan", "fee", "id", "invalidated_at", "invalidation_reason", "leverage", "portfolio_id", "price", "rationale", "realized_pnl", "realized_pnl_percent", "reason", "side", "size", "status", "stop_loss", "symbol", "take_profit", "type", "weex_order_id" FROM "trades";
DROP TABLE "trades";
ALTER TABLE "new_trades" RENAME TO "trades";
CREATE UNIQUE INDEX "trades_client_order_id_key" ON "trades"("client_order_id");
CREATE INDEX "trades_portfolio_id_idx" ON "trades"("portfolio_id");
CREATE INDEX "trades_symbol_idx" ON "trades"("symbol");
CREATE INDEX "trades_status_idx" ON "trades"("status");
CREATE INDEX "trades_created_at_idx" ON "trades"("created_at");
CREATE INDEX "trades_executed_at_idx" ON "trades"("executed_at");
CREATE INDEX "trades_champion_id_idx" ON "trades"("champion_id");
CREATE INDEX "trades_symbol_status_executed_at_idx" ON "trades"("symbol", "status", "executed_at");
CREATE INDEX "trades_status_side_executed_at_idx" ON "trades"("status", "side", "executed_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
