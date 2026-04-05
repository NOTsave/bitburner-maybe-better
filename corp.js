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
};

let options; // globální pro přístup z pomocných funkcí

// ── Main ─────────────────────────────────────────────────────────────────────
/** @param {NS} ns */
export async function main(ns) {
    options = getConfiguration(ns, argsSchema);
    if (!options || await instanceCount(ns) > 1) return;

    if (options.tail) ns.tail();
    ns.disableLog('ALL');
    ns.clearLog();

    log(ns, '════════════════════════════════════════');
    log(ns, '  corp.js — Korporátní autopilot');
    log(ns, '  RAM-safe · helpers.js kompatibilní');
    log(ns, '════════════════════════════════════════');

    let state = loadState(ns);
    log(ns, `Načten stav: fáze ${state.phase}, produkt č. ${state.productNum ?? 1}`);

    while (state.phase < PHASE.DONE) {
        try {
            state = await runPhase(ns, state);
        } catch (err) {
            log(ns, `WARNING: Chyba ve fázi ${state.phase}: ${getErrorInfo(err)}`, false, 'warning');
            await ns.sleep(5000);
        }
        await ns.sleep(300);
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
                    return saveState(ns, state);
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
            return saveState(ns, state);
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
            return saveState(ns, state);
        }

        case PHASE.INVEST_1: {
            log(ns, 'Fáze 2: Čekám na investici kola 1 (min $210b)...');
            await waitForInvestOffer(ns, 1, 210e9);
            await cc(ns, 'ns.corporation.acceptInvestmentOffer()');
            log(ns, 'SUCCESS: Přijata investice kola 1!', true, 'success');
            state.phase = PHASE.BUY_MATS;
            return saveState(ns, state);
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
            return saveState(ns, state);
        }

        case PHASE.INVEST_2: {
            log(ns, 'Fáze 4: Čekám na investici kola 2 (min $5t)...');
            await waitForInvestOffer(ns, 2, 5e12);
            await cc(ns, 'ns.corporation.acceptInvestmentOffer()');
            log(ns, 'SUCCESS: Přijata investice kola 2!', true, 'success');
            state.phase = options['no-tobacco'] ? PHASE.DONE : PHASE.SETUP_TOBAC;
            return saveState(ns, state);
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

            state.phase = PHASE.PRODUCTS;
            state.productNum = state.productNum ?? 1;
            return saveState(ns, state);
        }

        case PHASE.PRODUCTS: {
            await productLoop(ns, state);
            state.phase = PHASE.DONE;
            return saveState(ns, state);
        }

        default:
            state.phase = PHASE.DONE;
            return saveState(ns, state);
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
    const total = Object.values(roleMap).reduce((a, b) => a + b, 0);
    for (const city of CITIES) {
        for (let i = 0; i < total + 5; i++) {
            try {
                const office = await cc(ns,
                    'ns.corporation.getOffice(ns.args[0], ns.args[1])', [div, city]);
                if (!office || office.employees >= total) break;
                await tc(ns,
                    'ns.corporation.hireEmployee(ns.args[0], ns.args[1])', [div, city]);
            } catch (_) { break; }
            await ns.sleep(30);
        }
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
    let current = 0;
    try {
        current = await cc(ns,
            'ns.corporation.getHireAdVertCount(ns.args[0])', [div]);
    } catch (_) {}
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

    const sampleCity = CITIES[0];
    for (let tick = 0; tick < 200; tick++) {
        await ns.sleep(1500);
        let allDone = true;
        for (const [mat, amt] of Object.entries(mats)) {
            try {
                const m = await cc(ns,
                    'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                    [div, sampleCity, mat]);
                if (!m || m.qty < amt * 0.95) { allDone = false; break; }
            } catch (_) { allDone = false; break; }
        }
        if (allDone) break;
        if (tick % 5 === 0) {
            try {
                const w = await cc(ns,
                    'ns.corporation.getMaterial(ns.args[0], ns.args[1], ns.args[2])',
                    [div, sampleCity, 'Water']);
                log(ns, `  Čekám... Water: ${Math.floor(w?.qty ?? 0)}/${mats.Water}`);
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
                log(ns, `  Nabídka kola ${round}: ${formatMoney(offer.funds)}`);
                return;
            }
            if (tick % 15 === 0) {
                const funds = offer?.funds ?? 0;
                const pct = minFunds > 0 ? (funds / minFunds * 100).toFixed(1) : '?';
                log(ns, `  Čekám na kolo ${round}: ${formatMoney(funds)} / ${formatMoney(minFunds)} (${pct}%)`);
                await buyTeaAndParties(ns, options['div-agri']);
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
    let funds = 0;
    try {
        const corp = await cc(ns, 'ns.corporation.getCorporation()');
        funds = corp?.funds ?? 0;
    } catch (_) { return; }

    for (const upg of upgrades) {
        try {
            const cost = await cc(ns,
                'ns.corporation.getUpgradeLevelCost(ns.args[0])', [upg]);
            if (cost && cost < funds * 0.05) {
                await tc(ns, 'ns.corporation.levelUpgrade(ns.args[0])', [upg]);
                funds -= cost;
                log(ns, `  Upgrade: ${upg} (${formatMoney(cost)})`);
            }
        } catch (_) {}
        await ns.sleep(30);
    }
}

async function productLoop(ns, state) {
    const div      = options['div-tobac'];
    const homeCity = options['home-city'];
    log(ns, `INFO: Spouštím Product Loop pro ${div}...`, true, 'info');

    while (true) {
        const productName = `Cig-v${state.productNum}`;
        log(ns, `\nVyvíjím: ${productName}`);

        let launched = false;
        for (let attempt = 0; attempt < 3 && !launched; attempt++) {
            try {
                await cc(ns,
                    'ns.corporation.makeProduct(ns.args[0], ns.args[1], ns.args[2], 1e9, 1e9)',
                    [div, homeCity, productName]);
                launched = true;
            } catch (_) {
                const products = await tc(ns,
                    'ns.corporation.getDivision(ns.args[0]).products', [div]);
                if (products && products.length >= 3) {
                    const worst = await findWorstProduct(ns, div, products);
                    if (worst) {
                        log(ns, `  Mažu: ${worst}`);
                        await tc(ns,
                            'ns.corporation.discontinueProduct(ns.args[0], ns.args[1])',
                            [div, worst]);
                    }
                }
                await ns.sleep(2000);
            }
        }

        if (!launched) {
            log(ns, `  Vývoj selhal, zkouším za 10s...`);
            await ns.sleep(10000);
            continue;
        }

        let lastPct = -1;
        while (true) {
            await ns.sleep(3000);
            try {
                const p = await cc(ns,
                    'ns.corporation.getProduct(ns.args[0], ns.args[1])',
                    [div, productName]);
                if (!p || p.developmentProgress >= 99.9) break;
                const pct = Math.floor(p.developmentProgress / 10) * 10;
                if (pct !== lastPct) { log(ns, `  ${productName}: ${p.developmentProgress.toFixed(1)}%`); lastPct = pct; }
            } catch (_) { break; }
        }
        log(ns, `  ${productName} hotov!`);

        for (const city of CITIES) {
            await tc(ns,
                "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP*1', true)",
                [div, city, productName]);
            await ns.sleep(20);
        }

        await buyTeaAndParties(ns, div);
        await buyCorpUpgrades(ns);

        try {
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (corp && corp.funds > 50e9) {
                await expandOffices(ns, div, 30);
                await hireTo(ns, div, STAFF.tobac1);
                await assignJobs(ns, div, STAFF.tobac1);
            }
        } catch (_) {}

        state.productNum++;
        saveState(ns, state);
        await ns.sleep(5000);
    }
}

async function findWorstProduct(ns, div, products) {
    let worst = null;
    let worstRating = Infinity;
    for (const name of products) {
        try {
            const p = await cc(ns,
                'ns.corporation.getProduct(ns.args[0], ns.args[1])', [div, name]);
            const rating = p?.rat ?? p?.rating ?? p?.effectiveRating ?? 0;
            if (rating < worstRating) { worstRating = rating; worst = name; }
        } catch (_) {}
    }
    return worst ?? products[0];
}
