import { log, disableLogs } from './helpers.js'

const STATE_FILE = '/Temp/corp-state.txt';
const PROTECT_FILE = '/Temp/corp-protection.txt';

// Konfigurace modulů s inteligentním samovypínáním
const MODULES = {
    hr: { 
        file: 'corp-hr.js', 
        ram: 2.5, 
        priority: 1, 
        alwaysOn: true,
        selfTerminate: true,          // Samovypínání po dokončení úkolu
        completionConditions: [        // Podmínky pro samovypínání
            { type: 'funds', operator: '<', value: 500e9 }, // Méně než 500B
            { type: 'office_size', operator: '>=', value: 50 },    // Kanceláře >= 50
            { type: 'research_complete', operator: 'all', divisions: ['Tobacco'] }              // Všechny výzkumy hotové
        ]
    },
    research: { 
        file: 'corp-research.js', 
        ram: 3.0, 
        priority: 1, 
        alwaysOn: true,
        selfTerminate: true,
        completionConditions: [
            { type: 'research_points', operator: '<', value: 1000 },     // Málo RP
            { type: 'research_complete', operator: 'all', divisions: ['Tobacco'] },               // Všechny výzkumy hotové
            { type: 'funds', operator: '<', value: 100e9 }            // Málo peněz
        ]
    },
    products: { 
        file: 'corp-products.js', 
        ram: 4.0, 
        priority: 2, 
        phase: 3,
        selfTerminate: true,
        completionConditions: [
            { type: 'dividend_rate', operator: '>=', value: 0.35 }, // Dividendy >= 35%
            { type: 'shares_owned', operator: '>=', value: 0.8 },    // Vlastníme >= 80% akcií
            { type: 'profit_margin', operator: '>=', value: 0.2 },    // Profit margin >= 20%
            { type: 'total_value', operator: '>=', value: 10e12 }    // Celková hodnota >= 10T
        ]
    },
    stocks: { 
        file: 'corp-stocks.js', 
        ram: 2.0, 
        priority: 3, 
        phase: 5,
        selfTerminate: true,
        completionConditions: [
            { type: 'dividend_rate', operator: '>=', value: 0.35 }, // Dividendy >= 35%
            { type: 'shares_owned', operator: '>=', value: 0.8 },    // Vlastníme >= 80% akcií
            { type: 'profit_margin', operator: '>=', value: 0.2 }    // Profit margin >= 20%
        ]
    },
    logistics: { 
        file: 'orp-logistics.js', 
        ram: 2.5, 
        priority: 2, 
        phase: 2,
        selfTerminate: false,         // Logistika běží pořád
        completionConditions: []       // Nikdy se samovypíná
    }
};

// RAM management - maximálně 15GB na home serveru
const MAX_RAM = 15;
const RESERVED_RAM = 2; // Rezerva pro systém a manažera

export async function main(ns) {
    disableLogs(ns, ['sleep', 'run', 'read', 'disableLog']);
    ns.tail();

    log(ns, `🧠 Spouštím Enterprise Manager (RAM limit: ${MAX_RAM}GB)`, true, 'success');
    
    // --- AUTOSTART OCHRANKY (Watchdog) ---
    if (!ns.isRunning('corp-watchdog.js', 'home')) {
        log(ns, "🛡️ Spouštím Watchdog (ochranku)...", true, 'success');
        const watchdogPid = ns.run('corp-watchdog.js', 1);
        if (watchdogPid === 0) {
            log(ns, "⚠️ CHYBA: Nepodařilo se spustit corp-watchdog.js! Zkontroluj RAM.", true, 'error');
        } else {
            log(ns, "✅ Watchdog úspěšně spuštěn", true, 'success');
        }
    }

    // --- AUTOSTART DATA FETCHER ---
    if (!ns.isRunning('corp-fetcher.js', 'home')) {
        log(ns, "📊 Spouštím Data Fetcher...", true, 'success');
        const fetcherPid = ns.run('corp-fetcher.js', 1);
        if (fetcherPid === 0) {
            log(ns, "⚠️ CHYBA: Nepodařilo se spustit corp-fetcher.js!", true, 'error');
        } else {
            log(ns, "✅ Data Fetcher úspěšně spuštěn", true, 'success');
        }
    }

    // --- ČEKÁNÍ NA DATA ---
    let dataAvailable = false;
    let attempts = 0;
    const maxAttempts = 30; // Maximálně 5 minut čekání
    
    while (!dataAvailable && attempts < maxAttempts) {
        try {
            const raw = ns.read('/Temp/corp-data.txt');
            if (raw && raw.length > 2) {
                dataAvailable = true;
                log(ns, "✅ Data z fetcheru dostupná", true, 'success');
                break;
            }
        } catch (_) {}
        
        if (!dataAvailable) {
            attempts++;
            log(ns, `⏳ Čekám na data... (${attempts}/${maxAttempts})`, false, 'info');
            await ns.sleep(10000); // Čekání 10s
        }
    }
    
    if (!dataAvailable) {
        log(ns, "❌ Data nejsou dostupná ani po 5 minutách! Spouštím v nouzovém režimu...", true, 'error');
        await ns.sleep(5000);
        // Nouzový režim - spustíme jen základní moduly
        const emergencyModules = ['corp-products.js', 'corp-research.js'];
        for (const modName of emergencyModules) {
            if (ns.isRunning(modName, 'home')) continue;
            const config = Object.values(MODULES).find(m => m.file === modName);
            if (config && availableRAM >= config.ram) {
                ns.run(modName, 1);
                log(ns, `🚨 Nouzový start: ${modName}`, true, 'warning');
            }
        }
    }

    while (true) {
        try {
            let state = { phase: 0 };
            try {
                state = JSON.parse(ns.read(STATE_FILE) || '{"phase":0}');
            } catch (_) {
                state = { phase: 0, productNum: 1 };
            }

            // --- HEARTBEAT PRO WATCHDOG ---
            const heartbeat = { 
                pid: ns.pid, 
                lastCheck: Date.now(),
                modules: getRunningModules(ns),
                ramUsage: calculateRAMUsage(ns),
                timestamp: Date.now(),
                watchdogRunning: ns.isRunning('corp-watchdog.js', 'home'),
                fetcherRunning: ns.isRunning('corp-fetcher.js', 'home')
            };
            ns.write(PROTECT_FILE, JSON.stringify(heartbeat), 'w');

            // --- INTELIGENTNÍ SPRÁVA MODULŮ S SAMOVYPÍNÁNÍM ---
            await manageModulesWithSelfTermination(ns, state);
            
            // --- PRIORITY RAM MANAGEMENT ---
            const usedRAM = calculateRAMUsage(ns);
            if (usedRAM > MAX_RAM - RESERVED_RAM) {
                log(ns, `⚠️ RAM usage: ${usedRAM}/${MAX_RAM}GB - optimizing modules`, false, 'warning');
                await optimizeRAMUsage(ns, state);
            }

        } catch (e) {
            log(ns, `💥 Kritická chyba v manažerovi: ${e}`, true, 'error');
        }
        
        await ns.sleep(5000); // Manažer běží každých 5s
    }
}

