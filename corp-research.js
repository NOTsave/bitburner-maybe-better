import { getNsDataThroughFile, log } from './helpers.js'

// Prioritní výzkumy pro maximální efektivitu
const RESEARCH_PRIORITY = [
    // --- Tobacco priority ---
    { name: 'Hi-Tech R&D Laboratory', cost: 500e9, priority: 1, divisions: ['Tobacco'] },
    { name: 'Market-TA.I', cost: 250e9, priority: 2, divisions: ['Tobacco'] },
    { name: 'Market-TA.II', cost: 1e12, priority: 3, divisions: ['Tobacco'] },
    { name: 'uBiome', cost: 1e12, priority: 4, divisions: ['Tobacco'] },
    { name: 'AutoBrew', cost: 250e9, priority: 5, divisions: ['Tobacco'] },
    { name: 'Go-Juice', cost: 100e9, priority: 6, divisions: ['Tobacco'] },
    { name: 'CPH4 Injections', cost: 750e9, priority: 7, divisions: ['Tobacco'] },
    
    // --- Agriculture priority ---
    { name: 'Smart Supply', cost: 50e9, priority: 1, divisions: ['Agriculture'] },
    { name: 'Smart Storage', cost: 100e9, priority: 2, divisions: ['Agriculture'] },
    { name: 'DreamSense', cost: 200e9, priority: 3, divisions: ['Agriculture'] },
    { name: 'Wilson', cost: 500e9, priority: 4, divisions: ['Agriculture'] }
];

// Konfigurace výzkumného modulu s samovypínáním
const RESEARCH_CONFIG = {
    checkInterval: 30000,        // Kontrola každých 30s
    minRPBuffer: 10000,         // Minimální rezerva RP
    fundReserve: 5e9,         // 5B rezerva
    maxSpendPercent: 0.3,       // Max 30% fondů na výzkum
    selfTerminate: true,           // Samovypínání po dokončení výzkumů
    completionConditions: [        // Podmínky pro samovypínání
        { type: 'research_complete', operator: 'all', divisions: ['Tobacco'] },  // Všechny Tobacco výzkumy hotové
        { type: 'research_complete', operator: 'all', divisions: ['Agriculture'] }, // Všechny Agri výzkumy hotové
        { type: 'research_points', operator: '<', value: 1000 }, // Málo RP na další výzkum
        { type: 'funds', operator: '<', value: 100e9 } // Málo peněz na výzkum
    ]
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `🔬 Spouštím Research Manager (samovypínání: ${RESEARCH_CONFIG.selfTerminate ? 'ZAPNUTO' : 'VYPNUTO'})`, false, 'info');
    
    let lastResearchTime = 0;
    
    while (true) {
        try {
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (!corp) { await ns.sleep(10000); continue; }

            const now = Date.now();
            
            // --- KONTROLA SAMOVYPÍNÁNÍ ---
            if (RESEARCH_CONFIG.selfTerminate) {
                const shouldTerminate = await checkSelfTerminationConditions(ns, corp);
                if (shouldTerminate.terminate) {
                    log(ns, `🎯 Research dokončen: ${shouldTerminate.reason}`, false, 'success');
                    return; // Ukonči modul
                }
            }
            
            // --- INTELIGENTNÍ SPRÁVA VÝZKUMU ---
            if (now - lastResearchTime > RESEARCH_CONFIG.checkInterval) {
                await manageResearch(ns, corp);
                lastResearchTime = now;
            }
            
        } catch (e) {
            log(ns, `🔬 Výzkumná chyba: ${e}`, false, 'error');
        }
        
        await ns.sleep(5000); // Výzkum stačí kontrolovat každých 5s
    }
}

async function checkSelfTerminationConditions(ns, corp) {
    if (!RESEARCH_CONFIG.completionConditions || RESEARCH_CONFIG.completionConditions.length === 0) {
        return { terminate: false, reason: 'Samovypínání vypnuto' };
    }
    
    try {
        for (const condition of RESEARCH_CONFIG.completionConditions) {
            const result = await evaluateResearchCondition(ns, corp, condition);
            if (result.shouldTerminate) {
                return result;
            }
        }
        
        return { terminate: false, reason: 'Pokračuji ve výzkumu' };
    } catch (e) {
        return { terminate: false, reason: `Chyba v kontrole: ${e}` };
    }
}

