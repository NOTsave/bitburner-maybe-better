import {
    log, getConfiguration, instanceCount, getNsDataThroughFile,
    formatMoney, formatDuration, getErrorInfo
} from './helpers.js'
//tento kod je prakticky bez testu, bugy nejsps budou a je na vlastni nebezpeci, update nekdy 8 kvetna ig 
// ── Args schema ───────────────────────────────────────────────────────────────
const argsSchema = [
    ['tail',        false],   // Otevři log okno
    ['verbose',     false],   // Extra výpisy do terminálu
    ['skip-invest', false],   // Přeskoč investiční kola, jdi přímo na materiály/tobacco
    ['no-tobacco',  false],   // Zastav po Agriculture (bez Tobacco divize)
    ['corp-name',   'MegaCorp'],
    ['div-agri',    'Agriculture'],
    ['div-tobac',   'Tobacco'],
    ['home-city',   'Sector-12'],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

// ── Konstanty ─────────────────────────────────────────────────────────────────
const CITIES     = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const STATE_FILE = 'Temp/corp-state.txt';

const PHASE = {
    INIT:        0,
    SETUP_AGRI:  1,
    INVEST_1:    2,
    BUY_MATS:    3,
    INVEST_2:    4,
    SETUP_TOBAC: 5,
    PRODUCTS:    6,
    DONE:        99,
};

const AGRI_MATS = {
    Water:       300,
    Chemicals:   300,
    Hardware:    125,
    Robots:       96,
    AICores:      69,
    RealEstate: 200e3,
};

const STAFF = {
    agri1:  { Operations: 1, Engineer: 1, Business: 1, Management: 1, 'Research & Development': 1 },
    agri2:  { Operations: 3, Engineer: 2, Business: 2, Management: 2, 'Research & Development': 2 },
    tobac1: { Operations: 5, Engineer: 4, Business: 4, Management: 2, 'Research & Development': 3 },
    tobac2: { Operations: 8, Engineer: 6, Business: 6, Management: 4, 'Research & Development': 6 }, // 30 total for expanded office
};

let options; // globální pro přístup z pomocných funkcí

// ── Version Compatibility Layer ───────────────────────────────────────────────
let bitburnerVersion = "2.8.1"; // Default fallback
let apiVersion = 1; // 1 = legacy, 2 = modern

/** @param {NS} ns */
async function detectVersion(ns) {
    try {
        // Try to detect BitBurner version by testing API availability
        const version = await getNsDataThroughFile(ns, 'ns.getScriptVersion()', null);
        if (version) {
            bitburnerVersion = version;
            // Determine API version based on available functions
            try {
                await getNsDataThroughFile(ns, 'ns.getScriptPid()', null);
                apiVersion = 2; // Modern API
            } catch (_) {
                apiVersion = 1; // Legacy API (2.8.1 and earlier)
            }
        }
        log(ns, `DEBUG: Detected BitBurner ${bitburnerVersion}, API version ${apiVersion}`);
    } catch (_) {
        log(ns, `DEBUG: Could not detect version, assuming legacy API (2.8.1 compatible)`);
        apiVersion = 1;
    }
}

/** Get script PID with version compatibility */
async function getScriptPidCompat(ns) {
    if (apiVersion === 2) {
        return await getNsDataThroughFile(ns, 'ns.getScriptPid()', null);
    } else {
        // Legacy fallback - use process info from ps
        const scripts = await getNsDataThroughFile(ns, 'ns.ps(ns.args[0])', null, ["home"]);
        const currentScript = scripts.find(s => s.filename === 'corp.js');
        return currentScript?.pid ?? 0;
    }
}

/** Get AdVert count with version compatibility */
async function getAdVertCountCompat(ns, div) {
    if (apiVersion === 2) {
        try {
            return await getNsDataThroughFile(ns, 'ns.corporation.getHireAdVertCount(ns.args[0])', [div]);
        } catch (_) {
            return 0; // Fallback for modern versions
        }
    } else {
        return 0; // Legacy versions - start from 0
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────
/** @param {NS} ns */
export async function main(ns) {
    options = getConfiguration(ns, argsSchema);
    if (!options || await instanceCount(ns) > 1) return;

    // Detect BitBurner version and set compatibility mode
    await detectVersion(ns);

    ns.disableLog('ALL');
    ns.clearLog();
    if (options.tail) ns.tail();

    log(ns, '════════════════════════════════════════');
    log(ns, '  corp.js — Korporátní autopilot');
    log(ns, `  BitBurner ${bitburnerVersion} (API v${apiVersion}) · helpers.js kompatibilní`);
    log(ns, '════════════════════════════════════════');

    let corpState = loadState(ns);
    log(ns, `DEBUG: Loaded state - phase: ${corpState.phase}, productNum: ${corpState.productNum}, tobacExpanded: ${corpState.tobacExpanded ?? false}`);
    log(ns, `Načten stav: fáze ${corpState.phase}, produkt č. ${corpState.productNum ?? 1}`);

    // Check if corp.js is already running and kill previous instance
    const runningScripts = await getNsDataThroughFile(ns, 'ns.ps(ns.args[0])', null, ["home"]);
    const scriptPid = await getScriptPidCompat(ns);
    const existingCorp = runningScripts.find(s => s.filename.includes('corp.js') && s.pid !== scriptPid);
    if (existingCorp) {
        log(ns, `INFO: Found existing corp.js instance (pid: ${existingCorp.pid}), killing it...`, false, 'info');
        await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [existingCorp.pid]);
        await ns.sleep(1000); // Give it time to die
    }

    // Check if SF3 (Corporations) is available (RAM-optimized)
    const unlockedSFs = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedSourceFiles()', '/Temp/corp-sf-check.txt');
    if (!(3 in unlockedSFs)) {
        log(ns, 'ERROR: This script requires SF3 (Corporations) to run corporations.', true, 'error');
        log(ns, 'You do not have SF3. Please unlock BitNode 3 first to use corp.js.', true, 'error');
        return;
    }

    // Write a protection flag to prevent other scripts from killing this
    const protectionData = JSON.stringify({
        pid: scriptPid,
        startTime: Date.now(),
        lastCheck: Date.now()
    });
    ns.write('Temp/corp-protection.txt', protectionData, 'w');

    // Check if watchdog is already running (reuse existing runningScripts)
    const watchdogRunning = runningScripts.find(s => s.filename.includes('corp-watchdog.js'));
    if (!watchdogRunning) {
        log(ns, 'INFO: Starting corp-watchdog.js for protection...', false, 'info');
        const watchdogPid = ns.run('corp-watchdog.js', 1);
        if (watchdogPid === 0) {
            log(ns, 'WARNING: Failed to start watchdog, continuing without protection...', false, 'warning');
        }
    }

    if (options.tail) ns.tail();
    ns.disableLog('ALL');
    ns.clearLog();

    log(ns, '════════════════════════════════════════');
    log(ns, '  corp.js — Korporátní autopilot');
    log(ns, '  RAM-safe · helpers.js kompatibilní');
    log(ns, '════════════════════════════════════════');

    corpState = loadState(ns);
    log(ns, `DEBUG: Loaded state - phase: ${corpState.phase}, productNum: ${corpState.productNum}, tobacExpanded: ${corpState.tobacExpanded ?? false}`);
    log(ns, `Načten stav: fáze ${corpState.phase}, produkt č. ${corpState.productNum ?? 1}`);

    // Start protection monitoring with error handling and cleanup
    let protectionInterval;
    let protectionErrorCount = 0;
    const maxProtectionErrors = 5;
    
    const updateProtectionFile = () => {
        try {
            const currentProtectionData = JSON.stringify({
                pid: scriptPid,
                startTime: Date.now(),
                lastCheck: Date.now()
            });
            ns.write('Temp/corp-protection.txt', currentProtectionData, 'w');
            protectionErrorCount = 0; // Reset error count on success
        } catch (error) {
            protectionErrorCount++;
            log(ns, `WARNING: Failed to update protection file (${protectionErrorCount}/${maxProtectionErrors}): ${getErrorInfo(error)}`, false, 'warning');
            
            // If too many errors, stop trying to update protection
            if (protectionErrorCount >= maxProtectionErrors) {
                log(ns, 'ERROR: Too many protection file update failures, stopping protection updates', false, 'error');
                if (protectionInterval) clearInterval(protectionInterval);
            }
        }
    };
    
    protectionInterval = setInterval(updateProtectionFile, 5000); // Update every 5 seconds

    while (corpState.phase < PHASE.DONE) {
        try {
            const prevPhase = corpState.phase;
            log(ns, `DEBUG: Starting phase ${prevPhase} (productNum: ${corpState.productNum})`);
            corpState = await runPhase(ns, corpState);
            log(ns, `DEBUG: Completed phase ${prevPhase}, new phase: ${corpState.phase}`);
            
            // Update protection file after each phase
            updateProtectionFile();
        } catch (err) {
            log(ns, `WARNING: Chyba ve fázi ${corpState.phase}: ${getErrorInfo(err)}`, false, 'warning');
            log(ns, `DEBUG: Error details - phase: ${corpState.phase}, productNum: ${corpState.productNum}, error: ${err.message}`);
            await ns.sleep(5000);
        }
        await ns.sleep(300);
    }

    // Clean up protection file and interval when done with proper error handling
    if (protectionInterval) {
        clearInterval(protectionInterval);
        log(ns, 'INFO: Stopped protection monitoring', false, 'info');
    }
    
    // Remove protection file to signal completion
    try {
        ns.write('Temp/corp-protection.txt', '', 'w');
        log(ns, 'INFO: Cleaned up protection file', false, 'info');
    } catch (cleanupError) {
        log(ns, `WARNING: Failed to cleanup protection file: ${getErrorInfo(cleanupError)}`, false, 'warning');
    }

    // Reset state file to allow next run to start fresh
    try {
        ns.write(STATE_FILE, JSON.stringify({ phase: PHASE.INIT, productNum: 1 }), 'w');
        log(ns, 'INFO: Reset state file for next run', false, 'info');
    } catch (stateResetError) {
        log(ns, `WARNING: Failed to reset state file: ${getErrorInfo(stateResetError)}`, false, 'warning');
    }

    log(ns, 'SUCCESS: corp.js dokončen!', true, 'success');
}

// ── Stavový automat ───────────────────────────────────────────────────────────
/** @param {NS} ns */
async function runPhase(ns, state) {
    switch (state.phase) {

        case PHASE.INIT: {
            const hasCorp = await cc(ns, 'ns.corporation.hasCorporation()');
            if (!hasCorp) {
                log(ns, 'Fáze 0: Zakládám korporaci...');
                const ok = await cc(ns,
                    'ns.corporation.createCorporation(ns.args[0], true)',
                    [options['corp-name']]);
                if (!ok) {
                    log(ns, 'ERROR: Nelze vytvořit korporaci! Máš BN3 nebo dostatek $?', true, 'error');
                    state.phase = PHASE.DONE;
                    return saveState(ns, corpState);
                }
                await ns.sleep(1000);
            }

            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            const divs = corp?.divisions?.map(d => d.name) ?? [];
            if (!divs.includes(options['div-agri'])) {
                log(ns, `Zakládám divizi ${options['div-agri']}...`);
                await cc(ns,
                    'ns.corporation.expandIndustry(ns.args[0], ns.args[1])',
                    ['Agriculture', options['div-agri']]);
                await ns.sleep(500);
            }

            state.phase = PHASE.SETUP_AGRI;
            return saveState(ns, corpState);
        }

        case PHASE.SETUP_AGRI: {
            log(ns, 'Fáze 1: Nastavuji Agriculture...');
            const div = options['div-agri'];

            const hasSmartSupply = await cc(ns,
                'ns.corporation.hasUnlock(ns.args[0])', ['Smart Supply']);
            if (!hasSmartSupply) {
                await tc(ns, 'ns.corporation.purchaseUnlock(ns.args[0])', ['Smart Supply']);
            }

            for (const city of CITIES) {
                await tc(ns, 'ns.corporation.expandCity(ns.args[0], ns.args[1])',       [div, city]);
                await tc(ns, 'ns.corporation.purchaseWarehouse(ns.args[0], ns.args[1])', [div, city]);
                await tc(ns, 'ns.corporation.setSmartSupply(ns.args[0], ns.args[1], true)', [div, city]);
                await tc(ns, "ns.corporation.sellMaterial(ns.args[0], ns.args[1], 'Plants', 'MAX', 'MP')", [div, city]);
                await tc(ns, "ns.corporation.sellMaterial(ns.args[0], ns.args[1], 'Food', 'MAX', 'MP')",   [div, city]);
            }

            await expandOffices(ns, div, 9);
            await hireTo(ns, div, STAFF.agri1);
            await assignJobs(ns, div, STAFF.agri1);
            await buyAdvert(ns, div, 2);

            state.phase = options['skip-invest'] ? PHASE.BUY_MATS : PHASE.INVEST_1;
            return saveState(ns, corpState);
        }

        case PHASE.INVEST_1: {
            log(ns, 'Fáze 2: Čekám na investici kola 1 (min $210b)...');
            await waitForInvestOffer(ns, 1, 210e9);
            await cc(ns, 'ns.corporation.acceptInvestmentOffer()');
            log(ns, 'SUCCESS: Přijata investice kola 1!', true, 'success');
            state.phase = PHASE.BUY_MATS;
            return saveState(ns, corpState);
        }

        case PHASE.BUY_MATS: {
            log(ns, 'Fáze 3: Nakupuji materiály a upgraduji...');
            const div = options['div-agri'];

            await expandOffices(ns, div, 15);
            await hireTo(ns, div, STAFF.agri2);
            await assignJobs(ns, div, STAFF.agri2);

            for (const city of CITIES) {
                const wh = await cc(ns,
                    'ns.corporation.getWarehouse(ns.args[0], ns.args[1])', [div, city]);
                if (wh && wh.level < 10) {
                    await tc(ns,
                        'ns.corporation.upgradeWarehouse(ns.args[0], ns.args[1], ns.args[2])',
                        [div, city, 10 - wh.level]);
                }
            }

            await buyMaterials(ns, div, AGRI_MATS);
            await buyCorpUpgrades(ns);
            await buyTeaAndParties(ns, div);

            state.phase = options['skip-invest'] ? PHASE.SETUP_TOBAC : PHASE.INVEST_2;
            return saveState(ns, corpState);
        }

        case PHASE.INVEST_2: {
            log(ns, 'Fáze 4: Čekám na investici kola 2 (min $5t)...');
            await waitForInvestOffer(ns, 2, 5e12);
            await cc(ns, 'ns.corporation.acceptInvestmentOffer()');
            log(ns, 'SUCCESS: Přijata investice kola 2!', true, 'success');
            state.phase = options['no-tobacco'] ? PHASE.DONE : PHASE.SETUP_TOBAC;
            return saveState(ns, corpState);
        }

        case PHASE.SETUP_TOBAC: {
            log(ns, 'Fáze 5: Zakládám Tobacco divizi...');
            const div = options['div-tobac'];

            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            const divs = corp?.divisions?.map(d => d.name) ?? [];
            if (!divs.includes(div)) {
                await cc(ns,
                    'ns.corporation.expandIndustry(ns.args[0], ns.args[1])',
                    ['Tobacco', div]);
                await ns.sleep(500);
            }

            for (const city of CITIES) {
                await tc(ns, 'ns.corporation.expandCity(ns.args[0], ns.args[1])',        [div, city]);
                await tc(ns, 'ns.corporation.purchaseWarehouse(ns.args[0], ns.args[1])', [div, city]);
            }

            await expandOffices(ns, div, 15);
            await hireTo(ns, div, STAFF.tobac1);
            await assignJobs(ns, div, STAFF.tobac1);
            await buyAdvert(ns, div, 3);
            await buyTeaAndParties(ns, div);
            
            // Správa výzkumu pro Tobacco
            await manageResearch(ns, div);

            state.phase = PHASE.PRODUCTS;
            state.productNum = state.productNum ?? 1;
            return saveState(ns, corpState);
        }

        case PHASE.PRODUCTS: {
            await productLoop(ns, state);
            state.phase = PHASE.DONE;
            return saveState(ns, corpState);
        }

        default:
            state.phase = PHASE.DONE;
            return saveState(ns, corpState);
    }
}

// ── RAM-dodging wrappers ──────────────────────────────────────────────────────
async function cc(ns, command, args = []) {
    const match = command.match(/corporation\.(\w+)/);
    const fnName = match ? match[1] : 'call';
    return await getNsDataThroughFile(ns, command,
        `/Temp/corp-${fnName}.txt`, args);
}

async function tc(ns, command, args = []) {
    try { return await cc(ns, command, args); }
    catch (_) { return null; }
}

// ── Stavové funkce ─────────────────────────────────────────────────────────────
function loadState(ns) {
    try {
        const raw = ns.read(STATE_FILE);
        if (raw && raw.length > 2) return JSON.parse(raw);
    } catch (_) {}
    return { phase: PHASE.INIT, productNum: 1 };
}

function saveState(ns, state) {
    ns.write(STATE_FILE, JSON.stringify(state), 'w');
    return state;
}

/** Najde nejhorší produkt v seznamu */
async function findWorstProduct(ns, div, productNames) {
    let worst = null;
    let worstRating = Infinity;
    
    for (const name of productNames) {
        try {
            const p = await cc(ns,
                'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', [div, options['home-city'], name]);
            
            // PŘEZNÉ: Nikdy nevybírej produkt, který se ještě vyvíjí
            if (p && p.developmentProgress < 100) {
                log(ns, `DEBUG: Skipping ${name} - still in development (${p.developmentProgress.toFixed(1)}%)`);
                continue;
            }
            
            // Verze 2.8.1: rating je v p.rat
            const rating = p?.rat ?? 0;
            if (rating < worstRating) { 
                worstRating = rating; 
                worst = name; 
            }
        } catch (_) {
            log(ns, `DEBUG: Could not get product data for ${name}`);
        }
    }
    return worst ?? productNames[0];
}

/** Správa Research Points pro Tobacco divizi */
async function manageResearch(ns, div) {
    try {
        const research = await cc(ns, 'ns.corporation.getDivision(ns.args[0]).researchPoints', [div]);
        const corp = await cc(ns, 'ns.corporation.getCorporation()');
        
        if (!research || !corp) return;
        
        // Klíčové výzkumy pro Tobacco
        const keyResearch = [
            { name: 'Hi-Tech R&D Laboratory', cost: 500e9 },
            { name: 'uBiome', cost: 1e12 },
            { name: 'AutoBrew', cost: 250e9 },
            { name: 'Go-Juice', cost: 100e9 },
            { name: 'CPH4 Injections', cost: 750e9 }
        ];
        
        for (const researchItem of keyResearch) {
            try {
                const hasResearch = await cc(ns, 'ns.corporation.hasResearched(ns.args[0], ns.args[1])', [div, researchItem.name]);
                if (!hasResearch && research >= researchItem.cost && corp.funds > researchItem.cost * 2) {
                    await tc(ns, 'ns.corporation.research(ns.args[0], ns.args[1])', [div, researchItem.name]);
                    log(ns, `  Research: ${researchItem.name} (${formatMoney(researchItem.cost)})`);
                }
            } catch (_) {}
        }
    } catch (err) {
        log(ns, `DEBUG: Error managing research: ${getErrorInfo(err)}`);
    }
}

// ── Pomocné funkce ─────────────────────────────────────────────────────────────
async function expandOffices(ns, div, targetSize) {
    for (const city of CITIES) {
        try {
            const office = await cc(ns,
                'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div, city]);
            if (office && office.size < targetSize) {
                await tc(ns,
                    'ns.corporation.upgradeOfficeSize(ns.args[0], ns.args[1], ns.args[2])',
                    [div, city, targetSize - office.size]);
            }
        } catch (_) {}
        await ns.sleep(50);
    }
}

async function hireTo(ns, div, roleMap) {
    const targetEmployees = Object.values(roleMap).reduce((a, b) => a + b, 0);
    log(ns, `DEBUG: hireTo - division: ${div}, target: ${targetEmployees} employees`);
    
    for (const city of CITIES) {
        try {
            const office = await cc(ns,
                'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div, city]);
            if (!office) {
                log(ns, `DEBUG: No office found for ${div} in ${city}`);
                continue;
            }
            
            const currentEmployees = office.numEmployees ?? office.employees ?? 0;
            log(ns, `DEBUG: ${city} office - current: ${currentEmployees}, target: ${targetEmployees}, size: ${office.size}`);
            
            // Robustní najímání s pojistkou proti lagu
            let attempts = 0;
            const maxAttempts = targetEmployees - currentEmployees + 5; // +5 pojistka
            
            for (let i = currentEmployees; i < targetEmployees && attempts < maxAttempts; i++) {
                try {
                    const result = await tc(ns,
                        'ns.corporation.hireEmployee(ns.args[0], ns.args[1])', [div, city]);
                    
                    // Verze 2.8.1: kontrola, jestli najímání skutečně proběhlo
                    if (result !== null && result !== undefined) {
                        if (options.verbose) {
                            log(ns, `DEBUG: Hired employee ${i + 1}/${targetEmployees} in ${city}`);
                        }
                    } else {
                        if (options.verbose) {
                            log(ns, `DEBUG: Hire failed (null result) for employee ${i + 1} in ${city}`);
                        }
                        break; // Přerušit při selhání
                    }
                    await ns.sleep(100); // Malá pauza proti lagu
                } catch (err) { 
                    if (options.verbose) {
                        log(ns, `DEBUG: Failed to hire employee ${i + 1} in ${city}: ${getErrorInfo(err)}`);
                    }
                    break; // Přerušit při chybě
                }
                attempts++;
            }
        } catch (_) { 
            log(ns, `DEBUG: Error getting office for ${div} in ${city}`);
            continue; 
        }
        await ns.sleep(200); // Pauza mezi městy
    }
}

async function assignJobs(ns, div, roleMap) {
    const allRoles = [
        'Operations', 'Engineer', 'Business',
        'Management', 'Research & Development', 'Unassigned', 'Intern'
    ];
    for (const city of CITIES) {
        for (const role of allRoles) {
            await tc(ns,
                'ns.corporation.setAutoJobAssignment(ns.args[0], ns.args[1], ns.args[2], ns.args[3])',
                [div, city, role, 0]);
        }
        for (const [role, count] of Object.entries(roleMap)) {
            await tc(ns,
                'ns.corporation.setAutoJobAssignment(ns.args[0], ns.args[1], ns.args[2], ns.args[3])',
                [div, city, role, count]);
        }
        await ns.sleep(30);
    }
}

async function buyAdvert(ns, div, targetLevel) {
    let current = await getAdVertCountCompat(ns, div);
    
    while (current < targetLevel) {
        const ok = await tc(ns, 'ns.corporation.hireAdVert(ns.args[0])', [div]);
        if (ok === null) break;
        current++;
        await ns.sleep(100);
    }
    log(ns, `  ${div}: AdVert úroveň ${current}`);
}

async function buyMaterials(ns, div, mats) {
    log(ns, '  Spouštím nákup materiálů...');

    for (const city of CITIES) {
        for (const [mat, amt] of Object.entries(mats)) {
            await tc(ns,
                'ns.corporation.buyMaterial(ns.args[0], ns.args[1], ns.args[2], ns.args[3])',
                [div, city, mat, amt / 10]);
            await ns.sleep(20);
        }
    }

    // Čekej na naplnění jednoho vzorového města s kontrolou volného místa
    const sampleCity = CITIES[0];
    for (let tick = 0; tick < 200; tick++) {
        await ns.sleep(1500);
        let allDone = true;
        let hasWarehouseSpace = false;
        
        for (const [mat, amt] of Object.entries(mats)) {
            try {
                const m = await cc(ns,
                    'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                    [div, sampleCity, mat]);
                if (!m || m.qty < amt * 0.95) { 
                    allDone = false; 
                }
                // Kontrola volného místa ve skladu
                if (m && m.qty < (m.size ?? 1000)) {
                    hasWarehouseSpace = true;
                }
            } catch (_) { allDone = false; break; }
        }
        
        // Pokud je sklad plný a všechny materiály nejsou naplněny, upgrade sklad
        if (!allDone && !hasWarehouseSpace) {
            log(ns, `DEBUG: Warehouse full, attempting upgrade to make space for materials`);
            const upgradeCost = await cc(ns,
                'ns.corporation.getUpgradeWarehouseCost(ns.args[0], ns.args[1])', [div, sampleCity]);
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (corp && corp.funds > upgradeCost * 2) {
                await tc(ns, 'ns.corporation.upgradeWarehouse(ns.args[0], ns.args[1])', [div, sampleCity]);
                log(ns, `  Upgraded warehouse in ${sampleCity} for material storage (cost: ${formatMoney(upgradeCost)})`);
                await ns.sleep(2000); // Dej čas na upgrade
                continue; // Pokračuj v kontrole
            } else {
                log(ns, `DEBUG: Cannot upgrade warehouse - need ${formatMoney(upgradeCost * 2)}, have ${formatMoney(corp?.funds ?? 0)}`);
                // Pokud nemůžeme upgradovat, počkej déle na uvolnění místa
                await ns.sleep(5000); // Delší čekání
                continue;
            }
        }
        
        if (allDone) break;
        if (tick % 5 === 0) {
            try {
                const w = await cc(ns,
                    'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                    [div, sampleCity, 'Water']);
                log(ns, `  Čekám... Water: ${Math.floor(w?.qty ?? 0)}/${mats.Water} (space: ${hasWarehouseSpace ? 'yes' : 'no'})`);
            } catch (_) {}
        }
    }

    for (const city of CITIES) {
        for (const mat of Object.keys(mats)) {
            await tc(ns,
                'ns.corporation.buyMaterial(ns.args[0], ns.args[1], ns.args[2], 0)',
                [div, city, mat]);
            await ns.sleep(10);
        }
    }
    log(ns, '  Materiály nakoupeny!');
}

async function buyTeaAndParties(ns, div) {
    for (const city of CITIES) {
        await tc(ns, 'ns.corporation.buyTea(ns.args[0], ns.args[1])',          [div, city]);
        await tc(ns, 'ns.corporation.throwParty(ns.args[0], ns.args[1], 5e5)', [div, city]);
    }
}

async function waitForInvestOffer(ns, round, minFunds) {
    for (let tick = 0; ; tick++) {
        try {
            const offer = await cc(ns, 'ns.corporation.getInvestmentOffer()');
            if (offer && offer.round >= round && offer.funds >= minFunds) {
                log(ns, `SUCCESS: Investiční nabídka kola ${round}: ${formatMoney(offer.funds)}`, true, 'success');
                return;
            }
            if (tick % 15 === 0) {
                const funds = offer?.funds ?? 0;
                const pct = minFunds > 0 ? (funds / minFunds * 100).toFixed(1) : '?';
                log(ns, `  Čekám na kolo ${round}: ${formatMoney(funds)} / ${formatMoney(minFunds)} (${pct}%)`);
                
                // Zkontroluj a oprav plné sklady
                await checkAndUpgradeWarehouses(ns, options['div-agri']);
                
                // Boost both agriculture and tobacco divisions during wait
                await buyTeaAndParties(ns, options['div-agri']);
                if (round >= 2) {
                    try { await buyTeaAndParties(ns, options['div-tobac']); } catch (_) {}
                }
            }
        } catch (_) {}
        await ns.sleep(3000);
    }
}

async function buyCorpUpgrades(ns) {
    const upgrades = [
        'Wilson Analytics', 'Project Insight', 'Smart Factories',
        'Smart Storage', 'Nuoptimal Nootropic Injector Implants',
        'Speech Processor Implants', 'Neural Accelerators',
        'FocusWires', 'ABC SalesBots',
    ];
    
    // Sanity check that corporation exists
    try {
        await cc(ns, 'ns.corporation.getCorporation()');
    } catch (_) { return; }

    for (const upg of upgrades) {
        try {
            // Buy multiple levels if we have funds, refetch funds each level
            for (let lvl = 0; lvl < 5; lvl++) {
                const corp = await cc(ns, 'ns.corporation.getCorporation()');
                const funds = corp?.funds ?? 0;
                const cost = await cc(ns, 'ns.corporation.getUpgradeLevelCost(ns.args[0])', [upg]);
                if (!cost || cost >= funds * 0.05) break;
                
                await tc(ns, 'ns.corporation.levelUpgrade(ns.args[0])', [upg]);
                log(ns, `  Upgrade: ${upg} level ${lvl + 1} (${formatMoney(cost)})`);
            }
        } catch (_) {}
        await ns.sleep(30);
    }
}

async function productLoop(ns, state) {
    const div = options['div-tobac'];
    const homeCity = options['home-city'];
    log(ns, `INFO: Spouštím Product Loop pro ${div}...`, true, 'info');
    log(ns, `DEBUG: productLoop - division: ${div}, homeCity: ${homeCity}, productNum: ${state.productNum}`);

    while (true) {
        const division = await tc(ns, 'ns.corporation.getDivision(ns.args[0])', [div]);
        const products = division?.products ?? [];
        
        // 1. Správa stávajících produktů (nastavení prodeje)
        for (const pname of products) {
            const p = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', [div, homeCity, pname]);
            if (p && p.developmentProgress >= 100 && p.sName === undefined) {
                // Pokud produkt dokončil vývoj a ještě se neprodává, nastav prodej
                await tc(ns, "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP', true)", 
                    [div, homeCity, pname]);
                if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.II'])) {
                    await tc(ns, 'ns.corporation.setProductMarketTA2(ns.args[0], ns.args[1], true)', [div, pname]);
                }
                log(ns, `SUCCESS: Produkt ${pname} uveden na trh!`, false, 'success');
            }
        }

        // 2. Vývoj nového produktu
        if (products.length < 3 || (products.length === 3 && products.every(async p => 
            (await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', [div, homeCity, p])).developmentProgress >= 100))) {
            
            if (products.length >= 3) {
                const worst = await findWorstProduct(ns, div, products);
                if (worst) {
                    log(ns, `INFO: Ruším nejhorší produkt: ${worst}`, false, 'info');
                    await tc(ns, 'ns.corporation.discontinueProduct(ns.args[0], ns.args[1])', [div, worst]);
                }
            }

            const productName = `Cig-v${state.productNum}`;
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            
            // Dynamická investice podle fáze
            let investment;
            if (corp.funds > 1e12) { // Late game: 2% funds, max 2T
                investment = Math.min(corp.funds * 0.02, 2e12);
            } else if (corp.funds > 500e9) { // Mid game: 1.5% funds, max 500B
                investment = Math.min(corp.funds * 0.015, 500e9);
            } else { // Early game: 1% funds, max 100B
                investment = Math.min(corp.funds * 0.01, 100e9);
            }

            const ok = await tc(ns, 'ns.corporation.makeProduct(ns.args[0], ns.args[1], ns.args[2], ns.args[3], ns.args[3])', 
                [div, homeCity, productName, investment, investment]);
            
            if (ok) {
                log(ns, ` Vyvíjím nový produkt: ${productName} (Investice: ${formatMoney(investment)} - ${(investment/corp.funds*100).toFixed(1)}% fondů)`);
                state.productNum++;
                saveState(ns, corpState);
            } else {
                log(ns, ` Vývoj produktu selhal, zkouším znovu za 10s...`);
                await ns.sleep(10000);
                continue;
            }

            // Čekej na dokončení vývoje
            let lastPct = -1;
            while (true) {
                await ns.sleep(3000);
                try {
                    const p = await cc(ns,
                        'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])',
                        [div, homeCity, productName]);
                    if (!p) {
                        log(ns, `DEBUG: Could not get product data for ${productName}`);
                        break;
                    }
                    if (p.developmentProgress >= 100) {
                        log(ns, ` ${productName} vývoj dokončen (${p.developmentProgress.toFixed(1)}%)`);
                        break;
                    }
                    const pct = Math.floor(p.developmentProgress / 10) * 10;
                    if (pct !== lastPct) { 
                        log(ns, `  ${productName}: ${p.developmentProgress.toFixed(1)}%`); 
                        lastPct = pct; 
                    }
                } catch (err) { 
                    log(ns, `DEBUG: Error monitoring ${productName} development: ${getErrorInfo(err)}`);
                    break; 
                }
            }

            // Nastavení prodeje po dokončení vývoje
            for (const city of CITIES) {
                await tc(ns,
                    "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP', true)", 
                    [div, city, productName]);
                // Aktivuj Market TA1 a TA2 pro lepší ceny
                await tc(ns, 'ns.corporation.setMarketTA1(ns.args[0], ns.args[1], ns.args[2], true)', 
                    [div, city, productName]);
                await tc(ns, 'ns.corporation.setMarketTA2(ns.args[0], ns.args[1], ns.args[2], true)', 
                    [div, city, productName]);
                // Aktivuj Market-TA.II (Technical Analysis) pro maximální profit
                await tc(ns, 'ns.corporation.setProductMarketTA2(ns.args[0], ns.args[1], true)', 
                    [div, city, productName]);
                await ns.sleep(20);
            }

            log(ns, ` ${productName} je na trhu!`, true, 'success');
        }

        // 3. Údržba a expanze během čekání
        await buyTeaAndParties(ns, div);
        await manageResearch(ns, div);
        await buyCorpUpgrades(ns);

        // Expanze kanceláří Tobacco po prvním produktu
        if (!state.tobacExpanded) {
            log(ns, "INFO: Expanduji Tobacco týmy pro vyšší Research...", false, 'info');
            await expandOffices(ns, div, 30);
            await hireTo(ns, div, STAFF.tobac2);
            await assignJobs(ns, div, STAFF.tobac2);
            state.tobacExpanded = true;
            saveState(ns, corpState);
        }
        
        await ns.sleep(30000); // Cyklus jednou za 30s (produkty trvají dlouho)
    }
}

async function findWorstProduct(ns, div, productNames) {
    let worst = null;
    let worstRating = Infinity;
    
    for (const name of productNames) {
        try {
            const p = await cc(ns,
                'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', [div, options['home-city'], name]);
            
            // PŘEZNÉ: Nikdy nevybírej produkt, který se ještě vyvíjí
            if (p && p.developmentProgress < 100) {
                log(ns, `DEBUG: Skipping ${name} - still in development (${p.developmentProgress.toFixed(1)}%)`);
                continue;
            }
            
            // Verze 2.8.1: rating je v p.rat
            const rating = p?.rat ?? 0;
            if (rating < worstRating) { 
                worstRating = rating; 
                worst = name; 
            }
        } catch (_) {
            log(ns, `DEBUG: Could not get product data for ${name}`);
        }
    }
    return worst ?? productNames[0];
}
