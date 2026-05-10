import { getNsDataThroughFile, log, formatMoney, asleep, safeRemoveFile, getConfiguration } from '../helpers.js'
import { calculateOptimalPartyCost, calculatePerfMult, withCorpLock, CORP_LOCK_FILE, cc, getCachedCorpData, handleCorpError, safeCorpOperation, getTobaccoDivision, isDivisionValid } from '../corp-helpers.js'

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
    hireThreshold: 10e9,    // Hire at 10B+ funds (lowered for early game)
    expandThreshold: 50e9,  // Expand at 50B+ funds
    targetOfficeSize: 9,    // Target office size for early game (3-4 employees per city)
    moraleThreshold: 0.7,    // Minimum morale for actions
    adVertThreshold: 50e9,  // Minimum funds before hiring AdVert (50B)
    adVertFundsRatio: 0.05  // Spend up to 5% of funds on AdVert
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

// Parse command line arguments using getConfiguration
const argsSchema = [
    ['temp-prefix', '/Temp/corp-'], // Default prefix
];
const options = getConfiguration(ns, argsSchema);
const tempPrefix = options['temp-prefix'];

export async function main(ns) {
    log(ns, `👥 Starting HR Manager (Tea/Party intervals: ${HR_CONFIG.teaInterval/1000}s/${HR_CONFIG.partyInterval/1000}s)`, false, 'info');
    
    let lastTeaTime = 0;
    let lastPartyTime = 0;
    
    while (true) {
        try {
            // Fix #1, #8: Use cached data instead of direct API call
            const corp = await getCachedCorpData(ns);
            if (!corp) { await asleep(ns, 10000); continue; }

            const now = Date.now();
            
            // --- MORALE AND ENERGY MANAGEMENT ---
            const result = await manageMorale(ns, corp, now, lastTeaTime, lastPartyTime);
            lastTeaTime = result.lastTeaTime;
            lastPartyTime = result.lastPartyTime;
            
            // --- DYNAMIC HIRING ---
            await manageHiring(ns, corp);
            
            // --- OFFICE EXPANSION ---
            await manageExpansion(ns, corp);
            
            // --- ADVERTISING (AdVert) ---
            // Hire AdVert agency to boost awareness/popularity
            await manageAdvertising(ns, corp);
            
        } catch (e) {
            // Fix #1, #4: Standardized error handling using helper function
            handleCorpError(ns, ns.getScriptName(), e, 'main loop');
        }
        
        await asleep(ns, 20000); // HR cycle every 20s
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
                
                // Fix #2: Party for big boost (every 60s) - use OPTIMAL cost calculation from guide
                if (now - lastPartyTime > HR_CONFIG.partyInterval && office.avgMorale < HR_CONFIG.moraleThreshold) {
                    // Calculate optimal party cost using formula from corp guide
                    const perfMult = calculatePerfMult(
                        office.numEmployees || office.employees || 0,
                        office.employeeJobs?.['Intern'] || 0,
                        corp.funds,
                        (div.lastCycleRevenue || 0) > (div.lastCycleExpenses || 0)
                    );
                    
                    const optimalPartyCost = calculateOptimalPartyCost(
                        office.avgMorale,
                        office.maxMorale || 100,
                        perfMult
                    );
                    
                    // Total cost = per-employee cost * number of employees
                    const totalPartyCost = optimalPartyCost * (office.numEmployees || office.employees || 1);
                    
                    await cc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], ns.args[2])', 
                        [div.name, city, totalPartyCost]);
                    partyPerformed = true;
                    
                    log(ns, `INFO: Party ${div.name}/${city}: ${formatMoney(totalPartyCost)} (optimal ${formatMoney(optimalPartyCost)}/emp)`, false, 'info');
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
    log(ns, `DEBUG: manageHiring called - funds: ${formatMoney(corp.funds)}, threshold: ${formatMoney(HR_CONFIG.hireThreshold)}`, false, 'info');
    if (corp.funds < HR_CONFIG.hireThreshold) {
        log(ns, `DEBUG: Funds below threshold, skipping hiring`, false, 'info');
        return;
    }
    
    // Fix Priority 3: Defensive iteration with null checks
    for (const div of corp.divisions) {
        if (!div || !div.cities || !Array.isArray(div.cities)) {
            log(ns, `WARN: No cities found for division ${div?.name || 'Unknown'}`, false, 'warning');
            continue;
        }
        
        const targetStaff = getTargetStaff(div);
        const currentStaff = await calculateCurrentStaff(ns, div);
        
        let totalDivisionEmployees = 0;
        
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                const currentEmployees = office.numEmployees ?? office.employees ?? 0;
                totalDivisionEmployees += currentEmployees;
                const targetEmployees = Object.values(targetStaff).reduce((a, b) => a + b, 0);
                
                if (currentEmployees < targetEmployees) {
                    const toHire = Math.min(targetEmployees - currentEmployees, 3); // Hire in batches of 3
                    for (let i = 0; i < toHire; i++) {
                        try {
                            await cc(ns, 'ns.corporation.hireEmployee(ns.args[0], ns.args[1])', [div.name, city]);
                            await asleep(ns, 200); // Small pause to prevent lag
                        } catch (e) {
                            // Fix Priority 1: Error logging instead of silent catch
                            log(ns, `ERROR in ${ns.getScriptName()} hiring employee for ${div.name}/${city}: ${e.message || e}`, false, 'error');
                            break; // Stop on error
                        }
                    }
                }
                
                // Automatic role assignment - requires Office API unlock first
                const hasOfficeAPI = await cc(ns, 'ns.corporation.hasUnlock("Office API")');
                const threshold = Math.floor(targetEmployees * 0.1); // 10% of target (allows 2 employees)
                
                log(ns, `DEBUG: ${div.name}/${city} hasAPI=${hasOfficeAPI}, employees=${currentEmployees}, threshold=${threshold}`, false, 'info');
                
                if (hasOfficeAPI && currentEmployees >= threshold) {
                    log(ns, `INFO: Assigning roles for ${div.name}/${city} (${currentEmployees} employees)`, false, 'info');
                    await assignRoles(ns, div.name, city, targetStaff, currentEmployees);
                } else if (!hasOfficeAPI) {
                    log(ns, `WARN: Skipping role assignment - Office API not unlocked for ${div.name}/${city}`, false, 'warning');
                } else {
                    log(ns, `INFO: Not enough employees (${currentEmployees}/${threshold}) for auto-assignment in ${div.name}/${city}`, false, 'info');
                }
                
            } catch (e) {
                // Fix Priority 1: Error logging instead of silent catch
                log(ns, `ERROR in ${ns.getScriptName()} managing office ${div.name}/${city}: ${e.message || e}`, false, 'error');
            }
        }
        
        log(ns, `INFO: ${div.name} has ${totalDivisionEmployees} total employees across ${div.cities.length} cities`, false, 'info');
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
                    await cc(ns, 'ns.corporation.upgradeOfficeSize(ns.args[0], ns.args[1], ns.args[2])', [div.name, city, HR_CONFIG.targetOfficeSize]);
                    log(ns, `INFO: Expanding office ${div.name}/${city} to ${HR_CONFIG.targetOfficeSize} employees`, false, 'success');
                }
            } catch (e) {
                // Fix Priority 1: Error logging instead of silent catch
                log(ns, `ERROR in ${ns.getScriptName()} expanding office ${div.name}/${city}: ${e.message || e}`, false, 'error');
            }
        }
    }
}

