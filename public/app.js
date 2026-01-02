/**
 * Hypothesis Arena - Premium Frontend Application
 * AI-powered autonomous crypto trading platform
 *
 * @version 3.3.0
 * @author Hypothesis Arena Team
 * @license MIT
 */

"use strict";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = Object.freeze({
  API_BASE: "/api",
  AUTO_REFRESH_INTERVAL: 10000,
  ALERT_DURATION: 5000,
  DEBOUNCE_DELAY: 300,
  ANIMATION_DURATION: 300,
});

// ============================================================================
// APPLICATION STATE
// ============================================================================

const state = {
  // UI state
  refreshInterval: null,
  alertTimeout: null,
  isEngineActionPending: false,
  lastEngineStatus: null,
  lastFocusedElement: null,

  // Request management
  abortControllers: new Map(),
};

// ============================================================================
// ANALYST DATA
// ============================================================================

const ANALYSTS = Object.freeze({
  warren: { emoji: "👴", name: "Warren", style: "Value", color: "#3fb950" },
  cathie: { emoji: "🚀", name: "Cathie", style: "Growth", color: "#58a6ff" },
  jim: { emoji: "📺", name: "Jim", style: "Technical", color: "#f0883e" },
  ray: { emoji: "🌊", name: "Ray", style: "Macro", color: "#a371f7" },
  elon: { emoji: "🐦", name: "Elon", style: "Sentiment", color: "#00d4ff" },
  karen: { emoji: "🛡️", name: "Karen", style: "Risk", color: "#d29922" },
  quant: {
    emoji: "🤖",
    name: "Quant",
    style: "Quantitative",
    color: "#8b949e",
  },
  devil: { emoji: "😈", name: "Devil", style: "Contrarian", color: "#f85149" },
});

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener("DOMContentLoaded", initializeApp);

function initializeApp() {
  // Attach all event listeners
  attachEventListeners();

  // Initial data fetch
  refreshAll();

  // Start auto-refresh
  startAutoRefresh();

  // Cleanup on page unload
  window.addEventListener("beforeunload", cleanup);
  window.addEventListener("visibilitychange", handleVisibilityChange);
}

function cleanup() {
  // Clear all timeouts
  clearTimeout(state.alertTimeout);
  clearInterval(state.refreshInterval);

  // Abort all pending requests
  state.abortControllers.forEach((controller) => controller.abort());
  state.abortControllers.clear();
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    refreshAll();
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function attachEventListeners() {
  // Engine controls with debouncing
  const btnStart = document.getElementById("btn-start");
  const btnStop = document.getElementById("btn-stop");
  const btnTrigger = document.getElementById("btn-trigger");
  const btnRefresh = document.getElementById("btn-refresh");

  btnStart?.addEventListener(
    "click",
    debounce(startEngine, CONFIG.DEBOUNCE_DELAY)
  );
  btnStop?.addEventListener(
    "click",
    debounce(stopEngine, CONFIG.DEBOUNCE_DELAY)
  );
  btnTrigger?.addEventListener(
    "click",
    debounce(triggerCycle, CONFIG.DEBOUNCE_DELAY)
  );
  btnRefresh?.addEventListener(
    "click",
    debounce(refreshAll, CONFIG.DEBOUNCE_DELAY)
  );

  // Alert
  document
    .getElementById("btn-dismiss-alert")
    ?.addEventListener("click", dismissAlert);

  // Modal
  document
    .getElementById("btn-close-modal")
    ?.addEventListener("click", closeModal);
  document
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", closeModal);

  // Analyst cards
  document.querySelectorAll(".analyst-card").forEach((card) => {
    const analystId = card.dataset.analystId;
    if (analystId) {
      card.addEventListener("click", () => showAnalystStats(analystId));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          showAnalystStats(analystId);
        }
      });
    }
  });

  // Global keyboard shortcuts
  document.addEventListener("keydown", handleKeyboardShortcuts);

  // Market cards keyboard accessibility
  document
    .getElementById("market-overview")
    ?.addEventListener("keydown", (e) => {
      if (
        (e.key === "Enter" || e.key === " ") &&
        e.target.classList.contains("market-card")
      ) {
        e.preventDefault();
        const symbol = e.target.querySelector(".market-symbol")?.textContent;
        if (symbol) showMarketInfo(symbol);
      }
    });

  // FIXED: Event delegation for position close buttons (prevents memory leak)
  const positionsContainer = document.getElementById("positions-list");
  if (positionsContainer) {
    positionsContainer.addEventListener("click", (e) => {
      const target = e.target;
      if (target.classList.contains("btn-close-position")) {
        const symbol = target.dataset.symbol;
        const side = target.dataset.side;
        const size = target.dataset.size;
        if (symbol && side && size) {
          closePosition(symbol, side, size);
        }
      }
    });
  }
}

