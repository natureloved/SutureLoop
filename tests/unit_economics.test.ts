import { describe, it, expect } from 'vitest';
import { calculateIncidentEconomics, generateBusinessModel } from '../src/economics/unit_economics.js';
import { summarizeMeasurements, describeBasis } from '../src/economics/measurements.js';

describe('cfo.ai Unit Economics & Financial Calculator', () => {
  it('should compute accurate unit economics for remediations', () => {
    const econ = calculateIncidentEconomics({
      measuredTokenCostUSD: 0.0011,
      mttrMinutesSaved: 45,
      hourlyEngineerRateUSD: 125
    });

    expect(econ.mttrHoursSaved).toBe(0.75);
    expect(econ.grossSavingsUSD).toBe(93.75);
    expect(econ.netSavingsUSD).toBeCloseTo(93.7489, 2);
    expect(econ.grossMarginPercent).toBeGreaterThanOrEqual(99.9);
  });

  it('should generate business model subscription tiers with high gross margins', () => {
    const model = generateBusinessModel(0.0011);
    expect(model.subscriptionTiers).toHaveLength(3);

    const starter = model.subscriptionTiers[0];
    expect(starter.monthlyPriceUSD).toBe(79);
    expect(starter.estimatedGrossMarginPercent).toBeGreaterThan(99);

    const scale = model.subscriptionTiers[2];
    expect(scale.monthlyPriceUSD).toBe(599);
    expect(scale.estimatedGrossMarginPercent).toBeGreaterThan(99.9);
  });

  it('still prints the plan when nothing has been measured, and nulls only the derived figures', () => {
    const model = generateBusinessModel(null);

    expect(model.measured).toBe(false);
    expect(model.perIncident).toBeNull();

    // Plan inputs are business decisions, not measurements: always available.
    expect(model.subscriptionTiers).toHaveLength(3);
    for (const tier of model.subscriptionTiers) {
      expect(tier.monthlyPriceUSD).toBeGreaterThan(0);
      expect(tier.incidentsIncluded).toBeGreaterThan(0);
      expect(tier.estimatedGrossMarginPercent).toBeNull();
    }
    expect(model.monthlyProjections.engineeringTimeSavedUSD).toBeGreaterThan(0);
    expect(model.monthlyProjections.agentRunningCostUSD).toBeNull();
    expect(model.monthlyProjections.netMonthlySavingsUSD).toBeNull();
  });

  it('treats a zero or non-finite cost as unmeasured rather than as free compute', () => {
    expect(generateBusinessModel(0).measured).toBe(false);
    expect(generateBusinessModel(NaN).measured).toBe(false);
  });
});

describe('measurement ledger', () => {
  const m = (cost: number, mode: 'llm' | 'offline-transformer' = 'offline-transformer') => ({
    sessionId: `s_${cost}_${mode}`,
    measuredTokenCostUSD: cost,
    durationMs: 1000,
    mode,
    recordedAt: Date.now()
  });

  it('returns null for an empty ledger instead of inventing a figure', () => {
    expect(summarizeMeasurements([])).toBeNull();
  });

  it('uses the median so one expensive run cannot redefine the typical cost', () => {
    const summary = summarizeMeasurements([
      m(0.0001), m(0.0001), m(0.0001), m(0.0125)
    ])!;

    expect(summary.count).toBe(4);
    // Mean would be 0.0032; median stays at the typical offline cost.
    expect(summary.medianUSD).toBeCloseTo(0.0001, 6);
    expect(summary.maxUSD).toBeCloseTo(0.0125, 6);
    expect(summary.p95USD).toBeGreaterThan(summary.medianUSD);
  });

  it('counts composition by synthesis mode', () => {
    const summary = summarizeMeasurements([
      m(0.0001, 'offline-transformer'),
      m(0.0001, 'offline-transformer'),
      m(0.0125, 'llm')
    ])!;

    expect(summary.byMode.llm).toBe(1);
    expect(summary.byMode['offline-transformer']).toBe(2);
  });

  it('warns that an offline-only ledger excludes provider token cost', () => {
    const offlineOnly = summarizeMeasurements([m(0.0001)])!;
    expect(describeBasis(offlineOnly)).toMatch(/excludes provider token cost/);

    const mixed = summarizeMeasurements([m(0.0001), m(0.01, 'llm')])!;
    expect(describeBasis(mixed)).toMatch(/LLM-backed/);
    expect(describeBasis(mixed)).not.toMatch(/excludes provider token cost/);
  });

  it('ignores malformed entries rather than poisoning the summary', () => {
    const summary = summarizeMeasurements([
      m(0.0001),
      { ...m(NaN) },
      { ...m(-1) }
    ])!;
    expect(summary.count).toBe(1);
  });
});
