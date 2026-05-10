/**
 * Corporation-specific helper utilities
 * Separated from helpers.js to reduce RAM usage for non-corp scripts
 * Based on mathematical formulas from the Bitburner Corporation Strategy Guide
 */

import { log, getNsDataThroughFile, safeRemoveFile } from './helpers.js';

// ============================================================================
// CORP API HELPERS
// ============================================================================

/**
 * Check if Corporation API is available and accessible
 * @param {NS} ns 
 * @returns {boolean} True if API is available
 */
export function checkCorpAPI(ns) {
    if (!ns.corporation) {
        log(ns, "ERROR: Corporation API not available (requires SF3).", true, "error");
        return false;
    }
    return true;
}

/**
 * Corp data cache for reducing API calls
 */
const corpCache = {
    divisions: new Map(),
    corporations: new Map(),
    lastUpdate: 0,
    TTL: 5000 // 5 seconds
};

/**
 * Get cached division data with TTL
 * @param {NS} ns 
 * @param {string} divName - Division name
 * @returns {Promise<Object>} Division data
 */
export async function getCachedDivision(ns, divName) {
    const now = Date.now();
    
    // Check cache first
    if (corpCache.divisions.has(divName) && (now - corpCache.lastUpdate) < corpCache.TTL) {
        return corpCache.divisions.get(divName);
    }
    
    try {
        const division = await getNsDataThroughFile(ns, `ns.corporation.getDivision(ns.args[0])`, null, [divName]);
        corpCache.divisions.set(divName, division);
        corpCache.lastUpdate = now;
        return division;
    } catch (e) {
        log(ns, `ERROR: Failed to get division ${divName}: ${e.message || e}`, false, 'error');
        return null;
    }
}

/**
 * Clear Corp cache (useful after major changes)
 */
export function clearCorpCache() {
    corpCache.divisions.clear();
    corpCache.corporations.clear();
    corpCache.lastUpdate = 0;
}

// ============================================================================
// STATE MACHINE FOR CORP MANAGEMENT
// ============================================================================

export const CorpState = {
    INIT: "init",
    BUILDING: "building", 
    PRODUCING: "producing",
    SELLING: "selling",
    LIQUIDATING: "liquidating"
};

/**
 * Update Corp state based on current conditions
 * @param {NS} ns
 * @param {string} currentState - Current state
 * @param {Object} corp - Corp data
 * @returns {string} New state
 */
export function updateCorpState(ns, currentState, corp) {
    switch (currentState) {
        case CorpState.INIT:
            if (corp && corp.divisions && corp.divisions.length > 0) {
                return CorpState.BUILDING;
            }
            break;
            
        case CorpState.BUILDING:
            // Check if all core divisions have offices in all cities
            const coreDivisions = corp.divisions.filter(d => 
                ['Agriculture', 'Chemical', 'Tobacco'].includes(d.type)
            );
            const allOfficesBuilt = coreDivisions.every(div => 
                div.cities && div.cities.length === 6 // All cities
            );
            if (allOfficesBuilt && coreDivisions.length >= 2) {
                return CorpState.PRODUCING;
            }
            break;
            
        case CorpState.PRODUCING:
            // Check if we have products and positive revenue
            const hasProducts = corp.divisions.some(div => 
                div.products && div.products.length > 0
            );
            const isProfitable = corp.revenue > 0;
            if (hasProducts && isProfitable) {
                return CorpState.SELLING;
            }
            break;
            
        case CorpState.SELLING:
            // Could add conditions for liquidation here
            break;
            
        case CorpState.LIQUIDATING:
            // Terminal state - no transitions out
            break;
    }
    
    return currentState;
}

// ============================================================================
// PROFITABILITY METRICS
// ============================================================================

/**
 * Calculate ROI for a division
 * @param {Object} division - Division data
 * @returns {number} ROI ratio (revenue / investment)
 */
export function calculateDivisionROI(division) {
    if (!division || !division.revenue || !division.expenses) {
        return 0;
    }
    
    const profit = division.revenue - division.expenses;
    
    // Estimate investment based on division type and size
    let estimatedInvestment = 0;
    if (division.cities) {
        estimatedInvestment = division.cities.length * 50e9; // ~50B per city/warehouse
    }
    
    return estimatedInvestment > 0 ? profit / estimatedInvestment : 0;
}

/**
 * Calculate ROI for an office within a division
 * @param {Object} office - Office data
 * @returns {number} ROI ratio
 */