function handleKeyboardShortcuts(e) {
  // Escape closes modal
  if (e.key === "Escape") {
    closeModal();
    return;
  }

  // Ctrl/Cmd + R refreshes (prevent default browser refresh)
  if ((e.ctrlKey || e.metaKey) && e.key === "r") {
    e.preventDefault();
    refreshAll();
    return;
  }
}

// ============================================================================
// AUTO REFRESH
// ============================================================================

function startAutoRefresh() {
  if (state.refreshInterval) clearInterval(state.refreshInterval);
  state.refreshInterval = setInterval(refreshAll, CONFIG.AUTO_REFRESH_INTERVAL);
}

async function refreshAll() {
  const tasks = [
    fetchEngineStatus(),
    fetchPortfolio(),
    fetchPositions(),
    fetchRecentActivity(),
    fetchMarketOverview(),
  ];

  try {
    await Promise.allSettled(tasks);
  } catch (err) {
    console.error("Refresh error:", err);
  }
}

// ============================================================================
// ENGINE STATUS
// ============================================================================

async function fetchEngineStatus() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/autonomous/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const status = data.data || data;

    updateEngineUI(status);
    updateConnectionStatus(document.getElementById("weex-status"), true);
  } catch (err) {
    updateConnectionStatus(document.getElementById("weex-status"), false);
    // Silent failure - status will show offline
  }
}

function updateConnectionStatus(element, isOnline) {
  if (element) {
    element.dataset.status = isOnline ? "online" : "offline";
  }
}

function updateEngineUI(status) {
  if (!status) return;

  const indicator = document.getElementById("engine-indicator");
  const statusText = document.getElementById("engine-status-text");
  const btnStart = document.getElementById("btn-start");
  const btnStop = document.getElementById("btn-stop");

  const isRunning = status.isRunning;

  // Update indicator
  if (indicator) {
    indicator.classList.toggle("running", isRunning);
  }

  if (statusText) {
    statusText.textContent = isRunning ? "Running" : "Offline";
  }

  // Update buttons (respect pending state)
  if (!state.isEngineActionPending) {
    if (btnStart) btnStart.disabled = isRunning;
    if (btnStop) btnStop.disabled = !isRunning;
  }

  // Update stats
  updateText("cycle-count", status.cycleCount ?? 0);
  updateText(
    "debates-run",
    status.totalDebatesRun ??
      status.currentCycle?.debatesRun ??
      status.stats?.totalDebates ??
      0
  );

  // Mode badge
  const modeEl = document.getElementById("mode-status");
  if (modeEl) {
    const isDryRun = status.dryRun;
    modeEl.textContent = isDryRun ? "Paper" : "Live";
    modeEl.classList.toggle("dry", isDryRun);
    modeEl.classList.toggle("live", !isDryRun);
  }

  // Next cycle countdown
  if (status.nextCycleIn !== undefined) {
    const seconds = Math.max(0, Math.round(status.nextCycleIn / 1000));
    updateText("next-cycle", seconds > 0 ? `${seconds}s` : "Now");
  }

  state.lastEngineStatus = status;
}

// ============================================================================
// PORTFOLIO
// ============================================================================

