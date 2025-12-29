import React from "react";

interface MetricBoxProps {
  label: string;
  value: string;
  accent?: string;
}

export const MetricBox: React.FC<MetricBoxProps> = ({
  label,
  value,
  accent = "#06B6D4",
}) => (
  <div className="metric-card">
    <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 font-semibold">
      {label}
    </div>
    <div className="text-xl font-bold" style={{ color: accent }}>
      {value}
    </div>
  </div>
);
