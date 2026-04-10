import { log, disableLogs, getNsDataThroughFile, formatMoney, getCachedCorpData, calculateRamUsage, getRunningModules, getTobaccoDivision, isDivisionValid, DEFAULT_CORP_DATA_PATH, asleep } from './helpers.js'
import { calculateOptimalDummyDivisions, calculateDummyDivisionOfferBoost, DUMMY_DIVISION_CONFIG } from './corp-helpers.js'

const STATE_FILE = '/Temp/corp-state.txt';
const PROTECT_FILE = '/Temp/corp-protection.txt';

// Module configuration with intelligent self-termination
const MODULES = {
    hr: { 
        file: 'Corp/corp-hr.js', 
        ram: 2.5, 
        priority: 1, 
        alwaysOn: true,
        selfTerminate: true,          // Self-termination after task completion
        completionConditions: [        // Conditions for self-termination
            { type: 'funds', operator: '<', value: 500e9 }, // Less than 500B
            { type: 'office_size', operator: '>=', value: 50 },    // Offices >= 50
            { type: 'research_complete', operator: 'all', divisions: ['Tobacco'] }              // All research complete
        ]
    },
    research: { 
        file: 'Corp/corp-research.js', 
        ram: 3.0, 
        priority: 1, 
        alwaysOn: true,
        selfTerminate: true,
        completionConditions: [
            { type: 'research_points', operator: '<', value: 1000 },     // Low research points
            { type: 'research_complete', operator: 'all', divisions: ['Tobacco'] },               // All research complete
            { type: 'funds', operator: '<', value: 100e9 }            // Low funds
        ]
    },
    products: { 
        file: 'Corp/corp-products.js', 
        ram: 4.0, 
        priority: 2, 
        phase: 3,
        selfTerminate: true,
        completionConditions: [
            { type: 'dividend_rate', operator: '>=', value: 0.35 }, // Dividends >= 35%
            { type: 'shares_owned', operator: '>=', value: 0.8 },    // Own >= 80% of shares
            { type: 'profit_margin', operator: '>=', value: 0.2 },    // Profit margin >= 20%
            { type: 'total_value', operator: '>=', value: 10e12 }    // Total value >= 10T
        ]
    },
    stocks: { 
        file: 'Corp/corp-stocks.js', 
        ram: 2.0, 
        priority: 3, 
        phase: 5,
        selfTerminate: true,
        completionConditions: [
            { type: 'dividend_rate', operator: '>=', value: 0.35 }, // Dividends >= 35%
            { type: 'shares_owned', operator: '>=', value: 0.8 },    // Own >= 80% of shares
            { type: 'profit_margin', operator: '>=', value: 0.2 }    // Profit margin >= 20%
        ]
    },
    logistics: { 
        file: 'Corp/corp-logistics.js',  // Moved to Corp/ subdirectory
        ram: 2.5, 
        priority: 2, 
        phase: 2,
        selfTerminate: false,         // Logistics runs continuously
        completionConditions: []       // Never self-terminates
    }
};

// RAM management - maximum 15GB on home server
const MAX_RAM = 15;
const RESERVED_RAM = 2; // Reserve for system and manager

// Dynamic RAM calculation with race condition protection
async function getAvailableRam(ns) {
    const host = "home";
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
        try {
            const maxRam = ns.getServerMaxRam(host);
            const usedRam = ns.getServerUsedRam(host);
            const available = maxRam - usedRam;
            
            // Validate the result is reasonable
            if (available >= 0 && available <= maxRam) {
                return available;
            }
        } catch (e) {
            log(ns, `WARN: RAM calculation attempt ${attempts + 1} failed: ${e.message || e}`, false, 'warning');
        }
        
        attempts++;
        if (attempts < maxAttempts) {
            await ns.sleep(100); // Brief pause between attempts
        }
    }
    
    // Fallback to conservative estimate
    return Math.max(0, (ns.getServerMaxRam(host) || 0) - (ns.getServerUsedRam(host) || 0));
}

