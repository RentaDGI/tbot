/**
 * Escanea la aldea y muestra todos los edificios/campos
 * Uso: npm run scan
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

function normalize(txt) {
    return (txt || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function scanVillage() {
    console.log('Escaneando aldea...\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1366, height: 768 }
    });
    const page = await context.newPage();

    try {
        await page.goto(process.env.GAME_URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const loginField = await page.$('input[name="name"], input[name="username"]');
        if (loginField) {
            console.log('Iniciando sesion...');
            await loginField.fill(process.env.GAME_USERNAME);

            const passField = await page.$('input[name="password"], input[type="password"]');
            if (passField) await passField.fill(process.env.GAME_PASSWORD);

            const loginBtn = await page.$('button[type="submit"], input[type="submit"]');
            if (loginBtn) await loginBtn.click();

            await page.waitForTimeout(3000);
        }

        console.log('CAMPOS DE RECURSOS (Slots 1-18)\n');
        await page.goto(`${process.env.GAME_URL}/dorf1.php`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        const resourceFields = [];
        for (let slot = 1; slot <= 18; slot++) {
            try {
                await page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(350);

                const info = await page.evaluate(() => {
                    const titleEl = document.querySelector('.titleInHeader, h1, .buildingTitle, .contentNavi h1');
                    if (!titleEl) return null;

                    const fullText = (titleEl.textContent || '').trim();

                    const levelMatch = fullText.match(/[Nn]ivel\s*(\d+)/) ||
                                      fullText.match(/[Ll]evel\s*(\d+)/) ||
                                      fullText.match(/(\d+)\s*$/);
                    const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

                    let name = fullText
                        .replace(/[Nn]ivel\s*\d+/, '')
                        .replace(/[Ll]evel\s*\d+/, '')
                        .replace(/\d+$/, '')
                        .trim();

                    return { name, level };
                });

                if (info && info.name) {
                    const nameLower = normalize(info.name);
                    let type = 'unknown';

                    if (nameLower.includes('leñador') || nameLower.includes('lenador') || nameLower.includes('wood')) type = 'wood';
                    else if (nameLower.includes('barrera') || nameLower.includes('barro') || nameLower.includes('clay') || nameLower.includes('arcilla')) type = 'clay';
                    else if (nameLower.includes('mina') || nameLower.includes('hierro') || nameLower.includes('iron')) type = 'iron';
                    else if (nameLower.includes('granja') || nameLower.includes('cereal') || nameLower.includes('crop')) type = 'crop';

                    resourceFields.push({ slot, ...info, type });
                    console.log(`- Slot ${slot.toString().padStart(2)}: ${info.name} (Nivel ${info.level})`);
                }
            } catch (e) {
                // Ignorar slots que fallen
            }
        }

        console.log('\nEDIFICIOS (Slots 19-40)\n');
        const buildings = [];

        for (let slot = 19; slot <= 40; slot++) {
            try {
                await page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(350);

                const info = await page.evaluate(() => {
                    const titleEl = document.querySelector('.titleInHeader, h1, .buildingTitle, .contentNavi h1');
                    const bodyClass = (document.body && document.body.className) ? String(document.body.className) : '';
                    const isEmptyByBody = /\bgid0\b/i.test(bodyClass) || /\baid0\b/i.test(bodyClass);

                    if (!titleEl) {
                        if (isEmptyByBody) return { name: '[VACIO - Construir nuevo]', level: 0, empty: true };
                        return null;
                    }

                    const fullText = (titleEl.textContent || '').trim();

                    const levelMatch = fullText.match(/[Nn]ivel\s*(\d+)/) ||
                                      fullText.match(/[Ll]evel\s*(\d+)/) ||
                                      fullText.match(/(\d+)\s*$/);
                    const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

                    let name = fullText
                        .replace(/[Nn]ivel\s*\d+/, '')
                        .replace(/[Ll]evel\s*\d+/, '')
                        .replace(/\d+$/, '')
                        .trim();

                    const lower = (name || '')
                        .toLowerCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    const looksEmpty = isEmptyByBody || lower.includes('construir') || lower.includes('build new') || lower.includes('bauplatz');
                    if (looksEmpty) return { name: '[VACIO - Construir nuevo]', level: 0, empty: true };

                    return { name, level, empty: false };
                });

                if (info) {
                    buildings.push({ slot, ...info });
                    console.log(`- Slot ${slot}: ${info.name}${info.empty ? '' : ` (Nivel ${info.level})`}`);
                }
            } catch (e) {
                // Ignorar
            }
        }

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        const { data: account } = await supabase
            .from('accounts')
            .select('id')
            .eq('username', process.env.GAME_USERNAME)
            .single();

        if (account) {
            await supabase.from('accounts').update({
                village_scan: {
                    resources: resourceFields,
                    buildings,
                    scanned_at: new Date().toISOString()
                }
            }).eq('id', account.id);

            console.log('\nEscaneo guardado en base de datos.');
        }
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await browser.close();
    }
}

scanVillage();
