/**
 * Analyst Card - Cinematic command center style
 * Bold asymmetric design with dramatic lighting effects
 */

import React from "react";
import { AIAnalysis, REC_CONFIG } from "./types";

interface AnalystCardProps {
  analysis: AIAnalysis;
  isChampion?: boolean;
  onClick?: () => void;
}

export const AnalystCard: React.FC<AnalystCardProps> = ({
  analysis,
  isChampion = false,
  onClick,
}) => {
  // Guard against missing data
  if (!analysis) return null;

  const config = REC_CONFIG[analysis.recommendation] || REC_CONFIG.hold;
  const confidence = Number.isFinite(analysis.confidence)
    ? analysis.confidence
    : 0;
  const riskLevel = analysis.riskLevel || "medium";

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
      aria-label={`${analysis.analystName} - ${config.label} recommendation`}
      className={`relative group ${
        onClick ? "cursor-pointer" : ""
      } hover:-translate-y-1 hover:scale-[1.02] active:scale-[0.98] transition-transform duration-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 rounded-xl`}
    >
      {/* Outer glow on hover */}
      <div
        className="absolute -inset-1 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: `linear-gradient(135deg, ${config.accent}20, transparent 60%)`,
          filter: "blur(8px)",
        }}
      />

      {/* Champion crown badge */}
      {isChampion && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-20">
          <div
            className="px-3 py-1.5 rounded-full text-[10px] font-black tracking-wider whitespace-nowrap"
            style={{
              background: "linear-gradient(135deg, #F5B800 0%, #FF8C00 100%)",
              color: "#0a0a0f",
              boxShadow: "0 4px 20px rgba(245,184,0,0.4)",
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
          background:
            "linear-gradient(165deg, rgba(20,31,50,0.95) 0%, rgba(10,18,32,0.9) 100%)",
          border: `1px solid ${
            isChampion ? "rgba(245,184,0,0.4)" : "rgba(255,255,255,0.06)"
          }`,
          boxShadow: isChampion
            ? "0 0 40px rgba(245,184,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)"
            : "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
          marginTop: isChampion ? "12px" : "0",
        }}
      >
        {/* Diagonal accent stripe */}
        <div
          className="absolute top-0 right-0 w-24 h-24 opacity-20 pointer-events-none"
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
                {analysis.analystEmoji}
              </div>
              {/* Status indicator */}
              <div
                className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2"
                style={{
                  borderColor: "rgba(20,31,50,1)",
                  background: config.accent,
                  boxShadow: `0 0 10px ${config.accent}60`,
                }}
              />
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm text-white truncate tracking-tight">
                {analysis.analystName}
              </h3>
              <p className="text-[10px] text-slate-500 truncate mt-0.5">
                {analysis.analystId.replace(/_/g, " ")}
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
            <div
              className="p-3 rounded-lg"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div className="text-[8px] text-slate-500 uppercase tracking-widest mb-1 font-semibold">
                CONFIDENCE
              </div>
              <div
                className="text-lg font-black"
                style={{
                  color: "#06B6D4",
                  textShadow: "0 0 20px rgba(6,182,212,0.4)",
                }}
              >
                {confidence}%
              </div>
            </div>
            <div
              className="p-3 rounded-lg"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div className="text-[8px] text-slate-500 uppercase tracking-widest mb-1 font-semibold">
                RISK
              </div>
              <div
                className="text-lg font-black"
                style={{
                  color:
                    riskLevel === "low"
                      ? "#4ADE80"
                      : riskLevel === "high"
                      ? "#F43F5E"
                      : "#FFD54F",
                  textShadow: `0 0 20px ${
                    riskLevel === "low"
                      ? "rgba(74,222,128,0.4)"
                      : riskLevel === "high"
                      ? "rgba(244,63,94,0.4)"
                      : "rgba(255,213,79,0.4)"
                  }`,
                }}
              >
                {riskLevel.toUpperCase()}
              </div>
            </div>
          </div>

          {/* Price target range bar (mini) */}
          {analysis.priceTarget && analysis.priceTarget.base > 0 && (
            <div className="mb-4">
              <div className="flex justify-between text-[9px] mb-1.5">
                <span className="text-rose-400 font-mono">
                  ${analysis.priceTarget.bear.toLocaleString()}
                </span>
                <span className="text-slate-600 uppercase tracking-wider">
                  Range
                </span>
                <span className="text-green-400 font-mono">
                  ${analysis.priceTarget.bull.toLocaleString()}
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
                <div
                  className="h-full rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, #F43F5E 0%, #FFD54F 50%, #4ADE80 100%)",
                  }}
                />
              </div>
            </div>
          )}

          {/* Key insight */}
          <div
            className="pt-3 border-t"
            style={{ borderColor: "rgba(255,255,255,0.05)" }}
          >
            <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2 italic">
              "{analysis.thesis}"
            </p>
          </div>
        </div>

        {/* Bottom accent line on hover */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[2px] scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-left"
          style={{ background: config.accent }}
        />
      </div>
    </div>
  );
};