async function fetchPortfolio() {
  try {
    const res = await fetchWithAbort(
      `${CONFIG.API_BASE}/weex/assets`,
      "portfolio"
    );
    if (!res) return;

    const data = await res.json();
    const assets = data.assets || data.data || {};

    // Update balance displays
    updateText("balance", formatCurrency(assets.available || 0));
    updateText("equity", formatCurrency(assets.equity || 0));

    // Update Unrealized P&L (from open positions)
    const unrealizedPnl = parseFloat(assets.unrealizedPL) || 0;
    const unrealizedPnlEl = document.getElementById("unrealized-pnl");
    if (unrealizedPnlEl) {
      unrealizedPnlEl.textContent = formatCurrency(unrealizedPnl);
      unrealizedPnlEl.classList.toggle("positive", unrealizedPnl >= 0);
      unrealizedPnlEl.classList.toggle("negative", unrealizedPnl < 0);
    }

    // Update Total Wallet P&L (since starting balance)
    const totalPnl = parseFloat(assets.totalWalletPnl) || 0;
    const totalPnlPercent = parseFloat(assets.totalWalletPnlPercent) || 0;
    const totalPnlEl = document.getElementById("total-pnl");
    if (totalPnlEl) {
      const sign = totalPnl >= 0 ? "+" : "";
      totalPnlEl.textContent = `${sign}$${Math.abs(totalPnl).toFixed(
        2
      )} (${sign}${totalPnlPercent.toFixed(1)}%)`;
      totalPnlEl.classList.toggle("positive", totalPnl >= 0);
      totalPnlEl.classList.toggle("negative", totalPnl < 0);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      // Silent failure - portfolio will show stale data
    }
  }
}

// ============================================================================
// MARKET OVERVIEW
// ============================================================================

async function fetchMarketOverview() {
  const container = document.getElementById("market-overview");
  if (!container) return;

  // All 8 tradeable coins
  const symbols = [
    "cmt_btcusdt",
    "cmt_ethusdt",
    "cmt_solusdt",
    "cmt_xrpusdt",
    "cmt_dogeusdt",
    "cmt_adausdt",
    "cmt_bnbusdt",
    "cmt_ltcusdt",
  ];
  const markets = [];

  try {
    // Fetch all tickers in parallel
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const res = await fetch(`${CONFIG.API_BASE}/weex/ticker/${symbol}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const ticker = data.ticker || data.data || data;

        return {
          symbol: formatSymbol(symbol),
          price: parseFloat(ticker.last || 0),
          change24h: parseFloat(ticker.priceChangePercent || 0) * 100,
        };
      })
    );

    // Collect successful results
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        markets.push(result.value);
      }
    });

    if (markets.length > 0) {
      container.innerHTML = markets.map(renderMarketCard).join("");
      updateText("market-updated", formatTime(new Date()));
    } else {
      container.innerHTML = renderEmptyState("📊", "Failed to load markets");
    }
  } catch (err) {
    container.innerHTML = renderEmptyState("⚠️", "Market data unavailable");
  }
}

function renderMarketCard(market) {
  const changeClass = market.change24h >= 0 ? "positive" : "negative";
  const changeSign = market.change24h >= 0 ? "+" : "";

  // SECURITY: Escape ALL user-controlled data including aria-label to prevent XSS
  return `
    <div class="market-card" onclick="showMarketInfo('${escapeHtml(
      market.symbol
    )}')" 
         role="listitem" tabindex="0" aria-label="${escapeHtml(
           market.symbol
         )} price ${formatPrice(
    market.price
  )}, ${changeSign}${market.change24h.toFixed(2)}%">
      <span class="market-symbol">${escapeHtml(market.symbol)}</span>
      <span class="market-price">${formatPrice(market.price)}</span>
      <span class="market-change ${changeClass}">${changeSign}${market.change24h.toFixed(
    2
  )}%</span>
    </div>
  `;
}

function showMarketInfo(symbol) {
  showAlert(`📊 ${symbol}/USDT - Chart view coming soon`, "info");
}

// ============================================================================
// POSITIONS
// ============================================================================

async function fetchPositions() {
  const container = document.getElementById("positions-list");
  const countEl = document.getElementById("positions-count");
  if (!container) return;

  try {
    const res = await fetch(`${CONFIG.API_BASE}/weex/positions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const positions = data.positions || data.data || [];
    const activePositions = positions.filter((p) => parseFloat(p.size) > 0);

    if (countEl) countEl.textContent = activePositions.length;

    if (activePositions.length > 0) {
      // FIXED: No need to attach listeners - using event delegation on container
      container.innerHTML = activePositions.map(renderPositionCard).join("");
    } else {
      container.innerHTML = renderEmptyState("📭", "No open positions");
    }
  } catch (err) {
    container.innerHTML = renderEmptyState("⚠️", "Failed to load positions");
  }
}

