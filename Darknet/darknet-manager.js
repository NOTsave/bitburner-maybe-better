import {
log, getConfiguration, instanceCount, getNsDataThroughFile,
formatMoney, formatDuration, formatNumberShort, disableLogs,
getActiveSourceFiles, getErrorInfo, asleep
} from '../helpers.js'

/**

    Darknet Automation Manager

    New Bitburner feature: The Darknet is a hidden network of services and

    contractors accessible through special terminals. Provides unique

    upgrades, contracts, and resource exchanges.

    This script:

        Connects to Darknet services automatically

        Manages Darknet contracts and reputation

        Purchases Darknet upgrades when beneficial

        Integrates with existing daemon.js infrastructure

    RAM Optimization: All API calls use ram-dodging via getNsDataThroughFile

    Base RAM: 1.6GB + dynamic (typically 0-4GB for temp scripts)
    */

// Configuration
const DARKNET_CONFIG = {
checkInterval: 30000, // Check every 30s
contractCheckInterval: 60000, // Check contracts every 60s
minFunds: 100e6, // Minimum funds before interacting
maxSpendPercent: 0.05, // Max 5% of funds per purchase cycle
reputationThreshold: 0.8, // Complete contracts above this success rate
autoAcceptContracts: true, // Auto-accept profitable contracts
upgradePriority: [ // Purchase order for Darknet upgrades
'Bandwidth', // More contracts available
'Processing', // Faster contract completion
'Encryption', // Better success rates
'Storage', // More simultaneous contracts
'Network' // Access to better contracts
]
};

// Ram-dodging helper
const cc = async (ns, cmd, args = []) =>
await getNsDataThroughFile(ns, cmd, `/Temp/darknet-${cmd.split('(')[0]}.txt`, args);

const argsSchema = [
['interval', 30000], // Check interval in ms
['reserve', null], // Reserve this much cash
['continuous', true], // Run continuously
['enable-logging', false], // Enable verbose logging
];

let options;
let hasDarknetAccess = false;
let lastContractCheck = 0;
let activeContracts = [];

export function autocomplete(data, args) {
data.flags(argsSchema);
return [];
}

/** @param {NS} ns */
export async function main(ns) {
const runOptions = getConfiguration(ns, argsSchema);
if (!runOptions || await instanceCount(ns) > 1) return;
options = runOptions;

disableLogs(ns, ['sleep', 'getServerMoneyAvailable']);

// Verify Darknet access (requires specific SourceFile or BN)
const sourceFiles = await getActiveSourceFiles(ns, true);
if (!hasDarknetAccess) {
try {
hasDarknetAccess = await cc(ns, 'typeof ns.darknet !== "undefined"');
} catch (e) {
return log(ns, 'INFO: Darknet API not available yet. Requires appropriate SourceFile or BitNode.', false, 'info');
}
}

if (!hasDarknetAccess) {
return log(ns, 'INFO: Darknet API not available.', false, 'info');
}

log(ns, '🌐 Darknet Manager started', false, 'success');
log(ns, `Checking every ${formatDuration(options.interval)}`, false, 'info');

// Initialize
await initializeDarknet(ns);

// Main loop
while (options.continuous) {
try {
const player = ns.getPlayer();
const reserve = options.reserve ?? Number(ns.read('reserve.txt') ?? 0);
const spendableFunds = player.money - reserve;

if (spendableFunds < DARKNET_CONFIG.minFunds) {
await asleep(ns, options.interval);
continue;
}

// Core operations
await manageDarknetServices(ns, spendableFunds);
await manageDarknetContracts(ns);
await manageDarknetUpgrades(ns, spendableFunds);

log(ns, `💰 Available: ${formatMoney(spendableFunds)} | Contracts: ${activeContracts.length} active`, false, 'info');

} catch (err) {
log(ns, `ERROR: Darknet manager error: ${getErrorInfo(err)}`, false, 'error');
}

await asleep(ns, options.interval);
}
}

/**

    Initialize Darknet - connect to services and scan available contracts

    @param {NS} ns
    */
    async function initializeDarknet(ns) {
    try {
    // Check current Darknet status
    const status = await cc(ns, 'ns.darknet.getStatus()');
    log(ns, `Darknet Status: ${JSON.stringify(status)}`, false, 'info');

    // Get available services
    const services = await cc(ns, 'ns.darknet.getServices()');
    log(ns, `Available services: ${services?.length || 0}`, false, 'info');

    // Get available upgrades
    const upgrades = await cc(ns, 'ns.darknet.getUpgrades()');
    if (upgrades && upgrades.length > 0) {
    log(ns, `Available upgrades: ${upgrades.map(u => u.name).join(', ')}`, false, 'info');
    }

    // Get active contracts
    activeContracts = await cc(ns, 'ns.darknet.getContracts()') || [];
    log(ns, `Active contracts: ${activeContracts.length}`, false, 'info');

    } catch (e) {
    log(ns, `ERROR: Initialization failed: ${getErrorInfo(e)}`, false, 'error');
    }
    }

/**

    Manage Darknet services - connect to beneficial services

    @param {NS} ns

    @param {number} spendableFunds
    */
    async function manageDarknetServices(ns, spendableFunds) {
    try {
    const services = await cc(ns, 'ns.darknet.getServices()');
    if (!services || services.length === 0) return;

    for (const service of services) {
    // Skip already connected services
    if (service.connected) continue;

    // Check if service is affordable
    const connectionCost = service.cost || 0;
    if (connectionCost > spendableFunds * 0.1) continue; // Max 10% of funds per service

    // Check reputation requirements
    if (service.reputationRequired > 0) {
    const rep = await cc(ns, 'ns.darknet.getReputation(ns.args[0])', [service.name]);
    if (rep < service.reputationRequired) continue;
    }

    // Connect to service
    const success = await cc(ns, 'ns.darknet.connectToService(ns.args[0])', [service.name]);
    if (success) {
    log(ns, `SUCCESS: Connected to ${service.name} (cost: ${formatMoney(connectionCost)})`, false, 'success');
    } else {
    log(ns, `WARN: Failed to connect to ${service.name}`, false, 'warning');
    }
    }
    } catch (e) {
    log(ns, `ERROR: Service management failed: ${getErrorInfo(e)}`, false, 'error');
    }
    }

