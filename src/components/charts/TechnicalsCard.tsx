/**
 * Technical Indicators - Cinematic Command Center
 * Data-dense dashboard with dramatic visual hierarchy
 */

import React from "react";
import { TechnicalIndicators } from "../../types/stock";

interface TechnicalsCardProps {
  technicals: TechnicalIndicators;
  currentPrice: number;
}

export const TechnicalsCard: React.FC<TechnicalsCardProps> = ({
  technicals,
  currentPrice,
}) => {
  const trendConfig: Record<
    string,
    { color: string; label: string; icon: string }
  > = {
    strong_uptrend: { color: "#00ff88", label: "STRONG UPTREND", icon: "🚀" },
    uptrend: { color: "#22c55e", label: "UPTREND", icon: "📈" },
    sideways: { color: "#64748b", label: "SIDEWAYS", icon: "➡️" },
    downtrend: { color: "#ef4444", label: "DOWNTREND", icon: "📉" },
    strong_downtrend: {
      color: "#dc2626",
      label: "STRONG DOWNTREND",
      icon: "💥",
    },
  };

  const trend = trendConfig[technicals.trend] || trendConfig.sideways;

  return (
    <div className="relative">
      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
        }}
      >
        {/* Scanlines */}
        <div
          className="absolute inset-0 opacity-[0.02] pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        {/* Header */}
        <div className="p-5 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">📉</span>
              <h3
                className="text-lg font-bold text-white"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                Technical Analysis
              </h3>
            </div>
            <div
              className="px-4 py-2 rounded-lg flex items-center gap-2"
              style={{
                background: `${trend.color}15`,
                border: `1px solid ${trend.color}30`,
              }}
            >
              <span>{trend.icon}</span>
              <span
                className="text-xs font-black tracking-wider"
                style={{ color: trend.color }}
              >
                {trend.label}
              </span>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-6">
          {/* Momentum Section */}
          <Section title="MOMENTUM">
            <div className="space-y-4">
              <GaugeBar label="RSI (14)" value={technicals.rsi14} />
              {technicals.stochastic ? (
                <>
                  <GaugeBar
                    label="Stochastic %K"
                    value={technicals.stochastic.k}
                  />
                  <GaugeBar
                    label="Stochastic %D"
                    value={technicals.stochastic.d}
                  />
                </>
              ) : (
                <div className="text-sm text-slate-500 px-3 py-2">
                  Stochastic data unavailable
                </div>
              )}
            </div>
          </Section>

          {/* MACD Section */}
          <Section title="MACD">
            {technicals.macd ? (
              <div className="grid grid-cols-3 gap-3">
                <MetricBox
                  label="LINE"
                  value={technicals.macd.macdLine.toFixed(2)}
                  color={technicals.macd.macdLine >= 0 ? "#22c55e" : "#ef4444"}
                />
                <MetricBox
                  label="SIGNAL"
                  value={technicals.macd.signalLine.toFixed(2)}
                  color="#ffffff"
                />
                <MetricBox
                  label="HISTOGRAM"
                  value={technicals.macd.histogram.toFixed(2)}
                  color={technicals.macd.histogram >= 0 ? "#22c55e" : "#ef4444"}
                />
              </div>
            ) : (
              <div className="text-sm text-slate-500 px-3 py-2">
                MACD data unavailable
              </div>
            )}
          </Section>

          {/* Moving Averages */}
          <Section title="MOVING AVERAGES">
            <div className="space-y-2">
              {[
                { label: "SMA 20", value: technicals.sma20 },
                { label: "SMA 50", value: technicals.sma50 },
                { label: "SMA 200", value: technicals.sma200 },
              ].map((ma) => (
                <div
                  key={ma.label}
                  className="flex justify-between items-center py-3 border-b border-white/5"
                >
                  <span className="text-sm text-slate-400 font-medium">
                    {ma.label}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-white font-mono">
                      ${ma.value.toFixed(2)}
                    </span>
                    <span
                      className="px-2 py-1 rounded text-[10px] font-bold"
                      style={{
                        background:
                          currentPrice > ma.value
                            ? "rgba(34,197,94,0.15)"
                            : "rgba(239,68,68,0.15)",
                        color: currentPrice > ma.value ? "#22c55e" : "#ef4444",
                        border: `1px solid ${
                          currentPrice > ma.value
                            ? "rgba(34,197,94,0.3)"
                            : "rgba(239,68,68,0.3)"
                        }`,
                      }}
                    >
                      {currentPrice > ma.value ? "▲ ABOVE" : "▼ BELOW"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Bollinger Bands */}
          <Section title="BOLLINGER BANDS">
            <div
              className="relative h-16 rounded-lg overflow-hidden"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div className="absolute inset-0 flex items-center px-4">
                <div className="w-full h-8 relative">
                  <div
                    className="absolute inset-0 rounded"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(239,68,68,0.2) 0%, rgba(100,116,139,0.2) 50%, rgba(34,197,94,0.2) 100%)",
                    }}
                  />
                  {technicals.bollingerBands.upper >
                    technicals.bollingerBands.lower &&
                    (() => {
                      const range =
                        technicals.bollingerBands.upper -
                        technicals.bollingerBands.lower;
                      const position =
                        range > 0
                          ? ((currentPrice - technicals.bollingerBands.lower) /
                              range) *
                            100
                          : 50;
                      return (
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full"
                          style={{
                            background: "#00f0ff",
                            boxShadow: "0 0 15px rgba(0,240,255,0.5)",
                            left: `${Math.max(0, Math.min(100, position))}%`,
                          }}
                        />
                      );
                    })()}
                </div>
              </div>
              <div className="absolute bottom-1 left-3 text-[10px] text-red-400 font-mono">
                ${technicals.bollingerBands.lower.toFixed(0)}
              </div>
              <div className="absolute bottom-1 right-3 text-[10px] text-green-400 font-mono">
                ${technicals.bollingerBands.upper.toFixed(0)}
              </div>
            </div>
          </Section>

          {/* Support & Resistance */}
          <div className="grid grid-cols-2 gap-4">
            <Section title="SUPPORT LEVELS">
              <div className="space-y-1.5">
                {technicals.supportLevels.length > 0 ? (
                  technicals.supportLevels.slice(0, 3).map((level, i) => (
                    <div
                      key={i}
                      className="px-3 py-2 rounded-lg text-sm font-mono"
                      style={{
                        background: "rgba(34,197,94,0.1)",
                        border: "1px solid rgba(34,197,94,0.2)",
                        color: "#22c55e",
                      }}
                    >
                      ${level.toFixed(2)}
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-slate-500 px-3 py-2">—</div>
                )}
              </div>
            </Section>

            <Section title="RESISTANCE LEVELS">
              <div className="space-y-1.5">
                {technicals.resistanceLevels.length > 0 ? (
                  technicals.resistanceLevels.slice(0, 3).map((level, i) => (
                    <div
                      key={i}
                      className="px-3 py-2 rounded-lg text-sm font-mono"
                      style={{
                        background: "rgba(239,68,68,0.1)",
                        border: "1px solid rgba(239,68,68,0.2)",
                        color: "#ef4444",
                      }}
                    >
                      ${level.toFixed(2)}
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-slate-500 px-3 py-2">—</div>
                )}
              </div>
            </Section>
          </div>

          {/* Active Signals */}
          {technicals.signals.length > 0 && (
            <Section title="ACTIVE SIGNALS">
              <div className="space-y-2">
                {technicals.signals.map((signal, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-white/[0.04] transition-colors"
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.05)",
                    }}
                  >
                    <div>
                      <div className="text-sm text-white font-medium">
                        {signal.indicator}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {signal.description}
                      </div>
                    </div>
                    <SignalBadge
                      signal={signal.signal}
                      strength={signal.strength}
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Stats Footer */}
          <div
            className="grid grid-cols-3 gap-3 p-4 rounded-lg"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <div className="text-center">
              <div className="text-[10px] text-slate-500 font-bold tracking-wider mb-1">
                VOLATILITY
              </div>
              <div
                className="text-lg font-bold text-white"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                {technicals.volatility.toFixed(1)}%
              </div>
            </div>
            <div className="text-center border-x border-white/5">
              <div className="text-[10px] text-slate-500 font-bold tracking-wider mb-1">
                ATR (14)
              </div>
              <div
                className="text-lg font-bold text-white"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                ${technicals.atr14.toFixed(2)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-slate-500 font-bold tracking-wider mb-1">
                TREND STR
              </div>
              <div
                className="text-lg font-bold"
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  color: "#00f0ff",
                }}
              >
                {technicals.trendStrength}/100
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const Section: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <div>
    <h4 className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-3">
      {title}
    </h4>
    {children}
  </div>
);

const GaugeBar: React.FC<{ label: string; value: number }> = ({
  label,
  value,
}) => {
  const percentage = Math.max(0, Math.min(100, value));
  const isOverbought = value > 70;
  const isOversold = value < 30;
  const color = isOverbought ? "#ef4444" : isOversold ? "#22c55e" : "#00f0ff";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono font-bold" style={{ color }}>
          {value.toFixed(1)}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            background: color,
            boxShadow: `0 0 10px ${color}60`,
            width: `${percentage}%`,
          }}
        />
      </div>
    </div>
  );
};

const MetricBox: React.FC<{ label: string; value: string; color: string }> = ({
  label,
  value,
  color,
}) => (
  <div
    className="text-center p-3 rounded-lg hover:bg-white/[0.04] transition-colors"
    style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.05)",
    }}
  >
    <div className="text-[9px] text-slate-500 font-bold tracking-wider mb-1">
      {label}
    </div>
    <div className="text-sm font-bold font-mono" style={{ color }}>
      {value}
    </div>
  </div>
);

const SignalBadge: React.FC<{
  signal: "bullish" | "bearish" | "neutral";
  strength: number;
}> = ({ signal, strength }) => {
  const config = {
    bullish: { color: "#22c55e", bg: "rgba(34,197,94,0.15)" },
    bearish: { color: "#ef4444", bg: "rgba(239,68,68,0.15)" },
    neutral: { color: "#64748b", bg: "rgba(100,116,139,0.15)" },
  };
  const c = config[signal];

  return (
    <span
      className="px-2 py-1 rounded text-[10px] font-bold"
      style={{
        background: c.bg,
        color: c.color,
        border: `1px solid ${c.color}30`,
      }}
    >
      {signal.toUpperCase()} ({strength}%)
    </span>
  );
};

export default TechnicalsCard;
