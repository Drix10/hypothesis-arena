/**
 * Price Chart - Cinematic Command Center
 * Dramatic data visualization with glowing effects
 */

import React, { useState, useMemo } from "react";
import { HistoricalData } from "../../types/stock";

interface PriceChartProps {
  data: HistoricalData;
  currentPrice: number;
}

type ChartType = "candlestick" | "line";
type TimeRange = "1M" | "3M" | "6M" | "1Y";

export const PriceChart: React.FC<PriceChartProps> = ({
  data,
  currentPrice,
}) => {
  const [chartType, setChartType] = useState<ChartType>("candlestick");
  const [timeRange, setTimeRange] = useState<TimeRange>("3M");

  const filteredData = useMemo(() => {
    const now = new Date();
    const cutoff = new Date();
    switch (timeRange) {
      case "1M":
        cutoff.setMonth(now.getMonth() - 1);
        break;
      case "3M":
        cutoff.setMonth(now.getMonth() - 3);
        break;
      case "6M":
        cutoff.setMonth(now.getMonth() - 6);
        break;
      case "1Y":
        cutoff.setFullYear(now.getFullYear() - 1);
        break;
    }
    return data.data.filter((d) => new Date(d.date) >= cutoff);
  }, [data.data, timeRange]);

  const { minPrice, maxPrice, priceRange } = useMemo(() => {
    if (filteredData.length === 0)
      return { minPrice: 0, maxPrice: 100, priceRange: 100 };
    const lows = filteredData.map((d) => d.low).filter((v) => v > 0);
    const highs = filteredData.map((d) => d.high).filter((v) => v > 0);
    if (lows.length === 0 || highs.length === 0)
      return { minPrice: 0, maxPrice: 100, priceRange: 100 };
    const min = Math.min(...lows) * 0.98;
    const max = Math.max(...highs) * 1.02;
    const range = max - min;
    return { minPrice: min, maxPrice: max, priceRange: range > 0 ? range : 1 };
  }, [filteredData]);

  const priceToY = (price: number): number => {
    if (
      priceRange === 0 ||
      !isFinite(price) ||
      !isFinite(minPrice) ||
      !isFinite(priceRange)
    )
      return 50;
    return 100 - ((price - minPrice) / priceRange) * 100;
  };

  const chartWidth = 100;
  const candleWidth =
    filteredData.length > 0
      ? Math.max(0.5, (chartWidth / filteredData.length) * 0.7)
      : 1;
  const gap = filteredData.length > 0 ? chartWidth / filteredData.length : 1;

  const priceChange =
    filteredData.length > 1
      ? (filteredData[filteredData.length - 1]?.close ?? 0) -
        (filteredData[0]?.close ?? 0)
      : 0;
  const priceChangePercent =
    filteredData.length > 1 && filteredData[0]?.close
      ? (priceChange / filteredData[0].close) * 100
      : 0;
  const isPositive = priceChange >= 0;
  const accentColor = isPositive ? "#00ff88" : "#ef4444";

  return (
    <div className="relative">
      {/* Outer glow */}
      <div
        className="absolute -inset-1 rounded-2xl opacity-30 blur-xl"
        style={{
          background: `linear-gradient(135deg, ${accentColor}40, transparent)`,
        }}
      />

      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
        }}
      >
        {/* Scanlines */}
        <div
          className="absolute inset-0 opacity-[0.02] pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
          }}
        />

        <div className="relative p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">📊</span>
                <h3
                  className="text-base font-bold text-white"
                  style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  Price Chart
                </h3>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className="text-2xl font-black"
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    color: "#ffffff",
                  }}
                >
                  ${currentPrice.toFixed(2)}
                </span>
                <span
                  className="px-2 py-1 rounded-lg text-xs font-bold"
                  style={{
                    background: `${accentColor}15`,
                    color: accentColor,
                    border: `1px solid ${accentColor}30`,
                  }}
                >
                  {isPositive ? "▲" : "▼"}{" "}
                  {Math.abs(priceChangePercent).toFixed(2)}%
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              {/* Chart type toggle */}
              <div
                className="flex p-1 rounded-lg"
                role="group"
                aria-label="Chart type selection"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                {(["candlestick", "line"] as ChartType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setChartType(type)}
                    aria-label={`${type} chart`}
                    aria-pressed={chartType === type}
                    className="px-3 py-1.5 text-[10px] font-bold rounded-md transition-all active:scale-95"
                    style={{
                      background:
                        chartType === type
                          ? "rgba(0,240,255,0.15)"
                          : "transparent",
                      color: chartType === type ? "#00f0ff" : "#64748b",
                      border:
                        chartType === type
                          ? "1px solid rgba(0,240,255,0.3)"
                          : "1px solid transparent",
                    }}
                  >
                    {type === "candlestick" ? "CANDLES" : "LINE"}
                  </button>
                ))}
              </div>

              {/* Time range toggle */}
              <div
                className="flex p-1 rounded-lg"
                role="group"
                aria-label="Time range selection"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                {(["1M", "3M", "6M", "1Y"] as TimeRange[]).map((range) => (
                  <button
                    key={range}
                    onClick={() => setTimeRange(range)}
                    aria-label={`${range} time range`}
                    aria-pressed={timeRange === range}
                    className="px-2.5 py-1.5 text-[10px] font-bold rounded-md transition-all active:scale-95"
                    style={{
                      background:
                        timeRange === range
                          ? "rgba(0,240,255,0.15)"
                          : "transparent",
                      color: timeRange === range ? "#00f0ff" : "#64748b",
                      border:
                        timeRange === range
                          ? "1px solid rgba(0,240,255,0.3)"
                          : "1px solid transparent",
                    }}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="relative h-64 w-full">
            {filteredData.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                No data available
              </div>
            ) : (
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="w-full h-full"
                role="img"
                aria-label={`Price chart showing ${chartType} view for ${timeRange} time range`}
              >
                {/* Grid lines */}
                {[0, 25, 50, 75, 100].map((y) => (
                  <line
                    key={y}
                    x1="0"
                    y1={y}
                    x2="100"
                    y2={y}
                    stroke="rgba(255,255,255,0.03)"
                    strokeWidth="0.2"
                  />
                ))}

                {/* Gradient fill under line */}
                {chartType === "line" && (
                  <>
                    <defs>
                      <linearGradient
                        id="lineGradient"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor={accentColor}
                          stopOpacity="0.3"
                        />
                        <stop
                          offset="100%"
                          stopColor={accentColor}
                          stopOpacity="0"
                        />
                      </linearGradient>
                    </defs>
                    <path
                      d={`${filteredData
                        .map((d, i) => {
                          const x =
                            filteredData.length > 1
                              ? (i / (filteredData.length - 1)) * 100
                              : 50;
                          const y = priceToY(d.close);
                          return `${i === 0 ? "M" : "L"} ${x} ${y}`;
                        })
                        .join(" ")} L 100 100 L 0 100 Z`}
                      fill="url(#lineGradient)"
                    />
                  </>
                )}

                {chartType === "line" ? (
                  <path
                    d={filteredData
                      .map((d, i) => {
                        const x =
                          filteredData.length > 1
                            ? (i / (filteredData.length - 1)) * 100
                            : 50;
                        const y = priceToY(d.close);
                        return `${i === 0 ? "M" : "L"} ${x} ${y}`;
                      })
                      .join(" ")}
                    fill="none"
                    stroke={accentColor}
                    strokeWidth="0.5"
                    style={{ filter: `drop-shadow(0 0 3px ${accentColor})` }}
                  />
                ) : (
                  filteredData.map((d, i) => {
                    const x = i * gap + gap / 2;
                    const isUp = d.close >= d.open;
                    const color = isUp ? "#00ff88" : "#ef4444";
                    const bodyTop = priceToY(Math.max(d.open, d.close));
                    const bodyBottom = priceToY(Math.min(d.open, d.close));
                    const bodyHeight = Math.max(0.5, bodyBottom - bodyTop);

                    return (
                      <g key={i}>
                        <line
                          x1={x}
                          y1={priceToY(d.high)}
                          x2={x}
                          y2={priceToY(d.low)}
                          stroke={color}
                          strokeWidth="0.15"
                        />
                        <rect
                          x={x - candleWidth / 2}
                          y={bodyTop}
                          width={candleWidth}
                          height={bodyHeight}
                          fill={color}
                          stroke={color}
                          strokeWidth="0.1"
                          style={{ filter: `drop-shadow(0 0 2px ${color}60)` }}
                        />
                      </g>
                    );
                  })
                )}
              </svg>
            )}

            {/* Price labels */}
            <div className="absolute right-0 top-0 bottom-0 w-16 flex flex-col justify-between text-right pr-2 py-1">
              <span className="text-[10px] text-slate-500 font-mono">
                ${maxPrice.toFixed(0)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                ${((maxPrice + minPrice) / 2).toFixed(0)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                ${minPrice.toFixed(0)}
              </span>
            </div>
          </div>

          {/* Volume bars */}
          <div className="h-12 mt-3">
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="w-full h-full"
            >
              {(() => {
                const volumes = filteredData.map((p) => p.volume);
                const maxVol = volumes.length > 0 ? Math.max(...volumes) : 0;
                return filteredData.map((d, i) => {
                  const volHeight = maxVol > 0 ? (d.volume / maxVol) * 100 : 0;
                  const x = i * gap;
                  const isUp = d.close >= d.open;
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={100 - volHeight}
                      width={gap * 0.8}
                      height={volHeight}
                      fill={
                        isUp ? "rgba(0,255,136,0.3)" : "rgba(239,68,68,0.3)"
                      }
                    />
                  );
                });
              })()}
            </svg>
          </div>
          <div className="text-[10px] text-slate-600 text-center mt-1 font-bold tracking-wider">
            VOLUME
          </div>
        </div>
      </div>
    </div>
  );
};

export default PriceChart;
