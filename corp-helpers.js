/**
 * Corporation-specific helper utilities
 * Separated from helpers.js to reduce RAM usage for non-corp scripts
 * Based on mathematical formulas from the Bitburner Corporation Strategy Guide
 */

import { log, checkNsInstance } from './helpers.js';

/**
 * Sets corporation dividend percentage to maximum (100%) for pre-ascension payout
 * @param {NS} ns - Netscript instance
 * @param {string} context - Context message for logging
 */
export async function maximizeDividends(ns, context = '') {
    checkNsInstance(ns, '"maximizeDividends"');
    try {
        // Check if corporation API exists (requires BN3 or SF3, disabled in BN8)
        if (!ns.corporation) {
            return; // Silently skip if no API access
        }
        const corp = await ns.corporation.getCorporation();
        if (!corp) {
            log(ns, `INFO: No corporation found${context ? ' - ' + context : ''}`, false, 'info');
            return;
        }
        await ns.corporation.issueDividends(1.0);
        log(ns, `SUCCESS: Dividends maximized to 100%${context ? ' - ' + context : ''}`, false, 'success');
    } catch (error) {
        log(ns, `WARNING: Failed to maximize dividends${context ? ' - ' + context : ''}: ${error?.message || error}`, false, 'warning');
    }
}

// ============================================================================
// BOOST MATERIAL CONSTANTS AND CALCULATIONS
// ============================================================================

export const BOOST_MATERIAL_SIZES = {
    'Real Estate': 0.005,
    'Hardware': 0.015,
    'AI Cores': 0.1,
    'Robots': 0.5
};

export const INDUSTRY_BOOST_COEFFICIENTS = {
    'Agriculture': { 'Real Estate': 0.72, 'Hardware': 0.2, 'AI Cores': 0.3, 'Robots': 0.3 },
    'Chemical': { 'Real Estate': 0.25, 'Hardware': 0.2, 'AI Cores': 0.2, 'Robots': 0.25 },
    'Tobacco': { 'Real Estate': 0.15, 'Hardware': 0.15, 'AI Cores': 0.15, 'Robots': 0.25 },
    'Pharmaceutical': { 'Real Estate': 0.2, 'Hardware': 0.15, 'AI Cores': 0.25, 'Robots': 0.3 },
    'Healthcare': { 'Real Estate': 0.1, 'Hardware': 0.1, 'AI Cores': 0.1, 'Robots': 0.3 },
    'Restaurant': { 'Real Estate': 0.25, 'Hardware': 0.15, 'AI Cores': 0.1, 'Robots': 0.2 },
    'Real Estate': { 'Real Estate': 0.3, 'Hardware': 0.1, 'AI Cores': 0.05, 'Robots': 0.2 }
};

function calculateOptimalBoostMaterialsRecursive(industryType, storageSpace, excludeMaterials) {
    const coefficients = INDUSTRY_BOOST_COEFFICIENTS[industryType];
    const materials = ['Real Estate', 'Hardware', 'AI Cores', 'Robots'].filter(m => !excludeMaterials.includes(m));
    
    if (materials.length === 0) {
        return { materials: {}, totalSpace: 0, industry: industryType, storageSpace };
    }
    
    const sizes = materials.map(m => BOOST_MATERIAL_SIZES[m]);
    const coeffs = materials.map(m => coefficients[m]);
    const sumCoeffs = coeffs.reduce((a, b) => a + b, 0);
    const sumSizes = sizes.reduce((a, b) => a + b, 0);
    
    const result = {};
    
    for (let i = 0; i < materials.length; i++) {
        const ci = coeffs[i];
        const si = sizes[i];
        const otherCoeffsSum = sumCoeffs - ci;
        const otherSizesSum = sumSizes - sizes[i];
        
        const numerator = storageSpace - 500 * ((si / ci) * otherCoeffsSum - otherSizesSum);
        const denominator = sumCoeffs / ci;
        
        let optimalSpace = numerator / denominator;
        const quantity = optimalSpace / si;
        
        result[materials[i]] = {
            quantity: Math.max(0, quantity),
            space: Math.max(0, optimalSpace),
            percentage: 0
        };
    }
    
    const stillNegative = materials.filter(m => result[m].quantity < 0);
    if (stillNegative.length > 0) {
        return calculateOptimalBoostMaterialsRecursive(industryType, storageSpace, [...excludeMaterials, ...stillNegative]);
    }
    
    for (const excluded of excludeMaterials) {
        result[excluded] = { quantity: 0, space: 0, percentage: 0 };
    }
    
    const totalSpace = Object.values(result).reduce((sum, r) => sum + r.space, 0);
    for (const material of Object.keys(result)) {
        result[material].percentage = totalSpace > 0 ? (result[material].space / totalSpace) * 100 : 0;
    }
    
    return {
        materials: result,
        totalSpace: totalSpace,
        industry: industryType,
        storageSpace: storageSpace
    };
}

