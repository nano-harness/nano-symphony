/**
 * Lightweight in-memory Prometheus-compatible metrics registry.
 *
 * Not intended to replace a full metrics pipeline; it exposes counters and
 * summaries that operators can scrape with `curl /metrics` while running
 * symphony locally or in small deployments.
 */

interface Counter {
  value: number;
  labels: Record<string, string>;
}

interface HistogramSample {
  sum: number;
  count: number;
  buckets: Map<number, number>;
}

const counters = new Map<string, Counter[]>();
const histograms = new Map<string, HistogramSample>();

export function incCounter(name: string, labels: Record<string, string> = {}, delta = 1): void {
  const series = counters.get(name) ?? [];
  const key = labelKey(labels);
  let entry = series.find((s) => labelKey(s.labels) === key);
  if (!entry) {
    entry = { value: 0, labels };
    series.push(entry);
  }
  entry.value += delta;
  counters.set(name, series);
}

export function observeHistogram(name: string, value: number, buckets: number[] = [1000, 5000, 10_000, 30_000, 60_000, 300_000]): void {
  let sample = histograms.get(name);
  if (!sample) {
    sample = { sum: 0, count: 0, buckets: new Map() };
    histograms.set(name, sample);
  }
  sample.sum += value;
  sample.count += 1;
  for (const b of buckets) {
    if (value <= b) {
      sample.buckets.set(b, (sample.buckets.get(b) ?? 0) + 1);
    }
  }
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return "{" + entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",") + "}";
}

export function renderMetrics(): string {
  const lines: string[] = [];
  lines.push("# HELP symphony_build_info Static build information.");
  lines.push("# TYPE symphony_build_info gauge");
  lines.push(`symphony_build_info{version="0.1.0"} 1`);

  for (const [name, series] of counters) {
    lines.push(`# HELP ${name} Auto-generated counter.`);
    lines.push(`# TYPE ${name} counter`);
    for (const s of series) {
      lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
    }
  }

  for (const [name, sample] of histograms) {
    lines.push(`# HELP ${name} Auto-generated histogram.`);
    lines.push(`# TYPE ${name} histogram`);
    const sortedBuckets = [...sample.buckets.entries()].sort(([a], [b]) => a - b);
    for (const [le, count] of sortedBuckets) {
      lines.push(`${name}_bucket{le="${le}"} ${count}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${sample.count}`);
    lines.push(`${name}_sum ${sample.sum}`);
    lines.push(`${name}_count ${sample.count}`);
  }

  return lines.join("\n") + "\n";
}

/** Snapshot counters/histograms for testing or debugging. */
export function getMetricsDebugSnapshot(): {
  counters: Array<{ name: string; value: number; labels: Record<string, string> }>;
  histograms: Array<{ name: string; sum: number; count: number; buckets: number[] }>;
} {
  return {
    counters: [...counters.entries()].flatMap(([name, series]) =>
      series.map((s) => ({ name, value: s.value, labels: s.labels }))
    ),
    histograms: [...histograms.entries()].map(([name, sample]) => ({
      name,
      sum: sample.sum,
      count: sample.count,
      buckets: [...sample.buckets.entries()].map(([le, count]) => ({ le, count })) as unknown as number[],
    })),
  };
}
