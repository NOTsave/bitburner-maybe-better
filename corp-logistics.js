import { getNsDataThroughFile, log, formatMoney, getCachedCorpData } from './helpers.js'

// Fix #6: Global Constant Definitions
const CORP_CONFIG = {
    PARTY_COST: 5e6,         // $5M for office parties
    ENERGY_COST_PER_UNIT: 1000, // $1K per energy point
    ENERGY_THRESHOLD: 70,    // Refill energy below 70%
    MORALE_COOLDOWN: 30000,  // 30s for tea/coffee
    PARTY_COOLDOWN: 60000    // 60s for parties
};

// Logistics Module Configuration
const LOGISTICS_CONFIG = {
    checkInterval: 45000,       // Check every 45s
    upgradeThreshold: 1e12,    // Upgrades at 1T+ funds
    materialBuffer: 0.8,          // 80% warehouse capacity
    energyThreshold: 0.7,        // Refill energy below 70%
    moraleThreshold: 0.6          // Morale below 60% = urgent action
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `🚚 Starting Logistics Manager (interval: ${LOGISTICS_CONFIG.checkInterval/1000}s)`, false, 'info');
    
    while (true) {
        try {
            // Fix #1, #8: Use cached data instead of direct API call
            const corp = await getCachedCorpData(ns);
            if (!corp) { await ns.sleep(10000); continue; }

            // --- INTELLIGENT UPGRADES ---
            await manageUpgrades(ns, corp);
            
            // --- ENERGY MANAGEMENT ---
            await manageEnergy(ns, corp);
            
            // --- CRISIS HANDLING ---
            await handleCrises(ns, corp);
            
        } catch (e) {
            log(ns, `🚚 Logistics error: ${e}`, false, 'error');
        }
        
        await ns.sleep(LOGISTICS_CONFIG.checkInterval);
    }
}

async function manageUpgrades(ns, corp) {
    if (corp.funds < LOGISTICS_CONFIG.upgradeThreshold) return;
    
    // Fix #2: Dynamic Detection - use industry type instead of hardcoded names
    const agriDiv = corp.divisions.find(d => d.type === 'Agriculture');
    const tobaccoDiv = corp.divisions.find(d => d.type === 'Tobacco');
    
    // Priority upgrades for corporation (these are UNLOCKS, not warehouse upgrades)
    const PRIORITY_UNLOCKS = [
        { name: 'Smart Supply', priority: 1 },
        { name: 'Smart Storage', priority: 2 },
        { name: 'DreamSense', priority: 3 },
        { name: 'Wilson', priority: 4 }
    ];
    
    for (const unlock of PRIORITY_UNLOCKS) {
        try {
            const hasUnlock = await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', [unlock.name]);
            if (!hasUnlock) {
                const cost = await cc(ns, 'ns.corporation.getUnlockCost(ns.args[0])', [unlock.name]);
                if (corp.funds > cost * 3) {
                    await cc(ns, 'ns.corporation.purchaseUnlock(ns.args[0])', [unlock.name]);
                    log(ns, `SUCCESS: Purchased ${unlock.name} (${formatMoney(cost)})`, false, 'success');
                    await ns.sleep(2000);
                    break; // Only one unlock per cycle
                }
            }
        } catch (e) {
            // Fix #1, #4: Standardized error logging
            log(ns, `ERROR in ${ns.getScriptName()} purchasing ${unlock.name}: ${e.message || e}`, false, 'error');
        }
    }
}

async function manageEnergy(ns, corp) {
    for (const div of corp.divisions) {
        // Fix #5: Defensive iteration with null checks
        if (!div || !div.cities || !Array.isArray(div.cities)) {
            log(ns, `WARN: No cities found for division ${div?.name || 'Unknown'}`, false, 'warning');
            continue;
        }
        
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                // Fix #2, #6: Refill energy below threshold using constant
                if (office.energy < office.maxEnergy * LOGISTICS_CONFIG.energyThreshold) {
                    const energyNeeded = Math.ceil(office.maxEnergy - office.energy);
                    // Fix #6: Use constant instead of magic number
                    const cost = energyNeeded * CORP_CONFIG.ENERGY_COST_PER_UNIT;
                    
                    if (corp.funds > cost * 2) {
                        await cc(ns, 'ns.corporation.buyTea(ns.args[0], ns.args[1])', [div.name, city]);
                        log(ns, `INFO: Refilling energy for ${div.name} in ${city}. Cost: ${formatMoney(cost)}`, false, 'info');
                    }
                }
                
            } catch (e) {
                // Fix #1, #4: Standardized error logging
                log(ns, `ERROR in ${ns.getScriptName()} managing energy for ${div.name}/${city}: ${e.message || e}`, false, 'error');
            }
        }
    }
}

async function handleCrises(ns, corp) {
    const crises = [];
    
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
                
                // Crisis situation checks
                if (office.avgMorale < LOGISTICS_CONFIG.moraleThreshold) {
                    crises.push({
                        type: 'low_morale',
                        division: div.name,
                        city: city,
                        morale: office.avgMorale,
                        severity: 'high'
                    });
                }
                
                const warehouse = await cc(ns, 'ns.corporation.getWarehouse(ns.args[0], ns.args[1])', [div.name, city]);
                if (warehouse && warehouse.sizeUsed > warehouse.size * 0.95) {
                    crises.push({
                        type: 'warehouse_full',
                        division: div.name,
                        city: city,
                        usage: (warehouse.sizeUsed / warehouse.size * 100).toFixed(1),
                        severity: 'medium'
                    });
                }
                
            } catch (e) {
                // Fix Priority 1: Error logging instead of silent catch
                log(ns, `ERROR in ${ns.getScriptName()} checking crisis for ${div.name}/${city}: ${e.message || e}`, false, 'error');
            }
        }
    }
    
    // Crisis resolution
    for (const crisis of crises) {
        await resolveCrisis(ns, corp, crisis);
    }
    
    if (crises.length > 0) {
        log(ns, `INFO: Resolving ${crises.length} crisis situations`, false, 'warning');
    }
}

async function resolveCrisis(ns, corp, crisis) {
    try {
        switch (crisis.type) {
            case 'low_morale':
                // Immediate morale boost
                await cc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], ns.args[2])', 
                    [crisis.division, crisis.city, 2e6]); // 2M for urgent party
                log(ns, `SUCCESS: Crisis morale boost in ${crisis.division}/${crisis.city}`, false, 'warning');
                break;
                
            case 'warehouse_full':
                // Warehouse upgrade
                const upgradeCost = await cc(ns, 'ns.corporation.getUpgradeWarehouseCost(ns.args[0], ns.args[1])', 
                    [crisis.division, crisis.city]);
                
                if (corp.funds > upgradeCost * 1.5) {
                    await cc(ns, 'ns.corporation.upgradeWarehouse(ns.args[0], ns.args[1])', 
                        [crisis.division, crisis.city]);
                    log(ns, `SUCCESS: Crisis warehouse upgrade in ${crisis.division}/${crisis.city} (${crisis.usage}% → 100%+)`, false, 'warning');
                }
                break;
        }
    } catch (e) {
        log(ns, `ERROR: Crisis resolution failed: ${e.message || e}`, false, 'error');
    }
}