export async function main(ns) {
    disableLogs(ns, ['sleep', 'run', 'read', 'disableLog']);
    ns.tail();

    log(ns, `Starting Enterprise Manager (RAM limit: ${MAX_RAM}GB)`, true, 'success');
    
    // Fix #13: Heartbeat Validation - simplified and more efficient
    const rawData = ns.read('/Temp/corp-stats.txt');
    if (rawData && rawData.length > 0) {
        try {
            const stats = JSON.parse(rawData);
            // Simple validation - just check if we have valid revenue data
            if (stats.revenue !== undefined && typeof stats.revenue === 'number') {
                ns.print(`Heartbeat verified: Revenue ${formatMoney(stats.revenue)}`);
            } else {
                log(ns, "WARN: Invalid heartbeat data format", false, 'warning');
            }
        } catch (e) {
            log(ns, "WARN: Heartbeat data corrupted, skipping frame.", false, 'warning');
        }
    }
    
    // --- AUTOSTART WATCHDOG ---
    if (!ns.isRunning('Corp/corp-watchdog.js', 'home')) {
        log(ns, "INFO: Starting Watchdog (protection)...", true, 'success');
        const watchdogPid = await ns.run('Corp/corp-watchdog.js', 1);
        if (watchdogPid === 0) {
            log(ns, "⚠️ ERROR: Failed to start Corp/corp-watchdog.js! Check RAM.", true, 'error');
        } else {
            log(ns, "SUCCESS: Watchdog started successfully", true, 'success');
        }
    }

    // --- AUTOSTART DATA FETCHER ---
    if (!ns.isRunning('corp-fetcher.js', 'home')) {
        log(ns, "INFO: Starting Data Fetcher...", true, 'success');
        const fetcherPid = await ns.run('corp-fetcher.js', 1);
        if (fetcherPid === 0) {
            log(ns, "⚠️ ERROR: Failed to start corp-fetcher.js!", true, 'error');
        } else {
            log(ns, "SUCCESS: Data Fetcher started successfully", true, 'success');
        }
    }

    // --- WAITING FOR DATA ---
    let dataAvailable = false;
    let attempts = 0;
    const maxAttempts = 30; // Maximum 5 minutes waiting
    
    while (!dataAvailable && attempts < maxAttempts) {
        try {
            const raw = ns.read(DEFAULT_CORP_DATA_PATH);
            if (raw && raw.length > 2) {
                dataAvailable = true;
                log(ns, "SUCCESS: Fetcher data available", true, 'success');
                break;
            }
        } catch (e) {
            log(ns, `WARN: Error reading fetcher data: ${e.message || e}`, false, 'warning');
        }
        
        if (!dataAvailable) {
            attempts++;
            log(ns, `INFO: Waiting for data... (${attempts}/${maxAttempts})`, false, 'info');
            await ns.sleep(10000); // Waiting 10s
        }
    }
    
    if (!dataAvailable) {
        log(ns, "ERROR: Data not available even after 5 minutes! Starting in emergency mode...", true, 'error');
        await ns.sleep(5000);
        try {
            // Emergency mode - start only basic modules with dynamic RAM calculation
            const currentAvailableRAM = await getAvailableRam(ns);
            log(ns, `INFO: Emergency mode - Available RAM: ${currentAvailableRAM.toFixed(1)}GB`, false, 'info');
            const emergencyModules = ['Corp/corp-products.js', 'Corp/corp-research.js'];
            for (const modName of emergencyModules) {
                if (ns.isRunning(modName, 'home')) continue;
                const config = Object.values(MODULES).find(m => m.file === modName);
                if (config && currentAvailableRAM >= config.ram) {
                    const pid = await ns.run(modName, 1);
                    if (pid === 0) {
                        log(ns, `ERROR: Emergency start failed for ${modName} - insufficient RAM or script not found`, false, 'error');
                    } else {
                        log(ns, `WARNING: Emergency start: ${modName} (PID: ${pid})`, true, 'warning');
                    }
                } else {
                    log(ns, `INFO: Skipping ${modName} - insufficient RAM (${config?.ram || '?'}GB needed, ${currentAvailableRAM.toFixed(1)}GB available)`, false, 'info');
                }
            }
        } catch (e) {
            log(ns, `ERROR: Emergency mode failed: ${e.message || e}`, true, 'error');
        }
    }

    while (true) {
        try {
            let state = { phase: 0 };
            try {
                state = JSON.parse(ns.read(STATE_FILE) || '{"phase":0}');
            } catch (e) {
                log(ns, `WARN: Error parsing state file, using default: ${e.message || e}`, false, 'warning');
                state = { phase: 0, productNum: 1 };
            }

            // --- HEARTBEAT PRO WATCHDOG ---
            const heartbeat = { 
                pid: ns.pid, 
                lastCheck: Date.now(),
                modules: getRunningModules(ns),
                ramUsage: calculateRamUsage(ns),
                timestamp: Date.now(),
                watchdogRunning: ns.isRunning('Corp/corp-watchdog.js', 'home'),
                fetcherRunning: ns.isRunning('corp-fetcher.js', 'home')
            };
            await ns.write(PROTECT_FILE, JSON.stringify(heartbeat), 'w');

            // --- PHASE ADVANCEMENT WITH RP THRESHOLDS ---
            // Check every 60 seconds if we can advance to next phase (per corp strategy guide)
            if (!state.lastPhaseCheck || Date.now() - state.lastPhaseCheck > 60000) {
                state = await maybeAdvancePhase(ns, state);
                state.lastPhaseCheck = Date.now();
            }
            
            // --- CORE DIVISION CREATION (Agriculture -> Tobacco) ---
            // Automatically creates required divisions if they don't exist
            await ensureCoreDivisions(ns, corp);
            
            // --- DUMMY DIVISION CREATION (Investment Round Boost) ---
            // Creates cheap Restaurant divisions to boost valuation before investment rounds
            // Formula: Valuation *= (1.1^12)^NumberOfOfficesAndWarehouses
            await maybeCreateDummyDivisions(ns, state, corp);
            
            // --- INTELLIGENT MODULE MANAGEMENT WITH SELF-TERMINATION ---
            await manageModulesWithSelfTermination(ns, state);
            
            // --- PRIORITY RAM MANAGEMENT ---
            const usedRAM = calculateRamUsage(ns);
            if (usedRAM > MAX_RAM - RESERVED_RAM) {
                log(ns, `⚠️ RAM usage: ${usedRAM}/${MAX_RAM}GB - optimizing modules`, false, 'warning');
                await optimizeRAMUsage(ns, state);
            }

        } catch (e) {
            log(ns, `ERROR: Critical error in manager: ${e.message || e}`, true, 'error');
        }
        
        await asleep(ns, 5000); // Manager runs every 5s
    }
}

