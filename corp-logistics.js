import { getNsDataThroughFile, log } from './helpers.js'

// Konfigurace logistického modulu
const LOGISTICS_CONFIG = {
    checkInterval: 45000,       // Kontrola každých 45s
    upgradeThreshold: 1e12,    // Upgrady při 1T+ fondů
    materialBuffer: 0.8,          // 80% kapacity skladu
    energyThreshold: 0.7,        // Energie pod 70% = doplnit
    moraleThreshold: 0.6          // Morálka pod 60% = urgentní akce
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `🚚 Spouštím Logistics Manager (interval: ${LOGISTICS_CONFIG.checkInterval/1000}s)`, false, 'info');
    
    while (true) {
        try {
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (!corp) { await ns.sleep(10000); continue; }

            // --- INTELIGENTNÍ UPGRADY ---
            await manageUpgrades(ns, corp);
            
            // --- ENERGETICKÁ SPRÁVA ---
            await manageEnergy(ns, corp);
            
            // --- KRIZOVÉ ŘEŠENÍ ---
            await handleCrises(ns, corp);
            
        } catch (e) {
            log(ns, `🚚 Logistická chyba: ${e}`, false, 'error');
        }
        
        await ns.sleep(LOGISTICS_CONFIG.checkInterval);
    }
}

async function manageUpgrades(ns, corp) {
    if (corp.funds < LOGISTICS_CONFIG.upgradeThreshold) return;
    
    // Prioritní upgrady pro korporaci
    const PRIORITY_UPGRADES = [
        { name: 'Smart Supply', cost: async () => cc(ns, 'ns.corporation.getUpgradeWarehouseCost(ns.args[0], ns.args[1])', ['Agriculture', 'Aevum']), priority: 1 },
        { name: 'Smart Storage', cost: async () => cc(ns, 'ns.corporation.getUpgradeWarehouseCost(ns.args[0], ns.args[1])', ['Agriculture', 'Chongqing']), priority: 2 },
        { name: 'DreamSense', cost: async () => cc(ns, 'ns.corporation.getUpgradeOfficeCost(ns.args[0], ns.args[1])', ['TobacDiv', 'Sector-12']), priority: 3 },
        { name: 'Wilson', cost: async () => cc(ns, 'ns.corporation.getUpgradeOfficeCost(ns.args[0], ns.args[1])', ['TobacDiv', 'New Tokyo']), priority: 4 }
    ];
    
    for (const upgrade of PRIORITY_UPGRADES) {
        try {
            const hasUpgrade = await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', [upgrade.name]);
            if (!hasUpgrade) {
                const cost = await upgrade.cost();
                if (corp.funds > cost * 3) {
                    await cc(ns, 'ns.corporation.purchaseUnlock(ns.args[0])', [upgrade.name]);
                    log(ns, `🔧 Koupil jsem ${upgrade.name} (${formatMoney(cost)})`, false, 'success');
                    await ns.sleep(2000);
                    break; // Jen jeden upgrade za cyklus
                }
            }
        } catch (_) {}
    }
}

async function manageEnergy(ns, corp) {
    for (const div of corp.divisions) {
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                // Doplnění energie pod 70%
                if (office.energy < office.maxEnergy * LOGISTICS_CONFIG.energyThreshold) {
                    const energyNeeded = Math.ceil(office.maxEnergy - office.energy);
                    const cost = energyNeeded * 1000; // $1K za 1 energii
                    
                    if (corp.funds > cost * 2) {
                        await cc(ns, 'ns.corporation.buyTea(ns.args[0], ns.args[1])', [div.name, city]);
                        await cc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], ns.args[2])', 
                            [div.name, city, Math.min(cost, 1e6)]); // Max 1M na party
                        log(ns, `⚡ Doplnil jsem energii v ${div.name}/${city} (${energyNeeded} → ${office.maxEnergy})`, false, 'info');
                    }
                }
                
            } catch (_) {}
        }
    }
}

async function handleCrises(ns, corp) {
    const crises = [];
    
    for (const div of corp.divisions) {
        for (const city of div.cities) {
            try {
                const office = await cc(ns, 'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div.name, city]);
                if (!office) continue;
                
                // Kontrola krizových situací
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
                
            } catch (_) {}
        }
    }
    
    // Řešení krizí
    for (const crisis of crises) {
        await resolveCrisis(ns, corp, crisis);
    }
    
    if (crises.length > 0) {
        log(ns, `🚨 Řeším ${crises.length} krizových situací`, false, 'warning');
    }
}

async function resolveCrisis(ns, corp, crisis) {
    try {
        switch (crisis.type) {
            case 'low_morale':
                // Okamžitá morálka boost
                await cc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], ns.args[2])', 
                    [crisis.division, crisis.city, 2e6]); // 2M na urgentní party
                log(ns, `🎉 Krizová morálka boost v ${crisis.division}/${crisis.city}`, false, 'warning');
                break;
                
            case 'warehouse_full':
                // Upgrade skladu
                const upgradeCost = await cc(ns, 'ns.corporation.getUpgradeWarehouseCost(ns.args[0], ns.args[1])', 
                    [crisis.division, crisis.city]);
                
                if (corp.funds > upgradeCost * 1.5) {
                    await cc(ns, 'ns.corporation.upgradeWarehouse(ns.args[0], ns.args[1])', 
                        [crisis.division, crisis.city]);
                    log(ns, `📦 Krizový upgrade skladu v ${crisis.division}/${crisis.city} (${crisis.usage}% → 100%+)`, false, 'warning');
                }
                break;
        }
    } catch (e) {
        log(ns, `💥 Řešení krize selhalo: ${e}`, false, 'error');
    }
}

function formatMoney(amount) {
    if (amount >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return `$${amount.toFixed(2)}`;
}