function renderPositionCard(pos) {
  const pnl = parseFloat(pos.unrealizedPL || pos.unrealizePnl || 0);
  const side = (pos.side || "").toLowerCase();
  const symbol = formatSymbol(pos.symbol);
  const pnlClass = pnl >= 0 ? "positive" : "negative";
  const rawSymbol = pos.symbol || "";
  const rawSide = (pos.side || "").toUpperCase();
  const rawSize = pos.size || "0";

  // Calculate invested amount (margin used) = (size * entryPrice) / leverage
  const size = parseFloat(pos.size) || 0;
  const entryPrice = parseFloat(pos.entryPrice || pos.avgPrice) || 0;
  const leverage = parseFloat(pos.leverage) || 1;
  const investedAmount = leverage > 0 ? (size * entryPrice) / leverage : 0;

  return `
    <div class="position-card" role="listitem">
      <div class="position-header">
        <span class="position-symbol">${escapeHtml(symbol)}</span>
        <span class="position-side ${side}">${escapeHtml(
    side.toUpperCase()
  )}</span>
        <span class="position-leverage">${pos.leverage || 1}x</span>
        <button 
          class="btn-close-position" 
          data-symbol="${escapeHtml(rawSymbol)}"
          data-side="${escapeHtml(rawSide)}"
          data-size="${escapeHtml(rawSize)}"
          aria-label="Close position"
          title="Close position">
          ✕
        </button>
      </div>
      <div class="position-details">
        <div class="position-detail">
          <span class="label">Invested</span>
          <span class="value">$${investedAmount.toFixed(2)}</span>
        </div>
        <div class="position-detail">
          <span class="label">Size</span>
          <span class="value">${formatNumber(pos.size || 0)}</span>
        </div>
        <div class="position-detail">
          <span class="label">Entry</span>
          <span class="value">${formatPrice(
            pos.entryPrice || pos.avgPrice || 0
          )}</span>
        </div>
        <div class="position-detail">
          <span class="label">Mark</span>
          <span class="value">${formatPrice(pos.markPrice || 0)}</span>
        </div>
        <div class="position-detail">
          <span class="label">P&L</span>
          <span class="value ${pnlClass}">${formatCurrency(pnl)}</span>
        </div>
        <div class="position-detail">
          <span class="label">Liq.</span>
          <span class="value">${formatPrice(pos.liquidationPrice || 0)}</span>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// RECENT ACTIVITY
// ============================================================================

async function fetchRecentActivity() {
  const container = document.getElementById("activity-log");
  if (!container) return;

  try {
    const res = await fetchWithAbort(
      `${CONFIG.API_BASE}/autonomous/history?limit=10`,
      "activity"
    );
    if (!res) return;

    const data = await res.json();
    const items = data.data || [];

    if (items.length > 0) {
      container.innerHTML = items.map(renderActivityItem).join("");
    } else {
      container.innerHTML = renderEmptyState("🕐", "No recent activity");
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      // Silent failure - activity will show stale data
    }
  }
}

function renderActivityItem(item) {
  const symbol = formatSymbol(item.symbol);
  const action = item.action || item.type || "Trade";
  const time = formatTime(item.timestamp || item.createdAt);

  return `
    <div class="activity-item" role="listitem">
      <div class="activity-info">
        <span class="activity-symbol">${escapeHtml(symbol)}</span>
        <span class="activity-action">${escapeHtml(action)}</span>
        ${
          item.result
            ? `<span class="activity-result">${escapeHtml(item.result)}</span>`
            : ""
        }
      </div>
      <span class="activity-time">${time}</span>
    </div>
  `;
}

// ============================================================================
// ANALYST STATS MODAL
// ============================================================================

async function showAnalystStats(analystId) {
  const modal = document.getElementById("analyst-modal");
  const content = document.getElementById("modal-content");
  const info = ANALYSTS[analystId] || {
    emoji: "🤖",
    name: analystId,
    style: "Unknown",
  };

  if (!modal || !content) return;

  // Update modal header
  document.getElementById("modal-analyst-emoji").textContent = info.emoji;
  document.getElementById("modal-analyst-name").textContent = info.name;
  document.getElementById("modal-analyst-style").textContent = info.style;

  // Show modal with loading state
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden"; // Prevent background scroll
  content.innerHTML = renderModalLoading();

  // Focus management - focus close button and trap focus within modal
  const closeBtn = document.getElementById("btn-close-modal");
  closeBtn?.focus();

  // Store last focused element to restore on close
  state.lastFocusedElement = document.activeElement;

  try {
    const res = await fetch(
      `${CONFIG.API_BASE}/trading/analysts/${encodeURIComponent(
        analystId
      )}/stats`
    );
    const data = await res.json();

    if (data.success && data.stats) {
      content.innerHTML = renderAnalystStats(
        data.stats,
        data.recentTrades || []
      );
    } else {
      content.innerHTML = renderEmptyState(
        "📊",
        data.error || "No statistics available yet"
      );
    }
  } catch (err) {
    content.innerHTML = renderEmptyState(
      "⚠️",
      `Failed to load: ${err.message}`
    );
  }
}

function renderModalLoading() {
  return `
    <div class="modal-loading">
      <div class="spinner" aria-hidden="true"></div>
      <span>Loading statistics...</span>
    </div>
  `;
}

function renderAnalystStats(stats, recentTrades) {
  const winRateClass = parseFloat(stats.winRate) >= 50 ? "positive" : "";
  const totalPnlClass = (stats.totalPnl || 0) >= 0 ? "positive" : "negative";
  const avgPnlClass = (stats.avgPnl || 0) >= 0 ? "positive" : "negative";

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <span class="label">Total Trades</span>
        <span class="value">${stats.totalTrades || 0}</span>
      </div>
      <div class="stat-card">
        <span class="label">Win Rate</span>
        <span class="value ${winRateClass}">${formatNumber(
    stats.winRate || 0
  )}%</span>
      </div>
      <div class="stat-card">
        <span class="label">Total P&L</span>
        <span class="value ${totalPnlClass}">${formatCurrency(
    stats.totalPnl || 0
  )}</span>
      </div>
      <div class="stat-card">
        <span class="label">Avg P&L</span>
        <span class="value ${avgPnlClass}">${formatCurrency(
    stats.avgPnl || 0
  )}</span>
      </div>
      <div class="stat-card">
        <span class="label">Best Trade</span>
        <span class="value positive">${formatCurrency(
          stats.bestTrade || 0
        )}</span>
      </div>
      <div class="stat-card">
        <span class="label">Worst Trade</span>
        <span class="value negative">${formatCurrency(
          stats.worstTrade || 0
        )}</span>
      </div>
      <div class="stat-card">
        <span class="label">Winning</span>
        <span class="value positive">${stats.winningTrades || 0}</span>
      </div>
      <div class="stat-card">
        <span class="label">Losing</span>
        <span class="value negative">${stats.losingTrades || 0}</span>
      </div>
    </div>
    
    ${
      stats.favoriteSymbol
        ? `
      <div class="stat-card" style="margin-bottom: var(--space-lg);">
        <span class="label">Favorite Symbol</span>
        <span class="value" style="color: var(--gold);">${escapeHtml(
          formatSymbol(stats.favoriteSymbol)
        )}</span>
      </div>
    `
        : ""
    }
    
    ${recentTrades.length > 0 ? renderRecentTrades(recentTrades) : ""}
  `;
}

