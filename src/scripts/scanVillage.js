/**
 * Escanea la aldea y muestra todos los edificios/campos
 * Uso: npm run scan
 */

require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const GameClient = require('../classes/GameClient');

function normalize(txt) {
    return (txt || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function ask(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const answer = await new Promise(resolve => rl.question(prompt, resolve));
    rl.close();
    return answer;
}

async function scanVillage() {
    console.log('Escaneando aldea...\n');

    const client = new GameClient();
    await client.init();

    try {
        await client.login();

        const villages = await client.getVillages();
        let targetInput = process.argv.slice(2).join(' ').trim();

        if (!targetInput) {
            if (villages.length) {
                console.log('Aldeas detectadas:\n');
                for (const v of villages) {
                    console.log(`- ${v.id}  ${v.name}`);
                }
                console.log('');
            }

            targetInput = (await ask('Village id o nombre [main]: ')).trim();
        }

        if (!targetInput) targetInput = 'main';

        let selectedVillage = null;
        if (targetInput.toLowerCase() !== 'main' && villages.length) {
            if (/^\d+$/.test(targetInput)) {
                selectedVillage = villages.find(v => v.id === targetInput) || { id: targetInput, name: targetInput };
            } else {
                const targetNorm = normalize(targetInput);
                selectedVillage = villages.find(v => {
                    const nameNorm = normalize(v.name);
                    return nameNorm === targetNorm || nameNorm.includes(targetNorm) || targetNorm.includes(nameNorm);
                });
            }
        }

        const switchTarget = selectedVillage ? selectedVillage.id : targetInput;
        if (switchTarget.toLowerCase() !== 'main') {
            const switched = await client.switchToVillage(switchTarget);
            if (!switched) {
                console.log('No se pudo cambiar a la aldea solicitada.');
                return;
            }
        }

        console.log(`Usando aldea: ${selectedVillage ? `${selectedVillage.id} (${selectedVillage.name})` : switchTarget}`);

        const page = client.page;

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
                    village_id: selectedVillage ? selectedVillage.id : switchTarget,
                    village_name: selectedVillage ? selectedVillage.name : null,
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
        await client.close();
    }
}

scanVillage();
