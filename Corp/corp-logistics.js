import { getNsDataThroughFile, log, formatMoney, getCachedCorpData, asleep } from '../helpers.js'
import { calculateOptimalBoostMaterials, calculateBoostPurchaseRate, INDUSTRY_BOOST_COEFFICIENTS } from '../corp-helpers.js'

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
    moraleThreshold: 0.6,         // Morale below 60% = urgent action
    
    // Early game: Manual buy rate for Water/Chemicals (when Smart Supply disabled)
    // Set to 0 to disable buying entirely, or small number (1-5) for slow production
    earlyGameBuyRate: 5           // Buy 5/s of Water and Chemicals (cheap, keeps production going)
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `🚚 Starting Logistics Manager (interval: ${LOGISTICS_CONFIG.checkInterval/1000}s)`, false, 'info');
    
    // Prevent multiple instances - only one logistics manager should run
    const runningInstances = ns.ps('home').filter(p => p.filename === 'Corp/corp-logistics.js');
    if (runningInstances.length > 1) {
        log(ns, `Another instance already running (PID: ${runningInstances[0].pid}), exiting.`, false, 'warning');
        return;
    }
    
    while (true) {
        try {
            // Fix #1, #8: Use cached data instead of direct API call
            const corp = await getCachedCorpData(ns);
            if (!corp) { await asleep(ns, 10000); continue; }

            // --- EARLY GAME SMART SUPPLY MANAGEMENT ---
            // Disable Smart Supply on Agriculture if Chemical doesn't exist (prevents buying inputs)
            await manageEarlyGameSmartSupply(ns, corp);
            
            // --- INTELLIGENT UPGRADES ---
            await manageUpgrades(ns, corp);
            
            // --- MATERIAL SALES (Agriculture/Chemical) ---
            await manageMaterialSales(ns, corp);
            
            // --- ENERGY MANAGEMENT ---
            await manageEnergy(ns, corp);
            
            // --- CRISIS HANDLING ---
            await handleCrises(ns, corp);
            
        } catch (e) {
            log(ns, `🚚 Logistics error: ${e}`, false, 'error');
        }
        
        await asleep(ns, LOGISTICS_CONFIG.checkInterval);
    }
}

/**
 * Early game: Manage Smart Supply on Agriculture if Chemical division doesn't exist
 * Replaces aggressive Smart Supply with controlled buying to save funds
 * @param {NS} ns
 * @param {Object} corp - Corporation data
 */
