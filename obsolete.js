import { log, getConfiguration, instanceCount, getNsDataThroughFile, getActiveSourceFiles } from './helpers.js';
// complete ussles rn , will delete later 
const argsSchema = [
    ['interval', 30000],
    ['no-tail-windows', false]
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options.noTailWindows) ns.tail();

    if (instanceCount(ns, 'corporation.js') > 1) {
        log(ns, 'INFO: Another corporation instance is already running. Exiting.');
        return;
    }

    const hasSingularity = 4 in getActiveSourceFiles(ns);
    if (!(await ensureCorporation(ns))) return;

    let loopCount = 0;
    while (loopCount < 10000) {
        try {
            await manage(ns, hasSingularity, loopCount);
        } catch (e) {
            log(ns, `ERROR: Exception in main loop: ${e}`);
        }
        await ns.sleep(options.interval);
        loopCount++;
    }
    log(ns, 'INFO: Reached loop limit and is exiting.');
}

async function manage(ns, hasSingularity, loopCount) {
    const corp = ns.corporation.getCorporation();

    if (!corp.divisions || corp.divisions.length === 0) {
        await createDivision(ns, corp);
        return;
    }

    await expandToCities(ns, corp);
    for (const division of corp.divisions) {
        await manageDivision(ns, corp, division);
    }

    await upgradeCorporation(ns, corp);
    await issueDividends(ns, corp);
    await purchaseSingularityAugmentations(ns, hasSingularity, loopCount);
}

async function createDivision(ns, corp) {
    const industry = 'Agriculture';
    const minimumFunds = 150_000_000;
    if (corp.funds < minimumFunds) {
        log(ns, `INFO: Waiting to create ${industry} division. Need ${ns.nFormat(minimumFunds, '$0.00a')}, currently have ${ns.nFormat(corp.funds, '$0.00a')}.`);
        return;
    }

    try {
        ns.corporation.expandIndustry(industry, `${industry} Division`);
        log(ns, `SUCCESS: Created ${industry} division.`);
    } catch (e) {
        log(ns, `ERROR: Failed to create ${industry} division: ${e}`);
    }
}

async function expandToCities(ns, corp) {
    const cities = ['Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima'];
    const division = corp.divisions[0];
    if (!division) return;

    for (const city of cities) {
        if (division.cities.includes(city)) continue;
        const cost = ns.corporation.getExpandCityCost();
        if (corp.funds <= cost * 3) continue;
        try {
            ns.corporation.expandCity(division.name, city);
            log(ns, `SUCCESS: Expanded ${division.name} to ${city}.`);
        } catch (e) {
            log(ns, `WARNING: Could not expand ${division.name} to ${city}: ${e}`);
        }
        return;
    }
}

async function manageDivision(ns, corp, division) {
    const hireCost = await getNsDataThroughFile(ns, 'ns.corporation.getEmployeePositionCost()', '/Temp/corp-hire-cost.txt');

    for (const city of division.cities) {
        const office = ns.corporation.getOffice(division.name, city);
        if (!office) continue;

        await hireEmployees(ns, corp, division, city, office, hireCost);
        assignJobs(ns, division, city, office.employees);
        await upgradeOffice(ns, corp, division, city, office);
        await manageWarehouse(ns, corp, division.name, city);
        await developProduct(ns, corp, division, city);
    }
}

async function hireEmployees(ns, corp, division, city, office, hireCost) {
    while (office.employees < office.size && corp.funds > hireCost * 6) {
        try {
            ns.corporation.hireEmployee(division.name, city);
            log(ns, `Hired employee in ${city} for ${division.name}.`);
            office.employees++;
        } catch (e) {
            break;
        }
    }
}

function assignJobs(ns, division, city, employees) {
    const ops = Math.max(1, Math.floor(employees * 0.4));
    const eng = Math.max(1, Math.floor(employees * 0.3));
    const bus = Math.max(0, employees - ops - eng);

    ns.corporation.setAutoJobAssignment(division.name, city, 'Operations', ops);
    ns.corporation.setAutoJobAssignment(division.name, city, 'Engineer', eng);
    ns.corporation.setAutoJobAssignment(division.name, city, 'Business', bus);
}