async function evaluateResearchCondition(ns, corp, condition) {
    try {
        switch (condition.type) {
            case 'research_complete':
                if (!condition.divisions) return { terminate: false, reason: 'Chybí divize v podmínce' };
                
                for (const divName of condition.divisions) {
                    const division = corp.divisions.find(d => d.type === divName);
                    if (!division) continue;
                    
                    const priorityResearch = RESEARCH_PRIORITY.filter(r => r.divisions.includes(divName));
                    const completedResearch = [];
                    
                    for (const res of priorityResearch) {
                        try {
                            const hasRes = await cc(ns, 'ns.corporation.hasResearched(ns.args[0], ns.args[1])', [division.name, res.name]);
                            if (hasRes) completedResearch.push(res);
                        } catch (_) {}
                    }
                    
                    const allComplete = completedResearch.length === priorityResearch.length;
                    if (allComplete) {
                        return {
                            terminate: true,
                            reason: `Všechny prioritní výzkumy v ${divName} hotovy (${completedResearch.length}/${priorityResearch.length})`
                        };
                    }
                }
                return { terminate: false, reason: 'Některé výzkumy ještě nejsou hotovy' };
                
            case 'research_points':
                const totalRP = corp.divisions.reduce((sum, div) => sum + (div.researchPoints || 0), 0);
                return {
                    terminate: totalRP < condition.value,
                    reason: `Málo výzkumných bodů (${totalRP} < ${condition.value})`
                };
                
            case 'funds':
                return {
                    terminate: corp.funds < condition.value,
                    reason: `Málo peněz na výzkum (${formatMoney(corp.funds)} < ${formatMoney(condition.value)})`
                };
                
            default:
                return { terminate: false, reason: 'Neznámá podmínka' };
        }
    } catch (e) {
        return { terminate: false, reason: `Chyba: ${e}` };
    }
}

async function manageResearch(ns, corp) {
    for (const div of corp.divisions) {
        try {
            const division = await cc(ns, 'ns.corporation.getDivision(ns.args[0])', [div.name]);
            if (!division) continue;
            
            const availableRP = division.researchPoints || 0;
            const affordableResearch = getAffordableResearch(ns, div.name, availableRP, corp.funds);
            
            if (affordableResearch.length === 0) continue;
            
            // Seřadit podle priority a koupit nejlepší možný
            affordableResearch.sort((a, b) => a.priority - b.priority);
            const targetResearch = affordableResearch[0];
            
            // Kontrola, jestli máme dostatek RP a peněz
            if (availableRP >= targetResearch.cost + RESEARCH_CONFIG.minRPBuffer && 
                corp.funds >= targetResearch.cost + RESEARCH_CONFIG.fundReserve) {
                
                await cc(ns, 'ns.corporation.research(ns.args[0], ns.args[1])', [div.name, targetResearch.name]);
                log(ns, `🔬 ${div.name}: ${targetResearch.name} (${formatMoney(targetResearch.cost)})`, false, 'success');
                
                // Malá pauza pro zpracování
                await ns.sleep(1000);
            }
            
        } catch (e) {
            log(ns, `💥 Výzkumná chyba (${div.name}): ${e}`, false, 'error');
        }
    }
}

function getAffordableResearch(ns, divisionName, availableRP, availableFunds) {
    return RESEARCH_PRIORITY
        .filter(research => 
            research.divisions.includes(divisionName) && // Správná divize
            research.cost <= availableRP * RESEARCH_CONFIG.maxSpendPercent && // Máme dostatek RP
            research.cost <= availableFunds * RESEARCH_CONFIG.maxSpendPercent // Máme dostatek peněz
        )
        .map(research => ({
            ...research,
            rpEfficiency: research.cost / availableRP, // Efektivita RP
            fundEfficiency: research.cost / availableFunds // Efektivita fondů
        }));
}

function formatMoney(amount) {
    if (amount >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return `$${amount.toFixed(2)}`;
}