async function manageModulesWithSelfTermination(ns, state) {
    const availableRAM = MAX_RAM - RESERVED_RAM - calculateRAMUsage(ns);
    
    for (const [name, config] of Object.entries(MODULES)) {
        const shouldRun = shouldModuleRun(ns, name, config, state, availableRAM);
        const isRunning = ns.isRunning(config.file, 'home');
        
        if (shouldRun && !isRunning) {
            if (availableRAM >= config.ram) {
                log(ns, `🚀 Spouštím modul: ${name} (${config.ram}GB RAM)`, false, 'info');
                ns.run(config.file, 1);
                await ns.sleep(1000); // Dej čas na start
            } else {
                log(ns, `❌ Nedostatek RAM pro ${name} (${config.ram}GB potřebných, ${availableRAM.toFixed(1)}GB volných)`, false, 'warning');
            }
        } else if (!shouldRun && isRunning && !config.alwaysOn) {
            log(ns, `🛑 Inteligentně vypínám modul: ${name}`, false, 'info');
            await terminateModule(ns, config.file, name);
        } else if (isRunning && config.selfTerminate) {
            // Kontrola samovypínacích podmínek
            const shouldTerminate = await checkSelfTerminationConditions(ns, name, config);
            if (shouldTerminate) {
                log(ns, `🎯 Modul ${name} splnil úkol - samovypínám`, false, 'success');
                await terminateModule(ns, config.file, name);
            }
        }
    }
}

async function checkSelfTerminationConditions(ns, moduleName, config) {
    if (!config.completionConditions || config.completionConditions.length === 0) {
        return { terminate: false, reason: 'Samovypínání vypnuto' };
    }
    
    try {
        const corp = await getCorpData(ns);
        if (!corp) return false;
        
        for (const condition of config.completionConditions) {
            const result = await evaluateCondition(ns, corp, condition);
            if (result.shouldTerminate) {
                log(ns, `🎯 ${moduleName}: ${result.reason}`, false, 'info');
                return true;
            }
        }
        
        return { terminate: false, reason: 'Pokračuji ve správě modulu' };
    } catch (e) {
        return { terminate: false, reason: `Chyba v kontrole samovypínání ${moduleName}: ${e}` };
    }
}