export function calculateOfficeROI(office) {
    if (!office || !office.revenue || !office.expenses) {
        return 0;
    }
    
    const profit = office.revenue - office.expenses;
    
    // Approximate investment: employee costs + overhead
    const employeeCount = office.employees ? office.employees.length : 0;
    const estimatedInvestment = employeeCount * 1e6; // ~1M per employee
    
    return estimatedInvestment > 0 ? profit / estimatedInvestment : 0;
}

/**
 * Get profitability summary for all divisions
 * @param {NS} ns
 * @param {Object} corp - Corp data
 * @returns {Array} Array of profitability metrics
 */
export function getProfitabilitySummary(ns, corp) {
    if (!corp || !corp.divisions) {
        return [];
    }
    
    return corp.divisions.map(division => ({
        name: division.name,
        type: division.type,
        revenue: division.revenue || 0,
        expenses: division.expenses || 0,
        profit: (division.revenue || 0) - (division.expenses || 0),
        roi: calculateDivisionROI(division),
        cityCount: division.cities ? division.cities.length : 0,
        productCount: division.products ? division.products.length : 0
    })).sort((a, b) => b.profit - a.profit);
}

// ============================================================================
// DEBUGGING UTILITIES
// ============================================================================

/**
 * Log Corp state to file for debugging
 * @param {NS} ns
 * @param {Object} corp - Corp data
 * @param {string} filename - Output file (default: /Temp/corp-debug.txt)
 */
export function logCorpState(ns, corp, filename = "/Temp/corp-debug.txt") {
    try {
        const debugData = {
            timestamp: new Date().toISOString(),
            corp: {
                name: corp.name,
                funds: corp.funds,
                revenue: corp.revenue,
                expenses: corp.expenses,
                divisions: corp.divisions.map(div => ({
                    name: div.name,
                    type: div.type,
                    revenue: div.revenue,
                    expenses: div.expenses,
                    cities: div.cities ? div.cities.length : 0,
                    products: div.products ? div.products.length : 0
                }))
            },
            profitability: getProfitabilitySummary(ns, corp)
        };
        
        ns.write(filename, JSON.stringify(debugData, null, 2), "w");
    } catch (e) {
        log(ns, `ERROR: Failed to log corp state: ${e.message || e}`, false, 'error');
    }
}

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

