-- Initial database schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  subscription_tier VARCHAR(50) DEFAULT 'free'
);

-- WEEX Accounts table
CREATE TABLE IF NOT EXISTS weex_accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_encrypted VARCHAR(500) NOT NULL,
  secret_key_encrypted VARCHAR(500) NOT NULL,
  passphrase_encrypted VARCHAR(500) NOT NULL,
  account_id VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_sync TIMESTAMP,
  UNIQUE(user_id, account_id)
);

-- Portfolios table
CREATE TABLE IF NOT EXISTS portfolios (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weex_account_id UUID REFERENCES weex_accounts(id),
  agent_name VARCHAR(100) NOT NULL,
  initial_balance DECIMAL(20, 8) NOT NULL,
  current_balance DECIMAL(20, 8) NOT NULL,
  total_return DECIMAL(10, 4) DEFAULT 0,
  win_rate DECIMAL(5, 2) DEFAULT 0,
  sharpe_ratio DECIMAL(10, 4),
  max_drawdown DECIMAL(10, 4) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  trading_mode VARCHAR(50) DEFAULT 'paper'
);

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL,
  size DECIMAL(20, 8) NOT NULL,
  entry_price DECIMAL(20, 8) NOT NULL,
  current_price DECIMAL(20, 8),
  margin_mode VARCHAR(20) DEFAULT 'CROSS',
  leverage DECIMAL(5, 2) DEFAULT 1,
  unrealized_pnl DECIMAL(20, 8) DEFAULT 0,
  realized_pnl DECIMAL(20, 8) DEFAULT 0,
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  is_open BOOLEAN DEFAULT true,
  weex_position_id VARCHAR(255)
);

-- Trades table
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  position_id UUID REFERENCES positions(id),
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL,
  type VARCHAR(20) NOT NULL,
  size DECIMAL(20, 8) NOT NULL,
  price DECIMAL(20, 8) NOT NULL,
  fee DECIMAL(20, 8) DEFAULT 0,
  status VARCHAR(50) NOT NULL,
  reason VARCHAR(255),
  analysis_id UUID,
  confidence DECIMAL(5, 2),
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  weex_order_id VARCHAR(255),
  client_order_id VARCHAR(255) UNIQUE,
  realized_pnl DECIMAL(20, 8),
  realized_pnl_percent DECIMAL(10, 4)
);

-- Analyses table
CREATE TABLE IF NOT EXISTS analyses (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol VARCHAR(50) NOT NULL,
  agent_id VARCHAR(100) NOT NULL,
  agent_name VARCHAR(100) NOT NULL,
  recommendation VARCHAR(50),
  confidence DECIMAL(5, 2),
  thesis TEXT,
  reasoning JSONB,
  target_price DECIMAL(20, 8),
  stop_loss DECIMAL(20, 8),
  take_profit DECIMAL(20, 8),
  time_horizon VARCHAR(100),
  risk_level VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

-- Debates table
CREATE TABLE IF NOT EXISTS debates (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_ids JSONB NOT NULL,
  winner VARCHAR(50) NOT NULL,
  bull_score DECIMAL(5, 2) NOT NULL,
  bear_score DECIMAL(5, 2) NOT NULL,
  summary TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- AI Logs table
CREATE TABLE IF NOT EXISTS ai_logs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id UUID REFERENCES trades(id),
  order_id VARCHAR(255),
  stage VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  input JSONB NOT NULL,
  output JSONB NOT NULL,
  explanation TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  uploaded_to_weex BOOLEAN DEFAULT false,
  weex_log_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Performance Metrics table
CREATE TABLE IF NOT EXISTS performance_metrics (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  portfolio_value DECIMAL(20, 8),
  daily_return DECIMAL(10, 4),
  cumulative_return DECIMAL(10, 4),
  sharpe_ratio DECIMAL(10, 4),
  max_drawdown DECIMAL(10, 4),
  win_rate DECIMAL(5, 2),
  trades_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(portfolio_id, date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_weex_accounts_user_id ON weex_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_agent_name ON portfolios(agent_name);
CREATE INDEX IF NOT EXISTS idx_positions_portfolio_id ON positions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_is_open ON positions(is_open);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio_id ON trades(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_analyses_user_id ON analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_analyses_symbol ON analyses(symbol);
CREATE INDEX IF NOT EXISTS idx_analyses_agent_id ON analyses(agent_id);
CREATE INDEX IF NOT EXISTS idx_debates_user_id ON debates(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_user_id ON ai_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_trade_id ON ai_logs(trade_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_order_id ON ai_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_portfolio_id ON performance_metrics(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_date ON performance_metrics(date);
