import { getNsDataThroughFile, log, formatMoney, getCachedCorpData } from './helpers.js'

// Priority research for maximum efficiency
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

// Research module configuration with self-termination
const RESEARCH_CONFIG = {
    checkInterval: 30000,        // Check every 30s
    minRPBuffer: 10000,         // Minimum RP reserve
    fundReserve: 5e9,         // 5B reserve
    maxSpendPercent: 0.3,       // Max 30% of funds on research
    selfTerminate: true,           // Self-termination after research completion
    completionConditions: [        // Conditions for self-termination
        { type: 'research_complete', operator: 'all', divisions: ['Tobacco'] },  // All Tobacco research complete
        { type: 'research_complete', operator: 'all', divisions: ['Agriculture'] }, // All Agri research complete
        { type: 'research_points', operator: '<', value: 1000 }, // Low RP for more research
        { type: 'funds', operator: '<', value: 100e9 } // Low funds for research
    ]
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `🔬 Starting Research Manager (self-termination: ${RESEARCH_CONFIG.selfTerminate ? 'ENABLED' : 'DISABLED'})`, false, 'info');
    
    let lastResearchTime = 0;
    
    while (true) {
        try {
            const corp = await getCachedCorpData(ns); // Fix #4: Use cached data
            if (!corp) { await ns.sleep(10000); continue; }

            const now = Date.now();
            
            // --- SELF-TERMINATION CHECK ---
            if (RESEARCH_CONFIG.selfTerminate) {
                const shouldExit = await checkSelfTerminationConditions(ns, corp);
                if (shouldExit) {
                    return; // Exit module
                }
            }
            
            // --- INTELLIGENT RESEARCH MANAGEMENT ---
            if (now - lastResearchTime > RESEARCH_CONFIG.checkInterval) {
                await manageResearch(ns, corp);
                lastResearchTime = now;
            }
            
        } catch (e) {
            log(ns, `🔬 Research error: ${e}`, false, 'error');
        }
        
        await ns.sleep(5000); // Research check every 5s
    }
}

async function checkSelfTerminationConditions(ns, corp) {
    if (!RESEARCH_CONFIG.completionConditions || RESEARCH_CONFIG.completionConditions.length === 0) {
        return false;
    }
    
    try {
        for (const condition of RESEARCH_CONFIG.completionConditions) {
            const result = await evaluateResearchCondition(ns, corp, condition);
            if (result.shouldTerminate) {
                log(ns, `Research complete: ${result.reason}`, false, 'success');
                return true;
            }
        }
        
        return false;
    } catch (e) {
        log(ns, `Error in research termination check: ${e}`, false, 'error');
        return false;
    }
}

async function evaluateResearchCondition(ns, corp, condition) {
    try {
        switch (condition.type) {
            case 'research_complete':
                if (!condition.divisions) return { terminate: false, reason: 'Missing divisions in condition' };
                
                for (const divName of condition.divisions) {
                    // Fix #1: Dynamic Division Matching - use type instead of name
                    const division = corp.divisions.find(d => d.type === divName);
                    if (!division) continue;
                    
                    const priorityResearch = RESEARCH_PRIORITY.filter(r => r.divisions.includes(divName));
                    const completedResearch = [];
                    
                    for (const res of priorityResearch) {
                        try {
                            const hasRes = await cc(ns, 'ns.corporation.hasResearched(ns.args[0], ns.args[1])', [division.name, res.name]);
                            if (hasRes) completedResearch.push(res);
                        } catch (e) {
                            log(ns, `Error checking research ${res.name}: ${e}`, false, 'error'); // Fix #6: No silent catch
                        }
                    }
                    
                    const allComplete = completedResearch.length === priorityResearch.length;
                    if (allComplete) {
                        return {
                            terminate: true,
                            reason: `All priority research complete in ${divName} (${completedResearch.length}/${priorityResearch.length})`
                        };
                    }
                }
                return { terminate: false, reason: 'Some research not yet complete' };
                
            case 'research_points':
                const totalRP = corp.divisions.reduce((sum, div) => sum + (div.researchPoints || 0), 0);
                return {
                    terminate: totalRP < condition.value,
                    reason: `Low research points (${totalRP} < ${condition.value})`
                };
                
            case 'funds':
                return {
                    terminate: corp.funds < condition.value,
                    reason: `Low funds for research (${formatMoney(corp.funds)} < ${formatMoney(condition.value)})`
                };
                
            default:
                return { terminate: false, reason: 'Unknown condition' };
        }
    } catch (e) {
        return { terminate: false, reason: `Error: ${e}` };
    }
}

async function manageResearch(ns, corp) {
    for (const div of corp.divisions) {
        try {
            // Use cached division data instead of fresh API call
            const division = div; // Already available from cached corp data
            if (!division) continue;
            
            const availableRP = division.researchPoints || 0;
            // Fix: Use division.type instead of division.name for proper research filtering
            const affordableResearch = getAffordableResearch(ns, division.type, availableRP, corp.funds);
            
            if (affordableResearch.length === 0) continue;
            
            // Sort by priority and buy best available
            affordableResearch.sort((a, b) => a.priority - b.priority);
            const targetResearch = affordableResearch[0];
            
            // Check if we have enough RP (research costs RP only, not funds)
            if (availableRP >= targetResearch.cost + RESEARCH_CONFIG.minRPBuffer) {
                
                await cc(ns, 'ns.corporation.research(ns.args[0], ns.args[1])', [div.name, targetResearch.name]);
                log(ns, `🔬 ${div.name}: ${targetResearch.name} (${formatMoney(targetResearch.cost)})`, false, 'success');
                
                // Small pause for processing
                await ns.sleep(1000);
            }
            
        } catch (e) {
            log(ns, `💥 Research error (${div.name}): ${e}`, false, 'error');
        }
    }
}

function getAffordableResearch(ns, divisionType, availableRP, availableFunds) {
    return RESEARCH_PRIORITY
        .filter(research => 
            research.divisions.includes(divisionType) && // Match by division type
            research.cost <= availableRP * RESEARCH_CONFIG.maxSpendPercent // Have enough RP
            // Note: Research only costs RP, not corporate funds
        )
        .map(research => ({
            ...research,
            rpEfficiency: research.cost / availableRP, // RP efficiency
            fundEfficiency: research.cost / availableFunds // Fund efficiency (for info only)
        }));
}
