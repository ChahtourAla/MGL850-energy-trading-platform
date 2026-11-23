'use client';

import { useState } from 'react';

type EnergyHour = {
  intervalStart: string;
  productionWh: string;
  consumptionWh: string;
  netEnergyWh: string;
};

type Props = {
  hours: EnergyHour[];
};

export default function EnergyHistoryChart({ hours }: Props) {
  const [mode, setMode] = useState<'compare' | 'net'>('compare');

  const readings = [...hours]
    .sort((a, b) => a.intervalStart.localeCompare(b.intervalStart))
    .map((hour) => ({
      date: hour.intervalStart,
      production: Number(hour.productionWh) / 1000,
      consumption: Number(hour.consumptionWh) / 1000,
      net: Number(hour.netEnergyWh) / 1000,
    }));

  if (readings.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h3 className="font-semibold">Hourly Energy Chart</h3>
        <p className="mt-3 text-sm text-slate-400">No energy readings for this period.</p>
      </div>
    );
  }

  const width = 900;
  const height = 300;
  const left = 65;
  const right = 24;
  const top = 25;
  const bottom = 45;

  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const maxValue =
    mode === 'compare'
      ? Math.max(1, ...readings.flatMap((r) => [r.production, r.consumption]))
      : Math.max(1, ...readings.map((r) => Math.abs(r.net)));

  const minY = mode === 'net' ? -maxValue : 0;
  const maxY = maxValue;

  const x = (index: number) =>
    left + (readings.length === 1 ? plotWidth / 2 : (index / (readings.length - 1)) * plotWidth);

  const y = (value: number) => top + ((maxY - value) / (maxY - minY)) * plotHeight;

  const series =
    mode === 'compare'
      ? [
          {
            label: 'Production',
            field: 'production' as const,
            color: '#34d399',
          },
          {
            label: 'Consumption',
            field: 'consumption' as const,
            color: '#38bdf8',
          },
        ]
      : [
          {
            label: 'Net energy',
            field: 'net' as const,
            color: '#c4b5fd',
          },
        ];

  const gridLevels = [0, 0.25, 0.5, 0.75, 1];
  const labelStep = Math.max(1, Math.ceil(readings.length / 8));

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Hourly Energy Chart</h3>
          <p className="mt-1 text-sm text-slate-400">Historical simulated electricity data · UTC</p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={mode === 'compare'}
            onClick={() => setMode('compare')}
            className={`rounded-lg px-4 py-2 text-sm ${
              mode === 'compare' ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            Production / Consumption
          </button>

          <button
            type="button"
            aria-pressed={mode === 'net'}
            onClick={() => setMode('net')}
            className={`rounded-lg px-4 py-2 text-sm ${
              mode === 'net' ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            Net Energy
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-5 text-sm">
        {series.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full min-w-[600px]"
          role="img"
          aria-label={`Hourly ${
            mode === 'compare' ? 'production and consumption' : 'net energy'
          } chart in kWh`}
        >
          {gridLevels.map((fraction) => {
            const value = maxY - fraction * (maxY - minY);
            const position = y(value);

            return (
              <g key={fraction}>
                <line
                  x1={left}
                  x2={width - right}
                  y1={position}
                  y2={position}
                  stroke="#334155"
                  strokeDasharray="4 5"
                />
                <text x={left - 12} y={position + 4} fontSize="12" fill="#94a3b8" textAnchor="end">
                  {value.toFixed(1)}
                </text>
              </g>
            );
          })}

          {readings.map((reading, index) =>
            index % labelStep === 0 || index === readings.length - 1 ? (
              <text
                key={`${reading.date}-${index}`}
                x={x(index)}
                y={height - 12}
                fontSize="12"
                fill="#94a3b8"
                textAnchor="middle"
              >
                {reading.date.slice(11, 16)}
              </text>
            ) : null,
          )}

          {mode === 'net' && (
            <line
              x1={left}
              x2={width - right}
              y1={y(0)}
              y2={y(0)}
              stroke="#e2e8f0"
              strokeWidth="1.5"
            />
          )}

          {series.map((item) => (
            <g key={item.label}>
              <polyline
                fill="none"
                stroke={item.color}
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={readings
                  .map((reading, index) => `${x(index)},${y(reading[item.field])}`)
                  .join(' ')}
              />

              {readings.map((reading, index) => (
                <circle
                  key={`${item.label}-${reading.date}`}
                  cx={x(index)}
                  cy={y(reading[item.field])}
                  r="4"
                  fill={item.color}
                  stroke="#0f172a"
                  strokeWidth="1.5"
                >
                  <title>
                    {`${reading.date.replace('T', ' ').slice(0, 16)} UTC
${item.label}: ${reading[item.field].toFixed(3)} kWh`}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Hover over a point to see its exact hourly value. Net energy = production − consumption.
      </p>
    </section>
  );
}
