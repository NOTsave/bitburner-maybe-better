/** @param {NS} ns
 * Blindly try to open all ports and crack the specified target, regardless of owned tools. */
export async function main(ns) {
    const target = ns.args[0];
    ns.brutessh(target);
    ns.ftpcrack(target);
    ns.relaysmtp(target);
    ns.httpworm(target);
    ns.sqlinject(target);
    ns.nuke(target);
}