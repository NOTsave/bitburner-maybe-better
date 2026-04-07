import { getNsDataThroughFile, log, formatMoney, getCachedCorpData, handleCorpError, safeCorpOperation, getTobaccoDivision, isDivisionValid } from './helpers.js'

// Fix #6: Global Constant Definitions
const CORP_CONFIG = {
    PARTY_COST: 5e6,         // $5M for office parties
    ENERGY_COST_PER_UNIT: 1000, // $1K per energy point
    ENERGY_THRESHOLD: 70,    // Refill energy below 70%
    MORALE_COOLDOWN: 30000,  // 30s for tea/coffee
    PARTY_COOLDOWN: 60000    // 60s for parties
};

// HR Module Configuration
const HR_CONFIG = {
    teaInterval: 30000,      // Tea interval every 30s
    partyInterval: 60000,    // Party interval every 60s
    hireThreshold: 1e12,    // Hire at 1T+ funds
    expandThreshold: 5e12,  // Expand at 5T+ funds
    targetOfficeSize: 30,    // Target office size
    moraleThreshold: 0.7     // Minimum morale for actions
};

const STAFF = {
    agri: {
        Operations: 6, Engineer: 6, Business: 3, 
        Management: 3, 'Research & Development': 2
    },
    tobacco: {
        Operations: 9, Engineer: 6, Business: 6, 
        Management: 3, 'Research & Development': 6
    },
    tobacco_expanded: {
        Operations: 12, Engineer: 10, Business: 8, 
        Management: 5, 'Research & Development': 15
    }
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `👥 Starting HR Manager (Tea/Party intervals: ${HR_CONFIG.teaInterval/1000}s/${HR_CONFIG.partyInterval/1000}s)`, false, 'info');
    
    let lastTeaTime = 0;
    let lastPartyTime = 0;
    
    while (true) {
        try {
            // Fix #1, #8: Use cached data instead of direct API call
            const corp = await getCachedCorpData(ns);
            if (!corp) { await ns.sleep(10000); continue; }

            const now = Date.now();
            
            // --- MORALE AND ENERGY MANAGEMENT ---
            const result = await manageMorale(ns, corp, now, lastTeaTime, lastPartyTime);
            lastTeaTime = result.lastTeaTime;
            lastPartyTime = result.lastPartyTime;
            
            // --- DYNAMIC HIRING ---
            await manageHiring(ns, corp);
            
            // --- OFFICE EXPANSION ---
            await manageExpansion(ns, corp);
            
        } catch (e) {
            // Fix #1, #4: Standardized error handling using helper function
            handleCorpError(ns, ns.getScriptName(), e, 'main loop');
        }
        
        await ns.sleep(20000); // HR cycle every 20s
    }
}

async function manageMorale(ns, corp, now, lastTeaTime, lastPartyTime) {
    if (!corp.divisions || !Array.isArray(corp.divisions)) {
        log(ns, "WARN: No divisions found in corporation data", false, 'warning');
        return { lastTeaTime, lastPartyTime };
    }
    
    let teaPerformed = false;
    let partyPerformed = false;
    
    for (const div of corp.divisions) {
        // Fix #5: Defensive iteration with null checks
        if (!isDivisionValid(div) || !div.cities || !Array.isArray(div.cities)) {
            log(ns, `WARN: Invalid division data for ${div?.name || 'Unknown'}`, false, 'warning');
            continue;
        }
        
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                // Fix #2: Tea for morale (every 30s)
                if (now - lastTeaTime > HR_CONFIG.teaInterval) {
                    await cc(ns, 'ns.corporation.buyTea(ns.args[0], ns.args[1])', [div.name, city]);
                    teaPerformed = true;
                }
                
                // Fix #2: Party for big boost (every 60s)
                if (now - lastPartyTime > HR_CONFIG.partyInterval && office.avgMorale < HR_CONFIG.moraleThreshold) {
                    // Fix #6: Use constant instead of magic number
                    await cc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], ns.args[2])', 
                        [div.name, city, CORP_CONFIG.PARTY_COST]);
                    partyPerformed = true;
                }
                
            } catch (e) {
                // Fix #1, #4: Standardized error handling using helper function
                handleCorpError(ns, ns.getScriptName(), e, `managing ${div.name}/${city}`);
            }
        }
    }
    
    return {
        lastTeaTime: teaPerformed ? now : lastTeaTime,
        lastPartyTime: partyPerformed ? now : lastPartyTime
    };
}

