import { log, disableLogs, getNsDataThroughFile, formatMoney, getCachedCorpData, calculateRamUsage, getRunningModules, getTobaccoDivision, isDivisionValid, DEFAULT_CORP_DATA_PATH, asleep } from './helpers.js'

const STATE_FILE = '/Temp/corp-state.txt';
const PROTECT_FILE = '/Temp/corp-protection.txt';

// Module configuration with intelligent self-termination
const MODULES = {
    hr: { 
        file: 'corp-hr.js', 
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
        file: 'corp-research.js', 
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
        file: 'corp-products.js', 
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
        file: 'corp-stocks.js', 
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
        file: 'corp-logistics.js',  // Fix #2: Corrected filename typo
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
    if (!ns.isRunning('corp-watchdog.js', 'home')) {
        log(ns, "INFO: Starting Watchdog (protection)...", true, 'success');
        const watchdogPid = await ns.run('corp-watchdog.js', 1);
        if (watchdogPid === 0) {
            log(ns, "⚠️ ERROR: Failed to start corp-watchdog.js! Check RAM.", true, 'error');
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
            const emergencyModules = ['corp-products.js', 'corp-research.js'];
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
                watchdogRunning: ns.isRunning('corp-watchdog.js', 'home'),
                fetcherRunning: ns.isRunning('corp-fetcher.js', 'home')
            };
            await ns.write(PROTECT_FILE, JSON.stringify(heartbeat), 'w');

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
                // Simplified profit margin calculation
                const profitPerShare = corp.sharePrice - (corp.issuedShares > 0 ? corp.shareSalePrice : 0);
                const margin = profitPerShare / corp.sharePrice;
                
                return {
                    shouldTerminate: margin >= condition.value,
                    reason: `Profit margin high enough (${(margin*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
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

function shouldModuleRun(ns, name, config, state, availableRAM) {
    // Always-on modules
    if (config.alwaysOn) return true;
    
    // Phase modules
    if (config.phase !== undefined) {
        return state.phase >= config.phase;
    }
    
    // Priority modules (when low on RAM)
    if (availableRAM < 5) {
        return config.priority <= 1;
    }
    
    return true;
}

// Remove duplicate functions - use imported ones from helpers.js

/** @param {NS} ns */
async function optimizeRAMUsage(ns) {
    const PROTECTED_MODULES = ["corp-manager.js", "corp-fetcher.js"];
    const processes = ns.ps("home");

    for (const proc of processes) {
        if (PROTECTED_MODULES.includes(proc.filename)) continue;
        
        // Only kill if the module is marked as 'low priority' in our config
        const moduleEntry = Object.values(MODULES).find(m => m.file === proc.filename);
        if (moduleEntry && moduleEntry.priority === 'low') {
            ns.print(`Terminating low-priority module: ${proc.filename}`);
            await ns.kill(proc.pid);
        }
    }
}

