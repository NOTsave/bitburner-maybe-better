import { getNsDataThroughFile } from './helpers.js'

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    ns.tail();
    
    while (true) {
        try {
            const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
            if (!corp) {
                await ns.sleep(5000);
                continue;
            }
            
            const divisions = [];
            for (const div of corp.divisions) {
                try {
                    const divisionData = await getNsDataThroughFile(ns, `ns.corporation.getDivision("${div.name}")`);
                    divisions.push(divisionData);
                } catch (e) {
                    divisions.push(null);
                }
            }
            
            const data = { 
                corp, 
                divisions, 
                lastUpdate: Date.now(),
                timestamp: new Date().toISOString()
            };
            
            ns.write('/Temp/corp-data.txt', JSON.stringify(data), 'w');
            await ns.sleep(2000);
            
        } catch (e) {
            ns.print("Chyba fetcher: " + e);
            await ns.sleep(5000);
        }
    }
}