export function calculateOptimalBoostMaterials(industryType, storageSpace) {
    const coefficients = INDUSTRY_BOOST_COEFFICIENTS[industryType];
    if (!coefficients) {
        throw new Error(`Unknown industry type: ${industryType}`);
    }

    const materials = ['Real Estate', 'Hardware', 'AI Cores', 'Robots'];
    const sizes = materials.map(m => BOOST_MATERIAL_SIZES[m]);
    const coeffs = materials.map(m => coefficients[m]);
    
    const sumCoeffs = coeffs.reduce((a, b) => a + b, 0);
    const sumSizes = sizes.reduce((a, b) => a + b, 0);
    
    const result = {};
    
    for (let i = 0; i < materials.length; i++) {
        const ci = coeffs[i];
        const si = sizes[i];
        const otherCoeffsSum = sumCoeffs - ci;
        const otherSizesSum = sumSizes - sizes[i];
        
        const numerator = storageSpace - 500 * ((si / ci) * otherCoeffsSum - otherSizesSum);
        const denominator = sumCoeffs / ci;
        
        let optimalSpace = numerator / denominator;
        
        if (optimalSpace < 0) {
            optimalSpace = 0;
        }
        
        const quantity = optimalSpace / si;
        
        result[materials[i]] = {
            quantity: Math.max(0, quantity),
            space: Math.max(0, optimalSpace),
            percentage: 0
        };
    }
    
    const negativeMaterials = materials.filter(m => result[m].quantity < 0);
    if (negativeMaterials.length > 0) {
        return calculateOptimalBoostMaterialsRecursive(industryType, storageSpace, negativeMaterials);
    }
    
    const totalSpace = Object.values(result).reduce((sum, r) => sum + r.space, 0);
    for (const material of materials) {
        result[material].percentage = totalSpace > 0 ? (result[material].space / totalSpace) * 100 : 0;
    }
    
    return {
        materials: result,
        totalSpace: totalSpace,
        industry: industryType,
        storageSpace: storageSpace
    };
}

export function calculateOptimalExportString(inputProduction, inputInventory) {
    const exportRate = (inputProduction + (inputInventory / 10)) * (-1);
    return exportRate.toFixed(2);
}

export function calculateBoostPurchaseRate(targetQuantity, currentQuantity, cyclesToReach = 10) {
    const needed = targetQuantity - currentQuantity;
    if (needed <= 0) return 0;
    return needed / (cyclesToReach * 10);
}

// ============================================================================
// EMPLOYEE MORALE/PERFORMANCE CALCULATIONS
// ============================================================================

export function calculateOptimalPartyCost(currentMorale, maxMorale = 100, perfMult = 1.0) {
    const a = currentMorale;
    const b = maxMorale;
    const k = perfMult;
    
    const term1 = (a * k - 10) ** 2;
    const term2 = 40 * b;
    const sqrtTerm = Math.sqrt(term1 + term2);
    
    const optimalCost = 500000 * (sqrtTerm - a * k - 10);
    
    return Math.max(500000, optimalCost);
}

export function calculatePerfMult(totalEmployees, internEmployees, corpFunds, isProfitable) {
    if (totalEmployees < 9) {
        return 1.002;
    }
    
    const internRatio = internEmployees / (totalEmployees - 1/9);
    const internMult = 0.002 * Math.min(1/9, internRatio) * 9;
    
    const penaltyMult = (corpFunds < 0 && !isProfitable) ? 0.001 : 0;
    
    return 1 + internMult - penaltyMult;
}

// ============================================================================
// DUMMY DIVISION UTILITIES
// ============================================================================

export const DUMMY_DIVISION_CONFIG = {
    industry: 'Restaurant',
    startingCost: 10e9,
    warehouseCost: 10e9,
    cities: ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'],
    valuationMultiplierBase: 1.1 ** 12
};

export function calculateDummyDivisionImpact(numDummyDivisions) {
    const config = DUMMY_DIVISION_CONFIG;
    const officesAndWarehousesPerDiv = config.cities.length * 2;
    const totalOfficesWarehouses = numDummyDivisions * officesAndWarehousesPerDiv;
    
    const valuationMultiplier = config.valuationMultiplierBase ** totalOfficesWarehouses;
    
    const divisionCost = config.startingCost * numDummyDivisions;
    const warehouseCost = config.warehouseCost * config.cities.length * numDummyDivisions;
    const totalCost = divisionCost + warehouseCost;
    
    return {
        numDummyDivisions,
        totalOfficesWarehouses,
        valuationMultiplier,
        totalCost,
        divisionCost,
        warehouseCost,
        officesAndWarehousesPerDiv,
        roi: valuationMultiplier / (totalCost / 1e12)
    };
}

export function calculateOptimalDummyDivisions(availableFunds, minReserve = 50e9, maxDummies = 5) {
    const config = DUMMY_DIVISION_CONFIG;
    const usableFunds = availableFunds - minReserve;
    
    if (usableFunds <= config.startingCost) return 0;
    
    const costPerDummy = config.startingCost + (config.warehouseCost * config.cities.length);
    const affordableDummies = Math.floor(usableFunds / costPerDummy);
    
    return Math.min(affordableDummies, maxDummies);
}

export function calculateDummyDivisionOfferBoost(baseValuation, numDummyDivisions, fundingRound = 1) {
    const impact = calculateDummyDivisionImpact(numDummyDivisions);
    const newValuation = baseValuation * impact.valuationMultiplier;
    
    const fundingRoundShares = [0.1, 0.35, 0.25, 0.2][fundingRound - 1] || 0.1;
    const fundingRoundMultiplier = [3, 2, 2, 1.5][fundingRound - 1] || 3;
    
    const baseOffer = baseValuation * fundingRoundShares * fundingRoundMultiplier;
    const boostedOffer = newValuation * fundingRoundShares * fundingRoundMultiplier;
    const offerIncrease = boostedOffer - baseOffer;
    
    return {
        baseValuation,
        newValuation,
        baseOffer,
        boostedOffer,
        offerIncrease,
        offerIncreasePercent: ((boostedOffer / baseOffer) - 1) * 100,
        totalCost: impact.totalCost,
        netBenefit: offerIncrease - impact.totalCost,
        isProfitable: offerIncrease > impact.totalCost
    };
}
