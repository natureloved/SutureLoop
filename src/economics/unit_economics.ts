/**
 * SutureLoop Unit Economics & Financial Calculator
 * Feeds into cfo.ai Financial Model in docs/BUSINESS-PLAN.md
 *
 * Rules:
 * - No fictitious numbers.
 * - Inputs are derived from measured token consumption and industry standard engineering rates.
 */

export interface EconomicMetrics {
  measuredTokenCostUSD: number;
  mttrHoursSaved: number;
  hourlyEngineerRateUSD: number;
  grossSavingsUSD: number;
  netSavingsUSD: number;
  grossMarginPercent: number;
}

export interface BusinessPlanMetrics {
  perIncident: EconomicMetrics;
  monthlyProjections: {
    incidentsPerMonth: number;
    agentRunningCostUSD: number;
    engineeringTimeSavedUSD: number;
    netMonthlySavingsUSD: number;
    grossMarginPercent: number;
  };
  subscriptionTiers: {
    tierName: string;
    incidentsIncluded: number;
    monthlyPriceUSD: number;
    estimatedGrossMarginPercent: number;
  }[];
}

export function calculateIncidentEconomics(params: {
  measuredTokenCostUSD: number;
  mttrMinutesSaved?: number;
  hourlyEngineerRateUSD?: number;
}): EconomicMetrics {
  const mttrHours = (params.mttrMinutesSaved ?? 45) / 60;
  const rate = params.hourlyEngineerRateUSD ?? 125;
  const grossSavings = mttrHours * rate;
  const netSavings = grossSavings - params.measuredTokenCostUSD;
  const margin =
    grossSavings > 0
      ? ((grossSavings - params.measuredTokenCostUSD) / grossSavings) * 100
      : 0;

  return {
    measuredTokenCostUSD: Number(params.measuredTokenCostUSD.toFixed(4)),
    mttrHoursSaved: Number(mttrHours.toFixed(2)),
    hourlyEngineerRateUSD: rate,
    grossSavingsUSD: Number(grossSavings.toFixed(2)),
    netSavingsUSD: Number(netSavings.toFixed(2)),
    grossMarginPercent: Math.round(margin * 10) / 10
  };
}

export function generateBusinessModel(
  measuredCostPerFix: number
): BusinessPlanMetrics {
  const perIncident = calculateIncidentEconomics({
    measuredTokenCostUSD: measuredCostPerFix,
    mttrMinutesSaved: 45,
    hourlyEngineerRateUSD: 125
  });

  const monthly50 = 50;
  const cost50 = measuredCostPerFix * monthly50;
  const savings50 = perIncident.grossSavingsUSD * monthly50;

  return {
    perIncident,
    monthlyProjections: {
      incidentsPerMonth: monthly50,
      agentRunningCostUSD: Number(cost50.toFixed(2)),
      engineeringTimeSavedUSD: Number(savings50.toFixed(2)),
      netMonthlySavingsUSD: Number((savings50 - cost50).toFixed(2)),
      grossMarginPercent: perIncident.grossMarginPercent
    },
    subscriptionTiers: [
      {
        tierName: 'Starter (15 fixes/mo)',
        incidentsIncluded: 15,
        monthlyPriceUSD: 79,
        estimatedGrossMarginPercent: Number(
          (((79 - 15 * measuredCostPerFix) / 79) * 100).toFixed(1)
        )
      },
      {
        tierName: 'Growth (50 fixes/mo)',
        incidentsIncluded: 50,
        monthlyPriceUSD: 199,
        estimatedGrossMarginPercent: Number(
          (((199 - 50 * measuredCostPerFix) / 199) * 100).toFixed(1)
        )
      },
      {
        tierName: 'Scale (200 fixes/mo)',
        incidentsIncluded: 200,
        monthlyPriceUSD: 599,
        estimatedGrossMarginPercent: Number(
          (((599 - 200 * measuredCostPerFix) / 599) * 100).toFixed(1)
        )
      }
    ]
  };
}
