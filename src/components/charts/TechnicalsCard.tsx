/**
 * Technical Indicators Detail Card - Strategic Arena Theme
 */

import React from "react";
import { motion } from "framer-motion";
import { TechnicalIndicators } from "../../types/stock";

interface TechnicalsCardProps {
  technicals: TechnicalIndicators;
  currentPrice: number;
}

const Gauge: React.FC<{
  value: number;
  min?: number;
  max?: number;
  label: string;
  showValue?: boolean;
  delay?: number;
}> = ({ value, min = 0, max = 100, label, showValue = true, delay = 0 }) => {
  const range = max - min;
  const percentage =
    range > 0 ? Math.max(0, Math.min(100, ((value - min) / range) * 100)) : 50;
  const isOverbought = value > 70;
  const isOversold = value < 30;
  const color = isOverbought ? "bg-bear" : isOversold ? "bg-bull" : "bg-cyan";

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        {showValue && (
          <motion.span
            className="text-white font-medium"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: delay + 0.2 }}
          >
            {value.toFixed(1)}
          </motion.span>
        )}
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <motion.div
          className={`h-full ${color} rounded-full`}
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.6, delay, ease: "easeOut" }}
        />
      </div>
    </div>
  );
};

const SignalBadge: React.FC<{
  signal: "bullish" | "bearish" | "neutral";
  strength: number;
}> = ({ signal, strength }) => {
  const colors = {
    bullish: "bg-bull-muted text-bull-light border-bull/30",
    bearish: "bg-bear-muted text-bear-light border-bear/30",
    neutral: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  };

  return (
    <motion.span
      className={`px-2 py-0.5 text-xs rounded border ${colors[signal]}`}
      whileHover={{ scale: 1.05 }}
    >
      {signal.charAt(0).toUpperCase() + signal.slice(1)} ({strength}%)
    </motion.span>
  );
};

