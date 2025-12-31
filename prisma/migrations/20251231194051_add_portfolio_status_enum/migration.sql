-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_portfolios" (
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
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_portfolios" ("agent_id", "agent_name", "created_at", "current_balance", "current_drawdown", "id", "initial_balance", "losing_trades", "max_drawdown", "sharpe_ratio", "status", "total_points", "total_return", "total_return_dollar", "total_trades", "total_value", "tournament_wins", "updated_at", "win_rate", "winning_trades") SELECT "agent_id", "agent_name", "created_at", "current_balance", "current_drawdown", "id", "initial_balance", "losing_trades", "max_drawdown", "sharpe_ratio", "status", "total_points", "total_return", "total_return_dollar", "total_trades", "total_value", "tournament_wins", "updated_at", "win_rate", "winning_trades" FROM "portfolios";
DROP TABLE "portfolios";
ALTER TABLE "new_portfolios" RENAME TO "portfolios";
CREATE UNIQUE INDEX "portfolios_agent_id_key" ON "portfolios"("agent_id");
CREATE INDEX "portfolios_status_idx" ON "portfolios"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
