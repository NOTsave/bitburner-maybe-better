import { getFilePath, getNsDataThroughFile } from '../helpers.js'
const scriptSolver = getFilePath("/Tasks/contractor.js.solver.js");
const scriptLauncher = getFilePath('/Tasks/run-with-delay.js');

/** @param {NS} ns **/
export async function main(ns) {
    const servers = await getNsDataThroughFile(ns, `(() => {
        const [callerPid, collector, solver, launcher] = ns.args;
        const normalize = path => String(path).replace(/^\\//, '');
        const servers = scanAllServers(ns);
        const busy = servers.some(host => ns.ps(host).some(process => {
            const file = normalize(process.filename);
            return file === normalize(solver) ||
                (file === normalize(launcher) && normalize(process.args[0]) === normalize(solver)) ||
                (file === normalize(collector) && process.pid < callerPid);
        }));
        return busy ? [] : servers;
    })()`, '/Temp/contract-scan-servers.txt', [ns.pid, ns.getScriptName(), scriptSolver, scriptLauncher]);
    if (servers.length === 0)
        return ns.print("Another contractor is scanning or solving contracts.");

    const contracts = servers.flatMap(hostname => ns.ls(hostname, '.cct')
        .filter(contract => contract.endsWith('.cct')).map(contract => ({ contract, hostname })));
    if (contracts.length === 0)
        return ns.print("Found no contracts to solve.");

    // Keep the queries separate so only one coding-contract API is charged per worker.
    const collect = (entries, property, command, filename) => getNsDataThroughFile(ns,
        `JSON.parse(ns.args[0]).flatMap(c => {
            try {
                return [{ ...c, ${property}: ${command} }];
            } catch (error) {
                if (String(error?.message ?? error).includes("Cannot find contract")) return [];
                throw error;
            }
        })`, filename, [JSON.stringify(entries)]);
    const typed = await collect(contracts, 'type', 'ns.codingcontract.getContractType(c.contract, c.hostname)', '/Temp/contract-types.txt');
    if (typed.length === 0) return;
    const ready = await collect(typed, 'dataJson', 'JSON.stringify(ns.codingcontract.getData(c.contract, c.hostname), jsonReplacer)', '/Temp/contract-data-stringified.txt');
    ns.print(`Collected data for ${ready.length} of ${contracts.length} contracts.`);
    if (ready.length === 0) return;

    // Exit before the delayed launcher starts the solver to free RAM.
    const pid = ns.run(scriptLauncher, { temporary: true }, scriptSolver, 1, JSON.stringify(ready));
    if (!pid) ns.tprint(`ERROR: Could not start ${scriptLauncher} to solve ${ready.length} contracts.`);
}