/**

    Manage Darknet contracts - accept, monitor, complete

    @param {NS} ns
    */
    async function manageDarknetContracts(ns) {
    const now = Date.now();
    if (now - lastContractCheck < DARKNET_CONFIG.contractCheckInterval) return;
    lastContractCheck = now;

    try {
    // Get available contracts
    const available = await cc(ns, 'ns.darknet.getAvailableContracts()');
    if (!available || available.length === 0) return;

    // Filter by success rate and profitability
    const viableContracts = available.filter(c => {
    const successRate = c.estimatedSuccess || 0;
    const reward = c.reward || 0;
    const cost = c.cost || 0;
    const roi = cost > 0 ? (reward - cost) / cost : 0;

    return successRate >= DARKNET_CONFIG.reputationThreshold &&
    roi > 0.1; // At least 10% ROI
    });

    // Sort by best ROI
    viableContracts.sort((a, b) => {
    const roiA = ((a.reward || 0) - (a.cost || 0)) / (a.cost || 1);
    const roiB = ((b.reward || 0) - (b.cost || 0)) / (b.cost || 1);
    return roiB - roiA;
    });

    // Auto-accept best contracts
    const maxNewContracts = 3 - activeContracts.length;
    const toAccept = viableContracts.slice(0, Math.max(0, maxNewContracts));

    for (const contract of toAccept) {
    if (DARKNET_CONFIG.autoAcceptContracts) {
    const success = await cc(ns, 'ns.darknet.acceptContract(ns.args[0])', [contract.id]);
    if (success) {
    activeContracts.push(contract);
    log(ns, `📋 Accepted contract: ${contract.name} (ROI: ${((contract.reward - contract.cost) / contract.cost * 100).toFixed(1)}%)`, false, 'success');
    }
    }
    }

    // Monitor active contracts for completion
    const updatedContracts = [];
    for (const contract of activeContracts) {
    const status = await cc(ns, 'ns.darknet.getContractStatus(ns.args[0])', [contract.id]);

    if (!status || status.completed) {
    if (status?.success) {
    const reward = await cc(ns, 'ns.darknet.collectContractReward(ns.args[0])', [contract.id]);
    log(ns, `SUCCESS: Contract completed! Reward: ${formatMoney(reward)}`, false, 'success');
    } else if (status?.failed) {
    log(ns, `WARN: Contract failed: ${contract.name}`, false, 'warning');
    }
    continue; // Remove completed/failed contracts
    }

    updatedContracts.push({...contract, ...status});
    }

    activeContracts = updatedContracts;

    } catch (e) {
    log(ns, `ERROR: Contract management failed: ${getErrorInfo(e)}`, false, 'error');
    }
    }

/**

    Manage Darknet upgrades - purchase in priority order

    @param {NS} ns

    @param {number} spendableFunds
    */
    async function manageDarknetUpgrades(ns, spendableFunds) {
    try {
    const upgrades = await cc(ns, 'ns.darknet.getUpgrades()');
    if (!upgrades || upgrades.length === 0) return;

    const maxSpend = spendableFunds * DARKNET_CONFIG.maxSpendPercent;

    // Filter to affordable upgrades with priority order
    const affordableUpgrades = upgrades
    .filter(u => u.cost <= maxSpend && !u.purchased)
    .sort((a, b) => {
    const priorityA = DARKNET_CONFIG.upgradePriority.indexOf(a.type);
    const priorityB = DARKNET_CONFIG.upgradePriority.indexOf(b.type);
    // Sort by priority first, then by cost efficiency
    if (priorityA !== priorityB) return priorityA - priorityB;
    return (a.cost / (a.benefit || 1)) - (b.cost / (b.benefit || 1));
    });

    // Purchase the best upgrade
    if (affordableUpgrades.length > 0) {
    const upgrade = affordableUpgrades[0];
    const success = await cc(ns, 'ns.darknet.purchaseUpgrade(ns.args[0])', [upgrade.id]);

    if (success) {
    log(ns, `SUCCESS: Purchased ${upgrade.name} (${upgrade.type}) for ${formatMoney(upgrade.cost)}`, false, 'success');

    // Log benefit
    if (upgrade.description) {
    log(ns, `↳ ${upgrade.description}`, false, 'info');
    }
    } else {
    log(ns, `WARN: Failed to purchase ${upgrade.name}`, false, 'warning');
    }
    }

    } catch (e) {
    log(ns, `ERROR: Upgrade management failed: ${getErrorInfo(e)}`, false, 'error');
    }
    }

/**

    Get Darknet status summary for external scripts (e.g., stats.js)

    @param {NS} ns

    @returns {Object} Status summary
    */
    export async function getDarknetSummary(ns) {
    try {
    const status = await cc(ns, 'ns.darknet.getStatus()');
    const contracts = await cc(ns, 'ns.darknet.getContracts()');
    const reputation = await cc(ns, 'ns.darknet.getReputation()');

    return {
    connected: status?.connected || false,
    servicesCount: status?.services || 0,
    activeContracts: contracts?.length || 0,
    reputation: reputation || 0,
    income: status?.income || 0
    };
    } catch (e) {
    return { connected: false, error: getErrorInfo(e) };
    }
    }