function getTargetStaff(div) {
    // Use division type, not name (e.g., "Agriculture", not "GreenGrow")
    const type = div?.type || div?.industry || '';
    if (type === 'Agriculture') return STAFF.agri;
    if (type === 'Tobacco') return STAFF.tobacco;
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

async function assignRoles(ns, division, city, targetStaff, totalEmployees) {
    try {
        const targetTotal = Object.values(targetStaff).reduce((a,b)=>a+b,0);
        let assignedCount = 0;
        let employeesRemaining = totalEmployees;
        
        log(ns, `DEBUG: assignRoles called for ${division}/${city} with ${totalEmployees} employees, targetTotal=${targetTotal}`, false, 'info');
        
        // Sort roles by priority (highest target count first)
        const sortedRoles = Object.entries(targetStaff).sort((a, b) => b[1] - a[1]);
        log(ns, `DEBUG: Roles sorted: ${sortedRoles.map(r=>r[0]).join(', ')}`, false, 'info');
        
        // Check if all ideal counts would be 0 (happens when employees < number of roles)
        const allZero = sortedRoles.every(([_, targetCount]) => {
            const ratio = targetCount / targetTotal;
            const ideal = Math.floor(totalEmployees * ratio);
            log(ns, `DEBUG: ${targetCount}/${targetTotal}=${ratio.toFixed(2)}, floor(${totalEmployees}*${ratio.toFixed(2)})=${ideal}`, false, 'info');
            return ideal === 0;
        });
        log(ns, `DEBUG: allZero=${allZero}`, false, 'info');
        
        for (const [role, targetCount] of sortedRoles) {
            // Calculate scaled count
            const ratio = targetCount / targetTotal;
            const idealCount = Math.floor(totalEmployees * ratio);
            
            // If all ideal counts are 0, assign 1 to highest priority roles until employees run out
            const scaledCount = allZero ? 
                Math.min(1, employeesRemaining) : // Give 1 to each role in priority order
                Math.min(idealCount, employeesRemaining);
            
            log(ns, `DEBUG: Role ${role}: ideal=${idealCount}, scaled=${scaledCount}, remaining=${employeesRemaining}`, false, 'info');
            
            // Stop if no employees left
            if (scaledCount <= 0 || employeesRemaining <= 0) {
                log(ns, `DEBUG: Breaking - scaledCount=${scaledCount}, employeesRemaining=${employeesRemaining}`, false, 'info');
                break;
            }
            
            try {
                // Validate Office API availability before attempting role assignment
                const hasOfficeAPI = await cc(ns, 'ns.corporation.hasUnlock("Office API")');
                if (!hasOfficeAPI) {
                    log(ns, `WARN: Office API not unlocked - cannot assign roles in ${division}/${city}`, false, 'warning');
                    break;
                }
                
                // v3.x: setAutoJobAssignment() removed, use setJobAssignment() with Office API check
                // API requires ns.args for ram-dodging parameter passing
                await cc(ns, 'ns.corporation.setJobAssignment(ns.args[0], ns.args[1], ns.args[2], ns.args[3])', 
                    [division, city, role, scaledCount]);
                employeesRemaining -= scaledCount;
                assignedCount++;
                log(ns, `INFO: Assigned ${scaledCount} to ${role} in ${division}/${city}`, false, 'info');
            } catch (e) {
                log(ns, `WARN: Failed to assign ${role} in ${division}/${city}: ${e.message || e}`, false, 'warning');
            }
        }
        
        // Log warning if employees remain unassigned
        if (employeesRemaining > 0) {
            log(ns, `WARN: ${employeesRemaining} employees unassigned in ${division}/${city} (insufficient for all roles)`, false, 'warning');
        } else if (assignedCount > 0) {
            log(ns, `SUCCESS: Assigned all ${totalEmployees} employees to ${assignedCount} roles in ${division}/${city}`, false, 'success');
        }
    } catch (e) {
        log(ns, `ERROR assigning roles for ${division}/${city}: ${e.message || e}`, false, 'error');
    }
}

/** Manage AdVert advertising for all divisions
 * AdVert increases awareness and popularity which drives sales
 * @param {NS} ns
 * @param {Object} corp - Corporation data
 */
async function manageAdvertising(ns, corp) {
    if (!corp.divisions || !Array.isArray(corp.divisions)) return;
    if (corp.funds < HR_CONFIG.adVertThreshold) return;
    
    // Calculate budget - up to 5% of current funds
    const maxAdSpend = corp.funds * HR_CONFIG.adVertFundsRatio;
    let totalSpent = 0;
    
    for (const div of corp.divisions) {
        if (!div?.name) continue;
        
        // Defensive check for division type before accessing
        if (!div.type) {
            log(ns, `WARN: Division ${div.name} missing type property, skipping AdVert`, false, 'warning');
            continue;
        }
        
        // Only do AdVert for Tobacco - Agriculture/Chemical don't benefit as much and may have API issues
        if (div.type !== 'Tobacco') continue;
        
        try {
            // Check current AdVert count
            const adVertCount = await cc(ns, 'ns.corporation.getHireAdVertCount(ns.args[0])', [div.name]);
            
            // Hire AdVert if we have budget and haven't hit diminishing returns too hard
            // Cap at reasonable number to avoid wasting money (cost scales exponentially)
            if (totalSpent < maxAdSpend && adVertCount < 10) {
                await cc(ns, 'ns.corporation.hireAdVert(ns.args[0])', [div.name]);
                // Estimate cost (scales roughly 2x per hire, starting ~100M)
                const estimatedCost = 100e6 * Math.pow(2, adVertCount);
                totalSpent += estimatedCost;
                log(ns, `SUCCESS: Hired AdVert for ${div.name} (est. ${formatMoney(estimatedCost)}) - Count: ${adVertCount + 1}`, false, 'success');
                await asleep(ns, 1000);
            }
        } catch (e) {
            // AdVert may fail if already at max or division doesn't support it
            if (e.message?.includes('not supported')) {
                // Some industries don't support AdVert, skip silently
                continue;
            }
            log(ns, `WARN: Failed to hire AdVert for ${div.name}: ${e.message || e}`, false, 'warning');
        }
    }
}