async function manageModulesWithSelfTermination(ns, state) {
    const availableRAM = await getAvailableRam(ns);
    
    for (const [name, config] of Object.entries(MODULES)) {
        const shouldRun = shouldModuleRun(ns, name, config, state, availableRAM);
        const isRunning = ns.isRunning(config.file, 'home');
        
        if (shouldRun && !isRunning) {
            if (availableRAM >= config.ram) {
                log(ns, `INFO: Starting module: ${name} (${config.ram}GB RAM)`, false, 'info');
                await ns.run(config.file, 1);
                await ns.sleep(1000); // Allow time to start
            } else {
                log(ns, `WARNING: Insufficient RAM for ${name} (${config.ram}GB needed, ${availableRAM.toFixed(1)}GB available)`, false, 'warning');
            }
        } else if (!shouldRun && isRunning && !config.alwaysOn) {
            log(ns, `INFO: Intelligently stopping module: ${name}`, false, 'info');
            await terminateModule(ns, config.file, name);
        } else if (isRunning && config.selfTerminate) {
            // Check self-termination conditions
            const shouldTerminate = await checkSelfTerminationConditions(ns, name, config);
            if (shouldTerminate) {
                log(ns, `SUCCESS: Module ${name} completed task - self-terminating`, false, 'success');
                await terminateModule(ns, config.file, name);
            }
        }
    }
}

async function checkSelfTerminationConditions(ns, moduleName, config) {
    if (!config.completionConditions || config.completionConditions.length === 0) {
        return false; // Fix #7: Standardized Return Types (Boolean only)
    }
    
    try {
        const corp = await getCachedCorpData(ns); // Fix #4: Use cached data
        if (!corp) return false;
        
        for (const condition of config.completionConditions) {
            const result = await evaluateCondition(ns, corp, condition);
            if (result.shouldTerminate) {
                log(ns, `🎯 ${moduleName}: ${result.reason}`, false, 'info');
                return true; // Fix #7: Return boolean
            }
        }
        
        return false; // Fix #7: Return boolean
    } catch (e) {
        log(ns, `Error in ${moduleName} termination check: ${e}`, false, 'error'); // Fix #6: No silent catch
        return false; // Fix #7: Return boolean
    }
}

