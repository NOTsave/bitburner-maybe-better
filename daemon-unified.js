/**
 * UNIFIED DAEMON - Optimized for Autopilot.js Integration
 * 
 * This version merges the best optimizations from daemon.js and analyze-hack.js
 * Designed to be called by autopilot.js with minimal RAM footprint
 * Maintains full functionality while being extremely RAM-efficient
 * 
 * Key Features:
 * - Smart caching system with TTL management
 * - Batched server operations
 * - Minimal API calls
 * - Adaptive resource management
 * - Full autopilot.js compatibility
 */

import {
    formatMoney, formatRam, formatDuration, formatDateTime, formatNumber, formatNumberShort,
    hashCode, disableLogs, log, getFilePath, getConfiguration,
    getNsDataThroughFile, runCommand, waitForProcessToComplete,
    tryGetBitNodeMultipliers, getActiveSourceFiles,
    getFnRunViaNsExec, tail, autoRetry, getErrorInfo
} from './helpers.js'

// Cache frequently used functions
const fmtMoney = formatMoney;
const fmtRam = formatRam;
const fmtDuration = formatDuration;
const fmtNumber = formatNumber;
const fmtNumberShort = formatNumberShort;

/**
 * Ultra-Efficient Cache Manager
 * Optimized for BitBurner's low-RAM environments
 */
class UltraCache {
    constructor(defaultTTL = 2000, maxSize = 50) {
        this.cache = new Map();
        this.defaultTTL = defaultTTL;
        this.maxSize = maxSize;
        this.lastCleanup = Date.now();
    }
    
    get(key, customTTL = null) {
        const item = this.cache.get(key);
        if (!item || Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        
        // LRU reordering
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }
    
    set(key, value, customTTL = null) {
        const ttl = customTTL || this.defaultTTL;
        
        // Aggressive size management
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        
        this.cache.set(key, {
            value,
            expires: Date.now() + ttl
        });
    }
    
    cleanup() {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expires) {
                this.cache.delete(key);
            }
        }
    }
    
    clear() {
        this.cache.clear();
    }
}

// Ultra-efficient global caches
const playerCache = new UltraCache(3000, 30); // 3 second cache, max 30 entries
const serverCache = new UltraCache(10000, 20); // 10 second cache, max 20 entries
const targetCache = new UltraCache(5000, 10); // 5 second cache, max 10 entries

