import { getNsDataThroughFile, log, safelyWriteData, DEFAULT_CORP_DATA_PATH } from './helpers.js';

/** @param {NS} ns **/
export async function main(ns) {
    const DATA_PATH = DEFAULT_CORP_DATA_PATH;
    
    while (true) {
        try {
            const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
            if (!corp || !corp.divisions || !Array.isArray(corp.divisions)) {
                await ns.sleep(5000);
                continue;
            }
            const divisionsData = [];
            for (const div of corp.divisions) {
                try {
                    // Fix #13: Explicit string cast
                    const name = String(div.name);
                    const divInfo = await getNsDataThroughFile(ns, `ns.corporation.getDivision(ns.args[0])`, null, [name]);
                    
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
                        type: divInfo.type || div.type || 'Unknown'
                    });
                } catch (e) {
                    // Fix #4: Preserve error details for better debugging
                    divisionsData.push({ 
                        name: String(div.name), 
                        type: div.type || 'Unknown',
                        cities: [],
                        researchPoints: 0,
                        products: [],
                        makesProducts: false,
                        error: true, 
                        msg: e.message || String(e),
                        timestamp: Date.now()
                    });
                    log(ns, `WARN: Failed to fetch division ${div.name}: ${e.message || e}`, false, 'warning');
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

            // Atomic write: use improved safelyWriteData with checksum/timestamp
            await safelyWriteData(ns, DATA_PATH, corpSummary);
            
        } catch (e) {
            // Single top-level catch handles all errors (fetch, division processing, write)
            log(ns, `ERROR: Corp-fetcher failed: ${e.message || e}`, false, 'error');
        }
        await ns.sleep(2000);
    }
}