function calculateOptimalBoostMaterialsRecursive(industryType, storageSpace, excludeMaterials = [], depth = 0) {
    // Prevent infinite recursion with depth limit
    if (depth > 10) {
        log(ns, `WARN: Max recursion depth in boost calculation for ${industryType}`, false, 'warning');
        const safeResult = {};
        for (const material of ['Real Estate', 'Hardware', 'AI Cores', 'Robots']) {
            safeResult[material] = { quantity: 0, space: 0, percentage: 0 };
        }
        return {
            materials: safeResult,
            totalSpace: 0,
            industry: industryType,
            storageSpace,
            warning: 'Max depth exceeded - using fallback values'
        };
    }
    
    // Validate inputs
    if (storageSpace < 0) {
        log(null, `WARN: Negative storage space (${storageSpace}) - treating as 0`, false, 'warning');
        storageSpace = 0;
    }
    
    const allMaterials = ['Real Estate', 'Hardware', 'AI Cores', 'Robots'];
    const availableMaterials = allMaterials.filter(m => !excludeMaterials.includes(m));
    
    // Base case: No materials left to allocate
    if (availableMaterials.length === 0) {
        const safeResult = {};
        for (const material of allMaterials) {
            safeResult[material] = { quantity: 0, space: 0, percentage: 0 };
        }
        return {
            materials: safeResult,
            totalSpace: 0,
            industry: industryType,
            storageSpace,
            warning: 'No materials available for allocation'
        };
    }
    
    const coefficients = INDUSTRY_BOOST_COEFFICIENTS[industryType];
    const materials = availableMaterials;
    
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
        // Check for edge case: if all remaining materials would be excluded, return safe result
        const allMaterialsExcluded = [...excludeMaterials, ...stillNegative].length >= 4;
        if (allMaterialsExcluded) {
            // Return all zeros as safe fallback
            const safeResult = {};
            for (const material of ['Real Estate', 'Hardware', 'AI Cores', 'Robots']) {
                safeResult[material] = { quantity: 0, space: 0, percentage: 0 };
            }
            return { 
                materials: safeResult, 
                totalSpace: 0, 
                industry: industryType, 
                storageSpace,
                warning: 'All materials excluded due to constraints'
            };
        }
        
        return calculateOptimalBoostMaterialsRecursive(industryType, storageSpace, [...excludeMaterials, ...stillNegative], depth + 1);
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
// CENTRALIZED LOCK MECHANISM
// ============================================================================

export const CORP_LOCK_FILE = '/Temp/corp-lock.txt';

/**
 * Execute a function with a Corp operation lock to prevent race conditions
 * @param {NS} ns 
 * @param {Function} fn - Function to execute while holding lock
 * @param {number} timeout - Lock timeout in milliseconds (default: 30000)
 */
export async function withCorpLock(ns, fn, timeout = 30000) {
    const startTime = Date.now();
    
    // Wait for lock to be released with timeout
    while (ns.read(CORP_LOCK_FILE) === "1") {
        if (Date.now() - startTime > timeout) {
            // Force cleanup stale lock and proceed
            log(ns, `WARN: Corp lock timeout after ${timeout}ms - forcing cleanup`, false, 'warning');
            try {
                ns.rm(CORP_LOCK_FILE);
            } catch (e) {
                // Lock file might not exist or be locked
                log(ns, `ERROR: Failed to cleanup stale lock: ${e.message || e}`, false, 'error');
            }
            break;
        }
        await ns.sleep(100);
    }
    
    // Acquire lock with timestamp for debugging
    const lockData = JSON.stringify({ 
        timestamp: Date.now(), 
        script: ns.getScriptName(),
        pid: ns.pid 
    });
    ns.write(CORP_LOCK_FILE, lockData, "w");
    
    try {
        await fn();
    } catch (e) {
        log(ns, `ERROR in Corp lock (${ns.getScriptName()}): ${e.message || e}`, false, 'error');
        throw e; // Re-throw to avoid masking errors
    } finally {
        // Always release lock - no nested try-catch (Protected Zone compliance)
        if (ns.fileExists(CORP_LOCK_FILE)) {
            ns.rm(CORP_LOCK_FILE);
        }
    }
}

// ============================================================================
// BOOST MATERIAL CONSTANTS AND CALCULATIONS
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

// ============================================================================
// CORP API RATE LIMITING AND WRAPPERS (MOVED FROM HELPERS.JS)
// ============================================================================

export const CORP_API_DELAY = 200; // 200ms between Corp API calls to prevent throttling

/**
 * Generate unique temp file name with PID + timestamp + randomness
 * @param {NS} ns 
 * @param {string} prefix - File prefix (default: '/Temp/corp-')
 * @returns {string} Unique temp file path
 */
export function getTempFileName(ns, prefix = '/Temp/corp-') {
    return `${prefix}${ns.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.json`;
}

/**
 * Corp API wrapper with built-in rate limiting to prevent API throttling
 * Uses per-script rate limiting to avoid race conditions
 * @param {NS} ns 
 * @param {string} cmd - Command to execute
 * @param {Array} args - Arguments for the command
 * @param {string} tempFile - Optional temp file path
 * @returns {Promise<any>} Result of the command
 */
export async function cc(ns, cmd, args = [], tempFile = null) {
    // Per-script rate limiting to avoid race conditions
    const scriptId = ns.getScriptName() + '-' + ns.pid;
    const lastCallFile = `/Temp/${scriptId}-last-call.txt`;
    let lastCall = Number(ns.read(lastCallFile) || 0);
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall < CORP_API_DELAY) {
        await ns.sleep(CORP_API_DELAY - timeSinceLastCall);
    }

    // Update last call time
    ns.write(lastCallFile, now.toString(), 'w');
    
    // Generate unique temp file if not provided
    tempFile = tempFile || getTempFileName(ns);
    
    try {
        const result = await getNsDataThroughFile(ns, cmd, tempFile, args);
        await safeRemoveFile(ns, tempFile);
        return result;
    } catch (e) {
        await safeRemoveFile(ns, tempFile);
        throw e;
    }
}

// ============================================================================
// CORP DATA CACHING (MOVED FROM HELPERS.JS)
// ============================================================================

export const DEFAULT_CORP_DATA_PATH = '/Temp/corp-data.json';
export const MAX_CACHE_SIZE = 5 * 1024 * 1024; // 5MB limit

// Tiered TTL system for different data types
const CACHE_TTL = {
    'corp': 5000,      // 5 seconds for main corp data
    'division': 3000,   // 3 seconds for division data
    'office': 2000,     // 2 seconds for office data
    'product': 4000     // 4 seconds for product data
};

