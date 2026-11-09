// This is a proof-of-concept script that can continuously push changes to scripts on your home server to all other servers.
// Run this script once to push the latest version of your scripts any other servers that have a copy.
// Warning: If you keep try to edit and save a file while this script is running, it will probably crash your game the first time you save a file.
const loopingMode = false;
const home = "home";

/** @param {NS} ns */
export async function main(ns) {
    let scan = (server, parent) => ns.scan(server)
        .map(newServer => newServer != parent ? scan(newServer, server) : server).flat();
    ["scan", "scp"].forEach(log => ns.disableLog(log));
    const serverList = scan(home);
    do {
        const fileList = ns.ls(home);
        const latestContents = Object.fromEntries(fileList.map(s => [s, ns.read(s)]));
        for (const server of serverList.filter(s => s != home)) {
            const serverFiles = ns.ls(server); // What files does the server have
            for (const file of serverFiles.filter(s => fileList.includes(s))) {
                if (!ns.scp(file, home, server)) {
                    ns.tprint(`WARNING: Could not read ${file} from ${server} for sync.`);
                    continue;
                }
                if (ns.read(file) != latestContents[file]) { // Remote file was out of date.
                    ns.print(`The file ${file} was out of date on ${server}. Updating...`);
                    await ns.write(file, latestContents[file], "w"); // Restore original home file
                    if (!ns.scp(file, server, home)) {
                        ns.tprint(`WARNING: Could not update ${file} on ${server}.`);
                        continue;
                    }
                    const runningInstances = ns.ps(server).filter(p => p.filename == file);
                    for (const p of runningInstances) {
                        if (!ns.kill(p.pid)) continue; // The old instance may have already exited.
                        let failure = 'exec returned 0';
                        try {
                            if (ns.exec(p.filename, server, p.threads, ...p.args)) continue;
                        } catch (error) {
                            failure = String(error);
                        }
                        ns.tprint(`ERROR: Could not restart ${p.filename} on ${server} (PID ${p.pid}, ${p.threads} threads, args ${JSON.stringify(p.args)}): ${failure}`);
                    }
                }
            }
        }
        if (loopingMode) await ns.sleep(1000);
    } while (loopingMode);
}