/**
 * Escanea la aldea y muestra todos los edificios/campos
 * Uso: npm run scan
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

async function scanVillage() {
    console.log('🔍 Escaneando aldea...\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1366, height: 768 }
    });
    const page = await context.newPage();

    try {
        // Login
        await page.goto(process.env.GAME_URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        // Verificar si hay que loguearse
        const loginField = await page.$('input[name="name"], input[name="username"]');
        if (loginField) {
            console.log('🔑 Iniciando sesión...');
            await loginField.fill(process.env.GAME_USERNAME);
            
            const passField = await page.$('input[name="password"], input[type="password"]');
            if (passField) await passField.fill(process.env.GAME_PASSWORD);
            
            const loginBtn = await page.$('button[type="submit"], input[type="submit"]');
            if (loginBtn) await loginBtn.click();
            
            await page.waitForTimeout(3000);
        }

        // ============ ESCANEAR CAMPOS DE RECURSOS ============
        console.log('═══════════════════════════════════════════');
        console.log('   🌾 CAMPOS DE RECURSOS (Slots 1-18)');
        console.log('═══════════════════════════════════════════\n');

        await page.goto(`${process.env.GAME_URL}/dorf1.php`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const resourceFields = [];

        for (let slot = 1; slot <= 18; slot++) {
            try {
                await page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(500);

                const info = await page.evaluate(() => {
                    const titleEl = document.querySelector('.titleInHeader, h1, .buildingTitle, .contentNavi h1');
                    if (!titleEl) return null;

                    const fullText = titleEl.textContent.trim();
                    
                    // Extraer nivel
                    const levelMatch = fullText.match(/[Nn]ivel\s*(\d+)/) || 
                                      fullText.match(/[Ll]evel\s*(\d+)/) ||
                                      fullText.match(/(\d+)\s*$/);
                    const level = levelMatch ? parseInt(levelMatch[1]) : 0;

                    // Limpiar nombre
                    let name = fullText
                        .replace(/[Nn]ivel\s*\d+/, '')
                        .replace(/[Ll]evel\s*\d+/, '')
                        .replace(/\d+$/, '')
                        .trim();

                    return { name, level };
                });

                if (info && info.name) {
                    // Determinar tipo
                    const nameLower = info.name.toLowerCase();
                    let type = 'unknown';
                    let emoji = '❓';

                    if (nameLower.includes('leñador') || nameLower.includes('wood')) {
                        type = 'wood'; emoji = '🪵';
                    } else if (nameLower.includes('barrer') || nameLower.includes('clay') || nameLower.includes('arcilla')) {
                        type = 'clay'; emoji = '🧱';
                    // CORRECCIÓN AQUÍ: Aceptamos "mina" a secas como hierro
                    } else if (nameLower.includes('hierro') || nameLower.includes('iron') || nameLower === 'mina') {
                        type = 'iron'; emoji = '⛏️';
                    } else if (nameLower.includes('granja') || nameLower.includes('crop') || nameLower.includes('cereal')) {
                        type = 'crop'; emoji = '🌾';
                    }

                    resourceFields.push({ slot, ...info, type, emoji });
                    console.log(`   ${emoji} Slot ${slot.toString().padStart(2)}: ${info.name.padEnd(20)} Nivel ${info.level}`);
                }
            } catch (e) {
                // Ignorar
            }
        }

        // ============ ESCANEAR EDIFICIOS ============
        console.log('\n═══════════════════════════════════════════');
        console.log('   🏛️  EDIFICIOS (Slots 19-40)');
        console.log('═══════════════════════════════════════════\n');

        const buildings = [];

        for (let slot = 19; slot <= 40; slot++) {
            try {
                await page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(500);

                const info = await page.evaluate(() => {
                    // Verificar si es slot vacío (se puede construir algo nuevo)
                    const emptySlot = document.querySelector('.buildingWrapper, .g0, .aid0');
                    if (emptySlot) return { name: '[VACÍO - Construir nuevo]', level: 0, empty: true };

                    const titleEl = document.querySelector('.titleInHeader, h1, .buildingTitle, .contentNavi h1');
                    if (!titleEl) return null;

                    const fullText = titleEl.textContent.trim();
                    
                    const levelMatch = fullText.match(/[Nn]ivel\s*(\d+)/) || 
                                      fullText.match(/[Ll]evel\s*(\d+)/) ||
                                      fullText.match(/(\d+)\s*$/);
                    const level = levelMatch ? parseInt(levelMatch[1]) : 0;

                    let name = fullText
                        .replace(/[Nn]ivel\s*\d+/, '')
                        .replace(/[Ll]evel\s*\d+/, '')
                        .replace(/\d+$/, '')
                        .trim();

                    return { name, level, empty: false };
                });

                if (info) {
                    const emoji = info.empty ? '🔳' : '🏛️';
                    buildings.push({ slot, ...info });
                    console.log(`   ${emoji} Slot ${slot}: ${info.name.padEnd(25)} ${info.empty ? '' : 'Nivel ' + info.level}`);
                }
            } catch (e) {
                // Ignorar
            }
        }

        // ============ RESUMEN ============
        console.log('\n═══════════════════════════════════════════');
        console.log('   📊 RESUMEN');
        console.log('═══════════════════════════════════════════\n');

        const countByType = resourceFields.reduce((acc, f) => {
            acc[f.type] = (acc[f.type] || 0) + 1;
            return acc;
        }, {});

        console.log(`   🪵 Leñadores (wood): ${countByType.wood || 0}`);
        console.log(`   🧱 Barreras (clay):  ${countByType.clay || 0}`);
        console.log(`   ⛏️  Minas (iron):     ${countByType.iron || 0}`);
        console.log(`   🌾 Granjas (crop):   ${countByType.crop || 0}`);

        // Guardar en Supabase para referencia
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        
        // Guardar escaneo
        const { data: account } = await supabase
            .from('accounts')
            .select('id')
            .eq('username', process.env.GAME_USERNAME)
            .single();

        if (account) {
            await supabase.from('accounts').update({
                village_scan: {
                    resources: resourceFields,
                    buildings: buildings,
                    scanned_at: new Date().toISOString()
                }
            }).eq('id', account.id);
            
            console.log('\n   ✅ Escaneo guardado en base de datos');
        }

        console.log('\n═══════════════════════════════════════════\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await browser.close();
    }
}

scanVillage();