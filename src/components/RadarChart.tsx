import React, { memo, useMemo } from "react";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";
import { Scores } from "../types";

interface Props {
  scores: Scores;
  color?: string;
}

const ScoreRadar: React.FC<Props> = memo(({ scores, color = "#22d3ee" }) => {
  const data = useMemo(
    () => [
      { subject: "Novelty", A: scores.novelty, fullMark: 10 },
      { subject: "Feasibility", A: scores.feasibility, fullMark: 10 },
      { subject: "Impact", A: scores.impact, fullMark: 10 },
      { subject: "Ethics", A: scores.ethics, fullMark: 10 },
    ],
    [scores.novelty, scores.feasibility, scores.impact, scores.ethics]
  );

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart cx="50%" cy="50%" outerRadius="90%" data={data}>
          <PolarGrid stroke="#475569" />
          <PolarAngleAxis
            dataKey="subject"
            tick={{ fill: "#94a3b8", fontSize: 12 }}
          />
          <PolarRadiusAxis
            angle={30}
            domain={[0, 10]}
            tick={false}
            axisLine={false}
          />
          <Radar
            name="Score"
            dataKey="A"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.3}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
});

ScoreRadar.displayName = "ScoreRadar";

export default ScoreRadar;