function renderRecentTrades(trades) {
  return `
    <div class="recent-trades-section">
      <h4 class="section-title">📜 Recent Trades</h4>
      <div class="recent-trades-list" role="list">
        ${trades
          .slice(0, 5)
          .map((trade) => {
            const pnl = trade.realized_pnl || 0;
            const symbol = formatSymbol(trade.symbol);
            const side = (trade.side || "").toLowerCase();
            const pnlClass = pnl >= 0 ? "positive" : "negative";

            return `
            <div class="trade-item" role="listitem">
              <div class="trade-info">
                <span class="trade-symbol">${escapeHtml(symbol)}</span>
                <span class="trade-side ${side}">${escapeHtml(
              trade.side || ""
            )}</span>
              </div>
              <span class="trade-pnl ${pnlClass}">${formatCurrency(pnl)}</span>
            </div>
          `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function closeModal() {
  const modal = document.getElementById("analyst-modal");
  if (modal) {
    modal.classList.add("hidden");
    document.body.style.overflow = ""; // Restore scroll

    // Restore focus to the element that opened the modal
    if (
      state.lastFocusedElement &&
      typeof state.lastFocusedElement.focus === "function"
    ) {
      state.lastFocusedElement.focus();
      state.lastFocusedElement = null;
    }
  }
}

// ============================================================================
// ENGINE CONTROLS
// ============================================================================

async function startEngine() {
  // FIXED: Race condition - check and set flag atomically
  if (state.isEngineActionPending) return;
  state.isEngineActionPending = true; // Set IMMEDIATELY before any async operations

  const btnStart = document.getElementById("btn-start");
  if (btnStart) {
    btnStart.disabled = true;
    btnStart.setAttribute("aria-busy", "true");
  }

  try {
    const res = await fetch(`${CONFIG.API_BASE}/autonomous/start`, {
      method: "POST",
    });
    const data = await res.json();

    if (data.success) {
      showAlert("🚀 Engine started successfully", "success");
      await fetchEngineStatus();
    } else {
      showAlert(`❌ Failed: ${data.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showAlert(`❌ Error: ${err.message}`, "error");
  } finally {
    state.isEngineActionPending = false;
    if (btnStart) btnStart.removeAttribute("aria-busy");
  }
}

