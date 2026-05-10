import { formatMoney, formatRam, getConfiguration, getNsDataThroughFile, log } from '../helpers.js'

const MAX_RAM = 2 ** 30; // 1PB (max possible in most BNs)
const argsSchema = [
    ['budget', 0.2], // Spend up to this fraction of available money per upgrade
    ['reserve', -1], // Reserve this much cash (defaults to contents of reserve.txt)
    ['interval', 10000], // Check every 10 seconds
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;

    // Validate budget
    if (isNaN(options.budget) || options.budget <= 0 || options.budget > 1) {
        log(ns, `ERROR: Invalid budget value: ${options.budget}. Must be between 0 and 1.`, true, "error");
        return;
    }

    // Check Singularity API availability
    if (!ns.singularity) {
        log(ns, "ERROR: Singularity API not available. This script requires SF4.", true, "error");
        return;
    }

    // Read reserve (once, with fallback)
    const reserveFileValue = (ns.read("reserve.txt") || "0").trim();
    const reserve = options.reserve !== -1 ? options.reserve : Number(reserveFileValue);
    if (isNaN(reserve)) {
        log(ns, `ERROR: Invalid reserve value in reserve.txt: "${reserveFileValue}"`, true, "error");
        return;
    }

    // Cache API results to reduce calls
    let cachedRamData = null;
    let lastRamUpdate = 0;
    const RAM_CACHE_TTL = 5000; // 5 seconds

    async function getRamData(ns) {
        const now = Date.now();
        if (cachedRamData && now - lastRamUpdate < RAM_CACHE_TTL) {
            return cachedRamData;
        }
        const [money, currentRam, upgradeCost] = await getNsDataThroughFile(
            ns,
            `[
                ns.getServerMoneyAvailable("home"),
                ns.getServerMaxRam("home"),
                ns.singularity.getUpgradeHomeRamCost()
            ]`,
            "/Temp/ram-manager-data.json"
        );
        cachedRamData = { money, currentRam, upgradeCost };
        lastRamUpdate = now;
        return cachedRamData;
    }

    // Main loop
    while (true) {
        try {
            // Get current stats (with caching)
            const { money, currentRam, upgradeCost } = await getRamData(ns);

            // Validate data
            if (money === undefined || currentRam === undefined || upgradeCost === undefined) {
                log(ns, "ERROR: Failed to read game state. Retrying...", true, "error");
                await ns.sleep(5000);
                continue;
            }

            // Check if already maxed
            if (currentRam >= MAX_RAM) {
                log(ns, `Home RAM already maxed at ${formatRam(MAX_RAM)}. Exiting.`, true, "info");
                return;
            }

            // Calculate spendable money
            const spendable = Math.min(money - reserve, money * options.budget);
            if (spendable <= 0) {
                log(ns, `Insufficient funds. Spendable: ${formatMoney(spendable)} (Reserve: ${formatMoney(reserve)})`, true, "info");
                await ns.sleep(options.interval);
                continue;
            }

            // Check if upgrade is affordable
            if (upgradeCost > spendable || upgradeCost === Infinity) {
                log(ns, `Cannot afford upgrade (Cost: ${formatMoney(upgradeCost)}, Spendable: ${formatMoney(spendable)}).`, true, "info");
                await ns.sleep(options.interval);
                continue;
            }

            // Attempt upgrade
            const success = await getNsDataThroughFile(
                ns,
                `ns.singularity.upgradeHomeRam()`,
                null,
                [],
                false,
                3,    // maxRetries
                1000  // retryDelayMs
            );

            if (success) {
                log(ns, `SUCCESS: Upgraded home RAM from ${formatRam(currentRam)} to ${formatRam(currentRam * 2)} for ${formatMoney(upgradeCost)}.`, true, "success");
            } else {
                log(ns, "WARN: Failed to upgrade home RAM. Retrying...", true, "warning");
            }

            await ns.sleep(options.interval);
        } catch (e) {
            log(ns, `ERROR: Critical error in ram-manager: ${e.message || e}`, true, "error");
            await ns.sleep(5000); // Wait before retrying
        }
    }
}