/**
 * Trading Settings Component - Strategic Arena Theme
 * Premium settings interface matching analysis aesthetic
 */

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { TradingSystemState } from "../../types/trading";
import { tradingService } from "../../services/trading";

interface TradingSettingsProps {
  state: TradingSystemState;
  onUpdate: (state: TradingSystemState) => void;
  onReset: () => void;
  onClose: () => void;
}

export const TradingSettings: React.FC<TradingSettingsProps> = ({
  state,
  onUpdate,
  onReset,
  onClose,
}) => {
  const [localState, setLocalState] = useState(state);

  // Sync local state when props change
  useEffect(() => {
    setLocalState(state);
  }, [state]);

  const handleSave = () => {
    tradingService.saveTradingState(localState);
    onUpdate(localState);
    onClose();
  };

  const parseAndValidateNumber = (
    value: string,
    min: number,
    max: number,
    defaultVal: number
  ): number => {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return defaultVal;
    return Math.max(min, Math.min(max, parsed));
  };

  const parseAndValidateInt = (
    value: string,
    min: number,
    max: number,
    defaultVal: number
  ): number => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) return defaultVal;
    return Math.max(min, Math.min(max, parsed));
  };

  const updatePositionSizingRule = (key: string, value: number) => {
    setLocalState({
      ...localState,
      positionSizingRules: {
        ...localState.positionSizingRules,
        [key]: value,
      },
    });
  };

  const updateRiskManagementRule = (key: string, value: number | boolean) => {
    setLocalState({
      ...localState,
      riskManagementRules: {
        ...localState.riskManagementRules,
        [key]: value,
      },
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-xl p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-serif font-bold text-white flex items-center gap-2">
          <span className="text-2xl">⚙️</span>
          Trading Settings
        </h2>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white transition-colors text-xl"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Position Sizing Rules */}
        <div>
          <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
            <span>📊</span>
            Position Sizing Rules
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Max Position Size (%)
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={localState.positionSizingRules.maxPositionPercent * 100}
                onChange={(e) =>
                  updatePositionSizingRule(
                    "maxPositionPercent",
                    parseAndValidateNumber(e.target.value, 1, 100, 20) / 100
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Maximum % of portfolio per position
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Max Total Invested (%)
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={localState.positionSizingRules.maxTotalInvested * 100}
                onChange={(e) =>
                  updatePositionSizingRule(
                    "maxTotalInvested",
                    parseAndValidateNumber(e.target.value, 1, 100, 80) / 100
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Maximum % of portfolio invested
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Min Trade Value ($)
              </label>
              <input
                type="number"
                min="1"
                value={localState.positionSizingRules.minTradeValue}
                onChange={(e) =>
                  updatePositionSizingRule(
                    "minTradeValue",
                    parseAndValidateNumber(e.target.value, 1, 100000, 100)
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Minimum trade size in dollars
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Max Positions Per Agent
              </label>
              <input
                type="number"
                min="1"
                max="50"
                value={localState.positionSizingRules.maxPositionsPerAgent}
                onChange={(e) =>
                  updatePositionSizingRule(
                    "maxPositionsPerAgent",
                    parseAndValidateInt(e.target.value, 1, 50, 10)
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Maximum number of positions
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Reserve Cash (%)
              </label>
              <input
                type="number"
                min="0"
                max="50"
                value={localState.positionSizingRules.reserveCashPercent * 100}
                onChange={(e) =>
                  updatePositionSizingRule(
                    "reserveCashPercent",
                    parseAndValidateNumber(e.target.value, 0, 50, 5) / 100
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                % of cash to keep in reserve
              </p>
            </div>
          </div>
        </div>

        {/* Risk Management Rules */}
        <div>
          <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
            <span>🛡️</span>
            Risk Management Rules
          </h3>

          <div className="space-y-4">
            <div>
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={localState.riskManagementRules.enableStopLoss}
                  onChange={(e) =>
                    updateRiskManagementRule("enableStopLoss", e.target.checked)
                  }
                  className="mr-2 w-4 h-4 accent-cyan"
                />
                <span className="text-sm font-medium text-white">
                  Enable Stop Loss
                </span>
              </label>
            </div>

            {localState.riskManagementRules.enableStopLoss && (
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                  Stop Loss (%)
                </label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={localState.riskManagementRules.stopLossPercent * 100}
                  onChange={(e) =>
                    updateRiskManagementRule(
                      "stopLossPercent",
                      parseAndValidateNumber(e.target.value, 1, 50, 15) / 100
                    )
                  }
                  className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
                />
                <p className="text-[10px] text-slate-500 mt-1.5">
                  Sell if position down by this %
                </p>
              </div>
            )}

            <div>
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={localState.riskManagementRules.enableTakeProfit}
                  onChange={(e) =>
                    updateRiskManagementRule(
                      "enableTakeProfit",
                      e.target.checked
                    )
                  }
                  className="mr-2 w-4 h-4 accent-cyan"
                />
                <span className="text-sm font-medium text-white">
                  Enable Take Profit
                </span>
              </label>
            </div>

            {localState.riskManagementRules.enableTakeProfit && (
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                  Take Profit (%)
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={localState.riskManagementRules.takeProfitPercent * 100}
                  onChange={(e) =>
                    updateRiskManagementRule(
                      "takeProfitPercent",
                      parseAndValidateNumber(e.target.value, 1, 100, 25) / 100
                    )
                  }
                  className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
                />
                <p className="text-[10px] text-slate-500 mt-1.5">
                  Sell half if position up by this %
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Max Drawdown Before Pause (%)
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={
                  localState.riskManagementRules.maxDrawdownBeforePause * 100
                }
                onChange={(e) =>
                  updateRiskManagementRule(
                    "maxDrawdownBeforePause",
                    parseAndValidateNumber(e.target.value, 1, 100, 30) / 100
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Pause trading at this drawdown
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Max Drawdown Before Liquidate (%)
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={
                  localState.riskManagementRules.maxDrawdownBeforeLiquidate *
                  100
                }
                onChange={(e) =>
                  updateRiskManagementRule(
                    "maxDrawdownBeforeLiquidate",
                    parseAndValidateNumber(e.target.value, 1, 100, 80) / 100
                  )
                }
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan/50"
              />
              <p className="text-[10px] text-slate-500 mt-1.5">
                Liquidate portfolio at this drawdown
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex items-center justify-between pt-6 border-t border-white/[0.08]">
        <motion.button
          onClick={onReset}
          className="px-4 py-2 bg-gradient-to-r from-bear/20 to-bear/10 hover:from-bear/30 hover:to-bear/20 border border-bear/30 rounded-lg text-bear-light transition-all font-medium text-sm"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          🔄 Reset All Portfolios
        </motion.button>
        <div className="flex gap-2">
          <motion.button
            onClick={onClose}
            className="px-4 py-2 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] rounded-lg text-slate-300 transition-all font-medium text-sm"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Cancel
          </motion.button>
          <motion.button
            onClick={handleSave}
            className="px-4 py-2 bg-gradient-to-r from-cyan/20 to-cyan/10 hover:from-cyan/30 hover:to-cyan/20 border border-cyan/30 rounded-lg text-cyan transition-all font-medium text-sm"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Save Settings
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
};
