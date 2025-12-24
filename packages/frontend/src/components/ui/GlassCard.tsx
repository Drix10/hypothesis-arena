import React from "react";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
  accentColor?: string;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  className = "",
  glow = false,
  accentColor,
}) => (
  <div
    className={`glass-card rounded-xl ${
      glow ? "glow-border" : ""
    } ${className}`}
    style={accentColor ? { borderColor: `${accentColor}30` } : undefined}
  >
    {children}
  </div>
);
