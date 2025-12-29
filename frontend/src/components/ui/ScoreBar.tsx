/**
 * Score Bar - Comparative bull/bear score visualization
 */

import React from "react";

interface ScoreBarProps {
  label: string;
  bull: number;
  bear: number;
}

export const ScoreBar: React.FC<ScoreBarProps> = ({ label, bull, bear }) => {
  // Safe number handling
  const safeBull = Number.isFinite(bull) ? bull : 0;
  const safeBear = Number.isFinite(bear) ? bear : 0;
  const total = safeBull + safeBear;
  const bullPercent = total > 0 ? (safeBull / total) * 100 : 50;

  return (
    <div>
      <div className="text-[9px] text-slate-500 mb-1.5 font-medium uppercase tracking-wider">
        {label}
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-slate-900/50 border border-white/5">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ background: "#4ADE80", width: `${bullPercent}%` }}
        />
      </div>
      <div className="flex justify-between mt-1 text-[9px] font-mono">
        <span className="text-green-400">{safeBull}</span>
        <span className="text-rose-400">{safeBear}</span>
      </div>
    </div>
  );
};