/**
 * Get cached Corp data with TTL validation
 * @param {NS} ns - Netscript instance
 * @param {string} path - Path to cached data file
 * @param {string} type - Cache type for TTL selection
 * @returns {object|null} Cached data or null if invalid/expired
 */
export function getCachedCorpData(ns, path = DEFAULT_CORP_DATA_PATH, type = 'corp') {
    if (!ns.fileExists(path)) return null;
    
    try {
        const data = JSON.parse(ns.read(path));
        const now = Date.now();
        const ttl = CACHE_TTL[type] || CACHE_TTL['corp'];
        
        if (!data.timestamp || (now - data.timestamp) > ttl) {
            return null; // Cache expired
        }
        
        return data.data;
    } catch (e) {
        log(ns, `WARN: Failed to parse cached Corp data from ${path}: ${e.message || e}`, false, 'warning');
        return null;
    }
}

/**
 * Safely write Corp data to cache with timestamp
 * @param {NS} ns - Netscript instance
 * @param {object} data - Data to cache
 * @param {string} path - Path to cache file
 * @returns {boolean} Success status
 */
export function setCachedCorpData(ns, data, path = DEFAULT_CORP_DATA_PATH) {
    try {
        const cacheData = {
            data: data,
            timestamp: Date.now()
        };
        
        const serialized = JSON.stringify(cacheData);
        
        if (serialized.length > MAX_CACHE_SIZE) {
            log(ns, `WARN: Corp data cache too large (${serialized.length} bytes), skipping write`, false, 'warning');
            return false;
        }
        
        ns.write(path, serialized, 'w');
        return true;
    } catch (e) {
        log(ns, `ERROR: Failed to write Corp data cache to ${path}: ${e.message || e}`, false, 'error');
        return false;
    }
}

/**
 * Handle Corp errors with consistent logging and recovery
 * @param {NS} ns - Netscript instance
 * @param {string} moduleName - Name of module where error occurred
 * @param {Error|string} error - Error object or message
 * @param {string} context - Additional context about the operation
 * @param {boolean} critical - Whether this is a critical error that should stop execution
 */
export function handleCorpError(ns, moduleName, error, context = '', critical = false) {
    const errorStr = error?.message || error || 'Unknown error';
    const logLevel = critical ? 'error' : 'warning';
    const contextStr = context ? ` (${context})` : '';
    
    log(ns, `${moduleName.toUpperCase()}${contextStr}: ${errorStr}`, true, logLevel);
    
    if (critical) {
        log(ns, `CRITICAL: ${moduleName} cannot continue. Exiting.`, true, 'error');
    }
}

/**
 * Safely execute Corp operation with error handling and fallback
 * @param {NS} ns - Netscript instance
 * @param {string} moduleName - Module name for error logging
 * @param {Function} operation - Async operation to execute
 * @param {string} context - Operation context
 * @param {*} fallback - Value to return if operation fails
 * @returns {Promise<*>} Result of operation or fallback
 */
export async function safeCorpOperation(ns, moduleName, operation, context = '', fallback = null) {
    try {
        return await operation();
    } catch (error) {
        handleCorpError(ns, moduleName, error, context);
        return fallback;
    }
}

/**
 * Get division by type from corporation data
 * @param {object} corp - Corporation object
 * @param {string} type - Division type to find
 * @returns {object|null} Division object or null if not found
 */
export function getDivisionByType(corp, type) {
    if (!corp || !corp.divisions) {
        throw new Error("Invalid Corporation object provided to helper.");
    }
    
    return corp.divisions.find(div => div.type === type) || null;
}

/**
 * Get Tobacco division from corporation data
 * @param {Corporation} corp - Corporation data object
 * @returns {Division|null} Tobacco division or null if not found
 */
export function getTobaccoDivision(corp) {
    if (!corp || !corp.divisions || !Array.isArray(corp.divisions)) {
        return null;
    }
    
    return corp.divisions.find(div => div.type === 'Tobacco') || null;
}

/**
 * Check if a division is valid and properly initialized
 * @param {object} division - Division object to validate
 * @returns {boolean} True if division is valid
 */
export function isDivisionValid(division) {
    return division && 
           typeof division === 'object' && 
           typeof division.name === 'string' && 
           typeof division.type === 'string' &&
           division.name !== 'undefined' &&
           division.type !== 'undefined';
}
