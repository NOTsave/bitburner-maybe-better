/** @param {NS} ns **/
export async function main(ns) {
    ns.print('corp-fetcher-test.js starting - NO TEMP SCRIPTS VERSION');
    
    // Prevent multiple instances
    const runningInstances = ns.ps('home').filter(p => p.filename === 'corp-fetcher-test.js');
    if (runningInstances.length > 1) {
        ns.print(`Another instance already running (PID: ${runningInstances[0].pid}), exiting.`);
        return;
    }
    
    const DATA_PATH = '/Temp/corp-data.json';
    
    // Check if corporation exists
    if (!ns.corporation.hasCorporation()) {
        ns.print('INFO: No corporation owned yet. corp-fetcher-test.js exiting.');
        return;
    }

    let tickCounter = 0;
    const UPDATE_INTERVAL = 5; // Update every 5 ticks (very infrequent)

    while (true) {
        try {
            tickCounter++;
            
            // Only update on specified intervals
            if (tickCounter % UPDATE_INTERVAL !== 0) {
                await ns.corporation.nextUpdate();
                continue;
            }
            
            ns.print(`Updating corp data (tick ${tickCounter})...`);
            
            // Direct API calls - NO TEMP SCRIPTS
            const corp = ns.corporation.getCorporation();
            if (!corp || !corp.divisions || !Array.isArray(corp.divisions)) {
                await ns.asleep(5000);
                continue;
            }
            
            // Simple division data - no complex processing
            const divisionsData = [];
            for (const div of corp.divisions) {
                const name = typeof div === 'string' ? div : div?.name;
                if (!name || name === 'undefined') {
                    continue;
                }
                
                try {
                    // Direct API call - no temp scripts
                    const divInfo = ns.corporation.getDivision(name);
                    divisionsData.push({ 
                        name: name,
                        type: divInfo.type || 'Unknown',
                        cities: divInfo.cities || [],
                        researchPoints: divInfo.researchPoints || 0
                    });
                } catch (e) {
                    divisionsData.push({ 
                        name: name, 
                        type: 'Unknown',
                        cities: [],
                        researchPoints: 0,
                        error: true
                    });
                }
            }

            // Simple corp summary
            const corpSummary = {
                name: corp.name,
                funds: corp.funds,
                revenue: corp.revenue,
                divisions: divisionsData,
                lastUpdate: Date.now()
            };

            // Direct write - no temp scripts
            const serialized = JSON.stringify(corpSummary);
            ns.write(DATA_PATH, serialized, 'w');
            
            ns.print(`SUCCESS: Updated corp data with ${divisionsData.length} divisions`);
            
        } catch (e) {
            ns.print(`ERROR: Corp-fetcher-test failed: ${e.message || e}`);
        }

        // Wait for next tick
        try {
            await ns.corporation.nextUpdate();
        } catch {
            await ns.asleep(2000);
        }
    }
}
