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

export interface SubscriptionTier {
  tierName: string;
  incidentsIncluded: number;
  monthlyPriceUSD: number;
  /**
   * Derived from the measured cost per fix, so it is null until a remediation
   * has actually been measured on this host. The price and the included-fix
   * count are business inputs and are always populated.
   */
  estimatedGrossMarginPercent: number | null;
}

export interface BusinessPlanMetrics {
  perIncident: EconomicMetrics | null;
  /** False until at least one session has been measured. */
  measured: boolean;
  monthlyProjections: {
    incidentsPerMonth: number;
    agentRunningCostUSD: number | null;
    engineeringTimeSavedUSD: number;
    netMonthlySavingsUSD: number | null;
    grossMarginPercent: number | null;
  };
  subscriptionTiers: SubscriptionTier[];
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

/**
 * Builds the subscription model.
 *
 * `measuredCostPerFix` is null when no remediation has been measured on this
 * host. Everything that does not depend on it -- the per-incident engineering
 * value, the tier prices, the included-fix counts -- is still returned, so the
 * command shows a real plan instead of an error. Only the figures that would
 * require an invented cost come back null.
 */
export function generateBusinessModel(
  measuredCostPerFix: number | null
): BusinessPlanMetrics {
  const measured =
    measuredCostPerFix !== null &&
    Number.isFinite(measuredCostPerFix) &&
    measuredCostPerFix > 0;

  const perIncident = measured
    ? calculateIncidentEconomics({
        measuredTokenCostUSD: measuredCostPerFix!,
        mttrMinutesSaved: 45,
        hourlyEngineerRateUSD: 125
      })
    : null;

  const monthly50 = 50;
  // Engineering time returned is independent of the agent's own cost.
  const savings50 = 0.75 * 125 * monthly50;
  const cost50 = measured ? measuredCostPerFix! * monthly50 : null;

  const marginFor = (priceUSD: number, fixes: number): number | null =>
    measured ? Number((((priceUSD - fixes * measuredCostPerFix!) / priceUSD) * 100).toFixed(1)) : null;

  return {
    perIncident,
    measured,
    monthlyProjections: {
      incidentsPerMonth: monthly50,
      agentRunningCostUSD: cost50 === null ? null : Number(cost50.toFixed(2)),
      engineeringTimeSavedUSD: Number(savings50.toFixed(2)),
      netMonthlySavingsUSD: cost50 === null ? null : Number((savings50 - cost50).toFixed(2)),
      grossMarginPercent: perIncident?.grossMarginPercent ?? null
    },
    subscriptionTiers: [
      {
        tierName: 'Starter (15 fixes/mo)',
        incidentsIncluded: 15,
        monthlyPriceUSD: 79,
        estimatedGrossMarginPercent: marginFor(79, 15)
      },
      {
        tierName: 'Growth (50 fixes/mo)',
        incidentsIncluded: 50,
        monthlyPriceUSD: 199,
        estimatedGrossMarginPercent: marginFor(199, 50)
      },
      {
        tierName: 'Scale (200 fixes/mo)',
        incidentsIncluded: 200,
        monthlyPriceUSD: 599,
        estimatedGrossMarginPercent: marginFor(599, 200)
      }
    ]
  };
}
