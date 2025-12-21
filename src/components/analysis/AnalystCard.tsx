/**
 * Analyst Card Component - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React from "react";
import { InvestmentThesis } from "../../types/stock";
import { getAnalystById } from "../../services/stock";

interface AnalystCardProps {
  thesis: InvestmentThesis;
  onClick?: () => void;
  isWinner?: boolean;
}

const formatCurrency = (value: number): string => {
  // Handle edge cases
  if (!isFinite(value) || isNaN(value)) {
    return "$0";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

const REC_CONFIG: Record<
  string,
  { accent: string; glow: string; label: string; icon: string }
> = {
  strong_buy: {
    accent: "#00ff88",
    glow: "0 0 30px rgba(0,255,136,0.4)",
    label: "STRONG BUY",
    icon: "⚡",
  },
  buy: {
    accent: "#22c55e",
    glow: "0 0 20px rgba(34,197,94,0.3)",
    label: "BUY",
    icon: "↗",
  },
  hold: {
    accent: "#ffd700",
    glow: "0 0 20px rgba(255,215,0,0.3)",
    label: "HOLD",
    icon: "◆",
  },
  sell: {
    accent: "#ef4444",
    glow: "0 0 20px rgba(239,68,68,0.3)",
    label: "SELL",
    icon: "↘",
  },
  strong_sell: {
    accent: "#dc2626",
    glow: "0 0 30px rgba(220,38,38,0.4)",
    label: "STRONG SELL",
    icon: "⚠",
  },
};

export const AnalystCard: React.FC<AnalystCardProps> = ({
  thesis,
  onClick,
  isWinner = false,
}) => {
  const analyst = getAnalystById(thesis.agentId);
  if (!analyst) return null;

  const config = REC_CONFIG[thesis.recommendation] || REC_CONFIG.hold;
  const confidence = thesis.confidence ?? 0;
  const priceTargetBase = thesis.priceTarget?.base ?? 0;
  const priceTargetBear = thesis.priceTarget?.bear ?? 0;
  const priceTargetBull = thesis.priceTarget?.bull ?? 0;
  const bullCase = thesis.bullCase ?? [];

  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`${analyst.name} - ${config.label} recommendation`}
      className={`relative group ${
        onClick ? "cursor-pointer" : ""
      } hover:-translate-y-1 hover:scale-[1.02] active:scale-[0.98] transition-transform duration-200 focus:outline-none focus:ring-2 focus:ring-cyan/50 rounded-xl`}
    >
      {/* Outer glow on hover */}
      <div
        className="absolute -inset-1 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: `linear-gradient(135deg, ${config.accent}20, transparent 60%)`,
          filter: "blur(8px)",
        }}
      />

      {/* Winner crown - positioned outside the overflow-hidden card */}
      {isWinner && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-20">
          <div
            className="px-3 py-1.5 rounded-full text-[10px] font-black tracking-wider whitespace-nowrap"
            style={{
              background: "linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)",
              color: "#0a0a0f",
              boxShadow: "0 4px 20px rgba(255,215,0,0.4)",
            }}
          >
            👑 CHAMPION
          </div>
        </div>
      )}

      {/* Main card */}
      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: `1px solid ${
            isWinner ? "#ffd700" : "rgba(255,255,255,0.06)"
          }`,
          boxShadow: isWinner
            ? "0 0 40px rgba(255,215,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05)"
            : "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
          marginTop: isWinner ? "12px" : "0",
        }}
      >
        {/* Diagonal accent stripe */}
        <div
          className="absolute top-0 right-0 w-24 h-24 opacity-20"
          style={{
            background: `linear-gradient(135deg, ${config.accent} 0%, transparent 60%)`,
            clipPath: "polygon(100% 0, 0 0, 100% 100%)",
          }}
        />

        {/* Scanline texture */}
        <div
          className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        <div className="relative p-4 pt-5">
          {/* Header */}
          <div className="flex items-start gap-3 mb-4">
            <div className="relative">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                style={{
                  background:
                    "linear-gradient(145deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
                }}
              >
                {analyst.avatarEmoji}
              </div>
              <div
                className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-[#0d1117]"
                style={{
                  background: config.accent,
                  boxShadow: config.glow,
                }}
              />
            </div>

            <div className="flex-1 min-w-0">
              <h3
                className="font-bold text-sm text-white truncate tracking-tight"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                {analyst.name}
              </h3>
              <p className="text-[10px] text-slate-500 truncate mt-0.5">
                {analyst.title}
              </p>
            </div>
          </div>

          {/* Recommendation badge */}
          <div
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg mb-4 hover:scale-105 transition-transform"
            style={{
              background: `${config.accent}15`,
              border: `1px solid ${config.accent}40`,
              boxShadow: `inset 0 1px 0 ${config.accent}20`,
            }}
          >
            <span style={{ color: config.accent }}>{config.icon}</span>
            <span
              className="text-[10px] font-black tracking-widest"
              style={{ color: config.accent }}
            >
              {config.label}
            </span>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            <MetricBox
              label="CONFIDENCE"
              value={`${confidence}%`}
              accent={config.accent}
            />
            <MetricBox
              label="TARGET"
              value={formatCurrency(priceTargetBase)}
              accent="#00f0ff"
            />
          </div>

          {/* Price range bar */}
          <div className="mb-4">
            <div className="flex justify-between text-[9px] mb-1.5">
              <span className="text-red-400 font-mono">
                {formatCurrency(priceTargetBear)}
              </span>
              <span className="text-slate-600 uppercase tracking-wider">
                Range
              </span>
              <span className="text-green-400 font-mono">
                {formatCurrency(priceTargetBull)}
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
              <div
                className="h-full rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, #ef4444 0%, #ffd700 50%, #22c55e 100%)",
                  width: "100%",
                }}
              />
            </div>
          </div>

          {/* Key insight */}
          {bullCase.length > 0 && (
            <div
              className="pt-3 border-t"
              style={{ borderColor: "rgba(255,255,255,0.05)" }}
            >
              <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2 italic">
                "{bullCase[0]}"
              </p>
            </div>
          )}
        </div>

        {/* Bottom accent line */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[2px] scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-left"
          style={{ background: config.accent }}
        />
      </div>
    </div>
  );
};

const MetricBox: React.FC<{ label: string; value: string; accent: string }> = ({
  label,
  value,
  accent,
}) => (
  <div
    className="p-3 rounded-lg"
    style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.05)",
    }}
  >
    <div className="text-[8px] text-slate-500 uppercase tracking-widest mb-1 font-semibold">
      {label}
    </div>
    <div
      className="text-lg font-black"
      style={{
        color: accent,
        fontFamily: "'Space Grotesk', sans-serif",
        textShadow: `0 0 20px ${accent}40`,
      }}
    >
      {value}
    </div>
  </div>
);

export default AnalystCard;
