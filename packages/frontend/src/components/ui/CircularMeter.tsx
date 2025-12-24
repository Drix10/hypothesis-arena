/**
 * Circular Meter - Animated radial progress indicator
 */

import React from "react";

interface CircularMeterProps {
  value: number;
  label: string;
  color?: string;
  size?: number;
}

export const CircularMeter: React.FC<CircularMeterProps> = ({
  value,
  label,
  color = "#06B6D4",
  size = 80,
}) => {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  // Safe value handling - ensure it's a valid number between 0-100
  const safeValue = Number.isFinite(value) ? value : 0;
  const progress = Math.min(100, Math.max(0, safeValue));
  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className="text-center">
      <div
        className="relative inline-block"
        style={{ width: size, height: size }}
      >
        {/* Background circle */}
        <svg className="transform -rotate-90" width={size} height={size}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="4"
          />
          {/* Progress circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{
              transition: "stroke-dashoffset 0.8s ease-out",
              filter: `drop-shadow(0 0 8px ${color}60)`,
            }}
          />
        </svg>
        {/* Center value */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className="text-xl font-bold"
            style={{ color, textShadow: `0 0 20px ${color}60` }}
          >
            {progress.toFixed(0)}%
          </span>
        </div>
      </div>
      <div className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mt-2">
        {label}
      </div>
    </div>
  );
};
