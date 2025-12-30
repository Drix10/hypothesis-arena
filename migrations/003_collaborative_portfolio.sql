-- Migration: Convert from 8 individual portfolios to 1 collaborative portfolio
-- 
-- BACKGROUND:
-- The system was originally designed with 8 separate portfolios (one per analyst).
-- FLOW.md specifies that all 8 analysts should collaborate on ONE shared portfolio.
-- This migration consolidates existing portfolios into a single collaborative portfolio.
--
-- WHAT THIS DOES:
-- 1. Creates a new 'collaborative' portfolio if it doesn't exist
-- 2. Sums up balances from all individual analyst portfolios
-- 3. Keeps individual portfolios for historical reference (marked inactive)
--
-- ROLLBACK: Set collaborative portfolio to inactive and reactivate individual portfolios

BEGIN;

-- Step 0: Ensure unique constraint exists for ON CONFLICT to work
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_user_agent ON portfolios(user_id, agent_id);

-- Step 1: Create collaborative portfolio if it doesn't exist
-- Uses the sum of all existing analyst portfolios as the initial balance
INSERT INTO portfolios (id, user_id, agent_id, agent_name, initial_balance, current_balance, total_trades, status)
SELECT 
    gen_random_uuid() as id,
    user_id,
    'collaborative' as agent_id,
    'Collaborative AI Team' as agent_name,
    SUM(initial_balance) as initial_balance,
    SUM(current_balance) as current_balance,
    SUM(COALESCE(total_trades, 0)) as total_trades,
    'active' as status
FROM portfolios
WHERE agent_id IN ('warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil')
  AND status = 'active'
GROUP BY user_id
ON CONFLICT (user_id, agent_id) 
DO UPDATE SET 
    initial_balance = EXCLUDED.initial_balance,
    current_balance = EXCLUDED.current_balance,
    total_trades = EXCLUDED.total_trades,
    updated_at = NOW();

-- Step 2: Mark individual analyst portfolios as inactive (keep for history)
UPDATE portfolios 
SET status = 'inactive', updated_at = NOW()
WHERE agent_id IN ('warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil')
  AND status = 'active';

-- Step 3: Update trades to reference the collaborative portfolio
-- This preserves trade history while linking to the new shared portfolio
-- Only update trades that belonged to the original analyst portfolios (not unrelated trades)
UPDATE trades t
SET portfolio_id = (
    SELECT p.id FROM portfolios p 
    WHERE p.user_id = t.user_id AND p.agent_id = 'collaborative'
    LIMIT 1
)
WHERE EXISTS (
    SELECT 1 FROM portfolios p 
    WHERE p.user_id = t.user_id AND p.agent_id = 'collaborative'
)
AND EXISTS (
    SELECT 1 FROM portfolios orig 
    WHERE orig.id = t.portfolio_id 
    AND orig.agent_id IN ('warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil')
);

COMMIT;

-- NOTE: After running this migration, restart the trading engine.
-- The engine will now use the collaborative portfolio for all 8 analysts.