async function evaluateCondition(ns, corp, condition) {
    try {
        switch (condition.type) {
            case 'funds':
                return {
                    shouldTerminate: corp.funds < condition.value,
                    reason: `Funds below limit (${formatMoney(corp.funds)} < ${formatMoney(condition.value)})`
                };
                
            case 'research_points':
                // Fix #1: Dynamic Division Matching
                const division = getTobaccoDivision(corp);
                const rp = division?.researchPoints || 0;
                return {
                    shouldTerminate: rp < condition.value,
                    reason: `Low research points (${rp} < ${condition.value})`
                };
                
            case 'research_complete':
                // Fix #1: Dynamic Division Matching
                const tobacco = getTobaccoDivision(corp);
                if (!tobacco) return { shouldTerminate: false, reason: 'Tobacco division not found' };
                
                const priorityResearch = ['Hi-Tech R&D Laboratory', 'Market-TA.I', 'Market-TA.II', 'uBiome'];
                const completedResearch = [];
                
                for (const res of priorityResearch) {
                    try {
                        const hasRes = await getNsDataThroughFile(ns, `ns.corporation.hasResearched(ns.args[0], ns.args[1])`, null, [tobacco.name, res]);
                        if (hasRes) completedResearch.push(res);
                    } catch (e) {
                        log(ns, `Error checking research ${res}: ${e}`, false, 'error'); // Fix #6: No silent catch
                    }
                }
                
                const allComplete = completedResearch.length === priorityResearch.length;
                return {
                    shouldTerminate: allComplete,
                    reason: `All priority research complete (${completedResearch.length}/${priorityResearch.length})`
                };
                
            case 'office_size':
                // Fix #1: Dynamic Division Matching
                const tobaccoDiv = getTobaccoDivision(corp);
                if (!tobaccoDiv) return { shouldTerminate: false, reason: 'Tobacco division not found' };
                
                let maxSize = 0;
                for (const city of tobaccoDiv.cities) {
                    maxSize = Math.max(maxSize, city.size || 0);
                }
                
                return {
                    shouldTerminate: maxSize >= condition.value,
                    reason: `Offices large enough (${maxSize} >= ${condition.value})`
                };
                
            case 'dividend_rate':
                return {
                    shouldTerminate: corp.dividendRate >= condition.value,
                    reason: `Dividends high enough (${(corp.dividendRate*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'shares_owned':
                const totalShares = corp.totalShares || 0;
                const maxShares = corp.numShares || 0;
                const ownedPercent = totalShares / maxShares;
                
                return {
                    shouldTerminate: ownedPercent >= condition.value,
                    reason: `Sufficient shares owned (${(ownedPercent*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'profit_margin':
                // API LIMITATION: CorporationInfo has no cost basis property (shareSalePrice does not exist).
                // Only sharePrice (current price), numShares (shares owned), and issuedShares are available.
                // Without purchase price history, profit margin cannot be calculated.
                // Alternative: Use 'shares_owned' or 'total_value' conditions for similar behavior.
                // See: https://raw.githubusercontent.com/bitburner-official/bitburner-src/dev/markdown/bitburner.corporationinfo.md
                return {
                    shouldTerminate: false,
                    reason: 'profit_margin disabled - API lacks cost basis data (CorporationInfo has sharePrice but no shareSalePrice/purchase history)'
                };
                
            case 'total_value':
                const totalValue = corp.sharePrice * corp.totalShares;
                return {
                    shouldTerminate: totalValue >= condition.value,
                    reason: `Total share value high enough (${formatMoney(totalValue)} >= ${formatMoney(condition.value)})`
                };
                
            default:
                return { shouldTerminate: false, reason: 'Unknown condition' };
        }
    } catch (e) {
        return { shouldTerminate: false, reason: `Error: ${e}` };
    }
}

async function terminateModule(ns, filename, moduleName) {
    try {
        const scripts = ns.ps('home').filter(s => s.filename === filename);
        for (const script of scripts) {
            await ns.kill(script.pid);
            log(ns, `INFO: Terminating ${moduleName} (PID: ${script.pid})`, false, 'info');
        }
        await ns.sleep(2000); // Allow time for clean termination
    } catch (e) {
        log(ns, `ERROR: Error terminating ${moduleName}: ${e.message || e}`, false, 'error');
    }
}

// Core division configuration - auto-created in early phases
const CORE_DIVISIONS = {
    Agriculture: {
        name: 'GreenGrow',
        priority: 1,  // Create first
        minPhase: 0,
        costEstimate: 150e9  // ~50b to create + ~100b for expansions
    },
    Chemical: {
        name: 'ChemSynth',
        priority: 2,  // Create second - vertical integration with Agriculture
        minPhase: 1,
        costEstimate: 200e9  // ~70b to create + ~130b for expansions
    },
    Tobacco: {
        name: 'SmokeWorks',
        priority: 3,  // Create third - needs more funds, high-value products
        minPhase: 2,
        costEstimate: 300e9  // ~150b to create + ~150b for expansions
    }
};

const CITIES = ['Sector-12', 'Aevum', 'Chongqing', 'New Tokyo', 'Ishima', 'Volhaven'];

// RP thresholds per corp strategy guide
const RP_THRESHOLDS = {
    1: { Agriculture: 55, Chemical: 0 },        // Round 1: Agri 55 RP before production
    2: { Agriculture: 700, Chemical: 390 },       // Round 2: Agri 700, Chem 390 RP
    3: { Agriculture: 1000, Chemical: 500 }       // Round 3+: Minimum RP stockpile
};

/** Check if we have enough RP to advance to next phase
 * @param {NS} ns 
 * @param {Object} corp - Cached corp data
 * @param {number} targetPhase - Phase we want to advance to
 * @returns {Promise<boolean>} True if RP thresholds met */
async function checkRPThresholds(ns, corp, targetPhase) {
    const thresholds = RP_THRESHOLDS[targetPhase];
    if (!thresholds) return true; // No threshold defined for this phase
    
    for (const [divType, requiredRP] of Object.entries(thresholds)) {
        if (requiredRP === 0) continue; // No requirement
        
        const division = corp.divisions.find(d => d.type === divType);
        if (!division) {
            log(ns, `RP Check: ${divType} division not found (required: ${requiredRP} RP)`, false, 'warning');
            return false; // Division doesn't exist yet
        }
        
        const currentRP = division.researchPoints || 0;
        if (currentRP < requiredRP) {
            log(ns, `RP Check: ${division.name} has ${currentRP.toLocaleString()} RP, need ${requiredRP.toLocaleString()} to advance to phase ${targetPhase}`, false, 'info');
            return false;
        }
    }
    
    return true;
}

/** Ensure core divisions (Agriculture, Tobacco) exist
 * Auto-creates them in order when funds are available
 * @param {NS} ns
 * @param {Object} corp - Corporation data
 */
async function ensureCoreDivisions(ns, corp) {
    if (!corp || !corp.divisions) return;
    
    const funds = corp.funds || 0;
    const existingTypes = corp.divisions.map(d => d.type);
    
    // Sort by priority and process each core division
    const sortedDivisions = Object.entries(CORE_DIVISIONS)
        .sort((a, b) => a[1].priority - b[1].priority);
    
    for (const [industry, config] of sortedDivisions) {
        // Skip if already exists
        if (existingTypes.includes(industry)) continue;
        
        // Check if we have enough funds
        if (funds < config.costEstimate) {
            log(ns, `INFO: Waiting for funds to create ${industry} division (need ~${formatMoney(config.costEstimate)}, have ${formatMoney(funds)})`, false, 'info');
            return; // Don't check lower priority divisions until higher ones are created
        }
        
        try {
            // Create the division
            log(ns, `SUCCESS: Creating ${industry} division "${config.name}"...`, true, 'success');
            const success = await getNsDataThroughFile(ns, 
                'ns.corporation.expandIndustry(ns.args[0], ns.args[1])', 
                null, 
                [industry, config.name]
            );
            
            if (!success) {
                log(ns, `WARNING: Failed to create ${industry} division - may already exist or insufficient funds`, false, 'warning');
                continue;
            }
            
            log(ns, `SUCCESS: ${industry} division "${config.name}" created!`, true, 'success');
            await asleep(ns, 2000);
            
            // Expand to all cities
            for (const city of CITIES) {
                if (city === 'Sector-12') continue; // Already exists
                
                try {
                    await getNsDataThroughFile(ns, 
                        'ns.corporation.expandCity(ns.args[0], ns.args[1])', 
                        null, 
                        [config.name, city]
                    );
                    
                    // Purchase warehouse for this city
                    await getNsDataThroughFile(ns, 
                        'ns.corporation.purchaseWarehouse(ns.args[0], ns.args[1])', 
                        null, 
                        [config.name, city]
                    );
                    
                    // Enable smart supply
                    await getNsDataThroughFile(ns, 
                        'ns.corporation.setSmartSupply(ns.args[0], ns.args[1], true)', 
                        null, 
                        [config.name, city]
                    );
                    
                    log(ns, `SUCCESS: ${config.name} expanded to ${city} with warehouse`, false, 'success');
                    await asleep(ns, 1000);
                } catch (e) {
                    log(ns, `WARN: Failed to expand ${config.name} to ${city}: ${e.message || e}`, false, 'warning');
                }
            }
            
            log(ns, `SUCCESS: ${industry} division "${config.name}" fully set up in all cities!`, true, 'success');
            
        } catch (e) {
            log(ns, `ERROR: Failed to create ${industry} division: ${e.message || e}`, false, 'error');
        }
    }
}

/** Advance to next phase if RP thresholds are met
 * @param {NS} ns 
 * @param {Object} state - Current state
 * @returns {Promise<Object>} Updated state */
async function maybeAdvancePhase(ns, state) {
    const corp = await getCachedCorpData(ns);
    if (!corp) return state;
    
    const nextPhase = state.phase + 1;
    const canAdvance = await checkRPThresholds(ns, corp, nextPhase);
    
    if (canAdvance && nextPhase <= 5) {
        state.phase = nextPhase;
        // Reset dummy division flag for new phase (allow creating more dummies for next round)
        state.dummyDivisionsCreated = false;
        await persistState(ns, state, 'advancePhase');
        log(ns, `SUCCESS: Advanced to phase ${nextPhase}`, true, 'success');
    }
    
    return state;
}

// ============================================================================
// DUMMY DIVISION MANAGEMENT
// Creates cheap Restaurant divisions to boost investment offer valuation
// Formula: Valuation *= (1.1^12)^NumberOfOfficesAndWarehouses
// ============================================================================

/** 
 * Manage dummy divisions for investment round boost
 * Creates Restaurant divisions (cheapest at 10B) with 6 cities + warehouses only
 * No employees, no upgrades, no boost materials - pure valuation boost
 * 
 * @param {NS} ns
 * @param {Object} corp - Corporation data
 * @param {number} fundingRound - Current funding round (1-4)
 */
async function manageDummyDivisions(ns, corp, fundingRound = 1) {
    // Skip if we don't have enough funds or not in right phase
    if (corp.funds < 100e9) return; // Need at least 100B to consider
    
    // Check current dummy division count
    const existingDummies = corp.divisions.filter(d => d.type === DUMMY_DIVISION_CONFIG.industry).length;
    const maxDummies = 3; // Cap at 3 to prevent excessive spending
    
    if (existingDummies >= maxDummies) return;
    
    // Calculate optimal number of new dummy divisions
    const desiredNewDummies = calculateOptimalDummyDivisions(corp.funds, 100e9, maxDummies - existingDummies);
    if (desiredNewDummies <= 0) return;
    
    // Calculate impact before creating
    const boost = calculateDummyDivisionOfferBoost(corp.valuation || 1e12, desiredNewDummies, fundingRound);
    
    if (!boost.isProfitable) {
        log(ns, `INFO: Dummy divisions not profitable yet (net benefit: ${formatMoney(boost.netBenefit)})`, false, 'info');
        return;
    }
    
    log(ns, `SUCCESS: Creating ${desiredNewDummies} dummy divisions to boost offer by ${boost.offerIncreasePercent.toFixed(1)}%`, true, 'success');
    
    // Create dummy divisions
    for (let i = 0; i < desiredNewDummies; i++) {
        const divName = `Dummy-${Date.now() % 10000}-${i}`;
        
        try {
            // 1. Create Restaurant division (10B)
            await getNsDataThroughFile(ns, 'ns.corporation.expandIndustry(ns.args[0], ns.args[1])', null, 
                [DUMMY_DIVISION_CONFIG.industry, divName]);
            log(ns, `SUCCESS: Created dummy division ${divName}`, false, 'success');
            await asleep(ns, 2000);
            
            // 2. Expand to all 6 cities
            for (const city of DUMMY_DIVISION_CONFIG.cities) {
                try {
                    // Skip Sector-12 (already exists)
                    if (city === 'Sector-12') continue;
                    
                    await getNsDataThroughFile(ns, 'ns.corporation.expandCity(ns.args[0], ns.args[1])', null, 
                        [divName, city]);
                    log(ns, `INFO: Expanded ${divName} to ${city}`, false, 'info');
                    await asleep(ns, 1000);
                } catch (e) {
                    // City might already exist, continue
                    continue;
                }
            }
            
            // 3. Buy warehouses in each city (10B each)
            for (const city of DUMMY_DIVISION_CONFIG.cities) {
                try {
                    await getNsDataThroughFile(ns, 'ns.corporation.purchaseWarehouse(ns.args[0], ns.args[1])', null, 
                        [divName, city]);
                    log(ns, `INFO: Warehouse ${divName}/${city}`, false, 'info');
                    await asleep(ns, 1000);
                } catch (e) {
                    // Warehouse might already exist, continue
                    continue;
                }
            }
            
            // 4. Enable Smart Supply (cheap unlock, makes it hands-off)
            const hasSmartSupply = await getNsDataThroughFile(ns, 'ns.corporation.hasUnlock(ns.args[0])', null, ['Smart Supply']);
            if (hasSmartSupply) {
                for (const city of DUMMY_DIVISION_CONFIG.cities) {
                    try {
                        await getNsDataThroughFile(ns, 'ns.corporation.setSmartSupply(ns.args[0], ns.args[1], true)', null, 
                            [divName, city]);
                    } catch (e) {
                        // May fail if no warehouse or other issue, continue
                        continue;
                    }
                }
            }
            
            log(ns, `SUCCESS: Dummy division ${divName} ready (valuation boost active)`, false, 'success');
            
        } catch (e) {
            log(ns, `ERROR: Failed to create dummy division ${divName}: ${e.message || e}`, false, 'error');
            // Continue to next dummy even if this one failed
            continue;
        }
    }
}

/**
 * Check if we should create dummy divisions based on investment round timing
 * Call this before accepting investment offers for maximum benefit
 * 
 * @param {NS} ns
 * @param {Object} state - Current corp state
 * @param {Object} corp - Corporation data
 */
async function maybeCreateDummyDivisions(ns, state, corp) {
    // Only create dummies in phases 2+ (when we're preparing for investment rounds)
    if (state.phase < 2) return;
    
    // Check if we've already created dummies this phase
    if (state.dummyDivisionsCreated) return;
    
    // Detect funding round from corporation state
    // Simple heuristic: check if we have pending investment offer
    const hasOffer = corp.investmentOffers && corp.investmentOffers.length > 0;
    const fundingRound = hasOffer ? (corp.investmentOffers[0]?.round || 1) : state.phase;
    
    // Create dummy divisions
    await manageDummyDivisions(ns, corp, fundingRound);
    
    // Mark as created for this phase (reset when advancing phase)
    state.dummyDivisionsCreated = true;
    await persistState(ns, state, 'dummyDivisions');
}

function shouldModuleRun(ns, name, config, state, availableRAM) {
    // Always-on modules
    if (config.alwaysOn) return true;

    // Phase modules - check if we've reached the required phase
    if (config.phase !== undefined) {
        return state.phase >= config.phase;
    }

    // Priority modules (when low on RAM)
    if (availableRAM < 5) {
        return config.priority <= 1;
    }

    return true;
}

/** Centralized state persistence to prevent race conditions
 * @param {NS} ns
 * @param {Object} state - State to persist
 * @param {string} context - Context for debug logging
 * @returns {Promise<boolean>} Success status */
async function persistState(ns, state, context = '') {
    try {
        await ns.write(STATE_FILE, JSON.stringify(state), 'w');
        if (context) {
            log(ns, `DEBUG: State persisted (${context}): phase=${state.phase}`, false, 'debug');
        }
        return true;
    } catch (e) {
        log(ns, `ERROR: Failed to persist state: ${e.message || e}`, false, 'error');
        return false;
    }
}

// Remove duplicate functions - use imported ones from helpers.js

/** @param {NS} ns */
async function optimizeRAMUsage(ns) {
    const PROTECTED_MODULES = ["corp-manager.js", "corp-fetcher.js"];
    const processes = ns.ps("home");

    for (const proc of processes) {
        if (PROTECTED_MODULES.includes(proc.filename)) continue;
        
        // Only kill if the module is marked as low priority (priority >= 3) in our config
        const moduleEntry = Object.values(MODULES).find(m => m.file === proc.filename);
        if (moduleEntry && moduleEntry.priority >= 3) {
            ns.print(`Terminating low-priority module: ${proc.filename} (priority: ${moduleEntry.priority})`);
            await ns.kill(proc.pid);
        }
    }
}