async function evaluateCondition(ns, corp, condition) {
    try {
        switch (condition.type) {
            case 'funds':
                return {
                    shouldTerminate: corp.funds < condition.value,
                    reason: `Fondy pod limitem (${formatMoney(corp.funds)} < ${formatMoney(condition.value)})`
                };
                
            case 'research_points':
                const division = corp.divisions.find(d => d.type === 'Tobacco');
                const rp = division?.researchPoints || 0;
                return {
                    shouldTerminate: rp < condition.value,
                    reason: `Málo výzkumných bodů (${rp} < ${condition.value})`
                };
                
            case 'research_complete':
                const tobacco = corp.divisions.find(d => d.type === 'Tobacco');
                if (!tobacco) return { shouldTerminate: false, reason: 'Tobacco nenalezen' };
                
                const priorityResearch = ['Hi-Tech R&D Laboratory', 'Market-TA.I', 'Market-TA.II', 'uBiome'];
                const completedResearch = [];
                
                for (const res of priorityResearch) {
                    try {
                        const hasRes = await getCorpData(ns, `ns.corporation.hasResearched(ns.args[0], ns.args[1])`, [tobacco.name, res]);
                        if (hasRes) completedResearch.push(res);
                    } catch (_) {}
                }
                
                const allComplete = completedResearch.length === priorityResearch.length;
                return {
                    shouldTerminate: allComplete,
                    reason: `Všechny prioritní výzkumy hotovy (${completedResearch.length}/${priorityResearch.length})`
                };
                
            case 'office_size':
                const tobaccoDiv = corp.divisions.find(d => d.type === 'Tobacco');
                if (!tobaccoDiv) return { shouldTerminate: false, reason: 'Tobacco nenalezen' };
                
                let maxSize = 0;
                for (const city of tobaccoDiv.cities) {
                    maxSize = Math.max(maxSize, city.size || 0);
                }
                
                return {
                    shouldTerminate: maxSize >= condition.value,
                    reason: `Kanceláře dostatečně velké (${maxSize} >= ${condition.value})`
                };
                
            case 'dividend_rate':
                return {
                    shouldTerminate: corp.dividendRate >= condition.value,
                    reason: `Dividendy dostatečně vysoké (${(corp.dividendRate*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'shares_owned':
                const totalShares = corp.totalShares || 0;
                const maxShares = corp.numShares || 0;
                const ownedPercent = totalShares / maxShares;
                
                return {
                    shouldTerminate: ownedPercent >= condition.value,
                    reason: `Dostatek akcií vlastněn (${(ownedPercent*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'profit_margin':
                // Zjednodušený výpočet profit margin
                const profitPerShare = corp.sharePrice - (corp.issuedShares > 0 ? corp.shareSalePrice : 0);
                const margin = profitPerShare / corp.sharePrice;
                
                return {
                    shouldTerminate: margin >= condition.value,
                    reason: `Profit margin dostatečně vysoký (${(margin*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'total_value':
                const totalValue = corp.sharePrice * corp.totalShares;
                return {
                    shouldTerminate: totalValue >= condition.value,
                    reason: `Celková hodnota akcií dostatečně vysoká (${formatMoney(totalValue)} >= ${formatMoney(condition.value)})`
                };
                
            default:
                return { shouldTerminate: false, reason: 'Neznámá podmínka' };
        }
    } catch (e) {
        return { shouldTerminate: false, reason: `Chyba: ${e}` };
    }
}

async function terminateModule(ns, filename, moduleName) {
    try {
        const scripts = ns.ps('home').filter(s => s.filename === filename);
        for (const script of scripts) {
            ns.kill(script.pid);
            log(ns, `🛑 Ukončuji ${moduleName} (PID: ${script.pid})`, false, 'info');
        }
        await ns.sleep(2000); // Dej čas na čisté ukončení
    } catch (e) {
        log(ns, `💥 Chyba při ukončování ${moduleName}: ${e}`, false, 'error');
    }
}

async function getCorpData(ns, command) {
    try {
        return await getNsDataThroughFile(ns, command, null, []);
    } catch (_) {
        return null;
    }
}

function shouldModuleRun(ns, name, config, state, availableRAM) {
    // Vždy zapnuté moduly
    if (config.alwaysOn) return true;
    
    // Fázové moduly
    if (config.phase !== undefined) {
        return state.phase >= config.phase;
    }
    
    // Prioritní moduly (pokud máme málo RAM)
    if (availableRAM < 5) {
        return config.priority <= 1;
    }
    
    return true;
}

function calculateRAMUsage(ns) {
    const scripts = ns.ps('home');
    let totalRAM = 0;
    
    for (const script of scripts) {
        const config = Object.values(MODULES).find(m => m.file === script.filename);
        if (config) {
            totalRAM += config.ram;
        }
    }
    
    return totalRAM;
}

function getRunningModules(ns) {
    const scripts = ns.ps('home');
    return scripts
        .filter(s => Object.values(MODULES).some(m => m.file === s.filename))
        .map(s => s.filename);
}

async function optimizeRAMUsage(ns, state) {
    const scripts = ns.ps('home');
    const runningModules = scripts
        .filter(s => Object.values(MODULES).some(m => m.file === s.filename))
        .map(s => Object.entries(MODULES).find(([_, m]) => m.file === s.filename));
    
    // Seřadit podle priority a vypínat nejméně důležité
    runningModules.sort((a, b) => a[1].priority - b[1].priority);
    
    for (const [name, config] of runningModules) {
        if (!config.alwaysOn && config.priority > 1) {
            log(ns, `� RAM optimalizace: vypínám ${name}`, false, 'info');
            await terminateModule(ns, config.file, name);
            await ns.sleep(500);
            break;
        }
    }
}

function formatMoney(amount) {
    if (amount >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return `$${amount.toFixed(2)}`;
}
