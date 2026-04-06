import { getNsDataThroughFile, log } from './helpers.js'

// Konfigurace HR modulu
const HR_CONFIG = {
    teaInterval: 30000,      // Čaj a party každých 30s
    partyInterval: 60000,    // Velké party každých 60s
    hireThreshold: 1e12,    // Najímání při 1T+ fondů
    expandThreshold: 5e12,  // Expanze při 5T+ fondů
    targetOfficeSize: 30,    // Cílová velikost kanceláře
    moraleThreshold: 0.7     // Minimální morálka pro akce
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
    log(ns, `👥 Spouštím HR Manager (Čaj/Party intervaly: ${HR_CONFIG.teaInterval/1000}s/${HR_CONFIG.partyInterval/1000}s)`, false, 'info');
    
    let lastTeaTime = 0;
    let lastPartyTime = 0;
    
    while (true) {
        try {
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (!corp) { await ns.sleep(10000); continue; }

            const now = Date.now();
            
            // --- SPRÁVA MORÁLKY A ENERGIE ---
            await manageMorale(ns, corp, now, lastTeaTime, lastPartyTime);
            
            // --- DYNAMICKÝ NÁBOR ---
            await manageHiring(ns, corp);
            
            // --- EXPANZE KANCELÁŘÍ ---
            await manageExpansion(ns, corp);
            
        } catch (e) {
            log(ns, `💥 HR chyba: ${e}`, false, 'error');
        }
        
        await ns.sleep(20000); // HR cyklus každých 20s
    }
}

async function manageMorale(ns, corp, now, lastTeaTime, lastPartyTime) {
    for (const div of corp.divisions) {
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                // Čaj pro morálku (každých 30s)
                if (now - lastTeaTime > HR_CONFIG.teaInterval) {
                    await cc(ns, 'ns.corporation.buyTea(ns.args[0], ns.args[1])', [div.name, city]);
                }
                
                // Party pro velký boost (každých 60s)
                if (now - lastPartyTime > HR_CONFIG.partyInterval && office.avgMorale < HR_CONFIG.moraleThreshold) {
                    await cc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], ns.args[2])', 
                        [div.name, city, 5e6]); // 5M na party
                }
                
            } catch (_) {}
        }
    }
    
    if (now - lastTeaTime > HR_CONFIG.teaInterval) lastTeaTime = now;
    if (now - lastPartyTime > HR_CONFIG.partyInterval) lastPartyTime = now;
}

async function manageHiring(ns, corp) {
    if (corp.funds < HR_CONFIG.hireThreshold) return;
    
    for (const div of corp.divisions) {
        const targetStaff = getTargetStaff(div.name);
        const currentStaff = calculateCurrentStaff(div);
        
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                const currentEmployees = office.numEmployees ?? office.employees ?? 0;
                const targetEmployees = Object.values(targetStaff).reduce((a, b) => a + b, 0);
                
                if (currentEmployees < targetEmployees) {
                    const toHire = Math.min(targetEmployees - currentEmployees, 3); // Najímávej po 3
                    for (let i = 0; i < toHire; i++) {
                        try {
                            await cc(ns, 'ns.corporation.hireEmployee(ns.args[0], ns.args[1])', [div.name, city]);
                            await ns.sleep(200); // Malá pauza proti lagu
                        } catch (_) {
                            break; // Přerušit při chybě
                        }
                    }
                }
                
                // Automatické přiřazení rolí
                if (currentEmployees >= targetEmployees * 0.8) {
                    await assignRoles(ns, div.name, city, targetStaff);
                }
                
            } catch (_) {}
        }
    }
}

async function manageExpansion(ns, corp) {
    if (corp.funds < HR_CONFIG.expandThreshold) return;
    
    for (const div of corp.divisions) {
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                const currentSize = office.size ?? 0;
                if (currentSize < HR_CONFIG.targetOfficeSize) {
                    const upgradeCost = await cc(ns, 'ns.corporation.getOfficeSizeUpgradeCost(ns.args[0], ns.args[1])', [div.name, city]);
                    if (corp.funds > upgradeCost * 3) {
                        await cc(ns, 'ns.corporation.upgradeOfficeSize(ns.args[0], ns.args[1], ns.args[2])', 
                            [div.name, city, HR_CONFIG.targetOfficeSize - currentSize]);
                        log(ns, `🏢 Rozšířuji kancelář ${div.name}/${city} na ${HR_CONFIG.targetOfficeSize} zaměstnanců`, false, 'success');
                    }
                }
            } catch (_) {}
        }
    }
}

function getTargetStaff(divisionName) {
    if (divisionName.includes('Agri')) return STAFF.agri;
    if (divisionName.includes('Tobac')) return STAFF.tobacco;
    return STAFF.tobacco_expanded; // Default pro rozšířené
}

function calculateCurrentStaff(division) {
    let total = 0;
    for (const city of division.cities) {
        total += city.numEmployees ?? city.employees ?? 0;
    }
    return total;
}

async function assignRoles(ns, division, city, targetStaff) {
    const allRoles = [
        'Operations', 'Engineer', 'Business',
        'Management', 'Research & Development', 'Unassigned', 'Intern'
    ];
    
    for (const role of allRoles) {
        try {
            const count = targetStaff[role] || 0;
            await cc(ns, 'ns.corporation.setAutoJobAssignment(ns.args[0], ns.args[1], ns.args[2], ns.args[3])', 
                [division, city, role, count]);
        } catch (_) {}
    }
}