async function manageEarlyGameSmartSupply(ns, corp) {
    const agriDiv = corp.divisions.find(d => d.type === 'Agriculture');
    const hasChemical = corp.divisions.some(d => d.type === 'Chemical');
    
    // If no Agriculture or Chemical exists, nothing to do
    if (!agriDiv || hasChemical) return;
    
    const buyRate = LOGISTICS_CONFIG.earlyGameBuyRate;
    
    let totalWaterRate = 0;
    let totalChemicalRate = 0;
    
    for (const city of agriDiv.cities) {
        try {
            const warehouse = await cc(ns, 'ns.corporation.getWarehouse(ns.args[0], ns.args[1])', 
                [agriDiv.name, city]);
            if (!warehouse) continue;
            
            // Check Smart Supply unlock before attempting to disable
            const hasSmartSupply = await cc(ns, 'ns.corporation.hasUnlock("Smart Supply")');
            if (hasSmartSupply) {
                await cc(ns, 'ns.corporation.setSmartSupply(ns.args[0], ns.args[1], false)', 
                    [agriDiv.name, city]);
            }
            
            if (warehouse.smartSupplyEnabled) {
                log(ns, `WARN: DISABLED Smart Supply on ${agriDiv.name}/${city}`, false, 'warning');
            }
            
            // Set controlled buy rates for early game (Water needed more than Chemicals)
            // Water: 2/s (agriculture needs 0.5 water per production cycle)
            // Chemicals: 1/s (agriculture needs 0.2 chemicals per production cycle)
            const waterRate = buyRate > 0 ? 2 : 0;
            const chemicalRate = buyRate > 0 ? 1 : 0;
            
            await cc(ns, 'ns.corporation.buyMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3])',
                [agriDiv.name, city, 'Water', waterRate]);
            await cc(ns, 'ns.corporation.buyMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3])',
                [agriDiv.name, city, 'Chemicals', chemicalRate]);
            
            totalWaterRate += waterRate;
            totalChemicalRate += chemicalRate;
            
            // Verify the buy rates were actually set
            await asleep(ns, 100); // Brief wait for API to apply
            const waterMaterial = await cc(ns, 'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                [agriDiv.name, city, 'Water']);
            const chemMaterial = await cc(ns, 'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                [agriDiv.name, city, 'Chemicals']);
            
            const actualWaterBuy = waterMaterial?.buyAmount || 0;
            const actualChemBuy = chemMaterial?.buyAmount || 0;
            
            log(ns, `INFO: Set buy rates for ${agriDiv.name}/${city}: Water=${waterRate}/s (actual: ${actualWaterBuy}/s), Chemicals=${chemicalRate}/s (actual: ${actualChemBuy}/s)`, false, 'info');
            
            // Warn if actual rate doesn't match intended rate
            if (Math.abs(actualChemBuy - chemicalRate) > 0.1) {
                log(ns, `WARN: Chemical buy rate mismatch in ${agriDiv.name}/${city}! Intended: ${chemicalRate}/s, Actual: ${actualChemBuy}/s`, false, 'warning');
            }
        } catch (e) {
            log(ns, `WARN: Failed to set buy rates for ${agriDiv.name}/${city}: ${e.message || e}`, false, 'warning');
        }
    }
    
    log(ns, `INFO: Total buy rates across ${agriDiv.cities.length} cities: Water=${totalWaterRate}/s, Chemicals=${totalChemicalRate}/s`, false, 'info');
}

async function manageUpgrades(ns, corp) {
    if (corp.funds < LOGISTICS_CONFIG.upgradeThreshold) return;
    
    // Fix #2: Dynamic Detection - use industry type instead of hardcoded names
    const agriDiv = corp.divisions.find(d => d.type === 'Agriculture');
    const tobaccoDiv = corp.divisions.find(d => d.type === 'Tobacco');
    
    // --- OPTIMAL BOOST MATERIAL BUYING ---
    // Uses per-second buying (can go into debt) with Lagrange-optimized distribution
    await manageOptimalBoostMaterials(ns, corp);
    
    // Priority upgrades for corporation (these are UNLOCKS, not warehouse upgrades)
    // CORRECTED per corp strategy guide: Export is mandatory for Round 2 ($20B)
    // Wilson is NOT retroactive - must buy BEFORE Advert purchases. Skip in early rounds.
    const PRIORITY_UNLOCKS = [
        { name: 'Office API', priority: 0, minPhase: 1 },      // PRIORITY 1: Required for employee job assignment
        { name: 'Smart Supply', priority: 1, minPhase: 1 },     // CRITICAL: Required for production - auto buys Water/Energy
        { name: 'Export', priority: 2, minPhase: 1 },          // Round 2: For selling products between divisions
        { name: 'Smart Storage', priority: 3, minPhase: 1 },    // Round 1: Important for warehouse space
        { name: 'Smart Factories', priority: 4, minPhase: 2 }, // Round 2+: Production boost
        { name: 'Wilson', priority: 5, minPhase: 3 }            // Round 3+: Main profit driver (Wilson Analytics) - NOT RETROACTIVE!
    ];
    
    // Get current phase from corp state file
    let currentPhase = 1;
    try {
        const stateData = ns.read('/Temp/corp-state.txt');
        if (stateData) {
            const state = JSON.parse(stateData);
            currentPhase = state.phase || 1;
        }
    } catch (e) { /* Use default phase 1 */ }
    
    for (const unlock of PRIORITY_UNLOCKS) {
        try {
            // Skip if unlock has minPhase requirement and we're not there yet
            if (unlock.minPhase && currentPhase < unlock.minPhase) continue;
            
            const hasUnlock = await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', [unlock.name]);
            if (!hasUnlock) {
                const cost = await cc(ns, 'ns.corporation.getUnlockCost(ns.args[0])', [unlock.name]);
                const canAfford = corp.funds > cost * 3;
                log(ns, `DEBUG: Unlock ${unlock.name} - cost: ${formatMoney(cost)}, funds: ${formatMoney(corp.funds)}, canAfford: ${canAfford}`, false, 'info');
                if (canAfford) {
                    await cc(ns, 'ns.corporation.purchaseUnlock(ns.args[0])', [unlock.name]);
                    log(ns, `SUCCESS: Purchased ${unlock.name} (${formatMoney(cost)}) [Phase ${currentPhase}]`, false, 'success');
                    await asleep(ns, 2000);
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
                    await cc(ns, 'ns.corporation.upgradeWarehouse(ns.args[0], ns.args[1], 1)', 
                        [crisis.division, crisis.city]);
                    log(ns, `SUCCESS: Crisis warehouse upgrade in ${crisis.division}/${crisis.city} (${crisis.usage}% → 100%+)`, false, 'warning');
                }
                break;
        }
    } catch (e) {
        log(ns, `ERROR: Crisis resolution failed: ${e.message || e}`, false, 'error');
    }
}

/**
 * Manage optimal boost material buying using Lagrange-optimized distribution
 * Uses per-second buying (can go into debt) as recommended by corp guide
 * 
 * @param {NS} ns 
 * @param {Object} corp - Corporation data
 */
async function manageOptimalBoostMaterials(ns, corp) {
    for (const div of corp.divisions) {
        // Skip divisions without boost coefficient data
        if (!INDUSTRY_BOOST_COEFFICIENTS[div.type]) continue;
        
        // Chemical division gets minimal warehouse - max 1 upgrade per guide
        const isChemical = div.type === 'Chemical';
        
        for (const city of div.cities) {
            try {
                const warehouse = await cc(ns, 'ns.corporation.getWarehouse(ns.args[0], ns.args[1])', [div.name, city]);
                if (!warehouse) continue;
                
                // Early game: Skip boost buying for small warehouses (focus on production first)
                if (warehouse.level < 3) {
                    continue; // Skip boost buying until warehouse is level 3+
                }
                
                // Chemical: Only buy boost materials if warehouse level is <= 1
                if (isChemical && warehouse.level > 1) {
                    continue; // Skip boost buying for high-level Chemical warehouses
                }
                
                // Calculate optimal boost material distribution
                // Use 50% of warehouse space for boost materials (50% buffer for production)
                const boostSpace = warehouse.size * 0.5;
                const optimal = calculateOptimalBoostMaterials(div.type, boostSpace);
                
                if (!optimal || !optimal.materials) continue;
                
                // Buy boost materials optimally using per-second buying (can go into debt)
                for (const [materialName, data] of Object.entries(optimal.materials)) {
                    if (data.quantity <= 0) continue;
                    
                    try {
                        // Get current material quantity
                        const material = await cc(ns, 'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])', 
                            [div.name, city, materialName]);
                        
                        const currentQty = material?.stored || 0;
                        const targetQty = data.quantity;
                        
                        // Only buy if we need significantly more (avoid tiny purchases)
                        if (targetQty > currentQty * 1.2) { // 20% tolerance - only buy when 20% below target
                            // Calculate per-second purchase rate
                            const purchaseRate = calculateBoostPurchaseRate(targetQty, currentQty, 10);
                            
                            if (purchaseRate > 0) {
                                // Use per-second buying (can go into debt) - recommended by guide
                                await cc(ns, 'ns.corporation.buyMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3])',
                                    [div.name, city, materialName, purchaseRate]);
                                
                                log(ns, `INFO: Boost ${div.name}/${city}: ${materialName} target ${Math.round(targetQty).toLocaleString()} @ ${purchaseRate.toFixed(2)}/s`, false, 'info');
                            }
                        }
                    } catch (e) {
                        // Silent fail for individual materials - continue with others
                        continue;
                    }
                }
                
            } catch (e) {
                // Silent fail for individual cities - continue with others
                continue;
            }
        }
    }
}

/**
 * Set up exports between divisions to prevent Smart Supply from buying from market
 * Agriculture needs Chemicals from Chemical division
 * Chemical needs Plants from Agriculture division
 * @param {NS} ns
 * @param {Object} corp - Corporation data
 */
async function setupMaterialExports(ns, corp) {
    const agriDiv = corp.divisions.find(d => d.type === 'Agriculture');
    const chemDiv = corp.divisions.find(d => d.type === 'Chemical');
    
    if (!agriDiv || !chemDiv) return; // Need both divisions
    
    for (const city of agriDiv.cities) {
        try {
            // Check if Chemicals export from Chemical → Agriculture exists
            const chemExports = await cc(ns, 'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                [chemDiv.name, city, 'Chemicals']);
            
            // Check Export unlock before setting up exports
            const hasExport = await cc(ns, 'ns.corporation.hasUnlock("Export")');
            if (hasExport) {
                // Export Chemicals from Chemical to Agriculture
                if (chemExports && !chemExports.exports?.some(e => e.division === agriDiv.name)) {
                    await cc(ns, 'ns.corporation.exportMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3], ns.args[4], ns.args[5])',
                        [chemDiv.name, city, agriDiv.name, city, 'Chemicals', 'MAX']);
                    log(ns, `INFO: Export setup: ${chemDiv.name} → ${agriDiv.name}: Chemicals (${city})`, false, 'info');
                }
            }
            
            // Export Plants from Agriculture to Chemical
            const plantExports = await cc(ns, 'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                [agriDiv.name, city, 'Plants']);
            
            if (hasExport) {
                if (plantExports && !plantExports.exports?.some(e => e.division === chemDiv.name)) {
                    await cc(ns, 'ns.corporation.exportMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3], ns.args[4], ns.args[5])',
                        [agriDiv.name, city, chemDiv.name, city, 'Plants', 'MAX']);
                    log(ns, `INFO: Export setup: ${agriDiv.name} → ${chemDiv.name}: Plants (${city})`, false, 'info');
                }
            }
        } catch (e) {
            // Silent fail for individual cities
        }
    }
}

/**
 * Sell produced materials (Agriculture/Chemical) in all cities
 * Materials need to be sold via sellMaterial API
 * @param {NS} ns
 * @param {Object} corp - Corporation data
 */
async function manageMaterialSales(ns, corp) {
    // First, ensure exports are set up between divisions
    await setupMaterialExports(ns, corp);
    
    // Material-producing industries that need manual selling
    const MATERIAL_INDUSTRIES = ['Agriculture', 'Chemical'];
    
    for (const div of corp.divisions) {
        if (!MATERIAL_INDUSTRIES.includes(div.type)) continue;
        
        for (const city of div.cities) {
            try {
                // Get warehouse to see what materials are stored
                const warehouse = await cc(ns, 'ns.corporation.getWarehouse(ns.args[0], ns.args[1])', [div.name, city]);
                if (!warehouse || warehouse.size <= 0) continue;
                
                // Get materials this industry produces (API changed in v2.2.0)
                // Note: getIndustryData needs IndustryType (e.g., "Agriculture"), not division name
                // Use explicit type with fallback to prevent undefined errors
                const industryType = div.type || 'Agriculture'; // Fallback for safety
                const industryData = await cc(ns, 'ns.corporation.getIndustryData(ns.args[0])', [industryType]);
                const materials = industryData?.producedMaterials || [];
                
                for (const materialName of materials) {
                    try {
                        const material = await cc(ns, 'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])', 
                            [div.name, city, materialName]);
                        
                        // Debug logging to see material status
                        if (material) {
                            log(ns, `DEBUG: ${div.name}/${city}/${materialName}: stored=${material.stored?.toFixed(2) || 0}, prod=${material.productionAmount?.toFixed(2) || 0}, sell=${material.actualSellAmount?.toFixed(2) || 0}`, false, 'info');
                        }
                        
                        // Check Smart Supply unlock before selling materials
                        const hasSmartSupply = await cc(ns, 'ns.corporation.hasUnlock("Smart Supply")');
                        if (hasSmartSupply && material && material.stored > 0) {
                            log(ns, `INFO: Selling ${material.stored.toFixed(2)} ${materialName} from ${div.name}/${city} at MAX/MP`, false, 'info');
                            await cc(ns, 'ns.corporation.sellMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3], ns.args[4])',
                                [div.name, city, materialName, 'MAX', 'MP']);
                            log(ns, `SUCCESS: Listed ${materialName} for sale from ${div.name}/${city}`, false, 'success');
                        }
                    } catch (e) {
                        log(ns, `WARN: Failed to sell ${materialName} from ${div.name}/${city}: ${e.message || e}`, false, 'warning');
                    }
                }
            } catch (e) {
                // Silent fail for cities without warehouses
            }
        }
    }
}
