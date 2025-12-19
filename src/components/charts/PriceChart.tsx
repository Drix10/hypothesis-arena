/**
 * Price Chart Component - Strategic Arena Theme
 * Candlestick and line chart visualization for stock prices
 */

import React, { useState, useMemo } from "react";
import { motion } from "framer-motion";
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

    if (lows.length === 0 || highs.length === 0) {
      return { minPrice: 0, maxPrice: 100, priceRange: 100 };
    }

    const min = Math.min(...lows) * 0.98;
    const max = Math.max(...highs) * 1.02;
    const range = max - min;

    return { minPrice: min, maxPrice: max, priceRange: range > 0 ? range : 1 };
  }, [filteredData]);

  const priceToY = (price: number): number => {
    if (priceRange === 0) return 50;
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

  return (
    <motion.div
      className="glass-card rounded-2xl p-5"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">📊</span>
            <h3 className="text-base font-semibold text-white">Price Chart</h3>
          </div>
          <div className="flex items-center gap-2">
            <motion.span
              className="text-xl font-bold text-white"
              key={currentPrice}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              ${currentPrice.toFixed(2)}
            </motion.span>
            <motion.span
              className={`px-1.5 py-0.5 rounded-md text-xs font-medium ${
                isPositive
                  ? "bg-bull/[0.12] text-bull-light"
                  : "bg-bear/[0.12] text-bear-light"
              }`}
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
            >
              {isPositive ? "▲" : "▼"} {Math.abs(priceChangePercent).toFixed(2)}
              %
            </motion.span>
          </div>
        </div>

        <div className="flex gap-1.5">
          <div
            className="flex bg-arena-deep/50 rounded-lg p-0.5 border border-white/[0.05]"
            role="group"
            aria-label="Chart type"
          >
            {(["candlestick", "line"] as ChartType[]).map((type) => (
              <motion.button
                key={type}
                onClick={() => setChartType(type)}
                className={`px-2.5 py-1 text-[10px] rounded-md transition-all ${
                  chartType === type
                    ? "bg-cyan/15 text-cyan"
                    : "text-slate-500 hover:text-slate-300"
                }`}
                whileTap={{ scale: 0.95 }}
                aria-pressed={chartType === type}
                aria-label={`${
                  type === "candlestick" ? "Candlestick" : "Line"
                } chart`}
              >
                {type === "candlestick" ? "Candles" : "Line"}
              </motion.button>
            ))}
          </div>

          <div
            className="flex bg-arena-deep/50 rounded-lg p-0.5 border border-white/[0.05]"
            role="group"
            aria-label="Time range"
          >
            {(["1M", "3M", "6M", "1Y"] as TimeRange[]).map((range) => (
              <motion.button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-2 py-1 text-[10px] rounded-md transition-all ${
                  timeRange === range
                    ? "bg-cyan/15 text-cyan"
                    : "text-slate-500 hover:text-slate-300"
                }`}
                whileTap={{ scale: 0.95 }}
                aria-pressed={timeRange === range}
                aria-label={`${
                  range === "1M"
                    ? "1 month"
                    : range === "3M"
                    ? "3 months"
                    : range === "6M"
                    ? "6 months"
                    : "1 year"
                } range`}
              >
                {range}
              </motion.button>
            ))}
          </div>
        </div>
      </div>

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
            aria-label={`Price chart showing ${timeRange} of data. Current price ${currentPrice.toFixed(
              2
            )}, ${isPositive ? "up" : "down"} ${Math.abs(
              priceChangePercent
            ).toFixed(2)}%`}
          >
            <title>Stock Price Chart</title>
            {[0, 25, 50, 75, 100].map((y) => (
              <line
                key={y}
                x1="0"
                y1={y}
                x2="100"
                y2={y}
                stroke="rgba(255,255,255,0.05)"
                strokeWidth="0.2"
              />
            ))}

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
                stroke={isPositive ? "#10b981" : "#ef4444"}
                strokeWidth="0.5"
              />
            ) : (
              filteredData.map((d, i) => {
                const x = i * gap + gap / 2;
                const isUp = d.close >= d.open;
                const color = isUp ? "#10b981" : "#ef4444";
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
                    />
                  </g>
                );
              })
            )}
          </svg>
        )}

        <div className="absolute right-0 top-0 bottom-0 w-16 flex flex-col justify-between text-right pr-2 py-1">
          <span className="text-xs text-slate-500">${maxPrice.toFixed(0)}</span>
          <span className="text-xs text-slate-500">
            ${((maxPrice + minPrice) / 2).toFixed(0)}
          </span>
          <span className="text-xs text-slate-500">${minPrice.toFixed(0)}</span>
        </div>
      </div>

      <div className="h-12 mt-2">
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
                <motion.rect
                  key={i}
                  x={x}
                  y={100 - volHeight}
                  width={gap * 0.8}
                  height={volHeight}
                  fill={
                    isUp ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"
                  }
                  initial={{ height: 0, y: 100 }}
                  animate={{ height: volHeight, y: 100 - volHeight }}
                  transition={{ duration: 0.3, delay: i * 0.002 }}
                />
              );
            });
          })()}
        </svg>
      </div>
      <div className="text-xs text-slate-500 text-center mt-1">Volume</div>
    </motion.div>
  );
};

export default PriceChart;
