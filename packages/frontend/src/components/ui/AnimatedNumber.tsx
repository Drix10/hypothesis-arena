/**
 * Animated Number - Smooth number transitions with color flash
 */

import React, { useEffect, useRef, useState } from "react";
import { motion, useSpring } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 500,
  className = "",
}) => {
  // Safe value - handle NaN, Infinity, undefined
  const safeValue = Number.isFinite(value) ? value : 0;

  const [displayValue, setDisplayValue] = useState(safeValue);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevValue = useRef(safeValue);

  const spring = useSpring(safeValue, {
    stiffness: 100,
    damping: 30,
  });

  useEffect(() => {
    const newSafeValue = Number.isFinite(value) ? value : 0;
    spring.set(newSafeValue);

    // Determine flash direction
    if (newSafeValue > prevValue.current) {
      setFlash("up");
    } else if (newSafeValue < prevValue.current) {
      setFlash("down");
    }

    prevValue.current = newSafeValue;

    // Clear flash after animation
    const timer = setTimeout(() => setFlash(null), duration);
    return () => clearTimeout(timer);
  }, [value, spring, duration]);

  useEffect(() => {
    const unsubscribe = spring.on("change", (latest) => {
      // Ensure we never display NaN
      setDisplayValue(Number.isFinite(latest) ? latest : 0);
    });
    return unsubscribe;
  }, [spring]);

  // Safe formatting
  const formattedValue = Number.isFinite(displayValue)
    ? displayValue.toFixed(decimals)
    : "0";

  return (
    <motion.span
      className={`inline-block ${className}`}
      animate={{
        color:
          flash === "up"
            ? ["inherit", "#22c55e", "inherit"]
            : flash === "down"
            ? ["inherit", "#ef4444", "inherit"]
            : "inherit",
      }}
      transition={{ duration: duration / 1000 }}
    >
      {prefix}
      {formattedValue}
      {suffix}
    </motion.span>
  );
};
