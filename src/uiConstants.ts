/**
 * UI Constants - Single source of truth for timing, sizes, and limits
 */

// Animation Durations (ms)
export const ANIMATION = {
    FAST: 200,
    NORMAL: 300,
    SLOW: 500,
    VERY_SLOW: 700,
    ULTRA_SLOW: 1000,
} as const;

// Delays (ms)
export const DELAY = {
    SHORT: 100,
    MEDIUM: 200,
    LONG: 500,
} as const;

// Sizes (px)
export const SIZE = {
    ICON_SMALL: 14,
    ICON_MEDIUM: 16,
    ICON_LARGE: 24,
    MIN_CANVAS_HEIGHT: 250,
} as const;

// Distances (px)
export const DISTANCE = {
    CONNECTION_THRESHOLD: 250,
    PARTICLE_SPACING: 100,
} as const;

// Input Limits
export const INPUT_LIMITS = {
    MAX_LENGTH: 10000,
    MAX_FILE_SIZE: 20 * 1024 * 1024, // 20MB
} as const;

// Polling Intervals (ms)
export const POLLING = {
    API_KEY_CHECK: 1000,
} as const;

// Canvas Performance
export const CANVAS = {
    RESOLUTION_SCALE: 0.5,
    PARTICLE_COUNT: 80,
    MAX_CONNECTIONS: 3,
    RESIZE_DEBOUNCE: 200,
} as const;

// Colors (for programmatic use)
export const COLORS = {
    ELECTRIC_CYAN: 'rgba(0, 240, 255, 1)',
    ACID_PURPLE: 'rgba(176, 38, 255, 1)',
    VOID: '#050505',
    SURFACE: '#0A0A0A',
} as const;

// Opacity Values
export const OPACITY = {
    DISABLED: 0.5,
    HOVER: 0.8,
    ACTIVE: 1,
    SUBTLE: 0.1,
} as const;
