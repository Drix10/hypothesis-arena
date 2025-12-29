/**
 * Pulse Indicator - Animated status indicator
 */

import React from "react";
import { motion } from "framer-motion";

// Define color types for type safety
type PulseColor = "green" | "red" | "yellow" | "blue" | "cyan";
type PulseSize = "sm" | "md" | "lg";

interface PulseIndicatorProps {
  active: boolean;
  color?: PulseColor;
  size?: PulseSize;
  className?: string;
  /** Accessible label for screen readers */
  label?: string;
}

// Type-safe maps with explicit typing to ensure completeness
const colorMap: Record<PulseColor, string> = {
  green: "bg-green-400",
  red: "bg-red-400",
  yellow: "bg-yellow-400",
  blue: "bg-blue-400",
  cyan: "bg-cyan-400",
} as const;

const colorLabels: Record<PulseColor, string> = {
  green: "active",
  red: "stopped",
  yellow: "warning",
  blue: "processing",
  cyan: "idle",
} as const;

const sizeMap: Record<PulseSize, string> = {
  sm: "w-2 h-2",
  md: "w-3 h-3",
  lg: "w-4 h-4",
} as const;

export const PulseIndicator: React.FC<PulseIndicatorProps> = ({
  active,
  color = "green",
  size = "md",
  className = "",
  label,
}) => {
  const accessibleLabel =
    label || `Status: ${colorLabels[color]}${active ? " (pulsing)" : ""}`;

  return (
    <span
      className={`relative inline-flex ${className}`}
      role="img"
      aria-label={accessibleLabel}
    >
      <span className={`${sizeMap[size]} ${colorMap[color]} rounded-full`} />
      {active && (
        <>
          <motion.span
            className={`absolute inset-0 ${colorMap[color]} rounded-full opacity-75`}
            animate={{
              scale: [1, 2, 2],
              opacity: [0.75, 0, 0],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeOut",
            }}
          />
          <motion.span
            className={`absolute inset-0 ${colorMap[color]} rounded-full opacity-75`}
            animate={{
              scale: [1, 2, 2],
              opacity: [0.75, 0, 0],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeOut",
              delay: 1,
            }}
          />
        </>
      )}
    </span>
  );
};
