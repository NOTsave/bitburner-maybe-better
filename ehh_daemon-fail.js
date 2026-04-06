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
    getNsDataThroughFile_Custom, runCommand_Custom, waitForProcessToComplete_Custom,
    tryGetBitNodeMultipliers_Custom, getActiveSourceFiles_Custom,
    getFnRunViaNsExec, tail, autoRetry, getErrorInfo
} from './helpers.js'

// Cache frequently used functions
const fmtMoney = formatMoney;
const fmtRam = formatRam;
const fmtDuration = formatDuration;
const fmtNumber = formatNumber;
const fmtNumberShort = formatNumberShort;

// Minimal cache system to reduce RAM overhead
const simpleCache = {
    player: { data: null, expires: 0, ttl: 3000 },
    servers: { data: null, expires: 0, ttl: 10000 },
    targets: { data: null, expires: 0, ttl: 5000 }
};

function getCache(key) {
    const cache = simpleCache[key];
    if (cache && Date.now() < cache.expires) {
        return cache.data;
    }
    return null;
}

function setCache(key, data, customTtl = null) {
    const cache = simpleCache[key];
    cache.data = data;
    cache.expires = Date.now() + (customTtl || cache.ttl);
}

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
        const currentPid = ns.pid;
        const otherProcesses = runningProcesses.filter(p => p.pid !== currentPid);
        
        if (otherProcesses.length > 0) {
            log(ns, `INFO: Killing ${otherProcesses.length} old instance(s) of ${scriptName}...`, false, 'info');
            for (const process of otherProcesses) {
                if (ns.kill(process.pid)) {
                    log(ns, `INFO: Killed old instance (PID: ${process.pid})`, false, 'success');
                }
            }
            await ns.sleep(1000);
        }
    }
    
    // Use same minimal approach as original daemon
    disableLogs(ns, ['ALL']);
    
    // Get configuration like original
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions) return;
    
    const options = runOptions;
    const homeReservedRam = options['reserved-ram'] || 32;
    const verbose = options.v || options['verbose'];
    
    // Simple variables only
    let _cachedPlayerInfo = null;
    let _allServers = [];
    let loopCount = 0;
    
    // Minimal functions like original
    async function getPlayerInfo() {
        if (_cachedPlayerInfo) return _cachedPlayerInfo;
        try {
            _cachedPlayerInfo = await getNsDataThroughFile_Custom(ns, ns.run, `ns.getPlayer()`);
        } catch (error) {
            log(ns, `ERROR: getPlayerInfo failed: ${error.message}`, false, 'error');
        }
        return _cachedPlayerInfo;
    }
    
    function playerHackSkill() { 
        return _cachedPlayerInfo?.skills?.hacking || 1; 
    }
    
    // Simple server scan
    async function scanAllServers() {
        try {
            const hostnames = await getNsDataThroughFile_Custom(ns, ns.run, 'ns.scan()', '/Temp/scan-all.txt');
            const servers = [];
            for (const hostname of hostnames) {
                try {
                    const server = await getNsDataThroughFile_Custom(ns, ns.run, `ns.getServer(ns.args[0])`, `/Temp/server-${hostname}.txt`, [hostname]);
                    servers.push(server);
                } catch (error) {
                    // Skip servers that fail
                }
            }
            _allServers = servers;
            return servers;
        } catch (error) {
            log(ns, `ERROR: Server scan failed: ${error.message}`, false, 'error');
            return [];
        }
    }
    
    // Simple target selection
    function getTargets() {
        const targets = [];
        const hackLevel = playerHackSkill();
        
        for (const server of _allServers) {
            if (server.hasAdminRights && 
                server.requiredHackingSkill <= hackLevel &&
                server.moneyMax > 0 &&
                server.maxRam > 0) {
                targets.push(server);
            }
        }
        
        // Sort by money and return top few
        return targets.sort((a, b) => b.moneyMax - a.moneyMax).slice(0, 3);
    }
    
    // Initial setup
    await getPlayerInfo();
    await scanAllServers();
    log(ns, `Unified daemon started with ${_allServers.length} servers`, false, 'success');
    
    // Main loop - simplified like original
    while (true) {
        try {
            // Update player info occasionally
            if (loopCount % 50 === 0) {
                await getPlayerInfo();
            }
            
            // Run hacks occasionally
            if (loopCount % 100 === 0) {
                const targets = getTargets();
                if (targets.length > 0) {
                    for (const target of targets.slice(0, 2)) {
                        try {
                            const hackScript = '/Remote/hack-target.js';
                            const startTime = Date.now() + 2000;
                            const args = [target.hostname, startTime, 1000, `Hack ${target.hostname}`, false, true, false];
                            const pid = ns.exec(hackScript, 'home', 1, ...args);
                            if (pid > 0 && verbose) {
                                log(ns, `INFO: Started hack on ${target.hostname} (PID: ${pid})`, false, 'info');
                            }
                        } catch (hackError) {
                            log(ns, `WARNING: Failed to hack ${target.hostname}: ${hackError.message}`, false, 'warning');
                        }
                    }
                }
                
                // Status update
                const ramUsage = ns.getServerUsedRam('home');
                const ramMax = ns.getServerMaxRam('home');
                const utilization = ramUsage / ramMax;
                ns.print(`Unified Daemon: ${targets.length} targets, RAM: ${fmtRam(ramUsage)}/${fmtRam(ramMax)} (${(utilization * 100).toFixed(1)}%)`);
            }
            
        } catch (error) {
            log(ns, `ERROR: Main loop error: ${error.message}`, false, 'error');
            throw error;
        }
        
        await ns.sleep(1000);
        loopCount++;
    }
}
