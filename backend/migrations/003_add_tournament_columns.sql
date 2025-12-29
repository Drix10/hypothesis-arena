-- Migration: Add tournament tracking columns for collaborative flow
-- Date: 2025-12-25

-- Add tournament_wins column to portfolios table
ALTER TABLE portfolios 
ADD COLUMN IF NOT EXISTS tournament_wins INTEGER DEFAULT 0;

-- Add total_points column to portfolios table for leaderboard scoring
ALTER TABLE portfolios 
ADD COLUMN IF NOT EXISTS total_points INTEGER DEFAULT 0;

-- Add champion_id column to trades table to track which analyst won the trade
-- NOTE: Using VARCHAR instead of FK because analyst IDs are string identifiers
-- not database UUIDs. The valid values are enforced at application level.
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS champion_id VARCHAR(50);

-- Create indexes for faster leaderboard queries
-- NOTE: Using regular CREATE INDEX (not CONCURRENTLY) because:
-- 1. This runs in a migration transaction
-- 2. CONCURRENTLY cannot run inside a transaction
-- For production with large tables, run these manually outside transaction:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_portfolios_tournament_wins ON portfolios(tournament_wins DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_portfolios_total_points ON portfolios(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_portfolios_tournament_wins ON portfolios(tournament_wins DESC);
CREATE INDEX IF NOT EXISTS idx_portfolios_total_points ON portfolios(total_points DESC);

-- Add comment for documentation
COMMENT ON COLUMN portfolios.tournament_wins IS 'Number of tournament championships won by this analyst';
COMMENT ON COLUMN portfolios.total_points IS 'Total points accumulated from tournament performance';
COMMENT ON COLUMN trades.champion_id IS 'ID of the analyst who won the tournament for this trade (e.g., warren, cathie, jim)';
