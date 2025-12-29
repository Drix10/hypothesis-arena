/**
 * Price Range Bar - Visual price target range with markers
 */

import React from "react";

interface PriceRangeBarProps {
  current: number;
  target: number;
  bear: number;
  bull: number;
  label?: string;
}

const calculatePosition = (value: number, min: number, max: number): number => {
  // Validate all inputs are finite numbers
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max))
    return 50;
  if (max <= min) return 50;
  const position = ((value - min) / (max - min)) * 100;
  return Math.max(5, Math.min(95, position));
};

export const PriceRangeBar: React.FC<PriceRangeBarProps> = ({
  current,
  target,
  bear,
  bull,
  label = "12-MONTH PRICE TARGET RANGE",
}) => {
  // Safe number formatting
  const safeFormat = (n: number) =>
    Number.isFinite(n) ? n.toLocaleString() : "0";
  const currentPos = calculatePosition(current, bear, bull);
  const targetPos = calculatePosition(target, bear, bull);

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-slate-400 font-bold tracking-wider">
          {label}
        </span>
        <span className="text-[10px] text-slate-600 px-2 py-1 rounded bg-white/5">
          Current position shown
        </span>
      </div>

      <div className="flex items-center gap-4">
        {/* Bear price */}
        <div className="text-center">
          <div className="text-[9px] text-rose-400/70 mb-1 font-bold tracking-wider">
            BEAR
          </div>
          <span className="text-rose-400 font-bold font-mono">
            ${safeFormat(bear)}
          </span>
        </div>

        {/* Range bar */}
        <div className="flex-1 relative py-4">
          <div className="h-3 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
            <div
              className="h-full"
              style={{
                background:
                  "linear-gradient(90deg, #F43F5E 0%, #FFD54F 50%, #4ADE80 100%)",
              }}
            />
          </div>

          {/* Current price marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 z-10 transition-all duration-500"
            style={{ left: `${currentPos}%` }}
          >
            <div className="w-5 h-5 bg-white rounded-full shadow-lg border-2 border-slate-900 -translate-x-1/2" />
          </div>

          {/* Target marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 z-10 transition-all duration-500"
            style={{ left: `${targetPos}%` }}
          >
            <div
              className="w-4 h-4 rounded-full -translate-x-1/2"
              style={{
                background: "#06B6D4",
                boxShadow: "0 0 20px rgba(6,182,212,0.5)",
              }}
            />
          </div>
        </div>

        {/* Bull price */}
        <div className="text-center">
          <div className="text-[9px] text-green-400/70 mb-1 font-bold tracking-wider">
            BULL
          </div>
          <span className="text-green-400 font-bold font-mono">
            ${safeFormat(bull)}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex justify-center gap-6 mt-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 bg-white rounded-full" /> Current
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "#06B6D4" }}
          />{" "}
          Target
        </span>
      </div>
    </div>
  );
};