export const TechnicalsCard: React.FC<TechnicalsCardProps> = ({
  technicals,
  currentPrice,
}) => {
  const trendColors = {
    strong_uptrend: "text-bull-light",
    uptrend: "text-bull-light",
    sideways: "text-slate-400",
    downtrend: "text-bear-light",
    strong_downtrend: "text-bear-light",
  };

  const trendLabels = {
    strong_uptrend: "🚀 Strong Uptrend",
    uptrend: "📈 Uptrend",
    sideways: "➡️ Sideways",
    downtrend: "📉 Downtrend",
    strong_downtrend: "💥 Strong Downtrend",
  };

  return (
    <motion.div
      className="glass-card rounded-2xl overflow-hidden"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="px-6 py-4 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">📉</span>
            <h3 className="text-lg font-semibold text-white">
              Technical Analysis
            </h3>
          </div>
          <motion.div
            className={`px-3 py-1 rounded-lg text-sm font-medium ${
              trendColors[technicals.trend]
            } bg-white/5`}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            {trendLabels[technicals.trend]}
          </motion.div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
        >
          <h4 className="text-sm font-medium text-slate-300 mb-4">Momentum</h4>
          <div className="space-y-4">
            <Gauge value={technicals.rsi14} label="RSI (14)" delay={0.1} />
            <Gauge
              value={technicals.stochastic.k}
              label="Stochastic %K"
              delay={0.15}
            />
            <Gauge
              value={technicals.stochastic.d}
              label="Stochastic %D"
              delay={0.2}
            />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h4 className="text-sm font-medium text-slate-300 mb-3">MACD</h4>
          <div className="grid grid-cols-3 gap-4">
            <motion.div
              className="text-center p-3 bg-white/[0.02] rounded-lg border border-white/5"
              whileHover={{
                scale: 1.02,
                backgroundColor: "rgba(255,255,255,0.04)",
              }}
            >
              <div className="text-xs text-slate-500 mb-1">Line</div>
              <div
                className={`text-sm font-medium ${
                  technicals.macd.macdLine >= 0
                    ? "text-bull-light"
                    : "text-bear-light"
                }`}
              >
                {technicals.macd.macdLine.toFixed(2)}
              </div>
            </motion.div>
            <motion.div
              className="text-center p-3 bg-white/[0.02] rounded-lg border border-white/5"
              whileHover={{
                scale: 1.02,
                backgroundColor: "rgba(255,255,255,0.04)",
              }}
            >
              <div className="text-xs text-slate-500 mb-1">Signal</div>
              <div className="text-sm font-medium text-white">
                {technicals.macd.signalLine.toFixed(2)}
              </div>
            </motion.div>
            <motion.div
              className="text-center p-3 bg-white/[0.02] rounded-lg border border-white/5"
              whileHover={{
                scale: 1.02,
                backgroundColor: "rgba(255,255,255,0.04)",
              }}
            >
              <div className="text-xs text-slate-500 mb-1">Histogram</div>
              <div
                className={`text-sm font-medium ${
                  technicals.macd.histogram >= 0
                    ? "text-bull-light"
                    : "text-bear-light"
                }`}
              >
                {technicals.macd.histogram.toFixed(2)}
              </div>
            </motion.div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
        >
          <h4 className="text-sm font-medium text-slate-300 mb-3">
            Moving Averages
          </h4>
          <div className="space-y-2">
            {[
              { label: "SMA 20", value: technicals.sma20 },
              { label: "SMA 50", value: technicals.sma50 },
              { label: "SMA 200", value: technicals.sma200 },
            ].map((ma, i) => (
              <motion.div
                key={ma.label}
                className="flex justify-between items-center py-2 border-b border-white/5"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.05 }}
              >
                <span className="text-sm text-slate-400">{ma.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white">
                    ${ma.value.toFixed(2)}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      currentPrice > ma.value
                        ? "text-bull-light bg-bull-muted"
                        : "text-bear-light bg-bear-muted"
                    }`}
                  >
                    {currentPrice > ma.value ? "▲ Above" : "▼ Below"}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4 }}
        >
          <h4 className="text-sm font-medium text-slate-300 mb-3">
            Bollinger Bands
          </h4>
          <div className="relative h-16 bg-white/[0.02] rounded-lg overflow-hidden border border-white/5">
            <div className="absolute inset-y-0 left-0 right-0 flex items-center">
              <div className="w-full h-8 relative">
                <div className="absolute inset-0 bg-gradient-to-r from-bear/20 via-slate-500/20 to-bull/20 rounded" />
                {technicals.bollingerBands.upper >
                  technicals.bollingerBands.lower && (
                  <motion.div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-cyan rounded-full shadow-glow-cyan"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.5, type: "spring" }}
                    style={{
                      left: `${Math.max(
                        0,
                        Math.min(
                          100,
                          ((currentPrice - technicals.bollingerBands.lower) /
                            (technicals.bollingerBands.upper -
                              technicals.bollingerBands.lower)) *
                            100
                        )
                      )}%`,
                    }}
                  />
                )}
              </div>
            </div>
            <div className="absolute bottom-1 left-2 text-xs text-bear-light">
              ${technicals.bollingerBands.lower.toFixed(0)}
            </div>
            <div className="absolute bottom-1 right-2 text-xs text-bull-light">
              ${technicals.bollingerBands.upper.toFixed(0)}
            </div>
          </div>
        </motion.div>

        <motion.div
          className="grid grid-cols-2 gap-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <div>
            <h4 className="text-sm font-medium text-bull-light mb-2">
              Support Levels
            </h4>
            <div className="space-y-1">
              {technicals.supportLevels.length > 0 ? (
                technicals.supportLevels.slice(0, 3).map((level, i) => (
                  <motion.div
                    key={i}
                    className="text-sm text-slate-300 bg-bull-muted px-3 py-1.5 rounded border border-bull/20"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.5 + i * 0.05 }}
                  >
                    ${level.toFixed(2)}
                  </motion.div>
                ))
              ) : (
                <div className="text-sm text-slate-500 px-3 py-1.5">—</div>
              )}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-bear-light mb-2">
              Resistance Levels
            </h4>
            <div className="space-y-1">
              {technicals.resistanceLevels.length > 0 ? (
                technicals.resistanceLevels.slice(0, 3).map((level, i) => (
                  <motion.div
                    key={i}
                    className="text-sm text-slate-300 bg-bear-muted px-3 py-1.5 rounded border border-bear/20"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.5 + i * 0.05 }}
                  >
                    ${level.toFixed(2)}
                  </motion.div>
                ))
              ) : (
                <div className="text-sm text-slate-500 px-3 py-1.5">—</div>
              )}
            </div>
          </div>
        </motion.div>

        {technicals.signals.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <h4 className="text-sm font-medium text-slate-300 mb-3">
              Active Signals
            </h4>
            <div className="space-y-2">
              {technicals.signals.map((signal, i) => (
                <motion.div
                  key={i}
                  className="flex items-center justify-between p-3 bg-white/[0.02] rounded-lg border border-white/5 hover:bg-white/[0.04] transition-colors"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.6 + i * 0.05 }}
                >
                  <div>
                    <div className="text-sm text-white font-medium">
                      {signal.indicator}
                    </div>
                    <div className="text-xs text-slate-500">
                      {signal.description}
                    </div>
                  </div>
                  <SignalBadge
                    signal={signal.signal}
                    strength={signal.strength}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        <motion.div
          className="flex items-center justify-between p-4 bg-white/[0.02] rounded-lg border border-white/5"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
        >
          <div>
            <div className="text-sm text-slate-400">Volatility (20-day)</div>
            <div className="text-lg font-semibold text-white">
              {technicals.volatility.toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-400">ATR (14)</div>
            <div className="text-lg font-semibold text-white">
              ${technicals.atr14.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-400">Trend Strength</div>
            <div className="text-lg font-semibold text-cyan">
              {technicals.trendStrength}/100
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
};

export default TechnicalsCard;
