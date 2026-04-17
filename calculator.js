// Merch Troop Calculator core (synced to merchtroop.com/calculator as of 2026-03-10)

export function money(v) {
  return `$${(Number(v) || 0).toFixed(2)}`;
}

export function priceFromCost(cost, mode = 'markup', pct = 40) {
  const c = Number(cost || 0);
  const p = Number(pct || 0);
  if (mode === 'margin') {
    const m = Math.min(99.9, Math.max(0, p));
    return c / (1 - (m / 100));
  }
  return c * (1 + (p / 100));
}

const screenPricing = {
  1:{75:2.51,100:1.87,150:1.40,250:1.23,500:1.02,750:0.89,1000:0.81,2500:0.72,5000:0.64},
  2:{75:3.19,100:2.47,150:1.91,250:1.70,500:1.45,750:1.28,1000:1.16,2500:1.06,5000:0.98},
  3:{75:3.61,100:2.81,150:2.17,250:1.91,500:1.62,750:1.40,1000:1.27,2500:1.15,5000:1.06},
  4:{75:4.04,100:3.15,150:2.42,250:2.13,500:1.79,750:1.53,1000:1.37,2500:1.23,5000:1.15},
  5:{75:4.46,100:3.49,150:2.68,250:2.34,500:1.96,750:1.66,1000:1.47,2500:1.32,5000:1.23},
  6:{75:4.89,100:3.83,150:2.93,250:2.55,500:2.13,750:1.79,1000:1.57,2500:1.40,5000:1.32},
  7:{75:5.31,100:4.17,150:3.19,250:2.76,500:2.30,750:1.91,1000:1.67,2500:1.49,5000:1.40},
  8:{75:5.74,100:4.51,150:3.44,250:2.98,500:2.47,750:2.04,1000:1.77,2500:1.57,5000:1.49}
};

function getScreenBreak(qty) {
  const breaks = [75,100,150,250,500,750,1000,2500,5000];
  let selected = 75;
  for (const b of breaks) if (qty >= b) selected = b;
  return selected;
}

function screenCost(qty, colors = 1) {
  const safeColors = Math.min(8, Math.max(1, parseInt(colors, 10) || 1));
  const breakQty = getScreenBreak(Number(qty || 0));
  return screenPricing[safeColors][breakQty];
}

function dtfCost(widthIn, heightIn) {
  const sqin = (Number(widthIn) || 0) * (Number(heightIn) || 0);
  return (sqin * 0.05) + 1.5;
}

function laserCost(qty) {
  const q = Number(qty || 0);
  if (q >= 500) return 1.5;
  if (q >= 250) return 3;
  if (q >= 100) return 5;
  return 5;
}

function embroideryCost(qty, live) {
  if (live) return Number(qty || 0) >= 150 ? 15 : 20;
  return 7;
}

function patchCost(qty, designCount = 1) {
  const perDesign = Number(qty || 0) > 150 ? 5 : 8;
  return perDesign * (parseInt(designCount, 10) || 1);
}

export function locationCostPerUnit(loc, qty, eventMode = false) {
  const l = loc || {};
  const isLive = !!l.live || !!eventMode;

  if (l.method === 'screen') {
    let price = screenCost(qty, l.colors || 1);
    if (isLive) price += 1.5;
    return price;
  }

  if (l.method === 'dtf' || l.method === 'uvdtf') {
    return dtfCost(l.w, l.h);
  }

  if (l.method === 'laser') return laserCost(qty);
  if (l.method === 'emb') return embroideryCost(qty, isLive);

  if (l.method === 'wovenPatch' || l.method === 'leatherPatch' || l.method === 'heatPatch') {
    let price = patchCost(qty, l.designCount || 1);
    if (isLive) price += 1.5;
    return price;
  }

  return 0;
}

export function calcJob(input = {}) {
  const quantity = Number(input.quantity || 0);
  const blankCost = Number(input.blankCost || 0);
  const mode = input.mode || 'markup';
  const pct = Number(input.pct ?? input.markupPct ?? 40);
  const eventMode = !!input.eventMode;
  const applyMarkupToPrint = !!input.applyMarkupToPrint;
  const locations = Array.isArray(input.locations) ? input.locations : [];

  let decorationCostPerUnit = 0;

  for (const loc of locations) {
    if (loc?.enabled === false) continue;
    decorationCostPerUnit += locationCostPerUnit(loc, quantity, eventMode);
  }

  const printPricePerUnit = applyMarkupToPrint ? priceFromCost(decorationCostPerUnit, mode, pct) : decorationCostPerUnit;
  const blankPricePerUnit = priceFromCost(blankCost, mode, pct);

  const unitCost = blankCost + decorationCostPerUnit;
  const unitPrice = blankPricePerUnit + printPricePerUnit;
  const unitProfit = unitPrice - unitCost;
  const subtotal = unitPrice * quantity;

  return {
    quantity,
    blankCost,
    mode,
    pct,
    eventMode,
    applyMarkupToPrint,
    decorationCostPerUnit,
    blankPricePerUnit,
    printPricePerUnit,
    unitCost,
    unitPrice,
    unitProfit,
    subtotal,
    totalProfit: unitProfit * quantity,
  };
}
