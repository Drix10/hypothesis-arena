/**
 * Champion Card - Epic winner display with dramatic visual effects
 * Cinematic command center style with golden accents and glows
 */

import React from "react";
import { AIAnalysis, REC_CONFIG } from "./types";
import { CircularMeter, PriceRangeBar } from "../ui";

interface ChampionCardProps {
  champion: AIAnalysis;
  currentPrice?: number;
}

export const ChampionCard: React.FC<ChampionCardProps> = ({
  champion,
  currentPrice = 0,
}) => {
  const config = REC_CONFIG[champion?.recommendation] || REC_CONFIG.hold;
  const hasTargets = champion?.priceTarget && champion.priceTarget.base > 0;
  const safeCurrentPrice = Number.isFinite(currentPrice) ? currentPrice : 0;
  const upside =
    hasTargets && safeCurrentPrice > 0
      ? ((champion.priceTarget!.base - safeCurrentPrice) / safeCurrentPrice) *
        100
      : 0;

  // Guard against missing champion data
  if (!champion) return null;

  return (
    <div className="relative">
      {/* Outer golden glow */}
      <div
        className="absolute -inset-2 rounded-3xl opacity-60 blur-xl"
        style={{
          background:
            "linear-gradient(135deg, #F5B800 0%, #FF8C00 50%, #F5B800 100%)",
        }}
      />

      {/* Main card */}
      <div
        className="relative overflow-hidden rounded-2xl"
        style={{
          background:
            "linear-gradient(165deg, rgba(20,31,50,0.98) 0%, rgba(10,18,32,0.95) 100%)",
          border: "1px solid rgba(245,184,0,0.3)",
          boxShadow:
            "0 0 60px rgba(245,184,0,0.15), 0 20px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
      >
        {/* Top accent bar */}
        <div
          className="h-1"
          style={{
            background:
              "linear-gradient(90deg, #F5B800 0%, #FF8C00 50%, #F5B800 100%)",
          }}
        />

        {/* Diagonal accent */}
        <div
          className="absolute top-0 right-0 w-96 h-96 opacity-10 pointer-events-none"
          style={{
            background: "linear-gradient(135deg, #F5B800 0%, transparent 50%)",
            clipPath: "polygon(100% 0, 0 0, 100% 100%)",
          }}
        />

        {/* Scanlines texture */}
        <div
          className="absolute inset-0 opacity-[0.02] pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        <div className="relative p-6 sm:p-8">
          {/* Hero Section */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8 mb-8">
            <div className="flex items-center gap-5">
              {/* Avatar with crown */}
              <div className="relative">
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl"
                  style={{
                    background:
                      "linear-gradient(145deg, rgba(245,184,0,0.2) 0%, rgba(245,184,0,0.05) 100%)",
                    border: "1px solid rgba(245,184,0,0.3)",
                    boxShadow: "0 0 40px rgba(245,184,0,0.3)",
                  }}
                >
                  {champion.analystEmoji}
                </div>
                <div className="absolute -top-3 -right-3 text-3xl drop-shadow-lg">
                  👑
                </div>
              </div>

              <div>
                <div className="text-[10px] text-amber-400/70 font-bold tracking-[0.2em] uppercase mb-2">
                  TOURNAMENT CHAMPION
                </div>
                <h1
                  className="text-3xl sm:text-4xl font-black"
                  style={{
                    background:
                      "linear-gradient(135deg, #F5B800 0%, #FFD54F 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    textShadow: "0 0 40px rgba(245,184,0,0.3)",
                  }}
                >
                  {champion.analystName}
                </h1>
              </div>
            </div>

            {/* Confidence meters */}
            <div className="flex gap-8">
              <CircularMeter
                label="CONFIDENCE"
                value={champion.confidence}
                color="#06B6D4"
              />
              {hasTargets && upside !== 0 && (
                <CircularMeter
                  label="UPSIDE"
                  value={Math.abs(upside)}
                  color={upside >= 0 ? "#4ADE80" : "#F43F5E"}
                />
              )}
            </div>
          </div>

          {/* Recommendation Badge */}
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg mb-6"
            style={{
              background: `${config.accent}15`,
              border: `1px solid ${config.accent}40`,
              boxShadow: `0 0 20px ${config.accent}20`,
            }}
          >
            <span className="text-xl">{config.icon}</span>
            <span
              className="text-sm font-black tracking-widest"
              style={{ color: config.accent }}
            >
              {config.label}
            </span>
          </div>

          {/* Thesis */}
          <p className="text-slate-300 leading-relaxed text-lg mb-8">
            {champion.thesis}
          </p>

          {/* Price Target Range */}
          {hasTargets && currentPrice > 0 && (
            <PriceRangeBar
              current={currentPrice}
              target={champion.priceTarget!.base}
              bear={champion.priceTarget!.bear}
              bull={champion.priceTarget!.bull}
            />
          )}

          {/* Key Reasoning */}
          {champion.reasoning &&
            Array.isArray(champion.reasoning) &&
            champion.reasoning.length > 0 && (
              <div className="mt-6 pt-6 border-t border-white/5">
                <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-3">
                  KEY ARGUMENTS
                </div>
                <div className="space-y-2">
                  {champion.reasoning.slice(0, 3).map((reason, i) => (
                    <div
                      key={i}
                      className="flex gap-3 p-3 rounded-lg"
                      style={{
                        background: "rgba(245,184,0,0.05)",
                        border: "1px solid rgba(245,184,0,0.1)",
                      }}
                    >
                      <div className="w-1 rounded-full flex-shrink-0 bg-amber-400" />
                      <p className="text-sm text-amber-200/80">{reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
};