async function manageHiring(ns, corp) {
    if (corp.funds < HR_CONFIG.hireThreshold) return;
    
    // Fix Priority 3: Defensive iteration with null checks
    for (const div of corp.divisions) {
        if (!div || !div.cities || !Array.isArray(div.cities)) {
            log(ns, `WARN: No cities found for division ${div?.name || 'Unknown'}`, false, 'warning');
            continue;
        }
        
        const targetStaff = getTargetStaff(div.name);
        const currentStaff = await calculateCurrentStaff(ns, div);
        
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                const currentEmployees = office.numEmployees ?? office.employees ?? 0;
                const targetEmployees = Object.values(targetStaff).reduce((a, b) => a + b, 0);
                
                if (currentEmployees < targetEmployees) {
                    const toHire = Math.min(targetEmployees - currentEmployees, 3); // Hire in batches of 3
                    for (let i = 0; i < toHire; i++) {
                        try {
                            await cc(ns, 'ns.corporation.hireEmployee(ns.args[0], ns.args[1])', [div.name, city]);
                            await ns.sleep(200); // Small pause to prevent lag
                        } catch (e) {
                            // Fix Priority 1: Error logging instead of silent catch
                            log(ns, `ERROR in ${ns.getScriptName()} hiring employee for ${div.name}/${city}: ${e.message || e}`, false, 'error');
                            break; // Stop on error
                        }
                    }
                }
                
                // Automatic role assignment
                if (currentEmployees >= targetEmployees * 0.8) {
                    await assignRoles(ns, div.name, city, targetStaff);
                }
                
            } catch (e) {
                // Fix Priority 1: Error logging instead of silent catch
                log(ns, `ERROR in ${ns.getScriptName()} managing office ${div.name}/${city}: ${e.message || e}`, false, 'error');
            }
        }
    }
}

async function manageExpansion(ns, corp) {
    if (corp.funds < HR_CONFIG.expandThreshold) return;
    
    // Fix Priority 3: Defensive iteration with null checks
    for (const div of corp.divisions) {
        if (!div || !div.cities || !Array.isArray(div.cities)) {
            log(ns, `WARN: No cities found for division ${div?.name || 'Unknown'}`, false, 'warning');
            continue;
        }
        
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                if (office.size < HR_CONFIG.targetOfficeSize) {
                    await cc(ns, 'ns.corporation.upgradeOfficeSize(ns.args[0], ns.args[1])', [div.name, city]);
                    log(ns, `INFO: Expanding office ${div.name}/${city} to ${HR_CONFIG.targetOfficeSize} employees`, false, 'success');
                }
            } catch (e) {
                // Fix Priority 1: Error logging instead of silent catch
                log(ns, `ERROR in ${ns.getScriptName()} expanding office ${div.name}/${city}: ${e.message || e}`, false, 'error');
            }
        }
    }
}

function getTargetStaff(divisionName) {
    if (divisionName.includes('Agri')) return STAFF.agri;
    if (divisionName.includes('Tobac')) return STAFF.tobacco;
    return STAFF.tobacco_expanded; // Default for expanded
}

async function calculateCurrentStaff(ns, division) {
    let total = 0;
    if (!division?.cities || !Array.isArray(division.cities)) return 0;
    
    for (const city of division.cities) {
        try {
            const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [division.name, city]);
            if (office) {
                total += office.numEmployees ?? office.employees ?? 0;
            }
        } catch (e) {
            log(ns, `WARN: Failed to get office data for ${division.name}/${city}: ${e.message || e}`, false, 'warning');
        }
    }
    return total;
}

async function assignRoles(ns, division, city, targetStaff) {
    try {
        for (const [role, count] of Object.entries(targetStaff)) {
            await cc(ns, 'ns.corporation.setAutoJobAssignment(ns.args[0], ns.args[1], ns.args[2], ns.args[3])', 
                [division, city, role, count]);
        }
    } catch (e) {
        // Fix Priority 1: Error logging instead of silent catch
        log(ns, `ERROR in ${ns.getScriptName()} assigning roles for ${division}/${city}: ${e.message || e}`, false, 'error');
    }
}
