import { getNsDataThroughFile, log, safelyWriteData, DEFAULT_CORP_DATA_PATH, asleep } from './helpers.js';

// RAM-dodging wrapper function
async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

/** @param {NS} ns **/
export async function main(ns) {
    ns.print('corp-fetcher.js starting...');
    
    // Prevent multiple instances - only one fetcher should write to corp-data.json
    const runningInstances = ns.ps('home').filter(p => p.filename === 'corp-fetcher.js');
    if (runningInstances.length > 1) {
        ns.print(`Another instance already running (PID: ${runningInstances[0].pid}), exiting.`);
        return;
    }
    
    const DATA_PATH = DEFAULT_CORP_DATA_PATH;

    // Check if corporation API is available and corporation exists before entering main loop
    const hasCorp = await cc(ns, 'ns.corporation.hasCorporation()');
    if (!hasCorp) {
        log(ns, 'INFO: No corporation owned yet. corp-fetcher.js exiting.', false, 'info');
        return;
    }

    while (true) {
        try {
            // Double-check corporation still exists (in case it was sold/liquidated)
            if (!await cc(ns, 'ns.corporation.hasCorporation()')) {
                log(ns, 'INFO: Corporation no longer exists. corp-fetcher.js exiting.', false, 'info');
                return;
            }
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (!corp || !corp.divisions || !Array.isArray(corp.divisions)) {
                await asleep(ns, 5000);
                continue;
            }
            const divisionsData = [];
            for (const div of corp.divisions) {
                // Handle both string names and division objects
                const name = typeof div === 'string' ? div : div?.name;
                if (!name || name === 'undefined') {
                    log(ns, `WARN: Skipping invalid division: ${JSON.stringify(div)}`, false, 'warning');
                    continue;
                }
                
                try {
                    // Fix #13: Explicit string cast
                    const divInfo = await cc(ns, `ns.corporation.getDivision(ns.args[0])`, [name]);
                    
                    // Fix #6: Safe city mapping with explicit fallbacks
                    const cities = (divInfo.cities || []).map(c => {
                        if (typeof c === 'string') return c;
                        if (c && typeof c === 'object' && typeof c.name === 'string') return c.name;
                        return "Unknown";
                    }).filter(city => city && city !== "Unknown");
                    
                    divisionsData.push({ 
                        ...divInfo, 
                        cities,
                        name: name,
                        type: divInfo.type || (typeof div === 'object' ? div.type : undefined) || 'Unknown'
                    });
                } catch (e) {
                    // Fix #4: Preserve error details for better debugging
                    divisionsData.push({ 
                        name: name, 
                        type: (typeof div === 'object' ? div.type : undefined) || 'Unknown',
                        cities: [],
                        researchPoints: 0,
                        products: [],
                        makesProducts: false,
                        error: true, 
                        msg: e.message || String(e),
                        timestamp: Date.now()
                    });
                    log(ns, `WARN: Failed to fetch division ${name}: ${e.message || e}`, false, 'warning');
                }
            }

            // Create clean corp summary with standardized structure
            const corpSummary = {
                name: corp.name,
                funds: corp.funds,
                revenue: corp.revenue,
                divisions: divisionsData,
                lastUpdate: Date.now(),
                timestamp: new Date().toISOString()
            };

            // Debug: log data size before write
            const dataSize = JSON.stringify(corpSummary).length;
            if (dataSize > 100000) {
                log(ns, `WARN: Corp data large: ${(dataSize/1024).toFixed(1)}KB`, false, 'warning');
            }

            // Atomic write: use improved safelyWriteData with checksum/timestamp
            const writeSuccess = await safelyWriteData(ns, DATA_PATH, corpSummary);
            if (!writeSuccess) {
                log(ns, `ERROR: Write failed - data size: ${dataSize} bytes`, false, 'error');
            }
            
        } catch (e) {
            // Single top-level catch handles all errors (fetch, division processing, write)
            log(ns, `ERROR: Corp-fetcher failed: ${e.message || e}`, false, 'error');
        }

        // Sync to corp tick for efficient updates (fallback to 2s sleep on error)
        try {
            // Pre-check: if corp was sold while we were processing, exit cleanly
            if (!await cc(ns, 'ns.corporation.hasCorporation()')) {
                log(ns, 'INFO: Corporation sold during processing. corp-fetcher.js exiting.', false, 'info');
                return;
            }
            await cc(ns, 'ns.corporation.nextUpdate()');
        } catch {
            await asleep(ns, 2000);
        }
    }
}
