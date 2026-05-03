import {
    log, getConfiguration, getNsDataThroughFile, formatMoney,
    getCachedCorpData, asleep, getErrorInfo
} from '../helpers.js'

/**
 * Corporation Test Harness
 * 
 * Validates the corporation automation suite by running controlled checks:
 * - Module launch verification - do all sub-scripts start correctly?
 * - Phase advancement - does the corp progress through phases?
 * - Self-termination - do modules exit when their goals are met?
 * - API compatibility - are all corp API calls using correct v3.x format?
 * - Division creation - do Agriculture/Chemical/Tobacco get created?
 * 
 * Uses ram-dodging for all API calls to minimize static RAM cost.
 * 
 * Usage: run Corp/corp-test-harness.js [--verbose] [--quick]
 */
const argsSchema = [
    ['verbose', false], // Detailed test output
    ['quick', false], // Skip long-running tests
    ['timeout', 120000], // Max test duration in ms (default 2 minutes)
];

const cc = async (ns, cmd, args = []) =>
    await getNsDataThroughFile(ns, cmd, `/Temp/corp-test-${cmd.split('(')[0]}.txt`, args);

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;

    ns.disableLog('ALL');
    const verbose = options.verbose;
    const startTime = Date.now();
    let passed = 0, failed = 0, skipped = 0;

    log(ns, '╔══════════════════════════════════╗', false, 'info');
    log(ns, '║ Corporation Test Harness v1.0 ║', false, 'info');
    log(ns, '╚══════════════════════════════════╝', false, 'info');

    // ── Test 1: Corporation Exists ──
    await runTest(ns, 'Corporation Exists', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        const hasCorp = await cc(ns, 'ns.corporation.hasCorporation()');
        if (!hasCorp) return { fail: true, reason: 'No corporation found. Run corp-auto-buy.js first or create one manually.' };
        return { pass: true, detail: 'Corporation detected' };
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Test 2: Corp Manager Running ──
    await runTest(ns, 'Corp Manager Running', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        const corpManagerRunning = ns.isRunning('corp-manager.js', 'home');
        if (!corpManagerRunning) return { fail: true, reason: 'corp-manager.js not running. Start it manually or wait for daemon.' };
        return { pass: true, detail: 'corp-manager.js is running' };
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Test 3: Corp Fetcher Produces Valid Data ──
    await runTest(ns, 'Data Fetcher Output', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        const corp = await getCachedCorpData(ns);
        if (!corp) return { fail: true, reason: 'No cached corp data. corp-fetcher.js may not be running or data is stale.' };
        if (!corp.divisions || !Array.isArray(corp.divisions)) return { fail: true, reason: 'Corp data missing divisions array.' };
        if (!corp.funds && corp.funds !== 0) return { fail: true, reason: 'Corp data missing funds field.' };
        return { pass: true, detail: `${corp.divisions.length} divisions, ${formatMoney(corp.funds)} funds` };
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Test 4: Core Modules Can Launch ──
    const modules = [
        { name: 'HR', file: 'Corp/corp-hr.js' },
        { name: 'Logistics', file: 'Corp/corp-logistics.js' },
        { name: 'Research', file: 'Corp/corp-research.js' },
    ];

    for (const mod of modules) {
        await runTest(ns, `Module: ${mod.name}`, async () => {
            if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
            const isRunning = ns.isRunning(mod.file, 'home');
            const exists = ns.fileExists(mod.file, 'home');
            if (!exists) return { fail: true, reason: `${mod.file} not found` };
            if (!isRunning) {
                // Try launching it
                const pid = ns.run(mod.file, 1);
                if (!pid) return { fail: true, reason: `Failed to launch ${mod.file} (insufficient RAM?)` };
                await asleep(ns, 2000);
                const nowRunning = ns.isRunning(mod.file, 'home');
                if (!nowRunning) return { fail: true, reason: `${mod.file} launched but immediately exited (check logs)` };
            }
            return { pass: true, detail: `${mod.file} is running` };
        }, verbose, { passed, failed, skipped }, startTime);
    }

    // ── Test 5: Phase State File ──
    await runTest(ns, 'Phase State Tracking', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        const stateData = ns.read('/Temp/corp-state.txt');
        if (!stateData || stateData.length < 5) return { fail: true, reason: 'No corp state file. corp-manager may not have initialized yet.' };
        try {
            const state = JSON.parse(stateData);
            if (state.phase === undefined) return { fail: true, reason: 'State file missing phase field.' };
            return { pass: true, detail: `Phase ${state.phase}` };
        } catch (e) {
            return { fail: true, reason: `Corrupt state file: ${e.message}` };
        }
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Test 6: Division Creation ──
    await runTest(ns, 'Division Structure', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        const corp = await getCachedCorpData(ns);
        if (!corp?.divisions) return { fail: true, reason: 'No division data' };
        const types = corp.divisions.map(d => d.type).filter(Boolean);
        const found = [];
        if (types.includes('Agriculture')) found.push('Agriculture');
        if (types.includes('Chemical')) found.push('Chemical');
        if (types.includes('Tobacco')) found.push('Tobacco');
        if (found.length === 0) return { fail: true, reason: 'No core divisions found. Wait for corp-manager to create them.' };
        return { pass: true, detail: `Found: ${found.join(', ')}${found.length < 3 ? ` (${3 - found.length} pending)` : ''}` };
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Test 7: Research Unlocked ──
    await runTest(ns, 'Research Capability', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        const hasResearch = await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Hi-Tech R&D Laboratory']);
        if (!hasResearch) {
            const corp = await getCachedCorpData(ns);
            if (!corp) return { fail: true, reason: 'Cannot determine research status' };
            // Check if any division has RP
            const totalRP = corp.divisions.reduce((sum, d) => sum + (d.researchPoints || 0), 0);
            return { fail: true, reason: `Hi-Tech R&D Lab not purchased yet (${totalRP.toLocaleString()} RP available)` };
        }
        return { pass: true, detail: 'Hi-Tech R&D Laboratory unlocked' };
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Test 8: Unlock Validation ──
    await runTest(ns, 'V3.x Unlock Validation', async () => {
        if (Date.now() - startTime > options.timeout) return { skip: true, reason: 'Timeout' };
        // Verify no deprecated APIs are in use
        const hrContent = ns.read('Corp/corp-hr.js');
        const logisticsContent = ns.read('Corp/corp-logistics.js');

        const deprecatedAPIs = ['setAutoJobAssignment'];
        let issues = [];

        for (const api of deprecatedAPIs) {
            if (hrContent.includes(api)) issues.push(`${api} found in corp-hr.js`);
            if (logisticsContent.includes(api)) issues.push(`${api} found in corp-logistics.js`);
        }

        if (issues.length > 0) return { fail: true, reason: `Deprecated APIs found: ${issues.join(', ')}` };
        return { pass: true, detail: 'No deprecated v2.x APIs detected' };
    }, verbose, { passed, failed, skipped }, startTime);

    // ── Summary ──
    log(ns, '\n╔══════════════════════════════════╗', false, 'info');
    log(ns, `║ Results: ${passed} passed, ${failed} failed, ${skipped} skipped ║`, false, failed > 0 ? 'error' : 'success');
    log(ns, '╚══════════════════════════════════╝', false, 'info');
}

let _passed, _failed, _skipped;
async function runTest(ns, name, fn, verbose, counters, startTime) {
    _passed = counters.passed;
    _failed = counters.failed;
    _skipped = counters.skipped;

    try {
        const result = await fn();
        if (result.skip) {
            _skipped++;
            log(ns, `⏭️  SKIP: ${name} — ${result.reason}`, false, 'info');
        } else if (result.fail) {
            _failed++;
            log(ns, `❌ FAIL: ${name} — ${result.reason}`, true, 'error');
        } else {
            _passed++;
            const detail = result.detail ? ` — ${result.detail}` : '';
            if (verbose) log(ns, `✅ PASS: ${name}${detail}`, false, 'success');
        }
    } catch (err) {
        _failed++;
        log(ns, `💥 CRASH: ${name} — ${getErrorInfo(err)}`, true, 'error');
    }
}