async function stopEngine() {
  // FIXED: Race condition - check and set flag atomically
  if (state.isEngineActionPending) return;
  state.isEngineActionPending = true; // Set IMMEDIATELY before any async operations

  const btnStop = document.getElementById("btn-stop");
  if (btnStop) {
    btnStop.disabled = true;
    btnStop.setAttribute("aria-busy", "true");
  }

  try {
    const res = await fetch(`${CONFIG.API_BASE}/autonomous/stop`, {
      method: "POST",
    });
    const data = await res.json();

    if (data.success) {
      showAlert("⏹️ Engine stopped", "info");
      await fetchEngineStatus();
    } else {
      showAlert(`❌ Failed: ${data.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showAlert(`❌ Error: ${err.message}`, "error");
  } finally {
    state.isEngineActionPending = false;
    if (btnStop) btnStop.removeAttribute("aria-busy");
  }
}

async function triggerCycle() {
  // FIXED: Race condition - check and set flag atomically
  if (state.isEngineActionPending) return;
  state.isEngineActionPending = true; // Set IMMEDIATELY before any async operations

  const btnTrigger = document.getElementById("btn-trigger");
  if (btnTrigger) {
    btnTrigger.disabled = true;
    btnTrigger.setAttribute("aria-busy", "true");
  }

  try {
    const res = await fetch(`${CONFIG.API_BASE}/autonomous/trigger`, {
      method: "POST",
    });
    const data = await res.json();

    if (data.success) {
      showAlert(data.message || "⚡ Cycle triggered", "success");
    } else {
      showAlert(`❌ Failed: ${data.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showAlert(`❌ Error: ${err.message}`, "error");
  } finally {
    state.isEngineActionPending = false;

    if (btnTrigger) {
      btnTrigger.disabled = false;
      btnTrigger.removeAttribute("aria-busy");
    }
  }
}

async function closePosition(symbol, side, size) {
  if (!symbol || !side || !size) return;

  if (
    !confirm(
      `Close ${side} position for ${formatSymbol(symbol)} (${size} units)?`
    )
  ) {
    return;
  }

  // FIXED: Disable all close buttons to prevent duplicate requests
  const buttons = document.querySelectorAll(".btn-close-position");
  buttons.forEach((btn) => {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  });

  // FIXED: Add timeout to prevent hanging requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${CONFIG.API_BASE}/trading/manual/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, side, size }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const data = await res.json();

    if (res.ok && data.success) {
      showAlert(`✅ Position closed: ${formatSymbol(symbol)}`, "success");
      await refreshAll();
    } else {
      showAlert(`❌ Failed: ${data.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      showAlert("❌ Request timeout - please try again", "error");
    } else {
      showAlert(`❌ Error: ${err.message}`, "error");
    }
  } finally {
    buttons.forEach((btn) => {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    });
  }
}

// ============================================================================
// ALERTS
// ============================================================================

function showAlert(message, type = "info") {
  const banner = document.getElementById("alert-banner");
  const messageEl = document.getElementById("alert-message");
  const iconEl = banner?.querySelector(".alert-icon");

  if (!banner || !messageEl) return;

  // Clear existing timeout
  if (state.alertTimeout) {
    clearTimeout(state.alertTimeout);
    state.alertTimeout = null;
  }

  const icons = {
    info: "ℹ️",
    success: "✅",
    error: "❌",
    warning: "⚠️",
  };

  messageEl.textContent = message;
  if (iconEl) iconEl.textContent = icons[type] || icons.info;

  banner.className = `alert-banner ${type}`;
  banner.classList.remove("hidden");

  // Auto-dismiss
  state.alertTimeout = setTimeout(dismissAlert, CONFIG.ALERT_DURATION);
}

function dismissAlert() {
  const banner = document.getElementById("alert-banner");
  if (banner) {
    banner.classList.add("hidden");
  }

  if (state.alertTimeout) {
    clearTimeout(state.alertTimeout);
    state.alertTimeout = null;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function updateText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatCurrency(value) {
  const num = parseFloat(value) || 0;
  const sign = num >= 0 ? "+" : "";
  return `${sign}$${Math.abs(num).toFixed(2)}`;
}

function formatPrice(value) {
  const num = parseFloat(value) || 0;
  if (num === 0) return "$0.00";
  if (num < 1) return `$${num.toFixed(6)}`;
  if (num < 100) return `$${num.toFixed(4)}`;
  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value) {
  const num = parseFloat(value);

  // SECURITY: Validate number is finite to prevent rendering NaN/Infinity
  if (!Number.isFinite(num)) return "0.00";
  if (num === 0) return "0.00";

  // FIXED: Handle very small numbers (< 0.01) with more decimal places
  if (Math.abs(num) < 0.01) {
    // For very small numbers, show up to 4 decimal places
    return num.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  // For normal numbers, use 2 decimal places
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTime(timestamp) {
  if (!timestamp) return "--:--";
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function formatSymbol(symbol) {
  if (!symbol) return "";
  return symbol.replace("cmt_", "").replace("usdt", "").toUpperCase();
}

function renderEmptyState(icon, text) {
  return `
    <div class="empty-state">
      <span class="empty-icon" aria-hidden="true">${icon}</span>
      <span class="empty-text">${escapeHtml(text)}</span>
    </div>
  `;
}

// Fetch with AbortController
async function fetchWithAbort(url, key) {
  // Abort existing request
  if (state.abortControllers.has(key)) {
    state.abortControllers.get(key).abort();
  }

  const controller = new AbortController();
  state.abortControllers.set(key, controller);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } finally {
    if (state.abortControllers.get(key) === controller) {
      state.abortControllers.delete(key);
    }
  }
}

// Debounce utility
function debounce(fn, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

// XSS Protection
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  const str = String(text);
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Export for global access (needed for onclick handlers)
window.showMarketInfo = showMarketInfo;
