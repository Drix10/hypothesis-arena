import React from "react";

interface IconProps {
  icon: string;
  width?: string | number;
  height?: string | number;
  className?: string;
  class?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

/**
 * Wrapper component for iconify-icon custom element
 * Provides proper TypeScript support in strict mode
 *
 * Note: Uses createElement with filtered props to avoid React warnings
 * about unknown DOM attributes while maintaining type safety
 */
const Icon: React.FC<IconProps> = (props) => {
  // Filter out React-specific props that shouldn't be passed to custom element
  const { className, ...elementProps } = props;

  // Map className to class for custom element
  const finalProps = {
    ...elementProps,
    ...(className && { class: className }),
  };

  return React.createElement("iconify-icon", finalProps);
};

export default Icon;
