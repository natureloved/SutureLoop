import { describe, it, expect } from 'vitest';
import { calculateIncidentEconomics, generateBusinessModel } from '../src/economics/unit_economics.js';

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
});
