const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { humanDelay, sleep } = require('../utils/time');
const logger = require('../utils/logger');

const SESSION_PATH = path.resolve(__dirname, '../../session.json');
const BUILDING_KEYWORDS = {
    barracks: ['cuartel', 'cuarteles', 'barracks'],
    stable: ['establo', 'estable', 'stable'],
    workshop: ['taller', 'taller de asedio', 'workshop'],
    residence: ['residencia', 'palacio', 'residence', 'palace'],
    rallyPoint: ['plaza de reuniones', 'plaza de reunion', 'rally point', 'assembly point']
};
const BUILDING_GIDS = {
    barracks: [19],
    stable: [20],
    workshop: [21],
    residence: [25, 26],
    rallyPoint: [16]
};

class GameClient {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
        this.fieldCache = null;
        this.lastScanTime = null;
        this.CACHE_DURATION = 30 * 60 * 1000;
    }

    _normalizeText(txt) {
        return (txt || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    async init() {
        logger.info('Iniciando navegador...');
        this.browser = await chromium.launch({
            headless: process.env.HEADLESS === 'true',
            args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--window-size=1366,768']
        });

        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'es-ES'
        };

        if (fs.existsSync(SESSION_PATH)) {
            logger.info('ðŸ“‚ Cargando sesiÃ³n guardada...');
            try {
                contextOptions.storageState = SESSION_PATH;
            } catch (e) {
                logger.warn('Archivo de sesiÃ³n corrupto.');
            }
        }

        this.context = await this.browser.newContext(contextOptions);
        this.page = await this.context.newPage();
    }

    async login() {
        const url = process.env.GAME_URL;
        logger.info('Navegando al juego...');
        
        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 3000, 5000);

            if (await this.checkIfLoggedIn()) {
                logger.success('âœ… SesiÃ³n vÃ¡lida. Login saltado.');
                this.isLoggedIn = true;
                return true;
            }

            logger.info('ðŸ”‘ Iniciando sesiÃ³n manual...');
            const userField = await this.page.$('input[name="name"], input[name="username"]');
            if (userField) {
                await userField.fill(process.env.GAME_USERNAME);
                await humanDelay(this.page, 300, 600);
                await this.page.fill('input[name="password"]', process.env.GAME_PASSWORD);
                await humanDelay(this.page, 500, 1000);
                
                const btn = await this.page.$('button[type="submit"], input[type="submit"]');
                if (btn) {
                    await btn.click();
                    logger.info('   Esperando carga tras login...');
                    await humanDelay(this.page, 5000, 7000);
                }
            }

            if (await this.checkIfLoggedIn()) {
                logger.success('âœ… Login exitoso. Guardando sesiÃ³n...');
                this.isLoggedIn = true;
                await this.context.storageState({ path: SESSION_PATH });
                return true;
            } else {
                throw new Error('Fallo al iniciar sesiÃ³n.');
            }
        } catch (error) {
            if (!this.page.isClosed()) await this.page.screenshot({ path: 'error-login.png' });
            throw error;
        }
    }

    async checkIfLoggedIn() {
        if (this.page.isClosed()) return false;
        return !!(await this.page.$('#stockBar, .villageList, #sidebarBoxVillagelist, a[href*="logout"], .playerName'));
    }

    async clickBuildingSlot(slotId) {
        if (this.page.isClosed()) return;
        await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slotId}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1500, 2500);
    }

        async findBuildingSlot(buildingType, explicitSlot) {
        if (explicitSlot) return explicitSlot;
        const keywords = (BUILDING_KEYWORDS[buildingType] || [buildingType]).filter(Boolean);
        const gids = BUILDING_GIDS[buildingType] || [];
        if (!keywords.length) return null;

        const tryReadSlotFromPage = async () => {
            try {
                await this.page.goto(`${process.env.GAME_URL}/dorf2.php`, { waitUntil: 'domcontentloaded' });
                await humanDelay(this.page, 900, 1400);
            } catch (error) {
                logger.warn('No se pudo abrir dorf2 para localizar edificio: ' + error.message);
                return null;
            }

            return await this.page.evaluate(({ keywords, gids }) => {
                const normalize = (text) => (text || '')
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .trim();

                const targets = keywords.map(normalize);
                const gidTargets = gids.map(g => parseInt(g, 10));

                const extractSlotFromEl = (el) => {
                    if (!el) return null;
                    const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
                    const dataId = el.getAttribute('data-id') || el.getAttribute('data-slotid');
                    const match = href.match(/id=(\d+)/);
                    if (match) return parseInt(match[1], 10);
                    if (dataId && !isNaN(parseInt(dataId, 10))) return parseInt(dataId, 10);
                    return null;
                };

                const candidates = Array.from(document.querySelectorAll('area[href*="build.php?id="], a[href*="build.php?id="], [href*="build.php?id="], [data-slotid], [data-id]'));
                for (const el of candidates) {
                    const slotId = extractSlotFromEl(el);
                    if (!slotId) continue;

                    const label = normalize(el.getAttribute('title') || el.getAttribute('alt') || el.textContent || '');
                    const classText = normalize(el.className || '');
                    const href = el.getAttribute('href') || '';
                    const gidMatch = href.match(/gid=(\d+)/);
                    const gid = gidMatch ? parseInt(gidMatch[1], 10) : null;

                    const byKeyword = targets.some(key => label.includes(key));
                    const byGid = gid !== null && gidTargets.includes(gid);
                    const classGid = gidTargets.some(g => classText.includes(`g${g}`));

                    if (byKeyword || byGid || classGid) {
                        return slotId;
                    }
                }

                for (const gid of gidTargets) {
                    const el = document.querySelector(`.g${gid}, [class*="g${gid}"]`);
                    if (el) {
                        const slotId = extractSlotFromEl(el) ||
                            extractSlotFromEl(el.querySelector('a[href*="build.php?id="]'));
                        if (slotId) return slotId;
                    }
                }

                const labels = Array.from(document.querySelectorAll('.buildingSlot, .label'));
                for (const el of labels) {
                    const link = el.querySelector('a[href*="build.php?id="]');
                    const slotId = extractSlotFromEl(link);
                    if (!slotId) continue;
                    const label = normalize(el.textContent || link.getAttribute('title') || '');
                    if (targets.some(key => label.includes(key))) return slotId;
                }

                return null;
            }, { keywords, gids });
        };

        let slot = await tryReadSlotFromPage();
        if (slot) {
            logger.info(`Edificio "${buildingType}" localizado en slot ${slot}.`);
            return slot;
        }

        const fallbackSlots = {
            barracks: [19, 18, 17, 16],
            stable: [20, 21],
            workshop: [21, 22, 23],
            residence: [25, 26]
        };

        const candidates = fallbackSlots[buildingType] || [];
        for (const candidate of candidates) {
            try {
                await this.page.goto(`${process.env.GAME_URL}/build.php?id=${candidate}`, { waitUntil: 'domcontentloaded' });
                await humanDelay(this.page, 600, 900);
                const matches = await this.page.evaluate(({ keywords }) => {
                    const normalize = (text) => (text || '')
                        .toLowerCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .trim();
                    const titleEl = document.querySelector('.titleInHeader, h1');
                    const text = titleEl ? normalize(titleEl.textContent) : '';
                    return keywords.some(key => text.includes(normalize(key)));
                }, { keywords });
                if (matches) {
                    logger.info(`Edificio "${buildingType}" encontrado por fallback en slot ${candidate}.`);
                    return candidate;
                }
            } catch (error) {
                logger.warn(`No se pudo probar slot ${candidate}: ${error.message}`);
            }
        }

        logger.warn(`No se pudo localizar edificio "${buildingType}". Keywords: ${keywords.join(', ')}; gids: ${gids.join(', ')}`);
        return null;
    }