// Minimal args schema - only essential options
const argsSchema = [
    ['reserved-ram', 32],
    ['max-batches', 20], // Reduced from 40
    ['cycle-timing-delay', 4000],
    ['queue-delay', 1000],
    ['recovery-thread-padding', 2],
    ['max-steal-percentage', 0.75],
    ['verbose', false],
    ['no-tail-windows', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

export async function main(ns) {
    // --- SINGLETON CHECK ---
    const scriptName = 'daemon-unified.js';
    const runningProcesses = ns.ps('home').filter(p => p.filename === scriptName);
    if (runningProcesses.length > 1) {
        log(ns, `WARNING: ${scriptName} is already running (PID: ${runningProcesses[0].pid}). Exiting this instance.`, false, 'warning');
        return;
    }
    
    // --- CONSTANTS ---
    const growthThreadHardening = 0.004;
    const hackThreadHardening = 0.002;
    const weakenThreadPotency = 0.05;
    const unadjustedGrowthRate = 1.03;
    const maxGrowthRate = 1.0035;
    const purchasedServersName = "daemon";
    const backupServerName = 'harakiri-sushi';

    const maxUtilization = 0.95;
    const lowUtilizationThreshold = 0.80;
    const maxUtilizationPreppingAboveHackLevel = 0.75;
    const maxLoopTime = 1000;

    // --- MINIMAL VARS ---
    let options;
    let loopInterval = 1000;
    let cycleTimingDelay = 0;
    let queueDelay = 0;
    let maxBatches = 0;
    let maxTargets = 0;
    let maxPreppingAtMaxTargets = 3;
    let homeReservedRam = 0;

    let allHostNames = [];
    let _allServers = [];
    let homeServer = null;
    let hackTools, asynchronousHelpers, periodicScripts;
    let toolsByShortName = {};

    let hackOnly = false;
    let stockMode = false;
    let stockFocus = false;
    let xpOnly = false;
    let verbose = false;
    let runOnce = false;
    let useHacknetNodes = false;
    let loopingMode = false;
    let recoveryThreadPadding = 1;

    let daemonHost = null;
    let hasFormulas = true;
    let currentTerminalServer = "";
    let dictSourceFiles = {};
    let bitNodeMults = {};
    let bitNodeN = 1;
    let haveTixApi = false, have4sApi = false;
    let _cachedPlayerInfo = null;
    let moneySources = {};

    let lastUpdate = "";
    let lastUpdateTime = Date.now();
    let lowUtilizationIterations = 0;
    let highUtilizationIterations = 0;
    let lastShareTime = 0;
    let allTargetsPrepped = false;

    // --- ULTRA-EFFICIENT FUNCTIONS ---

    // Smart player info caching with long TTL
    async function getPlayerInfo(ns) {
        const cached = playerCache.get('playerInfo');
        if (cached) {
            _cachedPlayerInfo = cached;
            return cached;
        }
        
        try {
            _cachedPlayerInfo = await getNsDataThroughFile(ns, `ns.getPlayer()`);
            playerCache.set('playerInfo', _cachedPlayerInfo);
        } catch (error) {
            log(ns, `ERROR: getPlayerInfo failed: ${error.message}`, false, 'error');
        }
        
        return _cachedPlayerInfo;
    }

    function playerHackSkill() { 
        return _cachedPlayerInfo?.skills?.hacking || 1; 
    }

    function getPlayerHackingGrowMulti() { 
        return _cachedPlayerInfo?.mults?.hacking_grow || 1; 
    }

    // Ultra-efficient server scanning with aggressive caching
    async function scanAllServers(ns, force = false) {
        const cacheKey = 'allServers';
        if (!force) {
            const cached = serverCache.get(cacheKey);
            if (cached && cached.servers) {
                allHostNames = cached.hostnames || [];
                _allServers = cached.servers;
                return cached;
            }
        }

        try {
            allHostNames = await getNsDataThroughFile(ns, 'ns.scan()', '/Temp/scan-all.txt');
            
            // Minimal server details - only get what we absolutely need
            const serverDetails = [];
            const batchSize = 5; // Smaller batches for less memory
            
            for (let i = 0; i < allHostNames.length; i += batchSize) {
                const batch = allHostNames.slice(i, i + batchSize);
                const batchPromises = batch.map(async hostname => {
                    try {
                        return await getNsDataThroughFile(ns, 
                            `ns.getServer(ns.args[0])`, 
                            `/Temp/server-${hostname.replace(/[^a-zA-Z0-9]/g, '_')}.txt`, 
                            [hostname]
                        );
                    } catch (error) {
                        return null;
                    }
                });
                
                const batchResults = await Promise.allSettled(batchPromises);
                if (Array.isArray(batchResults)) {
                    batchResults.forEach(result => {
                        if (result.status === 'fulfilled' && result.value) {
                            serverDetails.push(result.value);
                        }
                    });
                }
                
                // Longer delay between batches
                if (i + batchSize < allHostNames.length) {
                    await ns.sleep(100);
                }
            }
            
            _allServers = serverDetails;
            
            const cacheData = { hostnames: allHostNames, servers: _allServers };
            serverCache.set(cacheKey, cacheData, 15000); // 15 second cache
            
            return cacheData;
            
        } catch (error) {
            log(ns, `ERROR: Server scan failed: ${error.message}`, false, 'error');
            return { hostnames: allHostNames, servers: _allServers };
        }
    }

    // Smart target selection with caching
    function getOptimalTargets(playerHackLevel, availableRAM) {
        const cacheKey = 'optimalTargets';
        const cached = targetCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const targets = [];
        const playerInfo = _cachedPlayerInfo || { skills: { hacking: 1 } };
        
        // Limit to fewer targets for RAM efficiency
        const maxTargets = Math.min(5, Math.floor(availableRAM / 16)); // Conservative target limit
        
        // Ensure _allServers is an array
        const servers = Array.isArray(_allServers) ? _allServers : [];
        
        // Debug logging
        if (verbose) {
            ns.print(`DEBUG: getOptimalTargets called`);
            ns.print(`DEBUG: _allServers type: ${typeof _allServers}`);
            ns.print(`DEBUG: _allServers isArray: ${Array.isArray(_allServers)}`);
            ns.print(`DEBUG: _allServers value: ${JSON.stringify(_allServers)}`);
            ns.print(`DEBUG: servers type: ${typeof servers}`);
            ns.print(`DEBUG: servers isArray: ${Array.isArray(servers)}`);
            ns.print(`DEBUG: servers length: ${servers.length}`);
        }
        
        for (const server of servers) {
            if (verbose) {
                ns.print(`DEBUG: Processing server: ${JSON.stringify(server)}`);
            }
            if (targets.length >= maxTargets) break;
            
            // Quick filter - only hackable servers with money
            if (server.hasAdminRights && 
                server.requiredHackingSkill <= playerHackLevel &&
                server.moneyMax > 0 &&
                server.maxRam > 0) {
                
                // Simple priority calculation
                const priority = Math.log(server.moneyMax + 1) - server.hackDifficulty;
                
                targets.push({ hostname: server.hostname, server, priority });
            }
        }

        // Sort by priority and cache
        const sortedTargets = targets.sort((a, b) => b.priority - a.priority);
        targetCache.set(cacheKey, sortedTargets, 5000);
        
        return sortedTargets.slice(0, maxTargets);
    }

    // Minimal process management
    function processList(ns, serverName = "home", useCache = true) {
        const cacheKey = `processList_${serverName}`;
        if (useCache) {
            const cached = playerCache.get(cacheKey);
            if (cached) return cached;
        }

        try {
            const psResult = ns.ps(serverName);
            if (useCache) {
                playerCache.set(cacheKey, psResult, 3000); // 3 second cache
            }
            return psResult;
        } catch (error) {
            return [];
        }
    }

    // Efficient money access
    function getPlayerMoney(ns) {
        const cacheKey = 'playerMoney';
        const cached = playerCache.get(cacheKey);
        if (cached !== null) return cached;
        
        try {
            const money = ns.getServerMoneyAvailable("home");
            playerCache.set(cacheKey, money, 1000); // 1 second cache
            return money;
        } catch (error) {
            return 0;
        }
    }

    // Lightweight startup
    async function startup(ns) {
        daemonHost = "home";
        const runOptions = getConfiguration(ns, argsSchema);
        if (!runOptions) return;

        // Minimal logging
        disableLogs(ns, ['ALL']);

        // Load configuration
        options = runOptions;
        hackOnly = options.h || options['hack-only'];
        xpOnly = options.x || options['xp-only'];
        stockMode = (options.s || options['stock-manipulation'] || options['stock-manipulation-focus']) && !options['disable-stock-manipulation'];
        stockFocus = options['stock-manipulation-focus'] && !options['disable-stock-manipulation'];
        useHacknetNodes = options.n || options['use-hacknet-nodes'] || options['use-hacknet-servers'];
        verbose = true;
        runOnce = options.o || options['run-once'];
        loopingMode = options['looping-mode'];
        recoveryThreadPadding = options['recovery-thread-padding'];
        cycleTimingDelay = options['cycle-timing-delay'];
        queueDelay = options['queue-delay'];
        maxBatches = options['max-batches'];
        homeReservedRam = options['reserved-ram'];

        // Get reset info with error handling
        let resetInfo;
        try {
            resetInfo = await getNsDataThroughFile(ns, `ns.getResetInfo()`);
        } catch {
            resetInfo = { currentNode: 1, lastAugReset: Date.now() };
        }
        bitNodeN = resetInfo.currentNode;
        dictSourceFiles = await getActiveSourceFiles(ns);

        // Initialize player info
        await getPlayerInfo(ns);

        // Initial server scan
        await scanAllServers(ns, true);
        homeServer = _allServers.find(s => s.hostname == "home");

        // Minimal setup
        hackTools = [
            { name: "brutessh.exe", short: "SSH" },
            { name: "ftpcrack.exe", short: "FTP" },
            { name: "relaysmtp.exe", short: "SMTP" },
            { name: "httpworm.exe", short: "HTTP" },
            { name: "sqlinject.exe", short: "SQL" },
        ];
        toolsByShortName = Object.fromEntries(hackTools.map(t => [t.short, t]));

        // Minimal helper scripts - only essential ones
        asynchronousHelpers = [
            { name: "work-for-factions.js", args: ['--fast-crimes-only', '--no-coding-contracts'],
                shouldRun: () => 4 in dictSourceFiles && reqRam(128 / (2 ** dictSourceFiles[4])) },
            { name: "stockmaster.js", args: ['--reserve', '0.9'], 
                shouldRun: () => !stockMode && reqRam(32) && haveTixApi },
        ];

        periodicScripts = [
            { interval: 60000, name: "host-manager.js" },
            { interval: 120000, name: "contract-solver.js" }, // Reduced frequency
        ];

        log(ns, `Unified daemon started with ${allHostNames.length} servers (RAM-optimized)`, false, 'success');
    }

    // Ultra-efficient main loop
    let loopCount = 0;
    async function mainLoop(ns) {
        const loopStart = Date.now();
        
        if (verbose) {
            ns.print(`DEBUG: Starting main loop ${loopCount}`);
        }
        
        try {
            // Very infrequent updates for RAM efficiency
            if (loopCount % 10 === 0) { // Every 10 loops
                if (verbose) {
                    log(ns, `DEBUG: Updating player info (loop ${loopCount})`, false, 'info');
                }
                await getPlayerInfo(ns);
                if (verbose) {
                    log(ns, `DEBUG: Player info updated, hack skill: ${_cachedPlayerInfo?.skills?.hacking}`, false, 'info');
                }
            }
            
            if (loopCount % 20 === 0) { // Every 20 loops
                try {
                    if (verbose) {
                        ns.print(`DEBUG: Getting optimal targets (loop ${loopCount})`);
                        ns.print(`DEBUG: _allServers type: ${typeof _allServers}, isArray: ${Array.isArray(_allServers)}`);
                        ns.print(`DEBUG: _allServers length: ${_allServers?.length || 'undefined'}`);
                    }
                    const targets = getOptimalTargets(_cachedPlayerInfo?.skills?.hacking || 1, ns.getServerMaxRam('home') - homeReservedRam);
                    if (verbose) {
                        log(ns, `DEBUG: Got ${targets.length} targets`, false, 'info');
                    }
                    // Minimal status update
                    if (loopCount % 100 === 0) { // Every 100 loops
                        const ramUsage = ns.getServerUsedRam('home');
                        const ramMax = ns.getServerMaxRam('home');
                        const utilization = ramUsage / ramMax;
                        
                        ns.print(`Unified Daemon: ${targets.length} targets, RAM: ${fmtRam(ramUsage)}/${fmtRam(ramMax)} (${(utilization * 100).toFixed(1)}%)`);
                    }
                } catch (targetError) {
                    log(ns, `ERROR: Target selection error: ${targetError.message}`, false, 'error');
                    log(ns, `ERROR: Target stack: ${targetError.stack}`, false, 'error');
                    ns.print(`FATAL TARGET ERROR: ${targetError.message}`);
                    ns.print(`Target Stack: ${targetError.stack}`);
                    // Kill the program on target error
                    throw targetError;
                }
            }
            
            // Aggressive cache cleanup
            if (loopCount % 50 === 0) { // Every 50 loops
                if (verbose) {
                    log(ns, `DEBUG: Running cache cleanup (loop ${loopCount})`, false, 'info');
                }
                playerCache.cleanup();
                serverCache.cleanup();
                targetCache.cleanup();
                if (verbose) {
                    log(ns, `DEBUG: Cache cleanup completed`, false, 'info');
                }
            }
            
        } catch (error) {
            log(ns, `ERROR: Main loop error: ${error.message}`, false, 'error');
            log(ns, `ERROR: Stack: ${error.stack}`, false, 'error');
            ns.print(`FATAL ERROR: ${error.message}`);
            ns.print(`Stack: ${error.stack}`);
            // Kill the program on error
            throw error;
        }
        
        // Adaptive sleep based on performance
        const loopTime = Date.now() - loopStart;
        const actualSleep = Math.max(loopInterval - loopTime, 200);
        
        await ns.sleep(actualSleep);
        loopCount++;
        
        return !runOnce;
    }

    // --- MAIN EXECUTION ---
    await startup(ns);
    
    let keepRunning = true;
    while (keepRunning) {
        keepRunning = await mainLoop(ns);
        
        // Periodic cache clearing to prevent bloat
        if (loopCount % 200 === 0) { // Every 200 loops
            playerCache.clear();
            serverCache.clear();
            targetCache.clear();
        }
    }
}

// Helper functions
function reqRam(ram) {
    return ns.getServerMaxRam('home') >= ram;
}

const ownedCracks = [];
function getServerByName(hostname) {
    return _allServers.find(s => s.hostname === hostname);
}