async function upgradeOffice(ns, corp, division, city, office) {
    if (office.size >= 20) return;
    const cost = ns.corporation.getOfficeSizeUpgradeCost(division.name, city, 1);
    if (corp.funds <= cost * 5) return;

    try {
        ns.corporation.upgradeOfficeSize(division.name, city, 1);
        log(ns, `Upgraded office in ${city} for ${division.name}.`);
    } catch (e) {
        log(ns, `WARNING: Could not upgrade office in ${city}: ${e}`);
    }
}

async function manageWarehouse(ns, corp, divisionName, city) {
    const warehouse = ns.corporation.getWarehouse(divisionName, city);
    if (!warehouse) {
        const cost = ns.corporation.getPurchaseWarehouseCost();
        if (corp.funds <= cost * 3) return;

        try {
            ns.corporation.purchaseWarehouse(divisionName, city);
            log(ns, `Purchased warehouse in ${city} for ${divisionName}.`);
        } catch (e) {
            log(ns, `WARNING: Could not purchase warehouse in ${city}: ${e}`);
        }
        return;
    }

    const cost = ns.corporation.getUpgradeWarehouseCost(divisionName, city);
    if (corp.funds <= cost * 5) return;

    try {
        ns.corporation.upgradeWarehouse(divisionName, city);
        log(ns, `Upgraded warehouse in ${city} for ${divisionName}.`);
    } catch (e) {
        log(ns, `WARNING: Could not upgrade warehouse in ${city}: ${e}`);
    }
}

async function developProduct(ns, corp, division, city) {
    if (!division.makesProducts || division.products.length >= 3) return;

    const productName = `Product-${division.products.length + 1}`;
    const cost = ns.corporation.getProductDevelopmentCost(division.name, productName);
    if (corp.funds <= cost * 2) return;

    try {
        ns.corporation.makeProduct(division.name, city, productName, cost / 2, cost / 2);
        log(ns, `Started developing ${productName} in ${city} for ${division.name}.`);
    } catch (e) {
        log(ns, `WARNING: Could not create ${productName}: ${e}`);
    }
}

async function upgradeCorporation(ns, corp) {
    const upgrades = ['Smart Factories', 'Smart Storage', 'FocusWires', 'Neural Accelerators', 'Speech Processor Implants', 'Nuoptimal Nootropic Injector Implants', 'Wilson Analytics'];
    for (const upgrade of upgrades) {
        const cost = ns.corporation.getUpgradeLevelCost(upgrade);
        if (corp.funds <= cost * 4) continue;

        try {
            ns.corporation.levelUpgrade(upgrade);
            log(ns, `Leveled up ${upgrade}.`);
        } catch (e) {
            log(ns, `WARNING: Could not level upgrade ${upgrade}: ${e}`);
        }
    }
}

async function issueDividends(ns, corp) {
    if (typeof ns.corporation.issueDividends !== 'function') return;
    if (corp.funds < 50_000_000 || corp.revenue <= corp.expenses) return;

    try {
        ns.corporation.issueDividends(0.05);
        log(ns, 'Issued 5% dividends to keep investors happy.');
    } catch (e) {
        log(ns, `WARNING: Could not issue dividends: ${e}`);
    }
}

async function purchaseSingularityAugmentations(ns, hasSingularity, loopCount) {
    if (!hasSingularity || loopCount % 100 !== 0) return;
    if (typeof ns.singularity.getOwnedAugmentations !== 'function') return;

    const corpAugs = ['Smart Supply', 'Smart Storage', 'DreamSense', 'Wilson Analytics', 'Nuoptimal Nootropic Injector Implants', 'Speech Processor Implants', 'Neural Accelerators', 'FocusWires'];
    const owned = ns.singularity.getOwnedAugmentations();
    const rep = ns.singularity.getFactionRep('Bachman & Associates');

    for (const aug of corpAugs) {
        if (owned.includes(aug)) continue;

        const cost = ns.singularity.getAugmentationPrice(aug);
        if (ns.getPlayer().money > cost && rep >= ns.singularity.getAugmentationRepReq(aug)) {
            try {
                ns.singularity.purchaseAugmentation('Bachman & Associates', aug);
                log(ns, `Purchased augmentation: ${aug}`);
            } catch (e) {
                log(ns, `WARNING: Could not purchase augmentation ${aug}: ${e}`);
            }
        }
    }
}
