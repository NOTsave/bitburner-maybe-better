import { getNsDataThroughFile, log, safelyWriteData, asleep, safeRemoveFile, formatMoney } from './helpers.js';
import { withCorpLock, CORP_LOCK_FILE, cc, DEFAULT_CORP_DATA_PATH } from './corp-helpers.js';


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
            // Validate Corp structure
            if (!corp || !corp.divisions || !Array.isArray(corp.divisions)) {
                log(ns, "WARN: Invalid Corp data received. Retrying...", false, 'warning');
                await asleep(ns, 5000);
                continue;
            }
            
            // ✅ BATCH ALL DIVISIONS INTO 1 TEMP SCRIPT
            const divisionNames = corp.divisions.map(div => {
                const name = typeof div === 'string' ? div : div?.name;
                return name && name !== 'undefined' ? name : null;
            }).filter(name => name !== null);
            
            if (divisionNames.length === 0) {
                log(ns, 'WARN: No valid division names found', false, 'warning');
                await asleep(ns, 5000);
                continue;
            }
            
            const divisionsData = await cc(
                ns,
                `ns.args[0].map(name => ns.corporation.getDivision(name))`,
                `/Temp/all-divisions-${Date.now()}.json`,
                [divisionNames]
            );
            
            // Process divisions with validation
            const processedDivisions = [];
            for (let i = 0; i < divisionNames.length; i++) {
                const name = divisionNames[i];
                const divInfo = divisionsData[i];
                if (!divInfo) {
                    log(ns, `WARN: Failed to fetch division ${name}`, false, 'warning');
                    continue;
                }
                
                // Validate division data
                if (!divInfo || !divInfo.name) {
                    log(ns, `WARN: Invalid division data for ${name}: ${JSON.stringify(divInfo)}`, false, 'warning');
                    continue;
                }
                
                // Safe city mapping with explicit fallbacks
                const cities = (divInfo.cities || []).map(c => {
                    if (typeof c === 'string') return c;
                    if (c && typeof c === 'object' && typeof c.name === 'string') return c.name;
                    return "Unknown";
                }).filter(city => city && city !== "Unknown");
                
                processedDivisions.push({ 
                    ...divInfo, 
                    cities,
                    name: name,
                    type: divInfo.type || corp.divisions.find(d => 
                        (typeof d === 'string' ? d : d?.name) === name
                    )?.type || 'Unknown'
                });
            }

            // Create clean corp summary with standardized structure
            const corpSummary = {
                name: corp.name,
                funds: corp.funds,
                revenue: corp.revenue,
                divisions: processedDivisions,
                lastUpdate: Date.now(),
                timestamp: new Date().toISOString()
            };

            // Periodic Corp state logging for debugging (every ~60 seconds)
            if (Date.now() % 60000 < 1000) {
                log(ns, `Corp State: ${formatMoney(corp.funds)} | Revenue: ${formatMoney(corp.revenue)}/s | Divisions: ${corp.divisions.length}`, false, 'info');
            }

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

        // Sync to corp tick for efficient updates (always sleep to prevent infinite loop)
        try {
            // Pre-check: if corp was sold while we were processing, exit cleanly
            if (!await cc(ns, 'ns.corporation.hasCorporation()')) {
                log(ns, 'INFO: Corporation sold during processing. corp-fetcher.js exiting.', false, 'info');
                return;
            }
            await cc(ns, 'ns.corporation.nextUpdate()');
        } catch (nextUpdateError) {
            log(ns, `WARN: nextUpdate() failed: ${nextUpdateError.message || nextUpdateError}`, false, 'warning');
            await asleep(ns, 2000);
        }
        // ✅ THROTTLE: Always sleep, even on success - prevents infinite loop
        await asleep(ns, 1000);
    }
}
