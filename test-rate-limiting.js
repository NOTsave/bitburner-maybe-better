/**
 * Test script to verify Corp API rate limiting implementation
 * Run this script to validate that the cc function properly delays between calls
 */

import { cc } from './helpers.js';

export async function main(ns) {
    ns.disableLog('sleep');
    ns.print('🧪 Testing Corp API Rate Limiting...');
    
    const testCalls = 5;
    const startTime = Date.now();
    
    for (let i = 0; i < testCalls; i++) {
        const callStart = Date.now();
        
        try {
            // Test with a simple Corp API call
            const result = await cc(ns, 'ns.corporation.hasCorporation()');
            const callEnd = Date.now();
            const callDuration = callEnd - callStart;
            
            ns.print(`Call ${i + 1}: ${result ? 'Has Corp' : 'No Corp'} | Duration: ${callDuration}ms`);
        } catch (e) {
            const callEnd = Date.now();
            const callDuration = callEnd - callStart;
            ns.print(`Call ${i + 1}: ERROR - ${e.message} | Duration: ${callDuration}ms`);
        }
    }
    
    const totalTime = Date.now() - startTime;
    const expectedMinTime = (testCalls - 1) * 200; // 200ms delay between calls
    
    ns.print(`\n📊 Results:`);
    ns.print(`Total time: ${totalTime}ms`);
    ns.print(`Expected minimum: ${expectedMinTime}ms`);
    ns.print(`Rate limiting ${totalTime >= expectedMinTime ? '✅ WORKING' : '❌ NOT WORKING'}`);
    
    if (totalTime < expectedMinTime) {
        ns.print(`⚠️  WARNING: Rate limiting may not be functioning correctly!`);
    } else {
        ns.print(`✅ Rate limiting is working as expected.`);
    }
}