/**
     * ESCANER 1-A-1 BLINDADO ("Todo o Nada")
     */
    async scanSlotsOneByOne(maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            logger.info(`Escaneando campos uno a uno... (intento ${attempt}/${maxRetries})`);
            const fields = [];

            for (let slot = 1; slot <= 18; slot++) {
                try {
                    if (this.page.isClosed()) break;

                    await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                    await this.page.waitForTimeout(300);

                    const info = await this.getBuildingInfo();
                    const isUnderConstruction = await this.page.evaluate((currentSlot) => {
                        const queueBox = document.querySelector('.buildingList, .boxes-contents');
                        if (!queueBox) return false;
                        const links = queueBox.querySelectorAll('a');
                        for (const link of links) {
                            const href = link.getAttribute('href') || '';
                            if (href.includes(`id=${currentSlot}`)) {
                                const match = href.match(/id=(\d+)/);
                                if (match && parseInt(match[1]) === currentSlot) return true;
                            }
                        }
                        return false;
                    }, slot);

                    if (info.name) {
                        const name = info.name.toLowerCase();
                        let type = null;
                        if (name.includes('le\u00f1a') || name.includes('wood') || name.includes('bosque')) type = 'wood';
                        else if (name.includes('barr') || name.includes('clay') || name.includes('arcilla')) type = 'clay';
                        else if (name.includes('hierro') || name.includes('iron') || name.includes('mina')) type = 'iron';
                        else if (name.includes('granja') || name.includes('crop') || name.includes('cereal')) type = 'crop';

                        if (type) {
                            const effectiveLevel = isUnderConstruction ? info.level + 1 : info.level;
                            fields.push({ slot, type, level: effectiveLevel });
                            if (process.env.DEBUG === 'true') {
                                const status = isUnderConstruction ? '(build_queue)' : '';
                                console.log(`   Slot ${slot}: ${type} ${info.level} ${status}`);
                            }
                        }
                    }
                } catch (e) {
                    logger.warn(`Error leyendo slot ${slot}, reintentando...`);
                }
            }

            if (fields.length === 18) {
                this.fieldCache = fields;
                this.lastScanTime = Date.now();
                this.logCacheStatus();
                return fields;
            }

            logger.error(`ALERTA: Escaner incompleto (${fields.length}/18).`);
            if (attempt < maxRetries) {
                logger.warn('Reintentando escaneo completo en 3s...');
                await sleep(3000);
            } else {
                throw new Error('SCAN_INCOMPLETE_RETRY');
            }
        }
    }
    async scanFieldsIfNeeded(forceRescan = false) {
        const cacheValid = this.fieldCache && this.lastScanTime && (Date.now() - this.lastScanTime < this.CACHE_DURATION);
        if (cacheValid && !forceRescan) {
            logger.info('Usando cache de campos (vÃ¡lida)');
            return this.fieldCache;
        }
        return await this.scanSlotsOneByOne();
    }

    updateFieldLevel(slot, incrementLevel = true) {
        if (!this.fieldCache) return;
        for (const field of this.fieldCache) {
            if (field.slot === slot) {
                if (incrementLevel) field.level += 1;
                field.isBuilding = true;
                logger.info(`Cache actualizada: Slot ${slot} -> Nivel ${field.level}`);
                break;
            }
        }
    }

    findLowestFieldAcrossAllTasks(tasks, resourceAmounts = {}) {
        if (!this.fieldCache) return null;
        const resourceTasks = tasks.filter(task => task.building_type);
        if (!resourceTasks.length) return null;

        const allCandidates = [];

        for (const task of resourceTasks) {
            for (const field of this.fieldCache) {
                if (field.type === task.building_type &&
                    field.level < task.target_level &&
                    !field.isBuilding) {
                    const resourceValue = typeof resourceAmounts[field.type] === 'number'
                        ? resourceAmounts[field.type]
                        : Number.MAX_SAFE_INTEGER;
                    allCandidates.push({
                        slot: field.slot,
                        type: field.type,
                        level: field.level,
                        task,
                        targetLevel: task.target_level,
                        resourceValue
                    });
                }
            }
        }

        if (!allCandidates.length) return null;

        allCandidates.sort((a, b) => {
            if (a.level !== b.level) return a.level - b.level;
            return a.resourceValue - b.resourceValue;
        });

        const winner = allCandidates[0];
        logger.info(`Campo mÃ¡s bajo: ${winner.task.building_name} Slot ${winner.slot} (Nivel ${winner.level})`);
        return winner;
    }

    getCompletedResourceTasks(tasks) {
        if (!this.fieldCache) return [];
        return tasks.filter(task => {
            if (!task.building_type) return false;
            const fieldsOfType = this.fieldCache.filter(field => field.type === task.building_type);
            if (!fieldsOfType.length) return false;
            return fieldsOfType.every(field => field.level >= task.target_level);
        });
    }

    invalidateCache() {
        this.fieldCache = null;
        this.lastScanTime = null;
        logger.info('Cache de campos invalidada.');
    }

    async getVillages() {
        if (this.page.isClosed()) return [];

        return await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const uniq = new Set();
            const villages = [];

            const links = Array.from(document.querySelectorAll(
                '#sidebarBoxVillagelist a, .villageList a, a[href*="newdid="], a[href*="dorf1.php?newdid="], a[href*="dorf2.php?newdid="]'
            ));

            for (const a of links) {
                const href = a.getAttribute('href') || '';
                const match = href.match(/[?&]newdid=(\d+)/);
                if (!match) continue;
                const id = match[1];
                const name = normalize(a.textContent || a.innerText || '') || id;
                const key = `${id}|${name}`;
                if (uniq.has(key)) continue;
                uniq.add(key);
                villages.push({ id, name });
            }

            const liCandidates = Array.from(document.querySelectorAll('#sidebarBoxVillagelist li, .villageList li'));
            for (const li of liCandidates) {
                const did = li.getAttribute('data-did') || (li.dataset ? li.dataset.did : null);
                if (!did) continue;
                const name = normalize(li.textContent || '') || String(did);
                const key = `${did}|${name}`;
                if (uniq.has(key)) continue;
                uniq.add(key);
                villages.push({ id: String(did), name });
            }

            return villages;
        });
    }

    async switchToVillage(villageIdOrName) {
        if (this.page.isClosed()) return false;

        const targetRaw = (villageIdOrName || '').toString().trim();
        if (!targetRaw || targetRaw.toLowerCase() === 'main') return true;

        const clicked = await this.page.evaluate((target) => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const wanted = normalize(target);
            const wantedIsId = /^\d+$/.test(wanted);

            const links = Array.from(document.querySelectorAll(
                '#sidebarBoxVillagelist a, .villageList a, a[href*="newdid="], a[href*="dorf1.php?newdid="], a[href*="dorf2.php?newdid="]'
            ));

            for (const a of links) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/[?&]newdid=(\d+)/);
                if (!m) continue;
                const id = m[1];
                const name = normalize(a.textContent || a.innerText || '') || id;

                if (wantedIsId) {
                    if (id === wanted) {
                        a.click();
                        return true;
                    }
                } else {
                    if (name && (name === wanted || name.includes(wanted))) {
                        a.click();
                        return true;
                    }
                }
            }

            const items = Array.from(document.querySelectorAll('#sidebarBoxVillagelist li, .villageList li'));
            for (const li of items) {
                const did = li.getAttribute('data-did') || (li.dataset ? li.dataset.did : null);
                const name = normalize(li.textContent || '') || String(did || '');
                if (!did && !name) continue;

                if (wantedIsId && did && String(did) === wanted) {
                    li.click();
                    return true;
                }
                if (!wantedIsId && name && (name === wanted || name.includes(wanted))) {
                    li.click();
                    return true;
                }
            }

            return false;
        }, targetRaw);

        if (!clicked) {
            logger.warn(`No se pudo cambiar a la aldea "${targetRaw}" (usa village_id=newdid o nombre aproximado).`);
            return false;
        }

        await humanDelay(this.page, 1200, 2200);
        this.invalidateCache();
        return true;
    }

    logCacheStatus() {
        if (!this.fieldCache || !this.fieldCache.length) return;
        const summary = {};
        for (const field of this.fieldCache) {
            if (!summary[field.type]) {
                summary[field.type] = { count: 0, levels: [], building: 0 };
            }
            summary[field.type].count += 1;
            summary[field.type].levels.push(field.level);
            if (field.isBuilding) summary[field.type].building += 1;
        }
        logger.info('Estado de campos:');
        for (const type of Object.keys(summary)) {
            const data = summary[type];
            const minLevel = Math.min(...data.levels);
            const maxLevel = Math.max(...data.levels);
            logger.info(`   ${type}: ${data.count} campos, niveles ${minLevel}-${maxLevel}${data.building ? ` (${data.building} en cola)` : ''}`);
        }
    }

    async findLowestLevelField(buildingType, maxLevel) {
        // Usamos SIEMPRE el escÃ¡ner lento.
        const fields = await this.scanSlotsOneByOne();
        
        // VerificaciÃ³n extra de seguridad
        const typeCount = fields.filter(f => f.type === buildingType).length;
        if (typeCount === 0) {
            throw new Error(`SCAN_FAILED: No se encontraron campos de tipo ${buildingType}`);
        }

        const eligible = fields.filter(f => f.type === buildingType && f.level < maxLevel)
                               .sort((a, b) => a.level - b.level);
        
        return eligible.length > 0 ? eligible[0] : null;
    }

    async checkAndStartAdventure() {
        if (this.page.isClosed()) return false;
        logger.info('ðŸ—ºï¸ Revisando aventuras...');

        try {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 2000, 3000);

            const health = await this.getHeroHealthPercent({ skipNavigation: true });
            logger.info(`Salud del heroe: ${health}%. No se bloquea por salud.`);

            const result = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button.green, .adventureList button'));
                for (const btn of buttons) {
                    const text = (btn.innerText || btn.value || '').toLowerCase().trim();
                    if (text.includes('explorar') || text.includes('comenzar') || text.includes('start')) {
                        if (btn.disabled || btn.classList.contains('disabled')) return { found: true, canClick: false };
                        btn.click();
                        return { found: true, canClick: true };
                    }
                }
                return { found: false };
            });

            if (result.canClick) {
                logger.success('âš”ï¸ Â¡HÃ©roe enviado!');
                await humanDelay(this.page, 2000, 3000);
                return true;
            } else {
                logger.info('Sin aventuras disponibles.');
            }
        } catch (error) {
            logger.warn('Error en aventuras:', error.message);
        }
        return false;
    }

    async checkAndRaidOases(oasisTargets, options = {}) {
        logger.info('Envio de heroe a oasis desactivado.');
        return false;
    }

    async getHeroHealthPercent(options = {}) {
        if (this.page.isClosed()) return 0;
        if (!options.skipNavigation) {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1500, 2500);
        }

        return await this.page.evaluate(() => {
            function extractNumber(text) {
                if (!text) return null;
                const percentMatch = text.match(/(\d{1,3})\s*%/);
                if (percentMatch) return parseInt(percentMatch[1], 10);
                const numberMatch = text.match(/(\d{1,3})/);
                return numberMatch ? parseInt(numberMatch[1], 10) : null;
            }

            const bar = document.querySelector('.heroHealthBar .bar');
            if (bar) {
                const width = bar.style.width || bar.getAttribute('style') || '';
                const match = width.match(/(\d{1,3})/);
                if (match) return Math.min(100, Math.max(0, parseInt(match[1], 10)));
            }

            const heroSection = document.querySelector('.heroHealthBar, .heroStats, .heroAttributes');
            const heroText = heroSection ? heroSection.innerText : '';
            const parsedFromText = extractNumber(heroText);
            if (parsedFromText !== null) return Math.min(100, Math.max(0, parsedFromText));

            const valueNode = document.querySelector('.heroHealthBar .value');
            return extractNumber(valueNode ? valueNode.innerText : '') || 0;
        });
    }

    async inspectOasisNatureTroops(oasis) {
        if (this.page.isClosed()) return null;

        await this.page.goto(`${process.env.GAME_URL}/karte.php?x=${oasis.x}&y=${oasis.y}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1200, 2200);

        return await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const animalWords = [
                'rata', 'ratas', 'rat', 'rats',
                'arana', 'aranas', 'spider', 'spiders',
                'serpiente', 'serpientes', 'snake', 'snakes',
                'murcielago', 'murcielagos', 'bat', 'bats',
                'jabali', 'jabalies', 'boar', 'boars',
                'lobo', 'lobos', 'wolf', 'wolves',
                'oso', 'osos', 'bear', 'bears',
                'cocodrilo', 'cocodrilos', 'crocodile', 'crocodiles',
                'tigre', 'tigres', 'tiger', 'tigers',
                'elefante', 'elefantes', 'elephant', 'elephants'
            ];

            const sumMatches = (source) => {
                let total = 0;
                let found = false;
                for (const word of animalWords) {
                    const regex = new RegExp(`(\\d+)\\s+${word}`, 'g');
                    let m;
                    while ((m = regex.exec(source)) !== null) {
                        total += parseInt(m[1], 10);
                        found = true;
                    }
                }
                return found ? total : null;
            };

            // 1) Intentar sumar desde bloques cercanos a "Tropas"
            const bodyText = normalize(document.body ? document.body.innerText : '');
            if (bodyText) {
                const nearTropas = bodyText.split('tropas').slice(1).join('tropas').slice(0, 400);
                const parsedNear = sumMatches(nearTropas);
                if (parsedNear !== null) return parsedNear;

                const parsedBody = sumMatches(bodyText);
                if (parsedBody !== null) return parsedBody;
            }

            // 2) Buscar listas de tropas en DOM (clases habituales)
            const containers = Array.from(document.querySelectorAll('.troops, .troop, .troopWrapper, .troopList, .troopInfo, .unit, .units, .unitWrapper'));
            for (const node of containers) {
                const text = normalize(node.innerText);
                if (!text) continue;
                const parsed = sumMatches(text);
                if (parsed !== null) return parsed;
            }

            // 3) Fallback clásico
            const patterns = [
                /tropas de la naturaleza[^\d]*(\d+)/i,
                /nature troops[^\d]*(\d+)/i,
                /naturtruppen[^\d]*(\d+)/i
            ];
            for (const pattern of patterns) {
                const match = bodyText.match(pattern);
                if (match) return parseInt(match[1], 10);
            }

            return null;
        });
    }

    async sendHeroFromCurrentOasis() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };

        const result = await this.page.evaluate(() => {
            const findHeroInput = () => {
                const selectors = ['input[name*="hero"]', 'input[id*="hero"]'];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) return el;
                }
                const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
                for (const input of inputs) {
                    const descriptor = (input.name || input.id || input.placeholder || '').toLowerCase();
                    if (descriptor.includes('heroe') || descriptor.includes('hero')) {
                        return input;
                    }
                }
                return null;
            };

            const heroInput = findHeroInput();
            if (!heroInput) return { success: false, reason: 'hero_input_not_found' };
            if (heroInput.disabled) return { success: false, reason: 'hero_input_disabled' };

            heroInput.value = 1;
            heroInput.dispatchEvent(new Event('input', { bubbles: true }));
            heroInput.dispatchEvent(new Event('change', { bubbles: true }));

            const form = heroInput.closest('form') || heroInput.form;
            if (!form) return { success: false, reason: 'form_not_found' };

            const otherInputs = form.querySelectorAll('input[type="text"], input[type="number"]');
            for (const input of otherInputs) {
                if (input === heroInput) continue;
                input.value = 0;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
            const candidate = buttons.find(btn => {
                if (btn.disabled) return false;
                const label = (btn.innerText || btn.value || '').toLowerCase();
                return label.includes('atacar') || label.includes('enviar') || label.includes('attack') || label.includes('send');
            }) || buttons[0];

            if (!candidate) return { success: false, reason: 'submit_button_not_found' };
            if (candidate.disabled) return { success: false, reason: 'submit_button_disabled' };
            candidate.click();
            return { success: true };
        });

        if (result.success) {
            await humanDelay(this.page, 1500, 2200);
        }

        return result;
    }

    async getResourceAmounts() {
        if (this.page.isClosed()) return null;

        try {
            await this.page.goto(`${process.env.GAME_URL}/dorf1.php`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1000, 1600);
        } catch (error) {
            logger.warn('No se pudo visitar Dorf1 para leer recursos: ' + error.message);
            return null;
        }

        return await this.page.evaluate(() => {
            function parseAmount(raw) {
                if (!raw) return null;
                const cleaned = raw.replace(/[\\.\\,\\s]/g, '').replace(/[^0-9]/g, '');
                return cleaned ? parseInt(cleaned, 10) : null;
            }

            const stockBar = document.querySelector('#stockBar');
            const fallbackText = stockBar ? stockBar.innerText : document.body.innerText;
            const variants = {
                wood: ['madera', 'wood', 'holz'],
                clay: ['barro', 'clay', 'lehm', 'arcilla'],
                iron: ['hierro', 'iron', 'eisen', 'mineral'],
                crop: ['cereal', 'crop', 'trigo', 'gran']
            };

            const resources = {};
            for (const type in variants) {
                for (const label of variants[type]) {
                    const regex = new RegExp(label + '[^\\d]*(\\d[\\d\\.\\,]*)\\s*', 'i');
                    const match = fallbackText.match(regex);
                    if (match) {
                        const amount = parseAmount(match[1]);
                        if (amount !== null) {
                            resources[type] = amount;
                            break;
                        }
                    }
                }
            }

            return Object.keys(resources).length ? resources : null;
        });
    }

    async upgradeBuild() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };
        
        logger.info('Buscando botÃ³n de mejora...');
        const result = await this.page.evaluate(() => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const upgradeKeywords = ['mejora', 'mejorar', 'upgrade', 'construir', 'ampliar', 'nivel', 'level', 'build'];
            const blacklist = ['prolong', 'proteger', 'protecc', 'protection', 'plus', 'premium', 'activar', 'comprar', 'confirmar', 'cancelar', 'aventura', 'mision', 'adventure', 'prorrogar'];

            const collect = (root) => Array.from(root.querySelectorAll('button, input[type=\"submit\"], a.button'));
            const scopes = [
                document.querySelector('.buildAction'),
                document.querySelector('#contract'),
                document.querySelector('.upgradeButtons'),
                document.querySelector('.buildWrapper'),
                document.querySelector('.buildingDetails'),
                document
            ].filter(Boolean);

            const seen = new Set();
            const candidates = [];
            for (const scope of scopes) {
                for (const el of collect(scope)) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    candidates.push(el);
                }
            }

            for (const btn of candidates) {
                const text = normalize(btn.innerText || btn.value || '');
                const classes = normalize(btn.className || '');

                if (btn.disabled || classes.includes('disabled')) continue;
                if (classes.includes('gold')) continue;
                if (blacklist.some(word => text.includes(word))) continue;
                if (text.includes('npc') || text.includes('intercambiar')) continue;
                // Evitar diálogos de protección/plus
                if (text.includes('prolong') || text.includes('proteger') || text.includes('protecc')) continue;

                const isUpgradeKeyword = upgradeKeywords.some(k => text.includes(k));
                const isUpgradeClass = ['build', 'upgrade', 'contract'].some(k => classes.includes(k));
                if (!isUpgradeKeyword && !isUpgradeClass) continue;

                btn.click();
                return { success: true };
            }
            if (document.querySelector('.queueFull, .buildingQueueFull')) return { success: false, reason: 'queue_full' };
            return { success: false, reason: 'not_enough_resources' };
        });

        if (result.success) {
            await humanDelay(this.page, 2000, 3000);
            return { success: true };
        }
        return { success: false, reason: result.reason };
    }

    async constructBuildingFromEmptySlot(buildingName) {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };
        const wanted = this._normalizeText(buildingName);
        if (!wanted) return { success: false, reason: 'missing_building_name' };

        const clicked = await this.page.evaluate((rawName) => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const wanted = normalize(rawName);

            const anchorsRaw = Array.from(document.querySelectorAll('a[href*="gid="]'));
            const anchors = anchorsRaw.length ? anchorsRaw : Array.from(document.querySelectorAll('a'));

            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                if (!href.includes('gid=')) continue;
                const t = normalize(a.textContent || a.innerText || '');
                if (!t) continue;
                if (t === wanted || t.includes(wanted)) {
                    a.click();
                    return true;
                }
            }

            // Fallback: tarjetas/listas con nombre + link gid dentro
            const cards = Array.from(document.querySelectorAll('.buildingWrapper, .building, .buildNewBuilding, .newBuilding, li, .content, #content'));
            for (const c of cards) {
                const t = normalize(c.textContent || '');
                if (!t) continue;
                if (!(t === wanted || t.includes(wanted))) continue;
                const link = c.querySelector('a[href*="gid="]');
                if (link) {
                    link.click();
                    return true;
                }
            }

            return false;
        }, buildingName);

        if (!clicked) return { success: false, reason: 'building_choice_not_found' };

        await humanDelay(this.page, 900, 1500);
        const build = await this.upgradeBuild();
        return build.success ? { success: true } : build;
    }

    async executeTraining(buildingType, troopIdentifier, quantity = -1, buildingSlot = null) {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };

        const slot = await this.findBuildingSlot(buildingType, buildingSlot);
        if (!slot) return { success: false, reason: 'building_not_found' };

        try {
            await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1200, 2000);
        } catch (error) {
            logger.warn('No se pudo abrir la pagina de entrenamiento: ' + error.message);
            return { success: false, reason: 'navigation_failed' };
        }

        const result = await this.page.evaluate(({ identifier, quantity }) => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const identifierIsNumber = typeof identifier === 'number' || (typeof identifier === 'string' && /^\d+$/.test(identifier));
            const targetIndex = identifierIsNumber ? parseInt(identifier, 10) : null;
            const targetName = identifierIsNumber ? null : normalize(identifier);

            const allInputs = Array.from(document.querySelectorAll('input[name^="t"], input[name*="t"], input[data-unitid], input[data-unit], input[type="number"]'));
            const rows = allInputs.map(input => input.closest('tr') || input.closest('.unit') || input.closest('.trainUnits') || input.closest('.textList') || input.closest('.unitWrapper') || input.parentElement).filter(Boolean);

            const pickQuantity = (row, input) => {
                if (quantity !== -1) return quantity;

                const maxAttr = input.getAttribute('max');
                if (maxAttr && !isNaN(parseInt(maxAttr, 10))) return parseInt(maxAttr, 10);

                const maxNode = row.querySelector('.max, a.max');
                if (maxNode) {
                    const match = maxNode.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }

                const valueNode = row.querySelector('.value, .maxValue');
                if (valueNode) {
                    const match = valueNode.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }

                return 0;
            };

            const seen = new Set();
            for (const row of rows) {
                if (seen.has(row)) continue;
                seen.add(row);

                const input = row.querySelector('input[name^="t"], input[name*="t"], input[data-unitid], input[data-unit], input[type="number"]');
                if (!input) continue;

                const inputName = input.getAttribute('name') || '';
                const dataUnit = input.getAttribute('data-unitid') || input.getAttribute('data-unit') || null;
                const indexMatch = inputName.match(/t(\d+)/);
                const troopIndex = indexMatch ? parseInt(indexMatch[1], 10) : (dataUnit ? parseInt(dataUnit, 10) : null);

                const rowText = normalize(row.innerText);
                const imgAlt = normalize((row.querySelector('img') || {}).alt || '');
                const candidateText = `${rowText} ${imgAlt}`.trim();

                const matches = targetIndex !== null
                    ? troopIndex === targetIndex
                    : candidateText.includes(targetName);

                if (!matches) continue;

                const qty = pickQuantity(row, input);
                if (!qty || qty <= 0) {
                    return { success: false, reason: 'not_enough_resources_or_zero_max' };
                }

                if (typeof input.scrollIntoView === 'function') {
                    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                input.value = qty;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));

                const form = input.closest('form') || document.querySelector('form[action*="train"]');
                if (!form) return { success: false, reason: 'form_not_found' };

                const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
                const btn = buttons.find(b => {
                    if (b.disabled) return false;
                    const label = normalize(b.innerText || b.value || '');
                    if (label.includes('formacion') || label.includes('formar') || label.includes('formation')) return true;
                    return label.includes('entrenar') || label.includes('train') || label.includes('reclutar') || label.includes('enviar');
                }) || buttons.find(b => !b.disabled);

                if (!btn) return { success: false, reason: 'submit_button_not_found' };
                if (typeof btn.scrollIntoView === 'function') {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                btn.click();
                const isSubmitBtn = (btn.tagName === 'BUTTON' && (btn.getAttribute('type') || '').toLowerCase() === 'submit') ||
                    (btn.tagName === 'INPUT' && (btn.getAttribute('type') || '').toLowerCase() === 'submit');
                if (typeof form.requestSubmit === 'function') {
                    if (isSubmitBtn) form.requestSubmit(btn);
                    else form.requestSubmit();
                } else if (typeof form.submit === 'function') {
                    form.submit();
                }
                return { success: true, trained: qty };
            }

            return { success: false, reason: 'troop_not_found' };
        }, { identifier: troopIdentifier, quantity });

        if (!result.success) return result;

        await humanDelay(this.page, 2000, 3200);

        // Recargar la página para leer la cola actualizada
        try {
            await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 900, 1400);
        } catch (navErr) {
            logger.warn('No se pudo recargar pagina de entrenamiento para verificar cola: ' + navErr.message);
        }

        const verify = await this.page.evaluate(({ identifier }) => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const targetName = typeof identifier === 'string'
                ? normalize(identifier)
                : null;

            const errorEl = document.querySelector('.error, .alert, .warning, .messageError');
            if (errorEl) {
                return { ok: false, reason: 'page_error', message: normalize(errorEl.innerText) };
            }

            const queueSelectors = [
                '.under_progress', '.under-progress', '.trainingQueue', '.productionQueue',
                '.queue', '.underConstruction', '.build_queue', '.buildingList .under_progress',
                '.boxes-contents .under_progress', '.boxes-contents .under-progress',
                '.productionWrapper .under_progress', '.productionWrapper .under-progress',
                '#trainQueue', '.trainingList', '.queueWrapper', '.unitQueue'
            ];

            const queueEntries = Array.from(document.querySelectorAll(queueSelectors.join(',')))
                // Evitar el formulario principal de entrenamiento (contiene inputs numéricos)
                .filter(node => !node.querySelector('input[type=\"number\"], input[name^=\"t\"], input[name*=\"t\"]'));

            const matchesEntry = (node) => {
                const text = normalize(node.innerText || '');
                const hasTimer = /\d{1,2}:\d{2}/.test(text) || text.includes('curso') || text.includes('cola') || text.includes('queue');

                // Revisar imágenes con alt/title
                const imgs = Array.from(node.querySelectorAll('img'));
                const imgMatch = targetName && imgs.some(img => {
                    const alt = normalize(img.getAttribute('alt') || '');
                    const title = normalize(img.getAttribute('title') || '');
                    return alt.includes(targetName) || title.includes(targetName);
                });

                if (targetName) {
                    if (hasTimer && text.includes(targetName)) return true;
                    if (hasTimer && imgMatch) return true;
                } else if (hasTimer && /\d+\s*x/.test(text)) {
                    return true;
                }

                return false;
            };

            if (queueEntries.some(matchesEntry)) return { ok: true };

            // Fallback: buscar timers y nombre de tropa en bloques con temporizador
            const timers = Array.from(document.querySelectorAll('.timer, .dur, .countdown'));
            for (const timer of timers) {
                const container = timer.closest('li, tr, .textList, .buildDetails, .details, .queue, .under_progress, .under-progress') || timer.parentElement;
                const text = normalize((container && container.innerText) || '');
                if (!text) continue;

                const imgs = container ? Array.from(container.querySelectorAll('img')) : [];
                const imgMatch = targetName && imgs.some(img => {
                    const alt = normalize(img.getAttribute('alt') || '');
                    const title = normalize(img.getAttribute('title') || '');
                    return alt.includes(targetName) || title.includes(targetName);
                });

                if (targetName) {
                    if (text.includes(targetName) || imgMatch) return { ok: true };
                } else if (/\d+\s*x/.test(text)) {
                    return { ok: true };
                }
            }

            const queueText = queueEntries.map(n => normalize(n.innerText || '')).filter(Boolean).slice(0, 5);

            return { ok: false, reason: 'training_not_queued', queueText };
        }, { identifier: troopIdentifier }).catch(() => null);

        if (!verify || !verify.ok) {
            try { await this.screenshot('training-fail.png'); } catch (e) {}
            return {
                success: false,
                reason: (verify && verify.reason) || 'training_not_queued',
                detail: (verify && verify.message) || null,
                queueText: (verify && verify.queueText) || null
            };
        }

        return result;
    }

    async getBuildingInfo() {
        if (this.page.isClosed()) return {};
        return await this.page.evaluate(() => {
            const isEmpty =
                !!document.querySelector('.g0, .aid0, .buildingWrapper.g0, .buildingWrapper.aid0, .constructionSite, .buildNewBuilding, .newBuilding') ||
                !!document.querySelector('a[href*="gid="], a[href*="gid="] .name');

            const titleEl = document.querySelector('.titleInHeader, h1');
            if (!titleEl) {
                return { empty: isEmpty, name: null, level: 0 };
            }

            const text = (titleEl.textContent || '').trim();
            const levelMatch = text.match(/(\d+)/);
            return {
                empty: false,
                name: text.replace(/\d+/, '').trim(),
                level: levelMatch ? parseInt(levelMatch[0]) : 0
            };
        });
    }

    async screenshot(filename) {
        if (this.page && !this.page.isClosed()) await this.page.screenshot({ path: filename });
    }

    async getCurrentVillageCoordinates(options = {}) {
        if (this.page.isClosed()) return null;

        if (typeof options.x === 'number' && typeof options.y === 'number') {
            return { x: options.x, y: options.y, source: 'options' };
        }

        const envX = process.env.FARM_CENTER_X;
        const envY = process.env.FARM_CENTER_Y;
        if (envX && envY && !Number.isNaN(parseInt(envX, 10)) && !Number.isNaN(parseInt(envY, 10))) {
            return { x: parseInt(envX, 10), y: parseInt(envY, 10), source: 'env' };
        }

        await this.page.goto(`${process.env.GAME_URL}/karte.php`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1200, 2000);

        const coords = await this.page.evaluate(() => {
            const tryParsePair = (text) => {
                if (!text) return null;
                const m = String(text).match(/\((-?\d+)\s*\|\s*(-?\d+)\)/);
                if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
                return null;
            };

            const xInput = document.querySelector('#xCoord, input[name="xCoord"], input[name="x"], input[name="xcoord"], input[id*="xCoord"]');
            const yInput = document.querySelector('#yCoord, input[name="yCoord"], input[name="y"], input[name="ycoord"], input[id*="yCoord"]');

            if (xInput && yInput) {
                const x = parseInt(xInput.value, 10);
                const y = parseInt(yInput.value, 10);
                if (!Number.isNaN(x) && !Number.isNaN(y)) return { x, y };
            }

            const header = document.querySelector('#map') || document.querySelector('#content') || document.body;
            const fromHeader = tryParsePair(header && header.innerText);
            if (fromHeader) return fromHeader;

            return tryParsePair(document.body && document.body.innerText);
        });

        if (!coords || Number.isNaN(coords.x) || Number.isNaN(coords.y)) {
            throw new Error('No se pudieron detectar las coordenadas de la aldea. Define FARM_CENTER_X y FARM_CENTER_Y en .env.');
        }

        return { x: coords.x, y: coords.y, source: 'map' };
    }

    _generateCoordsInRadius(centerX, centerY, maxDistance) {
        const coords = [];
        const d = Math.max(0, Math.floor(maxDistance));
        for (let dx = -d; dx <= d; dx++) {
            for (let dy = -d; dy <= d; dy++) {
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist === 0) continue;
                if (dist > maxDistance) continue;
                coords.push({ x: centerX + dx, y: centerY + dy, dist });
            }
        }
        coords.sort((a, b) => a.dist - b.dist);
        return coords;
    }

    _distance(aX, aY, bX, bY) {
        const dx = bX - aX;
        const dy = bY - aY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    async _getMapTileVillageInfo(x, y) {
        if (this.page.isClosed()) return null;

        await this.page.goto(`${process.env.GAME_URL}/karte.php?x=${x}&y=${y}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 900, 1500);

        return await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const detailsEl =
                document.querySelector('#tileDetails') ||
                document.querySelector('#mapDetails') ||
                document.querySelector('.tileDetails') ||
                document.querySelector('.mapDetails') ||
                document.querySelector('#content') ||
                document.body;

            const detailsText = normalize(detailsEl ? detailsEl.innerText : document.body.innerText);

            const isOasis = detailsText.includes('oasis');
            const looksLikeVillage =
                detailsText.includes('aldea') ||
                detailsText.includes('village') ||
                detailsText.includes('pueblo') ||
                detailsText.includes('habitantes') ||
                detailsText.includes('population') ||
                detailsText.includes('inhabitants');

            if (!looksLikeVillage || isOasis) return null;

            const popMatch =
                detailsText.match(/habitantes\s*[:\-]?\s*(\d{1,6})/) ||
                detailsText.match(/population\s*[:\-]?\s*(\d{1,6})/) ||
                detailsText.match(/inhabitants\s*[:\-]?\s*(\d{1,6})/);

            const population = popMatch ? parseInt(popMatch[1], 10) : null;
            if (population === null || Number.isNaN(population)) return null;

            const titleEl =
                document.querySelector('#tileDetails h1, #tileDetails .title, #mapDetails h1, h1, .titleInHeader') ||
                null;
            const rawTitle = titleEl ? (titleEl.textContent || '').trim() : '';

            // Intentar extraer "Nombre" de: "Vesnice: Gregi (Capital) (-75|71)"
            let name = rawTitle;
            const labelMatch = name.match(/^\s*(vesnice|aldea|village)\s*:\s*(.+)$/i);
            if (labelMatch) name = labelMatch[2];
            name = name.replace(/\(\s*-?\d+\s*\|\s*-?\d+\s*\)\s*$/g, '').trim();
            // Quitar sufijos tipo "(Capital)" dejando el nombre base
            name = name.replace(/\([^)]*\)\s*$/g, '').trim();
            if (!name) name = null;

            return { population, name };
        });
    }

    async addToFarmListFromMap(x, y, listName) {
        if (this.page.isClosed()) return false;

        // Estamos ya en el detalle del mapa (karte.php?x=...&y=...)
        const clicked = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['agregar a la lista de vacas', 'add to farm list', 'add to farmlist'];
            const links = Array.from(document.querySelectorAll('a, button'));
            for (const el of links) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (!t) continue;
                if (wanted.some(w => t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (!clicked) return false;

        await humanDelay(this.page, 900, 1500);

        // En algunos servidores aparece un mini-form para elegir lista; lo intentamos de forma genérica.
        const selected = await this.page.evaluate((rawListName) => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const listName = normalize(rawListName);
            const selects = Array.from(document.querySelectorAll('select'));
            for (const sel of selects) {
                const options = Array.from(sel.querySelectorAll('option'));
                const match = options.find(o => normalize(o.textContent || '') === listName || normalize(o.textContent || '').includes(listName));
                if (match) {
                    sel.value = match.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
            }
            return false;
        }, listName);

        if (selected) await humanDelay(this.page, 400, 900);

        const confirmed = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['agregar', 'anadir', 'añadir', 'ok', 'aceptar', 'guardar', 'save'];
            const candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (!t) continue;
                if (wanted.some(w => t === normalize(w) || t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (confirmed) await humanDelay(this.page, 900, 1500);
        return true;
    }

    async findRallyPointSlot(explicitSlot) {
        return await this.findBuildingSlot('rallyPoint', explicitSlot);
    }

    _farmListNameForIndex(baseName, index) {
        if (index <= 1) return baseName;
        return `${baseName}-${index}`;
    }

    async _openFarmListTab(options = {}) {
        if (this.page.isClosed()) return false;
        const rallySlot = await this.findRallyPointSlot(options.rallySlot);
        if (!rallySlot) throw new Error('No se pudo localizar la Plaza de reuniones (rally point).');

        await this.page.goto(`${process.env.GAME_URL}/build.php?id=${rallySlot}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1200, 2000);

        const openedTab = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['lista de vacas', 'farm list', 'raid list'];
            const candidates = Array.from(document.querySelectorAll('a, button'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (wanted.some(w => t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (!openedTab) {
            logger.warn('No se pudo abrir la pesta¤a de "Lista de vacas" por texto. Continuando igualmente...');
        }

        await humanDelay(this.page, 900, 1500);
        return true;
    }

    async _getFarmListNamesOnPage() {
        if (this.page.isClosed()) return [];

        return await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const uniq = new Set();
            const names = [];

            const listCandidates = Array.from(document.querySelectorAll(
                'a, button, .raidList, .listEntry, .listTitle, .name, .raidListTitle, .listTitleText'
            ));

            for (const el of listCandidates) {
                const t = normalize(el.textContent || el.innerText || '');
                if (!t) continue;
                if (t.length > 50) continue;
                if (t.includes('comenzar') || t.includes('start all') || t.includes('todas las')) continue;
                if (uniq.has(t)) continue;
                uniq.add(t);
                names.push(t);
            }

            return names;
        });
    }

    async _selectFarmListOnPage(listName) {
        if (this.page.isClosed()) return false;

        const selectedList = await this.page.evaluate((rawName) => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const wanted = normalize(rawName);
            const listCandidates = Array.from(document.querySelectorAll('a, button, .raidList, .listEntry, .listTitle, .name, .raidListTitle, .listTitleText'));

            for (const el of listCandidates) {
                const t = normalize(el.textContent || el.innerText || '');
                if (!t) continue;
                if (t === wanted || t.includes(wanted)) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, listName);

        if (selectedList) await humanDelay(this.page, 800, 1400);
        return !!selectedList;
    }

    async _createFarmListOnPage(listName) {
        if (this.page.isClosed()) return false;

        const created = await this.page.evaluate((rawName) => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const wantedCreate = [
                'nueva lista', 'crear lista', 'crear nueva lista', 'nueva lista de vacas',
                'new list', 'create list', 'create new list', 'new farm list', 'new raid list'
            ];

            const clickCreate = () => {
                const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
                for (const el of candidates) {
                    const t = normalize(el.textContent || el.innerText || el.value);
                    if (!t) continue;
                    if (wantedCreate.some(w => t.includes(normalize(w)))) {
                        el.click();
                        return true;
                    }
                }
                return false;
            };

            const clicked = clickCreate();
            if (!clicked) return false;

            const name = String(rawName || '').trim();
            if (!name) return false;

            const input =
                document.querySelector('input[name*="name" i]') ||
                document.querySelector('input[id*="name" i]') ||
                document.querySelector('input[placeholder*="nombre" i]') ||
                document.querySelector('input[placeholder*="name" i]');

            if (input) {
                input.focus();
                input.value = name;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const wantedOk = ['crear', 'guardar', 'ok', 'aceptar', 'save', 'create'];
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.button'));
            for (const el of buttons) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (!t) continue;
                if (wantedOk.some(w => t === normalize(w) || t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }

            return true;
        }, listName);

        if (created) await humanDelay(this.page, 1200, 2000);
        return !!created;
    }

    async openFarmList(listName, options = {}) {
        if (this.page.isClosed()) return false;

        await this._openFarmListTab({ rallySlot: options.rallySlot });

        const openedTab = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['lista de vacas', 'farm list', 'raid list'];
            const candidates = Array.from(document.querySelectorAll('a, button'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (wanted.some(w => t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (!openedTab) {
            logger.warn('No se pudo abrir la pestaña de "Lista de vacas" por texto. Continuando igualmente...');
        }

        await humanDelay(this.page, 1200, 2000);

        const selectedList = await this.page.evaluate((rawName) => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const wanted = normalize(rawName);
            const listCandidates = Array.from(document.querySelectorAll('a, button, .raidList, .listEntry, .listTitle, .name'));

            for (const el of listCandidates) {
                const t = normalize(el.textContent || el.innerText || '');
                if (!t) continue;
                if (t === wanted || t.includes(wanted)) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, listName);

        let selected = selectedList;
        if (!selected && options.createIfMissing) {
            const existingNames = await this._getFarmListNamesOnPage();
            const wanted = this._normalizeText(listName);
            const exists = existingNames.some(n => n === wanted || n.includes(wanted));

            if (!exists) {
                logger.info(`Creando lista de vacas: "${listName}"...`);
                await this._createFarmListOnPage(listName);
            }

            selected = await this._selectFarmListOnPage(listName);
        }

        if (!selected) {
            logger.warn(`No se pudo seleccionar la lista "${listName}" por texto. Si ya está abierta, esto es normal.`);
        } else {
            await humanDelay(this.page, 800, 1400);
        }

        return true;
    }

    async startAllFarmLists(options = {}) {
        if (this.page.isClosed()) return false;
        const rallySlot = await this.findRallyPointSlot(options.rallySlot);
        if (!rallySlot) throw new Error('No se pudo localizar la Plaza de reuniones (rally point).');

        await this.page.goto(`${process.env.GAME_URL}/build.php?id=${rallySlot}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1200, 2000);

        // Asegurar pestaña "Lista de vacas"
        await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['lista de vacas', 'farm list', 'raid list'];
            const candidates = Array.from(document.querySelectorAll('a, button'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (wanted.some(w => t.includes(normalize(w)))) {
                    el.click();
                    return;
                }
            }
        });
        await humanDelay(this.page, 900, 1500);

        const clicked = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const wanted = [
                'comenzar todas las listas de vacas',
                'comenzar todas las listas',
                'start all farm lists',
                'start all raid lists'
            ];

            const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (!t) continue;
                if (!wanted.some(w => t.includes(normalize(w)))) continue;

                // Preferir el botón verde si existe
                const classText = normalize(el.className || '');
                const isGreen = classText.includes('green') || classText.includes('start') || classText.includes('go');
                if (isGreen || el.tagName.toLowerCase() === 'button') {
                    el.click();
                    return true;
                }
            }

            // Fallback: botón verde genérico que contiene "comenzar"
            const greenButtons = Array.from(document.querySelectorAll('button.green, .green button, a.green, .green a'));
            for (const el of greenButtons) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (t.includes('comenzar') || t.includes('start')) {
                    el.click();
                    return true;
                }
            }

            return false;
        });

        if (clicked) {
            await humanDelay(this.page, 1200, 2000);
            return true;
        }

        return false;
    }

    async getFarmListTargets() {
        if (this.page.isClosed()) return [];

        return await this.page.evaluate(() => {
            const uniq = new Set();
            const targets = [];

            const extractPair = (text) => {
                if (!text) return null;
                const m = String(text).match(/\((-?\d+)\s*\|\s*(-?\d+)\)/) || String(text).match(/(^|\s)(-?\d+)\s*\|\s*(-?\d+)(\s|$)/);
                if (!m) return null;
                const x = parseInt(m[m.length - 3], 10);
                const y = parseInt(m[m.length - 2], 10);
                if (Number.isNaN(x) || Number.isNaN(y)) return null;
                return { x, y };
            };

            const rowCandidates = Array.from(document.querySelectorAll('tr, .raidListEntry, .farmListEntry, .slotRow'));
            for (const row of rowCandidates) {
                const pair = extractPair(row.innerText);
                if (!pair) continue;
                const key = `${pair.x}|${pair.y}`;
                if (uniq.has(key)) continue;
                uniq.add(key);
                targets.push(pair);
            }
            return targets;
        });
    }

    async addFarmListTarget(x, y, options = {}) {
        if (this.page.isClosed()) return false;

        const clicked = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['anadir objetivo', 'añadir objetivo', 'add target', 'nuevo objetivo'];
            const candidates = Array.from(document.querySelectorAll('a, button'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (wanted.some(w => t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (!clicked) {
            throw new Error('No se encontró el botón "Añadir objetivo" en la lista de vacas.');
        }

        await humanDelay(this.page, 800, 1400);

        const filled = await this.page.evaluate(({ x, y, name }) => {
            const xInput =
                document.querySelector('#xCoord, input[name="xCoord"], input[name="x"], input[name="xcoord"], input[id*="xCoord"]') ||
                document.querySelector('input[placeholder*="x" i]');
            const yInput =
                document.querySelector('#yCoord, input[name="yCoord"], input[name="y"], input[name="ycoord"], input[id*="yCoord"]') ||
                document.querySelector('input[placeholder*="y" i]');

            if (!xInput || !yInput) return false;
            xInput.focus();
            xInput.value = String(x);
            xInput.dispatchEvent(new Event('input', { bubbles: true }));
            xInput.dispatchEvent(new Event('change', { bubbles: true }));

            yInput.focus();
            yInput.value = String(y);
            yInput.dispatchEvent(new Event('input', { bubbles: true }));
            yInput.dispatchEvent(new Event('change', { bubbles: true }));

            if (name) {
                const nameInput =
                    document.querySelector('input[name*="name" i], input[id*="name" i]') ||
                    document.querySelector('input[placeholder*="nombre" i], input[placeholder*="name" i]');
                if (nameInput) {
                    nameInput.focus();
                    nameInput.value = String(name);
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            return true;
        }, { x, y, name: options.name || null });

        if (!filled) {
            throw new Error('No se encontraron inputs X/Y al añadir objetivo.');
        }

        await humanDelay(this.page, 400, 900);

        const confirmed = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['anadir', 'añadir', 'agregar', 'ok', 'aceptar', 'guardar', 'save'];
            const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (wanted.some(w => t === normalize(w) || t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (!confirmed) {
            logger.warn('No se encontró botón de confirmación al añadir objetivo; puede que se guarde automáticamente.');
        }

        await humanDelay(this.page, 1000, 1600);
        return true;
    }

    async setFarmListTroopsForTarget(x, y, troopCounts) {
        if (this.page.isClosed()) return false;
        const clubCount = troopCounts && typeof troopCounts.t1 === 'number' ? troopCounts.t1 : null;
        if (clubCount === null) return false;

        const updated = await this.page.evaluate(({ x, y, clubCount }) => {
            const coordNeedleA = `(${x}|${y})`;
            const coordNeedleB = `${x}|${y}`;

            const rows = Array.from(document.querySelectorAll('tr, .raidListEntry, .farmListEntry, .slotRow'));

            const fireInputEvents = (input) => {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            };

            for (const row of rows) {
                const text = row.innerText || '';
                if (!text.includes(coordNeedleA) && !text.includes(coordNeedleB)) continue;

                const input =
                    row.querySelector('input[name*="t1"]') ||
                    row.querySelector('input[name*="troops[1]"]') ||
                    row.querySelector('input[data-unit="1"]') ||
                    row.querySelector('input[class*="u1"]') ||
                    row.querySelector('input');

                if (!input) return false;
                input.focus();
                input.value = String(clubCount);
                fireInputEvents(input);
                return true;
            }
            return false;
        }, { x, y, clubCount });

        if (!updated) {
            logger.warn(`No se pudo configurar tropas para objetivo (${x}|${y}).`);
            return false;
        }

        await humanDelay(this.page, 250, 600);
        return true;
    }

    async setFarmListTroopsForAllTargets(troopCounts) {
        if (this.page.isClosed()) return 0;
        const clubCount = troopCounts && typeof troopCounts.t1 === 'number' ? troopCounts.t1 : null;
        if (clubCount === null) return 0;

        const changed = await this.page.evaluate(({ clubCount }) => {
            const rows = Array.from(document.querySelectorAll('tr, .raidListEntry, .farmListEntry, .slotRow'));
            let updated = 0;

            const fireInputEvents = (input) => {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            };

            for (const row of rows) {
                const input =
                    row.querySelector('input[name*="t1"]') ||
                    row.querySelector('input[name*="troops[1]"]') ||
                    row.querySelector('input[data-unit="1"]') ||
                    row.querySelector('input[class*="u1"]');

                if (!input) continue;
                if (String(input.value || '').trim() === String(clubCount)) continue;
                input.focus();
                input.value = String(clubCount);
                fireInputEvents(input);
                updated += 1;
            }

            return updated;
        }, { clubCount });

        if (changed > 0) await humanDelay(this.page, 400, 900);
        return changed;
    }

    async saveFarmListIfNeeded() {
        if (this.page.isClosed()) return false;

        const clicked = await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const wanted = ['guardar', 'save'];
            const candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
            for (const el of candidates) {
                const t = normalize(el.textContent || el.innerText || el.value);
                if (wanted.some(w => t === normalize(w) || t.includes(normalize(w)))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            await humanDelay(this.page, 1200, 1800);
        }
        return clicked;
    }

    async updateFarmListFromNearbyVillages(options = {}) {
        const listName = options.listName || 'raid';
        const maxPopulation = typeof options.maxPopulation === 'number' ? options.maxPopulation : 50;
        const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 20;
        const troopCounts = options.troopCounts || { t1: 2 };
        // maxTargets = total deseado en la lista (no "nuevos a a¤adir")
        const maxTargets = typeof options.maxTargets === 'number' ? options.maxTargets : 100;
        const applyTroopsToExisting = options.applyTroopsToExisting !== false;
        const addMethod = options.addMethod || 'map';

        const center = await this.getCurrentVillageCoordinates({ x: options.centerX, y: options.centerY });
        logger.info(`Centro de busqueda: (${center.x}|${center.y}) [${center.source}]`);

        await this.openFarmList(listName, { rallySlot: options.rallySlot });
        if (applyTroopsToExisting) {
            const changed = await this.setFarmListTroopsForAllTargets(troopCounts);
            if (changed > 0) logger.info(`Tropas aplicadas a objetivos existentes: ${changed}`);
        }

        const existing = await this.getFarmListTargets();
        const existingSet = new Set(existing.map(t => `${t.x}|${t.y}`));
        logger.info(`Objetivos actuales en lista "${listName}": ${existing.length}`);

        const remaining = Math.max(0, maxTargets - existing.length);
        if (remaining === 0) {
            logger.info(`La lista "${listName}" ya tiene ${existing.length} objetivos (max=${maxTargets}).`);
        }

        const coordList = this._generateCoordsInRadius(center.x, center.y, maxDistance);
        const added = [];

        for (const c of coordList) {
            if (added.length >= remaining) break;
            const key = `${c.x}|${c.y}`;
            if (existingSet.has(key)) continue;

            let info = null;
            try {
                info = await this._getMapTileVillageInfo(c.x, c.y);
            } catch (e) {
                logger.warn(`Error leyendo mapa en (${c.x}|${c.y}): ${e.message}`);
                continue;
            }

            if (!info) continue;
            if (typeof info.population !== 'number') continue;
            if (info.population >= maxPopulation) continue;

            logger.info(`Anadiendo objetivo (${c.x}|${c.y}) hab=${info.population} dist=${c.dist.toFixed(1)}`);

            try {
                let addedOk = false;

                if (addMethod === 'map') {
                    // Ya estamos en el mapa por _getMapTileVillageInfo
                    addedOk = await this.addToFarmListFromMap(c.x, c.y, listName);
                }

                // Fallback: añadir desde la farmlist, pero con nombre si está disponible
                if (!addedOk) {
                    await this.openFarmList(listName, { rallySlot: options.rallySlot });
                    await this.addFarmListTarget(c.x, c.y, { name: info.name || undefined });
                    addedOk = true;
                }

                if (!addedOk) throw new Error('No se pudo agregar a la lista.');
                existingSet.add(key);
                added.push({ x: c.x, y: c.y, population: info.population, dist: c.dist });
            } catch (e) {
                logger.warn(`No se pudo anadir (${c.x}|${c.y}): ${e.message}`);
            }
        }

        // Reaplicar tropas a todos los objetivos (incluye los nuevos) y guardar
        await this.openFarmList(listName, { rallySlot: options.rallySlot });
        await this.setFarmListTroopsForAllTargets(troopCounts);
        await this.saveFarmListIfNeeded();

        return {
            center,
            listName,
            addedCount: added.length,
            added,
            maxPopulation,
            maxDistance,
            troopCounts,
            maxTargets
        };
    }

    async updateFarmListsFromNearbyVillages(options = {}) {
        const listName = options.listName || 'raid';
        const maxPopulation = typeof options.maxPopulation === 'number' ? options.maxPopulation : 50;
        const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 20;
        const troopCounts = options.troopCounts || { t1: 2 };
        const maxTargetsPerList = typeof options.maxTargetsPerList === 'number' ? options.maxTargetsPerList : 100;
        const totalTargets = typeof options.totalTargets === 'number' ? options.totalTargets : maxTargetsPerList;
        const applyTroopsToExisting = options.applyTroopsToExisting !== false;
        const addMethod = options.addMethod || 'map';
        const maxLists = typeof options.maxLists === 'number' ? options.maxLists : 20;

        const center = await this.getCurrentVillageCoordinates({ x: options.centerX, y: options.centerY });
        logger.info(`Centro de busqueda: (${center.x}|${center.y}) [${center.source}]`);

        const wantedTotal = Math.max(0, totalTargets);
        if (wantedTotal === 0) {
            return {
                center,
                listName,
                addedCount: 0,
                added: [],
                lists: [],
                maxPopulation,
                maxDistance,
                troopCounts,
                maxTargetsPerList,
                totalTargets: wantedTotal,
                source: 'map'
            };
        }

        const coordList = this._generateCoordsInRadius(center.x, center.y, maxDistance);
        const globalExistingSet = new Set();
        const added = [];
        const lists = [];
        let cursor = 0;

        for (let listIndex = 1; listIndex <= maxLists && added.length < wantedTotal; listIndex += 1) {
            const currentListName = this._farmListNameForIndex(listName, listIndex);
            await this.openFarmList(currentListName, { rallySlot: options.rallySlot, createIfMissing: true });

            if (applyTroopsToExisting) {
                const changed = await this.setFarmListTroopsForAllTargets(troopCounts);
                if (changed > 0) logger.info(`Tropas aplicadas a objetivos existentes (${currentListName}): ${changed}`);
            }

            const existing = await this.getFarmListTargets();
            for (const t of existing) globalExistingSet.add(`${t.x}|${t.y}`);
            logger.info(`Objetivos actuales en lista "${currentListName}": ${existing.length}`);

            const remainingInList = Math.max(0, maxTargetsPerList - existing.length);
            if (remainingInList === 0) {
                lists.push({ listName: currentListName, addedCount: 0, existingCount: existing.length, isFull: true });
                continue;
            }

            const remainingTotal = wantedTotal - added.length;
            const toAddHere = Math.min(remainingInList, remainingTotal);
            let addedThisList = 0;

            while (addedThisList < toAddHere && cursor < coordList.length) {
                const c = coordList[cursor];
                cursor += 1;

                const key = `${c.x}|${c.y}`;
                if (globalExistingSet.has(key)) continue;

                let info = null;
                try {
                    info = await this._getMapTileVillageInfo(c.x, c.y);
                } catch (e) {
                    logger.warn(`Error leyendo mapa en (${c.x}|${c.y}): ${e.message}`);
                    continue;
                }

                if (!info) continue;
                if (typeof info.population !== 'number') continue;
                if (info.population >= maxPopulation) continue;

                logger.info(`Anadiendo objetivo (${c.x}|${c.y}) hab=${info.population} dist=${c.dist.toFixed(1)} -> ${currentListName}`);

                try {
                    let addedOk = false;

                    if (addMethod === 'map') {
                        addedOk = await this.addToFarmListFromMap(c.x, c.y, currentListName);
                    }

                    if (!addedOk) {
                        await this.openFarmList(currentListName, { rallySlot: options.rallySlot });
                        await this.addFarmListTarget(c.x, c.y, { name: info.name || undefined });
                        addedOk = true;
                    }

                    if (!addedOk) throw new Error('No se pudo agregar a la lista.');
                    globalExistingSet.add(key);
                    added.push({ x: c.x, y: c.y, population: info.population, dist: c.dist, listName: currentListName });
                    addedThisList += 1;
                } catch (e) {
                    logger.warn(`No se pudo anadir (${c.x}|${c.y}): ${e.message}`);
                }
            }

            await this.openFarmList(currentListName, { rallySlot: options.rallySlot });
            await this.setFarmListTroopsForAllTargets(troopCounts);
            await this.saveFarmListIfNeeded();

            lists.push({ listName: currentListName, addedCount: addedThisList, existingCount: existing.length, isFull: addedThisList >= remainingInList });

            if (cursor >= coordList.length) break;
        }

        return {
            center,
            listName,
            addedCount: added.length,
            added,
            lists,
            maxPopulation,
            maxDistance,
            troopCounts,
            maxTargetsPerList,
            totalTargets: wantedTotal,
            source: 'map'
        };
    }

    async _httpGetText(url, options = {}) {
        const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 25000;

        return await new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: {
                    'User-Agent': 'travian-bot/1.0 (+https://github.com/)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    // Evitar compresion para simplificar el parsing
                    'Accept-Encoding': 'identity'
                }
            }, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, url).toString();
                    res.resume();
                    this._httpGetText(next, options).then(resolve, reject);
                    return;
                }

                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    const code = res.statusCode || 'unknown';
                    res.resume();
                    reject(new Error(`HTTP ${code} al descargar ${url}`));
                    return;
                }

                res.setEncoding('utf8');
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            });

            req.on('error', reject);
            req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout descargando ${url}`)));
        });
    }

    _parseInactiveSearchCoords(html) {
        const coords = [];
        // Ejemplo: <small class="text-muted">(-78|-72)</small>
        const re = /<small[^>]*class="[^"]*text-muted[^"]*"[^>]*>\s*\(\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)\s*<\/small>/gi;
        let m;
        while ((m = re.exec(html))) {
            const x = parseInt(m[1], 10);
            const y = parseInt(m[2], 10);
            if (Number.isNaN(x) || Number.isNaN(y)) continue;
            coords.push({ x, y });
        }
        return coords;
    }

    async _getInactiveSearchCoords(options = {}) {
        const inactiveSearchUrl = options.inactiveSearchUrl;
        if (!inactiveSearchUrl) throw new Error('Falta inactiveSearchUrl');

        const maxPages = typeof options.maxPages === 'number' ? options.maxPages : 20;
        const limit = typeof options.limit === 'number' ? options.limit : 200;

        const seen = new Set();
        const out = [];

        for (let page = 1; page <= maxPages; page += 1) {
            const url = new URL(inactiveSearchUrl);
            if (page > 1) url.searchParams.set('page', String(page));

            logger.info(`InactiveSearch: descargando p${page}...`);
            const html = await this._httpGetText(url.toString(), { timeoutMs: 25000 });
            const coords = this._parseInactiveSearchCoords(html);

            if (coords.length === 0) break;

            let addedFromPage = 0;
            for (const c of coords) {
                const key = `${c.x}|${c.y}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(c);
                addedFromPage += 1;
                if (out.length >= limit) return out;
            }

            if (addedFromPage === 0) break;
        }

        return out;
    }

    async updateFarmListFromInactiveSearch(options = {}) {
        const listName = options.listName || 'raid';
        const troopCounts = options.troopCounts || { t1: 2 };
        // maxTargets = total deseado en la lista (no "nuevos a a¤adir")
        const maxTargets = typeof options.maxTargets === 'number' ? options.maxTargets : 100;
        const applyTroopsToExisting = options.applyTroopsToExisting !== false;
        const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : null;

        const inactiveSearchUrl = options.inactiveSearchUrl;
        if (!inactiveSearchUrl) throw new Error('FARM_INACTIVESEARCH_URL es obligatorio para usar InactiveSearch.');

        const center = await this.getCurrentVillageCoordinates({ x: options.centerX, y: options.centerY });
        logger.info(`Centro de referencia: (${center.x}|${center.y}) [${center.source}]`);

        await this.openFarmList(listName, { rallySlot: options.rallySlot });
        if (applyTroopsToExisting) {
            const changed = await this.setFarmListTroopsForAllTargets(troopCounts);
            if (changed > 0) logger.info(`Tropas aplicadas a objetivos existentes: ${changed}`);
        }

        const existing = await this.getFarmListTargets();
        const existingSet = new Set(existing.map(t => `${t.x}|${t.y}`));
        logger.info(`Objetivos actuales en lista "${listName}": ${existing.length}`);

        const remaining = Math.max(0, maxTargets - existing.length);
        if (remaining === 0) {
            logger.info(`La lista "${listName}" ya tiene ${existing.length} objetivos (max=${maxTargets}).`);
            return {
                center,
                listName,
                addedCount: 0,
                added: [],
                troopCounts,
                maxTargets,
                source: 'inactivesearch'
            };
        }

        const verifyMaxPopulation = typeof options.maxPopulation === 'number' ? options.maxPopulation : null;
        const maxPages = typeof options.inactiveSearchMaxPages === 'number' ? options.inactiveSearchMaxPages : 30;
        const candidates = await this._getInactiveSearchCoords({
            inactiveSearchUrl,
            maxPages,
            limit: Math.max(remaining * 20, remaining)
        });

        const sortedCandidates = candidates
            .map(c => ({ ...c, dist: this._distance(center.x, center.y, c.x, c.y) }))
            .filter(c => (maxDistance === null ? true : c.dist <= maxDistance))
            .sort((a, b) => a.dist - b.dist);

        logger.info(`InactiveSearch: candidatos obtenidos=${candidates.length}, tras filtro/orden=${sortedCandidates.length}, a¤adir=${remaining}`);
        if (maxDistance !== null && sortedCandidates.length < remaining) {
            logger.warn(`InactiveSearch: no hay suficientes candidatos dentro de dist<=${maxDistance}. Considera subir FARM_MAX_DIST o cambiar la coordenada (c=...) del buscador.`);
        }

        const added = [];
        for (const c of sortedCandidates) {
            if (added.length >= remaining) break;

            const key = `${c.x}|${c.y}`;
            if (existingSet.has(key)) continue;

            let info = null;
            try {
                info = await this._getMapTileVillageInfo(c.x, c.y);
            } catch (e) {
                logger.warn(`Error leyendo mapa en (${c.x}|${c.y}): ${e.message}`);
                continue;
            }

            if (!info) continue;
            if (verifyMaxPopulation !== null && typeof info.population === 'number' && info.population >= verifyMaxPopulation) {
                continue;
            }

            logger.info(`Anadiendo objetivo (${c.x}|${c.y}) hab=${info.population} dist=${c.dist.toFixed(1)}`);

            try {
                let addedOk = false;

                // _getMapTileVillageInfo deja la pagina en el detalle del mapa, asi que usamos el flow "map"
                addedOk = await this.addToFarmListFromMap(c.x, c.y, listName);

                // Fallback: a¤adir desde la farmlist con nombre si esta disponible
                if (!addedOk) {
                    await this.openFarmList(listName, { rallySlot: options.rallySlot });
                    await this.addFarmListTarget(c.x, c.y, { name: info.name || undefined });
                    addedOk = true;
                }

                if (!addedOk) throw new Error('No se pudo agregar a la lista.');
                existingSet.add(key);
                added.push({ x: c.x, y: c.y, population: info.population, dist: c.dist });
            } catch (e) {
                logger.warn(`No se pudo anadir (${c.x}|${c.y}): ${e.message}`);
            }
        }

        await this.openFarmList(listName, { rallySlot: options.rallySlot });
        await this.setFarmListTroopsForAllTargets(troopCounts);
        await this.saveFarmListIfNeeded();

        return {
            center,
            listName,
            addedCount: added.length,
            added,
            troopCounts,
            maxTargets,
            source: 'inactivesearch'
        };
    }

    async updateFarmListsFromInactiveSearch(options = {}) {
        const listName = options.listName || 'raid';
        const troopCounts = options.troopCounts || { t1: 2 };
        const maxTargetsPerList = typeof options.maxTargetsPerList === 'number' ? options.maxTargetsPerList : 100;
        const totalTargets = typeof options.totalTargets === 'number' ? options.totalTargets : maxTargetsPerList;
        const applyTroopsToExisting = options.applyTroopsToExisting !== false;
        const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : null;
        const maxLists = typeof options.maxLists === 'number' ? options.maxLists : 20;

        const inactiveSearchUrl = options.inactiveSearchUrl;
        if (!inactiveSearchUrl) throw new Error('FARM_INACTIVESEARCH_URL es obligatorio para usar InactiveSearch.');

        const wantedTotal = Math.max(0, totalTargets);
        if (wantedTotal === 0) {
            return {
                center: await this.getCurrentVillageCoordinates({ x: options.centerX, y: options.centerY }),
                listName,
                addedCount: 0,
                added: [],
                lists: [],
                troopCounts,
                maxTargetsPerList,
                totalTargets: wantedTotal,
                source: 'inactivesearch'
            };
        }

        const center = await this.getCurrentVillageCoordinates({ x: options.centerX, y: options.centerY });
        logger.info(`Centro de referencia: (${center.x}|${center.y}) [${center.source}]`);

        const verifyMaxPopulation = typeof options.maxPopulation === 'number' ? options.maxPopulation : null;
        const maxPages = typeof options.inactiveSearchMaxPages === 'number' ? options.inactiveSearchMaxPages : 30;
        const candidates = await this._getInactiveSearchCoords({
            inactiveSearchUrl,
            maxPages,
            limit: Math.max(wantedTotal * 20, wantedTotal)
        });

        const sortedCandidates = candidates
            .map(c => ({ ...c, dist: this._distance(center.x, center.y, c.x, c.y) }))
            .filter(c => (maxDistance === null ? true : c.dist <= maxDistance))
            .sort((a, b) => a.dist - b.dist);

        logger.info(`InactiveSearch: candidatos obtenidos=${candidates.length}, tras filtro/orden=${sortedCandidates.length}, objetivo_total=${wantedTotal}`);
        if (maxDistance !== null && sortedCandidates.length < wantedTotal) {
            logger.warn(`InactiveSearch: no hay suficientes candidatos dentro de dist<=${maxDistance}. Considera subir FARM_MAX_DIST o cambiar la coordenada (c=...) del buscador.`);
        }

        const globalExistingSet = new Set();
        const added = [];
        const lists = [];
        let cursor = 0;

        for (let listIndex = 1; listIndex <= maxLists && added.length < wantedTotal; listIndex += 1) {
            const currentListName = this._farmListNameForIndex(listName, listIndex);
            await this.openFarmList(currentListName, { rallySlot: options.rallySlot, createIfMissing: true });

            if (applyTroopsToExisting) {
                const changed = await this.setFarmListTroopsForAllTargets(troopCounts);
                if (changed > 0) logger.info(`Tropas aplicadas a objetivos existentes (${currentListName}): ${changed}`);
            }

            const existing = await this.getFarmListTargets();
            for (const t of existing) globalExistingSet.add(`${t.x}|${t.y}`);
            logger.info(`Objetivos actuales en lista "${currentListName}": ${existing.length}`);

            const remainingInList = Math.max(0, maxTargetsPerList - existing.length);
            if (remainingInList === 0) {
                lists.push({ listName: currentListName, addedCount: 0, existingCount: existing.length, isFull: true });
                continue;
            }

            const remainingTotal = wantedTotal - added.length;
            const toAddHere = Math.min(remainingInList, remainingTotal);
            let addedThisList = 0;

            while (addedThisList < toAddHere && cursor < sortedCandidates.length) {
                const c = sortedCandidates[cursor];
                cursor += 1;

                const key = `${c.x}|${c.y}`;
                if (globalExistingSet.has(key)) continue;

                let info = null;
                try {
                    info = await this._getMapTileVillageInfo(c.x, c.y);
                } catch (e) {
                    logger.warn(`Error leyendo mapa en (${c.x}|${c.y}): ${e.message}`);
                    continue;
                }

                if (!info) continue;
                if (verifyMaxPopulation !== null && typeof info.population === 'number' && info.population >= verifyMaxPopulation) {
                    continue;
                }

                logger.info(`Anadiendo objetivo (${c.x}|${c.y}) hab=${info.population} dist=${c.dist.toFixed(1)} -> ${currentListName}`);

                try {
                    let addedOk = false;
                    addedOk = await this.addToFarmListFromMap(c.x, c.y, currentListName);
                    if (!addedOk) {
                        await this.openFarmList(currentListName, { rallySlot: options.rallySlot });
                        await this.addFarmListTarget(c.x, c.y, { name: info.name || undefined });
                        addedOk = true;
                    }

                    if (!addedOk) throw new Error('No se pudo agregar a la lista.');
                    globalExistingSet.add(key);
                    added.push({ x: c.x, y: c.y, population: info.population, dist: c.dist, listName: currentListName });
                    addedThisList += 1;
                } catch (e) {
                    logger.warn(`No se pudo anadir (${c.x}|${c.y}): ${e.message}`);
                }
            }

            await this.openFarmList(currentListName, { rallySlot: options.rallySlot });
            await this.setFarmListTroopsForAllTargets(troopCounts);
            await this.saveFarmListIfNeeded();

            lists.push({ listName: currentListName, addedCount: addedThisList, existingCount: existing.length, isFull: addedThisList >= remainingInList });

            if (cursor >= sortedCandidates.length) break;
        }

        return {
            center,
            listName,
            addedCount: added.length,
            added,
            lists,
            troopCounts,
            maxTargetsPerList,
            totalTargets: wantedTotal,
            source: 'inactivesearch'
        };
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

module.exports = GameClient;




