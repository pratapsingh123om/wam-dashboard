// src/components/ChartArea.jsx
import React, { useEffect, useRef } from "react";
import { Chart, registerables } from "chart.js";
import "chartjs-adapter-date-fns"; // adapter for time scale

// register everything once
Chart.register(...registerables);

const METRIC_COLORS = {
  ph: "#62d0b3",
  tds: "#7cb7ff",
  turb: "#ffd166",
  iron: "#d68cff",
  default: "#9fb0c8",
};

export default function ChartArea({ readings = [], metric = "ph", height = 260 }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // HMR / multi-mount safety: destroy any previous instance
    try {
      if (window.__wamChartInstance) {
        window.__wamChartInstance.destroy();
        window.__wamChartInstance = null;
      }
    } catch (e) {}

    if (chartRef.current) {
      try { chartRef.current.destroy(); } catch (e) { /* ignore */ }
      chartRef.current = null;
    }

    // Data preparation (assumes readings are chronological with oldest first)
    const rows = Array.isArray(readings) ? readings.slice() : [];
    const labels = rows.map(r => (r && r.ts ? new Date(r.ts) : null));
    const data = rows.map(r => {
      const v = r ? r[metric] : null;
      return v === "" || v === null || v === undefined ? null : Number(v);
    });

    const color = METRIC_COLORS[metric] || METRIC_COLORS.default;

    const cfg = {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: metric.toUpperCase(),
          data,
          spanGaps: true,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          borderColor: color,
          backgroundColor: `${color}33`,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, tooltip: { mode: "index", intersect: false } },
        scales: {
          x: {
            type: "time",
            time: { tooltipFormat: "PP p" },
            title: { display: true, text: "Time" }
          },
          y: { title: { display: true, text: metric.toUpperCase() } }
        },
        animation: false
      }
    };

    try {
      chartRef.current = new Chart(ctx, cfg);
      window.__wamChartInstance = chartRef.current;
    } catch (err) {
      console.error("Chart creation error:", err);
    }

    return () => {
      if (chartRef.current) {
        try { chartRef.current.destroy(); } catch (e) { /* ignore */ }
        chartRef.current = null;
      }
      try { window.__wamChartInstance = null; } catch (e) {}
    };
  }, [readings, metric, height]);

  return <div style={{ height, marginBottom: 12 }}><canvas ref={canvasRef} /></div>;
}
