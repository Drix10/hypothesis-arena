-- Add missing columns to portfolios table for autonomous trading engine
-- WRAPPED IN TRANSACTION for atomicity
-- 
-- NOTE: IF NOT EXISTS only prevents errors if column exists, but does NOT
-- apply constraints to existing columns. We handle this by:
-- 1. Adding columns without NOT NULL first
-- 2. Backfilling NULL values
-- 3. Then altering to add NOT NULL constraint
--
-- PREREQUISITES:
-- This migration requires the following tables to exist (from 001_initial.sql):
--   - users: Must have id (UUID) column
--   - portfolios: Must have id (UUID), current_balance columns
--   - trades: Must have id (UUID) column
-- Run 001_initial.sql first if these tables don't exist.

BEGIN;

-- Add agent_id column (separate from agent_name for internal ID)
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS agent_id VARCHAR(50);

-- Add counter columns WITHOUT NOT NULL first (IF NOT EXISTS won't apply constraints to existing)
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS total_trades INTEGER DEFAULT 0;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS winning_trades INTEGER DEFAULT 0;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS losing_trades INTEGER DEFAULT 0;

-- Add total_value with DEFAULT 0 to prevent NULL between ALTER and backfill
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS total_value DECIMAL(20, 8) DEFAULT 0;

-- Add total_return_dollar (absolute return in USDT)
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS total_return_dollar DECIMAL(20, 8) DEFAULT 0;

-- Add current_drawdown tracking
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS current_drawdown DECIMAL(10, 4) DEFAULT 0;

-- Add status column for portfolio state
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';

-- Add user_id column to trades table if missing (ON DELETE SET NULL to preserve trade history)
ALTER TABLE trades ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Create index on agent_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_portfolios_agent_id ON portfolios(agent_id);

-- Create performance_snapshots table for circuit breaker drawdown calculations
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  total_value DECIMAL(20, 8) NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_performance_snapshots_user_id ON performance_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_performance_snapshots_portfolio_id ON performance_snapshots(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_performance_snapshots_timestamp ON performance_snapshots(timestamp);

-- STEP 1: Handle NULL values BEFORE applying NOT NULL constraints
-- Only update NULL values, preserve intentional zeros
UPDATE portfolios SET total_trades = 0 WHERE total_trades IS NULL;
UPDATE portfolios SET winning_trades = 0 WHERE winning_trades IS NULL;
UPDATE portfolios SET losing_trades = 0 WHERE losing_trades IS NULL;

-- Backfill total_value from current_balance only if NULL (preserve intentional zeros)
-- NOTE: current_balance column must exist from 001_initial.sql
UPDATE portfolios SET total_value = COALESCE(current_balance, 0) WHERE total_value IS NULL;

-- STEP 2: Now apply NOT NULL constraints to existing columns
-- These will succeed because we've already backfilled NULL values
ALTER TABLE portfolios ALTER COLUMN total_trades SET NOT NULL;
ALTER TABLE portfolios ALTER COLUMN winning_trades SET NOT NULL;
ALTER TABLE portfolios ALTER COLUMN losing_trades SET NOT NULL;
ALTER TABLE portfolios ALTER COLUMN total_value SET NOT NULL;

COMMIT;
